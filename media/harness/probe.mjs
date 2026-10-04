// Deliberate own-code probe (Node), spec V1-12: run ONE call against a learner's module.
//
// usage: node [--permission ...] probe.mjs <module file> <call> [--stdin] [--workspace DIR] [--timeout-ms N]
//
// The module is imported from a temp copy in the cwd (the run temp dir): the file on disk, or with
// --stdin the editor's current text / a what-if mutant. Relative imports in the copy point back at
// the module's folder, and a top-level function that is not exported is exported from the copy,
// so the learner's helpers can be probed too. The top-level safety check, literal-only call parser
// and time limits are harness.mjs's (spec V1-12 MODULE SAFETY).
//
// Prints one line:
//   @@DLB {"ok": true, "type", "repr", "val", "ms", "importMs", "stdout"?}      the call returned
//   @@DLB {"ok": false, "exception", "error", "line"?, "ms", "importMs"}        it threw
//   @@DLB {"ok": false, "timedOut": true, "error"}                             past the deadline
//   @@DLB {"ok": false, "loadError": {...}, "importMs"}                        the module did not load
import fs from 'node:fs';
import {
  Session, TIMEOUT_TEXT, describeError, emit, encodeVal, errorLine, errorNames, parseCall, safeInspect, short, tokenize, topLevelNames, typeName,
} from './harness.mjs';

const STDOUT_MAX = 300;
const realExit = process.exit.bind(process);

function parseArgs(argv) {
  const o = { file: '', call: '', stdin: false, workspace: undefined, timeoutMs: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdin') o.stdin = true;
    else if (a === '--workspace' && i + 1 < argv.length) o.workspace = argv[++i];
    else if (a === '--timeout-ms' && i + 1 < argv.length) o.timeoutMs = Number(argv[++i]);
    else rest.push(a);
  }
  [o.file = '', o.call = ''] = rest;
  return o;
}

async function probe(session, callText, importMs) {
  let call;
  try {
    call = parseCall(callText);
  } catch (e) {
    return { ok: false, error: `BadCall: ${e.message}`, importMs };
  }
  const target = session.lookup(call.callee);
  if (!target.fn) return { ok: false, exception: target.exception, error: target.error, importMs };
  session.takeStdout();
  const t0 = performance.now();
  const r = await session.invoke(target.fn, call.args);
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  if (r.kind === 'timeout') return { ok: false, timedOut: true, error: TIMEOUT_TEXT, importMs };
  let rec;
  try {
    rec = session.runTimed(() => {
      if (r.kind === 'raised') {
        const out = { ok: false, exception: errorNames(r.error)[0], error: describeError(r.error), ms, importMs };
        if (r.error && r.error.code === 'ERR_ACCESS_DENIED') out.exception = 'DeliberateSandbox';
        const line = errorLine(r.error, session.target);
        if (line) out.line = line;
        return out;
      }
      return { ok: true, type: typeName(r.value), repr: safeInspect(r.value), val: encodeVal(r.value), ms, importMs };
    });
  } catch (e) {
    if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { ok: false, timedOut: true, error: TIMEOUT_TEXT, importMs };
    return { ok: false, error: `describing the result failed: ${describeError(e)}`, importMs };
  }
  const out = session.takeStdout();
  if (out) rec.stdout = short(out, STDOUT_MAX);
  return rec;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (!o.file || !o.call) {
    process.stderr.write('usage: probe.mjs <module file> <call> [--stdin] [--workspace DIR] [--timeout-ms N]\n');
    return 2;
  }
  const source = o.stdin ? fs.readFileSync(0, 'utf8') : fs.readFileSync(o.file, 'utf8');
  const session = new Session({ file: o.file, workspace: o.workspace, timeoutMs: o.timeoutMs ?? 3000, source, copy: true });
  try {
    const { callee } = parseCall(o.call);
    if (topLevelNames(tokenize(source).tokens).has(callee)) session.expose = callee;
  } catch {
    // reported by probe() below
  }
  const { importMs, loadError } = await session.load();
  if (loadError && loadError.kind !== 'not-exported') {
    emit('@@DLB', { ok: false, loadError, importMs });
    return 0;
  }
  emit('@@DLB', await probe(session, o.call, importMs));
  return 0;
}

let code;
try {
  code = await main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`probe.mjs: ${e && e.stack ? e.stack : String(e)}\n`);
  code = 70;
}
realExit(code);
