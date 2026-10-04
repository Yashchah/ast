import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mutateLiteral, parseCall, renameCallee, sameArgs, validateCall } from '../src/calls';
import { valEquals } from '../src/compare';
import type { Val } from '../src/contracts';

const S = (v: string): Val => ({ t: 'str', v });
const I = (v: number): Val => ({ t: 'int', v: String(v) });
const N = (v: number): Val => ({ t: 'num', v });
const L = (...v: Val[]): Val => ({ t: 'list', v });

// ---------------------------------------------------------------- accepted calls

test('parseCall accepts one call with literal arguments (Python)', () => {
  const r = parseCall("count_words('a  b')", 'python');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.callee, 'count_words');
  assert.deepEqual(r.args.map((a) => a.val), [S('a  b')]);
  assert.equal(r.call, "count_words('a  b')");

  const many = parseCall("f([1, -2], (3,), {'k': [None, True]}, 2.5, b'x', -7, set(), sep=',', limit=-1)", 'python');
  assert.equal(many.ok, true, many.error);
  assert.deepEqual(many.args.map((a) => a.name), [undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'sep', 'limit']);
  assert.deepEqual(many.args[0].val, L(I(1), I(-2)));
  assert.deepEqual(many.args[5].val, I(-7));
  assert.equal(many.args[7].text, "','");

  assert.equal(parseCall('f()', 'python').ok, true);
  assert.equal(parseCall('  f( 1 ,\n  2, )  ', 'python').ok, true, 'whitespace, newlines inside the parentheses and a trailing comma');
  assert.equal(parseCall("f(r'\\d+', u'x')", 'python').ok, true);
});

test('parseCall accepts one call with literal arguments (JS/TS)', () => {
  const r = parseCall("parseArgs(['-v', \"x\"], { a: 1, 'b-c': [true, null, undefined], 3: -0 }, -2, 10n, NaN, `t`);", 'javascript');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.callee, 'parseArgs');
  assert.equal(r.args.length, 6);
  assert.equal(r.call, "parseArgs(['-v', \"x\"], { a: 1, 'b-c': [true, null, undefined], 3: -0 }, -2, 10n, NaN, `t`)", 'the trailing ; is dropped');
  assert.deepEqual(r.args[2].val, N(-2));
  assert.equal(parseCall('total([4, 5, 6])', 'typescript').ok, true);
});

// ---------------------------------------------------------------- rejected calls (spec V1-11 / V1-12)

test('validateCall rejects a variable', () => {
  for (const [call, lang] of [['f(x)', 'python'], ['f([1, x])', 'python'], ["f({'a': y})", 'python'], ['f(-x)', 'python'], ['f(xs)', 'javascript'], ['f({ a })', 'javascript'], ['f(inf)', 'python'], ['f(globalThis)', 'javascript']] as const) {
    const r = validateCall(call, lang, ['f']);
    assert.equal(r.ok, false, call);
    assert.match(r.error ?? '', /not a literal/, call);
  }
});

test('validateCall rejects two calls', () => {
  for (const [call, lang] of [
    ['f(1); f(2)', 'python'],
    ['f(1); f(2)', 'javascript'],
    ['f(1)\nf(2)', 'python'],
    ['f(1) + f(2)', 'python'],
    ['f(1)(2)', 'python'],
    ['f(g(1))', 'python'],
    ['f(len([1]))', 'python'],
    ["f(float('inf'))", 'python'],
    ['f(frozenset())', 'python'],
    ['f(set([1]))', 'python'],
    ['f(new Map())', 'javascript'],
    ['f(Map(1) { 1 => 2 })', 'javascript'],
    ['f(String(1))', 'javascript'],
  ] as const) {
    assert.equal(validateCall(call, lang, ['f', 'g']).ok, false, call);
  }
});

test('validateCall rejects attribute access', () => {
  for (const [call, lang] of [["os.system('ls')", 'python'], ['f(x.y)', 'python'], ['f(1).real', 'python'], ["f('a').upper()", 'python'], ['Math.max(1, 2)', 'javascript'], ['f([1].length)', 'javascript']] as const) {
    assert.equal(validateCall(call, lang, ['f', 'os', 'Math']).ok, false, call);
  }
  assert.match(validateCall("os.system('ls')", 'python', ['os']).error ?? '', /attribute/);
});

test('validateCall rejects imports', () => {
  assert.equal(validateCall('import os', 'python', ['f']).ok, false);
  assert.equal(validateCall("__import__('os')", 'python', ['f']).ok, false);
  assert.equal(validateCall("__import__('os').system('x')", 'python', ['__import__']).ok, false);
  assert.equal(validateCall("import('fs')", 'javascript', ['f']).ok, false);
  assert.equal(validateCall("require('fs')", 'javascript', ['f']).ok, false);
  assert.equal(validateCall("f(__import__('os'))", 'python', ['f']).ok, false);
  assert.equal(validateCall("f(require('fs'))", 'javascript', ['f']).ok, false);
});

test('validateCall rejects comprehensions, lambdas, operators and other code', () => {
  const py: string[] = [
    'f([x for x in range(3)])', 'f(x for x in [1])', 'f({k: 1 for k in [1]})', 'f(lambda: 1)', 'f(1 + 2)', 'f([1, 2][0])',
    "f('a' 'b')", "f(f'{x}')", 'f(*[1])', "f(**{'a': 1})", 'f(not True)', "f('a' if True else 'b')", 'f(x := 1)',
    'f(a=1, 2)', 'f(a=1, a=2)', 'f(True=1)', 'f(1)  # comment', 'f(1', 'f[1]', 'f', '', '(f)(1)', 'await f(1)', 'print', '1j',
    'f(1j)', 'f(...)', 'f([1] * 3)', "f({[1]: 'unhashable'})", 'f(-True)', 'lambda(1)',
  ];
  for (const call of py) assert.equal(validateCall(call, 'python', ['f', 'print']).ok, false, call);
  const js: string[] = [
    'f(() => 1)', 'f(x => x)', 'f(function () {})', 'f(...xs)', 'f([...xs])', 'f({ ...o })', "f({ ['k']: 1 })", 'f({ get a() { return 1 } })',
    'f(`${x}`)', 'f(a = 1)', 'f((1, 2))', 'f(--1)', 'f(1 as number)', 'f(<any>1)', 'new f(1)', 'await f(1)', 'f(typeof 1)', 'f({ __proto__: {} })',
    'f(1); g(2)', 'f(/re/)', 'f(1) // c', 'void f(1)',
  ];
  for (const call of js) assert.equal(validateCall(call, 'javascript', ['f', 'g']).ok, false, call);
});

test('validateCall requires an interface function name', () => {
  const r = validateCall('total([4, 5, 6])', 'python', ['average', 'count']);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /total.*average, count/);
  assert.equal(validateCall('total([4, 5, 6])', 'python', ['total']).ok, true);
  assert.equal(validateCall('eval("1")', 'python', ['total']).ok, false);
});

// ---------------------------------------------------------------- sameArgs / renameCallee

test('sameArgs compares values, keyword arguments in any order', () => {
  const a = parseCall("f([1, 2], sep=',', n=2)", 'python').args;
  assert.ok(sameArgs(a, parseCall('f([1,2], n=2, sep=",")', 'python').args));
  assert.ok(!sameArgs(a, parseCall("f([1, 2], sep=';', n=2)", 'python').args));
  assert.ok(!sameArgs(a, parseCall("f([1, 2], ',', 2)", 'python').args));
  assert.ok(!sameArgs(parseCall('f(2)', 'python').args, parseCall('f(2.0)', 'python').args));
});

test('renameCallee maps an interface name to the learner name', () => {
  assert.equal(renameCallee("parse_args(['-v'])", 'parseArgs'), "parseArgs(['-v'])");
  assert.equal(renameCallee('  total([1])', 'sum_all'), '  sum_all([1])');
  assert.throws(() => renameCallee('f(1)', 'not a name'));
  assert.throws(() => renameCallee('f(1)', 'os.system'));
});

// ---------------------------------------------------------------- mutateLiteral

/** Every mutation must be a valid call that differs from the original in exactly one argument. */
function checkMutations(call: string, lang: 'python' | 'javascript', muts: string[]): void {
  const orig = parseCall(call, lang);
  assert.equal(new Set(muts).size, muts.length, 'no duplicates');
  for (const m of muts) {
    const r = validateCall(m, lang, [orig.callee]);
    assert.equal(r.ok, true, `${m}: ${r.error}`);
    assert.ok(!sameArgs(r.args, orig.args), `${m} must change an argument`);
    const changed = r.args.filter((a, i) => !valEquals(a.val, orig.args[i].val));
    assert.equal(changed.length, 1, `${m} changes exactly one argument`);
    assert.equal(r.args.length, orig.args.length);
  }
}

test('mutateLiteral: empty list or string, 0, -1, boundaries, duplicates', () => {
  const call = 'top_k([3, 1, 2], 2)';
  const muts = mutateLiteral(call, 'python');
  checkMutations(call, 'python', muts);
  assert.deepEqual(muts.slice(0, 5), ['top_k([], 2)', 'top_k([3, 1, 2], 3)', 'top_k([3, 1, 2], 0)', 'top_k([3, 1, 2], -1)', 'top_k([3, 1, 2, 3], 2)'], 'whole arguments first, empty inputs first');
  for (const want of ['top_k([3, 1, 2], 0)', 'top_k([3, 1, 2], -1)', 'top_k([3, 1, 2], 3)', 'top_k([3, 1, 2, 3], 2)', 'top_k([0, 1, 2], 2)', 'top_k([3, -1, 2], 2)']) {
    assert.ok(muts.includes(want), `missing ${want} in ${muts.join(' ; ')}`);
  }
  assert.ok(!muts.includes(call));
  assert.ok(!muts.includes('top_k([3, 1, 2], 2)'), 'len - 1 equals the original 2: skipped');
});

test('mutateLiteral: strings, keyword arguments, negative literals, tuples', () => {
  const words = mutateLiteral("count_words('a  b')", 'python');
  assert.deepEqual(words, ["count_words('')"]);
  const kw = mutateLiteral("join(parts=['a', 'b'], sep=', ')", 'python');
  checkMutations("join(parts=['a', 'b'], sep=', ')", 'python', kw);
  for (const want of ["join(parts=[], sep=', ')", "join(parts=['a', 'b'], sep='')", "join(parts=['', 'b'], sep=', ')", "join(parts=['a', 'b', 'a'], sep=', ')"]) {
    assert.ok(kw.includes(want), `missing ${want}`);
  }
  const neg = mutateLiteral('clamp(-5)', 'python');
  assert.deepEqual(neg, ['clamp(0)', 'clamp(-1)'], 'the sign is part of the literal');
  const tup = mutateLiteral('area((2, 3))', 'python');
  checkMutations('area((2, 3))', 'python', tup);
  assert.ok(tup.includes('area(())'));
  assert.ok(tup.includes('area((2, 3, 2))'));
  assert.ok(mutateLiteral("f(b'ab')", 'python').includes("f(b'')"));
  const nested = mutateLiteral("f({'a': [1]})", 'python');
  checkMutations("f({'a': [1]})", 'python', nested);
  assert.ok(nested.includes("f({'a': []})"));
});

test('mutateLiteral: JavaScript, and nothing for invalid calls', () => {
  const call = "slice([1, 2, 3], 'ab', 1.5, 7n);";
  const muts = mutateLiteral(call, 'javascript');
  checkMutations(call, 'javascript', muts);
  for (const want of ["slice([], 'ab', 1.5, 7n)", "slice([1, 2, 3], '', 1.5, 7n)", "slice([1, 2, 3], 'ab', 1.5, 0n)", "slice([1, 2, 3], 'ab', 1.5, 2n)"]) {
    assert.ok(muts.includes(want), `missing ${want} in ${muts.join(' ; ')}`);
  }
  assert.ok(!muts.some((m) => m.includes('1.5') === false), 'floats are not mutated');
  assert.deepEqual(mutateLiteral('f(x)', 'python'), []);
  assert.deepEqual(mutateLiteral('f()', 'python'), []);
  assert.deepEqual(mutateLiteral('f(True, None)', 'python'), [], 'booleans and None are left alone');
});
