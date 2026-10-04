import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AtomPattern, PrintedArg, RecordedOutput, StoredContrast, StoredMutant, StoredProbe, Val } from '../src/contracts';
import {
  ASSISTED_NOTE, EMPTY_REPROMPT, KEYS, LEGEND, LESSON_PENDING, feedbackDecoration, indentTo4, keysUsed, legendNeeded, renderBeliefCheck,
  renderCompletion, renderCompletionReveal, renderContrastPick, renderEscalate, renderExample, renderProbe, renderReveal, renderTraceback,
  renderTracebackMeaning, renderTyping, renderView, snippetString, wrapText, type SnippetPart,
} from '../src/atoms/render';
import { extractFills, gradeTraceback, parseAnswerLines } from '../src/atoms/grade';

const int = (n: number): Val => ({ t: 'int', v: String(n) });
const list = (ns: number[]): PrintedArg => ({ type: 'list', repr: `[${ns.join(', ')}]`, val: { t: 'list', v: ns.map(int) } });
const out = (...calls: PrintedArg[][]): RecordedOutput => ({ stdout: calls.map((a) => a.map((x) => x.repr).join(' ')).join('\n') + '\n', values: calls });

const allKeys = Object.fromEntries(Object.values(KEYS).map((k) => [k, 3]));
const lines = (text: string) => text.split('\n');

const probe: Pick<StoredProbe, 'code' | 'output' | 'trace'> = {
  code: 'a = [1, 2]\nb = a\nb.append(3)\nprint(a)',
  output: out([list([1, 2, 3])]),
  trace: [{ line: 1, text: 'a=[1, 2]' }, { line: 2, text: 'a=[1, 2]  b is a' }, { line: 3, text: 'a=[1, 2, 3]  b is a' }],
};
const mutant: Pick<StoredMutant, 'diffLine' | 'refutation'> = { diffLine: 2, refutation: 'b = a gives the same list a second name; nothing is copied, so appending through b changes a.' };

test('probe layout: generic header, legend until each key is used 3 times, code, "# -> " with the cursor after it', () => {
  const r = renderProbe(probe, { lang: 'python' });
  const ls = lines(r.text);
  assert.equal(ls[0], '# what does this print?');
  assert.equal(ls[1], `# ${LEGEND}`);
  assert.equal(ls[2], 'a = [1, 2]');
  assert.equal(ls[ls.length - 1], '# -> ');
  assert.equal(r.answerLine, ls.length - 1);
  assert.equal(r.answerColumn, 5);
  assert.equal(r.codeStart, 2);
  assert.equal(r.await, 'answer');
  const faded = renderProbe(probe, { lang: 'python', keyUse: allKeys });
  assert.equal(lines(faded.text)[1], 'a = [1, 2]', 'no legend once every key was used 3 times');
  assert.equal(legendNeeded({ ...allKeys, [KEYS.guess]: 2 }), true);
  const js = renderProbe({ code: 'const a = [1];\nconsole.log(a);' }, { lang: 'javascript', keyUse: allKeys });
  assert.deepEqual(lines(js.text), ['// what does this print?', 'const a = [1];', 'console.log(a);', '// -> ']);
  // What the learner types parses back.
  assert.deepEqual(parseAnswerLines(js.text + '[ 1 ]', '//'), ['[ 1 ]']);
});

test('keysUsed: submit or guess, ? and multi-line answers', () => {
  assert.deepEqual(keysUsed('[1, 2]', false), [KEYS.submit]);
  assert.deepEqual(keysUsed('?', false), [KEYS.submit, KEYS.dontKnow]);
  assert.deepEqual(keysUsed('1 | 2', true), [KEYS.guess, KEYS.lines]);
  assert.deepEqual(keysUsed('1\n2', false), [KEYS.submit, KEYS.lines]);
});

test('belief check: "actual: X" on the answer line, then the y / n question', () => {
  const r = renderBeliefCheck({ belief: 'b = a makes a separate copy of the list.', probe, answer: '[1, 2]', actual: '[1, 2, 3]' }, { lang: 'python' });
  const ls = lines(r.text);
  assert.equal(ls[ls.length - 2], '# -> [1, 2]');
  assert.equal(ls[ls.length - 1], '# Did you think: b = a makes a separate copy of the list?   y / n');
  assert.equal(r.await, 'yn');
  assert.deepEqual(r.decorations, [{ line: ls.length - 2, text: 'actual: [1, 2, 3]', kind: 'wrong' }]);
  // Multi-line answers keep one answer line each; ROUTE-time checks show the question alone.
  const multi = renderBeliefCheck({ belief: 'x', probe, answer: '1\n2', actual: '3' }, { lang: 'python' });
  assert.deepEqual(lines(multi.text).slice(-3), ['# -> 1', '# -> 2', '# Did you think: x?   y / n']);
  assert.equal(renderBeliefCheck({ belief: 'x' }, { lang: 'javascript' }).text, '// Did you think: x?   y / n');
});

const contrast: StoredContrast = {
  id: 'ct', misconceptionId: 'assignment-copies', rule: 'b = a shares one list; a.copy() makes a new one.',
  wrong: 'a = [1]\nb = a.copy()\nb.append(9)\nprint(a)', right: 'a = [1]\nb = a\nb.append(9)\nprint(a)',
  wrongOutput: out([list([1])]), rightOutput: out([list([1, 9])]),
};

test('contrast pick: both snippets without outputs under "Which one prints X?  1 / 2"', () => {
  for (const rightFirst of [true, false]) {
    const r = renderContrastPick(contrast, rightFirst, { lang: 'python' });
    const ls = lines(r.text);
    assert.equal(ls[0], '# Which one prints [1, 9]?  1 / 2');
    assert.equal(r.await, 'pick2');
    assert.equal(r.correctPick, rightFirst ? 1 : 2);
    const first = ls.slice(2, 6).join('\n');
    assert.equal(first, rightFirst ? contrast.right : contrast.wrong);
    assert.ok(!r.text.includes('prints: '), 'no outputs before the pick');
  }
});

test('reveal: rule, both outputs, the refutation on the changed line, the state trace on the others', () => {
  const r = renderReveal({ rule: 'b = a shares one list.', contrast, rightFirst: false, probe, mutant }, { lang: 'python' });
  const ls = lines(r.text);
  assert.equal(ls[0], '# Rule: b = a shares one list.');
  assert.ok(ls.includes('# prints: [1]'));
  assert.ok(ls.includes('# prints: [1, 9]'));
  assert.equal(ls[ls.length - 1], '# prints: [1, 2, 3]');
  const probeStart = ls.indexOf('a = [1, 2]');
  const removed = r.decorations.find((d) => d.kind === 'removed')!;
  assert.equal(removed.line, probeStart + 1, 'diffLine 2');
  assert.ok(removed.text.length <= 52);
  assert.match(removed.hover!, /nothing is copied[\s\S]*-> a=\[1, 2\] {2}b is a/);
  const traces = r.decorations.filter((d) => d.kind === 'trace').map((d) => [d.line - probeStart + 1, d.text]);
  assert.deepEqual(traces, [[1, '-> a=[1, 2]'], [3, '-> a=[1, 2, 3]  b is a']]);
  assert.equal(r.await, 'read');
  // Without a contrast: rule and probe only.
  const solo = renderReveal({ rule: 'x', probe, mutant }, { lang: 'python' });
  assert.equal(lines(solo.text)[1], 'a = [1, 2]');
});

const shape: AtomPattern = { kind: 'shape', name: 'Accumulate in a loop', useWhen: 'you need a running total', template: '', rule: '', howItRuns: '', pitfall: '', useCases: [] };

test('example: Pattern / Rule header, subgoal after-texts on their lines, the real output', () => {
  const ex = { code: 'total = 0\nfor x in [1, 2]:\n    total += x\nprint(total)', subgoals: [{ line: 1, label: 'start an empty accumulator' }, { line: 3, label: 'add each item' }, { line: 9, label: 'out of range' }], output: out([{ type: 'int', repr: '3', val: int(3) }]) };
  const r = renderExample(ex, shape, { lang: 'python' });
  const ls = lines(r.text);
  assert.equal(ls[0], '# Pattern: Accumulate in a loop - you need a running total');
  assert.equal(ls[ls.length - 1], '# prints: 3');
  assert.deepEqual(r.decorations.filter((d) => d.kind === 'subgoal').map((d) => [d.line, d.text]), [[1, '<- start an empty accumulator'], [3, '<- add each item']]);
  const sem = renderExample(ex, { ...shape, kind: 'semantics', rule: 'Names point at objects.' }, { lang: 'python' });
  assert.equal(lines(sem.text)[0], '# Rule: Names point at objects.');
  const multi = renderExample({ ...ex, output: { stdout: 'a\nb\n', values: [] } }, shape, { lang: 'python' });
  assert.deepEqual(lines(multi.text).slice(-3), ['# prints:', '#   a', '#   b']);
});

// VS Code's snippet insertion normalises each line's leading whitespace to the editor's settings
// (textModel normalizeIndentation): visible columns become tabs + spaces, or spaces.
function normalizeIndentation(line: string, tabSize: number, insertSpaces: boolean): string {
  const ws = /^[ \t]*/.exec(line)![0];
  let col = 0;
  for (const c of ws) col = c === '\t' ? col + tabSize - (col % tabSize) : col + 1;
  const lead = insertSpaces ? ' '.repeat(col) : '\t'.repeat(Math.floor(col / tabSize)) + ' '.repeat(col % tabSize);
  return lead + line.slice(ws.length);
}

/** Indentation levels as Python's tokenizer sees them: consistent iff no line mixes tabs and spaces. */
function levels(text: string): number[] | 'mixed' {
  const out: number[] = [];
  for (const l of text.split('\n')) {
    const ws = /^[ \t]*/.exec(l)![0];
    if (/ /.test(ws) && /\t/.test(ws)) return 'mixed';
    out.push(ws.length);
  }
  return out;
}

test('completion: a 4-space snippet with ___ tab stops; it inserts consistently under tab and 2-space settings', () => {
  const code = 'def total_over(xs, limit):\n    total = 0\n    for x in xs:\n        if x > limit:\n            [[1]]\n    return [[2]]';
  const r = renderCompletion({ code }, { lang: 'python' });
  assert.equal(r.await, 'answer');
  assert.deepEqual(r.snippet!.filter((p): p is { placeholder: number; value: string } => 'placeholder' in p), [{ placeholder: 1, value: '___' }, { placeholder: 2, value: '___' }]);
  assert.equal(lines(r.text)[0], '# fill the blanks (Tab moves), then Ctrl+Enter');
  assert.deepEqual(r.blankLines, [5, 6]);
  assert.equal(lines(r.text)[5], '            ___');
  const base = levels(r.text) as number[];
  // Tabs at tab size 4 (the editor default) and 2-space settings; the pad itself forces 4 spaces.
  for (const [tabSize, insertSpaces] of [[4, false], [4, true], [2, true], [2, false]] as const) {
    const inserted = r.text.split('\n').map((l) => normalizeIndentation(l, tabSize, insertSpaces)).join('\n');
    const lv = levels(inserted);
    assert.notEqual(lv, 'mixed', `tabSize ${tabSize} insertSpaces ${insertSpaces}`);
    // Same nesting: indentation stays proportional, line by line.
    const ratio = (lv as number[]).map((n, i) => (base[i] ? n / base[i] : n));
    assert.equal(new Set(ratio.filter((_x, i) => base[i] > 0)).size, 1);
    // And the fills are still found in what the editor holds.
    assert.deepEqual(extractFills(inserted.replace(/___/, 'total += x').replace(/___/, 'total'), code)!.fills, ['total += x', 'total']);
  }
});

test('completion: 2-space JS code is re-indented to 4, and $ / } / \\ are escaped in the snippet string', () => {
  const code = 'function greet(name) {\n  const msg = `hi ${name}`;\n  return [[1]];\n}';
  const r = renderCompletion({ code }, { lang: 'javascript' });
  assert.deepEqual(lines(r.text).slice(1), ['function greet(name) {', '    const msg = `hi ${name}`;', '    return ___;', '}']);
  assert.equal(lines(r.text)[0], '// fill the blank, then Ctrl+Enter');
  assert.ok(r.snippetText!.includes('`hi \\${name\\}`'));
  assert.ok(r.snippetText!.includes('return ${1:___};'));
  // A 2-space source inserted as-is would break Python under tabs (2 spaces stay spaces, 4 become a tab).
  const raw = 'if x:\n  if y:\n    z()';
  assert.equal(levels(raw.split('\n').map((l) => normalizeIndentation(l, 4, false)).join('\n')).toString(), '0,2,1');
  assert.equal(indentTo4(raw), 'if x:\n    if y:\n        z()');
  assert.equal(indentTo4('if x:\n\tpass'), 'if x:\n    pass');
  const parts: SnippetPart[] = [{ text: 'a$b' }, { placeholder: 1, value: '___' }];
  assert.equal(snippetString(parts), 'a\\$b${1:___}');
});

test('completion reveal: the solutions filled in and highlighted', () => {
  const r = renderCompletionReveal({ code: 'def f(xs):\n  t = 0\n  for x in xs:\n    [[1]]\n  return t', solutions: ['t += x'] }, { lang: 'python' });
  const ls = lines(r.text);
  assert.equal(ls[4], '        t += x');
  assert.deepEqual(r.decorations.filter((d) => d.kind === 'reveal-fill').map((d) => [d.line, d.text]), [[4, '<- t += x']]);
  assert.equal(r.await, 'read');
});

test('escalate: "preparing a short lesson" while pending; the lesson as a comment block above a fresh completion', () => {
  const pending = renderEscalate(undefined, { code: 'x = [[1]]' }, { lang: 'python' }, true);
  assert.equal(pending.text, `# ${LESSON_PENDING}`);
  assert.equal(pending.await, 'read');
  const lesson = { title: 'Why b changes too', explanation: 'It **seems** that `b = a` copies.\n\nIt does not: both names point at one list.', example: '```python\na = [1]\nb = a\n```', rule: 'Assignment shares; .copy() copies.' };
  const r = renderEscalate(lesson, { code: 'def f(a):\n    b = [[1]]\n    return b' }, { lang: 'python' });
  const ls = lines(r.text);
  assert.equal(ls[0], '# Why b changes too');
  assert.equal(ls[1], '# It seems that `b = a` copies.');
  assert.ok(ls.includes('#     a = [1]'));
  assert.ok(ls.includes('# Rule: Assignment shares; .copy() copies.'));
  assert.ok(!r.text.includes('```'));
  const code = ls.indexOf('def f(a):');
  assert.ok(ls.slice(0, code).every((l) => l.startsWith('#')), 'everything above the code is a comment');
  assert.ok(r.snippet && r.blankLines![0] === code + 1);
  // A failed lesson job leaves the completion alone.
  assert.equal(lines(renderEscalate(undefined, { code: 'x = [[1]]' }, { lang: 'python' }).text)[0], '# fill the blank, then Ctrl+Enter');
  assert.ok(wrapText('word '.repeat(40), 30).every((l) => l.length <= 30));
});

const tb = {
  code: 'def get(xs, i):\n    return xs[i]\n\nscores = [1, 2, 3]\nprint(get(scores, 3))',
  trace: 'Traceback (most recent call last):\n  File "pad", line 5, in <module>\n    print(get(scores, 3))\n  File "pad", line 2, in get\n    return xs[i]\nIndexError: list index out of range',
  line: 2, exception: 'IndexError', meanings: ['m0', 'm1', 'm2'], correctMeaning: 2, siblingGroup: 'g', conceptId: 'reading-tracebacks', id: 'tb',
};

test('traceback layout: the trace renumbered to pad lines and "# -> line ?, ?" with the first ? selected', () => {
  const r = renderTraceback(tb, { lang: 'python' });
  const ls = lines(r.text);
  assert.equal(ls[0], '# which line failed, and with what error?');
  assert.equal(r.lineOffset, 1);
  assert.ok(ls.includes('#   File "pad", line 6, in <module>'));
  assert.ok(ls.includes('#   File "pad", line 3, in get'));
  assert.equal(ls[ls.length - 1], '# -> line ?, ?');
  assert.equal(ls[r.answerLine!].slice(r.answerColumn!, r.answerSelectEnd), '?');
  // The editor line the trace names is the line the learner answers.
  assert.equal(ls[3 - 1].trim(), 'return xs[i]');
  assert.equal(gradeTraceback('line 3, IndexError', tb, { lineOffset: r.lineOffset }).correct, true);
});

test('traceback meaning: the answer kept, then "What does X mean?  1 / 2 / 3"', () => {
  const r = renderTracebackMeaning(tb, '# -> line 3, IndexError', { lang: 'python' });
  const ls = lines(r.text);
  assert.ok(ls.includes('# -> line 3, IndexError'));
  assert.deepEqual(ls.slice(-4), ['# What does IndexError mean?  1 / 2 / 3', '# 1  m0', '# 2  m1', '# 3  m2']);
  assert.equal(r.await, 'pick3');
  assert.equal(r.correctPick, 3);
});

test('typing calibration and the view dispatcher', () => {
  const t = renderTyping("[3, 'a', True]", { lang: 'python' });
  assert.deepEqual(lines(t.text), ['# copy this exactly, then Ctrl+Enter', "[3, 'a', True]", '# -> ']);
  assert.equal(renderView({ kind: 'typing', literal: 'x' }, { lang: 'python' }).text, t.text.replace("[3, 'a', True]", 'x'));
  assert.equal(renderView({ kind: 'probe', probe }, { lang: 'python', keyUse: allKeys }).text, renderProbe(probe, { lang: 'python', keyUse: allKeys }).text);
});

test('feedback decorations: 52-character after-text with the full text in the hover', () => {
  assert.deepEqual(feedbackDecoration({ kind: 'correct', ms: 6800 }, 4), { line: 4, text: 'ok 7s', kind: 'correct' });
  assert.equal(feedbackDecoration({ kind: 'assisted' }, 1).text, ASSISTED_NOTE);
  assert.equal(feedbackDecoration({ kind: 'empty' }, 1).text, EMPTY_REPROMPT);
  const long = feedbackDecoration({ kind: 'wrong', actual: '[' + '1, '.repeat(40) + '1]' }, 2);
  assert.ok(long.text.length <= 52);
  assert.ok(long.text.endsWith('…'));
  assert.match(long.hover!, /^actual: \[1, 1/);
  assert.equal(feedbackDecoration({ kind: 'format', note: 'right idea; Python writes it as [2, 3]' }, 0).kind, 'format');
});
