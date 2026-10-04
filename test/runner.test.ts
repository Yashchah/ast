import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCodex } from '../src/codex';
import type { BatchRecord, Val } from '../src/contracts';
import { spawnCapped } from '../src/proc';
import {
  LocalRunner,
  PATH_PYTHON_CANDIDATES,
  allowlistCheck,
  buildEnv,
  detectNode,
  detectPython,
  detectTypeScript,
  needsStripFlag,
  parseException,
  permissionFlagFor,
  pythonImports,
  pythonSnippetFlags,
  stripJs,
  stripPython,
  unstableIds,
  venvCandidates,
  type DetectedRuntime,
} from '../src/runner';

const RUNNER_DIR = path.resolve(__dirname, '..', 'media', 'runner');
const isWin = process.platform === 'win32';

// ====================================================================== parseException

describe('parseException', () => {
  test('python: plain traceback, qualified and chained exceptions', () => {
    const plain = [
      'Traceback (most recent call last):',
      '  File "C:\\work\\todo.py", line 12, in <module>',
      '    main()',
      '  File "C:\\work\\todo.py", line 8, in main',
      '    print(items[3])',
      '          ~~~~~^^^',
      'IndexError: list index out of range',
    ].join('\r\n');
    assert.equal(parseException(plain, 'python'), 'IndexError');

    const qualified = 'Traceback (most recent call last):\n  File "a.py", line 1, in <module>\n    json.loads("x")\njson.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)\n';
    assert.equal(parseException(qualified, 'python'), 'JSONDecodeError');

    const chained = [
      'Traceback (most recent call last):',
      '  File "a.py", line 2, in <module>',
      "    d['k']",
      "KeyError: 'k'",
      '',
      'During handling of the above exception, another exception occurred:',
      '',
      'Traceback (most recent call last):',
      '  File "a.py", line 4, in <module>',
      '    raise ValueError("bad key")',
      'ValueError: bad key',
    ].join('\n');
    assert.equal(parseException(chained, 'python'), 'ValueError');

    assert.equal(parseException('Traceback (most recent call last):\n  File "a.py", line 3, in <module>\n    time.sleep(9)\nKeyboardInterrupt\n', 'python'), 'KeyboardInterrupt');
    const custom = 'Traceback (most recent call last):\n  File "a.py", line 3, in <module>\n    raise Oops\nOops\n';
    assert.equal(parseException(custom, 'python'), 'Oops');
  });

  test('python: SyntaxError without a Traceback header, exception groups, notes', () => {
    const syntax = '  File "C:\\work\\a.py", line 1\n    def f(:\n          ^\nSyntaxError: invalid syntax\n';
    assert.equal(parseException(syntax, 'python'), 'SyntaxError');
    const group = [
      '  + Exception Group Traceback (most recent call last):',
      '  |   File "a.py", line 1, in <module>',
      '  |     raise ExceptionGroup("many", [ValueError(1), TypeError(2)])',
      '  | ExceptionGroup: many (2 sub-exceptions)',
      '  +-+---------------- 1 ----------------',
      '    | ValueError: 1',
      '    +---------------- 2 ----------------',
      '    | TypeError: 2',
      '    +------------------------------------',
    ].join('\n');
    assert.equal(parseException(group, 'python'), 'ExceptionGroup');
    const noted = 'Traceback (most recent call last):\n  File "a.py", line 1, in <module>\n    f()\nZeroDivisionError: division by zero\nwhile computing the average\n';
    assert.equal(parseException(noted, 'python'), 'ZeroDivisionError');
  });

  test('python: terminal tail with ANSI and shell-integration escapes; no traceback gives undefined', () => {
    const tail =
      '\x1b]633;C\x07PS C:\\work> python app.py\r\n\x1b[31mTraceback (most recent call last):\x1b[0m\r\n' +
      '  File "C:\\work\\app.py", line 2, in <module>\r\n    int("x")\r\n\x1b[1;35mValueError\x1b[0m: invalid literal for int() with base 10: \'x\'\r\n\x1b]633;D;1\x07PS C:\\work> ';
    assert.equal(parseException(tail, 'python'), 'ValueError');
    assert.equal(parseException('all good\n42\n', 'python'), undefined);
    // faulthandler's timeout dump is not an exception
    const dump = 'Timeout (0:00:03)!\nThread 0x00008360 (most recent call first):\n  File "<snippet>", line 2 in <module>\n';
    assert.equal(parseException(dump, 'python'), undefined);
  });

  test('node: uncaught errors, codes, multi-line messages, check failures', () => {
    const typeErr = [
      'C:\\work\\app.js:3',
      '  foo.bar();',
      '      ^',
      '',
      "TypeError: Cannot read properties of undefined (reading 'bar')",
      '    at Object.<anonymous> (C:\\work\\app.js:3:7)',
      '    at Module._compile (node:internal/modules/cjs/loader:1554:14)',
      '',
      'Node.js v24.11.1',
    ].join('\n');
    assert.equal(parseException(typeErr, 'javascript'), 'TypeError');
    const coded = "node:internal/modules/cjs/loader:1386\n  throw err;\n  ^\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find module 'x'\n    at foo (node:internal:1:1)\n\nNode.js v24.11.1\n";
    assert.equal(parseException(coded, 'javascript'), 'Error');
    const multi = 'RangeError: first line\nsecond line of the message\n    at f (a.js:1:1)\n';
    assert.equal(parseException(multi, 'typescript'), 'RangeError');
    assert.equal(parseException('CheckFailed: CHECK total(2) === 4\n    at snippet.js:9:1\n', 'javascript'), 'CheckFailed');
    assert.equal(parseException('C:\\a.js:1\nthrow "oops";\n^\noops\n(Use `node --trace-uncaught ...` to show where the exception was thrown)\n', 'javascript'), undefined);
    assert.equal(parseException('\x1b[31mUncaught ReferenceError: x is not defined\x1b[39m\n    at REPL1:1:1\n', 'javascript'), 'ReferenceError');
  });
});

// ====================================================================== allowlist

describe('allowlist', () => {
  test('python imports: allowlisted, denied, extras, relative', () => {
    assert.equal(allowlistCheck('import math\nfrom collections import Counter\nprint(math.pi)', 'python'), undefined);
    assert.equal(allowlistCheck('import os\nprint(1)', 'python'), 'import os');
    assert.equal(allowlistCheck('import math, os.path as p', 'python'), 'import os');
    assert.equal(allowlistCheck('x = 1; import subprocess', 'python'), 'import subprocess');
    assert.equal(allowlistCheck('if True: import socket', 'python'), 'import socket');
    assert.match(allowlistCheck('import numpy as np', 'python') ?? '', /numpy \(not on the allowlist\)/);
    assert.equal(allowlistCheck('import numpy as np', 'python', ['numpy']), undefined, 'per-tag extras');
    assert.equal(allowlistCheck('import os', 'python', ['os']), 'import os', 'extras never unlock always-denied modules');
    assert.equal(allowlistCheck('from . import helper', 'python'), 'relative import');
    assert.match(allowlistCheck('import random\nprint(random.random())', 'python') ?? '', /random/);
    assert.equal(allowlistCheck('from __future__ import annotations', 'python'), undefined);
  });

  test('python calls: open/eval/exec/input/__import__, but not in strings or comments', () => {
    assert.equal(allowlistCheck("open('x.txt', 'w')", 'python'), 'open(');
    assert.equal(allowlistCheck('f = __import__("os")', 'python'), '__import__');
    assert.equal(allowlistCheck('eval("1+1")', 'python'), 'eval(');
    assert.equal(allowlistCheck('exec ("x=1")', 'python'), 'exec(');
    assert.equal(allowlistCheck('name = input()', 'python'), 'input(');
    assert.equal(allowlistCheck('print(f"{open(1)}")', 'python'), 'open(', 'f-string expressions are code');
    assert.equal(allowlistCheck('print("open(file) and eval(x)")  # never input()', 'python'), undefined);
    assert.equal(allowlistCheck("print('''\nexec(\n''')", 'python'), undefined);
    assert.equal(allowlistCheck('reopen(3)\nmy_input(2)\nobj.eval(1)', 'python'), undefined, 'only the builtins');
    assert.equal(allowlistCheck('print(__builtins__)', 'python'), 'dunder escape');
    assert.equal(allowlistCheck('import io\nf = io.open("x")', 'python'), 'io.open');
  });

  test('python: datetime fixed values only, argparse with an explicit argv', () => {
    assert.match(allowlistCheck('import datetime\nprint(datetime.datetime.now())', 'python') ?? '', /now/);
    assert.match(allowlistCheck('from datetime import date\nprint(date.today())', 'python') ?? '', /today/);
    assert.equal(allowlistCheck('from datetime import date\nprint(date(2024, 1, 2).isoformat())', 'python'), undefined);
    assert.match(allowlistCheck('import argparse\np = argparse.ArgumentParser()\na = p.parse_args()', 'python') ?? '', /argv/);
    assert.equal(allowlistCheck("import argparse\np = argparse.ArgumentParser()\na = p.parse_args(['-v'])", 'python'), undefined);
  });

  test('js/ts: require, value imports, process, fetch, globals that break determinism', () => {
    assert.equal(allowlistCheck("const fs = require('fs')", 'javascript'), 'require(');
    assert.equal(allowlistCheck("import fs from 'fs'\nconsole.log(1)", 'javascript'), 'value import');
    assert.equal(allowlistCheck("import { readFileSync } from 'node:fs'", 'typescript'), 'value import');
    assert.equal(allowlistCheck("import type { Foo } from './foo'\nconst x: Foo = 1", 'typescript'), undefined);
    assert.equal(allowlistCheck("import { type A, type B } from './t'", 'typescript'), undefined);
    assert.equal(allowlistCheck("import { type A, b } from './t'", 'typescript'), 'value import');
    assert.equal(allowlistCheck("const m = await import('fs')", 'javascript'), 'import(');
    assert.equal(allowlistCheck('console.log(process.env.HOME)', 'javascript'), 'process.');
    assert.equal(allowlistCheck("fetch('http://x')", 'javascript'), 'fetch(');
    assert.equal(allowlistCheck('const r = Math.random()', 'javascript'), 'Math.random');
    assert.equal(allowlistCheck('const t = Date.now()', 'javascript'), 'Date.now');
    assert.equal(allowlistCheck('const d = new Date()', 'javascript'), 'new Date()');
    assert.equal(allowlistCheck('const d = new Date;', 'javascript'), 'new Date()');
    assert.equal(allowlistCheck('const d = new Date(0); console.log(d.getUTCFullYear())', 'javascript'), undefined);
    assert.equal(allowlistCheck("globalThis['pro' + 'cess']", 'javascript'), 'globalThis[');
    assert.equal(allowlistCheck('eval("1")', 'javascript'), 'eval(');
    assert.equal(allowlistCheck("const f = new Function('return 1')", 'javascript'), 'Function(');
    assert.equal(allowlistCheck("const cp = 'child_' + 'process'; x('child_process')", 'javascript'), 'child_process');
    assert.equal(allowlistCheck('Deno.exit()', 'typescript'), 'Deno');
  });

  test('js: constructor escapes are denied, ordinary class code is not; strings and comments are ignored', () => {
    assert.equal(allowlistCheck("console.log.constructor('return process')()", 'javascript'), '.constructor');
    assert.equal(allowlistCheck("const F = Object.getPrototypeOf(f).constructor; F('x')", 'javascript'), '.constructor');
    assert.equal(allowlistCheck("x['constructor']", 'javascript'), 'constructor by name');
    assert.equal(allowlistCheck('class P { constructor(x) { this.x = x } }\nconsole.log(new P(1).constructor.name)', 'javascript'), undefined);
    assert.equal(allowlistCheck("console.log('process.exit() and require(x)') // fetch(y)\n/* eval( */", 'javascript'), undefined);
    assert.equal(allowlistCheck('console.log(`${process.pid}`)', 'javascript'), 'process.', 'template expressions are code');
    assert.equal(allowlistCheck('console.log(`require(x) is text here`)', 'javascript'), undefined);
  });

  test('strippers keep line structure', () => {
    const py = "a = 'x#y'  # c\nb = \"\"\"q\nr\"\"\"\nc = rb'\\d'";
    const s = stripPython(py);
    assert.equal(s.split('\n').length, py.split('\n').length);
    assert.ok(!s.includes('x#y') && !s.includes('# c'));
    assert.deepEqual(pythonImports('import a.b as c, d\nfrom e.f import (g,\n h)\n  import i  # indented\ns = "import j"'), ['a', 'd', 'i', 'e']);
    const js = "const s = 'a//b'; // c\nconst t = `x${y + '}'}z`; /* q\n */";
    const j = stripJs(js);
    assert.equal(j.split('\n').length, 3);
    assert.ok(j.includes('y +') && !j.includes('a//b') && !j.includes('q'));
  });
});

// ====================================================================== pure helpers

describe('profiles', () => {
  test('node permission flag and strip flag by version', () => {
    assert.equal(permissionFlagFor('24.11.1'), '--permission');
    assert.equal(permissionFlagFor('23.9.0'), '--permission');
    assert.equal(permissionFlagFor('23.5.0'), '--permission');
    assert.equal(permissionFlagFor('23.4.0'), '--experimental-permission');
    assert.equal(permissionFlagFor('22.13.0'), '--permission');
    assert.equal(permissionFlagFor('22.12.0'), '--experimental-permission');
    assert.equal(permissionFlagFor('20.0.0'), '--experimental-permission');
    assert.equal(permissionFlagFor('18.19.0'), undefined);
    assert.equal(needsStripFlag('22.6.0'), true);
    assert.equal(needsStripFlag('23.5.9'), true);
    assert.equal(needsStripFlag('23.6.0'), false);
    assert.equal(needsStripFlag('22.5.1'), false);
    assert.deepEqual(pythonSnippetFlags('3.10.12'), ['-s', '-B', '-X', 'utf8']);
    assert.deepEqual(pythonSnippetFlags('3.14.0'), ['-s', '-B', '-X', 'utf8', '-P']);
  });

  test('env is built from scratch: nothing inherited beyond the listed variables', () => {
    process.env.DLB_SHOULD_NOT_LEAK = 'secret';
    process.env.PYTHONPATH = 'C:\\evil';
    try {
      const snip = buildEnv('snippet', '/run/tmp1', { PYTHONHASHSEED: '7' });
      assert.equal(snip.DLB_SHOULD_NOT_LEAK, undefined);
      assert.equal(snip.PYTHONPATH, undefined);
      assert.equal(snip.TEMP, '/run/tmp1');
      assert.equal(snip.TMP, '/run/tmp1');
      assert.equal(snip.PYTHONHASHSEED, '7');
      assert.ok(snip.PATH);
      if (isWin) {
        assert.equal(snip.APPDATA, undefined);
        assert.ok(buildEnv('learner', '/t').APPDATA, 'learner profile adds APPDATA');
      }
      assert.ok(Object.values(snip).every((v) => typeof v === 'string'));
    } finally {
      delete process.env.DLB_SHOULD_NOT_LEAK;
      delete process.env.PYTHONPATH;
    }
  });

  test('venv candidates in spec order', () => {
    const c = venvCandidates('/ws').map((x) => x.source);
    assert.deepEqual(c, ['.venv', 'venv', 'env']);
  });

  test('unstableIds compares two passes item by item', () => {
    const rec = (id: string, stdout: string): BatchRecord => ({ id, stdout, values: [], exitOk: true, timedOut: false, ms: 1, constructs: [] });
    assert.deepEqual(unstableIds([rec('a', '1'), rec('b', "{'x', 'y'}")], [rec('a', '1'), rec('b', "{'y', 'x'}")]), ['b']);
  });
});

// ====================================================================== real runs

let workRoot = '';
let runRoot = '';
let py: DetectedRuntime | undefined;
let node: DetectedRuntime | undefined;

before(async () => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dlb-runner-test-'));
  runRoot = path.join(workRoot, 'run');
  fs.mkdirSync(runRoot);
  [py, node] = await Promise.all([detectPython(PATH_PYTHON_CANDIDATES, { cwd: workRoot }), detectNode({ cwd: workRoot })]);
});

after(() => {
  fs.rmSync(workRoot, { recursive: true, force: true, maxRetries: 5 });
});

const pyRunner = () => new LocalRunner(py!, { runnerDir: RUNNER_DIR, runRoot });
const nodeRunner = (rt: DetectedRuntime = node!) => new LocalRunner(rt, { runnerDir: RUNNER_DIR, runRoot });
const valsOf = (rec: BatchRecord): Val[] => rec.values.flat().map((a) => a.val);
const runDirsLeft = () => fs.readdirSync(runRoot);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

describe('python runtime', () => {
  test('detection caches the absolute interpreter and the exact flags', (t) => {
    if (!py) return t.skip('no python found');
    assert.ok(path.isAbsolute(py.exe), py.exe);
    assert.doesNotMatch(py.exe, /Microsoft[\\/]WindowsApps[\\/]python3?\.exe$/i, 'the real interpreter, not the alias');
    assert.deepEqual(py.snippetArgv, pythonSnippetFlags(py.version));
    assert.deepEqual(py.learnerArgv, ['-E', '-B', '-X', 'utf8']);
    t.diagnostic(`python ${py.version} at ${py.exe} via ${py.source}; hello-world ${py.probeMs} ms`);
  });

  test('typed values: 2 vs 2.0, tuple vs list, set, dict, str, nested', async (t) => {
    if (!py) return t.skip('no python found');
    const [rec] = await pyRunner().runBatch([
      { id: 'v', code: "print(2, 2.0, (1, 2), [1, 2], {3}, {'k': None}, \"it's\", b'hi', True, float('-inf'), 10**30)\nprint()" },
    ]);
    assert.equal(rec.exitOk, true, rec.error);
    assert.equal(rec.stdout, "2 2.0 (1, 2) [1, 2] {3} {'k': None} it's b'hi' True -inf 1000000000000000000000000000000\n\n");
    assert.equal(rec.values.length, 2, 'one entry per print() call');
    assert.deepEqual(rec.values[1], []);
    const v = valsOf(rec);
    assert.deepEqual(v[0], { t: 'int', v: '2' });
    assert.deepEqual(v[1], { t: 'float', v: 2 });
    assert.deepEqual(v[2], { t: 'tuple', v: [{ t: 'int', v: '1' }, { t: 'int', v: '2' }] });
    assert.deepEqual(v[3], { t: 'list', v: [{ t: 'int', v: '1' }, { t: 'int', v: '2' }] });
    assert.deepEqual(v[4], { t: 'set', v: [{ t: 'int', v: '3' }] });
    assert.deepEqual(v[5], { t: 'dict', v: [[{ t: 'str', v: 'k' }, { t: 'none' }]] });
    assert.deepEqual(v[6], { t: 'str', v: "it's" });
    assert.deepEqual(v[7], { t: 'bytes', v: 'hi' });
    assert.deepEqual(v[8], { t: 'bool', v: true });
    assert.deepEqual(v[9], { t: 'float', v: '-inf' });
    assert.deepEqual(v[10], { t: 'int', v: '1000000000000000000000000000000' });
    assert.equal(rec.values[0][0].type, 'int');
    assert.equal(rec.values[0][6].repr, '"it\'s"');
    assert.deepEqual(runDirsLeft(), [], 'run tmp removed');
  });

  test('subclasses are opaque, so Counter({...}) never grades as a plain dict', async (t) => {
    if (!py) return t.skip('no python found');
    const [rec] = await pyRunner().runBatch([{ id: 'c', code: "from collections import Counter\nprint(Counter('aab'))" }]);
    assert.equal(rec.values[0][0].val.t, 'opaque');
    assert.equal(rec.values[0][0].type, 'Counter');
  });

  test('a timeout item does not sink the batch; errors, check() and syntax errors are per item', async (t) => {
    if (!py) return t.skip('no python found');
    const t0 = Date.now();
    const recs = await pyRunner().runBatch(
      [
        { id: 'ok1', code: 'print(1)' },
        { id: 'loop', code: 'while True:\n    pass' },
        { id: 'ok2', code: 'xs = [1, 2]\nprint(xs[5])' },
        { id: 'chk', code: 'def total(xs):\n    return sum(xs) + 1\ncheck(total([1, 2]) == 3, "total([1, 2]) == 3")' },
        { id: 'syn', code: 'def f(:\n  pass' },
        { id: 'ok3', code: 'print(3)' },
      ],
      { itemTimeoutMs: 800 },
    );
    t.diagnostic(`6 items with one 0.8 s timeout (2 spawns): ${Date.now() - t0} ms`);
    assert.deepEqual(recs.map((r) => r.id), ['ok1', 'loop', 'ok2', 'chk', 'syn', 'ok3']);
    assert.equal(recs[0].stdout, '1\n');
    assert.equal(recs[1].timedOut, true);
    assert.equal(recs[1].exitOk, false);
    assert.equal(recs[2].exception, 'IndexError');
    assert.match(recs[2].error ?? '', /File "<snippet>", line 2/);
    assert.equal(recs[3].exception, 'CheckFailed');
    assert.match(recs[3].error ?? '', /CheckFailed: CHECK total\(\[1, 2\]\) == 3/);
    assert.match(recs[3].error ?? '', /line 3/, 'the failing check() line, not the prelude');
    assert.doesNotMatch(recs[3].error ?? '', /prelude\.py|batch\.py/);
    assert.equal(recs[4].exception, 'SyntaxError');
    assert.equal(recs[5].stdout, '3\n');
    assert.ok(recs[5].exitOk);
  });

  test('two hash-seed passes flag string-set ordering, not int sets', async (t) => {
    if (!py) return t.skip('no python found');
    const items = [
      { id: 'strset', code: "print({'apple', 'banana', 'cherry', 'damson', 'elder', 'fig', 'grape', 'kiwi'})" },
      { id: 'intset', code: 'print({30, 1, 12, 7, 99})' },
      { id: 'sorted', code: "print(sorted({'b', 'a', 'c'}))" },
    ];
    const r = pyRunner();
    const [a, b] = await Promise.all([r.runBatch(items, { hashSeed: 1 }), r.runBatch(items, { hashSeed: 2 })]);
    assert.deepEqual(unstableIds(a, b), ['strset']);
    // the same seed is reproducible
    const again = await r.runBatch(items, { hashSeed: 1 });
    assert.deepEqual(unstableIds(a, again), []);
  });

  test('denied items get BatchRecord.denied and are never run', async (t) => {
    if (!py) return t.skip('no python found');
    const marker = path.join(workRoot, 'denied-ran.txt');
    const recs = await pyRunner().runBatch([
      { id: 'bad', code: `import os\nos.makedirs(${JSON.stringify(marker)})` },
      { id: 'good', code: 'print("ok")' },
    ]);
    assert.equal(recs[0].denied, 'import os');
    assert.equal(recs[0].exitOk, false);
    assert.equal(recs[0].stdout, '');
    assert.equal(recs[1].stdout, 'ok\n');
    assert.ok(!fs.existsSync(marker));
  });

  test('the audit hook blocks a write outside the run tmp (allowlist bypassed on purpose)', async (t) => {
    if (!py) return t.skip('no python found');
    const target = path.join(workRoot, 'escaped.txt');
    const recs = await pyRunner().runBatch([
      { id: 'w', code: `import io\nf = getattr(io, 'op' + 'en')(${JSON.stringify(target)}, 'w')\nf.write('x')` },
      { id: 'tmpok', code: "import io\nf = getattr(io, 'op' + 'en')('inside.txt', 'w')\nf.write('x')\nf.close()\nprint('wrote')" },
    ]);
    assert.equal(recs[0].exception, 'DeliberateSandbox');
    assert.match(recs[0].error ?? '', /keep that in the main block/);
    assert.ok(!fs.existsSync(target), 'nothing written outside tmp');
    assert.equal(recs[1].stdout, 'wrote\n', 'writes inside the run tmp are allowed');
  });

  test('state trace: aliasing, loop counts, 40/60 character cuts', async (t) => {
    if (!py) return t.skip('no python found');
    const code = "a = [1]\nb = a\nb.append(2)\nfor i in range(3):\n    a.append(i)\nsq = [x * x for x in range(4)]\nlong = 'z' * 100\nprint(a)";
    const [rec] = await pyRunner().runBatch([{ id: 't', code, wantTrace: true }]);
    const byLine = new Map((rec.trace ?? []).map((l) => [l.line, l.text]));
    assert.equal(byLine.get(2), 'a=[1]  b is a');
    assert.equal(byLine.get(3), 'a=[1, 2]  b is a');
    assert.match(byLine.get(4) ?? '', /^x4 /, 'the for header ran 4 times');
    assert.match(byLine.get(5) ?? '', /^x3 /, 'the body ran 3 times');
    assert.doesNotMatch(byLine.get(6) ?? '', /^x/, 'an inlined comprehension is one run of its line');
    for (const text of byLine.values()) assert.ok(text.length <= 60, text);
    assert.equal(byLine.get(7)?.length, 60, 'line text cut to 60 characters');
    const [cut, noTrace] = await pyRunner().runBatch([
      { id: 'r', code: "long = 'z' * 100", wantTrace: true },
      { id: 'n', code },
    ]);
    assert.equal(cut.trace?.[0]?.text, `long='${'z'.repeat(36)}...`, 'repr cut to 40 characters');
    assert.equal(noTrace.trace, undefined);
  });

  test('constructs from the ast walk', async (t) => {
    if (!py) return t.skip('no python found');
    const code = 'def fact(n, acc=1):\n    return acc if n < 2 else fact(n - 1, acc * n)\nxs = [fact(i) for i in range(5)]\nprint(xs[1:3], xs[-1], 7 // 2)';
    const [rec] = await pyRunner().runBatch([{ id: 'c', code }]);
    for (const c of ['def', 'default-arg', 'recursion', 'ternary', 'list-comp', 'slice', 'negative-index', 'floor-div', 'call:range']) {
      assert.ok(rec.constructs.includes(c), `${c} in ${rec.constructs.join(',')}`);
    }
  });

  test('learner-code run: temp cwd, workspace importable, writes outside tmp blocked, no __pycache__', async (t) => {
    if (!py) return t.skip('no python found');
    const ws = path.join(workRoot, 'ws-py');
    const harness = path.join(workRoot, 'harness-py');
    fs.mkdirSync(path.join(ws, 'pkg'), { recursive: true });
    fs.mkdirSync(harness);
    fs.writeFileSync(path.join(ws, 'mod.py'), 'from pkg.helper import twice\n\ndef double(x):\n    return twice(x)\n');
    fs.writeFileSync(path.join(ws, 'pkg', '__init__.py'), '');
    fs.writeFileSync(path.join(ws, 'pkg', 'helper.py'), 'def twice(x):\n    return x * 2\n');
    fs.writeFileSync(
      path.join(harness, 'h.py'),
      [
        'import os, sys',
        'import prelude',
        'ws = sys.argv[1]',
        'sys.path.insert(0, ws)',
        'import mod',
        'print(mod.double(21))',
        'print(os.getcwd())',
        'try:',
        "    open(os.path.join(ws, 'todos.json'), 'w').write('[]')",
        "    print('WROTE')",
        'except prelude.DeliberateSandbox as e:',
        "    print('BLOCKED', e.event)",
        'try:',
        "    os.remove(os.path.join(ws, 'mod.py'))",
        'except prelude.DeliberateSandbox:',
        "    print('BLOCKED remove')",
        "with open('todos.json', 'w') as f:",
        "    f.write('[]')",
        "print('TMP OK', len(prelude.sandbox_hits))",
        'prelude.check(mod.double(2) == 5, "double(2) == 5")',
      ].join('\n'),
    );
    const r = await pyRunner().runLearnerCode(path.join(harness, 'h.py'), [ws], { workspaceDir: ws, timeoutMs: 10_000 });
    t.diagnostic(`learner-code run: ${r.ms} ms`);
    const out = r.stdout.split(/\r?\n/);
    assert.equal(out[0], '42', r.stderr);
    assert.notEqual(path.resolve(out[1]).toLowerCase(), path.resolve(ws).toLowerCase(), 'cwd is never the workspace');
    assert.ok(path.resolve(out[1]).toLowerCase().startsWith(path.resolve(runRoot).toLowerCase()), out[1]);
    assert.equal(out[2], 'BLOCKED open');
    assert.equal(out[3], 'BLOCKED remove');
    assert.equal(out[4], 'TMP OK 2');
    assert.equal(r.exitCode, 1);
    assert.equal(r.exception, 'CheckFailed');
    assert.match(r.stderr, /CHECK double\(2\) == 5/);
    assert.ok(!fs.existsSync(path.join(ws, 'todos.json')));
    assert.ok(fs.existsSync(path.join(ws, 'mod.py')));
    assert.ok(!fs.existsSync(path.join(ws, '__pycache__')), 'no __pycache__ in the workspace');
    assert.ok(!fs.existsSync(path.join(ws, 'pkg', '__pycache__')), 'no __pycache__ in a workspace package');
    assert.deepEqual(runDirsLeft(), []);
  });

  test('learner-code run: subprocess and sockets are blocked too', async (t) => {
    if (!py) return t.skip('no python found');
    const dir = path.join(workRoot, 'harness-net');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'n.py'),
      [
        'import socket, subprocess, sys, prelude',
        'for name, fn in [',
        "    ('popen', lambda: subprocess.run([sys.executable, '-c', 'print(1)'])),",
        "    ('connect', lambda: socket.create_connection(('127.0.0.1', 9), timeout=1)),",
        ']:',
        '    try:',
        '        fn()',
        "        print(name, 'ran')",
        '    except prelude.DeliberateSandbox as e:',
        "        print(name, 'blocked', e.event)",
      ].join('\n'),
    );
    const r = await pyRunner().runLearnerCode(path.join(dir, 'n.py'), [], { workspaceDir: dir, timeoutMs: 10_000 });
    assert.match(r.stdout, /popen blocked subprocess\.Popen/, r.stderr);
    assert.match(r.stdout, /connect blocked socket\.connect/, r.stderr);
  });

  test('find_spec for the "other" allowlist', async (t) => {
    if (!py) return t.skip('no python found');
    const found = await pyRunner().findPythonModules(['json', 'definitely_not_a_module_xyz', 'os', 'bad name']);
    assert.deepEqual(found, ['json']);
  });
});

describe('node runtime', () => {
  test('detection: absolute node, permission flag by version', (t) => {
    if (!node) return t.skip('no node found');
    assert.ok(path.isAbsolute(node.exe));
    assert.equal(node.permissionFlag, permissionFlagFor(node.version));
    assert.deepEqual(node.snippetArgv, node.permissionFlag ? [node.permissionFlag] : []);
    t.diagnostic(`node ${node.version} at ${node.exe}; hello-world ${node.probeMs} ms`);
  });

  test('typed values and one-line arrays', async (t) => {
    if (!node) return t.skip('no node found');
    const [rec] = await nodeRunner().runBatch([
      { id: 'v', code: "console.log([1, 2, 3, 4, 5, 6, 7, 8], 6 / 2, -0, NaN, -Infinity, 10n, 'hi', null, undefined, true)\nconsole.log({ a: 1, 'b c': [2] }, new Set(['x']), new Map([[1, 'one']]))" },
    ]);
    assert.equal(rec.exitOk, true, rec.error);
    const [line1, line2] = rec.stdout.split('\n');
    assert.equal(line1, '[ 1, 2, 3, 4, 5, 6, 7, 8 ] 3 -0 NaN -Infinity 10n hi null undefined true');
    assert.equal(line2, "{ a: 1, 'b c': [ 2 ] } Set(1) { 'x' } Map(1) { 1 => 'one' }");
    const v = valsOf(rec);
    assert.equal(v[0].t, 'list');
    assert.deepEqual(v.slice(1, 10), [
      { t: 'num', v: 3 },
      { t: 'num', v: '-0' },
      { t: 'num', v: 'NaN' },
      { t: 'num', v: '-Infinity' },
      { t: 'bigint', v: '10' },
      { t: 'str', v: 'hi' },
      { t: 'null' },
      { t: 'undefined' },
      { t: 'bool', v: true },
    ]);
    assert.deepEqual(v[10], { t: 'dict', v: [[{ t: 'str', v: 'a' }, { t: 'num', v: 1 }], [{ t: 'str', v: 'b c' }, { t: 'list', v: [{ t: 'num', v: 2 }] }]] });
    assert.deepEqual(v[11], { t: 'set', v: [{ t: 'str', v: 'x' }] });
    assert.deepEqual(v[12], { t: 'dict', v: [[{ t: 'num', v: 1 }, { t: 'str', v: 'one' }]] });
    assert.equal(rec.values[0][0].type, 'Array');
    assert.equal(rec.values[0][0].repr, '[ 1, 2, 3, 4, 5, 6, 7, 8 ]');
  });

  test('async order, timeouts, rejections and a microtask hang that only the parent can stop', async (t) => {
    if (!node) return t.skip('no node found');
    const t0 = Date.now();
    const recs = await nodeRunner().runBatch(
      [
        { id: 'order', code: "setTimeout(() => console.log('timer'), 5);\nPromise.resolve().then(() => console.log('micro'));\nconsole.log('sync');" },
        { id: 'tla', code: 'const v = await new Promise((r) => setTimeout(() => r(42), 10));\nconsole.log(v);' },
        { id: 'loop', code: 'while (true) {}' },
        { id: 'cbloop', code: 'setTimeout(() => { while (true) {} }, 0);' },
        { id: 'reject', code: "Promise.reject(new RangeError('nope'));" },
        { id: 'chk', code: "function f(n) { return n * 2; }\ncheck(f(2) === 5, 'f(2) === 5');" },
        { id: 'hang', code: 'Promise.resolve().then(() => { for (;;) {} });' },
        { id: 'after', code: "console.log('still running')" },
      ],
      { itemTimeoutMs: 500 },
    );
    t.diagnostic(`8 node items incl. 3 timeouts and a respawn: ${Date.now() - t0} ms`);
    const by = Object.fromEntries(recs.map((r) => [r.id, r]));
    assert.equal(by.order.stdout, 'sync\nmicro\ntimer\n');
    assert.equal(by.tla.stdout, '42\n');
    assert.equal(by.loop.timedOut, true);
    assert.equal(by.cbloop.timedOut, true);
    assert.equal(by.reject.exception, 'RangeError');
    assert.equal(by.chk.exception, 'CheckFailed');
    assert.equal(by.chk.error, "CheckFailed: CHECK f(2) === 5\n    at snippet.js:2:1");
    assert.equal(by.hang.timedOut, true, 'killed by the parent watchdog');
    assert.equal(by.after.stdout, 'still running\n', 'the respawn ran the rest');
  });

  test('typescript via node type stripping', async (t) => {
    if (!node) return t.skip('no node found');
    const ts = await detectTypeScript(node, undefined, { cwd: workRoot, runnerDir: RUNNER_DIR });
    if (!ts) return t.skip(`node ${node.version} cannot run TypeScript without tsx`);
    t.diagnostic(`typescript ${ts.tsMode}: first batch (probe) ${ts.probeMs} ms`);
    const recs = await nodeRunner(ts).runBatch([
      { id: 'a', code: 'interface P { x: number }\nconst p: P = { x: 41 };\nconsole.log(p.x + 1);' },
      { id: 'b', code: 'enum Color { Red, Green }\nconsole.log(Color.Green);' },
      { id: 'c', code: "const s: string = 5 as unknown as string;\nconsole.log(typeof s);\nlet n: number = (null as any).x;" },
    ]);
    assert.equal(recs[0].stdout, '42\n', recs[0].error);
    assert.ok(recs[0].constructs.includes('interface'));
    assert.equal(recs[1].stdout, '1\n', recs[1].error);
    assert.equal(recs[2].exception, 'TypeError');
    assert.match(recs[2].error ?? '', /snippet\.ts:3/, 'stripping keeps line numbers');
  });

  test('learner-code run: workspace readable, writes outside the run tmp denied', async (t) => {
    if (!node) return t.skip('no node found');
    if (!node.permissionFlag) return t.skip('node without the permission model');
    const ws = path.join(workRoot, 'ws-js');
    const harness = path.join(workRoot, 'harness-js');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(harness, { recursive: true });
    fs.writeFileSync(path.join(ws, 'mod.mjs'), 'export const double = (x) => x * 2;\n');
    fs.writeFileSync(
      path.join(harness, 'h.mjs'),
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "import { pathToFileURL } from 'node:url';",
        'const ws = process.argv[2];',
        "const { double } = await import(pathToFileURL(path.join(ws, 'mod.mjs')).href);",
        'console.log(double(21));',
        "try { fs.writeFileSync(path.join(ws, 'todos.json'), '[]'); console.log('WROTE'); } catch (e) { console.log('DENIED', e.code); }",
        "fs.writeFileSync('scratch.json', '[]'); console.log('TMP OK');",
      ].join('\n'),
    );
    const r = await nodeRunner().runLearnerCode(path.join(harness, 'h.mjs'), [ws], { workspaceDir: ws, timeoutMs: 10_000 });
    t.diagnostic(`node learner-code run: ${r.ms} ms`);
    assert.equal(r.stdout, '42\nDENIED ERR_ACCESS_DENIED\nTMP OK\n', r.stderr);
    assert.ok(!fs.existsSync(path.join(ws, 'todos.json')));
  });
});

// ====================================================================== process trees

describe('process trees', () => {
  const parentCode =
    "import os, subprocess, sys, time\np = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\nprint(os.getpid(), p.pid, flush=True)\ntime.sleep(60)";

  test('abort kills a sleeping grandchild', async (t) => {
    if (!py) return t.skip('no python found');
    const ac = new AbortController();
    let pids: number[] = [];
    const run = spawnCapped(py.exe, ['-c', parentCode], {
      signal: ac.signal,
      onStdout: (s) => {
        pids = s.trim().split(/\s+/).map(Number);
        ac.abort();
      },
    });
    await assert.rejects(run, (e: Error) => e.name === 'AbortError');
    assert.equal(pids.length, 2);
    assert.ok(await waitGone(pids[0]), 'child gone');
    assert.ok(await waitGone(pids[1]), 'grandchild gone');
  });

  test('a timeout through a .cmd shim kills the node behind cmd.exe, not just cmd.exe (codex path)', async (t) => {
    if (!py) return t.skip('no python found');
    if (!isWin) return t.skip('cmd shims are win32 only');
    const shim = path.join(workRoot, 'fake codex.cmd');
    fs.writeFileSync(shim, `@echo off\r\n"${py.exe}" -c "${parentCode.replace(/\n/g, '; ')}"\r\n`);
    let pids: number[] = [];
    const r = await spawnCapped(shim, ['exec', '-'], { shell: true, timeoutMs: 2500, onStdout: (s) => (pids = s.trim().split(/\s+/).map(Number)) });
    assert.equal(r.timedOut, true);
    assert.equal(pids.length, 2, r.stderr);
    assert.ok(await waitGone(pids[0]), 'python under cmd.exe gone');
    assert.ok(await waitGone(pids[1]), 'its child gone');
  });

  test('runCodex: timeout becomes CodexError and the abort signal is honoured', async (t) => {
    if (!py) return t.skip('no python found');
    if (!isWin) return t.skip('fake .cmd codex is win32 only');
    const shim = path.join(workRoot, 'slow-codex.cmd');
    fs.writeFileSync(shim, `@echo off\r\n"${py.exe}" -c "import time; time.sleep(60)"\r\n`);
    const o = { bin: shim, model: 'm', effort: 'low', fast: false, timeoutMs: 1500 };
    await assert.rejects(runCodex(o, 'sys', 'prompt', {}), /did not answer within 2s/);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(runCodex({ ...o, timeoutMs: 30_000 }, 'sys', 'prompt', {}, ac.signal), (e: Error) => e.name === 'AbortError');
  });

  test('aborting runBatch rejects and leaves no temp dir', async (t) => {
    if (!py) return t.skip('no python found');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    await assert.rejects(pyRunner().runBatch([{ id: 'slow', code: 'while True:\n    pass' }], { signal: ac.signal }), (e: Error) => e.name === 'AbortError');
    assert.deepEqual(runDirsLeft(), []);
  });
});
