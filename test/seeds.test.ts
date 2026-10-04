import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BatchItem, BatchOptions, BatchRecord, Lang, PrintedArg, Runner, RunResult, SeedTemplate, Val,
} from '../src/contracts';
import {
  CANONICAL_TAGS, PLACEMENT_FUNDAMENTALS, SEMANTICS_TAGS, TAXONOMY, ancestors, canonicalTag, constructTag, descendants,
  isSemantics, misconceptionsFor, tagInfo, tagsFor, topoOrder,
} from '../src/atoms/tags';
import {
  Instantiator, Rng, applyTransform, drawSlot, evalDerive, fillHoles, harnessChecks, parseSeedBank,
  prepareTemplate, sameOutput, seedAtom, seenWithin7Days, singleDiffLine, templateIdOf,
} from '../src/atoms/seeds';
// The Instantiator's default traceback builder.
import { buildTracebackParts as buildTraceback } from '../src/atoms/traceback';

// ------------------------------------------------------------------------------------------------
// Fake runner: runs snippets as JavaScript in-process, with print() and check() predefined.
// ------------------------------------------------------------------------------------------------

function toVal(x: unknown): Val {
  if (x === null) return { t: 'null' };
  if (x === undefined) return { t: 'undefined' };
  if (typeof x === 'number') return { t: 'num', v: x };
  if (typeof x === 'string') return { t: 'str', v: x };
  if (typeof x === 'boolean') return { t: 'bool', v: x };
  if (Array.isArray(x)) return { t: 'list', v: x.map(toVal) };
  if (x instanceof Set) return { t: 'set', v: [...x].map(toVal) };
  if (typeof x === 'object') return { t: 'dict', v: Object.entries(x).map(([k, v]) => [toVal(k), toVal(v)] as [Val, Val]) };
  return { t: 'opaque', type: typeof x, repr: String(x) };
}

const fmt = (x: unknown) =>
  typeof x === 'string' || x === undefined ? String(x) : x instanceof Set ? `Set(${JSON.stringify([...x])})` : JSON.stringify(x);

class CheckFailed extends Error {
  name = 'CheckFailed';
}

function runJs(item: BatchItem): BatchRecord {
  const values: PrintedArg[][] = [];
  let stdout = '';
  const print = (...args: unknown[]) => {
    values.push(args.map((a) => ({ type: typeof a, repr: fmt(a), val: toVal(a) })));
    stdout += args.map(fmt).join(' ') + '\n';
  };
  const check = (cond: unknown, msg: string) => {
    if (!cond) throw new CheckFailed('CHECK ' + msg);
  };
  const base = { id: item.id, ms: 1, timedOut: false, constructs: ['fake'] };
  try {
    new Function('print', 'check', item.code)(print, check);
    return { ...base, stdout, values, exitOk: true };
  } catch (e) {
    const err = e as Error;
    return { ...base, stdout, values, exitOk: false, exception: err.name, error: String(err.stack ?? err) };
  }
}

type Hook = (item: BatchItem, opts: BatchOptions | undefined) => Partial<BatchRecord> | undefined;

class FakeRunner implements Runner {
  readonly runtime;
  calls: { items: BatchItem[]; opts?: BatchOptions }[] = [];
  constructor(lang: Lang = 'javascript', private hook?: Hook) {
    this.runtime = { lang, exe: 'fake', snippetArgv: [], learnerArgv: [], version: 'fake 1.0' };
  }
  async runBatch(items: BatchItem[], opts?: BatchOptions): Promise<BatchRecord[]> {
    this.calls.push({ items, opts });
    return items.map((it) => {
      const over = this.hook?.(it, opts);
      return { ...(this.runtime.lang === 'python' ? empty(it.id) : runJs(it)), ...over, id: it.id };
    });
  }
  async runLearnerCode(): Promise<RunResult> {
    throw new Error('not used');
  }
}

const empty = (id: string): BatchRecord => ({ id, stdout: '', values: [], exitOk: true, timedOut: false, ms: 1, constructs: [] });

function tpl(over: Partial<SeedTemplate> & Pick<SeedTemplate, 'id' | 'tag' | 'kind' | 'code'>): SeedTemplate {
  return { family: over.id, slots: {}, themes: {}, transforms: [], parSec: over.kind === 'completion' ? 25 : 5, ...over };
}

// A probe whose two mutants always print something new (distinct values, i >= 1).
const sliceProbe = tpl({
  id: 'js-slice', tag: 'list-slicing', kind: 'probe', family: 'slice',
  code: 'const {{@xs}} = {{vals}};\nprint({{@xs}}.slice({{i}}, {{j}}));',
  slots: {
    vals: { gen: 'intList', minLen: 5, maxLen: 7, min: 10, max: 99, distinct: true },
    i: { gen: 'int', min: 1, max: 2 },
    j: { gen: 'derive', expr: 'i + 2' },
  },
  themes: { scores: { xs: 'scores' }, temps: { xs: 'temps' } },
  transforms: [
    {
      misconceptionId: 'slice-end-included', find: '.slice({{i}}, {{j}})', replace: '.slice({{i}}, {{j}} + 1)',
      belief: 'The slice includes the item at the stop index', refutation: 'Index {{j}} is left out.', rule: 'Stop is excluded.',
    },
    {
      misconceptionId: 'index-starts-at-one', find: '.slice({{i}}, {{j}})', replace: '.slice({{i}} - 1, {{j}} - 1)',
      belief: 'The first item is at position 1, not 0', refutation: 'Indexes count from zero.', rule: 'Index 0 is first.',
    },
  ],
});

// Valid only when a is 1 or 3: for a = 0 and a = 2, a * a equals a + a.
const squareProbe = tpl({
  id: 'js-square', tag: 'numbers-int-float', kind: 'probe', family: 'square',
  code: 'const n = {{a}};\nprint(n * n, {{b}});',
  // 0 and 2 print the same either way; 1 and 3 differ by one character (a probable slip); 5 and 9 are valid.
  slots: { a: { gen: 'pick', options: [0, 1, 2, 3, 5, 9] }, b: { gen: 'int', min: 1, max: 500 } },
  transforms: [{ misconceptionId: 'float-math-exact', find: 'n * n', replace: 'n + n', belief: 'b', refutation: 'r', rule: 'r' }],
});

const sumCompletion = tpl({
  id: 'js-sum', tag: 'loop-accumulator', kind: 'completion', family: 'sum',
  code: 'function {{@fn}}(xs) {\n  let total = 0;\n  for (const x of xs) {\n    [[1]]\n  }\n  return total;\n}',
  slots: { a: { gen: 'int', min: 1, max: 9 }, b: { gen: 'int', min: 1, max: 9 }, s: { gen: 'derive', expr: 'a + b' } },
  themes: { cart: { fn: 'cartTotal' }, steps: { fn: 'stepTotal' } },
  solutions: ['total += x;'],
  wrongFills: [
    { blank: 1, fill: 'total = x;', misconceptionId: 'assign-instead-of-add' },
    { blank: 1, fill: 'total += x * 1;', misconceptionId: 'reset-inside-loop' }, // passes: dropped
  ],
  harness: "check({{@fn}}([{{a}}, {{b}}]) === {{s}}, 'adds two');\ncheck({{@fn}}([]) === 0, 'empty');",
});

const aliasContrast = tpl({
  id: 'js-alias', tag: 'alias-copy', kind: 'contrast', family: 'alias',
  code: 'const {{@a}} = {{vals}};\nconst {{@b}} = [...{{@a}}];\n{{@b}}.push({{n}});\nprint({{@a}});',
  contrastCode: 'const {{@a}} = {{vals}};\nconst {{@b}} = {{@a}};\n{{@b}}.push({{n}});\nprint({{@a}});',
  slots: { vals: { gen: 'intList', minLen: 2, maxLen: 4, min: 1, max: 9 }, n: { gen: 'int', min: 10, max: 20 } },
  themes: { cart: { a: 'cart', b: 'order' }, team: { a: 'team', b: 'squad' } },
  misconceptionId: 'assignment-copies', rule: 'b = a shares one array.',
});

// ------------------------------------------------------------------------------------------------
// Instantiator
// ------------------------------------------------------------------------------------------------

test('instances are deterministic for a seed and differ across seeds', async () => {
  const run = async (seed: number) => {
    const r = await new Instantiator(new FakeRunner(), seed).instantiate([sliceProbe, sumCompletion], 6);
    return [...r.byTag['list-slicing'].probes.map((p) => p.id + p.code), ...r.byTag['loop-accumulator'].completions.map((c) => c.id + c.harness)];
  };
  const a = await run(42);
  assert.equal(a.length, 12);
  assert.deepEqual(await run(42), a);
  assert.notDeepEqual(await run(43), a);
});

test('a later call draws new instances; exclude never reproduces an id', async () => {
  const inst = new Instantiator(new FakeRunner(), 7);
  const first = (await inst.instantiate([sliceProbe], 5)).byTag['list-slicing'].probes.map((p) => p.id);
  const second = (await inst.instantiate([sliceProbe], 5)).byTag['list-slicing'].probes.map((p) => p.id);
  assert.notDeepEqual(second, first);
  const again = await new Instantiator(new FakeRunner(), 7).instantiate([sliceProbe], 5, { exclude: first });
  const ids = again.byTag['list-slicing'].probes.map((p) => p.id);
  assert.equal(ids.length, 5);
  assert.ok(ids.every((id) => !first.includes(id)));
  assert.equal(new Set(ids).size, ids.length);
});

test('all instances and mutants of a round run in one batch, then once more with another hash seed', async () => {
  const runner = new FakeRunner();
  const r = await new Instantiator(runner, 1).instantiate([sliceProbe, aliasContrast], 3);
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(runner.calls.map((c) => c.opts?.hashSeed), [1, 2]);
  // 3 probes x (original + 2 mutants) + 3 contrasts x 2 snippets
  assert.equal(runner.calls[0].items.length, 3 * 3 + 3 * 2);
  assert.deepEqual(runner.calls[1].items.map((i) => i.id), runner.calls[0].items.map((i) => i.id));
  assert.equal(r.byTag['list-slicing'].probes.length, 3);
  assert.equal(r.byTag['alias-copy'].contrasts.length, 3);
});

test('invalid draws (a mutant printing the same as the original, or a probable slip of it) are redrawn', async () => {
  const runner = new FakeRunner();
  const r = await new Instantiator(runner, 3).instantiate([squareProbe], 8, { maxRounds: 10 });
  const rep = r.reports[0];
  const probes = r.byTag['numbers-int-float'].probes;
  assert.equal(probes.length, 8);
  assert.equal(rep.valid, 8);
  assert.ok(rep.drawn > 8, 'some draws were invalid');
  assert.ok(rep.rejected['mutant-same-as-original'] > 0 && rep.rejected['mutant-slip'] > 0, JSON.stringify(rep.rejected));
  assert.equal(rep.rejected['mutant-same-as-original'] + rep.rejected['mutant-slip'], rep.drawn - 8);
  assert.equal(rep.transforms[0].attributable, 8);
  assert.ok(rep.rounds >= 2);
  assert.equal(runner.calls.length, rep.rounds * 2);
  for (const p of probes) {
    const a = Number(p.code.match(/const n = (\d+)/)![1]);
    assert.ok(a === 5 || a === 9, `a = ${a} cannot be valid`);
    assert.ok(!sameOutput(p.mutants[0].output, p.output));
  }
});

test('redraws are bounded by maxRounds', async () => {
  const always = tpl({ ...squareProbe, id: 'js-same', slots: { a: { gen: 'pick', options: [0, 2] }, b: { gen: 'int', min: 1, max: 500 } } });
  const runner = new FakeRunner();
  const r = await new Instantiator(runner, 3).instantiate([always], 4, { maxRounds: 2 });
  assert.equal(r.byTag['numbers-int-float'], undefined);
  assert.equal(r.reports[0].valid, 0);
  assert.equal(r.reports[0].drawn, 8);
  assert.equal(r.reports[0].transforms[0].changed, 0);
  assert.equal(r.reports[0].transforms[0].ran, 8);
  assert.equal(runner.calls.length, 2, 'invalid on pass A: no pass B');
});

test('probes carry curated mutants with a single-line diff and filled texts', async () => {
  const r = await new Instantiator(new FakeRunner(), 5).instantiate([sliceProbe], 4);
  for (const p of r.byTag['list-slicing'].probes) {
    assert.match(p.id, /^js-slice#[0-9a-z]+$/);
    assert.equal(templateIdOf(p.id), 'js-slice');
    assert.equal(p.mutants.length, 2);
    assert.ok(p.discriminating);
    assert.deepEqual(p.stats, { seenAt: [], n: 0, nCorrect: 0 });
    assert.deepEqual(p.constructs, ['fake']);
    assert.ok(p.answerSpaceG > 0 && p.answerSpaceG <= 0.5);
    for (const m of p.mutants) {
      assert.equal(m.source, 'curated');
      assert.equal(m.ambiguous, false);
      assert.equal(m.diffLine, 2);
      assert.equal(singleDiffLine(p.code, m.code), 2);
      assert.ok(!m.belief.includes('{{') && !m.refutation.includes('{{'));
      assert.ok(m.id.startsWith(p.id + '~'));
    }
    const j = p.code.match(/slice\(\d, (\d)\)/)![1];
    assert.equal(p.mutants[0].refutation, `Index ${j} is left out.`);
    assert.ok(!sameOutput(p.mutants[0].output, p.mutants[1].output));
  }
});

test('sibling groups differ by family and theme', async () => {
  const other = tpl({ ...sliceProbe, id: 'js-slice-2', family: 'slice-other', themes: { ages: { xs: 'ages' }, temps: { xs: 'temps' } } });
  const r = await new Instantiator(new FakeRunner(), 11).instantiate([sliceProbe, other], 12);
  const probes = r.byTag['list-slicing'].probes;
  const groupsOf = (id: string) => new Set(probes.filter((p) => templateIdOf(p.id) === id).map((p) => p.group));
  assert.deepEqual([...groupsOf('js-slice')].sort(), ['slice:scores', 'slice:temps']);
  assert.deepEqual([...groupsOf('js-slice-2')].sort(), ['slice-other:ages', 'slice-other:temps']);
  for (const p of probes) {
    const theme = p.group.split(':')[1];
    assert.ok(p.code.startsWith(`const ${theme} = `), 'the theme renames the identifiers');
  }
});

test('transforms that do not apply exactly once on one line are rejected', () => {
  const t = tpl({
    ...sliceProbe, id: 'js-bad',
    transforms: [
      ...sliceProbe.transforms.slice(0, 1),
      { ...sliceProbe.transforms[0], find: '{{@xs}}' },                       // twice
      { ...sliceProbe.transforms[0], find: 'nowhere' },                       // never
      { ...sliceProbe.transforms[0], find: ';\nprint', replace: ';print' },   // spans lines
      { ...sliceProbe.transforms[0], replace: '.slice(0)\n' },                // replace adds a line
      { ...sliceProbe.transforms[0], misconceptionId: 'made-up-belief' },     // not in the taxonomy
      { ...sliceProbe.transforms[1], misconceptionId: 'negative-index-error' }, // Python-only belief
    ],
  });
  const p = prepareTemplate(t, 'javascript');
  assert.ok(p.ok);
  assert.deepEqual(p.transforms, [0]);
  assert.equal(p.problems.length, 6);
  assert.match(p.problems.join('\n'), /occurs 2 times/);
  assert.match(p.problems.join('\n'), /occurs 0 times/);
  assert.match(p.problems.join('\n'), /one line/);
  assert.match(p.problems.join('\n'), /made-up-belief/);
  assert.equal(applyTransform('a = 1\nb = a', 'a', 'x'), undefined);
  assert.equal(applyTransform('a = 1\nb = 2', 'b = 2', 'b = $& + 1'), 'a = 1\nb = $& + 1');
  const none = prepareTemplate(tpl({ ...sliceProbe, id: 'js-none', transforms: [{ ...sliceProbe.transforms[0], find: 'nowhere' }] }), 'javascript');
  assert.equal(none.ok, false, 'a probe needs at least one applicable transform');
});

test('instantiate skips dropped transforms and reports per-transform change counts', async () => {
  const neutral = { misconceptionId: 'index-starts-at-one', find: 'print(', replace: 'print( ', belief: 'b', refutation: 'r', rule: 'r' };
  const t = tpl({ ...sliceProbe, id: 'js-mixed', transforms: [sliceProbe.transforms[0], { ...sliceProbe.transforms[0], find: 'nowhere' }, neutral] });
  const r = await new Instantiator(new FakeRunner(), 2).instantiate([t], 3, { maxRounds: 1 });
  const rep = r.reports[0];
  assert.equal(rep.transforms[1].applies, false);
  assert.equal(rep.transforms[0].changed, 3);
  assert.equal(rep.transforms[2].ran, 3);
  assert.equal(rep.transforms[2].changed, 0, 'a transform that never changes the output');
  assert.equal(rep.valid, 0);
});

test('completions: solution passes, empty and constant fills fail, passing wrongFills are dropped', async () => {
  const r = await new Instantiator(new FakeRunner(), 9).instantiate([sumCompletion], 4);
  const cs = r.byTag['loop-accumulator'].completions;
  assert.equal(cs.length, 4);
  for (const c of cs) {
    assert.ok(c.code.includes('[[1]]'));
    assert.match(c.code, /^function (cartTotal|stepTotal)\(xs\)/);
    assert.deepEqual(c.solutions, ['total += x;']);
    assert.deepEqual(c.wrongFills, [{ blank: 1, fill: 'total = x;', misconceptionId: 'assign-instead-of-add' }]);
    assert.doesNotMatch(c.harness, /\{\{/);
    assert.equal(c.parSec, 25);
  }
  assert.equal(r.reports[0].droppedWrongFills, 4);

  const emptyPasses = tpl({ ...sumCompletion, id: 'js-empty-passes', harness: "check({{@fn}}([]) === 0, 'a');\ncheck({{@fn}}([0, 0]) === 0, 'b');" });
  const constPasses = tpl({
    ...sumCompletion, id: 'js-const-passes',
    code: 'function {{@fn}}(xs) {\n  let total = 0;\n  for (const x of xs) {\n    total += x;\n  }\n  return [[1]];\n}',
    solutions: ['total'], wrongFills: [],
    harness: "check({{@fn}}([5]) === 5, 'one');\ncheck({{@fn}}([2, 3]) === 5, 'two');",
  });
  const broken = tpl({ ...sumCompletion, id: 'js-broken', solutions: ['total -= x;'] });
  const bad = await new Instantiator(new FakeRunner(), 9).instantiate([emptyPasses, constPasses, broken], 2, { maxRounds: 1 });
  assert.equal(bad.byTag['loop-accumulator'], undefined);
  assert.deepEqual(bad.reports.map((x) => x.rejected), [{ 'empty-passes': 2 }, { 'constant-passes': 2 }, { 'solution-fails': 2 }]);
});

test('completion templates need blanks matching solutions and a check() harness', () => {
  const problems = (over: Partial<SeedTemplate>) => prepareTemplate(tpl({ ...sumCompletion, ...over }), 'javascript');
  assert.ok(problems({}).ok);
  assert.equal(problems({ solutions: ['a', 'b'] }).ok, false);
  assert.equal(problems({ harness: "check({{@fn}}([1]) === 1, 'only one');" }).ok, false);
  assert.equal(problems({ harness: "check({{@fn}}([1]) > 0, 'a');\ncheck({{@fn}}([2]) > 0, 'b');" }).ok, false);
  assert.equal(problems({ code: 'let total = 0;\n[[1]]\n\n\n\nprint(total);' }).ok, false);
  assert.equal(problems({ wrongFills: [{ blank: 2, fill: 'x', misconceptionId: 'assign-instead-of-add' }] }).ok, false);
  assert.equal(problems({ wrongFills: [{ blank: 1, fill: 'x', misconceptionId: 'slice-end-included' }] }).ok, false);
});

test('harnessChecks finds check() calls and their expected literals', () => {
  assert.deepEqual(harnessChecks("check(f([1, 2]) == [2, 4], 'doubles, in order')\ncheck(f([]) == [], 'empty')"),
    { calls: 2, expected: ['[2, 4]', '[]'] });
  assert.deepEqual(harnessChecks("check(5 === total([2, 3]), \"a == b\");"), { calls: 1, expected: ['5'] });
  assert.deepEqual(harnessChecks("check(f('a==b') != 3, 'x'); check(f(1) >= 2, 'y'); recheck(f(1) == 2, 'z')"), { calls: 2, expected: [] });
  assert.deepEqual(harnessChecks("check(count('a,b') == 2, 'counts (commas)')"), { calls: 1, expected: ['2'] });
});

test('contrasts: both snippets run and print different things', async () => {
  const r = await new Instantiator(new FakeRunner(), 4).instantiate([aliasContrast], 3);
  const cs = r.byTag['alias-copy'].contrasts;
  assert.equal(cs.length, 3);
  for (const c of cs) {
    assert.match(c.wrong, /\[\.\.\./);
    assert.doesNotMatch(c.right, /\[\.\.\./);
    assert.equal(c.misconceptionId, 'assignment-copies');
    assert.ok(!sameOutput(c.wrongOutput, c.rightOutput));
  }
  const same = tpl({ ...aliasContrast, id: 'js-alias-same', contrastCode: aliasContrast.code.replace('[...{{@a}}]', '{{@a}}.slice()') });
  const r2 = await new Instantiator(new FakeRunner(), 4).instantiate([same], 2, { maxRounds: 1 });
  assert.deepEqual(r2.reports[0].rejected, { 'contrast-same': 2 });
});

test('nondeterministic output across hash seeds is rejected', async () => {
  const flaky = tpl({ ...sliceProbe, id: 'js-flaky', code: '// NONDET\n' + sliceProbe.code });
  flaky.transforms = sliceProbe.transforms.map((x) => ({ ...x }));
  const runner = new FakeRunner('javascript', (item, opts) =>
    opts?.hashSeed === 2 && item.code.includes('NONDET') && item.id.endsWith('~orig') ? { stdout: 'shuffled\n' } : undefined);
  const r = await new Instantiator(runner, 1).instantiate([flaky, sliceProbe], 3, { maxRounds: 1 });
  assert.deepEqual(r.reports[0].rejected, { nondeterministic: 3 });
  assert.equal(r.reports[0].valid, 0);
  assert.equal(r.byTag['list-slicing'].probes.length, 3);
  assert.ok(r.byTag['list-slicing'].probes.every((p) => templateIdOf(p.id) === 'js-slice'));
});

test('intentionally raising probes record the exception; syntax-error mutants invalidate', async () => {
  const raising = tpl({
    id: 'js-undef', tag: 'object-property-access', kind: 'probe',
    code: 'const {{@o}} = undefined;\nprint({{@o}}.{{w}});',
    slots: { w: { gen: 'word', pool: 'colors' } },
    themes: { cfg: { o: 'config' } },
    transforms: [{ misconceptionId: 'property-of-undefined-ok', find: '{{@o}}.{{w}}', replace: '{{@o}}?.{{w}}', belief: 'b', refutation: 'r', rule: 'r' }],
  });
  const r = await new Instantiator(new FakeRunner(), 1).instantiate([raising], 2);
  const p = r.byTag['object-property-access'].probes[0];
  assert.equal(p.raises, true);
  assert.equal(p.output.exception, 'TypeError');
  assert.equal(p.answerSpaceG, 0.25);
  assert.equal(p.mutants[0].output.stdout, 'undefined\n');

  const broken = tpl({ ...raising, id: 'js-syntax', transforms: [{ ...raising.transforms[0], replace: '{{@o}}..{{w}}' }] });
  const r2 = await new Instantiator(new FakeRunner(), 1).instantiate([broken], 2, { maxRounds: 1 });
  assert.deepEqual(r2.reports[0].rejected, { 'mutant-failed': 2 });
});

test('denied items are dropped and reported', async () => {
  const runner = new FakeRunner('javascript', () => ({ denied: 'require(' }));
  const r = await new Instantiator(runner, 1).instantiate([sliceProbe], 2, { maxRounds: 1 });
  assert.deepEqual(r.reports[0].rejected, { denied: 2 });
  assert.match(r.reports[0].problems.join('\n'), /denied by the allowlist: require\(/);
});

test('examples run cleanly and keep filled subgoals', async () => {
  const ex = tpl({
    id: 'js-ex', tag: 'loop-accumulator', kind: 'example',
    code: 'const {{@xs}} = {{vals}};\nlet total = 0;\nfor (const x of {{@xs}}) {\n  total += x;\n}\nprint(total);',
    slots: { vals: { gen: 'intList', minLen: 3, maxLen: 4, min: 1, max: 9 } },
    themes: { prices: { xs: 'prices' } },
    subgoals: [{ line: 2, label: 'start the total at 0' }, { line: 4, label: 'add each of the {{@xs}}' }],
  });
  const r = await new Instantiator(new FakeRunner(), 1).instantiate([ex], 2);
  const e = r.byTag['loop-accumulator'].examples[0];
  assert.equal(e.group, 'js-ex:prices');
  assert.deepEqual(e.subgoals[1], { line: 4, label: 'add each of the prices' });
  assert.match(e.output.stdout, /^\d+\n$/);
});

test('traceback items keep the snippet frames, renumbered to pad lines', async () => {
  const pyError = [
    'Traceback (most recent call last):',
    '  File "C:\\ext\\media\\runner\\batch.py", line 80, in <module>',
    '    main()',
    '  File "C:\\ext\\media\\runner\\batch.py", line 50, in run_item',
    '    exec(code, ns)',
    '  File "<snippet>", line 4, in <module>',
    '  File "<snippet>", line 2, in last',
    'IndexError: list index out of range',
  ].join('\n');
  const code = 'def last(xs):\n    return xs[len(xs)]\nnums = [1, 2]\nprint(last(nums))';
  const rec = { ...empty('x'), exitOk: false, exception: 'IndexError', error: pyError };
  const parts = buildTraceback(code, rec, 'python', new Rng(1))!;
  assert.equal(parts.line, 2);
  assert.equal(parts.exception, 'IndexError');
  assert.equal(parts.trace, [
    'Traceback (most recent call last):', '  File "pad", line 4, in <module>', '    print(last(nums))',
    '  File "pad", line 2, in last', '    return xs[len(xs)]', 'IndexError: list index out of range',
  ].join('\n'));
  assert.equal(parts.meanings.length, 3);
  assert.match(parts.meanings[parts.correctMeaning], /past its end/);

  const jsError = "TypeError: Cannot read properties of undefined (reading 'name')\n    at first (pad.js:2:20)\n    at pad.js:4:13\n    at Script.runInContext (node:vm:149:12)\n    at run (C:\\ext\\media\\runner\\batch.mjs:40:3)";
  const js = buildTraceback('function first(xs) {\n  return xs[0].name;\n}\nconsole.log(first([]));', { ...rec, exception: 'TypeError', error: jsError }, 'javascript', new Rng(1))!;
  assert.equal(js.line, 2);
  assert.equal(js.trace, "TypeError: Cannot read properties of undefined (reading 'name')\n    at first (pad:2:20)\n    at pad:4:13");
  assert.equal(buildTraceback(code, { ...rec, error: 'IndexError: list index out of range' }, 'python', new Rng(1)), undefined);
  assert.equal(buildTraceback(code, { ...rec, exception: 'MemoryError' }, 'python', new Rng(1)), undefined, 'no meaning for it');

  // Through the Instantiator: a python-runtime fake that answers with the canned trace.
  const tb = tpl({ id: 'py-tb', tag: 'reading-tracebacks', kind: 'traceback', code, family: 'tb', slots: {}, themes: {} });
  const runner = new FakeRunner('python', () => ({ exitOk: false, exception: 'IndexError', error: pyError }));
  const r = await new Instantiator(runner, 1).instantiate([tb], 1);
  const item = r.byTag['reading-tracebacks'].tracebacks[0];
  assert.equal(item.line, 2);
  assert.equal(item.siblingGroup, 'tb:plain');
  assert.equal(item.conceptId, 'reading-tracebacks');
});

test('python state-trace tags ask the runner for a trace on the original only', async () => {
  const probe = tpl({
    id: 'py-alias', tag: 'alias-copy', kind: 'probe', code: 'a = [1]\nb = a\nb.append(2)\nprint(a)',
    transforms: [{ misconceptionId: 'assignment-copies', find: 'b = a', replace: 'b = a.copy()', belief: 'b', refutation: 'r', rule: 'r' }],
  });
  const runner = new FakeRunner('python', (item) => ({
    stdout: item.id.endsWith('~orig') ? '[1, 2]\n' : '[1]\n',
    trace: item.id.endsWith('~orig') ? [{ line: 2, text: 'a=[1]  b is a' }] : undefined,
  }));
  const r = await new Instantiator(runner, 1).instantiate([probe], 1);
  assert.deepEqual(runner.calls[0].items.map((i) => !!i.wantTrace), [true, false]);
  assert.ok(runner.calls[1].items.every((i) => !i.wantTrace));
  assert.deepEqual(r.byTag['alias-copy'].probes[0].trace, [{ line: 2, text: 'a=[1]  b is a' }]);
});

test('seedAtom assembles a StoredAtom with the canonical pattern name', async () => {
  const r = await new Instantiator(new FakeRunner(), 1).instantiate([sliceProbe], 2);
  const atom = seedAtom('list-slicing', 'javascript', r.byTag['list-slicing'], {
    lang: 'javascript', templates: [],
    patterns: { 'list-slicing': { kind: 'shape', name: 'Slicing!', useWhen: 'u', template: 't', rule: '', howItRuns: '', pitfall: 'p', useCases: [] } },
  }, 1000);
  assert.equal(atom.pattern.name, 'Slice a sequence');
  assert.equal(atom.key, 'list-slicing');
  assert.equal(atom.source, 'seed');
  assert.equal(atom.probes.length, 2);
});

// ------------------------------------------------------------------------------------------------
// Slots, holes and freshness
// ------------------------------------------------------------------------------------------------

test('derive expressions use floor semantics and earlier slots only', () => {
  const v = { a: 7, b: 2, xs: [4, 8, 15] };
  assert.equal(evalDerive('a + b * 2', v), 11);
  assert.equal(evalDerive('-a // b', v), -4);
  assert.equal(evalDerive('-7 % 3', v), 2);
  assert.equal(evalDerive('len(xs) - 1', v), 2);
  assert.equal(evalDerive('xs[-1] + sum(xs) + max(a, b) + min(xs) + abs(-3)', v), 15 + 27 + 7 + 4 + 3);
  assert.throws(() => evalDerive('a // (b - 2)', v), /division by zero/);
  assert.throws(() => evalDerive('c + 1', v), /unknown slot c/);
  assert.throws(() => evalDerive('a +', v), /bad derive/);
  assert.throws(() => evalDerive('eval(a)', v), /unknown function/);
  const later = prepareTemplate(tpl({ ...squareProbe, id: 'js-later', slots: { d: { gen: 'derive', expr: 'a + 1' }, a: { gen: 'int', min: 0, max: 3 } } }));
  assert.equal(later.ok, false);
  assert.match(later.problems.join(), /unknown or later slot 'a'/);
});

test('slot generators and hole filling', () => {
  const rng = new Rng(5);
  for (let k = 0; k < 50; k++) {
    const values: Record<string, number | number[] | string | string[]> = {};
    const [xs, xsText] = drawSlot({ gen: 'intList', minLen: 3, maxLen: 5, min: 0, max: 9, distinct: true, sorted: true }, rng, values);
    values.xs = xs;
    const list = xs as number[];
    assert.ok(list.length >= 3 && list.length <= 5);
    assert.equal(new Set(list).size, list.length);
    assert.deepEqual(list, list.slice().sort((a, b) => a - b));
    assert.equal(xsText, `[${list.join(', ')}]`);
    const [neg] = drawSlot({ gen: 'index', of: 'xs', negative: true }, rng, values);
    assert.ok((neg as number) < 0 && (neg as number) >= -list.length);
    const [off] = drawSlot({ gen: 'index', of: 'xs', offset: 1 }, rng, values);
    assert.ok((off as number) >= 1 && (off as number) <= list.length);
    const [n] = drawSlot({ gen: 'int', min: 1, max: 3, notIn: [2] }, rng, values);
    assert.ok(n === 1 || n === 3);
  }
  const [, words] = drawSlot({ gen: 'wordList', pool: 'fruits', minLen: 2, maxLen: 2, distinct: true }, rng, {});
  assert.match(words, /^\['[a-z]+', '[a-z]+'\]$/);
  assert.equal(fillHoles('{{@xs}}[{{i}}] {{@xs}}', { i: '2' }, { xs: 'scores' }), 'scores[2] scores');
  assert.throws(() => fillHoles('{{nope}}', {}, {}), /unknown slot/);
  assert.throws(() => fillHoles('{{@constructor}}', {}, {}), /unknown theme variable/);
});

test('sameOutput is strict on text and types but ignores set and dict order', () => {
  const arg = (val: Val, repr: string): PrintedArg => ({ type: val.t, repr, val });
  const out = (stdout: string, ...vals: [Val, string][]) => ({ stdout, values: vals.map(([v, r]) => [arg(v, r)]) });
  const int = (v: string): Val => ({ t: 'int', v });
  const set12 = out('{1, 2}\n', [{ t: 'set', v: [int('1'), int('2')] }, '{1, 2}']);
  const set21 = out('{2, 1}\n', [{ t: 'set', v: [int('2'), int('1')] }, '{2, 1}']);
  assert.ok(sameOutput(set12, set21));
  assert.ok(!sameOutput(out('2\n', [int('2'), '2']), out('2.0\n', [{ t: 'float', v: 2 }, '2.0'])));
  assert.ok(sameOutput(out('2\n', [int('2'), '2']), out('2\n', [{ t: 'str', v: '2' }, "'2'"])), 'no answer tells these apart');
  assert.ok(!sameOutput({ stdout: 'a\n', values: [] }, { stdout: 'b\n', values: [] }));
  assert.ok(!sameOutput({ stdout: '', values: [], exception: 'KeyError' }, { stdout: '', values: [], exception: 'IndexError' }));
  assert.ok(sameOutput({ stdout: 'x \r\n', values: [] }, { stdout: 'x\n', values: [] }));
});

test('no exact repeat within 7 days', () => {
  const day = 86_400_000;
  const now = 100 * day;
  assert.equal(seenWithin7Days(undefined, now), false);
  assert.equal(seenWithin7Days({ seenAt: [] }, now), false);
  assert.equal(seenWithin7Days({ seenAt: [now - 6.9 * day] }, now), true);
  assert.equal(seenWithin7Days({ seenAt: [now - 30 * day, now - 7 * day] }, now), false);
  assert.equal(seenWithin7Days({ seenAt: [now - 8 * day, now - 1000] }, now), true);
});

test('the bundled python sample is a valid seed file', () => {
  const json = JSON.parse(readFileSync(join(__dirname, '..', 'media', 'seed', 'python.json'), 'utf8'));
  const { bank, problems } = parseSeedBank(json, 'python');
  assert.deepEqual(problems, []);
  assert.deepEqual([...new Set(bank.templates.map((t) => t.kind))].sort(), ['completion', 'contrast', 'example', 'probe', 'traceback']);
  const probe = bank.templates.find((t) => t.kind === 'probe')!;
  assert.equal(probe.transforms.length, 2);
  assert.deepEqual(prepareTemplate(probe, 'python').transforms, [0, 1]);
  assert.equal(prepareTemplate(probe, 'javascript').ok, true, 'the tag exists in JS too');
  for (const tag of Object.keys(bank.patterns!)) assert.equal(bank.patterns![tag].name, tagInfo(tag)!.patternName);
});

// ------------------------------------------------------------------------------------------------
// Taxonomy
// ------------------------------------------------------------------------------------------------

const SPEC_TAGS = [
  'variables-assignment', 'numbers-int-float', 'integer-division-modulo', 'str-vs-number', 'string-indexing',
  'string-methods', 'string-formatting', 'string-split-join', 'booleans-truthiness', 'comparison-equality',
  'identity-vs-equality', 'conditionals', 'while-loop-termination', 'for-range-bounds', 'loop-accumulator',
  'nested-loops', 'break-continue', 'print-placement-in-loops', 'list-indexing', 'list-slicing',
  'list-mutation-methods', 'alias-copy', 'list-comprehension', 'tuple-unpacking', 'dict-access-missing-key',
  'dict-iteration', 'counting-with-dict', 'collections-counter', 'set-membership', 'sorting-key', 'function-def-call',
  'function-return-vs-print', 'function-params-defaults', 'mutable-default-arg', 'scope-local-global',
  'closure-capture', 'closure-late-binding', 'recursion-base-case', 'recursion-call-stack', 'recursion-combine',
  'exceptions-try-except', 'raising-errors', 'reading-tracebacks', 'class-def-init', 'instance-attributes',
  'methods-self-this', 'generator-yield', 'generator-laziness', 'file-read-lines', 'json-parse-serialize',
  'modules-imports', 'off-by-one',
  'null-undefined', 'loose-vs-strict-equality', 'let-const-var-scope', 'array-map-filter-reduce',
  'object-property-access', 'promise-basics', 'await-sequencing', 'async-error-handling', 'callbacks-event-loop',
  'this-method-call', 'this-arrow-vs-function', 'type-annotations',
  'other',
];

test('the taxonomy has exactly the spec tags, with semantics kinds as listed', () => {
  assert.deepEqual([...CANONICAL_TAGS].sort(), [...SPEC_TAGS].sort());
  assert.equal(CANONICAL_TAGS[CANONICAL_TAGS.length - 1], 'other');
  for (const t of CANONICAL_TAGS) assert.equal(TAXONOMY[t].kind === 'semantics', SEMANTICS_TAGS.includes(t), t);
  assert.equal(SEMANTICS_TAGS.length, 10);
  assert.ok(isSemantics('alias-copy') && !isSemantics('list-slicing') && !isSemantics('nope'));
  assert.equal(canonicalTag('List Slicing'), 'list-slicing');
  assert.equal(canonicalTag('list_slicing'), 'list-slicing');
  assert.equal(canonicalTag('constructor'), 'other');
  assert.equal(tagInfo('__proto__'), undefined);
});

test('the tag DAG is acyclic and every reference points at an existing tag', () => {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (t: string, path: string[]) => {
    if (state.get(t) === 'done') return;
    assert.notEqual(state.get(t), 'visiting', `cycle: ${[...path, t].join(' -> ')}`);
    state.set(t, 'visiting');
    for (const p of TAXONOMY[t].prereqs) visit(p, [...path, t]);
    if (TAXONOMY[t].parent) visit(TAXONOMY[t].parent!, [...path, t]);
    state.set(t, 'done');
  };
  for (const t of CANONICAL_TAGS) {
    const e = TAXONOMY[t];
    assert.equal(e.tag, t);
    for (const ref of [...e.prereqs, ...e.alternatives, ...(e.parent ? [e.parent] : [])]) {
      assert.ok(TAXONOMY[ref] && ref !== 'other' && ref !== t, `${t} -> ${ref}`);
    }
    // A prerequisite or parent exists in every language of the tag.
    for (const p of [...e.prereqs, ...(e.parent ? [e.parent] : [])]) {
      for (const l of e.langs) assert.ok(TAXONOMY[p].langs.includes(l), `${t} (${l}) needs ${p}`);
    }
    for (const a of e.alternatives) assert.ok(TAXONOMY[a].alternatives.includes(t), `alternatives are symmetric: ${t} <-> ${a}`);
    if (e.parent) assert.ok(ancestors(t).includes(e.parent), `${t}'s parent is one of its ancestors`);
    visit(t, []);
  }
  for (const lang of ['python', 'javascript', 'typescript'] as Lang[]) {
    const order = topoOrder(lang);
    assert.deepEqual([...order].sort(), tagsFor(lang).sort());
    const pos = new Map(order.map((t, i) => [t, i]));
    for (const t of order) for (const p of TAXONOMY[t].prereqs) assert.ok(pos.get(p)! < pos.get(t)!, `${p} before ${t}`);
  }
});

test('large tags are split into sub-atom chains', () => {
  const chains = [
    ['function-def-call', 'function-return-vs-print', 'function-params-defaults'],
    ['class-def-init', 'instance-attributes', 'methods-self-this'],
    ['recursion-base-case', 'recursion-call-stack', 'recursion-combine'],
    ['closure-capture', 'closure-late-binding'],
    ['generator-yield', 'generator-laziness'],
    ['promise-basics', 'await-sequencing', 'async-error-handling'],
    ['this-method-call', 'this-arrow-vs-function'],
  ];
  for (const [head, ...subs] of chains) {
    assert.equal(TAXONOMY[head].parent, undefined);
    subs.forEach((s, i) => {
      assert.equal(TAXONOMY[s].parent, head);
      assert.ok(TAXONOMY[s].prereqs.includes(i === 0 ? head : subs[i - 1]), `${s} follows its chain`);
      assert.ok(descendants(head).includes(s));
    });
  }
  // ancestors and descendants are inverse relations.
  for (const t of CANONICAL_TAGS) for (const a of ancestors(t)) assert.ok(descendants(a).includes(t), `${a} => ${t}`);
  assert.ok(!descendants('variables-assignment', 'python').includes('promise-basics'));
  assert.ok(descendants('variables-assignment', 'javascript').includes('promise-basics'));
});

test('misconceptions are stable, precise and within the reading budget', () => {
  const beliefs = new Map<string, string>();
  for (const t of CANONICAL_TAGS) {
    const e = TAXONOMY[t];
    assert.ok(e.patternName.trim().split(/\s+/).length <= 5, `${t}: pattern name '${e.patternName}' over 5 words`);
    assert.ok(e.langs.length > 0);
    if (t === 'other') continue;
    assert.ok(e.example && e.example.length <= 80, `${t}: one-line example`);
    const ids = e.misconceptions.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, `${t}: duplicate misconception id`);
    for (const lang of e.langs) {
      const n = misconceptionsFor(t, lang).length;
      assert.ok(n >= 2 && n <= 4, `${t} has ${n} misconceptions for ${lang}`);
    }
    for (const m of e.misconceptions) {
      assert.match(m.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
      assert.ok(m.belief.trim().split(/\s+/).length <= 12, `${m.id}: belief over 12 words`);
      assert.ok(m.prior > 0 && m.prior < 1);
      for (const l of m.langs ?? []) assert.ok(e.langs.includes(l), `${m.id}: language outside its tag`);
      // One id means one belief, word for word, across tags.
      if (beliefs.has(m.id)) assert.equal(m.belief, beliefs.get(m.id), m.id);
      beliefs.set(m.id, m.belief);
    }
    // Coverage needs at least one common (prior >= .2) misconception per language.
    for (const lang of e.langs) assert.ok(misconceptionsFor(t, lang).some((m) => m.prior >= 0.2), `${t}/${lang}`);
  }
  assert.ok(TAXONOMY['counting-with-dict'].alternatives.includes('collections-counter'));
  assert.ok(TAXONOMY['tuple-unpacking'].typeSensitive && TAXONOMY['str-vs-number'].typeSensitive && TAXONOMY['numbers-int-float'].typeSensitive);
  for (const t of ['alias-copy', 'scope-local-global', 'mutable-default-arg', 'closure-late-binding', 'list-mutation-methods', 'loop-accumulator']) {
    assert.ok(TAXONOMY[t].stateTrace, t);
  }
});

test('placement fundamentals are ~22 per language, in dependency order', () => {
  for (const lang of ['python', 'javascript', 'typescript'] as Lang[]) {
    const list = PLACEMENT_FUNDAMENTALS[lang];
    assert.ok(list.length >= 20 && list.length <= 24, `${lang}: ${list.length}`);
    assert.equal(new Set(list).size, list.length);
    list.forEach((t, i) => {
      assert.ok(tagsFor(lang).includes(t), `${t} is a ${lang} tag`);
      for (const a of ancestors(t, lang)) {
        if (list.includes(a)) assert.ok(list.indexOf(a) < i, `${lang}: ${a} must come before ${t}`);
      }
    });
  }
  assert.ok(!tagsFor('python').includes('promise-basics'));
  assert.ok(tagsFor('typescript').includes('type-annotations') && !tagsFor('javascript').includes('type-annotations'));
  assert.ok(!tagsFor('python').includes('other'));
});

test('runner constructs map to tags of their own language; basics map to nothing', () => {
  assert.equal(constructTag('slice', 'python'), 'list-slicing');
  assert.equal(constructTag('method:append', 'python'), 'list-mutation-methods');
  assert.equal(constructTag('floor-div', 'python'), 'integer-division-modulo');
  assert.equal(constructTag('loose-eq', 'javascript'), 'loose-vs-strict-equality');
  assert.equal(constructTag('method:map', 'typescript'), 'array-map-filter-reduce');
  assert.equal(constructTag('as-cast', 'typescript'), 'type-annotations');
  // The constructs every probe leans on never confound a probe.
  for (const c of ['call:print', 'call:len', 'call:repr', 'list-literal']) assert.equal(constructTag(c, 'python'), undefined, c);
  for (const c of ['method:log', 'const', 'let', 'array-literal', 'typeof', 'method:stringify', 'type-annotation']) {
    assert.equal(constructTag(c, 'typescript'), undefined, c);
  }
  // A tag the language lacks maps to nothing ('type-annotations' is TS only).
  assert.equal(constructTag('as-cast', 'javascript'), undefined);
});
