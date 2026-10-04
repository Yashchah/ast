import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspect } from 'node:util';
import type { BatchItem, BatchOptions, BatchRecord, Lang, PrintedArg, Runner, RunResult, Runtime, Val } from '../src/contracts';
import type { AtomPack, EscalationLesson, PackAtom, PackMutant, PackProbe } from '../src/schemas';
import {
  REPAIR_THRESHOLD, checkConditions, cutWords, diffLine, refutationLeak, typeVisible, verifyLesson, verifyPack,
  type PackVerifyResult,
} from '../src/atoms/verify';
import { LocalRunner, PATH_PYTHON_CANDIDATES, detectNode, detectPython, type DetectedRuntime } from '../src/runner';

// ------------------------------------------------------------------------------------------------
// Fake runners
// ------------------------------------------------------------------------------------------------

function toVal(x: unknown): Val {
  if (x === null) return { t: 'null' };
  if (x === undefined) return { t: 'undefined' };
  if (typeof x === 'number') return { t: 'num', v: x };
  if (typeof x === 'string') return { t: 'str', v: x };
  if (typeof x === 'boolean') return { t: 'bool', v: x };
  if (Array.isArray(x)) return { t: 'list', v: x.map(toVal) };
  if (typeof x === 'object') return { t: 'dict', v: Object.entries(x).map(([k, v]) => [toVal(k), toVal(v)] as [Val, Val]) };
  return { t: 'opaque', type: typeof x, repr: String(x) };
}

class CheckFailed extends Error {
  name = 'CheckFailed';
}

const repr = (x: unknown) => inspect(x, { breakLength: Infinity });

/** Runs a JS snippet in-process like batch.mjs: console.log captures typed values, check() is predefined. */
function runJs(item: BatchItem): BatchRecord {
  const values: PrintedArg[][] = [];
  let stdout = '';
  const log = (...args: unknown[]) => {
    values.push(args.map((a) => ({ type: typeof a, repr: repr(a), val: toVal(a) })));
    stdout += args.map((a) => (typeof a === 'string' ? a : repr(a))).join(' ') + '\n';
  };
  const check = (cond: unknown, msg: string) => {
    if (!cond) throw new CheckFailed('CHECK ' + msg);
  };
  const base = { id: item.id, ms: 1, timedOut: false, constructs: ['call'] };
  try {
    new Function('console', 'check', item.code)({ log }, check);
    return { ...base, stdout, values, exitOk: true };
  } catch (e) {
    const err = e as Error;
    return { ...base, stdout, values, exitOk: false, exception: err.name, error: `${err.name}: ${err.message}` };
  }
}

type Opts = BatchOptions & { allowImports?: string[] };
type Hook = (item: BatchItem, opts: Opts | undefined) => Partial<BatchRecord> | undefined;

class FakeRunner implements Runner {
  readonly runtime: Runtime;
  calls: { items: BatchItem[]; opts?: Opts }[] = [];
  constructor(lang: Lang = 'javascript', private readonly hook?: Hook) {
    this.runtime = { lang, exe: 'fake', snippetArgv: [], learnerArgv: [], version: lang === 'python' ? '3.14.0' : 'v24.11.1' };
  }
  async runBatch(items: BatchItem[], opts?: Opts): Promise<BatchRecord[]> {
    this.calls.push({ items, opts });
    return items.map((it) => {
      const over = this.hook?.(it, opts);
      const base = this.runtime.lang === 'python' ? unknownCode(it.id) : runJs(it);
      return { ...base, ...over, id: it.id };
    });
  }
  async runLearnerCode(): Promise<RunResult> {
    throw new Error('not used');
  }
  ran(code: string): boolean {
    return this.calls.some((c) => c.items.some((it) => it.code === code));
  }
}

const unknownCode = (id: string): BatchRecord => ({
  id, stdout: '', values: [], exitOk: false, timedOut: false, ms: 1, constructs: [], exception: 'NameError', error: 'unscripted code',
});

// Python values for the scripted runner.
const int = (n: number): Val => ({ t: 'int', v: String(n) });
const str = (s: string): Val => ({ t: 'str', v: s });
const list = (...v: Val[]): Val => ({ t: 'list', v });
function pyRepr(v: Val): string {
  switch (v.t) {
    case 'int':
      return v.v;
    case 'str':
      return `'${v.v}'`;
    case 'list':
      return `[${v.v.map(pyRepr).join(', ')}]`;
    default:
      return '?';
  }
}
/** A Python run that printed these calls. */
function py(...calls: Val[][]): Partial<BatchRecord> {
  return {
    exitOk: true, exception: undefined, error: undefined, constructs: ['assign', 'call'],
    stdout: calls.map((args) => args.map((a) => (a.t === 'str' ? a.v : pyRepr(a))).join(' ') + '\n').join(''),
    values: calls.map((args) => args.map((a) => ({ type: a.t, repr: pyRepr(a), val: a }))),
  };
}
/** Scripted Python runner: code -> record (unscripted code raises NameError). */
const scripted = (table: Record<string, Partial<BatchRecord> | ((item: BatchItem) => Partial<BatchRecord>)>) =>
  new FakeRunner('python', (it) => {
    const r = table[it.code];
    return typeof r === 'function' ? r(it) : r;
  });

// ------------------------------------------------------------------------------------------------
// Pack fixtures (JavaScript, tag list-slicing)
// ------------------------------------------------------------------------------------------------

const NAMES = ['scores', 'temps', 'pets', 'cities', 'ages'];

/** A correct slicing probe: k = 1..5 gives different code and output on its own surface. */
function sliceProbe(k: number, over: Partial<PackProbe> = {}): PackProbe {
  const xs = [k * 10 + 1, k * 10 + 2, k * 10 + 3, k * 10 + 4];
  const name = NAMES[k - 1];
  const code = `const ${name} = [${xs.join(', ')}];\nconsole.log(${name}.slice(1, 3));`;
  return {
    id: `p${k}`, siblingGroup: `surface ${k}`, code, answer: `[${xs[1]}, ${xs[2]}]`, parSec: 5,
    mutants: [mutant(code, '.slice(1, 4)', `[${xs[1]}, ${xs[2]}, ${xs[3]}]`)],
    ...over,
  };
}

function mutant(code: string, slice: string, prints: string, over: Partial<PackMutant> = {}): PackMutant {
  return {
    misconceptionId: 'slice-end-included', belief: 'The slice includes the item at the stop index',
    refutation: 'The slice stops just before index 3, so that item is left out.',
    code: code.replace('.slice(1, 3)', slice), prints, ...over,
  };
}

const COMPLETION: PackAtom['completion'] = {
  code: 'function middle(xs) {\n  // drop the first and the last item\n  const inner = [[1]];\n  return inner;\n}',
  solutions: ['xs.slice(1, xs.length - 1)'],
  wrongFills: [{ blank: 1, fill: 'xs.slice(1, xs.length)', misconceptionId: 'slice-end-included' }],
  harness: "check(JSON.stringify(middle([1, 2, 3, 4])) === '[2,3]', 'four items');\ncheck(JSON.stringify(middle([5, 6, 7])) === '[6]', 'three items');",
  parSec: 30,
};

function atom(over: Partial<PackAtom> = {}): PackAtom {
  return {
    conceptId: 'list-slicing', tag: 'list-slicing',
    pattern: {
      kind: 'shape', name: 'Slicing', useWhen: 'you need part of a list', template: 'xs.slice(<start>, <stop>)', rule: '',
      howItRuns: '', pitfall: 'the stop index is excluded',
      useCases: ['first three scores', 'drop the header row', 'last two readings', 'middle of a word', 'page of results', 'skip the first line'],
    },
    probes: [1, 2, 3, 4].map((k) => sliceProbe(k)),
    example: {
      code: 'const temps = [18, 21, 25, 19, 17];\nconst first = temps.slice(0, 2);\nconst middle = temps.slice(1, 4);\nconsole.log(first);\nconsole.log(middle);',
      subgoals: [{ line: 2, label: 'take the first two' }, { line: 3, label: 'items one to three' }, { line: 9, label: 'not a line' }],
    },
    completion: COMPLETION,
    contrast: {
      wrong: 'const xs = [1, 2, 3];\nconsole.log(xs.slice(0, 3));', right: 'const xs = [1, 2, 3];\nconsole.log(xs.slice(0, 2));',
      misconceptionId: 'slice-end-included', rule: 'A slice stops before the end index.',
    },
    ...over,
  };
}

const pack = (...atoms: PackAtom[]): AtomPack => ({ atoms });
const NOW = 1_700_000_000_000;

async function verifyJs(a: PackAtom, runner = new FakeRunner(), ctx = {}): Promise<PackVerifyResult> {
  return verifyPack(pack(a), runner, 'javascript', { now: NOW, ...ctx });
}

const repairFor = (r: PackVerifyResult, itemId: string) => r.repairs.find((f) => f.itemId === itemId);

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

describe('helpers', () => {
  test('diffLine finds the single changed line', () => {
    assert.equal(diffLine('a\nb\nc', 'a\nB\nc'), 2);
    assert.equal(diffLine('a\nb', 'a\nb  '), 0);
    assert.equal(diffLine('a\nb\nc', 'A\nb\nC'), -1);
    assert.equal(diffLine('a\nb', 'a\nb\nc'), -1);
  });

  test('refutationLeak flags numbers and quotes that are not in the code', () => {
    const code = 'const xs = [10, 20, 30, 40];\nconsole.log(xs.slice(1, 3));';
    assert.equal(refutationLeak('The slice stops before index 3.', code), undefined);
    assert.equal(refutationLeak("The slice doesn't include index 3.", code), undefined);
    assert.equal(refutationLeak('So the total is 50.', code), 'number 50');
    assert.equal(refutationLeak("It never reaches 'forty'.", code), "quoted 'forty'");
    assert.equal(refutationLeak('It prints "[20, 30]".', code), "quoted '[20, 30]'");
    assert.equal(refutationLeak('Look at `xs.slice`.', code), undefined);
  });

  test('checkConditions reads check() conditions, skipping strings', () => {
    assert.deepEqual(checkConditions("check(f([1, 2]) == 3, 'a, b')\ncheck(f([4]) == 4, 'c')"), ['f([1, 2]) == 3', 'f([4]) == 4']);
    assert.deepEqual(checkConditions("if (f(1) !== 1) throw new Error('check(')"), []);
  });

  test('cutWords keeps the first n words', () => {
    assert.equal(cutWords('  one two   three four ', 2), 'one two');
    assert.equal(cutWords('one two', 5), 'one two');
  });

  test('typeVisible: bare numbers fail, strings need a repr/type marker', () => {
    const out = (...vals: Val[]) => ({ stdout: '', values: [vals.map((v) => ({ type: v.t, repr: '', val: v }))] });
    assert.equal(typeVisible('print(a + b)', out(int(7)), 'python'), false);
    assert.equal(typeVisible("print(repr(a + b))", out(str("'34'")), 'python'), true);
    assert.equal(typeVisible('print(x)', out(str('34')), 'python'), false);
    assert.equal(typeVisible('print(type(x).__name__)', out(str('str')), 'python'), true);
    assert.equal(typeVisible('print(xs)', out(list(int(1), str('1'))), 'python'), true);
    assert.equal(typeVisible('console.log(JSON.stringify(x))', out(str('"5"')), 'javascript'), true);
    assert.equal(typeVisible('console.log(x)', out({ t: 'num', v: 5 }), 'javascript'), false);
  });
});

// ------------------------------------------------------------------------------------------------
// verifyPack: the spec's verify list
// ------------------------------------------------------------------------------------------------

describe('verifyPack', () => {
  test('a sound full pack is accepted, with every part checked in one batch per pass', async () => {
    const runner = new FakeRunner();
    const r = await verifyJs(atom(), runner);
    assert.deepEqual(r.repairs, []);
    assert.equal(r.needsRepair, false);
    const a = r.atom!;
    assert.ok(a);
    assert.equal(a.verified, true);
    assert.equal(a.source, 'model');
    assert.equal(a.key, 'list-slicing');
    assert.equal(a.createdAt, NOW);
    assert.equal(a.probes.length, 4);
    assert.equal(new Set(a.probes.map((p) => p.group)).size, 4);
    assert.equal(new Set(a.probes.map((p) => p.id)).size, 4);
    for (const p of a.probes) {
      assert.equal(p.discriminating, true);
      assert.equal(p.mutants.length, 1);
      assert.equal(p.mutants[0].diffLine, 2);
      assert.equal(p.mutants[0].source, 'model');
      assert.equal(p.mutants[0].ambiguous, false);
      assert.equal(p.mutants[0].rule, 'A slice stops before the end index.');
      assert.ok(p.mutants[0].id.startsWith(`${p.id}~`));
      assert.equal(p.answerSpaceG, 0.06);
      assert.deepEqual(p.constructs, ['call']);
      assert.deepEqual(p.stats, { seenAt: [], n: 0, nCorrect: 0 });
    }
    assert.deepEqual(a.probes[0].output.values[0][0].val, toVal([12, 13]));
    // Step 10: the canonical pattern name.
    assert.equal(a.pattern.name, 'Slice a sequence');
    assert.ok(r.log.some((l) => l.includes("'Slicing' renamed to 'Slice a sequence'")));
    // Example with its real output; the subgoal on a missing line is dropped.
    assert.equal(a.examples.length, 1);
    assert.equal(a.examples[0].output.stdout, '[ 18, 21 ]\n[ 21, 25, 19 ]\n');
    assert.deepEqual(a.examples[0].subgoals.map((s) => s.line), [2, 3]);
    assert.ok(r.dropped.some((d) => d.kind === 'subgoal'));
    assert.equal(a.completions.length, 1);
    assert.equal(a.completions[0].wrongFills.length, 1);
    assert.equal(a.contrasts.length, 1);
    assert.notEqual(a.contrasts[0].wrongOutput.stdout, a.contrasts[0].rightOutput.stdout);
    // Two passes, two hash seeds, everything in one batch each.
    assert.equal(runner.calls.length, 2);
    assert.deepEqual(runner.calls.map((c) => c.opts?.hashSeed), [1, 2]);
    assert.equal(runner.calls[0].items.length, runner.calls[1].items.length);
    assert.ok(runner.calls[0].items.length >= 4 + 4 + 1 + 4 + 2);
  });

  test('a probe whose model answer differs from the real output goes to repair and is not overwritten', async () => {
    const bad = sliceProbe(2, { answer: '[22, 23, 24]' });
    const r = await verifyJs(atom({ probes: [sliceProbe(1), bad, sliceProbe(3), sliceProbe(4)] }));
    const f = repairFor(r, 'p2');
    assert.ok(f);
    assert.equal(f.kind, 'probe');
    assert.match(f.what, /your answer: \[22, 23, 24\]; real output: \[ 22, 23 \]/);
    assert.equal(r.atom!.probes.length, 3);
    assert.ok(!r.atom!.probes.some((p) => p.code === bad.code), 'the mispredicted probe is not stored with a corrected answer');
  });

  test('an equal-output mutant is dropped (the probe stays, not discriminating)', async () => {
    const p = sliceProbe(1);
    p.mutants = [mutant(p.code, '.slice(-3, -1)', '[12, 13]', { misconceptionId: 'index-starts-at-one' })];
    const r = await verifyJs(atom({ probes: [p, sliceProbe(2), sliceProbe(3), sliceProbe(4)] }));
    assert.ok(r.dropped.some((d) => d.itemId === 'p1/m1' && /same as the original/.test(d.reason)));
    const stored = r.atom!.probes.find((x) => x.code === p.code)!;
    assert.deepEqual(stored.mutants, []);
    assert.equal(stored.discriminating, false);
  });

  test('two equal mutants become ambiguous; a distinct third keeps the probe discriminating', async () => {
    const p = sliceProbe(1);
    p.mutants = [
      mutant(p.code, '.slice(1, 4)', '[12, 13, 14]'),
      mutant(p.code, '.slice(1, 5)', '[12, 13, 14]', { misconceptionId: 'slice-past-end-errors', belief: 'Going past the end adds nothing new' }),
    ];
    let r = await verifyJs(atom({ probes: [p, sliceProbe(2), sliceProbe(3), sliceProbe(4)] }));
    let stored = r.atom!.probes.find((x) => x.code === p.code)!;
    assert.deepEqual(stored.mutants.map((m) => m.ambiguous), [true, true]);
    assert.equal(stored.discriminating, false);

    p.mutants.push(mutant(p.code, '.slice(0, 2)', '[11, 12]', { misconceptionId: 'index-starts-at-one', belief: 'The first item is at position 1, not 0' }));
    r = await verifyJs(atom({ probes: [p, sliceProbe(2), sliceProbe(3), sliceProbe(4)] }));
    stored = r.atom!.probes.find((x) => x.code === p.code)!;
    assert.deepEqual(stored.mutants.map((m) => m.ambiguous), [true, true, false]);
    assert.equal(stored.discriminating, true);
  });

  test('a mutant within a slip (edit distance 1) of the real output never makes the probe discriminating', async () => {
    const code = 'const n = [4, 5].length;\nconsole.log(n + 3);';
    const p = sliceProbe(1, { code, answer: '5', mutants: [{ ...mutant(code, '', '6'), code: 'const n = [4, 5].length;\nconsole.log(n + 4);' }] });
    const r = await verifyJs(atom({ probes: [p, sliceProbe(2), sliceProbe(3), sliceProbe(4)] }));
    const stored = r.atom!.probes.find((x) => x.code === code)!;
    assert.equal(stored.mutants.length, 1, 'kept: its output is real and different');
    assert.equal(stored.discriminating, false);
  });

  test("a mutant whose 'prints' claim is wrong is dropped", async () => {
    const p = sliceProbe(1);
    p.mutants = [mutant(p.code, '.slice(1, 4)', '[12, 13, 14, 15]')];
    const r = await verifyJs(atom({ probes: [p, sliceProbe(2), sliceProbe(3), sliceProbe(4)] }));
    const d = r.dropped.find((x) => x.itemId === 'p1/m1');
    assert.ok(d);
    assert.match(d.reason, /'prints' claim \[12, 13, 14, 15\] does not match its real output \[ 12, 13, 14 \]/);
    assert.equal(r.atom!.probes.find((x) => x.code === p.code)!.mutants.length, 0);
  });

  test('a mutant whose diff spans several lines is dropped without running', async () => {
    const runner = new FakeRunner();
    const p = sliceProbe(1);
    const twoLines = 'const scores = [11, 12, 99, 14];\nconsole.log(scores.slice(1, 4));';
    const extraLine = `${p.code}\nconsole.log(1);`;
    p.mutants = [
      { ...mutant(p.code, '.slice(1, 4)', '[12, 99, 14]'), code: twoLines },
      { ...mutant(p.code, '.slice(1, 4)', '[12, 13]\n1'), code: extraLine },
    ];
    const r = await verifyJs(atom({ probes: [p, sliceProbe(2), sliceProbe(3), sliceProbe(4)] }), runner);
    assert.equal(r.dropped.filter((d) => d.kind === 'mutant' && /several lines/.test(d.reason)).length, 2);
    assert.ok(!runner.ran(twoLines) && !runner.ran(extraLine));
  });

  test('a harness without check(f(...) == expected) calls is rejected (no constant-fill test possible)', async () => {
    const c = { ...COMPLETION, harness: "check(Array.isArray(middle([1, 2, 3])), 'a list');\ncheck(middle([1, 2]).length < 1, 'short');" };
    const runner = new FakeRunner();
    const r = await verifyJs(atom({ completion: c }), runner);
    assert.match(repairFor(r, 'completion')!.what, /harness needs check\(f\(\.\.\.\) == expected/);
    assert.equal(r.atom!.completions.length, 0);
    assert.ok(r.atom, 'the example still carries the atom');
  });

  test('a completion that passes with empty blanks is dropped', async () => {
    // inner defaults to a correct value, so the blank is never tested.
    const c = {
      ...COMPLETION,
      code: 'function middle(xs) {\n  let inner = xs.slice(1, xs.length - 1);\n  [[1]]\n  return inner;\n}',
      solutions: ['inner = xs.slice(1, -1);'],
      wrongFills: [],
    };
    const r = await verifyJs(atom({ completion: c }));
    assert.match(repairFor(r, 'completion')!.what, /passes with the blanks left empty/);
    assert.equal(r.atom!.completions.length, 0);
  });

  test('a completion that passes with a constant fill is dropped', async () => {
    const c = {
      code: 'function count(xs) {\n  // how many items\n  return [[1]];\n}',
      solutions: ['xs.length'],
      wrongFills: [],
      harness: "check(count([1, 2, 3]) === 3, 'three');\ncheck(count(['a', 'b', 'c']) === 3, 'three words');",
      parSec: 25,
    };
    const r = await verifyJs(atom({ completion: c }));
    assert.match(repairFor(r, 'completion')!.what, /constant fill 3/);
    assert.equal(r.atom!.completions.length, 0);
  });

  test('a JS harness without check( is rejected', async () => {
    const c = { ...COMPLETION, harness: "if (JSON.stringify(middle([1, 2, 3])) !== '[2]') throw new Error('bad');" };
    const runner = new FakeRunner();
    const r = await verifyJs(atom({ completion: c }), runner);
    assert.match(repairFor(r, 'completion')!.what, /no check\( calls/);
    assert.ok(!runner.calls[0].items.some((it) => it.id.includes('/c/')), 'a rejected completion never runs');
  });

  test('a harness checking only one input is rejected', async () => {
    const c = { ...COMPLETION, harness: "check(JSON.stringify(middle([1, 2, 3])) === '[2]', 'a');\ncheck(JSON.stringify(middle([1, 2, 3])) === '[2]', 'b');" };
    assert.match(repairFor(await verifyJs(atom({ completion: c })), 'completion')!.what, /at least 2 different inputs/);
  });

  test('a wrong fill that passes is dropped; a failing solution goes to repair', async () => {
    let c = { ...COMPLETION, wrongFills: [{ blank: 1, fill: 'xs.slice(1, -1)', misconceptionId: 'negative-index-error' }] };
    let r = await verifyJs(atom({ completion: c }));
    assert.ok(r.dropped.some((d) => d.kind === 'wrong-fill' && /passes the harness/.test(d.reason)));
    assert.deepEqual(r.atom!.completions[0].wrongFills, []);

    c = { ...COMPLETION, solutions: ['xs.slice(0, xs.length)'] };
    r = await verifyJs(atom({ completion: c }));
    const f = repairFor(r, 'completion')!;
    assert.match(f.what, /solution fails/);
    assert.match(f.stderr, /CHECK four items/);
  });

  test('a refutation quoting an output number is blanked; belief and refutation are cut', async () => {
    const p = sliceProbe(1);
    p.mutants = [mutant(p.code, '.slice(1, 4)', '[12, 13, 14]', {
      refutation: 'It stops before index 3, so it never prints 25 or the last item.',
      belief: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen',
    })];
    const q = sliceProbe(2);
    q.mutants = [mutant(q.code, '.slice(1, 4)', '[22, 23, 24]', { refutation: `${'word '.repeat(30)}end` })];
    const r = await verifyJs(atom({ probes: [p, q, sliceProbe(3), sliceProbe(4)] }));
    const m1 = r.atom!.probes.find((x) => x.code === p.code)!.mutants[0];
    assert.equal(m1.refutation, '');
    assert.equal(m1.belief.split(' ').length, 12);
    assert.ok(r.log.some((l) => /refutation blanked \(number 25/.test(l)));
    const m2 = r.atom!.probes.find((x) => x.code === q.code)!.mutants[0];
    assert.equal(m2.refutation.split(' ').length, 25);
    // A clean refutation is kept.
    assert.equal(r.atom!.probes.find((x) => x.code === sliceProbe(3).code)!.mutants[0].refutation, 'The slice stops just before index 3, so that item is left out.');
  });

  test('repair triggers above 40% failures, not at 2 of 7', async () => {
    const wrong = (k: number) => sliceProbe(k, { answer: '[0]' });
    // 2 probes + the contrast fail: 3 of 7 > 40%, yet the atom is still accepted.
    const badContrast = { ...atom().contrast, right: atom().contrast.wrong.replace('xs', 'ys').replace('xs', 'ys') };
    let r = await verifyJs(atom({ probes: [sliceProbe(1), sliceProbe(2), wrong(3), wrong(4)], contrast: badContrast }));
    assert.ok(r.atom);
    assert.ok(r.failRatio > REPAIR_THRESHOLD);
    assert.equal(r.needsRepair, true);
    assert.deepEqual(r.repairs.map((f) => f.itemId).sort(), ['contrast', 'p3', 'p4']);
    // 1 probe + the contrast: 2 of 7.
    r = await verifyJs(atom({ probes: [sliceProbe(1), sliceProbe(2), sliceProbe(3), wrong(4)], contrast: badContrast }));
    assert.ok(Math.abs(r.failRatio - 2 / 7) < 1e-9);
    assert.equal(r.needsRepair, false);
    assert.ok(r.atom);
  });

  test('exactly 40% failing does not trigger repair (the rule is "more than 40%")', async () => {
    const probes = [1, 2, 3, 4, 5].map((k) => sliceProbe(k, k > 3 ? { answer: '[0]' } : {}));
    const r = await verifyJs(atom({ probes, example: { code: '', subgoals: [] }, completion: { ...COMPLETION, code: '' }, contrast: { wrong: '', right: '', misconceptionId: '', rule: '' } }), new FakeRunner(), { variant: 'probes-only' });
    assert.equal(r.failRatio, 0.4);
    assert.equal(r.needsRepair, false);
    assert.equal(r.atom!.probes.length, 3);
  });

  test('an atom that misses acceptance asks for repair even under 40%', async () => {
    const r = await verifyJs(
      atom({ probes: [sliceProbe(1), sliceProbe(2, { answer: '[0]' })], example: { code: '', subgoals: [] }, contrast: { wrong: '', right: '', misconceptionId: '', rule: '' } }),
      new FakeRunner(),
      { variant: 'mini' },
    );
    assert.equal(r.atom, null);
    assert.ok(Math.abs(r.failRatio - 1 / 3) < 1e-9);
    assert.equal(r.needsRepair, true);
    assert.ok(r.repairs.some((f) => f.kind === 'atom' && /2\+ groups/.test(f.what)));
  });

  test('acceptance needs 2 probes from 2 sibling groups plus the example or the completion', async () => {
    const same = [1, 2, 3, 4].map((k) => sliceProbe(k, { siblingGroup: 'one surface' }));
    let r = await verifyJs(atom({ probes: same }));
    assert.equal(r.atom, null);
    assert.ok(r.repairs.some((f) => f.itemId === 'atom' && /in 1 sibling group/.test(f.what)));

    r = await verifyJs(atom({ example: { code: '', subgoals: [] }, completion: { ...COMPLETION, code: '' } }));
    assert.equal(r.atom, null);
    assert.ok(r.repairs.some((f) => f.itemId === 'atom' && /neither the example nor the completion/.test(f.what)));

    r = await verifyJs(atom({ example: { code: '', subgoals: [] } }));
    assert.ok(r.atom, 'the completion alone is enough');
  });

  test('variants: probes-only needs no production part; mini needs no example or contrast', async () => {
    const none = { example: { code: '', subgoals: [] }, completion: { ...COMPLETION, code: '' }, contrast: { wrong: '', right: '', misconceptionId: '', rule: '' } };
    let r = await verifyJs(atom(none), new FakeRunner(), { variant: 'probes-only' });
    assert.ok(r.atom);
    assert.deepEqual(r.repairs, []);
    assert.equal(r.failRatio, 0);
    r = await verifyJs(atom({ ...none, probes: [sliceProbe(1), sliceProbe(2)], completion: COMPLETION }), new FakeRunner(), { variant: 'mini' });
    assert.ok(r.atom);
    assert.deepEqual(r.repairs, []);
    // A full pack missing its parts fails them.
    r = await verifyJs(atom(none));
    assert.deepEqual(r.repairs.filter((f) => /missing|both snippets/.test(f.what)).map((f) => f.itemId).sort(), ['completion', 'contrast', 'example']);
  });

  test('allowlist-denied items are dropped and never run', async () => {
    const runner = new FakeRunner();
    const evil = sliceProbe(1, { code: "const fs = require('fs');\nconsole.log(fs.readdirSync('.'));" });
    const p = sliceProbe(2);
    p.mutants = [{ ...mutant(p.code, '.slice(1, 4)', '[22, 23, 24]'), code: p.code.replace('.slice(1, 3)', '.slice(1, Math.random() > 2 ? 0 : 3)') }];
    const r = await verifyJs(atom({ probes: [evil, p, sliceProbe(3), sliceProbe(4)] }), runner);
    assert.match(repairFor(r, 'p1')!.what, /denied by the allowlist: require/);
    assert.ok(r.dropped.some((d) => d.itemId === 'p2/m1' && /denied/.test(d.reason)));
    assert.ok(!runner.ran(evil.code) && !runner.ran(p.mutants[0].code));
  });

  test('output that differs between the two passes goes to repair', async () => {
    const flaky = sliceProbe(1);
    const runner = new FakeRunner('javascript', (it, opts) =>
      it.code === flaky.code && opts?.hashSeed === 2 ? { stdout: '[ 13, 12 ]\n', values: [[{ type: 'object', repr: '[ 13, 12 ]', val: toVal([13, 12]) }]] } : undefined);
    const r = await verifyJs(atom(), runner);
    assert.match(repairFor(r, 'p1')!.what, /differs between two runs/);
  });

  test('raising on purpose is fine when the answer is the exception name; other crashes go to repair', async () => {
    const raises = sliceProbe(1, { code: 'const pets = null;\nconsole.log(pets.length);', answer: 'TypeError', mutants: [] });
    const unexpected = sliceProbe(2, { code: 'const temps = null;\nconsole.log(temps.length);', answer: '0', mutants: [] });
    const broken = sliceProbe(3, { code: 'const x = ;\nconsole.log(x);', mutants: [] });
    const r = await verifyJs(atom({ probes: [raises, unexpected, broken, sliceProbe(4)] }));
    const kept = r.atom!.probes.find((p) => p.code === raises.code)!;
    assert.equal(kept.raises, true);
    assert.equal(kept.output.exception, 'TypeError');
    assert.equal(kept.answerSpaceG, 0.25);
    assert.match(repairFor(r, 'p2')!.what, /your answer: 0; real output: TypeError/);
    assert.match(repairFor(r, 'p3')!.what, /SyntaxError: the code does not parse/);
  });

  test('probes must print 1-4 lines of at most 200 characters and have at most 8 lines', async () => {
    const five = sliceProbe(1, { code: 'for (let i = 0; i < 5; i++) console.log(i);', answer: '0\n1\n2\n3\n4', mutants: [] });
    const silent = sliceProbe(2, { code: 'const x = 1;', answer: '1', mutants: [] });
    const long = sliceProbe(3, { code: "console.log('ab'.repeat(101));", answer: 'ab'.repeat(101), mutants: [] });
    const tall = sliceProbe(4, { code: Array.from({ length: 9 }, (_, i) => `console.log(${i});`).join('\n'), mutants: [] });
    const r = await verifyJs(atom({ probes: [five, silent, long, tall, sliceProbe(5)] }));
    assert.match(repairFor(r, 'p1')!.what, /prints 5 lines/);
    assert.match(repairFor(r, 'p2')!.what, /your answer: 1; real output: /);
    assert.match(repairFor(r, 'p3')!.what, /prints 202 characters/);
    assert.match(repairFor(r, 'p4')!.what, /9 lines \(8 or fewer\)/);
  });

  test('at most 3 mutants per probe', async () => {
    const p = sliceProbe(1);
    p.mutants = [
      mutant(p.code, '.slice(1, 4)', '[12, 13, 14]'),
      mutant(p.code, '.slice(0, 3)', '[11, 12, 13]', { misconceptionId: 'index-starts-at-one' }),
      mutant(p.code, '.slice(2, 3)', '[13]', { misconceptionId: 'other-one' }),
      mutant(p.code, '.slice(0, 1)', '[11]', { misconceptionId: 'other-two' }),
    ];
    const r = await verifyJs(atom({ probes: [p, sliceProbe(2), sliceProbe(3), sliceProbe(4)] }));
    assert.equal(r.atom!.probes.find((x) => x.code === p.code)!.mutants.length, 3);
    assert.ok(r.dropped.some((d) => d.itemId === 'p1/m4' && /more than 3/.test(d.reason)));
  });

  test('a contrast whose snippets print the same, or run long, goes to repair', async () => {
    let r = await verifyJs(atom({ contrast: { ...atom().contrast, right: 'const ys = [1, 2, 3];\nconsole.log(ys.slice(0, 3));' } }));
    assert.match(repairFor(r, 'contrast')!.what, /both snippets print the same/);
    assert.equal(r.atom!.contrasts.length, 0);
    r = await verifyJs(atom({ contrast: { ...atom().contrast, wrong: 'a\nb\nc\nd\ne' } }));
    assert.match(repairFor(r, 'contrast')!.what, /4 lines or fewer/);
  });

  test('useCases below 6 go to repair; the semantics card has no template', async () => {
    const pat = { ...atom().pattern, kind: 'shape' as const, template: 'b = a', rule: 'Assignment shares one object', useCases: ['a', 'b', 'a', 'c'] };
    const r = await verifyJs(atom({ tag: 'alias-copy', conceptId: 'alias-copy', pattern: pat }));
    const f = repairFor(r, 'pattern')!;
    assert.match(f.what, /useCases has 3 different items/);
    assert.ok(r.atom, 'short use cases do not block the atom');
    assert.equal(r.atom!.pattern.kind, 'semantics');
    assert.equal(r.atom!.pattern.template, '');
    assert.equal(r.atom!.pattern.rule, 'Assignment shares one object');
    assert.equal(r.atom!.pattern.name, 'Aliases share one object');
    assert.equal(r.failRatio, 0, 'the pattern does not count toward the 40% rule');
  });

  test('execution off: an unverified atom from the model claims, with mutant matching disabled', async () => {
    const r = await verifyPack(pack(atom()), null, 'javascript', { now: NOW });
    const a = r.atom!;
    assert.equal(a.verified, false);
    assert.equal(a.probes.length, 4);
    assert.equal(a.probes[0].output.stdout, '[12, 13]\n');
    assert.ok(a.probes.every((p) => !p.discriminating && p.mutants.every((m) => m.ambiguous)));
    assert.equal(a.contrasts.length, 0);
    assert.equal(a.completions.length, 1);
  });

  test('concepts are matched to the request; a skipped concept asks for repair', async () => {
    const runner = new FakeRunner();
    const other = atom({ conceptId: 'csv-parsing', tag: 'other' });
    const r = await verifyPack(pack(atom({ conceptId: 'slicing' }), other), runner, 'javascript', {
      now: NOW,
      concepts: [{ id: 'list-slices', tag: 'list-slicing' }, { id: 'csv-rows', tag: 'other' }, { id: 'missing', tag: 'dict-iteration' }],
    });
    assert.equal(runner.calls.length, 2, 'one batch per pass for the whole pack');
    assert.deepEqual(r.results.map((x) => [x.conceptId, x.key, x.atom ? 'ok' : 'none']), [
      ['list-slices', 'list-slicing', 'ok'], ['csv-rows', 'csv-rows', 'ok'], ['missing', 'dict-iteration', 'none'],
    ]);
    assert.equal(r.atom!.conceptId, 'list-slices');
    assert.equal(r.results[1].atom!.pattern.name, 'Slicing', "'other' keeps the model's name");
    assert.ok(r.repairs.some((f) => f.conceptId === 'missing' && f.kind === 'atom'));
    assert.equal(r.needsRepair, true);
  });
});

describe('verifyPack with a scripted Python runner', () => {
  test('type-sensitive tags must print repr()/type()', async () => {
    const A = "a = '3'\nb = '4'\nprint(repr(a + b))";
    const Am = "a = '3'\nb = '4'\nprint(repr(int(a) + int(b)))";
    const B = 'a = 3\nb = 4\nprint(a + b)';
    const C = "x = '34'\nprint(x)";
    const D = "n = '5'\nprint(type(n).__name__)";
    const runner = scripted({ [A]: py([str("'34'")]), [Am]: py([str('7')]), [B]: py([int(7)]), [C]: py([str('34')]), [D]: py([str('str')]) });
    const probe = (id: string, code: string, answer: string, mutants: PackMutant[] = []): PackProbe => ({ id, siblingGroup: id, code, answer, parSec: 4, mutants });
    const a: PackAtom = {
      ...atom({ conceptId: 'str-vs-number', tag: 'str-vs-number' }),
      probes: [
        probe('A', A, "'34'", [{ misconceptionId: 'digit-strings-add', belief: 'Adding digit strings does arithmetic', refutation: '+ joins two strings', code: Am, prints: '7' }]),
        probe('B', B, '7'), probe('C', C, '34'), probe('D', D, 'str'),
      ],
    };
    const r = await verifyPack(pack(a), runner, 'python', { now: NOW, variant: 'probes-only' });
    assert.match(repairFor(r, 'B')!.what, /type-sensitive, so print repr\(x\) or type\(x\)\.__name__/);
    assert.match(repairFor(r, 'C')!.what, /type-sensitive/);
    assert.deepEqual(r.atom!.probes.map((p) => p.code), [A, D]);
    assert.equal(r.atom!.probes[0].mutants[0].diffLine, 3);
    assert.equal(r.atom!.probes[0].discriminating, true);
  });

  test('state-trace tags request a trace in the first pass and keep it, cut to 60 characters', async () => {
    const P1 = 'a = [1, 2]\nb = a\nb.append(3)\nprint(a)';
    const P2 = 'xs = [5]\nys = xs\nys.append(6)\nprint(xs)';
    const M1 = 'a = [1, 2]\nb = a[:]\nb.append(3)\nprint(a)';
    const trace = [{ line: 1, text: 'a=[1, 2]' }, { line: 2, text: 'a=[1, 2]  b is a' }, { line: 3, text: `a=[${'9, '.repeat(30)}]` }];
    const runner = scripted({
      [P1]: (it) => ({ ...py([list(int(1), int(2), int(3))]), ...(it.wantTrace ? { trace } : {}) }),
      [P2]: py([list(int(5), int(6))]),
      [M1]: py([list(int(1), int(2))]),
    });
    const a: PackAtom = {
      ...atom({ conceptId: 'alias-copy', tag: 'alias-copy' }),
      probes: [
        { id: 'p1', siblingGroup: 'lists', code: P1, answer: '[1, 2, 3]', parSec: 5, mutants: [{ misconceptionId: 'assignment-copies', belief: 'b = a makes a separate copy', refutation: 'b and a name one list', code: M1, prints: '[1, 2]' }] },
        { id: 'p2', siblingGroup: 'numbers', code: P2, answer: '[5, 6]', parSec: 5, mutants: [] },
      ],
    };
    const r = await verifyPack(pack(a), runner, 'python', { now: NOW, variant: 'probes-only' });
    const first = runner.calls[0].items;
    assert.equal(first.find((it) => it.code === P1)!.wantTrace, true);
    assert.equal(first.find((it) => it.code === M1)!.wantTrace, undefined, 'mutants need no trace');
    assert.ok(runner.calls[1].items.every((it) => !it.wantTrace), 'the second pass needs no trace');
    const stored = r.atom!.probes.find((p) => p.code === P1)!;
    assert.equal(stored.trace!.length, 3);
    assert.equal(stored.trace![1].text, 'a=[1, 2]  b is a');
    assert.equal(stored.trace![2].text.length, 60);
    assert.ok(stored.trace![2].text.endsWith('...'));
    // The tag's allowedImports ride along for the runner's allowlist.
    assert.deepEqual(runner.calls[0].opts?.allowImports, ['copy']);
  });

  test('a timed-out item is not run again in the second pass', async () => {
    const P1 = 'xs = [1]\nprint(xs)';
    const P2 = 'while True:\n    pass';
    const runner = scripted({ [P1]: py([list(int(1))]), [P2]: { exitOk: false, timedOut: true, error: 'timed out' } });
    const a: PackAtom = { ...atom(), probes: [{ id: 'p1', siblingGroup: 'a', code: P1, answer: '[1]', parSec: 3, mutants: [] }, { id: 'p2', siblingGroup: 'b', code: P2, answer: '', parSec: 3, mutants: [] }] };
    a.probes[1].answer = 'nothing';
    const r = await verifyPack(pack(a), runner, 'python', { now: NOW, variant: 'probes-only' });
    assert.match(repairFor(r, 'p2')!.what, /timed out/);
    assert.ok(!runner.calls[1].items.some((it) => it.code === P2));
  });
});

// ------------------------------------------------------------------------------------------------
// verifyLesson
// ------------------------------------------------------------------------------------------------

describe('verifyLesson', () => {
  const lesson = (example: string): EscalationLesson => ({ title: 'Slices stop early', explanation: 'A slice stops before its end.', example, rule: 'The stop index is left out.' });

  test('a matching stated output is kept and verified', async () => {
    const ex = '```js\nconst xs = [1, 2, 3, 4];\nconsole.log(xs.slice(1, 3)); // [2, 3]\n```';
    const r = await verifyLesson(lesson(ex), new FakeRunner());
    assert.equal(r.outputVerified, true);
    assert.equal(r.lesson.example, ex);
    assert.equal(r.output!.stdout, '[ 2, 3 ]\n');
  });

  test('a wrong trailing output comment is removed and logged, the code stays', async () => {
    const ex = '```js\nconst xs = [1, 2, 3, 4];\nconsole.log(xs.slice(1, 3)); // [2, 3, 4]\n```';
    const r = await verifyLesson(lesson(ex), new FakeRunner());
    assert.equal(r.outputVerified, false);
    assert.equal(r.lesson.example, '```js\nconst xs = [1, 2, 3, 4];\nconsole.log(xs.slice(1, 3));\n```');
    assert.ok(r.log.some((l) => /mismatch: stated \[2, 3, 4\]; real \[ 2, 3 \]/.test(l)));
  });

  test("a wrong '// ->' line and a wrong 'Output:' line are removed; right ones stay", async () => {
    let ex = '```js\nconst s = "ab";\nconsole.log(s.slice(0, 1));\n// -> ab\n```';
    let r = await verifyLesson(lesson(ex), new FakeRunner());
    assert.equal(r.lesson.example, '```js\nconst s = "ab";\nconsole.log(s.slice(0, 1));\n```');

    ex = '```js\nconsole.log([1, 2, 3].slice(0, 2));\n```\nOutput: `[1, 2, 3]`';
    r = await verifyLesson(lesson(ex), new FakeRunner());
    assert.equal(r.lesson.example, '```js\nconsole.log([1, 2, 3].slice(0, 2));\n```');

    ex = '```js\nconsole.log([1, 2, 3].slice(0, 2));\n```\n**Output:** [1, 2]';
    r = await verifyLesson(lesson(ex), new FakeRunner());
    assert.equal(r.lesson.example, ex);
    assert.equal(r.outputVerified, true);
  });

  test('an output block after the code is checked too', async () => {
    const ex = '```js\nconsole.log("a");\nconsole.log("b");\n```\n\n```text\na\nc\n```';
    const r = await verifyLesson(lesson(ex), new FakeRunner());
    assert.equal(r.lesson.example, '```js\nconsole.log("a");\nconsole.log("b");\n```\n');
  });

  test('an example that does not parse is removed whole; no runner leaves the lesson alone', async () => {
    const r = await verifyLesson(lesson('```js\nconst = 1;\n```'), new FakeRunner());
    assert.equal(r.lesson.example, '');
    assert.ok(r.log[0].startsWith('lesson example removed: SyntaxError'));
    const l = lesson('```js\nconsole.log(1); // 2\n```');
    assert.deepEqual((await verifyLesson(l, null)).lesson, l);
  });

  test('a denied example keeps its code but loses its unconfirmed output', async () => {
    const ex = "```js\nconst fs = require('fs'); // nothing\nconsole.log(1); // 1\n```";
    const r = await verifyLesson(lesson(ex), new FakeRunner());
    // '// nothing' on a non-print line is a comment, not a stated output.
    assert.equal(r.lesson.example, "```js\nconst fs = require('fs'); // nothing\nconsole.log(1);\n```");
    assert.ok(r.log[0].includes('denied'));
  });
});

// ------------------------------------------------------------------------------------------------
// Real runtimes (skipped when missing)
// ------------------------------------------------------------------------------------------------

const RUNNER_DIR = path.resolve(__dirname, '..', 'media', 'runner');
let workRoot = '';
let py3: DetectedRuntime | undefined;
let node: DetectedRuntime | undefined;

describe('real runtimes', () => {
  before(async () => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dlb-verify-test-'));
    fs.mkdirSync(path.join(workRoot, 'run'));
    [py3, node] = await Promise.all([detectPython(PATH_PYTHON_CANDIDATES, { cwd: workRoot }), detectNode({ cwd: workRoot })]);
  });
  after(() => fs.rmSync(workRoot, { recursive: true, force: true, maxRetries: 5 }));
  const local = (rt: DetectedRuntime) => new LocalRunner(rt, { runnerDir: RUNNER_DIR, runRoot: path.join(workRoot, 'run') });

  test('a Python pack verifies end to end', async (t) => {
    if (!py3) return t.skip('no python found');
    const P1 = 'scores = [70, 85, 90, 65]\nprint(scores[1:3])';
    const P2 = "word = 'python'\nprint(word[0:2])";
    const P3 = 'nums = [1, 2, 3]\nprint(nums[1:])';
    const a: PackAtom = {
      ...atom(),
      probes: [
        { id: 'p1', siblingGroup: 'scores', code: P1, answer: '[85, 90]', parSec: 5, mutants: [{ misconceptionId: 'slice-end-included', belief: 'The slice includes the stop index', refutation: 'Index 3 is left out.', code: P1.replace('[1:3]', '[1:4]'), prints: '[85, 90, 65]' }] },
        { id: 'p2', siblingGroup: 'words', code: P2, answer: 'py', parSec: 5, mutants: [{ misconceptionId: 'index-starts-at-one', belief: 'The first item is at position 1', refutation: 'Position 0 is the first letter.', code: P2.replace('[0:2]', '[1:3]'), prints: 'yt' }] },
        { id: 'p3', siblingGroup: 'nums', code: P3, answer: '[2]', parSec: 5, mutants: [] },
      ],
      example: { code: 'temps = [18, 21, 25, 19, 17]\nfirst_two = temps[:2]\nlast_two = temps[-2:]\nprint(first_two)\nprint(last_two)', subgoals: [{ line: 2, label: 'the first two' }] },
      completion: {
        code: 'def middle(xs):\n    # drop the first and the last item\n    inner = [[1]]\n    return inner',
        solutions: ['xs[1:-1]'],
        wrongFills: [{ blank: 1, fill: 'xs[1:]', misconceptionId: 'slice-end-included' }],
        harness: "check(middle([1, 2, 3, 4]) == [2, 3], 'four items')\ncheck(middle([5, 6, 7]) == [6], 'three items')",
        parSec: 30,
      },
      contrast: { wrong: 'xs = [1, 2, 3]\nprint(xs[0:3])', right: 'xs = [1, 2, 3]\nprint(xs[0:2])', misconceptionId: 'slice-end-included', rule: 'A slice stops before the end index.' },
    };
    const r = await verifyPack(pack(a), local(py3), 'python', { now: NOW });
    assert.match(repairFor(r, 'p3')!.what, /your answer: \[2\]; real output: \[2, 3\]/);
    const stored = r.atom!;
    assert.ok(stored, r.log.join('\n'));
    assert.deepEqual(stored.probes.map((p) => p.code), [P1, P2]);
    assert.ok(stored.probes.every((p) => p.discriminating && p.constructs.length > 0));
    assert.equal(stored.examples[0].output.stdout.replace(/\r\n/g, '\n'), '[18, 21]\n[19, 17]\n');
    assert.equal(stored.completions.length, 1, r.log.join('\n'));
    assert.equal(stored.completions[0].wrongFills.length, 1);
    assert.equal(stored.contrasts.length, 1);
  });

  test('a JavaScript pack verifies end to end', async (t) => {
    if (!node) return t.skip('no node found');
    const r = await verifyPack(pack(atom()), local(node), 'javascript', { now: NOW });
    assert.deepEqual(r.repairs, [], r.log.join('\n'));
    assert.equal(r.atom!.probes.length, 4);
    assert.ok(r.atom!.probes.every((p) => p.discriminating));
    assert.equal(r.atom!.completions.length, 1);
  });

  test('a Python lesson with a wrong stated output loses it', async (t) => {
    if (!py3) return t.skip('no python found');
    const ex = '```python\nxs = [1, 2]\nys = xs\nys.append(3)\nprint(xs)  # [1, 2]\n```';
    const r = await verifyLesson({ title: 't', explanation: 'e', example: ex, rule: 'r' }, local(py3));
    assert.equal(r.lesson.example, '```python\nxs = [1, 2]\nys = xs\nys.append(3)\nprint(xs)\n```');
    const ok = await verifyLesson({ title: 't', explanation: 'e', example: ex.replace('# [1, 2]', '# [1, 2, 3]'), rule: 'r' }, local(py3));
    assert.equal(ok.outputVerified, true);
  });
});
