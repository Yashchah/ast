import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BatchItem, BatchRecord, LearnerRunOptions, RunResult, Runner, Runtime, SpecItem, SpecResult, TaskInterface, TaskSpecState } from '../src/contracts';
import { validateCall } from '../src/calls';
import {
  DESIGN_DIFFERS, TIMEOUT_TEXT, actualLine, arityOf, buildHarnessInput, buildVerificationPlan, findTopLevelFunctions, hiddenFailureCard,
  mapInterface, moduleKindFor, normalizeExpected, parseHarnessOutput, parseProbeOutput, rewriteSpecCalls, signatureMatch, specEvidenceWeight,
  specTimeoutMs, targetSpec, validateSpecs, verifySpecLadder, visibleTitles, type HarnessInput, type SpecLadderDraft,
} from '../src/specsCore';

const spec = (id: string, call: string, expected: string, extra: Partial<SpecItem> = {}): SpecItem => ({
  id, title: `title ${id}`, conceptId: 'c', call, expected, expectError: '', parSec: 30, failureSignatures: [], ...extra,
});

const PY_IFACE: TaskInterface = { file: 'wc.py', functions: [{ name: 'count_words', signature: 'count_words(text) -> dict', purpose: 'count' }] };

// =====================================================================================
// parseHarnessOutput
// =====================================================================================

describe('parseHarnessOutput', () => {
  const plan = '@@DLB_PLAN ["s1", "s2", "s3"]';
  const load = '@@DLB_LOAD {"importMs": 12.5}';

  test('a complete run: records in plan order, importMs, typed extras kept', () => {
    const out = [
      plan, load,
      '@@DLB_START s1', '@@DLB {"id": "s1", "pass": true, "status": "ok", "actual": "{\'a\': 1}", "val": {"t": "dict", "v": []}}',
      '@@DLB_START s2', '@@DLB {"id": "s2", "pass": false, "status": "ok", "actual": "{}", "sig": 0, "stdout": "debug\\n"}',
      '@@DLB_START s3', '@@DLB {"id": "s3", "pass": false, "status": "ok", "error": "KeyError: \'x\'", "exception": "KeyError", "line": 7}',
      '@@DLB_END {}',
    ].join('\n');
    const r = parseHarnessOutput(out, '', false);
    assert.equal(r.finished, true);
    assert.equal(r.timedOut, false);
    assert.equal(r.importMs, 12.5);
    assert.equal(r.loadError, undefined);
    assert.deepEqual(r.results.map((x) => [x.id, x.pass, x.status]), [['s1', true, 'ok'], ['s2', false, 'ok'], ['s3', false, 'ok']]);
    assert.equal(r.results[1].sig, 0);
    assert.equal(r.results[1].stdout, 'debug\n');
    assert.equal(r.results[2].exception, 'KeyError');
    assert.equal(r.results[2].line, 7);
    assert.deepEqual(r.results[0].val, { t: 'dict', v: [] });
  });

  test('a killed run: the spec that started last is a timeout, the rest not run', () => {
    const out = [plan, load, '@@DLB_START s1', '@@DLB {"id": "s1", "pass": true, "status": "ok", "actual": "1"}', '@@DLB_START s2'].join('\n');
    const r = parseHarnessOutput(out, 'Traceback...\nKeyboardInterrupt\n', true);
    assert.equal(r.timedOut, true);
    assert.equal(r.finished, false);
    assert.deepEqual(r.results.map((x) => [x.id, x.status]), [['s1', 'ok'], ['s2', 'timeout'], ['s3', 'not-run']]);
    assert.equal(r.results[1].error, TIMEOUT_TEXT);
    assert.equal(r.results[1].pass, false);
    assert.equal(r.loadError, undefined, 'a timeout during a spec is not a load problem');
  });

  test("the harness's own timeout record and END line", () => {
    const out = [plan, load, '@@DLB_START s1', '@@DLB {"id": "s1", "pass": false, "status": "timeout", "error": "timeout (infinite loop?)"}', '@@DLB_END {"timedOut": true}'].join('\n');
    const r = parseHarnessOutput(out, '', false);
    assert.equal(r.timedOut, true);
    assert.deepEqual(r.results.map((x) => x.status), ['timeout', 'not-run', 'not-run']);
  });

  test('a timeout during the import is a top-level problem; none started', () => {
    const r = parseHarnessOutput(plan + '\n', '', true);
    assert.equal(r.loadError?.kind, 'top-level');
    assert.equal(r.loadError?.name, 'timeout');
    assert.deepEqual(r.results.map((x) => x.status), ['not-run', 'not-run', 'not-run']);
  });

  test('a crash mid-run: the running spec gets the stderr tail, loadError is crash, warnings are dropped', () => {
    const out = [plan, load, '@@DLB_START s1', '@@DLB {"id": "s1", "pass": true, "status": "ok"}', '@@DLB_START s2'].join('\n');
    const stderr = '(node:123) ExperimentalWarning: Type Stripping is an experimental feature\nFatal Python error: Segmentation fault\n';
    const r = parseHarnessOutput(out, stderr, false);
    assert.equal(r.finished, false);
    assert.equal(r.loadError?.kind, 'crash');
    assert.match(r.loadError?.message ?? '', /Segmentation fault/);
    assert.doesNotMatch(r.loadError?.message ?? '', /ExperimentalWarning/);
    assert.equal(r.results[1].status, 'ok');
    assert.match(r.results[1].error ?? '', /crashed: Fatal Python error/);
    assert.equal(r.results[2].status, 'not-run');
  });

  test('a crash before any output: ids from the caller, all not run', () => {
    const r = parseHarnessOutput('', 'SyntaxError: invalid syntax in harness\n', false, { ids: ['a', 'b'] });
    assert.equal(r.loadError?.kind, 'crash');
    assert.deepEqual(r.results.map((x) => [x.id, x.status]), [['a', 'not-run'], ['b', 'not-run']]);
  });

  test('a load error ends the run; unknown kinds become crash; learner output before a tag is ignored', () => {
    const out = [
      'hello from the learner@@DLB_PLAN ["s1"]',
      '@@DLB_LOAD {"importMs": 3, "loadError": {"kind": "top-level", "message": "top-level code runs on import: move it under if __name__ == \'__main__\'", "name": "input()", "line": 4}}',
      '@@DLB_END {}',
    ].join('\r\n');
    const r = parseHarnessOutput(out, '', false);
    assert.deepEqual(r.loadError, { kind: 'top-level', message: "top-level code runs on import: move it under if __name__ == '__main__'", name: 'input()', line: 4 });
    assert.deepEqual(r.results, [{ id: 's1', pass: false, status: 'not-run' }]);
    const odd = parseHarnessOutput('@@DLB_PLAN []\n@@DLB_LOAD {"loadError": {"kind": "weird", "message": "x"}}\n@@DLB_END {}', '', false);
    assert.equal(odd.loadError?.kind, 'crash');
  });

  test('a truncated record line is treated as missing; the first record for an id wins; pass needs status ok', () => {
    const out = [
      plan, load, '@@DLB_START s1', '@@DLB {"id": "s1", "pass": true, "status": "ok"}', '@@DLB {"id": "s1", "pass": false, "status": "timeout"}',
      '@@DLB_START s2', '@@DLB {"id": "s2", "pass": true, "status": "timeout"}', '@@DLB_START s3', '@@DLB {"id": "s3", "pa',
    ].join('\n');
    const r = parseHarnessOutput(out, '', true);
    assert.equal(r.results[0].pass, true);
    assert.equal(r.results[1].pass, false, 'a timeout never passes');
    assert.equal(r.results[2].status, 'timeout');
  });
});

describe('parseProbeOutput', () => {
  test('value, exception, timeout, load error and silence', () => {
    const v = parseProbeOutput('@@DLB {"ok": true, "type": "list", "repr": "[1, 2]", "val": {"t": "list", "v": []}, "ms": 0.4, "importMs": 2}\n', '', false);
    assert.equal(v.ok, true);
    assert.equal(v.repr, '[1, 2]');
    assert.equal(v.type, 'list');
    assert.equal(v.importMs, 2);
    const e = parseProbeOutput('noise\n@@DLB {"ok": false, "exception": "IndexError", "error": "IndexError: list index out of range", "line": 3}\n', '', false);
    assert.equal(e.exception, 'IndexError');
    assert.equal(e.line, 3);
    assert.equal(parseProbeOutput('@@DLB {"ok": false, "timedOut": true, "error": "timeout (infinite loop?)"}', '', false).timedOut, true);
    assert.equal(parseProbeOutput('', '', true).timedOut, true);
    assert.equal(parseProbeOutput('@@DLB {"ok": false, "loadError": {"kind": "unsafe-top-level", "message": "m"}}', '', false).loadError?.kind, 'unsafe-top-level');
    assert.equal(parseProbeOutput('', 'boom', false).loadError?.kind, 'crash');
  });
});

// =====================================================================================
// Validation: calls and expected values are data, never code
// =====================================================================================

describe('validation', () => {
  test('validateCall rejects a variable, two calls, an attribute access and an import', () => {
    const names = ['count_words', 'parseArgs'];
    for (const [call, lang] of [
      ['count_words(text)', 'python'],
      ["count_words('a'); count_words('b')", 'python'],
      ["count_words('a') or count_words('b')", 'python'],
      ["os.system('rm -rf /')", 'python'],
      ["count_words.__globals__('x')", 'python'],
      ["__import__('os').system('x')", 'python'],
      ["count_words(__import__('os'))", 'python'],
      ["import os; count_words('a')", 'python'],
      ["parseArgs(require('fs'))", 'javascript'],
      ["parseArgs(import('fs'))", 'javascript'],
      ['parseArgs(argv)', 'javascript'],
      ['parseArgs([1]); parseArgs([2])', 'javascript'],
      ['process.exit(1)', 'javascript'],
    ] as const) {
      assert.equal(validateCall(call, lang, names).ok, false, call);
    }
    assert.equal(validateCall("count_words('a  b')", 'python', names).ok, true);
    assert.equal(validateCall("other('a')", 'python', names).ok, false, 'only interface functions');
  });

  test('validateSpecs drops invalid specs and signatures, canonicalises calls and expected values', () => {
    const items: SpecItem[] = [
      spec('s1', "count_words( 'a b' )", "{'a': 1, 'b': 1}"),
      spec('s2', 'count_words(text)', '{}'),
      spec('s3', "count_words('')", 'len("x")'),
      spec('s4', "count_words(None)", '', { expectError: 'AttributeError' }),
      spec('s5', "count_words(1)", '', { expectError: 'not a name!' }),
      spec('s1', "count_words('dup')", '{}'),
      spec('s6', "count_words('x')", "{'x': 1}", {
        failureSignatures: [
          { match: 'equals', value: "{'X': 1}", misconceptionId: 'case', nudge: 'Did you lower-case it?' },
          { match: 'equals', value: 'print(1)', misconceptionId: 'bad', nudge: '' },
          { match: 'error', value: 'KeyError', misconceptionId: 'key', nudge: 'Is every key there?' },
          { match: 'error', value: 'Key Error', misconceptionId: 'bad', nudge: '' },
        ],
      }),
    ];
    const { kept, dropped } = validateSpecs(items, PY_IFACE, 'python');
    assert.deepEqual(kept.map((s) => s.id), ['s1', 's4', 's6']);
    assert.equal(kept[0].call, "count_words('a b')");
    assert.equal(kept[1].expected, '', 'expectError specs carry no expected value');
    assert.deepEqual(kept[2].failureSignatures.map((f) => f.misconceptionId), ['case', 'key']);
    assert.deepEqual(dropped.map((d) => d.id), ['s2', 's3', 's5', 's1']);
    assert.match(dropped[0].reason, /not a literal/);
    assert.match(dropped[1].reason, /Python literal/);
    assert.match(dropped[3].reason, /duplicate/);
  });

  test('normalizeExpected: Python literals as written; JS converted to JSON or dropped', () => {
    assert.equal(normalizeExpected("{'a': (1, 2)}", 'python'), "{'a': (1, 2)}");
    assert.equal(normalizeExpected('set()', 'python'), 'set()');
    assert.equal(normalizeExpected("float('inf')", 'python'), undefined, 'literal_eval would refuse it');
    assert.equal(normalizeExpected('x + 1', 'python'), undefined);
    assert.equal(normalizeExpected('{"a": [1, true, null]}', 'javascript'), '{"a": [1, true, null]}');
    assert.equal(normalizeExpected("{ a: 1, 'b-c': ['x'], }", 'javascript'), '{"a":1,"b-c":["x"]}');
    assert.equal(normalizeExpected('undefined', 'javascript'), undefined, 'JSON cannot say undefined');
    assert.equal(normalizeExpected('NaN', 'typescript'), undefined);
    assert.equal(normalizeExpected('10n', 'javascript'), undefined);
    assert.equal(normalizeExpected('', 'javascript'), undefined);
  });

  test('buildHarnessInput carries calls, expected values and signatures, nothing else', () => {
    const s = spec('s1', "count_words('a')", "{'a': 1}", { failureSignatures: [{ match: 'error', value: 'KeyError', misconceptionId: 'm', nudge: 'n?' }] });
    const input: HarnessInput = buildHarnessInput([s], { workspace: '/ws', timeoutMs: 6000, functions: ['count_words'] });
    assert.deepEqual(input, {
      workspace: '/ws',
      timeoutMs: 6000,
      functions: ['count_words'],
      specs: [{ id: 's1', call: "count_words('a')", expected: "{'a': 1}", expectError: '', signatures: [{ match: 'error', value: 'KeyError' }] }],
    });
  });

  test('specTimeoutMs extends by the import time only once it is over 1 s', () => {
    assert.equal(specTimeoutMs(undefined), 5000);
    assert.equal(specTimeoutMs(900), 5000);
    assert.equal(specTimeoutMs(2400.2), 7401);
  });
});

// =====================================================================================
// Interface mapping
// =====================================================================================

describe('interface mapping', () => {
  const iface: TaskInterface = {
    file: 'cli.py',
    functions: [
      { name: 'parse_args', signature: 'parse_args(argv) -> dict', purpose: '' },
      { name: 'format_row', signature: 'format_row(row, width=10) -> str', purpose: '' },
    ],
  };

  test('arityOf reads Python and TypeScript signatures', () => {
    assert.equal(arityOf('parse_args(argv) -> dict'), 1);
    assert.equal(arityOf('format_row(row, width=10) -> str'), 2);
    assert.equal(arityOf('m(self, x, *args, key=None, **kw)'), 2);
    assert.equal(arityOf('f(a, /, b, *, c)'), 3);
    assert.equal(arityOf('parseArgs(argv: string[], opts: Map<string, number>): Args'), 2);
    assert.equal(arityOf('total(this: Cart, ...xs: number[])'), 0);
    assert.equal(arityOf('f()'), 0);
    assert.equal(arityOf('no parens'), -1);
  });

  test('exact names first, then the unique function of the same arity', () => {
    const exact = mapInterface(iface, [{ name: 'parse_args', arity: 1 }, { name: 'format_row', arity: 2 }, { name: 'helper', arity: 1 }]);
    assert.deepEqual(exact, { ok: true, mappedNames: {} });
    const renamed = mapInterface(iface, [{ name: 'read_args', arity: 1 }, { name: 'fmt', arity: 2 }, { name: 'main', arity: 0 }]);
    assert.deepEqual(renamed, { ok: true, mappedNames: { parse_args: 'read_args', format_row: 'fmt' } });
    const partly = mapInterface(iface, [{ name: 'parse_args', arity: 1 }, { name: 'fmt', arity: 2 }]);
    assert.deepEqual(partly.mappedNames, { format_row: 'fmt' });
  });

  test('ambiguous or missing counterparts: not applicable, and nothing is renamed', () => {
    const two = mapInterface(iface, [{ name: 'parse_args', arity: 1 }, { name: 'fmt', arity: 2 }, { name: 'fmt2', arity: 2 }]);
    assert.equal(two.ok, false);
    assert.equal(two.reason, DESIGN_DIFFERS);
    const none = mapInterface(iface, [{ name: 'parse_args', arity: 1 }, { name: 'fmt', arity: 3 }]);
    assert.equal(none.ok, false);
    // an interface name is never taken as another interface function's counterpart
    const taken = mapInterface(
      { file: 'x.py', functions: [{ name: 'a', signature: 'a(x)', purpose: '' }, { name: 'b', signature: 'b(y)', purpose: '' }] },
      [{ name: 'a', arity: 1 }],
    );
    assert.equal(taken.ok, false);
    assert.deepEqual(mapInterface(iface, []), { ok: true, mappedNames: {} }, 'nothing written yet: nothing differs');
  });

  test('rewriteSpecCalls renames only mapped callees', () => {
    const specs = [spec('s1', "parse_args(['-v'])", '{}'), spec('s2', "format_row(['a'], width=3)", "'a'")];
    const out = rewriteSpecCalls(specs, { parse_args: 'read_args' });
    assert.deepEqual(out.map((s) => s.call), ["read_args(['-v'])", "format_row(['a'], width=3)"]);
    assert.equal(specs[0].call, "parse_args(['-v'])", 'inputs are not mutated');
  });

  test('findTopLevelFunctions: Python defs with decorators, arity, ranges without trailing comments', () => {
    const src = [
      'import re', // 0
      '', // 1
      '@cache', // 2
      'def parse_args(argv,', // 3
      '               verbose=False):', // 4
      '    """Doc with def fake(x): inside', // 5
      'def not_a_function(y):', // 6
      '    """', // 7
      '    return {}', // 8
      '', // 9
      '# about helpers', // 10
      'class Row:', // 11
      '    def method(self, x):', // 12
      '        return x', // 13
      'async def fetch(self_url, *args):', // 14
      '    pass', // 15
      "if __name__ == '__main__':", // 16
      '    parse_args([])', // 17
    ].join('\n');
    assert.deepEqual(findTopLevelFunctions(src, 'python'), [
      { name: 'parse_args', startLine: 2, endLine: 8, arity: 2 },
      { name: 'fetch', startLine: 14, endLine: 15, arity: 1 },
    ]);
  });

  test('findTopLevelFunctions: JS/TS declarations, arrows, exports; braces in strings and regexes ignored', () => {
    const src = [
      "import fs from 'fs';", // 0
      'export function parseArgs(argv: string[], o = {}) {', // 1
      "  const s = '}';", // 2
      '  return /[{]/.test(s) ? {} : { x: `}${1}` };', // 3
      '}', // 4
      'const helper = (a, b) => {', // 5
      '  return a + b;', // 6
      '};', // 7
      'export const one = x => x', // 8
      '// trailing comment', // 9
      'const LIMIT = (1 + 2) * 3;', // 10: parentheses, but not a function
      'export default async function main() {}', // 11
      'export const typed = async <T,>(x: T, y: number): Promise<T> => x;', // 12
    ].join('\n');
    assert.deepEqual(findTopLevelFunctions(src, 'typescript'), [
      { name: 'parseArgs', startLine: 1, endLine: 4, arity: 2 },
      { name: 'helper', startLine: 5, endLine: 7, arity: 2 },
      { name: 'one', startLine: 8, endLine: 8, arity: 1 },
      { name: 'main', startLine: 11, endLine: 11, arity: 0 },
      { name: 'typed', startLine: 12, endLine: 12, arity: 2 },
    ]);
  });
});

// =====================================================================================
// Target-only reporting, fading, evidence weight, cards, signatures
// =====================================================================================

describe('ladder reporting', () => {
  const r = (id: string, pass: boolean, extra: Partial<SpecResult> = {}): SpecResult => ({ id, pass, status: 'ok', ...extra });

  test('only the first red spec is failed; later reds are not-yet', () => {
    const order = ['s1', 's2', 's3', 's4', 's5'];
    const rep = targetSpec(order, [r('s1', true), r('s2', false), r('s3', false), r('s4', true), r('s5', false, { status: 'timeout' })]);
    assert.equal(rep.target, 's2');
    assert.deepEqual(rep.display, { s1: 'passed', s2: 'failed', s3: 'not-yet', s4: 'passed', s5: 'not-yet' });
    assert.equal(rep.passed, 2);
    assert.equal(rep.total, 5);
    const allGreen = targetSpec(['a', 'b'], { a: r('a', true), b: r('b', true) });
    assert.equal(allGreen.target, undefined);
    const notRun = targetSpec(['a', 'b'], { a: r('a', false, { status: 'not-run' }) });
    assert.equal(notRun.target, undefined, 'a spec that never ran is not a failure');
    assert.deepEqual(notRun.display, { a: 'not-run', b: 'not-run' });
  });

  const state = (last: Record<string, SpecResult>, greenAt: Record<string, number> = {}): Pick<TaskSpecState, 'specs' | 'greenAt' | 'last'> => ({
    specs: [spec('s1', "count_words('')", '{}'), spec('s2', "count_words('a')", "{'a': 1}"), spec('s3', "count_words('a  b')", "{'a': 1, 'b': 1}")],
    greenAt,
    last,
  });

  test('fading: full shows all titles, partial reveals as earlier specs turn green', () => {
    const last = { s1: r('s1', true), s2: r('s2', false, { actual: '{}' }), s3: r('s3', false, { actual: '{}' }) };
    const full = visibleTitles('full', state(last, { s1: 1 }));
    assert.deepEqual(full.titles.map((t) => [t.id, t.display]), [['s1', 'passed'], ['s2', 'failed'], ['s3', 'not-yet']]);
    assert.equal(full.summary, '1 of 3 behaviours pass');
    assert.equal(full.next, 'title s2');
    assert.equal(full.target, undefined, 'the target call/actual line is for minimal and solo');
    assert.deepEqual(visibleTitles('partial', state({}, {})).titles.map((t) => t.id), ['s1'], 'the next title only');
    assert.deepEqual(visibleTitles('partial', state(last, { s1: 1 })).titles.map((t) => t.id), ['s1', 's2']);
    // a spec that was green once stays revealed even if it goes red again
    const relapsed = { s1: r('s1', false, { actual: 'None' }), s2: r('s2', true), s3: r('s3', false) };
    assert.deepEqual(visibleTitles('partial', state(relapsed, { s1: 1, s2: 2 })).titles.map((t) => t.id), ['s1', 's2', 's3']);
  });

  test('fading: minimal and solo show the count and the target call with the actual result, never the expected value', () => {
    const last = { s1: r('s1', true), s2: r('s2', false, { actual: "{'A': 1}" }), s3: r('s3', false) };
    for (const fade of ['minimal', 'solo'] as const) {
      const v = visibleTitles(fade, state(last, { s1: 1 }));
      assert.deepEqual(v.titles, []);
      assert.equal(v.summary, '1 of 3 behaviours pass');
      assert.deepEqual(v.target, { id: 's2', call: "count_words('a')", actual: "{'A': 1}", text: "count_words('a') returns {'A': 1}" });
      assert.doesNotMatch(JSON.stringify(v), /'a': 1/, 'the expected value never appears');
    }
    const raising = visibleTitles('solo', state({ s1: r('s1', false, { error: "KeyError: 'a'" }) }));
    assert.equal(raising.target?.text, "count_words('') raises KeyError: 'a'");
    const looping = visibleTitles('minimal', state({ s1: r('s1', false, { status: 'timeout', error: TIMEOUT_TEXT }) }));
    assert.equal(looping.target?.text, "count_words('') does not finish (infinite loop?)");
  });

  test('evidence weight: full within 3 saves since red and unassisted, else .3', () => {
    assert.equal(specEvidenceWeight(0, false), 1);
    assert.equal(specEvidenceWeight(3, false), 1);
    assert.equal(specEvidenceWeight(4, false), 0.3);
    assert.equal(specEvidenceWeight(9, false), 0.3);
    assert.equal(specEvidenceWeight(1, true), 0.3, 'assisted');
    assert.equal(specEvidenceWeight(undefined, false), 1, 'green on its first run');
  });

  test('hidden failure card shows the call and the actual result, never the expected value', () => {
    const s = spec('h1', "count_words('a  b')", "{'a': 1, 'b': 1}");
    assert.equal(
      hiddenFailureCard(s, r('h1', false, { actual: "{'': 1, 'a': 1, 'b': 1}" })),
      "Passes your checks but not count_words('a  b'): you return {'': 1, 'a': 1, 'b': 1}. What did you assume about the input?",
    );
    assert.match(hiddenFailureCard(s, r('h1', false, { error: 'IndexError: list index out of range' })), /: it raises IndexError: list index out of range\./);
    assert.match(hiddenFailureCard(s, r('h1', false, { status: 'timeout', error: TIMEOUT_TEXT })), /does not finish/);
    assert.match(hiddenFailureCard(s, '[]'), /you return \[\]\./);
    for (const card of [hiddenFailureCard(s, r('h1', false, { actual: '{}' })), hiddenFailureCard(s, r('h1', false, { error: 'E' }))]) {
      assert.doesNotMatch(card, /\{'a': 1, 'b': 1\}/);
    }
    assert.equal(actualLine("f(1)", r('x', false, { actual: '2' })), 'f(1) returns 2');
  });

  test('signatureMatch: the harness index, exception names, and typed or printed values', () => {
    const s = spec('s2', "count_words('a  b')", "{'a': 1, 'b': 1}", {
      failureSignatures: [
        { match: 'equals', value: "{'': 1, 'a': 1, 'b': 1}", misconceptionId: 'split-space', nudge: 'Is two spaces one separator?' },
        { match: 'error', value: 'KeyError', misconceptionId: 'missing-key', nudge: 'Does every word have a count yet?' },
      ],
    });
    const viaHarness = { id: 's2', pass: false, status: 'ok' as const, actual: 'whatever', sig: 1 };
    assert.equal(signatureMatch(viaHarness, s)?.misconceptionId, 'missing-key');
    assert.equal(signatureMatch(r('s2', false, { actual: "{'a': 1, '': 1, 'b': 1}" }), s, 'python')?.misconceptionId, 'split-space', 'dict order does not matter');
    assert.equal(signatureMatch(r('s2', false, { error: "KeyError: 'b'" }), s)?.misconceptionId, 'missing-key');
    assert.equal(signatureMatch({ id: 's2', pass: false, status: 'ok', error: 'boom', exception: 'KeyError' } as SpecResult, s)?.misconceptionId, 'missing-key');
    assert.equal(signatureMatch(r('s2', false, { actual: "{'a': 2}" }), s, 'python'), undefined);
    assert.equal(signatureMatch(r('s2', true, { actual: "{'': 1, 'a': 1, 'b': 1}" }), s), undefined, 'a passing spec matches nothing');
    assert.equal(signatureMatch(r('s2', false, { status: 'timeout' }), s), undefined);
    const js = spec('j', "split('a  b')", '["a","b"]', { failureSignatures: [{ match: 'equals', value: '["a","","b"]', misconceptionId: 'empty', nudge: '?' }] });
    assert.equal(signatureMatch(r('j', false, { actual: "[ 'a', '', 'b' ]" }), js, 'javascript')?.misconceptionId, 'empty', 'util.inspect output vs JSON');
  });
});

// =====================================================================================
// Verification plan: reference and stub variants
// =====================================================================================

describe('buildVerificationPlan', () => {
  const ladder = (reference: string, specs: SpecItem[] = [spec('s1', "count_words('a')", "{'a': 1}")]): SpecLadderDraft => ({
    applicable: true, reason: '', specs, hidden: [spec('h1', "count_words('b b')", "{'b': 2}")], reference,
  });
  const PY_REF = [
    'import re',
    'WORD = re.compile(r"\\w+")',
    '',
    'def _norm(w):',
    '    return w.lower()',
    '',
    'def count_words(text):',
    '    out = {}',
    '    for w in WORD.findall(text):',
    '        out[_norm(w)] = out.get(_norm(w), 0) + 1',
    '    return out',
    '',
    "if __name__ == '__main__':",
    "    print(count_words('reference main'))",
  ].join('\n');

  test('no learner file: the reference is the file; the stub raises NotImplementedError', () => {
    const plan = buildVerificationPlan(ladder(PY_REF), PY_IFACE, { lang: 'python' });
    assert.equal(plan.file, 'wc.py');
    assert.deepEqual(plan.ids, ['s1', 'h1']);
    assert.deepEqual(plan.hiddenIds, ['h1']);
    assert.equal(plan.referenceSource.trim(), PY_REF.trim());
    assert.match(plan.stubSource, /^def count_words\(\*args, \*\*kwargs\):\n    raise NotImplementedError\('count_words'\)\n$/);
    assert.equal(plan.input.specs.length, 2);
    assert.equal(plan.input.timeoutMs, 5000);
    assert.deepEqual(plan.input.functions, ['count_words']);
  });

  test("Python: the learner's function range is replaced, helpers appended, the learner's other code kept", () => {
    const learner = [
      'import sys', // 0
      '', // 1
      'def count_words(text):', // 2
      '    return {}  # TODO', // 3
      '', // 4
      'def _norm(w):', // 5
      '    return w', // 6
      '', // 7
      'def other():', // 8
      '    return 42', // 9
    ].join('\n');
    const plan = buildVerificationPlan(ladder(PY_REF), PY_IFACE, { lang: 'python', learnerSource: learner });
    const ref = plan.referenceSource;
    assert.doesNotMatch(ref, /TODO/, 'the learner body is gone');
    assert.match(ref, /^import sys\n\ndef count_words\(text\):\n    out = \{\}/, 'the reference sits where the learner had it');
    assert.match(ref, /def other\(\):\n    return 42/);
    assert.equal(ref.match(/def _norm/g)?.length, 1, 'a same-named helper replaces the learner one');
    assert.match(ref, /    return w\.lower\(\)/);
    assert.match(ref, /import re\n/);
    assert.match(ref, /WORD = re\.compile/);
    assert.doesNotMatch(ref, /reference main/, "the reference's main block is not copied");
    assert.match(plan.stubSource, /^import sys\n\ndef count_words\(\*args, \*\*kwargs\):\n    raise NotImplementedError\('count_words'\)\n\ndef _norm\(w\):\n    return w\n/);
    assert.match(plan.stubOnlySource, /^def count_words\(\*args, \*\*kwargs\)/);
    assert.equal(plan.referenceOnlySource.trim(), PY_REF.trim());
  });

  test('DocumentSymbol ranges win over the regex fallback', () => {
    const learner = 'def count_words(text):\n    return 1\n\n\nx = [\n    1,\n]\n';
    // pretend the symbol provider says the function ends on line 1 (0-based)
    const plan = buildVerificationPlan(ladder(PY_REF), PY_IFACE, { lang: 'python', learnerSource: learner, functionRanges: [{ name: 'count_words', startLine: 0, endLine: 1 }] });
    assert.match(plan.stubSource, /^def count_words\(\*args, \*\*kwargs\):\n    raise NotImplementedError\('count_words'\)\n\n\nx = \[\n    1,\n\]\n$/);
  });

  test('JS (ESM): inserted functions lose `export`, each interface function is exported exactly once', () => {
    const iface: TaskInterface = { file: 'cli.mjs', functions: [{ name: 'parseArgs', signature: 'parseArgs(argv)', purpose: '' }] };
    const learner = "import fs from 'node:fs';\n\nexport function parseArgs(argv) {\n  return null; // TODO\n}\n\nfunction keep() { return fs; }\n";
    const ref = "import fs from 'node:fs';\nimport path from 'node:path';\nconst FLAGS = new Set(['-v']);\n\nexport function parseArgs(argv) {\n  return { verbose: argv.some((a) => FLAGS.has(a)) };\n}\n\nexport { parseArgs as default };\n";
    const plan = buildVerificationPlan({ ...ladder(ref), specs: [spec('s1', "parseArgs(['-v'])", '{"verbose":true}')], hidden: [] }, iface, { lang: 'javascript', learnerSource: learner, moduleKind: 'esm' });
    const src = plan.referenceSource;
    assert.doesNotMatch(src, /TODO/);
    assert.equal(src.match(/import fs from 'node:fs';/g)?.length, 1, 'a duplicate import binding would be a SyntaxError');
    assert.match(src, /import path from 'node:path';/);
    assert.match(src, /const FLAGS = new Set/);
    assert.match(src, /function keep\(\)/);
    assert.equal(src.match(/export \{ parseArgs \};/g)?.length, 1);
    assert.doesNotMatch(src, /export function parseArgs/);
    assert.doesNotMatch(src, /as default/, "the reference's own export lists are not copied");
    assert.match(plan.stubSource, /function parseArgs\(\.\.\.args\) \{\n  throw new Error\('not implemented: parseArgs'\);\n\}/);
    assert.match(plan.stubSource, /export \{ parseArgs \};/);
  });

  test('JS (CommonJS): module.exports already lists the function, so nothing is added; TS stubs are typed', () => {
    const iface: TaskInterface = { file: 'total.js', functions: [{ name: 'total', signature: 'total(xs)', purpose: '' }] };
    const learner = "'use strict';\nfunction total(xs) {\n  return 0;\n}\nmodule.exports = { total };\n";
    const ref = 'export function total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n';
    const plan = buildVerificationPlan({ ...ladder(ref), specs: [spec('s1', 'total([1])', '1')], hidden: [] }, iface, { lang: 'javascript', learnerSource: learner, moduleKind: 'cjs' });
    assert.match(plan.referenceSource, /^'use strict';\nfunction total\(xs\) \{\n  return xs\.reduce/);
    assert.equal(plan.referenceSource.match(/module\.exports/g)?.length, 1);
    assert.match(plan.referenceOnlySource, /^function total\(xs\)[\s\S]*module\.exports\.total = total;\n$/, 'no learner file: CommonJS exports for the reference');
    const ts = buildVerificationPlan({ ...ladder(ref), specs: [spec('s1', 'total([1])', '1')], hidden: [] }, { ...iface, file: 'total.ts' }, { lang: 'typescript', moduleKind: 'esm' });
    assert.match(ts.stubSource, /function total\(\.\.\.args: any\[\]\): any \{/);
  });

  test('moduleKindFor: extension, then package type, then the file style', () => {
    assert.equal(moduleKindFor('a.mjs', 'commonjs', undefined), 'esm');
    assert.equal(moduleKindFor('a.cts', 'module', undefined), 'cjs');
    assert.equal(moduleKindFor('a.js', 'module', 'module.exports = {}'), 'esm');
    assert.equal(moduleKindFor('a.js', undefined, "const x = require('x');\nmodule.exports = { x };"), 'cjs');
    assert.equal(moduleKindFor('a.js', undefined, 'export const x = 1;'), 'esm');
    assert.equal(moduleKindFor('a.ts', undefined, undefined), 'esm');
  });
});

// =====================================================================================
// verifySpecLadder with a fake runner and a real temp workspace
// =====================================================================================

type Variant = 'reference' | 'stub' | 'other';
interface FakeRun {
  variant: Variant;
  ids: string[];
  copyFiles: string[];
  readDirs: string[];
  workspaceDir: string;
}

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dlb-specs-test-'));
after(() => fs.rmSync(tmpBase, { recursive: true, force: true }));

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) out.push(path.relative(base, p) + '@');
    else if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p));
  }
  return out.sort();
}

/**
 * A Runner whose harness answers from a table: the variant is recognised from the module text
 * (REFERENCE marker / NotImplementedError / Error('not implemented')).
 */
function fakeRunner(lang: 'python' | 'javascript', behave: (variant: Variant, id: string) => Partial<SpecResult> | 'crash', runs: FakeRun[]): Runner {
  const runtime: Runtime = { lang, exe: 'fake', snippetArgv: [], learnerArgv: [], version: '0' };
  return {
    runtime,
    runBatch: async (_items: BatchItem[]): Promise<BatchRecord[]> => [],
    runLearnerCode: async (script: string, args: string[], opts: LearnerRunOptions): Promise<RunResult> => {
      assert.equal(path.basename(script), lang === 'python' ? 'harness.py' : 'harness.mjs');
      const [moduleFile, specFile] = args;
      const src = fs.readFileSync(moduleFile, 'utf8');
      const input = JSON.parse(fs.readFileSync(specFile, 'utf8')) as HarnessInput;
      const variant: Variant = /REFERENCE/.test(src) ? 'reference' : /NotImplementedError|not implemented/.test(src) ? 'stub' : 'other';
      runs.push({ variant, ids: input.specs.map((s) => s.id), copyFiles: listFiles(opts.workspaceDir), readDirs: opts.readDirs ?? [], workspaceDir: opts.workspaceDir });
      assert.equal(input.workspace, opts.workspaceDir, 'the harness sees the copy as its workspace');
      const lines = [`@@DLB_PLAN ${JSON.stringify(input.specs.map((s) => s.id))}`, '@@DLB_LOAD {"importMs": 3}'];
      for (const s of input.specs) {
        lines.push(`@@DLB_START ${s.id}`);
        const b = behave(variant, s.id);
        if (b === 'crash') return { stdout: lines.join('\n'), stderr: 'Segmentation fault', exitCode: 139, timedOut: false, ms: 5 };
        if (b.status === 'timeout') return { stdout: lines.join('\n'), stderr: '', exitCode: null, timedOut: true, ms: 5000 };
        lines.push(`@@DLB ${JSON.stringify({ id: s.id, pass: false, status: 'ok', ...b })}`);
      }
      lines.push('@@DLB_END {}');
      return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0, timedOut: false, ms: 20 };
    },
  };
}

/** Normal behaviour: every spec passes on the reference and fails cleanly on the stub. */
const normal = (variant: Variant): Partial<SpecResult> =>
  variant === 'reference' ? { pass: true, actual: 'x' } : { pass: false, error: 'NotImplementedError: count_words', exception: 'NotImplementedError' } as Partial<SpecResult>;

function makeWorkspace(name: string, files: Record<string, string>): string {
  const ws = path.join(tmpBase, name);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), text);
  }
  return ws;
}

const PY_REFERENCE = 'def count_words(text):\n    return {}  # REFERENCE\n';

function pyLadder(n: number, hidden = 2): SpecLadderDraft {
  return {
    applicable: true,
    reason: '',
    specs: Array.from({ length: n }, (_, i) => spec(`s${i + 1}`, `count_words('${'a '.repeat(i + 1)}')`, `{'a': ${i + 1}}`)),
    hidden: Array.from({ length: hidden }, (_, i) => spec(`h${i + 1}`, `count_words('${'b '.repeat(i + 1)}')`, `{'b': ${i + 1}}`)),
    reference: PY_REFERENCE,
  };
}

describe('verifySpecLadder (fake runner)', () => {
  test('drops specs failing on the reference or passing on the stub; keeps order; deletes temp dirs; never returns the reference', async () => {
    const ws = makeWorkspace('ws-py', {
      'wc.py': 'def count_words(text):\n    return None\n',
      'util/helpers.py': 'X = 1\n',
      'notes.txt': 'not source',
      '.venv/lib/site.py': 'skip me',
      '__pycache__/wc.cpython.pyc': 'skip',
      'build/out.py': 'skip',
    });
    const tmpRoot = path.join(tmpBase, 'verify-1');
    const runs: FakeRun[] = [];
    const ladder = pyLadder(5);
    ladder.specs.push(spec('bad', 'count_words(text)', '{}')); // a variable: dropped before any run
    const behave = (v: Variant, id: string) => {
      if (id === 's3' && v === 'reference') return { pass: false, actual: "{'a': 2}" };
      if (id === 'h2' && v === 'stub') return { pass: true, error: 'NotImplementedError: count_words' };
      return normal(v);
    };
    const res = await verifySpecLadder(ladder, PY_IFACE, { runner: fakeRunner('python', behave, runs), workspaceDir: ws, harnessDir: '/harness', tmpRoot });
    assert.equal(res.verified, true);
    assert.equal(res.applicable, true);
    assert.deepEqual(res.specs.map((s) => s.id), ['s1', 's2', 's4', 's5']);
    assert.deepEqual(res.hidden.map((s) => s.id), ['h1']);
    const why = Object.fromEntries(res.dropped.map((d) => [d.id, d.reason]));
    assert.match(why.bad, /not a literal/);
    assert.match(why.s3, /fails on the reference \(actual: \{'a': 2\}\)/);
    assert.match(why.h2, /passes on an empty stub/);
    assert.deepEqual(runs.map((r) => r.variant), ['reference', 'stub']);
    assert.deepEqual(runs[0].ids, ['s1', 's2', 's3', 's4', 's5', 'h1', 'h2'], 'visible and hidden specs run together');
    assert.deepEqual(runs[0].copyFiles, ['util/helpers.py', 'wc.py'].map((p) => p.split('/').join(path.sep)), 'source globs only, excluded dirs skipped');
    assert.deepEqual(fs.readdirSync(tmpRoot), [], 'temp dirs deleted at once');
    assert.doesNotMatch(JSON.stringify(res), /REFERENCE/, 'the reference never leaves verification');
    assert.equal(res.importMs, 3);
    assert.equal(fs.readFileSync(path.join(ws, 'wc.py'), 'utf8'), 'def count_words(text):\n    return None\n', 'the workspace is never written');
  });

  test('a stub that times out or crashes does not fail cleanly', async () => {
    const ws = makeWorkspace('ws-py2', {});
    const runs: FakeRun[] = [];
    const behave = (v: Variant, id: string) => (v === 'stub' && id === 's4' ? { status: 'timeout' as const } : normal(v));
    const res = await verifySpecLadder(pyLadder(5, 0), PY_IFACE, { runner: fakeRunner('python', behave, runs), workspaceDir: ws, harnessDir: '/h', tmpRoot: path.join(tmpBase, 'verify-2') });
    assert.deepEqual(res.specs.map((s) => s.id), ['s1', 's2', 's3'], 's4 timed out on the stub; s5 never ran');
    const why = Object.fromEntries(res.dropped.map((d) => [d.id, d.reason]));
    assert.match(why.s4, /does not fail cleanly on a stub \(timeout\)/);
    assert.match(why.s5, /does not fail cleanly/);
    // A crash on the stub: the spec that was running and every spec after it are not clean.
    const withFile = makeWorkspace('ws-py2b', { 'wc.py': 'def count_words(text):\n    return 0\n\nprint("top")\n' });
    const crashRuns: FakeRun[] = [];
    const crashing = (v: Variant, id: string) => (v === 'stub' && id === 's2' ? 'crash' as const : normal(v));
    const res2 = await verifySpecLadder(pyLadder(5, 0), PY_IFACE, { runner: fakeRunner('python', crashing, crashRuns), workspaceDir: withFile, harnessDir: '/h', tmpRoot: path.join(tmpBase, 'verify-2b') });
    assert.equal(res2.applicable, false);
    assert.deepEqual(res2.specs.map((s) => s.id), ['s1']);
    assert.match(Object.fromEntries(res2.dropped.map((d) => [d.id, d.reason])).s2, /does not fail cleanly on a stub/);
    assert.deepEqual(crashRuns.map((r) => r.variant), ['reference', 'stub', 'stub'], "after a crash the stub is retried without the learner's other code");
    assert.match(res2.reason ?? '', /only 1 specs survived/);
  });

  test('one repair call: a fixed spec keeps its place; specs that still fail are dropped', async () => {
    const ws = makeWorkspace('ws-py3', { 'wc.py': '' });
    const runs: FakeRun[] = [];
    let fixedOnce = false;
    const behave = (v: Variant, id: string) => {
      if (v === 'reference' && (id === 's2' || id === 's4') && !fixedOnce) return { pass: false, actual: '{}' };
      if (v === 'reference' && id === 's4') return { pass: false, actual: '{}' };
      return normal(v);
    };
    const asked: string[][] = [];
    const res = await verifySpecLadder(pyLadder(4, 0), PY_IFACE, {
      runner: fakeRunner('python', behave, runs),
      workspaceDir: ws,
      harnessDir: '/h',
      tmpRoot: path.join(tmpBase, 'verify-3'),
      repair: async (failures) => {
        asked.push(failures.map((f) => `${f.id}:${f.reason}:${f.actual}`));
        fixedOnce = true;
        return {
          applicable: true,
          reason: '',
          specs: [spec('s2', "count_words('z')", "{'z': 1}"), spec('s4', "count_words('q')", "{'q': 1}"), spec('new', "count_words('n')", "{'n': 1}")],
          hidden: [],
          reference: '',
        };
      },
    });
    assert.deepEqual(asked, [['s2:fails on the reference:{}', 's4:fails on the reference:{}']]);
    assert.equal(res.repaired, true);
    assert.deepEqual(res.specs.map((s) => [s.id, s.call]), [['s1', "count_words('a ')"], ['s2', "count_words('z')"], ['s3', "count_words('a a a ')"]]);
    assert.deepEqual(res.dropped.map((d) => d.id), ['s4']);
    assert.deepEqual(runs.map((r) => [r.variant, r.ids.join(',')]), [
      ['reference', 's1,s2,s3,s4'], ['stub', 's1,s2,s3,s4'], ['reference', 's2,s4'], ['stub', 's2,s4'],
    ]);
  });

  test('fewer than 3 specs left: not applicable', async () => {
    const ws = makeWorkspace('ws-py4', {});
    const runs: FakeRun[] = [];
    const behave = (v: Variant, id: string) => (v === 'reference' && id !== 's1' && id !== 's2' ? { pass: false } : normal(v));
    const res = await verifySpecLadder(pyLadder(4, 0), PY_IFACE, { runner: fakeRunner('python', behave, runs), workspaceDir: ws, harnessDir: '/h', tmpRoot: path.join(tmpBase, 'verify-4') });
    assert.equal(res.applicable, false);
    assert.equal(res.verified, true);
    assert.deepEqual(res.specs.map((s) => s.id), ['s1', 's2']);
    const tooFew = await verifySpecLadder({ ...pyLadder(2, 0) }, PY_IFACE, { runner: fakeRunner('python', normal, []), workspaceDir: ws, harnessDir: '/h', tmpRoot: path.join(tmpBase, 'verify-4b') });
    assert.equal(tooFew.applicable, false);
    assert.equal(tooFew.verified, false, 'nothing runs when validation already leaves too few');
    const notApplicable = await verifySpecLadder({ ...pyLadder(3), applicable: false, reason: 'needs a server' }, PY_IFACE, { runner: fakeRunner('python', normal, []), workspaceDir: ws, harnessDir: '/h', tmpRoot: path.join(tmpBase, 'verify-4c') });
    assert.deepEqual([notApplicable.applicable, notApplicable.reason], [false, 'needs a server']);
    const escape = await verifySpecLadder(pyLadder(3), { ...PY_IFACE, file: '../outside.py' }, { runner: fakeRunner('python', normal, []), workspaceDir: ws, harnessDir: '/h', tmpRoot: path.join(tmpBase, 'verify-4d') });
    assert.match(escape.reason ?? '', /outside the workspace/);
  });

  test('JS: node_modules is linked into the copy (readable), never copied, and survives cleanup; caps at 300 files', async () => {
    const files: Record<string, string> = { 'src/cli.mjs': 'export function parseArgs(argv) { return {}; }\n', 'package.json': '{"type": "module"}', 'node_modules/dep/index.js': 'module.exports = 1;', '.git/HEAD': 'ref' };
    for (let i = 0; i < 305; i++) files[`gen/f${String(i).padStart(3, '0')}.js`] = 'export const x = 1;\n';
    const ws = makeWorkspace('ws-js', files);
    const runs: FakeRun[] = [];
    const iface: TaskInterface = { file: 'src/cli.mjs', functions: [{ name: 'parseArgs', signature: 'parseArgs(argv)', purpose: '' }] };
    const ladder: SpecLadderDraft = {
      applicable: true,
      reason: '',
      specs: ["parseArgs([])", "parseArgs(['-v'])", "parseArgs(['a', 'b'])"].map((c, i) => spec(`s${i}`, c, '{}')),
      hidden: [],
      reference: 'export function parseArgs(argv) { return {}; } // REFERENCE\n',
    };
    const tmpRoot = path.join(tmpBase, 'verify-js');
    const res = await verifySpecLadder(ladder, iface, { runner: fakeRunner('javascript', (v) => normal(v), runs), workspaceDir: ws, harnessDir: '/h', tmpRoot });
    assert.equal(res.applicable, true, JSON.stringify(res.dropped));
    const seen = runs[0].copyFiles;
    assert.ok(seen.includes('node_modules@'), 'node_modules is a link in the copy');
    assert.ok(!seen.some((f) => f.startsWith('node_modules' + path.sep)), 'its contents are not copied');
    assert.ok(!seen.some((f) => f.startsWith('.git')));
    assert.ok(seen.includes(path.join('src', 'cli.mjs')), 'the interface file is copied first');
    assert.ok(seen.includes('package.json'));
    assert.equal(seen.filter((f) => !f.endsWith('@')).length, 300, 'capped at 300 files');
    assert.ok(runs[0].readDirs.includes(path.join(ws, 'node_modules')), 'the real node_modules is readable under --permission');
    assert.equal(fs.readFileSync(path.join(ws, 'node_modules/dep/index.js'), 'utf8'), 'module.exports = 1;', 'cleanup never follows the link');
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
  });
});
