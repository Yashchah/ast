import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BatchRecord, StoredProbe, TracebackItem } from '../src/contracts';
import { Rng, type TracebackBuilder } from '../src/atoms/seeds';
import {
  EXCEPTION_TABLE, buildTracebackItem, buildTracebackParts, failingFrame, formatTrace, frameCount, meaningChoices, outermostFrame,
  parseItemTrace, parseTrace, preferMultiFrame, raisingCandidates, renumberTrace,
} from '../src/atoms/traceback';

// Error texts exactly as media/runner/batch.py and batch.mjs report them (captured from real runs).
const PY_CODE = 'def get(xs, i):\n    return xs[i]\n\nscores = [1, 2, 3]\nprint(get(scores, 3))';
const PY_ERROR =
  'Traceback (most recent call last):\n  File "<snippet>", line 5, in <module>\n    print(get(scores, 3))\n          ~~~^^^^^^^^^^^\n' +
  '  File "<snippet>", line 2, in get\n    return xs[i]\n           ~~^^^\nIndexError: list index out of range\n';
const JS_CODE = 'function get(xs, i) {\n  return xs[i].name;\n}\n\nconst scores = [1, 2, 3];\nconsole.log(get(scores, 3));';
const JS_ERROR =
  "snippet.js:2\n  return xs[i].name;\n               ^\n\nTypeError: Cannot read properties of undefined (reading 'name')\n" +
  '    at get (snippet.js:2:16)\n    at snippet.js:6:13';
const PY_RECURSION =
  'Traceback (most recent call last):\n  File "<snippet>", line 3, in <module>\n    r(0)\n    ~^^^\n  File "<snippet>", line 2, in r\n' +
  '    return r(n + 1)\n  File "<snippet>", line 2, in r\n    return r(n + 1)\n  [Previous line repeated 993 more times]\n' +
  'RecursionError: maximum recursion depth exceeded\n';

function rec(over: Partial<BatchRecord>): BatchRecord {
  return { id: 'x', stdout: '', values: [], exitOk: false, timedOut: false, ms: 1, constructs: [], ...over };
}

test('Python traces keep snippet frames, outermost first; the failing line is the innermost frame', () => {
  const t = parseTrace(PY_ERROR, 'python', 'IndexError')!;
  assert.equal(t.exception, 'IndexError');
  assert.equal(t.message, 'IndexError: list index out of range');
  assert.deepEqual(t.frames.map((f) => [f.fn, f.line]), [['<module>', 5], ['get', 2]]);
  assert.equal(failingFrame(t).line, 2);
  assert.equal(outermostFrame(t).line, 5);
});

test('Node stacks drop the source excerpt; the failing line is the first frame', () => {
  const t = parseTrace(JS_ERROR, 'javascript', 'TypeError')!;
  assert.equal(t.message, "TypeError: Cannot read properties of undefined (reading 'name')");
  assert.deepEqual(t.frames.map((f) => [f.fn, f.line, f.col]), [['get', 2, 16], ['', 6, 13]]);
  assert.equal(failingFrame(t).line, 2);
  assert.equal(outermostFrame(t).line, 6);
});

test('Node internals and runner frames never reach the pad', () => {
  const err = 'RangeError: Invalid array length\n    at snippet.js:1:11\n    at Script.runInContext (node:vm:149:12)\n    at run (file:///C:/ast/media/runner/batch.mjs:220:14)';
  const t = parseTrace(err, 'javascript', 'RangeError')!;
  assert.deepEqual(t.frames.map((f) => f.line), [1]);
});

test('formatTrace rebuilds the trace against the pad: file "pad", source lines from the code, no carets', () => {
  const t = parseTrace(PY_ERROR, 'python', 'IndexError')!;
  assert.equal(
    formatTrace(t, PY_CODE),
    [
      'Traceback (most recent call last):',
      '  File "pad", line 5, in <module>',
      '    print(get(scores, 3))',
      '  File "pad", line 2, in get',
      '    return xs[i]',
      'IndexError: list index out of range',
    ].join('\n'),
  );
  const js = parseTrace(JS_ERROR, 'javascript', 'TypeError')!;
  assert.equal(formatTrace(js, JS_CODE, 1), "TypeError: Cannot read properties of undefined (reading 'name')\n    at get (pad:3:16)\n    at pad:7:13");
});

test('renumberTrace shifts code lines to pad lines in both formats', () => {
  const py = formatTrace(parseTrace(PY_ERROR, 'python')!, PY_CODE);
  assert.match(renumberTrace(py, 2), /line 7, in <module>[\s\S]*line 4, in get/);
  assert.equal(renumberTrace('X: y\n    at f (pad:2:5)\n    at pad:9:1', 3), 'X: y\n    at f (pad:5:5)\n    at pad:12:1');
  assert.equal(renumberTrace(py, 0), py);
});

test('a recursion trace keeps the repeat note; a truncated head still parses from the inner frames', () => {
  const t = parseTrace(PY_RECURSION, 'python', 'RecursionError')!;
  assert.equal(t.frames.length, 3);
  assert.match(formatTrace(t, 'def r(n):\n    return r(n + 1)\nr(0)'), /\[Previous line repeated 993 more times\]/);
  // MAX_ERROR keeps the tail: the <module> frame may be gone.
  const tail = PY_RECURSION.slice(PY_RECURSION.indexOf('  File "<snippet>", line 2'));
  const t2 = parseTrace(tail, 'python', 'RecursionError')!;
  assert.equal(failingFrame(t2).line, 2);
});

test('the meaning table covers the spec exceptions; meanings never name an exception', () => {
  for (const name of ['IndexError', 'KeyError', 'TypeError', 'NameError', 'AttributeError', 'ValueError', 'ZeroDivisionError', 'RecursionError']) {
    assert.ok(EXCEPTION_TABLE.python[name], name);
  }
  for (const name of ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError']) assert.ok(EXCEPTION_TABLE.javascript[name], name);
  for (const table of Object.values(EXCEPTION_TABLE)) {
    const names = Object.keys(table);
    for (const [name, e] of Object.entries(table)) {
      assert.ok(!names.some((n) => e.meaning.includes(n)), `${name}: meaning leaks a name`);
      for (const c of e.confusions) assert.ok(table[c], `${name}: unknown confusion ${c}`);
    }
  }
});

test('meaningChoices: the right meaning plus 2 distinct distractors from its confusions', () => {
  for (let seed = 1; seed < 30; seed++) {
    const m = meaningChoices('KeyError', 'python', new Rng(seed))!;
    assert.equal(m.meanings.length, 3);
    assert.equal(new Set(m.meanings).size, 3);
    assert.equal(m.meanings[m.correctMeaning], EXCEPTION_TABLE.python.KeyError.meaning);
    const allowed = EXCEPTION_TABLE.python.KeyError.confusions.map((c) => EXCEPTION_TABLE.python[c].meaning);
    for (const x of m.meanings) if (x !== EXCEPTION_TABLE.python.KeyError.meaning) assert.ok(allowed.includes(x));
  }
  assert.equal(meaningChoices('CheckFailed', 'python'), undefined);
  assert.equal(meaningChoices('IndexError', 'javascript'), undefined, 'JS has no IndexError');
});

test('buildTracebackItem: a stable item from a raising run, line = the failing code line', () => {
  const r = rec({ exception: 'IndexError', error: PY_ERROR });
  const a = buildTracebackItem({ id: 'tb-1', code: PY_CODE, record: r, lang: 'python', siblingGroup: 'helper:scores' })!;
  const b = buildTracebackItem({ id: 'tb-1', code: PY_CODE, record: r, lang: 'python', siblingGroup: 'helper:scores' })!;
  assert.deepEqual(a, b, 'seeded from the id');
  assert.equal(a.line, 2);
  assert.equal(a.exception, 'IndexError');
  assert.equal(a.conceptId, 'reading-tracebacks');
  assert.equal(a.siblingGroup, 'helper:scores');
  assert.equal(a.meanings[a.correctMeaning], EXCEPTION_TABLE.python.IndexError.meaning);
  assert.ok(a.trace.startsWith('Traceback (most recent call last):'));
  assert.ok(!a.trace.includes('<snippet>'));
});

test('unusable runs build no item', () => {
  const base = { id: 't', code: PY_CODE, lang: 'python' as const, siblingGroup: 'g' };
  assert.equal(buildTracebackItem({ ...base, record: rec({ exitOk: true }) }), undefined);
  assert.equal(buildTracebackItem({ ...base, record: rec({ exception: 'IndexError', error: PY_ERROR, timedOut: true }) }), undefined);
  const check = 'Traceback (most recent call last):\n  File "<snippet>", line 5, in <module>\n    check(False)\nCheckFailed: CHECK nope\n';
  assert.equal(buildTracebackItem({ ...base, record: rec({ exception: 'CheckFailed', error: check }) }), undefined);
  // A frame past the end of the code (the code shown is not the code that ran).
  assert.equal(buildTracebackItem({ ...base, code: 'x = 1', record: rec({ exception: 'IndexError', error: PY_ERROR }) }), undefined);
});

test('buildTracebackParts fits the seeds TracebackBuilder slot', () => {
  const b: TracebackBuilder = buildTracebackParts;
  const parts = b(JS_CODE, rec({ exception: 'TypeError', error: JS_ERROR }), 'javascript', new Rng(7))!;
  assert.equal(parts.line, 2);
  assert.equal(parts.exception, 'TypeError');
  assert.match(parts.trace, /^TypeError: [\s\S]*at get \(pad:2:16\)\n {4}at pad:6:13$/);
});

test('multi-frame traces sort first; frameCount reads stored traces', () => {
  const one: Pick<TracebackItem, 'trace'> = { trace: 'Traceback (most recent call last):\n  File "pad", line 2, in <module>\n    d["x"]\nKeyError: \'x\'' };
  const two: Pick<TracebackItem, 'trace'> = { trace: formatTrace(parseTrace(PY_ERROR, 'python')!, PY_CODE) };
  assert.equal(frameCount(one), 1);
  assert.equal(frameCount(two), 2);
  assert.deepEqual(preferMultiFrame([one, two]), [two, one]);
  const t = parseItemTrace(two.trace)!;
  assert.equal(t.lang, 'python');
  assert.equal(failingFrame(t).line, 2);
});

test('raisingCandidates: raising mutants and raising probes with a known exception', () => {
  const probe = {
    id: 'p1', group: 'g:a', code: 'xs = [1]\nprint(xs[0])', raises: false, output: { stdout: '1\n', values: [] },
    mutants: [
      { id: 'p1~m1', misconceptionId: 'm1', code: 'xs = [1]\nprint(xs[1])', output: { stdout: '', values: [], exception: 'IndexError' } },
      { id: 'p1~m2', misconceptionId: 'm2', code: 'xs = [1]\nprint(xs[0] + 1)', output: { stdout: '2\n', values: [] } },
      { id: 'p1~m3', misconceptionId: 'm3', code: 'xs = [1]\nraise Boom', output: { stdout: '', values: [], exception: 'Boom' } },
    ],
  } as unknown as StoredProbe;
  assert.deepEqual(raisingCandidates([probe], 'python'), [{ id: 'p1~m1~tb', code: 'xs = [1]\nprint(xs[1])', siblingGroup: 'g:a' }]);
});
