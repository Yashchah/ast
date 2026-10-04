import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { spawnSync } from 'node:child_process';
import {
  actualText,
  answerSpaceG,
  compareOutput,
  editDistance,
  formatVal,
  LiteralError,
  parseJs5,
  parsePyLiteral,
  valEquals,
  type CompareOpts,
} from '../src/compare';
import type { Lang, MutantOutput, PrintedArg, RecordedOutput, Val } from '../src/contracts';

// ---------------------------------------------------------------- fixtures

const S = (v: string): Val => ({ t: 'str', v });
const I = (v: number | string): Val => ({ t: 'int', v: String(v) });
const F = (v: number | 'nan' | 'inf' | '-inf'): Val => ({ t: 'float', v });
const N = (v: number | 'NaN' | 'Infinity' | '-Infinity' | '-0'): Val => ({ t: 'num', v });
const B = (v: boolean): Val => ({ t: 'bool', v });
const NONE: Val = { t: 'none' };
const L = (...v: Val[]): Val => ({ t: 'list', v });
const T = (...v: Val[]): Val => ({ t: 'tuple', v });
const SET = (...v: Val[]): Val => ({ t: 'set', v });
const D = (...v: [Val, Val][]): Val => ({ t: 'dict', v });

/** One Python print() call per entry; each argument as [typed value, repr]. stdout follows print's rules. */
function py(...calls: [Val, string][][]): RecordedOutput {
  const values = calls.map((args) => args.map(([val, repr]): PrintedArg => ({ type: val.t, repr, val })));
  const stdout = values.map((args) => args.map((a) => (a.val.t === 'str' ? a.val.v : a.repr)).join(' ') + '\n').join('');
  return { stdout, values };
}

/** Shorthand for a single print(x). */
const py1 = (val: Val, repr: string): RecordedOutput => py([[val, repr]]);

/** What the JS batch runner records: console.log args through util.inspect, typed values alongside. */
function toVal(x: unknown): Val {
  if (typeof x === 'string') return S(x);
  if (typeof x === 'number') return Number.isNaN(x) ? N('NaN') : Object.is(x, -0) ? N('-0') : x === Infinity ? N('Infinity') : x === -Infinity ? N('-Infinity') : N(x);
  if (typeof x === 'bigint') return { t: 'bigint', v: x.toString() };
  if (typeof x === 'boolean') return B(x);
  if (x === null) return { t: 'null' };
  if (x === undefined) return { t: 'undefined' };
  if (Array.isArray(x)) return L(...x.map(toVal));
  if (x instanceof Set) return SET(...[...x].map(toVal));
  if (x instanceof Map) return D(...[...x].map(([k, v]): [Val, Val] => [toVal(k), toVal(v)]));
  return D(...Object.entries(x as object).map(([k, v]): [Val, Val] => [S(k), toVal(v)]));
}

function js(...calls: unknown[][]): RecordedOutput {
  const values = calls.map((args) => args.map((x): PrintedArg => ({ type: typeof x, repr: inspect(x, { breakLength: Infinity }), val: toVal(x) })));
  const stdout = values.map((args) => args.map((a) => (a.val.t === 'str' ? a.val.v : a.repr)).join(' ') + '\n').join('');
  return { stdout, values };
}

const raises = (exception: string, stdout = ''): RecordedOutput => ({ stdout, values: [], exception });

function verdict(answer: string, rec: RecordedOutput, lang: Lang = 'python', opts: Partial<CompareOpts> = {}) {
  return compareOutput(answer, rec, lang, { typeSensitive: false, ...opts });
}
const kind = (answer: string, rec: RecordedOutput, lang: Lang = 'python', opts: Partial<CompareOpts> = {}) => verdict(answer, rec, lang, opts).verdict;

const mutant = (id: string, output: RecordedOutput, ambiguous = false): MutantOutput => ({ id, output, ambiguous });

// ---------------------------------------------------------------- parsePyLiteral

test('parsePyLiteral: numbers keep int and float apart', () => {
  assert.deepEqual(parsePyLiteral('2'), I(2));
  assert.deepEqual(parsePyLiteral('2.0'), F(2));
  assert.deepEqual(parsePyLiteral('-7'), I(-7));
  assert.deepEqual(parsePyLiteral('1_000'), I(1000));
  assert.deepEqual(parsePyLiteral('0x1F'), I(31));
  assert.deepEqual(parsePyLiteral('123456789012345678901234567890'), I('123456789012345678901234567890'));
  assert.deepEqual(parsePyLiteral('1.'), F(1));
  assert.deepEqual(parsePyLiteral('.5'), F(0.5));
  assert.deepEqual(parsePyLiteral('1e3'), F(1000));
  assert.deepEqual(parsePyLiteral('1e400'), F('inf'));
  assert.deepEqual(parsePyLiteral('inf'), F('inf'));
  assert.deepEqual(parsePyLiteral('-inf'), F('-inf'));
  assert.deepEqual(parsePyLiteral('nan'), F('nan'));
  assert.deepEqual(parsePyLiteral("float('-inf')"), F('-inf'));
  assert.ok(Object.is((parsePyLiteral('-0.0') as { v: number }).v, -0));
});

test('parsePyLiteral: strings in both quote styles with escapes', () => {
  assert.deepEqual(parsePyLiteral(`"it's"`), S("it's"));
  assert.deepEqual(parsePyLiteral(`'it\\'s'`), S("it's"));
  assert.deepEqual(parsePyLiteral(`'say "hi"'`), S('say "hi"'));
  assert.deepEqual(parsePyLiteral(`'a\\nb\\t\\x41\\101\\u00e9\\U0001F600\\\\'`), S('a\nb\tAAé\u{1F600}\\'));
  assert.deepEqual(parsePyLiteral(`'\\d'`), S('\\d'), 'unknown escapes keep the backslash');
  assert.deepEqual(parsePyLiteral(`r'\\n\\''`), S("\\n\\'"));
  assert.deepEqual(parsePyLiteral(`'''a'b'''`), S("a'b"));
  assert.deepEqual(parsePyLiteral(`b'a\\x00\\xff'`), { t: 'bytes', v: 'a\x00\xff' });
  assert.deepEqual(parsePyLiteral(`b'\\u0041'`), { t: 'bytes', v: '\\u0041' }, '\\u is not an escape in bytes');
  assert.deepEqual(parsePyLiteral(`'None'`), S('None'));
});

test('parsePyLiteral: containers, 1-tuples, sets and frozensets', () => {
  assert.deepEqual(parsePyLiteral('[1, [2, 3],]'), L(I(1), L(I(2), I(3))));
  assert.deepEqual(parsePyLiteral('()'), T());
  assert.deepEqual(parsePyLiteral('(1,)'), T(I(1)));
  assert.deepEqual(parsePyLiteral('(1)'), I(1), 'parentheses alone do not make a tuple');
  assert.deepEqual(parsePyLiteral('(1, (2, 3))'), T(I(1), T(I(2), I(3))));
  assert.deepEqual(parsePyLiteral('{}'), D());
  assert.deepEqual(parsePyLiteral("{'a': 1, (1, 2): [None]}"), D([S('a'), I(1)], [T(I(1), I(2)), L(NONE)]));
  assert.deepEqual(parsePyLiteral('{1, 2}'), SET(I(1), I(2)));
  assert.deepEqual(parsePyLiteral('set()'), SET());
  assert.deepEqual(parsePyLiteral('frozenset()'), { t: 'frozenset', v: [] });
  assert.deepEqual(parsePyLiteral('frozenset({1, 2})'), { t: 'frozenset', v: [I(1), I(2)] });
  assert.deepEqual(parsePyLiteral('[True, False, None]'), L(B(true), B(false), NONE));
});

test('parsePyLiteral throws on anything that is not a literal', () => {
  for (const bad of ['', 'hello', 'x + 1', '[1, 2', '1, 2', '1 2', '01', '1j', "f'x'", '{[1]: 2}', '{[1]}', '...', 'lambda: 1', "'abc", 'true', 'null', '<object>', '[1,,2]', "'a' 'b'", '--', '1.2.3', "set('ab')"]) {
    assert.throws(() => parsePyLiteral(bad), LiteralError, bad);
  }
  assert.deepEqual(parsePyLiteral('true', 'loose'), B(true), 'loose mode maps JS spellings');
  assert.deepEqual(parsePyLiteral('null', 'loose'), NONE);
});

// ---------------------------------------------------------------- parseJs5

test('parseJs5 reads JSON5 and util.inspect output', () => {
  assert.deepEqual(parseJs5("[ 'a', 'b' ]"), L(S('a'), S('b')));
  assert.deepEqual(parseJs5(`{ a: 1, 'b-c': [1,], "d": null, }`), D([S('a'), N(1)], [S('b-c'), L(N(1))], [S('d'), { t: 'null' }]));
  assert.deepEqual(parseJs5('{ 1: true, 0x10: false }'), D([S('1'), B(true)], [S('16'), B(false)]), 'object keys are strings');
  assert.deepEqual(parseJs5('[ undefined, NaN, Infinity, -Infinity, -0, 10n, -5, .5, 5. ]'), L({ t: 'undefined' }, N('NaN'), N('Infinity'), N('-Infinity'), N('-0'), { t: 'bigint', v: '10' }, N(-5), N(0.5), N(5)));
  assert.deepEqual(parseJs5("Map(2) { 'a' => 1, 2 => [ 'b' ] }"), D([S('a'), N(1)], [N(2), L(S('b'))]));
  assert.deepEqual(parseJs5("Set(2) { 1, 'a' }"), SET(N(1), S('a')));
  assert.deepEqual(parseJs5('Map(0) {}'), D());
  assert.deepEqual(parseJs5('Set(0) {}'), SET());
  assert.deepEqual(parseJs5('`both \' and "`'), S(`both ' and "`));
  assert.deepEqual(parseJs5(`'it\\'s \\x41\\u0042\\u{1F600}'`), S("it's AB\u{1F600}"));
  for (const bad of ['[ 1, <1 empty item>, 3 ]', '[Function: f]', 'Foo { a: 1 }', '{ a }', '`${x}`', '[1, 2', '01', 'x', '(1)', 'True', '[ 1, ... 1 more item ]']) {
    assert.throws(() => parseJs5(bad), LiteralError, bad);
  }
  assert.deepEqual(parseJs5('True', 'loose'), B(true));
  assert.deepEqual(parseJs5('None', 'loose'), { t: 'null' });
});

test('parse then format reproduces util.inspect for real JS values', () => {
  const values: unknown[] = [0, -0, 1.5, -1e-7, 1e21, NaN, -Infinity, 10n, 'hi', "it's", 'say "hi"', `both ' and "`, 'all \' " `', 'a\nb\tc\x00\x7f\x85 ',
    true, null, undefined, [], [1, [2, 3]], {}, { a: 1, 'b-c': [1, 'x'], $y: null, if: 2 }, new Map([[1, 'a']]), new Set([1, 'a']), new Set()];
  for (const x of values) {
    const printed = inspect(x, { breakLength: Infinity });
    assert.equal(formatVal(parseJs5(printed), 'javascript'), printed);
    assert.ok(valEquals(parseJs5(printed), toVal(x)), printed);
  }
});

// ---------------------------------------------------------------- valEquals / formatVal / editDistance

test('valEquals: order-free sets and dicts, typed numbers, multisets', () => {
  assert.ok(valEquals(SET(I(1), I(2), I(3)), SET(I(3), I(1), I(2))));
  assert.ok(valEquals(D([S('a'), I(1)], [S('b'), I(2)]), D([S('b'), I(2)], [S('a'), I(1)])));
  assert.ok(!valEquals(SET(I(1), I(1), I(2)), SET(I(1), I(2))), 'a typed duplicate is not the printed set');
  assert.ok(!valEquals(I(2), F(2)));
  assert.ok(!valEquals(T(I(1)), L(I(1))));
  assert.ok(valEquals(T(I(1)), L(I(1)), { strict: false }));
  assert.ok(valEquals(F('nan'), F(NaN)));
  assert.ok(!valEquals(F(-0), F(0)), 'Python prints -0.0 and 0.0 differently');
  assert.ok(valEquals(N('-0'), N(-0)));
  assert.ok(valEquals(N(3), N(3.0)));
  assert.ok(valEquals(I('007'), I(7)));
});

test('formatVal prints like Python repr', () => {
  assert.equal(formatVal(L(I(1), F(2), F(1e16), F(1e-5), F(0.1), F(-0)), 'python'), '[1, 2.0, 1e+16, 1e-05, 0.1, -0.0]');
  assert.equal(formatVal(T(I(1)), 'python'), '(1,)');
  assert.equal(formatVal(SET(), 'python'), 'set()');
  assert.equal(formatVal({ t: 'frozenset', v: [I(1)] }, 'python'), 'frozenset({1})');
  assert.equal(formatVal(D([S("it's"), S('say "hi"')]), 'python'), `{"it's": 'say "hi"'}`);
  assert.equal(formatVal(S(`both ' and "`), 'python'), `'both \\' and "'`);
  assert.equal(formatVal(S('a\nb\x00\xa0'), 'python'), `'a\\nb\\x00\\xa0'`);
  assert.equal(formatVal({ t: 'bytes', v: 'a\xff' }, 'python'), `b'a\\xff'`);
  assert.equal(formatVal(L(B(true), NONE, F('inf'), F('nan')), 'python'), '[True, None, inf, nan]');
});

test('formatVal matches Python repr on a real interpreter (skipped without python)', (t) => {
  const code = [
    'vals = [0, -5, 10**30, 1.0, 2.5, -0.0, 0.1+0.2, 1e16, 1e15, 123456789012345678.0, 1e-5, 0.0001, 1e22, 5e-324,',
    "  float('inf'), float('nan'), 'hi', \"it's\", 'say \"hi\"', 'both \\' and \"', 'a\\nb\\tc\\x00\\x7f\\x85\\xa0\\xad\\u2028', '\\U0001F600',",
    "  b'abc\\x00\\xff\\'', True, None, [], (), (1,), {}, {'a': 1, 2: [3]}, set(), {1}, frozenset(), frozenset({1}), [(1, 'x'), {'k': (None, True)}], 1/3]",
    'for v in vals: print(repr(v))',
  ].join('\n');
  const r = spawnSync('python', ['-X', 'utf8', '-c', code], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0 || !r.stdout) return t.skip('python not available');
  const lines = r.stdout.trimEnd().split(/\r?\n/);
  assert.ok(lines.length >= 35);
  for (const line of lines) assert.equal(formatVal(parsePyLiteral(line), 'python'), line);
});

test('editDistance', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('same', 'same'), 0);
  assert.equal(editDistance('[1, 2, 3]', '[1, 2, 4]'), 1);
  assert.equal(editDistance('\u{1F600}a', 'a'), 1, 'counts code points');
  assert.equal(editDistance('aaaaaaaa', 'bbbbbbbb', 2), 3, 'stops early past max');
});

// ---------------------------------------------------------------- compareOutput: Python

test('2 vs 2.0 is wrong in Python', () => {
  assert.equal(kind('2', py1(F(2), '2.0')), 'wrong');
  assert.equal(kind('2.0', py1(I(2), '2')), 'wrong');
  assert.equal(kind('2.0', py1(F(2), '2.0')), 'correct');
  assert.equal(kind('2.00', py1(F(2), '2.0')), 'correct', 'same float value');
});

test('a string containing an apostrophe', () => {
  const rec = py1(S("it's"), `"it's"`);
  assert.equal(kind("it's", rec), 'correct');
  assert.equal(kind(`"it's"`, rec), 'format-only');
  assert.equal(kind("'it's'", rec), 'format-only', 'quotes removed even when the quoted text does not parse');
  assert.equal(kind("its", rec), 'wrong');
  const inList = py1(L(S("it's")), `["it's"]`);
  assert.equal(kind(`["it's"]`, inList), 'correct');
  assert.equal(kind(`['it\\'s']`, inList), 'correct');
});

test("'None' inside a string is never confused with None", () => {
  assert.equal(kind('None', py1(S('None'), "'None'")), 'correct', 'print shows the str bare');
  assert.equal(kind('x is None', py1(S('x is None'), "'x is None'")), 'correct');
  const rec = py1(L(S('None'), NONE), "['None', None]");
  assert.equal(kind("['None', None]", rec), 'correct');
  assert.equal(kind('[None, None]', rec), 'wrong');
  assert.equal(kind("['None', 'None']", rec), 'wrong');
});

test("'hi' vs hi is format-only, with a note", () => {
  const rec = py1(S('hi'), "'hi'");
  assert.deepEqual(verdict("'hi'", rec), { verdict: 'format-only', note: 'right idea; Python writes it as hi' });
  assert.equal(kind('"hi"', rec), 'format-only');
  assert.equal(kind('hi', rec), 'correct');
  assert.equal(kind("'hi'", rec, 'python', { typeSensitive: true }), 'wrong');
});

test('(1, 2) vs [1, 2] is format-only, but wrong under a type-sensitive tag', () => {
  const rec = py1(T(I(1), I(2)), '(1, 2)');
  assert.equal(kind('(1, 2)', rec), 'correct');
  assert.equal(kind('(1,2)', rec), 'correct', 'spacing never matters');
  assert.deepEqual(verdict('[1, 2]', rec), { verdict: 'format-only', note: 'right idea; Python writes it as (1, 2)' });
  assert.equal(kind('[1, 2]', rec, 'python', { typeSensitive: true }), 'wrong');
  assert.equal(kind('[[1, 2]]', py1(L(T(I(1), I(2))), '[(1, 2)]')), 'format-only', 'nested conversion');
});

test('format-only is wrong when a mutant prints exactly that answer', () => {
  const rec = py1(T(I(1), I(2)), '(1, 2)');
  const v = verdict('[1, 2]', rec, 'python', { mutants: [mutant('m-list', py1(L(I(1), I(2)), '[1, 2]'))] });
  assert.deepEqual(v, { verdict: 'wrong', mutantId: 'm-list' });
});

test('True/true and None/null are format-only', () => {
  assert.equal(kind('true', py1(B(true), 'True')), 'format-only');
  assert.equal(kind('null', py1(NONE, 'None')), 'format-only');
  assert.equal(kind('[true, null]', py1(L(B(true), NONE), '[True, None]')), 'format-only');
  assert.equal(kind('True', py1(B(true), 'True')), 'correct');
  assert.equal(kind('1', py1(B(true), 'True')), 'wrong');
});

test('missing outer brackets is format-only, but only for a bare sequence', () => {
  assert.equal(kind('1, 2', py1(T(I(1), I(2)), '(1, 2)')), 'format-only');
  assert.equal(kind('1, 2', py1(L(I(1), I(2)), '[1, 2]')), 'format-only');
  assert.equal(kind("'a': 1", py1(D([S('a'), I(1)]), "{'a': 1}")), 'format-only');
  assert.equal(kind('5', py1(L(I(5)), '[5]')), 'wrong', 'an element is not a one-item slice');
  assert.equal(kind('[1, 2]', py1(L(L(I(1), I(2))), '[[1, 2]]')), 'wrong', 'nesting is not notation');
  assert.equal(kind('1 2', py1(L(I(1), I(2)), '[1, 2]')), 'wrong');
});

test('set and dict order does not matter, duplicates do', () => {
  const rec = py1(SET(I(1), I(2), I(3)), '{1, 2, 3}');
  assert.equal(kind('{3, 2, 1}', rec), 'correct');
  assert.equal(kind('{1, 1, 2, 3}', rec), 'wrong');
  assert.equal(kind('[1, 2, 3]', rec), 'wrong');
  const d = py1(D([S('a'), I(1)], [S('b'), I(2)]), "{'a': 1, 'b': 2}");
  assert.equal(kind(`{"b": 2, "a": 1}`, d), 'correct');
});

test('mutant matching: strict match names the mutant; an edit-distance-1 slip does not', () => {
  const rec = py1(L(I(1), I(2), I(3)), '[1, 2, 3]');
  const mutants = [mutant('m-slice', py1(L(I(2), I(3)), '[2, 3]')), mutant('m-last', py1(L(I(1), I(2), I(4)), '[1, 2, 4]'))];
  assert.deepEqual(verdict('[2, 3]', rec, 'python', { mutants }), { verdict: 'wrong', mutantId: 'm-slice' });
  assert.deepEqual(verdict('[2,3]', rec, 'python', { mutants }), { verdict: 'wrong', mutantId: 'm-slice' }, 'strict means typed, not spacing');
  assert.deepEqual(verdict('[1, 2, 4]', rec, 'python', { mutants }), { verdict: 'wrong' }, 'one character from the actual output: a slip');
  assert.deepEqual(verdict('[1,2,4]', rec, 'python', { mutants }), { verdict: 'wrong' }, 'a slip even with different spacing');
  assert.deepEqual(verdict('[9]', rec, 'python', { mutants }), { verdict: 'wrong' });
});

test('ambiguous mutants record wrong evidence without naming a belief', () => {
  const rec = py1(I(6), '6');
  const out = py1(I(10), '10');
  assert.deepEqual(verdict('10', rec, 'python', { mutants: [mutant('a', out, true), mutant('b', out, true)] }), { verdict: 'wrong', ambiguous: true });
  assert.deepEqual(verdict('10', rec, 'python', { mutants: [mutant('a', out), mutant('b', out)] }), { verdict: 'wrong', ambiguous: true }, 'two matches are ambiguous too');
});

test('multi-line answers: separate lines or " | "', () => {
  const rec = py([[S('a'), "'a'"]], [[L(I(1)), '[1]']], [[B(false), 'False']]);
  assert.equal(kind('a\n[1]\nFalse', rec), 'correct');
  assert.equal(kind('a | [1] | False', rec), 'correct');
  assert.equal(kind('# -> a\n# -> [ 1 ]\n# -> False', rec), 'correct', 'pad prefixes are tolerated');
  assert.equal(kind('a | [1]', rec), 'wrong', 'a missing line');
  assert.equal(kind('a | [1] | False | x', rec), 'wrong', 'an extra line');
  assert.equal(kind("'a' | [1] | False", rec), 'format-only');
  assert.equal(kind('a | [1] | false', rec), 'format-only');
  assert.equal(kind('[1] | a | False', rec), 'wrong', 'order matters across lines');
  const bar = py1(S('a | b'), "'a | b'");
  assert.equal(kind('a | b', bar), 'correct', "a printed ' | ' is not a line break");
  const twoLines = py1(S('x\ny'), "'x\\ny'");
  assert.equal(kind('x | y', twoLines), 'correct');
  assert.equal(kind(`'x\\ny'`, twoLines), 'format-only');
});

test('print with several arguments', () => {
  const rec = py([[S('total:'), "'total:'"], [L(I(1), I(2)), '[1, 2]']]);
  assert.equal(rec.stdout, 'total: [1, 2]\n');
  assert.equal(kind('total: [1, 2]', rec), 'correct');
  assert.equal(kind('total: [1,2]', rec), 'correct');
  assert.equal(kind("'total:' [1, 2]", rec), 'format-only');
  assert.equal(kind("('total:', [1, 2])", rec), 'wrong', 'print(a, b) does not print a tuple');
  const nums = py([[I(3), '3'], [F(1.5), '1.5']]);
  assert.equal(kind('3   1.5', nums), 'correct');
  assert.equal(kind('3 1', nums), 'wrong');
});

test('exception-name answers for raising probes', () => {
  const rec = raises('ZeroDivisionError');
  for (const a of ['ZeroDivisionError', 'zerodivisionerror', 'ZeroDivisionError: division by zero', 'raises ZeroDivisionError', 'builtins.ZeroDivisionError', "ZeroDivisionError('division by zero')", 'ZeroDivisionError.']) {
    assert.equal(kind(a, rec), 'correct', a);
  }
  assert.equal(kind("KeyError('a: b')", raises('KeyError')), 'correct');
  assert.equal(kind('error', rec), 'wrong');
  assert.equal(kind('ZeroDivision', rec), 'wrong');
  assert.equal(kind('division by zero', rec), 'wrong');
  assert.equal(kind('0', rec), 'wrong');
  // Lines printed before the raise may be included or left out.
  const after = raises('IndexError', '3\n');
  assert.equal(kind('IndexError', after), 'correct');
  assert.equal(kind('3 | IndexError', after), 'correct');
  assert.equal(kind('3', after), 'wrong');
});

test("a bare 'error' never names a mutant, an exception name does", () => {
  const rec = py1(I(3), '3');
  const mutants = [mutant('m-raise', raises('IndexError')), mutant('m-err', py1(S('error'), "'error'"))];
  assert.deepEqual(verdict('IndexError', rec, 'python', { mutants }), { verdict: 'wrong', mutantId: 'm-raise' });
  assert.deepEqual(verdict('error', rec, 'python', { mutants }), { verdict: 'wrong' });
  assert.deepEqual(verdict('it raises an error', rec, 'python', { mutants }), { verdict: 'wrong' });
  assert.deepEqual(verdict('error: index out of range', rec, 'python', { mutants }), { verdict: 'wrong' });
});

test("'?' is don't know, and so is an empty answer", () => {
  const rec = py1(I(3), '3');
  assert.deepEqual(verdict('?', rec, 'python', { mutants: [mutant('m', py1(S('?'), "'?'"))] }), { verdict: 'dont-know' });
  assert.equal(kind('  ?  ', rec), 'dont-know');
  assert.equal(kind('', rec), 'dont-know');
  assert.equal(kind('# -> ', rec), 'dont-know');
});

test('top-level str: CRLF and trailing whitespace are normalised, inner whitespace is not', () => {
  const rec = { stdout: 'a, b  \r\n', values: [[{ type: 'str', repr: "'a, b  '", val: S('a, b  ') }]] };
  assert.equal(kind('a, b', rec), 'correct');
  assert.equal(kind('a, b   ', rec), 'correct');
  assert.equal(kind('a,b', rec), 'wrong', 'the separator is the point of a join probe');
  assert.equal(kind(' a, b', rec), 'wrong');
});

test('unparseable values fall back to whitespace-collapsed text', () => {
  const cls = { stdout: "<class 'int'>\n", values: [[{ type: 'type', repr: "<class 'int'>", val: { t: 'opaque' as const, type: 'type', repr: "<class 'int'>" } }]] };
  assert.equal(kind("<class 'int'>", cls), 'correct');
  assert.equal(kind("<class  'int'>", cls), 'correct');
  assert.equal(kind("<class 'str'>", cls), 'wrong');
  const counter = { stdout: "Counter({'a': 2})\n", values: [[{ type: 'Counter', repr: "Counter({'a': 2})", val: { t: 'opaque' as const, type: 'Counter', repr: "Counter({'a': 2})" } }]] };
  assert.equal(kind("Counter({'a':2})", counter), 'correct');
  // Output the runner could not map to print calls (end='') is compared as text.
  const ends = { stdout: '1 2 3 \n', values: [[{ type: 'int', repr: '1', val: I(1) }], [{ type: 'int', repr: '2', val: I(2) }], [{ type: 'int', repr: '3', val: I(3) }]] };
  assert.equal(kind('1 2 3', ends), 'correct');
  assert.equal(kind('1  2 3', ends), 'correct');
  assert.equal(kind('1 2', ends), 'wrong');
});

test('return values (own-code probes): strings are written as literals', () => {
  const opts = { returnValue: true };
  const abc = py1(S('abc'), "'abc'");
  assert.equal(kind("'abc'", abc, 'python', opts), 'correct');
  assert.equal(kind('"abc"', abc, 'python', opts), 'correct');
  assert.deepEqual(verdict('abc', abc, 'python', opts), { verdict: 'format-only', note: "right idea; Python writes it as 'abc'" });
  assert.equal(kind('None', py1(S('None'), "'None'"), 'python', opts), 'wrong', "None is not the string 'None'");
  assert.equal(kind("['a', '', 'b']", py1(L(S('a'), S(''), S('b')), "['a', '', 'b']"), 'python', opts), 'correct');
  assert.equal(kind('KeyError', raises('KeyError'), 'python', opts), 'correct');
});

// ---------------------------------------------------------------- compareOutput: JavaScript

test("[ 'a', 'b' ] vs ['a','b'] is correct in JS", () => {
  const rec = js([['a', 'b']]);
  assert.equal(rec.stdout, "[ 'a', 'b' ]\n");
  assert.equal(kind("['a','b']", rec, 'javascript'), 'correct');
  assert.equal(kind('["a", "b"]', rec, 'javascript'), 'correct');
  assert.equal(kind("[ 'a', 'b', ]", rec, 'javascript'), 'correct');
  assert.equal(kind("['b','a']", rec, 'javascript'), 'wrong');
});

test('a 100-character array printed by Node (grouped onto several lines)', () => {
  const xs = Array.from({ length: 26 }, (_, i) => i * 3);
  const rec = js([xs]);
  assert.ok(inspect(xs, { breakLength: Infinity, compact: true }).length >= 100);
  assert.ok(rec.stdout.split('\n').length > 3, 'util.inspect groups long numeric arrays into columns');
  assert.equal(kind(JSON.stringify(xs), rec, 'javascript'), 'correct');
  assert.equal(kind(`[${xs.join(', ')}]`, rec, 'javascript'), 'correct');
  assert.equal(kind(rec.stdout, rec, 'javascript'), 'correct', 'typed exactly as printed');
  assert.equal(kind(JSON.stringify(xs.slice(1)), rec, 'javascript'), 'wrong');
  assert.equal(actualText(rec, 'javascript'), `[ ${xs.join(', ')} ]`);
  // Followed by another line: the grouped block is still one answer line.
  const two = js([xs], ['done']);
  assert.equal(kind(`${JSON.stringify(xs)} | done`, two, 'javascript'), 'correct');
  const words = ['apple', 'banana', 'cherry', 'dates', 'elderberry', 'fig', 'grape', 'honeydew', 'kiwi', 'lemon', 'mango'];
  assert.equal(kind(JSON.stringify(words), js([words]), 'javascript'), 'correct');
});

test('JS numbers: 3 and 3.0 are the same number, -0 is not 0', () => {
  assert.equal(kind('3.0', js([6 / 2]), 'javascript'), 'correct');
  assert.equal(kind('0', js([-0]), 'javascript'), 'wrong');
  assert.equal(kind('-0', js([-0]), 'javascript'), 'correct');
  assert.equal(kind('NaN', js([NaN]), 'javascript'), 'correct');
  assert.equal(kind("'3'", js([3]), 'javascript'), 'wrong');
  assert.equal(kind('3', js(['3']), 'javascript'), 'correct', 'a printed string shows bare');
});

test('JS: quotes, objects, Maps, Sets and JSON.stringify output', () => {
  assert.deepEqual(verdict("'hi'", js(['hi']), 'javascript'), { verdict: 'format-only', note: 'right idea; JavaScript writes it as hi' });
  assert.equal(kind('`hi`', js(['hi']), 'typescript'), 'format-only');
  assert.equal(kind('{a:1, "b": [true]}', js([{ a: 1, b: [true] }]), 'javascript'), 'correct');
  assert.equal(kind('{ a: 1, b: [ True ] }', js([{ a: 1, b: [true] }]), 'javascript'), 'format-only');
  assert.equal(kind('None', js([null]), 'javascript'), 'format-only');
  assert.equal(kind('undefined', js([null]), 'javascript'), 'wrong');
  assert.equal(kind("Map(1) { 'a' => 1 }", js([new Map([['a', 1]])]), 'javascript'), 'correct');
  assert.equal(kind('Set { 2, 1 }', js([new Set([1, 2])]), 'javascript'), 'correct');
  assert.equal(kind('{"a": [1, 2]}', js([JSON.stringify({ a: [1, 2] })]), 'javascript'), 'correct', 'JSON spacing never matters');
  assert.equal(kind('{"a": [1, 3]}', js([JSON.stringify({ a: [1, 2] })]), 'javascript'), 'wrong');
  assert.equal(kind('x: [ 1 ]', js(['x:', [1]]), 'javascript'), 'correct');
});

test('JS exceptions: Error is a real class name', () => {
  assert.equal(kind('TypeError', raises('TypeError'), 'javascript'), 'correct');
  assert.equal(kind('Uncaught TypeError: x is not a function', raises('TypeError'), 'javascript'), 'correct');
  assert.equal(kind('Error', raises('Error'), 'javascript'), 'correct');
  const rec = js([1]);
  assert.deepEqual(verdict('Error', rec, 'javascript', { mutants: [mutant('m', raises('Error'))] }), { verdict: 'wrong', mutantId: 'm' });
  assert.deepEqual(verdict('error', rec, 'javascript', { mutants: [mutant('m', raises('Error'))] }), { verdict: 'wrong' });
});

// ---------------------------------------------------------------- answerSpaceG / actualText

test('answerSpaceG by answer space', () => {
  assert.equal(answerSpaceG(py1(B(true), 'True')), 0.5);
  assert.equal(answerSpaceG(js([false])), 0.5);
  assert.equal(answerSpaceG(raises('KeyError')), 0.25);
  assert.equal(answerSpaceG(raises('KeyError', '1\n')), 0.25);
  assert.equal(answerSpaceG(py1(I(7), '7')), 0.2);
  assert.equal(answerSpaceG(py1(I(-19), '-19')), 0.2);
  assert.equal(answerSpaceG(js([12])), 0.2);
  assert.equal(answerSpaceG(py1(I(20), '20')), 0.12);
  assert.equal(answerSpaceG(py1(F(2), '2.0')), 0.12);
  assert.equal(answerSpaceG(py1(S('abc'), "'abc'")), 0.12);
  assert.equal(answerSpaceG(py1(L(I(1), I(2)), '[1, 2]')), 0.06);
  assert.equal(answerSpaceG(py1(S('hello world'), "'hello world'")), 0.06);
  assert.equal(answerSpaceG(js([Array.from({ length: 25 }, (_, i) => i)])), 0.06, 'a grouped array is one value');
  assert.equal(answerSpaceG(py([[I(1), '1']], [[I(2), '2']])), 0.04);
  assert.equal(answerSpaceG(py1(S('a\nb\nc'), "'a\\nb\\nc'")), 0.04);
});

test('robustness: blank lines at the ends, CRLF answers, untyped arguments', () => {
  const blanks = py([], [[I(1), '1']], []);
  assert.equal(blanks.stdout, '\n1\n\n');
  assert.equal(kind('1', blanks), 'correct');
  assert.equal(kind('1\r\n2', py([[I(1), '1']], [[I(2), '2']])), 'correct');
  assert.equal(kind('1\n\n2', py([[I(1), '1']], [], [[I(2), '2']])), 'correct', 'a blank line in the middle is part of the answer');
  assert.equal(kind('1\n2', py([[I(1), '1']], [], [[I(2), '2']])), 'wrong');
  const untyped = { stdout: 'Point(x=1, y=2)\n', values: [[{ type: 'Point', repr: 'Point(x=1, y=2)' } as PrintedArg]] };
  assert.equal(kind('Point(x=1,y=2)', untyped), 'correct');
  assert.equal(kind('Point(x=2, y=1)', untyped), 'wrong');
  assert.equal(kind('[1, 2]', py1(L(I(1), I(2)), '[1, 2]'), 'python', { typeSensitive: true }), 'correct');
});

test('return values in JavaScript', () => {
  const opts = { returnValue: true };
  const rec: RecordedOutput = { stdout: "[ 'a', '', 'b' ]", values: [[{ type: 'object', repr: "[ 'a', '', 'b' ]", val: L(S('a'), S(''), S('b')) }]] };
  assert.equal(kind('["a", "", "b"]', rec, 'javascript', opts), 'correct');
  assert.equal(kind("['a', 'b']", rec, 'javascript', opts), 'wrong');
  const str: RecordedOutput = { stdout: "'x'", values: [[{ type: 'string', repr: "'x'", val: S('x') }]] };
  assert.equal(kind("'x'", str, 'javascript', opts), 'correct');
  assert.equal(kind('x', str, 'javascript', opts), 'format-only');
  assert.equal(kind('null', str, 'javascript', opts), 'wrong');
});

test('actualText shows the output on one line', () => {
  assert.equal(actualText(py([[S('a'), "'a'"]], [[L(I(2), I(3)), '[2, 3]']]), 'python'), 'a | [2, 3]');
  assert.equal(actualText(raises('IndexError', '1\n'), 'python'), '1 | IndexError');
  assert.equal(actualText(py1(S('abc'), "'abc'"), 'python', true), "'abc'");
});
