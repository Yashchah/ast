// Deliberate batch runner (Node): many model/seed snippets in one process.
//
// usage: node [--permission ...] batch.mjs <items.json> [--start N] [--timeout-ms N] [--max-out N]
//                                          [--lang javascript|typescript] [--tsx <tsx package dir>]
//
// <items.json> is a JSON array of {id, code}. For each item from index --start on:
//   @@DLB_START <json id>
//   @@DLB {"id", "stdout", "values", "exception"?, "error"?, "exitOk", "timedOut", "ms", "constructs"}
// Each item runs with vm.runInNewContext semantics (a fresh context) under the vm timeout, which
// stops synchronous loops; timer callbacks run under the same timeout. Pending promises and timers
// get at most 2 s after the synchronous part. A hang the vm cannot interrupt (a microtask loop) is
// killed by the parent, which then respawns with --start past the item.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import util from 'node:util';
import * as nodeModule from 'node:module';
import { CHECK_SOURCE, INSPECT, constructsOf, makeConsole, typeName } from './prelude.mjs';

const PROMISE_CAP_MS = 2000;
const MAX_ERROR = 1000;

function parseArgs(argv) {
  const o = { path: '', start: 0, timeoutMs: 3000, maxOut: 20000, lang: 'javascript', tsx: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') o.start = Number(argv[++i]);
    else if (a === '--timeout-ms') o.timeoutMs = Number(argv[++i]);
    else if (a === '--max-out') o.maxOut = Number(argv[++i]);
    else if (a === '--lang') o.lang = argv[++i];
    else if (a === '--tsx') o.tsx = argv[++i];
    else o.path = a;
  }
  return o;
}

/** Protocol lines are written synchronously, so a later hang (and kill) cannot lose them. */
function emit(tag, payload) {
  const buf = Buffer.from(`${tag} ${JSON.stringify(payload)}\n`, 'utf8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(1, buf, off);
    } catch (e) {
      if (e && e.code === 'EAGAIN') continue; // non-blocking pipe momentarily full
      throw e;
    }
  }
}

function capped(max) {
  let text = '';
  return {
    write(s) {
      if (text.length < max) text += s.slice(0, max - text.length);
    },
    get text() {
      return text;
    },
  };
}

// ------------------------------------------------------------------ TypeScript

/**
 * tsx fallback (Node without type stripping): esbuild ships with tsx. All items are transformed
 * up front through one esbuild service; transformSync would start the esbuild binary per item.
 * Returns {code} or {error} per item.
 */
async function pretransformTsx(items, o) {
  const esbuild = nodeModule.createRequire(path.join(o.tsx, 'package.json'))('esbuild');
  return Promise.all(
    items.map((it) =>
      esbuild.transform(it.code ?? '', { loader: 'ts', target: 'esnext' }).then(
        (r) => ({ code: r.code }),
        (error) => ({ error }),
      ),
    ),
  );
}

function transformTs(code) {
  const strip = nodeModule.stripTypeScriptTypes;
  if (typeof strip !== 'function') throw new Error('TypeScript snippets need Node 22.13+ / 23.2+, or tsx');
  try {
    return strip(code, { mode: 'strip' }); // positions unchanged, so error lines match the snippet
  } catch (e) {
    if (e && e.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') return strip(code, { mode: 'transform' }); // enums, namespaces
    throw e;
  }
}

// ------------------------------------------------------------------ errors

function errorName(e) {
  const name = typeof e.name === 'string' ? e.name : '';
  if (name && name !== 'Error') return name;
  const ctor = typeName(e);
  return ctor && ctor !== 'Object' ? ctor : name || 'Error';
}

/** {exception, error} for anything thrown; the stack keeps snippet frames only. */
function describe(e, file) {
  if (util.types.isNativeError(e) || (e && typeof e === 'object' && typeof e.stack === 'string')) {
    let lines = String(e.stack ?? `${errorName(e)}: ${e.message}`).split('\n');
    // Node prefixes '<file>:<line>\n<source>\n<caret>\n\n'. Keep it only when it points at the snippet
    // (a failing check() would otherwise show check's own source).
    if (/^\S.*:\d+$/.test(lines[0]) && !lines[0].startsWith(`${file}:`) && lines.indexOf('') > 0) {
      lines = lines.slice(lines.indexOf('') + 1);
    }
    const firstFrame = lines.findIndex((l) => /^\s+at /.test(l));
    const head = firstFrame < 0 ? lines : lines.slice(0, firstFrame);
    const frames = firstFrame < 0 ? [] : lines.slice(firstFrame).filter((l) => l.includes(file));
    return { exception: errorName(e), error: [...head, ...frames].join('\n').slice(-MAX_ERROR) };
  }
  return { exception: typeName(e), error: `Uncaught ${util.inspect(e, INSPECT)}`.slice(-MAX_ERROR) };
}

// ------------------------------------------------------------------ one item

/** The item running now: process-level failures (unhandled rejections) are charged to it. */
let current;
const charge = (e) => {
  if (current) return current.fail(e);
  process.stderr.write(`batch.mjs: ${e && e.stack ? e.stack : String(e)}\n`); // our own bug: die loudly
  process.exit(70);
};
process.on('unhandledRejection', charge);
process.on('uncaughtException', charge);

async function runItem(item, o, pre) {
  const ts = o.lang === 'typescript';
  const file = ts ? 'snippet.ts' : 'snippet.js';
  const rec = { id: item.id, stdout: '', values: [], exitOk: false, timedOut: false, ms: 0, constructs: [] };
  const out = capped(o.maxOut);
  const err = capped(o.maxOut);
  const timers = new Map(); // handle -> clear function
  let failure;
  let done = false;
  const fail = (e) => {
    if (!failure && !done) failure = describe(e, file);
  };
  current = { fail };
  const t0 = performance.now();
  const finish = () => {
    done = true;
    current = undefined;
    for (const clear of timers.values()) clear();
    timers.clear();
    rec.ms = Math.round((performance.now() - t0) * 100) / 100;
    rec.stdout = out.text;
    if (failure) {
      rec.exception = failure.exception;
      rec.error = (err.text ? err.text + '\n' : '') + failure.error;
      rec.error = rec.error.slice(-MAX_ERROR);
    }
    rec.exitOk = !failure && !rec.timedOut;
    return rec;
  };

  const code = item.code ?? '';
  try {
    rec.constructs = constructsOf(code, ts);
  } catch {
    // constructs are metadata: never fail an item over them
  }

  let js;
  try {
    if (pre && pre.error) throw pre.error;
    js = pre ? pre.code : ts ? transformTs(code) : code;
  } catch (e) {
    failure = { exception: 'SyntaxError', error: String(e && e.message ? e.message : e).slice(-MAX_ERROR) };
    return finish();
  }

  const sink = { values: rec.values, out: (s) => out.write(s), err: (s) => err.write(s) };
  // Timer callbacks run through a script so the vm timeout covers them too.
  const pendingCall = { fn: undefined, args: [] };
  const invoke = (fn, args) => {
    if (done || failure || rec.timedOut) return;
    pendingCall.fn = fn;
    pendingCall.args = args;
    try {
      vm.runInContext('__dlbInvoke__()', ctx, { timeout: o.timeoutMs });
    } catch (e) {
      if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') rec.timedOut = true;
      else fail(e);
    }
  };
  const addTimer = (start, clear, repeat) => (fn, ms, ...args) => {
    if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
    const h = start(() => {
      if (!repeat) timers.delete(h);
      invoke(fn, args);
    }, ms);
    timers.set(h, () => clear(h));
    return h;
  };
  const dropTimer = (clear) => (h) => {
    if (timers.delete(h)) clear(h);
  };
  const globals = {
    console: makeConsole(sink),
    setTimeout: addTimer(setTimeout, clearTimeout, false),
    setInterval: addTimer(setInterval, clearInterval, true),
    setImmediate: addTimer((cb) => setImmediate(cb), clearImmediate, false),
    clearTimeout: dropTimer(clearTimeout),
    clearInterval: dropTimer(clearInterval),
    clearImmediate: dropTimer(clearImmediate),
    queueMicrotask: (fn) => queueMicrotask(() => invoke(fn, [])),
    structuredClone,
  };
  const ctx = vm.createContext(globals);
  vm.runInContext(CHECK_SOURCE, ctx, { filename: 'deliberate-check.js' });
  Object.defineProperty(ctx, '__dlbInvoke__', { value: () => pendingCall.fn(...pendingCall.args) });

  let script;
  try {
    script = new vm.Script(js, { filename: file });
  } catch (e) {
    // Top-level await: run the snippet as an async function body (same line numbers).
    if (e instanceof SyntaxError && /await is only valid|reserved word|Cannot use keyword 'await'/.test(e.message)) {
      try {
        script = new vm.Script(`(async () => {${js}\n})()`, { filename: file });
      } catch (e2) {
        fail(e2);
        return finish();
      }
    } else {
      fail(e);
      return finish();
    }
  }

  let result;
  try {
    result = script.runInContext(ctx, { timeout: o.timeoutMs });
  } catch (e) {
    if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') rec.timedOut = true;
    else fail(e);
  }

  // Async tail: the completion value's promise and any timers, for at most PROMISE_CAP_MS.
  if (!rec.timedOut && !failure) {
    let settled = !(result && typeof result.then === 'function');
    if (!settled) {
      Promise.resolve(result).then(
        () => (settled = true),
        (e) => {
          fail(e);
          settled = true;
        },
      );
    }
    const deadline = performance.now() + PROMISE_CAP_MS;
    for (;;) {
      await new Promise((r) => setImmediate(r)); // let microtasks and rejection tracking run
      if (failure || rec.timedOut || (settled && timers.size === 0)) break;
      if (performance.now() >= deadline) {
        rec.timedOut = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  }
  return finish();
}

// ------------------------------------------------------------------ main

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.path) {
    process.stderr.write('usage: batch.mjs <items.json> [--start N] [--timeout-ms N] [--max-out N] [--lang L] [--tsx DIR]\n');
    process.exit(2);
  }
  const items = JSON.parse(fs.readFileSync(o.path, 'utf8')).slice(o.start);
  const pre = o.lang === 'typescript' && o.tsx ? await pretransformTsx(items, o) : [];
  for (let i = 0; i < items.length; i++) {
    emit('@@DLB_START', items[i].id);
    emit('@@DLB', await runItem(items[i], o, pre[i]));
  }
  process.exit(0);
}

await main();
