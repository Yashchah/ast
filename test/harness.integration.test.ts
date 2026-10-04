// Integration tests for media/harness (spec V1-11, V1-12) with the real interpreters, run the way
// LocalRunner.runLearnerCode runs them: Python through media/runner/prelude.py with the learner
// flags, Node with the permission flags, cwd a fresh temp dir. Skipped when Python or Node is missing.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { BatchRecord, LearnerRunOptions, RunResult, Runner, SpecItem, TaskInterface } from '../src/contracts';
import {
  buildHarnessInput, parseHarnessOutput, parseProbeOutput, signatureMatch, verifySpecLadder, type HarnessRun, type SpecLadderDraft,
} from '../src/specsCore';

const HARNESS_DIR = path.resolve(__dirname, '..', 'media', 'harness');
const RUNNER_DIR = path.resolve(__dirname, '..', 'media', 'runner');
const PY_FLAGS = ['-E', '-B', '-X', 'utf8'];

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dlb-harness-it-'));
after(() => fs.rmSync(tmpBase, { recursive: true, force: true }));

// ---------------------------------------------------------------- runtimes

function findPython(): string | undefined {
  for (const bin of [process.env.DELIBERATE_TEST_PYTHON, 'python', 'python3'].filter((b): b is string => !!b)) {
    const r = spawnSync(bin, ['-c', 'import sys; print(sys.executable); print(sys.version_info >= (3, 8))'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const [exe, ok] = (r.stdout ?? '').trim().split(/\r?\n/);
    if (r.status === 0 && ok === 'True' && exe && path.isAbsolute(exe)) return exe;
  }
  return undefined;
}

const PY = findPython();
const NODE = process.execPath;
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
const PERMISSION = NODE_MAJOR >= 24 || (NODE_MAJOR === 23 && NODE_MINOR >= 5) || (NODE_MAJOR === 22 && NODE_MINOR >= 13)
  ? '--permission'
  : NODE_MAJOR >= 20 ? '--experimental-permission' : undefined;
const TS_NATIVE = ['strip', 'transform'].includes(String((process.features as { typescript?: string }).typescript));

function env(cwd: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { PATH: process.env.PATH, TEMP: cwd, TMP: cwd, TMPDIR: cwd };
  for (const k of ['SYSTEMROOT', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) if (process.env[k]) e[k] = process.env[k];
  return e;
}

interface Run extends RunResult {
  cwdFiles: string[];
}

/** One learner-profile run in a fresh temp cwd (deleted afterwards). */
function run(lang: 'python' | 'node', script: string, args: string[], o: { timeoutMs?: number; stdin?: string; readDirs?: string[] } = {}): Run {
  const cwd = fs.mkdtempSync(path.join(tmpBase, 'run-'));
  try {
    const argv = lang === 'python'
      ? [...PY_FLAGS, path.join(RUNNER_DIR, 'prelude.py'), path.join(HARNESS_DIR, script), ...args]
      : [
        ...(PERMISSION ? [PERMISSION, ...[HARNESS_DIR, RUNNER_DIR, cwd, ...(o.readDirs ?? [])].map((d) => `--allow-fs-read=${d}`), `--allow-fs-write=${cwd}`] : []),
        path.join(HARNESS_DIR, script), ...args,
      ];
    const t0 = Date.now();
    const r = spawnSync(lang === 'python' ? PY! : NODE, argv, {
      cwd, env: env(cwd), encoding: 'utf8', input: o.stdin ?? '', timeout: o.timeoutMs ?? 15000, windowsHide: true, maxBuffer: 10_000_000,
    });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status, timedOut, ms: Date.now() - t0, cwdFiles: fs.readdirSync(cwd) };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

let wsCount = 0;
function workspace(files: Record<string, string>): string {
  const ws = path.join(tmpBase, `ws${wsCount++}`);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), text);
  }
  return ws;
}

const spec = (id: string, call: string, expected: string, extra: Partial<SpecItem> = {}): SpecItem => ({
  id, title: id, conceptId: 'c', call, expected, expectError: '', parSec: 30, failureSignatures: [], ...extra,
});

/** Write the spec JSON next to the workspace and run the harness on `file`. */
function harness(lang: 'python' | 'node', ws: string, file: string, specs: SpecItem[], o: { timeoutMs?: number; functions?: string[]; parentTimeoutMs?: number } = {}): { report: HarnessRun; raw: Run } {
  const specDir = fs.mkdtempSync(path.join(tmpBase, 'spec-'));
  const specFile = path.join(specDir, 'specs.json');
  fs.writeFileSync(specFile, JSON.stringify(buildHarnessInput(specs, { workspace: ws, timeoutMs: o.timeoutMs ?? 5000, functions: o.functions })));
  const raw = run(lang, lang === 'python' ? 'harness.py' : 'harness.mjs', [path.join(ws, file), specFile], {
    timeoutMs: o.parentTimeoutMs ?? (o.timeoutMs ?? 5000) + 2000,
    readDirs: [ws, specDir],
  });
  return { report: parseHarnessOutput(raw.stdout, raw.stderr, raw.timedOut, { ids: specs.map((s) => s.id) }), raw };
}

const TOP_LEVEL_NUDGE = "top-level code runs on import: move it under if __name__ == '__main__'";
const UNSAFE_NUDGE = 'wrap the entry code in a main guard (if (require.main === module) or, on Node 24.2+, if (import.meta.main))';

// =====================================================================================
// Python
// =====================================================================================

describe('harness.py', () => {
  test('imports a module with Counter() at top level and input() under a main guard', (t) => {
    if (!PY) return t.skip('no python found');
    const ws = workspace({
      'wc.py': [
        'import re',
        'from collections import Counter',
        'WORD = re.compile(r"[a-z\']+")',
        'counts = Counter()',
        '',
        'def count_words(text):',
        '    return dict(Counter(WORD.findall(text.lower())))',
        '',
        "if __name__ == '__main__':",
        "    print(count_words(input('text? ')))",
        '',
      ].join('\n'),
    });
    const sigs = [{ match: 'equals' as const, value: "{'x': 1, 'y': 1}", misconceptionId: 'all-words', nudge: 'Which words does the spec count?' }];
    const specs = [
      spec('s1', "count_words('a b a')", "{'a': 2, 'b': 1}"),
      spec('s2', "count_words('')", '{}'),
      spec('s3', "count_words(text='A')", "{'a': 1}"),
      spec('s4', "count_words('x y')", "{'x': 1}", { failureSignatures: sigs }),
      spec('s5', 'count_words(None)', '', { expectError: 'AttributeError' }),
    ];
    const { report, raw } = harness('python', ws, 'wc.py', specs);
    assert.equal(report.loadError, undefined, raw.stderr);
    assert.equal(report.finished, true);
    assert.equal(typeof report.importMs, 'number');
    assert.deepEqual(report.results.map((r) => [r.id, r.pass]), [['s1', true], ['s2', true], ['s3', true], ['s4', false], ['s5', true]]);
    assert.equal(report.results[3].actual, "{'x': 1, 'y': 1}");
    assert.equal(signatureMatch(report.results[3], specs[3], 'python')?.misconceptionId, 'all-words');
    assert.equal(report.results[4].exception, 'AttributeError');
    assert.ok(!fs.existsSync(path.join(ws, '__pycache__')), 'no bytecode written into the workspace');
  });

  test('a top-level input() gives the top-level nudge; so do sys.argv[1] and sys.exit()', (t) => {
    if (!PY) return t.skip('no python found');
    const cases: [string, string][] = [
      ["def f(x):\n    return x\n\nname = input('who? ')\n", 'input()'],
      ['import sys\n\ndef f(x):\n    return x\n\nn = int(sys.argv[1])\n', 'sys.argv'],
      ['import argparse\np = argparse.ArgumentParser()\np.add_argument("n")\nargs = p.parse_args()\n\ndef f(x):\n    return x\n', 'sys.argv'],
      ["def f(x):\n    return x\n\ntry:\n    name = input()\nexcept BaseException:\n    name = 'swallowed'\n", 'input()'],
      ["import sys\n\ndef f(x):\n    return x\n\nif len(sys.argv) < 2:\n    sys.exit('usage: app.py N')\n", 'SystemExit'],
    ];
    for (const [src, name] of cases) {
      const ws = workspace({ 'app.py': src });
      const { report } = harness('python', ws, 'app.py', [spec('s1', 'f(1)', '1')]);
      assert.equal(report.loadError?.kind, 'top-level', src);
      assert.equal(report.loadError?.message, TOP_LEVEL_NUDGE);
      assert.equal(report.loadError?.name, name, src);
      assert.equal(report.results[0].status, 'not-run');
    }
    const ws = workspace({ 'app.py': 'def f(x):\n    return x\n\nname = input()\n' });
    assert.equal(harness('python', ws, 'app.py', [spec('s1', 'f(1)', '1')]).report.loadError?.line, 4);
  });

  test('a file write during a spec is blocked by the audit hook and nothing appears in the fixture workspace', (t) => {
    if (!PY) return t.skip('no python found');
    const ws = workspace({
      'todo.py': [
        'import os',
        '',
        'def save(name):',
        '    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)',
        "    with open(path, 'w') as f:",
        "        f.write('x')",
        "    return 'saved'",
        '',
        'def save_here(name):',
        "    with open(name, 'w') as f:  # relative: the run's temp dir",
        "        f.write('x')",
        "    return 'saved'",
        '',
        'def wipe(name):',
        '    os.remove(os.path.join(os.path.dirname(os.path.abspath(__file__)), name))',
        "    return 'gone'",
        '',
      ].join('\n'),
    });
    const before = fs.readdirSync(ws).sort();
    const { report } = harness('python', ws, 'todo.py', [
      spec('s1', "save('todos.json')", "'saved'"),
      spec('s2', "save_here('todos.json')", "'saved'"),
      spec('s3', "wipe('todo.py')", "'gone'"),
    ]);
    assert.equal(report.results[0].pass, false);
    assert.equal(report.results[0].exception, 'DeliberateSandbox');
    assert.match(report.results[0].error ?? '', /keep that in the main block/);
    assert.equal(report.results[1].pass, true, 'writes inside the run temp dir are allowed');
    assert.equal(report.results[2].exception, 'DeliberateSandbox');
    assert.deepEqual(fs.readdirSync(ws).sort(), before, 'nothing written or deleted in the workspace');
  });

  test('an infinite loop: the running spec times out and the rest are not run (own watchdog, then the parent kill)', (t) => {
    if (!PY) return t.skip('no python found');
    const ws = workspace({
      'loop.py': [
        'import time',
        'def spin(n):',
        '    while True:',
        '        n += 1',
        'def nap(n):',
        '    time.sleep(30)',
        'def stubborn(n):',
        '    while True:',
        '        try:',
        '            while True:',
        '                pass',
        '        except KeyboardInterrupt:',
        '            pass',
        'def ok(n):',
        '    return n',
      ].join('\n'),
    });
    const own = harness('python', ws, 'loop.py', [spec('a', 'ok(1)', '1'), spec('b', 'spin(1)', '1'), spec('c', 'ok(2)', '2')], { timeoutMs: 1500 });
    assert.equal(own.raw.timedOut, false, 'the harness stopped itself before the parent timeout');
    assert.deepEqual(own.report.results.map((r) => r.status), ['ok', 'timeout', 'not-run']);
    assert.equal(own.report.results[1].error, 'timeout (infinite loop?)');
    assert.equal(own.report.timedOut, true);
    const sleepy = harness('python', ws, 'loop.py', [spec('a', 'nap(1)', '1')], { timeoutMs: 1500 });
    assert.equal(sleepy.raw.timedOut, false, 'time.sleep() is interrupted too');
    assert.equal(sleepy.report.results[0].status, 'timeout');
    const killed = harness('python', ws, 'loop.py', [spec('a', 'ok(1)', '1'), spec('b', 'stubborn(1)', '1'), spec('c', 'ok(2)', '2')], { timeoutMs: 1500, parentTimeoutMs: 2500 });
    assert.equal(killed.raw.timedOut, true, 'swallowed interrupts leave it to the parent');
    assert.deepEqual(killed.report.results.map((r) => r.status), ['ok', 'timeout', 'not-run']);
    assert.equal(killed.report.results[0].pass, true);
  });

  test('a module that hangs at top level is reported as top-level code', (t) => {
    if (!PY) return t.skip('no python found');
    const ws = workspace({ 'hang.py': 'def f(x):\n    return x\n\nwhile True:\n    pass\n' });
    const { report, raw } = harness('python', ws, 'hang.py', [spec('a', 'f(1)', '1')], { timeoutMs: 1500 });
    assert.equal(raw.timedOut, false);
    assert.deepEqual([report.loadError?.kind, report.loadError?.name, report.loadError?.line], ['top-level', 'timeout', 5]);
  });
});

describe('probe.py', () => {
  test('typed values, exception names, the editor text from stdin, and unsafe modules', (t) => {
    if (!PY) return t.skip('no python found');
    const ws = workspace({ 'row.py': "def parse_row(line):\n    return line.split(',')\n\ndef first(xs):\n    return xs[0]\n\ndef pair():\n    return (1, 2.0)\n" });
    const file = path.join(ws, 'row.py');
    const probe = (call: string, o: { stdin?: string } = {}) => parseProbeOutput(...((r) => [r.stdout, r.stderr, r.timedOut] as const)(run('python', 'probe.py', [file, call, ...(o.stdin !== undefined ? ['--stdin'] : [])], { stdin: o.stdin })));
    const v = probe("parse_row('a,,b')");
    assert.equal(v.ok, true);
    assert.equal(v.type, 'list');
    assert.equal(v.repr, "['a', '', 'b']");
    assert.deepEqual(v.val, { t: 'list', v: [{ t: 'str', v: 'a' }, { t: 'str', v: '' }, { t: 'str', v: 'b' }] });
    assert.deepEqual(probe('pair()').val, { t: 'tuple', v: [{ t: 'int', v: '1' }, { t: 'float', v: 2 }] }, 'int and float stay distinct');
    const e = probe('first([])');
    assert.deepEqual([e.ok, e.exception, e.line], [false, 'IndexError', 5]);
    const mutant = probe("parse_row('a,,b')", { stdin: "def parse_row(line):\n    return [x for x in line.split(',') if x]\n" });
    assert.equal(mutant.repr, "['a', 'b']", 'the source from stdin, not the file');
    assert.equal(probe("first(open('x'))").error?.startsWith('BadCall'), true, 'calls are literal-only');
    const unsafe = probe('f(1)', { stdin: 'x = input()\ndef f(a):\n    return a\n' });
    assert.equal(unsafe.loadError?.kind, 'top-level');
    assert.equal(probe('nope(1)').exception, 'NameError');
  });
});

// =====================================================================================
// Node
// =====================================================================================

describe('harness.mjs', () => {
  test('ESM exports pass; a defined-but-unexported function gets the export nudge while the others still run', () => {
    const ws = workspace({
      'cli.mjs': [
        "import { basename } from 'node:path';",
        "const FLAGS = new Set(['-v', '--verbose']);",
        'export function parseArgs(argv) {',
        '  const out = { verbose: false, files: [] };',
        '  for (const a of argv) {',
        '    if (FLAGS.has(a)) out.verbose = true;',
        '    else out.files.push(basename(a));',
        '  }',
        '  return out;',
        '}',
        'export async function later(x) { await null; return x * 2; }',
        "export function boom() { throw new RangeError('too big'); }",
        'function helper(s) { return s.trim(); }',
        'if (import.meta.main) {',
        '  console.log(parseArgs(process.argv.slice(2)));',
        '}',
        '',
      ].join('\n'),
    });
    const { report, raw } = harness('node', ws, 'cli.mjs', [
      spec('s1', "parseArgs(['-v', 'a/b.txt'])", '{"verbose": true, "files": ["b.txt"]}'),
      spec('s2', 'parseArgs([])', '{"verbose": false, "files": []}'),
      spec('s3', 'later(21)', '42'),
      spec('s4', 'boom()', '', { expectError: 'RangeError' }),
      spec('s5', "helper(' x ')", '"x"'),
      spec('s6', "parseArgs(['-v'])", '{"verbose": false, "files": []}'),
    ], { functions: ['parseArgs', 'later', 'boom', 'helper'] });
    assert.equal(report.loadError?.kind, 'not-exported', raw.stderr);
    assert.equal(report.loadError?.message, 'helper is defined but not exported: add export');
    assert.equal(report.loadError?.name, 'helper');
    assert.deepEqual(report.results.map((r) => [r.id, r.pass]), [['s1', true], ['s2', true], ['s3', true], ['s4', true], ['s5', false], ['s6', false]]);
    assert.match(report.results[4].error ?? '', /not exported/);
    assert.equal(report.results[5].actual, "{ verbose: true, files: [] }");
    assert.equal(report.finished, true);
  });

  test('CommonJS modules load (require fallback included) and get the module.exports nudge', () => {
    const ws = workspace({
      'total.js': "'use strict';\nconst path = require('path');\nfunction total(xs) { return xs.reduce((a, b) => a + b, 0); }\nfunction avg(xs) { return total(xs) / xs.length; }\nmodule.exports = { total };\nif (require.main === module) console.log(total([1]));\n",
    });
    const { report } = harness('node', ws, 'total.js', [spec('s1', 'total([1, 2, 3])', '6'), spec('s2', 'avg([2, 4])', '3')], { functions: ['total', 'avg'] });
    assert.equal(report.loadError?.message, 'avg is defined but not exported: add it to module.exports');
    assert.deepEqual(report.results.map((r) => r.pass), [true, false]);
  });

  test('an unsafe top level is never imported', () => {
    const ws = workspace({
      'app.mjs': 'export function f(x) { return x; }\nmain();\nfunction main() { process.exit(5); }\n',
      'safe.mjs': "import { run } from './server.mjs';\nexport function g(x) { return x; }\n",
      'server.mjs': 'export function run() {}\nconst app = createServer();\napp.listen(3000);\n',
    });
    const a = harness('node', ws, 'app.mjs', [spec('s1', 'f(1)', '1')]);
    assert.equal(a.raw.exitCode, 0, 'main() never ran: it would have exited with 5');
    assert.equal(a.report.loadError?.kind, 'unsafe-top-level');
    assert.equal(a.report.loadError?.message, UNSAFE_NUDGE);
    assert.equal(a.report.loadError?.name, 'main();');
    assert.equal(a.report.loadError?.line, 2);
    assert.equal(a.report.results[0].status, 'not-run');
    const b = harness('node', ws, 'safe.mjs', [spec('s1', 'g(1)', '1')]);
    assert.equal(b.report.loadError?.kind, 'unsafe-top-level', 'a relative import runs its top level too');
    assert.equal(b.report.loadError?.file, 'server.mjs');
    assert.match(String((b.report.loadError as { why?: string }).why), /createServer\(\) runs on import/);
  });

  test('a synchronous infinite loop times out; the rest are not run', () => {
    const ws = workspace({ 'spin.mjs': 'export function spin() { for (;;) {} }\nexport function ok(x) { return x; }\n' });
    const { report, raw } = harness('node', ws, 'spin.mjs', [spec('a', 'ok(1)', '1'), spec('b', 'spin()', '1'), spec('c', 'ok(2)', '2')], { timeoutMs: 1500 });
    assert.equal(raw.timedOut, false, 'the vm timeout stopped it before the parent did');
    assert.deepEqual(report.results.map((r) => r.status), ['ok', 'timeout', 'not-run']);
    assert.equal(report.results[1].error, 'timeout (infinite loop?)');
  });

  test('a file write during a spec is blocked by the permission model', (t) => {
    if (!PERMISSION) return t.skip('this node has no permission model');
    const ws = workspace({ 'save.mjs': "import fs from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nexport function save() { fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'out.json'), '{}'); return 'saved'; }\n" });
    const { report } = harness('node', ws, 'save.mjs', [spec('s1', 'save()', '"saved"')]);
    assert.equal(report.results[0].exception, 'DeliberateSandbox');
    assert.ok(!fs.existsSync(path.join(ws, 'out.json')));
  });

  test("TypeScript: './util.js' resolves to util.ts", (t) => {
    if (!TS_NATIVE) return t.skip('this node cannot strip types');
    const ws = workspace({
      'util.ts': 'export const twice = (x: number): number => x * 2;\n',
      'calc.ts': "import { twice } from './util.js';\ninterface Opts { scale: number }\nconst cache: Map<string, number> = new Map<string, number>();\nexport function calc(x: number, o: Opts = { scale: 1 }): number {\n  return twice(x) * o.scale;\n}\n",
    });
    const { report, raw } = harness('node', ws, 'calc.ts', [spec('t1', 'calc(3)', '6'), spec('t2', 'calc(3, { scale: 10 })', '60')]);
    assert.equal(report.loadError, undefined, raw.stderr);
    assert.deepEqual(report.results.map((r) => r.pass), [true, true]);
  });
});

describe('probe.mjs', () => {
  test('typed values, exception names, unexported helpers and the editor text from stdin', () => {
    const ws = workspace({
      'lib.mjs': "export function counts(s) { const m = new Map(); for (const c of s) m.set(c, (m.get(c) ?? 0) + 1); return m; }\nfunction hidden(xs) { return xs[5].y; }\nexport const half = (n) => n / 2;\n",
    });
    const file = path.join(ws, 'lib.mjs');
    const probe = (call: string, stdin?: string) => {
      const r = run('node', 'probe.mjs', [file, call, ...(stdin !== undefined ? ['--stdin'] : [])], { stdin, readDirs: [ws] });
      return parseProbeOutput(r.stdout, r.stderr, r.timedOut);
    };
    const m = probe("counts('aba')");
    assert.equal(m.ok, true, m.error);
    assert.equal(m.type, 'Map');
    assert.deepEqual(m.val, { t: 'dict', v: [[{ t: 'str', v: 'a' }, { t: 'num', v: 2 }], [{ t: 'str', v: 'b' }, { t: 'num', v: 1 }]] });
    assert.deepEqual(probe('half(-0)').val, { t: 'num', v: '-0' });
    const e = probe('hidden([1])');
    assert.deepEqual([e.ok, e.exception], [false, 'TypeError'], 'an unexported helper can still be probed');
    assert.equal(e.line, 2);
    assert.equal(probe('half(4)', 'export const half = (n) => n * 2;\n').repr, '8', 'the source from stdin, not the file');
    assert.equal(probe('half(x)').error?.startsWith('BadCall'), true);
    assert.equal(probe('f()', 'export function f() {}\nf();\n').loadError?.kind, 'unsafe-top-level');
  });
});

// =====================================================================================
// harness.mjs internals: the top-level check and the literal call parser
// =====================================================================================

describe('harness.mjs checker and call parser', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const load = async (): Promise<any> => import(pathToFileURL(path.join(HARNESS_DIR, 'harness.mjs')).href);

  test('safe top levels', async () => {
    const { checkTopLevel } = await load();
    const safe = [
      "import fs from 'node:fs';\nimport { a, b as c } from './x.js'\nimport * as ns from 'y'\nimport 'side'\nexport function f(x) { return g(x) }\n",
      "'use strict';\nconst fs = require('fs');\nconst { join } = require('path')\nfunction parse(argv) { return main(argv) }\nmodule.exports = { parse };\n",
      'exports.parse = function (argv) { return argv.map((a) => a.trim()) };\nmodule.exports.other = (x) => x * 2\n',
      "const FLAGS = new Set(['-v'])\nconst RE = /[(]\\d+/g\nconst M = new Map([[1, 2]])\nconst T = Object.freeze({ a: 1 })\nconst S = Symbol('s')\nlet count = 0\nvar x = 1, y = 2\n",
      'export const add = (a, b = compute()) => a + b\nexport const obj = { m(x) { return run(x) }, get v() { return 1 }, arrow: (y) => go(y) }\n',
      'function main() { console.log(1) }\nif (require.main === module) {\n  main()\n}\n',
      'export function main() {}\nif (import.meta.main) main();\n',
      "import { fileURLToPath } from 'node:url';\nexport function f() {}\nif (process.argv[1] === fileURLToPath(import.meta.url)) f();\n",
      'class Stack {\n  items = [];\n  static EMPTY = Object.freeze([]);\n  #secret = compute();\n  push(x) { this.items.push(x); }\n  get size() { return this.items.length }\n}\nexport default Stack;\n',
      "if (typeof module !== 'undefined' && module.exports) {\n  module.exports = { a: 1 };\n}\n",
      'export enum Color { Red, Green }\ninterface P { x: number }\nconst cache: Map<string, number[]> = new Map<string, number[]>();\nexport const id = <T,>(x: T): T => x;\nlet h: (e: Event) => void = (e) => {};\n',
    ];
    for (const src of safe) assert.equal(checkTopLevel(src), undefined, src);
  });

  test('unsafe top levels, with the reason', async () => {
    const { checkTopLevel } = await load();
    const unsafe: [string, RegExp][] = [
      ["console.log('hi')", /console\.log\(\) runs/],
      ["const data = fs.readFileSync('x')", /fs\.readFileSync\(\) runs/],
      ['app.listen(3000)', /listen/],
      ['await fetch("x")', /await/],
      ['(function () { start() })()', /call runs/],
      ['const x = new Date()', /new Date/],
      ['class A { static { init() } }', /static block/],
      ['class A { static x = load() }', /load\(\) runs/],
      ['class A extends mixin(B) {}', /mixin\(\) runs/],
      ['const x = tag`hello`', /tagged template/],
      ['const x = `a ${run()} b`', /run\(\) runs/],
      ['if (require.main !== module) { boot() }', /boot\(\) runs/],
      ['if (require.main === module) { main() } else { boot() }', /boot\(\) runs/],
      ['const x = import("./y.js")', /dynamic import/],
      ['const v = list.map((x) => x * 2)', /list\.map\(\) runs/],
      ['export default run()', /run\(\) runs/],
      ['module.exports = build()', /build\(\) runs/],
      ['const a = 1\n(function () {})()', /call runs/],
      ['for (const a of process.argv) {}', /runs on import/],
      ['const { a = init() } = obj', /init\(\) runs/],
    ];
    for (const [src, why] of unsafe) {
      const r = checkTopLevel(src);
      assert.ok(r, src);
      assert.match(r.why, why, src);
    }
  });

  test('parseCall reads literals only', async () => {
    const { parseCall } = await load();
    const r = parseCall("f([1, -2.5, 'a\\n'], { b: true, 'c-d': null, 3: undefined }, -0, 10n, NaN, `t`);");
    assert.equal(r.callee, 'f');
    assert.deepEqual(r.args.slice(0, 2), [[1, -2.5, 'a\n'], { b: true, 'c-d': null, 3: undefined }]);
    assert.ok(Object.is(r.args[2], -0));
    assert.equal(r.args[3], 10n);
    assert.ok(Number.isNaN(r.args[4]));
    assert.equal(r.args[5], 't');
    for (const bad of ['f(x)', 'f(g())', 'f(1); g(2)', 'a.b(1)', 'f(`${x}`)', 'f({ __proto__: 1 })', 'f(...[1])', 'new f()', 'f(1) + 1', 'f({ a })']) {
      assert.throws(() => parseCall(bad), SyntaxError, bad);
    }
  });
});

// =====================================================================================
// verifySpecLadder end to end with the real harness
// =====================================================================================

/** A Runner whose runLearnerCode is the learner-code profile above. */
function realRunner(lang: 'python' | 'javascript'): Runner {
  return {
    runtime: { lang, exe: lang === 'python' ? PY! : NODE, snippetArgv: [], learnerArgv: [], version: '' },
    runBatch: async (): Promise<BatchRecord[]> => [],
    runLearnerCode: async (script: string, args: string[], o: LearnerRunOptions): Promise<RunResult> =>
      run(lang === 'python' ? 'python' : 'node', path.basename(script), args, { timeoutMs: o.timeoutMs + 1000, stdin: o.stdin, readDirs: [o.workspaceDir, ...(o.readDirs ?? [])] }),
  };
}

describe('verifySpecLadder with the real harness', () => {
  const pyIface: TaskInterface = { file: 'wc.py', functions: [{ name: 'count_words', signature: 'count_words(text) -> dict', purpose: '' }] };
  const reference = [
    'from collections import Counter',
    '',
    'def count_words(text):',
    '    return dict(Counter(text.split()))',
    '',
  ].join('\n');

  test('Python: a wrong spec and a too-loose one are dropped; the learner file with top-level input() falls back to the pure reference', async (t) => {
    if (!PY) return t.skip('no python found');
    const ws = workspace({ 'wc.py': "def count_words(text):\n    return {}\n\nname = input('text? ')\nprint(count_words(name))\n", 'helpers.py': 'X = 1\n' });
    const ladder: SpecLadderDraft = {
      applicable: true,
      reason: '',
      specs: [
        spec('s1', "count_words('')", '{}'),
        spec('s2', "count_words('a')", "{'a': 1}"),
        spec('s3', "count_words('a b a')", "{'a': 2, 'b': 1}"),
        spec('s4', "count_words('a  b')", "{'': 1, 'a': 1, 'b': 1}"), // wrong on purpose
        spec('s5', 'count_words(None)', '', { expectError: 'Exception' }), // a stub raising NotImplementedError passes it too
      ],
      hidden: [spec('h1', "count_words('x y x')", "{'x': 2, 'y': 1}"), spec('h2', "count_words('q')", "{'q': 1}")],
      reference,
    };
    const tmpRoot = path.join(tmpBase, 'verify-py');
    const res = await verifySpecLadder(ladder, pyIface, { runner: realRunner('python'), workspaceDir: ws, harnessDir: HARNESS_DIR, tmpRoot });
    assert.equal(res.verified, true);
    assert.deepEqual(res.specs.map((s) => s.id), ['s1', 's2', 's3'], JSON.stringify(res.dropped));
    assert.deepEqual(res.hidden.map((s) => s.id), ['h1', 'h2']);
    const why = Object.fromEntries(res.dropped.map((d) => [d.id, d.reason]));
    assert.match(why.s4, /fails on the reference \(actual: \{'a': 1, 'b': 1\}\)/);
    assert.match(why.s5, /passes on an empty stub/);
    assert.equal(res.applicable, true);
    assert.deepEqual(fs.readdirSync(tmpRoot), []);
    assert.equal(fs.readFileSync(path.join(ws, 'wc.py'), 'utf8').includes('Counter'), false, 'the workspace file is untouched');
  });

  test('JavaScript (ESM): the reference replaces the learner function in the copy and passes; the stub fails cleanly', async () => {
    const ws = workspace({
      'package.json': '{"type": "module"}',
      'src/cli.js': "import { basename } from 'node:path';\n\nexport function parseArgs(argv) {\n  return null;\n}\n\nexport function keep() { return basename('a/b'); }\n",
    });
    const iface: TaskInterface = { file: 'src/cli.js', functions: [{ name: 'parseArgs', signature: 'parseArgs(argv)', purpose: '' }] };
    const ladder: SpecLadderDraft = {
      applicable: true,
      reason: '',
      specs: [
        spec('s1', 'parseArgs([])', '{"verbose": false, "files": []}'),
        spec('s2', "parseArgs(['-v'])", '{"verbose": true, "files": []}'),
        spec('s3', "parseArgs(['a.txt', '-v'])", '{verbose: true, files: ["a.txt"]}'), // JSON5: normalised to JSON
        spec('s4', "parseArgs(['x'])", '{"verbose": true, "files": ["x"]}'), // wrong on purpose
      ],
      hidden: [spec('h1', "parseArgs(['--verbose', 'b'])", '{"verbose": true, "files": ["b"]}')],
      reference: "import { basename } from 'node:path';\nconst FLAGS = new Set(['-v', '--verbose']);\n\nexport function parseArgs(argv) {\n  const out = { verbose: false, files: [] };\n  for (const a of argv) {\n    if (FLAGS.has(a)) out.verbose = true;\n    else out.files.push(basename(a));\n  }\n  return out;\n}\n",
    };
    const res = await verifySpecLadder(ladder, iface, { runner: realRunner('javascript'), workspaceDir: ws, harnessDir: HARNESS_DIR, tmpRoot: path.join(tmpBase, 'verify-js') });
    assert.deepEqual(res.specs.map((s) => s.id), ['s1', 's2', 's3'], JSON.stringify(res.dropped));
    assert.equal(res.specs[2].expected, '{"verbose":true,"files":["a.txt"]}');
    assert.deepEqual(res.hidden.map((s) => s.id), ['h1']);
    assert.deepEqual(res.dropped.map((d) => d.id), ['s4']);
    assert.equal(res.applicable, true);
  });
});
