import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrintedArg, RecordedOutput, Val } from '../src/contracts';
import {
  OPERATORS, alternativeLine, applyOperator, attributeWhatIf, findOperator, maskLine, operatorSites, operatorsFor, operatorsForTag, shiftExpr,
  tagOfMisconception, tagOfOperator, whatIfCandidates, type MutantOpId,
} from '../src/mutants';
import { findMisconception, tagInfo } from '../src/atoms/tags';

test('every operator maps to a canonical tag and one of its taxonomy misconceptions', () => {
  for (const op of OPERATORS) {
    assert.ok(tagInfo(op.tag), `${op.id}: tag ${op.tag}`);
    assert.ok(findMisconception(op.tag, op.misconceptionId), `${op.id}: ${op.misconceptionId} belongs to ${op.tag}`);
    if (op.alternative) assert.equal(OPERATORS.find((o) => o.id === op.alternative)?.alternative, op.id, 'alternatives pair up');
  }
  assert.deepEqual(
    Object.fromEntries(OPERATORS.map((o) => [o.id, o.tag])),
    {
      'bound-plus-1': 'for-range-bounds', 'bound-minus-1': 'for-range-bounds', 'lt-to-le': 'off-by-one', 'le-to-lt': 'off-by-one',
      'gt-to-ge': 'off-by-one', 'ge-to-gt': 'off-by-one', 'drop-copy': 'alias-copy', 'augadd-to-assign': 'loop-accumulator',
      'drop-return': 'function-return-vs-print', 'and-to-or': 'booleans-truthiness', 'or-to-and': 'booleans-truthiness',
      'drop-await': 'await-sequencing', 'eq-to-is': 'identity-vs-equality',
    },
  );
  assert.ok(!operatorsFor('python').some((o) => o.id === 'drop-await'), 'await is JS-only');
  assert.ok(!operatorsFor('javascript').some((o) => o.id === 'eq-to-is'), '== -> is is Python-only');
  assert.deepEqual(operatorsForTag('for-range-bounds', 'typescript').map((o) => o.id), ['bound-plus-1', 'bound-minus-1']);
  assert.equal(tagOfOperator('drop-copy'), 'alias-copy');
  assert.equal(tagOfMisconception('assignment-copies'), 'alias-copy');
  assert.equal(tagOfMisconception('no-such-id'), undefined);
});

const py = (line: string, op: MutantOpId) => applyOperator(line, op, 'python');
const js = (line: string, op: MutantOpId) => applyOperator(line, op, 'javascript');

test('comparisons: < <-> <=, > <-> >=; shifts, arrows and annotations untouched', () => {
  assert.equal(py('    if score < limit:', 'lt-to-le'), '    if score <= limit:');
  assert.equal(py('    while i <= n:', 'le-to-lt'), '    while i < n:');
  assert.equal(py('if a > b and c >= d:', 'gt-to-ge'), 'if a >= b and c >= d:');
  assert.equal(py('if a > b and c >= d:', 'ge-to-gt'), 'if a > b and c > d:');
  assert.equal(py('def f(x) -> int:', 'gt-to-ge'), null);
  assert.equal(py('x = y << 2', 'lt-to-le'), null);
  assert.equal(py('x >>= 1', 'gt-to-ge'), null);
  assert.equal(js('const f = (a) => a > 1;', 'gt-to-ge'), 'const f = (a) => a >= 1;');
  assert.equal(applyOperator('const xs: Array<number> = [];', 'lt-to-le', 'typescript'), null, 'a TS generic is not a comparison');
  assert.equal(applyOperator('if (i<n) {', 'lt-to-le', 'typescript'), 'if (i<=n) {');
  assert.equal(operatorSites('a < b < c', 'lt-to-le', 'python'), 2);
  assert.equal(applyOperator('a < b < c', 'lt-to-le', 'python', 1), 'a < b <= c');
});

test('nothing inside strings or comments is mutated', () => {
  assert.equal(py("    print('a < b')", 'lt-to-le'), null);
  assert.equal(py('    x = 1  # if a < b and c', 'lt-to-le'), null);
  assert.equal(py('    x = 1  # if a < b and c', 'and-to-or'), null);
  assert.equal(py('s = f"{a} and {b}" if a < b else ""', 'and-to-or'), null);
  assert.equal(py('s = f"{a} and {b}" if a < b else ""', 'lt-to-le'), 's = f"{a} and {b}" if a <= b else ""');
  assert.equal(py("print('''x += 1''')", 'augadd-to-assign'), null);
  assert.equal(js('const s = "a && b"; // c || d', 'and-to-or'), null);
  assert.equal(js('const n = `${a} < ${b}`;', 'lt-to-le'), null);
  assert.equal(js('const ok = /a<b/.test(s) && t;', 'lt-to-le'), null, 'regex literal');
  assert.equal(js('const ok = /a<b/.test(s) && t;', 'and-to-or'), 'const ok = /a<b/.test(s) || t;');
  assert.equal(js('const half = a / 2 < b / 2;', 'lt-to-le'), 'const half = a / 2 <= b / 2;', 'division is not a regex');
  assert.equal(js('/* a < b */ x = 1;', 'lt-to-le'), null);
  assert.equal(maskLine("x = 'a#b'  # c", 'python').length, "x = 'a#b'  # c".length);
});

test('range bound / loop limit +-1, folding n - 1 + 1 back to n', () => {
  assert.equal(py('    for i in range(len(prices) - 1):', 'bound-plus-1'), '    for i in range(len(prices)):');
  assert.equal(py('    for i in range(len(prices)):', 'bound-minus-1'), '    for i in range(len(prices) - 1):');
  assert.equal(py('for i in range(1, n):', 'bound-plus-1'), 'for i in range(1, n + 1):');
  assert.equal(py('for i in range(0, 10, 2):', 'bound-minus-1'), 'for i in range(0, 9, 2):');
  assert.equal(py('for i in range(a if b else c):', 'bound-plus-1'), 'for i in range((a if b else c) + 1):');
  assert.equal(py('xs.range(3)', 'bound-plus-1'), null, 'a method called range is not the builtin');
  assert.equal(py('print("range(3)")', 'bound-plus-1'), null);
  assert.equal(js('for (let i = 0; i < xs.length; i++) {', 'bound-plus-1'), 'for (let i = 0; i < xs.length + 1; i++) {');
  assert.equal(js('for (let i = 0; i <= n - 1; i++) {', 'bound-plus-1'), 'for (let i = 0; i <= n; i++) {');
  assert.equal(js('for (const x of xs) {', 'bound-plus-1'), null);
  assert.equal(js('for (let i = 0; i < n && ok; i++) {', 'bound-plus-1'), null, 'compound conditions are left alone');
  assert.equal(shiftExpr('5', 1), '6');
  assert.equal(shiftExpr('-1', 1), '0');
  assert.equal(shiftExpr('n + 1', -1), 'n');
  assert.equal(shiftExpr('a - b - 1', 1), 'a - b');
  assert.equal(shiftExpr('x if c else y - 1', 1), '(x if c else y - 1) + 1', 'never folds across a lower-precedence operator');
  assert.equal(alternativeLine('for i in range(n):', 'bound-plus-1', 'python'), 'for i in range(n - 1):');
  assert.equal(alternativeLine('if a < b:', 'lt-to-le', 'python'), null);
});

test("drop 'return', and <-> or, += -> =, remove await, == -> is", () => {
  assert.equal(py('    return total', 'drop-return'), '    total');
  assert.equal(py('    return', 'drop-return'), null, 'a bare return: nothing to drop to');
  assert.equal(py('    returned = 1', 'drop-return'), null);
  assert.equal(js('  return a + b;', 'drop-return'), '  a + b;');
  assert.equal(js('  return;', 'drop-return'), null);
  assert.equal(py('if a and not b:', 'and-to-or'), 'if a or not b:');
  assert.equal(py('x = a or b', 'or-to-and'), 'x = a and b');
  assert.equal(py('band = 1', 'and-to-or'), null);
  assert.equal(js('if (a && b) {', 'and-to-or'), 'if (a || b) {');
  assert.equal(js('x ||= 1;', 'or-to-and'), null);
  assert.equal(py('        total += price', 'augadd-to-assign'), '        total = price');
  assert.equal(js('  i++;', 'augadd-to-assign'), null);
  assert.equal(js('  const r = await fetchIt(x);', 'drop-await'), '  const r = fetchIt(x);');
  assert.equal(js('  awaited(x);', 'drop-await'), null);
  assert.equal(py('if a == b:', 'eq-to-is'), 'if a is b:');
  assert.equal(py('if a==b:', 'eq-to-is'), 'if a is b:');
  assert.equal(py('if a != b:', 'eq-to-is'), null);
  assert.equal(py('if a <= b:', 'eq-to-is'), null);
});

test('alias-copy: .copy(), list(x), x[:], [...x] and .slice() drop to x', () => {
  assert.equal(py('    seen = items.copy()', 'drop-copy'), '    seen = items');
  assert.equal(py('    seen = list(items)', 'drop-copy'), '    seen = items');
  assert.equal(py('    seen = self.items[:]', 'drop-copy'), '    seen = self.items');
  assert.equal(py('    seen = list(range(3))', 'drop-copy'), null, 'list() of a call is not a copy of a name');
  assert.equal(py('    seen = mylist(items)', 'drop-copy'), null);
  assert.equal(js('  const seen = [...items];', 'drop-copy'), '  const seen = items;');
  assert.equal(js('  const seen = items.slice();', 'drop-copy'), '  const seen = items;');
  assert.equal(js('  const seen = [0, ...items];', 'drop-copy'), null);
  const e = findOperator('    seen = items.copy()', 'drop-copy', 'python')!;
  assert.deepEqual([e.start, e.end, e.replacement], [16, 23, ''], 'the span for the line-through decoration');
});

test('candidate selection prefers the weakest concept, then journal mistakes; one per line, 2 by default', () => {
  const lines = [
    { line: 3, text: '    for i in range(len(xs) - 1):' },
    { line: 4, text: '        if xs[i] < xs[i + 1]:' },
    { line: 5, text: '            total += xs[i]' },
    { line: 6, text: '    return total' },
  ];
  const plain = whatIfCandidates(lines, 'python');
  assert.equal(plain.length, 2);
  assert.notEqual(plain[0].line, plain[1].line);
  assert.deepEqual(plain.map((c) => c.op), ['bound-plus-1', 'lt-to-le'], 'table order, distinct lines and operators');
  const weak = whatIfCandidates(lines, 'python', { weakestTag: 'loop-accumulator' });
  assert.equal(weak[0].op, 'augadd-to-assign');
  assert.equal(weak[0].mutated, '            total = xs[i]');
  assert.equal(weak[0].score, 2);
  const journal = whatIfCandidates(lines, 'python', { journal: [{ misconceptionId: 'print-is-return' }] });
  assert.equal(journal[0].op, 'drop-return');
  const both = whatIfCandidates(lines, 'python', { weakestTag: 'loop-accumulator', journal: [{ misconceptionId: 'print-is-return' }], max: 3 });
  assert.deepEqual(both.map((c) => [c.op, c.score]), [['augadd-to-assign', 2], ['drop-return', 1], ['bound-plus-1', 0]]);
  assert.deepEqual(whatIfCandidates([{ line: 1, text: "    print('done')" }], 'python'), []);
});

// ---------------------------------------------------------------- attribution

const int = (n: number): Val => ({ t: 'int', v: String(n) });
const ret = (n: number): RecordedOutput => ({ stdout: `${n}\n`, values: [[{ type: 'int', repr: String(n), val: int(n) } as PrintedArg]] });

test('attribution: correct is own evidence; equal to the unmutated or the alternative output counts toward the misconception', () => {
  const outputs = { actual: ret(15), unmutated: ret(9), alternative: ret(4) };
  const ok = attributeWhatIf('15', outputs, 'python', 'bound-plus-1');
  assert.deepEqual([ok.correct, ok.weight, ok.attributable], [true, 1, false]);
  const same = attributeWhatIf('9', outputs, 'python', 'bound-plus-1');
  assert.deepEqual([same.correct, same.attributable, same.matched, same.weight, same.misconceptionId, same.misconceptionOdds], [false, true, 'unmutated', 1, 'range-includes-end', 3]);
  const alt = attributeWhatIf('4', outputs, 'python', 'bound-plus-1');
  assert.equal(alt.matched, 'alternative');
  const other = attributeWhatIf('16', outputs, 'python', 'bound-plus-1');
  assert.deepEqual([other.correct, other.attributable, other.weight, other.misconceptionId], [false, false, 0.5, undefined]);
  const dk = attributeWhatIf('?', outputs, 'python', 'bound-plus-1');
  assert.deepEqual([dk.correct, dk.evidence, dk.attributable], [null, true, false]);
  assert.equal(attributeWhatIf('  ', outputs, 'python').evidence, false);
  const raising: RecordedOutput = { stdout: '', values: [], exception: 'IndexError' };
  assert.equal(attributeWhatIf('IndexError', { actual: raising, unmutated: ret(9) }, 'python').correct, true, 'raising is a valid answer');
  const strOut: RecordedOutput = { stdout: "'ab'\n", values: [[{ type: 'str', repr: "'ab'", val: { t: 'str', v: 'ab' } }]] };
  assert.equal(attributeWhatIf('ab', { actual: strOut, unmutated: ret(1) }, 'python').evidence, false, 'format-only: no evidence');
});
