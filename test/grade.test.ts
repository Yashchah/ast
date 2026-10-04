import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BatchItem, BatchOptions, BatchRecord, PrintedArg, RecordedOutput, Runner, StoredCompletion, StoredMutant, StoredProbe, TracebackItem, Val } from '../src/contracts';
import { detectNode, detectPython, LocalRunner, PATH_PYTHON_CANDIDATES, type DetectedRuntime } from '../src/runner';
import {
  answerText, commentToken, copiesLiteral, extractFills, failingCheckLine, gradeCompletion, gradeMeaningPick, gradePredict, gradeTraceback,
  matchWrongFill, parseAnswerLines, parseTracebackAnswer,
} from '../src/atoms/grade';

// ---------------------------------------------------------------- fixtures

const int = (n: number): Val => ({ t: 'int', v: String(n) });
const arg = (val: Val, repr: string, type = val.t): PrintedArg => ({ type, repr, val });
const pyList = (ns: number[]) => arg({ t: 'list', v: ns.map(int) }, `[${ns.join(', ')}]`, 'list');
const pyStr = (s: string) => arg({ t: 'str', v: s }, `'${s}'`, 'str');
function printed(...calls: PrintedArg[][]): RecordedOutput {
  return { stdout: calls.map((args) => args.map((a) => (a.val.t === 'str' ? a.val.v : a.repr)).join(' ')).join('\n') + '\n', values: calls };
}

function mutant(id: string, misconceptionId: string, output: RecordedOutput, ambiguous = false): StoredMutant {
  return {
    id, misconceptionId, belief: 'The slice includes the stop index', refutation: 'A slice stops before its stop index.', rule: 'Start in, stop out.',
    code: '', output, diffLine: 2, source: 'curated', ambiguous, matches: 0, confirmations: 0, rejections: 0,
  };
}

const probe: Pick<StoredProbe, 'code' | 'output' | 'mutants'> = {
  code: 'scores = [3, 1, 4, 1, 5]\nprint(scores[1:3])',
  output: printed([pyList([1, 4])]),
  mutants: [mutant('m-end', 'slice-end-included', printed([pyList([1, 4, 1])])), mutant('m-one', 'index-starts-at-one', printed([pyList([3, 1])]))],
};

// ---------------------------------------------------------------- answer lines

test('parseAnswerLines: every # -> line in order, | splits, other comments ignored', () => {
  const doc = '# what does this print?\nxs = [1]\n# -> [1, 4]\n#-> 2 | 3\n  # ->   x  \n# not -> an answer\n';
  assert.deepEqual(parseAnswerLines(doc, '#'), ['[1, 4]', '2', '3', '  x']);
  assert.deepEqual(parseAnswerLines(doc, '#', { split: false }), ['[1, 4]', '2 | 3', '  x']);
  assert.deepEqual(parseAnswerLines('// what?\nlet x = 1;\n// -> 1\n// -> \n', '//'), ['1']);
  assert.deepEqual(parseAnswerLines('# -> \n# -> ', '#'), []);
  assert.equal(commentToken('python'), '#');
  assert.equal(commentToken('typescript'), '//');
  assert.equal(commentToken('rust'), '//');
});

test('answerText keeps " | " for compareOutput, which splits it itself (and can keep a printed |)', () => {
  assert.equal(answerText('# -> a | b\n# -> c', '#'), 'a | b\nc');
});

// ---------------------------------------------------------------- predict

test('gradePredict: correct, with the coverage of the probe mutants', () => {
  const g = gradePredict('[1, 4]', probe, 'python', false);
  assert.equal(g.verdict, 'correct');
  assert.equal(g.correct, true);
  assert.equal(g.empty, false);
  assert.deepEqual(g.avoidedMisconceptionIds, ['slice-end-included', 'index-starts-at-one']);
  assert.equal(g.actual, '[1, 4]');
});

test('gradePredict: a wrong answer equal to a mutant output names its misconception', () => {
  const g = gradePredict('[1, 4, 1]', probe, 'python', false);
  assert.equal(g.verdict, 'wrong');
  assert.equal(g.correct, false);
  assert.equal(g.misconceptionId, 'slice-end-included');
  assert.equal(g.mutant?.id, 'm-end');
});

test('gradePredict: no belief for an ambiguous mutant, an edit-distance-1 slip or a bare "error"', () => {
  const amb = { ...probe, mutants: [mutant('m-end', 'slice-end-included', printed([pyList([1, 4, 1])]), true)] };
  const a = gradePredict('[1, 4, 1]', amb, 'python', false);
  assert.equal(a.misconceptionId, undefined);
  assert.equal(a.ambiguous, true);
  const slip = { ...probe, mutants: [mutant('m-x', 'x', printed([pyList([1, 41])]))] };
  assert.equal(gradePredict('[1, 41]', slip, 'python', false).misconceptionId, undefined, '[1, 41] is one edit from [1, 4]');
  const raising = { ...probe, mutants: [mutant('m-err', 'x', { stdout: '', values: [], exception: 'IndexError' })] };
  assert.equal(gradePredict('error', raising, 'python', false).misconceptionId, undefined);
  assert.equal(gradePredict('IndexError', raising, 'python', false).misconceptionId, 'x');
});

test("gradePredict: format-only gives a note and no evidence verdict; wrong under a type-sensitive tag", () => {
  const p = { code: "word = 'hi'\nprint(word)", output: printed([pyStr('hi')]), mutants: [] };
  const g = gradePredict("'hi'", p, 'python', false);
  assert.equal(g.verdict, 'format-only');
  assert.equal(g.correct, undefined, 'format-only records no evidence');
  assert.match(g.note!, /right idea; Python writes it as hi/);
  assert.equal(gradePredict("'hi'", p, 'python', true).verdict, 'wrong');
});

test('gradePredict: ? is don\'t know, an empty answer re-prompts', () => {
  const dk = gradePredict('?', probe, 'python', false);
  assert.equal(dk.verdict, 'dont-know');
  assert.equal(dk.correct, null);
  assert.equal(dk.empty, false);
  const empty = gradePredict('  \n# -> ', probe, 'python', false);
  assert.equal(empty.empty, true);
  assert.equal(empty.correct, undefined);
});

test('gradePredict: a raising probe is answered with the exception name; multi-line outputs by line or |', () => {
  const raising = { code: 'd = {}\nprint(d["k"])', output: { stdout: '', values: [], exception: 'KeyError' }, mutants: [] };
  assert.equal(gradePredict('KeyError', raising, 'python', false).verdict, 'correct');
  const two = { code: 'print(1)\nprint(2)', output: printed([arg(int(1), '1')], [arg(int(2), '2')]), mutants: [] };
  assert.equal(gradePredict('1 | 2', two, 'python', false).verdict, 'correct');
  assert.equal(gradePredict('1\n2', two, 'python', false).verdict, 'correct');
  assert.equal(gradePredict('1', two, 'python', false).verdict, 'wrong');
});

test('copiesLiteral: an answer that repeats a 5+ character literal from the code', () => {
  assert.equal(copiesLiteral('[3, 1, 4, 1, 5]', probe.code, 'python'), true);
  assert.equal(copiesLiteral('[3,1,4,1,5]', probe.code, 'python'), true, 'spacing does not matter');
  assert.equal(copiesLiteral('[1, 4]', probe.code, 'python'), false);
  assert.equal(copiesLiteral('hello', "msg = 'hello'\nprint(msg.upper())", 'python'), true);
  assert.equal(copiesLiteral('hi', "msg = 'hi'", 'python'), false, 'shorter than 5');
  assert.equal(copiesLiteral('[1, 2]', 'f([1, 2])', 'python'), true);
  assert.equal(gradePredict('[3, 1, 4, 1, 5]', probe, 'python', false).copiedLiteral, true);
});

// ---------------------------------------------------------------- completion

const completion: StoredCompletion = {
  id: 'c1', group: 'accumulate:prices', parSec: 25, stats: { seenAt: [], n: 0, nCorrect: 0 },
  code: 'def total_over(prices, limit):\n    total = 0\n    for price in prices:\n        if price > limit:\n            [[1]]\n    return total',
  solutions: ['total += price'],
  wrongFills: [{ blank: 1, fill: 'total = price', misconceptionId: 'assign-instead-of-add' }],
  harness: "check(total_over([9, 2, 8], 5) == 17, 'adds only the values above the limit')",
};

class FakeRunner implements Runner {
  readonly runtime = { lang: 'python' as const, exe: 'python', snippetArgv: [], learnerArgv: [], version: '3.14' };
  calls: { items: BatchItem[]; opts?: BatchOptions }[] = [];
  constructor(private readonly reply: (code: string) => Partial<BatchRecord>) {}
  async runBatch(items: BatchItem[], opts?: BatchOptions): Promise<BatchRecord[]> {
    this.calls.push({ items, opts });
    return items.map((it) => ({ id: it.id, stdout: '', values: [], exitOk: false, timedOut: false, ms: 12, constructs: [], ...this.reply(it.code) }));
  }
  async runLearnerCode(): Promise<never> {
    throw new Error('not used');
  }
}

const doc = (fill: string, header = '# fill the blank, then Ctrl+Enter\n') =>
  `${header}def total_over(prices, limit):\n    total = 0\n    for price in prices:\n        if price > limit:\n            ${fill}\n    return total\n`;

const checkError = (line: number, msg: string) =>
  `Traceback (most recent call last):\n  File "<snippet>", line ${line}, in <module>\n    check(...)\nCheckFailed: CHECK ${msg}\n`;

test('gradeCompletion: runs document + newline + harness; exit 0 passes', async () => {
  const r = new FakeRunner(() => ({ exitOk: true }));
  const g = await gradeCompletion(doc('total += price'), completion, r, 'python');
  assert.equal(g.pass, true);
  assert.equal(g.empty, false);
  assert.deepEqual(g.fills, ['total += price']);
  assert.deepEqual(g.blankLines, [5]);
  assert.equal(r.calls.length, 1);
  const code = r.calls[0].items[0].code;
  assert.ok(code.endsWith(`return total\n${completion.harness}\n`), 'document, newline, harness');
});

test('gradeCompletion: the failing check is found by its CHECK marker; a tagged wrongFill names its misconception', async () => {
  const r = new FakeRunner(() => ({ exception: 'CheckFailed', error: checkError(8, 'adds only the values above the limit') }));
  const g = await gradeCompletion(doc('total = price'), completion, r, 'python');
  assert.equal(g.pass, false);
  assert.equal(g.checkFailed, true);
  assert.equal(g.message, 'adds only the values above the limit');
  assert.equal(g.misconceptionId, 'assign-instead-of-add');
  assert.equal(g.wrongFillBlank, 1);
  // Spacing differences do not hide the wrong fill.
  const g2 = await gradeCompletion(doc('total=price'), completion, r, 'python');
  assert.equal(g2.misconceptionId, 'assign-instead-of-add');
  // Any other wrong fill fails without a belief.
  const g3 = await gradeCompletion(doc('total -= price'), completion, r, 'python');
  assert.equal(g3.misconceptionId, undefined);
});

test('gradeCompletion: unfilled blanks re-prompt without running', async () => {
  const r = new FakeRunner(() => ({ exitOk: true }));
  const g = await gradeCompletion(doc('___'), completion, r, 'python');
  assert.equal(g.empty, true);
  assert.equal(r.calls.length, 0);
  const g2 = await gradeCompletion(doc(''), completion, r, 'python');
  assert.equal(g2.empty, true);
});

test('gradeCompletion: a crash in the learner code reports the exception line and the document line', async () => {
  const err = 'Traceback (most recent call last):\n  File "<snippet>", line 8, in <module>\n    check(...)\n  File "<snippet>", line 6, in total_over\n    totl += price\nNameError: name \'totl\' is not defined\n';
  const r = new FakeRunner(() => ({ exception: 'NameError', error: err }));
  const g = await gradeCompletion(doc('totl += price'), completion, r, 'python');
  assert.equal(g.checkFailed, false);
  assert.equal(g.message, "NameError: name 'totl' is not defined");
  assert.equal(g.crashLine, 5, '0-based document line 5 = 1-based line 6');
});

test('gradeCompletion: timeouts and denials fail with a message', async () => {
  const slow = await gradeCompletion(doc('total += price'), completion, new FakeRunner(() => ({ timedOut: true })), 'python');
  assert.equal(slow.pass, false);
  assert.equal(slow.timedOut, true);
  assert.match(slow.message!, /too long/);
  const denied = await gradeCompletion(doc('import os'), completion, new FakeRunner(() => ({ denied: 'import os' })), 'python');
  assert.equal(denied.pass, false);
  assert.equal(denied.denied, 'import os');
});

test('extractFills tolerates re-indentation (2-space JS code shown with 4 spaces) and header lines', () => {
  const code = 'function total(xs) {\n  let t = 0;\n  for (const x of xs) {\n    [[1]]\n  }\n  return [[2]];\n}';
  const shown = '// fill the blanks (Tab moves), then Ctrl+Enter\nfunction total(xs) {\n    let t = 0;\n    for (const x of xs) {\n        t += x;\n    }\n    return t;\n}';
  const f = extractFills(shown, code)!;
  assert.deepEqual(f.fills, ['t += x;', 't']);
  assert.deepEqual(f.lines, [4, 6]);
  assert.equal(extractFills('function other() {}', code), undefined, 'edited outside the blanks');
});

test('matchWrongFill compares whole documents when the code around the blanks was edited', () => {
  const edited = doc('total = price').replace('total = 0', 'total = 0  # start');
  assert.equal(matchWrongFill(completion, undefined, edited), undefined, 'a different document');
  const same = doc('total = price', '');
  assert.equal(matchWrongFill(completion, undefined, same)?.misconceptionId, 'assign-instead-of-add');
});

test('failingCheckLine reads the CHECK marker in Python and Node errors', () => {
  assert.equal(failingCheckLine(checkError(7, 'f(4) should be 9')), 'f(4) should be 9');
  assert.equal(failingCheckLine('CheckFailed: CHECK f(4) should be 9\n    at snippet.js:6:1'), 'f(4) should be 9');
  assert.equal(failingCheckLine('CheckFailed: CHECK \n    at snippet.js:6:1'), 'failed');
  assert.equal(failingCheckLine("NameError: name 'x' is not defined"), undefined);
  assert.equal(failingCheckLine(undefined), undefined);
});

// ---------------------------------------------------------------- real runners (skipped when missing)

describe('gradeCompletion with the real batch runners', () => {
  let workRoot = '';
  let py: DetectedRuntime | undefined;
  let node: DetectedRuntime | undefined;
  const RUNNER_DIR = path.resolve(__dirname, '..', 'media', 'runner');
  before(async () => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dlb-grade-test-'));
    fs.mkdirSync(path.join(workRoot, 'run'));
    [py, node] = await Promise.all([detectPython(PATH_PYTHON_CANDIDATES, { cwd: workRoot }), detectNode({ cwd: workRoot })]);
  });
  after(() => fs.rmSync(workRoot, { recursive: true, force: true, maxRetries: 5 }));
  const runner = (rt: DetectedRuntime) => new LocalRunner(rt, { runnerDir: RUNNER_DIR, runRoot: path.join(workRoot, 'run') });

  test('Python: pass, a CHECK failure with a wrong fill, and a crash line', async (t) => {
    if (!py) return t.skip('no Python');
    const r = runner(py);
    assert.equal((await gradeCompletion(doc('total += price'), completion, r, 'python')).pass, true);
    const wrong = await gradeCompletion(doc('total = price'), completion, r, 'python');
    assert.equal(wrong.checkFailed, true);
    assert.equal(wrong.message, 'adds only the values above the limit');
    assert.equal(wrong.misconceptionId, 'assign-instead-of-add');
    const crash = await gradeCompletion(doc('totl += price'), completion, r, 'python');
    assert.equal(crash.checkFailed, false);
    assert.match(crash.message!, /^(?:NameError|UnboundLocalError): /);
    assert.equal(crash.crashLine, 5);
  });

  test('JavaScript: a CHECK failure from the vm realm', async (t) => {
    if (!node) return t.skip('no Node');
    const c: StoredCompletion = {
      ...completion, id: 'cjs',
      code: 'function totalOver(prices, limit) {\n  let total = 0;\n  for (const p of prices) {\n    if (p > limit) {\n      [[1]]\n    }\n  }\n  return total;\n}',
      solutions: ['total += p;'], wrongFills: [{ blank: 1, fill: 'total = p;', misconceptionId: 'assign-instead-of-add' }],
      harness: "check(totalOver([9, 2, 8], 5) === 17, 'adds only the values above the limit');",
    };
    const shown = (fill: string) => `// fill the blank, then Ctrl+Enter\n${c.code.replace('[[1]]', fill).replace(/^( +)/gm, '$1$1')}`;
    const r = runner(node);
    assert.equal((await gradeCompletion(shown('total += p;'), c, r, 'javascript')).pass, true);
    const wrong = await gradeCompletion(shown('total = p;'), c, r, 'javascript');
    assert.equal(wrong.message, 'adds only the values above the limit');
    assert.equal(wrong.misconceptionId, 'assign-instead-of-add');
  });
});

// ---------------------------------------------------------------- traceback

const tbItem: TracebackItem = {
  id: 'tb', code: 'def get(xs, i):\n    return xs[i]\n\nscores = [1, 2, 3]\nprint(get(scores, 3))',
  trace: 'Traceback (most recent call last):\n  File "pad", line 5, in <module>\n    print(get(scores, 3))\n  File "pad", line 2, in get\n    return xs[i]\nIndexError: list index out of range',
  line: 2, exception: 'IndexError', meanings: ['a', 'b', 'c'], correctMeaning: 1, siblingGroup: 'g', conceptId: 'reading-tracebacks',
};

test('parseTracebackAnswer reads line and name in any order; the untouched template is empty', () => {
  assert.deepEqual(parseTracebackAnswer('line 3, IndexError'), { empty: false, dontKnow: false, line: 3, name: 'IndexError' });
  assert.deepEqual(parseTracebackAnswer('# -> 3 indexerror'), { empty: false, dontKnow: false, line: 3, name: 'indexerror' });
  assert.deepEqual(parseTracebackAnswer('IndexError: list index out of range on line 3'), { empty: false, dontKnow: false, line: 3, name: 'IndexError' });
  assert.equal(parseTracebackAnswer('line ?, ?').empty, true);
  assert.equal(parseTracebackAnswer('').empty, true);
  assert.equal(parseTracebackAnswer('?').dontKnow, true);
});

test('gradeTraceback: pad line numbers (offset by the header), name case-insensitive, the meaning pick', () => {
  const ok = gradeTraceback('line 3, indexerror', tbItem, { lineOffset: 1 });
  assert.equal(ok.lineOk, true);
  assert.equal(ok.nameOk, true);
  assert.equal(ok.correct, true);
  assert.equal(gradeTraceback('line 3, IndexError', tbItem, { lineOffset: 1, pick: 2 }).correct, true);
  const badPick = gradeTraceback('line 3, IndexError', tbItem, { lineOffset: 1, pick: 3 });
  assert.equal(badPick.meaningOk, false);
  assert.equal(badPick.correct, false);
  assert.equal(gradeTraceback('line 3, KeyError', tbItem, { lineOffset: 1 }).correct, false);
  assert.equal(gradeTraceback('line 2, IndexError', tbItem).correct, true, 'offset 0: code lines');
});

test('gradeTraceback: picking the outermost frame names the frame-order misconception', () => {
  const g = gradeTraceback('line 6, IndexError', tbItem, { lineOffset: 1 });
  assert.equal(g.lineOk, false);
  assert.equal(g.misconceptionId, 'first-frame-is-failure');
  const js: TracebackItem = { ...tbItem, trace: "TypeError: x\n    at get (pad:2:16)\n    at pad:6:13", exception: 'TypeError' };
  assert.equal(gradeTraceback('line 6, TypeError', js).misconceptionId, 'last-frame-is-failure');
  assert.equal(gradeTraceback('line 4, IndexError', tbItem, { lineOffset: 1 }).misconceptionId, undefined);
  assert.equal(gradeMeaningPick(2, tbItem), true);
  assert.equal(gradeMeaningPick(1, tbItem), false);
});
