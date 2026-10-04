import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { BatchItem, BatchOptions, BatchRecord, Lang, LearnerRunOptions, RunResult, Runner, Runtime } from './contracts';
import { spawnCapped, type ProcResult } from './proc';

/**
 * Local execution (spec V1-2): runtime detection, the snippet and learner-code run profiles,
 * the batch runner (one spawn per batch) and the static allowlist. No vscode import: callers
 * pass paths in (runtimeDiscovery.ts gathers the Python candidates inside VS Code).
 */

// ---------------------------------------------------------------- types

export interface DetectedRuntime extends Runtime {
  /** Which candidate won, e.g. 'ms-python' or 'PATH python'. */
  source: string;
  /** Duration of the hello-world probe with the cached exe. */
  probeMs: number;
  /** tsMode 'tsx': the tsx package directory (its esbuild transforms snippets). */
  tsxDir?: string;
}

export interface DetectOptions {
  /** Directory the probes run in (also their TEMP). Default os.tmpdir(). */
  cwd?: string;
  /** Per probe. Default 10 s (a cold interpreter start on a busy disk can take seconds). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Diagnostics: why each rejected candidate failed. */
  log?: (msg: string) => void;
}

export interface PythonCandidate {
  bin: string;
  /** Arguments that select the interpreter, e.g. ['-3'] for the py launcher. */
  args?: string[];
  /** Label for logs, e.g. 'ms-python', '.venv', 'PATH python3'. */
  source?: string;
}

export interface LocalRunnerOptions {
  /** Absolute path of media/runner (batch.py, batch.mjs, prelude.py, prelude.mjs). */
  runnerDir: string;
  /** Parent of the per-run temp dirs, e.g. globalStorageUri/run. Created on demand. */
  runRoot: string;
}

export interface LocalBatchOptions extends BatchOptions {
  /** Extra Python imports allowed for this batch: the tag's allowedImports, find_spec hits for 'other'. */
  allowImports?: string[];
  /** Per-item stdout cap (characters). Default 20000. */
  maxOut?: number;
}

export class RunnerError extends Error {}

// ---------------------------------------------------------------- constants

const isWin = process.platform === 'win32';
export const DEFAULT_ITEM_TIMEOUT_MS = 3000;
const MAX_OUT = 20_000;
/** batch.mjs gives pending promises and timers this long after the synchronous part. */
const PROMISE_CAP_MS = 2000;
/** The first item's START line must arrive within this (interpreter start + reading the items). */
const STARTUP_MS = 15_000;
/** Extra time past the in-process limits before the parent kills a stuck batch. */
const WATCHDOG_GRACE_MS = 1000;
const LEARNER_MAX_OUT = 200_000;
const PROBE_TIMEOUT_MS = 10_000;

const PY_BASE_FLAGS = ['-s', '-B', '-X', 'utf8'];
/** No -s (user site-packages must load) and -E instead of -I (see spec critique note). */
const PY_LEARNER_FLAGS = ['-E', '-B', '-X', 'utf8'];
const PY_PROBE = "import sys; print(42); print(sys.executable); print('%d.%d.%d' % sys.version_info[:3])";
const NODE_PROBE = 'console.log(42); console.log(process.execPath); console.log(process.version)';
const MIN_PYTHON = [3, 8, 0]; // sys.addaudithook
const MIN_NODE = [18, 0, 0];

// ---------------------------------------------------------------- versions and flags

export function parseVersion(v: string): number[] {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : [0, 0, 0];
}

function atLeast(v: number[], min: number[]): boolean {
  for (let i = 0; i < 3; i++) if ((v[i] ?? 0) !== (min[i] ?? 0)) return (v[i] ?? 0) > (min[i] ?? 0);
  return true;
}

/** Node permission flag by version: '--permission' from 22.13 / 23.5, experimental from 20.0, none below. */
export function permissionFlagFor(version: string): string | undefined {
  const [maj, min] = parseVersion(version);
  if (maj >= 24 || (maj === 23 && min >= 5) || (maj === 22 && min >= 13)) return '--permission';
  if (maj >= 20) return '--experimental-permission';
  return undefined;
}

/** Node 22.6-23.5 needs --experimental-strip-types for .ts files. */
export function needsStripFlag(version: string): boolean {
  const v = parseVersion(version);
  return atLeast(v, [22, 6, 0]) && !atLeast(v, [23, 6, 0]);
}

/** Snippet-profile Python flags: '-s -B -X utf8', plus '-P' on 3.11+. */
export function pythonSnippetFlags(version: string): string[] {
  return atLeast(parseVersion(version), [3, 11, 0]) ? [...PY_BASE_FLAGS, '-P'] : [...PY_BASE_FLAGS];
}

/**
 * Child environment, built from scratch (nothing inherited but what is listed): PATH, SYSTEMROOT,
 * TEMP/TMP (= the run tmp), USERPROFILE/HOME; the learner profile adds APPDATA and LOCALAPPDATA
 * so user site-packages resolve.
 */
export function buildEnv(profile: 'snippet' | 'learner', tmp: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const src = process.env; // case-insensitive on win32
  const env: NodeJS.ProcessEnv = { PATH: src.PATH ?? '', TEMP: tmp, TMP: tmp };
  if (isWin) {
    env.SYSTEMROOT = src.SYSTEMROOT;
    env.USERPROFILE = src.USERPROFILE;
    if (profile === 'learner') {
      env.APPDATA = src.APPDATA;
      env.LOCALAPPDATA = src.LOCALAPPDATA;
    }
  } else {
    env.HOME = src.HOME;
    env.TMPDIR = tmp;
  }
  Object.assign(env, extra);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

// ---------------------------------------------------------------- runtime detection

type Probe = { ok: true; exe: string; version: string; ms: number; stdout: string } | { ok: false; error: string };

async function probe(
  bin: string,
  args: string[],
  o: DetectOptions,
  check: (lines: string[]) => boolean,
  profile: 'snippet' | 'learner' = 'snippet',
): Promise<Probe> {
  const cwd = o.cwd ?? os.tmpdir();
  try {
    const r = await spawnCapped(bin, args, {
      cwd,
      env: buildEnv(profile, cwd),
      timeoutMs: o.timeoutMs ?? PROBE_TIMEOUT_MS,
      signal: o.signal,
      maxOut: 20_000,
    });
    const lines = r.stdout.split(/\r?\n/).map((l) => l.trim());
    if (r.exitCode === 0 && check(lines)) return { ok: true, exe: lines[1], version: lines[2].replace(/^v/, ''), ms: r.ms, stdout: r.stdout };
    const why = r.timedOut ? 'timed out' : (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' | ');
    return { ok: false, error: why || `exit code ${r.exitCode}` };
  } catch (e) {
    if (o.signal?.aborted) throw e;
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const helloOk = (lines: string[]) => lines[0] === '42' && path.isAbsolute(lines[1] ?? '') && /^v?\d+\.\d+\.\d+/.test(lines[2] ?? '');

function samePath(a: string, b: string): boolean {
  const n = (p: string) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
  return n(a) === n(b);
}

/** Workspace virtualenv interpreters, in spec order: .venv, venv, env. */
export function venvCandidates(workspaceDir: string): PythonCandidate[] {
  return ['.venv', 'venv', 'env'].map((d) => ({
    bin: isWin ? path.join(workspaceDir, d, 'Scripts', 'python.exe') : path.join(workspaceDir, d, 'bin', 'python'),
    source: d,
  }));
}

/** PATH fallbacks, last in the spec order. */
export const PATH_PYTHON_CANDIDATES: PythonCandidate[] = [
  { bin: 'python', source: 'PATH python' },
  { bin: 'python3', source: 'PATH python3' },
  { bin: 'py', args: ['-3'], source: 'py -3' },
];

/**
 * First candidate whose hello-world (the exact snippet flags) prints 42 and sys.executable.
 * The absolute sys.executable is cached and spawned directly from then on, which skips the
 * WindowsApps alias and launchers. Never `--version`.
 */
export async function detectPython(candidates: (string | PythonCandidate)[], o: DetectOptions = {}): Promise<DetectedRuntime | undefined> {
  const seen = new Set<string>();
  for (const raw of candidates) {
    const c: PythonCandidate = typeof raw === 'string' ? { bin: raw } : raw;
    if (!c.bin.trim()) continue;
    const key = `${isWin ? c.bin.toLowerCase() : c.bin}\0${(c.args ?? []).join(' ')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = c.source ?? c.bin;
    if (path.isAbsolute(c.bin) && !fs.existsSync(c.bin)) {
      o.log?.(`python ${label}: ${c.bin} does not exist`);
      continue;
    }
    const pre = c.args ?? [];
    // Snippet flags depend on the version (-P is 3.11+): try with -P, drop it if refused.
    // Launchers (the WindowsApps alias, the Python install manager, py) need LOCALAPPDATA to pick
    // the interpreter a terminal would; without it this machine's alias silently ran another
    // Python. So the candidate is probed with the learner env, the cached exe with the snippet env.
    let flags = [...PY_BASE_FLAGS, '-P'];
    let p = await probe(c.bin, [...pre, ...flags, '-c', PY_PROBE], o, helloOk, 'learner');
    if (!p.ok && /-P\b/.test(p.error)) {
      flags = [...PY_BASE_FLAGS];
      p = await probe(c.bin, [...pre, ...flags, '-c', PY_PROBE], o, helloOk, 'learner');
    }
    if (!p.ok) {
      o.log?.(`python ${label}: ${p.error}`);
      continue;
    }
    if (!atLeast(parseVersion(p.version), MIN_PYTHON)) {
      o.log?.(`python ${label}: ${p.version} is older than 3.8`);
      continue;
    }
    flags = pythonSnippetFlags(p.version);
    let exe = p.exe;
    let lead: string[] = [];
    // The exact snippet argv and env, spawning the cached absolute interpreter directly.
    let direct = await probe(exe, [...flags, '-c', PY_PROBE], o, helloOk);
    if (!direct.ok || !samePath(direct.exe, exe)) {
      // e.g. a Store install whose real exe cannot be started: keep the launcher if it still
      // reaches the same interpreter with the snippet env.
      const via = await probe(c.bin, [...pre, ...flags, '-c', PY_PROBE], o, helloOk);
      if (!via.ok || !samePath(via.exe, exe)) {
        o.log?.(`python ${label}: ${exe} does not start with the snippet profile (${direct.ok ? direct.exe : direct.error})`);
        continue;
      }
      direct = via;
      exe = c.bin;
      lead = pre;
    }
    const ms = direct.ms;
    return {
      lang: 'python',
      exe,
      snippetArgv: [...lead, ...flags],
      learnerArgv: [...lead, ...PY_LEARNER_FLAGS],
      version: p.version,
      source: label,
      probeMs: ms,
    };
  }
  return undefined;
}

/**
 * The first node on PATH (or `bin`), probed with the exact snippet argv including the permission
 * flag. The absolute process.execPath is cached.
 */
export async function detectNode(o: DetectOptions & { bin?: string } = {}): Promise<DetectedRuntime | undefined> {
  const bin = o.bin ?? 'node';
  const run = (flag: string | undefined) => probe(bin, [...(flag ? [flag] : []), '-e', NODE_PROBE], o, helloOk);
  for (const flag of ['--permission', '--experimental-permission', undefined]) {
    let p = await run(flag);
    if (!p.ok) {
      if (flag && /bad option|unknown|not allowed|invalid/i.test(p.error)) continue; // too old for this flag
      o.log?.(`node ${bin}: ${p.error}`);
      return undefined;
    }
    let used = flag;
    const want = permissionFlagFor(p.version);
    if (want !== flag) {
      // accepted, but the version table says otherwise (e.g. an alias): use the table's flag if it works
      const q = await run(want);
      if (q.ok) {
        p = q;
        used = want;
      }
    }
    if (!atLeast(parseVersion(p.version), MIN_NODE)) {
      o.log?.(`node ${bin}: ${p.version} is older than 18`);
      return undefined;
    }
    const argv = used ? [used] : [];
    return {
      lang: 'javascript',
      exe: p.exe,
      snippetArgv: argv,
      learnerArgv: [...argv],
      version: p.version,
      permissionFlag: used,
      source: bin,
      probeMs: p.ms,
    };
  }
  return undefined;
}

/** tsx package directory: <workspace>/node_modules/.bin/tsx first, then tsx on PATH. */
export function findTsx(workspaceDir: string | undefined, envPath = process.env.PATH ?? ''): string | undefined {
  const pkgDirs: string[] = [];
  if (workspaceDir) {
    const bin = path.join(workspaceDir, 'node_modules', '.bin');
    if (['tsx', 'tsx.cmd'].some((n) => fs.existsSync(path.join(bin, n)))) pkgDirs.push(path.join(workspaceDir, 'node_modules', 'tsx'));
  }
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    if (isWin) {
      // npm global installs: <prefix>/tsx.cmd next to <prefix>/node_modules/tsx
      if (fs.existsSync(path.join(dir, 'tsx.cmd'))) pkgDirs.push(path.join(dir, 'node_modules', 'tsx'));
    } else if (fs.existsSync(path.join(dir, 'tsx'))) {
      try {
        pkgDirs.push(path.resolve(fs.realpathSync(path.join(dir, 'tsx')), '..', '..')); // .../tsx/dist/cli.mjs
      } catch {
        // dangling link
      }
    }
  }
  return pkgDirs.find((d) => fs.existsSync(path.join(d, 'package.json')));
}

/** file: URL of tsx's loader (package.json exports['.']), for `node --import`. */
export function tsxLoaderUrl(tsxDir: string): string {
  let rel = 'dist/loader.mjs';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(tsxDir, 'package.json'), 'utf8'));
    const dot = pkg?.exports?.['.'];
    const target = typeof dot === 'string' ? dot : (dot?.import?.default ?? dot?.import ?? dot?.default);
    if (typeof target === 'string') rel = target;
  } catch {
    // keep the default
  }
  return pathToFileURL(path.join(tsxDir, rel)).href;
}

/**
 * TypeScript on top of a detected node: native type stripping when `node -p process.features.typescript`
 * says 'strip'/'transform' (and module.stripTypeScriptTypes exists for snippets), else tsx.
 * With `runnerDir` the result is verified by a real one-item TS batch (the exact snippet argv).
 */
export async function detectTypeScript(
  node: Runtime,
  workspaceDir: string | undefined,
  o: DetectOptions & { runnerDir?: string } = {},
): Promise<DetectedRuntime | undefined> {
  const stripFlag = needsStripFlag(node.version) ? ['--experimental-strip-types'] : [];
  const expr = "[process.features.typescript, typeof require('node:module').stripTypeScriptTypes].join(' ')";
  const cwd = o.cwd ?? os.tmpdir();
  let candidate: DetectedRuntime | undefined;
  try {
    const r = await spawnCapped(node.exe, [...node.snippetArgv, ...stripFlag, '-p', expr], {
      cwd,
      env: buildEnv('snippet', cwd),
      timeoutMs: o.timeoutMs ?? PROBE_TIMEOUT_MS,
      signal: o.signal,
    });
    const [mode, api] = r.stdout.trim().split(/\s+/);
    if (r.exitCode === 0 && (mode === 'strip' || mode === 'transform') && api === 'function') {
      candidate = {
        ...node,
        lang: 'typescript',
        snippetArgv: [...node.snippetArgv, ...stripFlag],
        learnerArgv: [...node.learnerArgv, ...stripFlag],
        tsMode: mode,
        source: `node ${mode}`,
        probeMs: r.ms,
      };
    } else {
      o.log?.(`typescript: node ${node.version} reports '${r.stdout.trim() || r.stderr.trim()}'`);
    }
  } catch (e) {
    if (o.signal?.aborted) throw e;
    o.log?.(`typescript: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!candidate) {
    const tsxDir = findTsx(workspaceDir);
    if (!tsxDir) return undefined;
    // esbuild (inside tsx) runs its native binary as a child process.
    const allowChild = node.permissionFlag ? ['--allow-child-process'] : [];
    candidate = {
      ...node,
      lang: 'typescript',
      snippetArgv: [...node.snippetArgv, ...allowChild],
      learnerArgv: [...node.learnerArgv, ...allowChild, '--import', tsxLoaderUrl(tsxDir)],
      tsMode: 'tsx',
      tsxDir,
      source: `tsx ${tsxDir}`,
      probeMs: 0,
    };
  }
  if (o.runnerDir) {
    const t0 = performance.now();
    try {
      const runner = new LocalRunner(candidate, { runnerDir: o.runnerDir, runRoot: cwd });
      const [rec] = await runner.runBatch([{ id: 'ts-probe', code: 'const x: number = 42;\nconsole.log(x);' }], { signal: o.signal });
      if (rec.stdout.trim() !== '42') {
        o.log?.(`typescript (${candidate.tsMode}): probe printed '${rec.stdout.trim()}' ${rec.error ?? ''}`);
        return undefined;
      }
    } catch (e) {
      if (o.signal?.aborted) throw e;
      o.log?.(`typescript (${candidate.tsMode}): ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    candidate.probeMs = Math.round(performance.now() - t0);
  }
  return candidate;
}

export interface DetectedRuntimes {
  python?: DetectedRuntime;
  javascript?: DetectedRuntime;
  typescript?: DetectedRuntime;
}

/** Python and Node in parallel, then TypeScript on the detected node. */
export async function detectRuntimes(
  o: DetectOptions & { pythonCandidates: (string | PythonCandidate)[]; workspaceDir?: string; runnerDir?: string },
): Promise<DetectedRuntimes> {
  const [python, javascript] = await Promise.all([detectPython(o.pythonCandidates, o), detectNode(o)]);
  const typescript = javascript ? await detectTypeScript(javascript, o.workspaceDir, o) : undefined;
  return { python, javascript, typescript };
}

// ---------------------------------------------------------------- allowlist

/** Python modules model and seed snippets may import (spec V1-2 ALLOWLIST); tags add their own. */
export const PY_ALLOWED_IMPORTS: readonly string[] = [
  'math', 'collections', 'itertools', 'functools', 'string', 're', 'json', 'dataclasses', 'datetime',
  'io', 'argparse', 'typing', 'enum', 'statistics', 'fractions', 'decimal', 'heapq', 'bisect', 'copy',
  'operator', 'textwrap', '__future__',
];
const PY_ALLOWED = new Set(PY_ALLOWED_IMPORTS);
const PY_DENIED_MODULES = new Set([
  'os', 'sys', 'subprocess', 'shutil', 'socket', 'pathlib', 'urllib', 'http', 'requests', 'ctypes',
  'multiprocessing', 'threading', 'signal',
]);
const PY_DENIED: [RegExp, string][] = [
  [/(?<![.\w])open\s*\(/, 'open('],
  [/__import__/, '__import__'],
  [/(?<![.\w])eval\s*\(/, 'eval('],
  [/(?<![.\w])exec\s*\(/, 'exec('],
  [/(?<![.\w])input\s*\(/, 'input('],
  // Escape hatches around the list above; the audit hook would only catch their effects.
  [/(?<![.\w])(?:compile|breakpoint|help)\s*\(/, 'compile/breakpoint/help('],
  [/\b__(?:builtins|subclasses|globals|code|loader|spec)__\b/, 'dunder escape'],
  [/\bio\s*\.\s*(?:open|open_code|FileIO)\b/, 'io.open'],
  // argparse only with an explicit argv list
  [/\.\s*parse_(?:known_)?args\s*\(\s*\)/, 'parse_args() without an argv list'],
];
// datetime with fixed values only
const PY_CLOCK = /\.\s*(?:now|today|utcnow)\s*\(/;

const JS_DENIED: [RegExp, string][] = [
  [/(?<![.\w$])require\s*\(/, 'require('],
  [/(?<![.\w$])import\s*\(/, 'import('],
  [/\bimport\s*\.\s*meta\b/, 'import.meta'],
  [/\bprocess\s*[.[]/, 'process.'],
  [/(?<![.\w$])fetch\s*\(/, 'fetch('],
  [/\bDeno\b/, 'Deno'],
  [/\bBun\b/, 'Bun'],
  [/\bglobalThis\s*\[/, 'globalThis['],
  [/(?<![.\w$])eval\s*\(/, 'eval('],
  [/(?<![.\w$])Function\s*\(/, 'Function('],
  [/\bMath\s*\.\s*random\b/, 'Math.random'],
  [/\bDate\s*\.\s*now\b/, 'Date.now'],
  [/\bDate\s*\(\s*\)|\bnew\s+Date\b(?!\s*\()/, 'new Date()'],
  // Reaching a host Function through a constructor chain escapes the vm context.
  [/\.\s*constructor\b(?!\s*\.\s*name\b)/, '.constructor'],
  [/__proto__/, '__proto__'],
];
/** Checked on the raw text: these hide in string literals. */
const JS_DENIED_RAW: [RegExp, string][] = [
  [/child_process/, 'child_process'],
  [/['"`](?:constructor|__proto__)['"`]/, 'constructor by name'],
];

/** Blank comments and string contents (newlines kept); f-strings stay, since their {} hold code. */
export function stripPython(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = code[i];
    if (c === '#') {
      const j = code.indexOf('\n', i);
      const end = j < 0 ? n : j;
      out += blank(code.slice(i, end));
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      // a string prefix (r, b, f, rb, fr...) is a separate token: not the tail of a longer name
      const m = /(?<![\w])([rRbBuUfF]{1,2})$/.exec(out);
      const prefix = m ? m[1] : '';
      const keep = /[fF]/.test(prefix);
      const raw = /[rR]/.test(prefix);
      const q = code.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < n) {
        if (code[j] === '\\' && !raw) j += 2;
        else if (code.startsWith(q, j)) break;
        else if (q.length === 1 && code[j] === '\n') break;
        else j++;
      }
      const body = code.slice(i + q.length, Math.min(j, n));
      const closed = code.startsWith(q, j);
      out += q + (keep ? body : blank(body)) + (closed ? q : '');
      i = closed ? j + q.length : j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Blank comments, string contents and template text; `${}` expressions stay (they are code). */
export function stripJs(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  const braces: boolean[] = [];
  const template = () => {
    let j = i;
    while (j < n) {
      if (code[j] === '\\') j += 2;
      else if (code[j] === '`') {
        out += blank(code.slice(i, j)) + '`';
        i = j + 1;
        return;
      } else if (code[j] === '$' && code[j + 1] === '{') {
        out += blank(code.slice(i, j)) + '${';
        i = j + 2;
        braces.push(true);
        return;
      } else j++;
    }
    out += blank(code.slice(i));
    i = n;
  };
  while (i < n) {
    const c = code[i];
    if (c === '/' && code[i + 1] === '/') {
      const j = code.indexOf('\n', i);
      const end = j < 0 ? n : j;
      out += blank(code.slice(i, end));
      i = end;
    } else if (c === '/' && code[i + 1] === '*') {
      const j = code.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      out += blank(code.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      const closed = j < n && code[j] === c;
      out += c + blank(code.slice(i + 1, Math.min(j, n))) + (closed ? c : '');
      i = closed ? j + 1 : j;
    } else if (c === '`') {
      out += '`';
      i++;
      template();
    } else if (c === '{') {
      braces.push(false);
      out += c;
      i++;
    } else if (c === '}') {
      out += c;
      i++;
      if (braces.pop()) template();
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Top-level module names imported by Python code (relative imports as '.'). */
export function pythonImports(code: string): string[] {
  const src = stripPython(code).replace(/\\\r?\n/g, ' ');
  const mods: string[] = [];
  for (const m of src.matchAll(/(?:^|[;:])[ \t]*import[ \t]+([^;\n#]+)/gm)) {
    for (const part of m[1].replace(/[()]/g, '').split(',')) {
      const name = part.trim().split(/\s+/)[0];
      if (name) mods.push(name.split('.')[0]);
    }
  }
  for (const m of src.matchAll(/(?:^|[;:])[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import\b/gm)) {
    mods.push(m[1] ? '.' : m[2].split('.')[0]);
  }
  return mods;
}

/** JS/TS import statements that bring in values (type-only imports are fine). */
function jsValueImport(stripped: string): boolean {
  for (const m of stripped.matchAll(/(?:^|[;}])\s*import\b\s*([^;]*?)(?:\bfrom\b|['"`])/gm)) {
    const clause = m[1].trim();
    if (clause.startsWith('(') || clause.startsWith('.')) continue; // import( and import.meta: own rules
    if (/^type\b/.test(clause)) continue;
    const named = /^\{([^}]*)\}$/.exec(clause);
    if (named && named[1].split(',').every((s) => !s.trim() || /^type\b/.test(s.trim()))) continue;
    return true;
  }
  return false;
}

/**
 * Static allowlist for model and seed code (spec V1-2). Returns why the code is denied, or
 * undefined when it may run. Denied items are dropped, never run.
 */
export function allowlistCheck(code: string, lang: Lang, extraImports: readonly string[] = []): string | undefined {
  if (lang === 'python') {
    for (const mod of pythonImports(code)) {
      if (mod === '.') return 'relative import';
      if (PY_DENIED_MODULES.has(mod)) return `import ${mod}`;
      if (!PY_ALLOWED.has(mod) && !extraImports.includes(mod)) return `import ${mod} (not on the allowlist)`;
    }
    const s = stripPython(code);
    for (const [re, why] of PY_DENIED) if (re.test(s)) return why;
    if (/\bdatetime\b/.test(s) && PY_CLOCK.test(s)) return 'datetime.now()/today()';
    return undefined;
  }
  for (const [re, why] of JS_DENIED_RAW) if (re.test(code)) return why;
  const s = stripJs(code);
  if (jsValueImport(s)) return 'value import';
  for (const [re, why] of JS_DENIED) if (re.test(s)) return why;
  return undefined;
}

// ---------------------------------------------------------------- parseException

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const PY_EXC_LINE = /^([A-Za-z_][\w.]*)(?::(?:\s.*)?)?$/;

/**
 * Exception class name from a Python traceback or a Node uncaught-error report (stderr or a
 * terminal tail). The final exception of the last traceback wins; undefined when there is none.
 */
export function parseException(text: string, lang: Lang): string | undefined {
  const lines = text.replace(ANSI, '').split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  return lang === 'python' ? pyException(lines) : nodeException(lines);
}

const lastComponent = (name: string) => name.split('.').pop() || name;

function lastIndex(lines: string[], re: RegExp): number {
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return i;
  return -1;
}

function pyException(lines: string[]): string | undefined {
  const tb = lastIndex(lines, /^Traceback \(most recent call last\):/);
  const group = lastIndex(lines, /^\s*\+ Exception Group Traceback \(most recent call last\):/);
  if (group > tb) {
    // '  | ExceptionGroup: msg (2 sub-exceptions)' right after the group's own frames
    for (let i = group + 1; i < lines.length; i++) {
      const m = /^\s*\| ([A-Za-z_][\w.]*)(?::\s.*|:)?$/.exec(lines[i]);
      if (m && m[1] !== 'File') return lastComponent(m[1]);
    }
  }
  // Frames ('  File "x.py", line 3, in f'), then indented source/caret lines, then the exception.
  // A SyntaxError report has a File line but no 'Traceback' header.
  const start = Math.max(tb, lastIndex(lines, /^\s*File ".*", line \d+/));
  if (start < 0) return undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l || /^\s/.test(l)) continue;
    const m = PY_EXC_LINE.exec(l);
    if (m) return lastComponent(m[1]);
  }
  return undefined;
}

function nodeException(lines: string[]): string | undefined {
  const head = /^(?:Uncaught\s+)?([A-Za-z_$][\w$]*)(?: \[[\w]+\])?(?::\s.*|:)?$/;
  // 'TypeError: msg' directly followed by its stack frames; the last report wins.
  for (let i = lines.length - 2; i >= 0; i--) {
    const m = head.exec(lines[i]);
    if (m && /^\s+at\s/.test(lines[i + 1])) return m[1];
  }
  // A multi-line message separates the name from the frames: fall back to an Error-like name.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(?:Uncaught\s+)?([A-Za-z_$][\w$]*(?:Error|Exception|Failed))(?: \[[\w]+\])?:\s/.exec(lines[i]);
    if (m) return m[1];
  }
  return undefined;
}

// ---------------------------------------------------------------- LocalRunner

interface Pass {
  records: BatchRecord[];
  /** START lines seen. */
  started: number;
  stderr: string;
  exitCode: number | null;
  /** The parent killed it: an item ran past every in-process limit. */
  killed: boolean;
}

const WATCHDOG = new Error('batch watchdog');

function emptyRecord(id: string): BatchRecord {
  return { id, stdout: '', values: [], exitOk: false, timedOut: false, ms: 0, constructs: [] };
}

function normalizeRecord(raw: Partial<BatchRecord>, id: string): BatchRecord {
  const rec: BatchRecord = {
    ...emptyRecord(id),
    stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
    values: Array.isArray(raw.values) ? raw.values : [],
    exitOk: raw.exitOk === true,
    timedOut: raw.timedOut === true,
    ms: typeof raw.ms === 'number' ? raw.ms : 0,
    constructs: Array.isArray(raw.constructs) ? raw.constructs : [],
  };
  if (raw.exception) rec.exception = raw.exception;
  if (raw.error) rec.error = raw.error;
  if (Array.isArray(raw.trace)) rec.trace = raw.trace;
  return rec;
}

const tail = (s: string, n = 1000) => (s.length > n ? s.slice(-n) : s);

/** Ids whose output differs between two passes of the same items (e.g. two hash seeds). */
export function unstableIds(a: BatchRecord[], b: BatchRecord[]): string[] {
  const ids: string[] = [];
  a.forEach((x, i) => {
    const y = b[i];
    if (!y || x.denied || y.denied || x.timedOut || y.timedOut) return;
    if (x.stdout !== y.stdout || x.exception !== y.exception || x.exitOk !== y.exitOk) ids.push(x.id);
  });
  return ids;
}

export class LocalRunner implements Runner {
  constructor(
    readonly runtime: Runtime,
    private readonly o: LocalRunnerOptions,
  ) {}

  /**
   * Allowlist, then ONE spawn for every runnable item. If an item hangs past the in-process
   * limits the process is killed (Python exits itself through faulthandler), that item is marked
   * timedOut and a new process runs the remaining items.
   */
  async runBatch(items: BatchItem[], opts: LocalBatchOptions = {}): Promise<BatchRecord[]> {
    const results: (BatchRecord | undefined)[] = items.map(() => undefined);
    const runIdx: number[] = [];
    items.forEach((it, i) => {
      const why = allowlistCheck(it.code, this.runtime.lang, opts.allowImports);
      if (why) results[i] = { ...emptyRecord(it.id), denied: why };
      else runIdx.push(i);
    });
    if (runIdx.length) {
      opts.signal?.throwIfAborted();
      const tmp = await this.makeTmp('b-');
      try {
        const file = path.join(tmp, 'items.json');
        const wantTrace = (it: BatchItem) => this.runtime.lang === 'python' && !!it.wantTrace;
        await fsp.writeFile(file, JSON.stringify(runIdx.map((i) => ({ id: items[i].id, code: items[i].code, wantTrace: wantTrace(items[i]) }))));
        let start = 0;
        while (start < runIdx.length) {
          opts.signal?.throwIfAborted();
          const pass = await this.batchPass(tmp, file, start, opts);
          pass.records.slice(0, runIdx.length - start).forEach((rec, k) => {
            results[runIdx[start + k]] = { ...rec, id: items[runIdx[start + k]].id };
          });
          const next = start + pass.records.length;
          if (next >= runIdx.length) break;
          const id = items[runIdx[next]].id;
          if (pass.started <= pass.records.length) {
            // The process ended before starting the item: the runtime itself is broken.
            throw new RunnerError(`batch runner exited (code ${pass.exitCode}) before item ${id}: ${tail(pass.stderr, 500)}`);
          }
          results[runIdx[next]] = this.stuckRecord(id, pass);
          start = next + 1;
        }
      } finally {
        await removeDir(tmp);
      }
    }
    return results.map((r, i) => r ?? { ...emptyRecord(items[i].id), error: 'not run' });
  }

  /** Record for the item that was running when its process ended without reporting it. */
  private stuckRecord(id: string, pass: Pass): BatchRecord {
    const rec = emptyRecord(id);
    if (pass.killed || /^Timeout \(\d+:\d\d:\d\d/m.test(pass.stderr)) {
      rec.timedOut = true;
      rec.error = 'timed out';
    } else {
      // A hard crash (native fault, out of memory): report what the process left behind.
      const ex = parseException(pass.stderr, this.runtime.lang);
      if (ex) rec.exception = ex;
      rec.error = tail(pass.stderr.trim()) || `process exited with code ${pass.exitCode}`;
    }
    return rec;
  }

  private async batchPass(tmp: string, file: string, start: number, opts: LocalBatchOptions): Promise<Pass> {
    const rt = this.runtime as DetectedRuntime;
    const itemMs = opts.itemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS;
    const common = ['--start', String(start), '--timeout-ms', String(itemMs), '--max-out', String(opts.maxOut ?? MAX_OUT)];
    let argv: string[];
    let env: NodeJS.ProcessEnv;
    let perItemMs: number;
    if (rt.lang === 'python') {
      argv = [...rt.snippetArgv, path.join(this.o.runnerDir, 'batch.py'), file, ...common];
      env = buildEnv('snippet', tmp, { PYTHONHASHSEED: String(opts.hashSeed ?? 0) });
      perItemMs = itemMs + WATCHDOG_GRACE_MS;
    } else {
      const ts = rt.lang === 'typescript' ? ['--lang', 'typescript', ...(rt.tsMode === 'tsx' && rt.tsxDir ? ['--tsx', rt.tsxDir] : [])] : [];
      argv = [...rt.snippetArgv, ...this.nodeFsFlags(tmp, []), path.join(this.o.runnerDir, 'batch.mjs'), file, ...common, ...ts];
      env = buildEnv('snippet', tmp, rt.tsMode === 'tsx' ? { ESBUILD_WORKER_THREADS: '0' } : {});
      perItemMs = itemMs + PROMISE_CAP_MS + WATCHDOG_GRACE_MS;
    }

    const records: BatchRecord[] = [];
    let started = 0;
    let buf = '';
    const watchdog = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => watchdog.abort(WATCHDOG), ms);
    };
    arm(STARTUP_MS + perItemMs);
    const onStdout = (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('@@DLB_START ')) {
          started++;
          arm(perItemMs);
        } else if (line.startsWith('@@DLB ')) {
          let raw: Partial<BatchRecord>;
          try {
            raw = JSON.parse(line.slice(6));
          } catch {
            raw = { error: 'unreadable record' };
          }
          records.push(normalizeRecord(raw, String(raw.id ?? '')));
        }
      }
    };
    const signal = opts.signal ? AbortSignal.any([opts.signal, watchdog.signal]) : watchdog.signal;
    try {
      const r: ProcResult = await spawnCapped(rt.exe, argv, { cwd: tmp, env, signal, maxOut: 100_000, onStdout });
      return { records, started, stderr: r.stderr, exitCode: r.exitCode, killed: false };
    } catch (e) {
      if (watchdog.signal.aborted && !opts.signal?.aborted) return { records, started, stderr: '', exitCode: null, killed: true };
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Node permission flags: read the listed dirs, the run tmp and the runner; write only the run tmp. */
  private nodeFsFlags(tmp: string, readDirs: string[]): string[] {
    const rt = this.runtime as DetectedRuntime;
    if (!rt.permissionFlag) return []; // Node < 20: allowlist plus temp cwd only
    const reads = [tmp, this.o.runnerDir, ...readDirs];
    if (rt.tsxDir) {
      // tsx's loader looks for package.json / tsconfig.json in every parent directory with plain
      // fs calls, which the permission model would turn into crashes. (Node's own lookups are exempt.)
      reads.push(...ancestorConfigFiles(reads), path.dirname(rt.tsxDir)); // tsx and its esbuild
    }
    return [...new Set(reads)].map((d) => `--allow-fs-read=${d}`).concat(`--allow-fs-write=${tmp}`);
  }

  /**
   * Run a bundled script (harness, probe) against learner code in the learner-code profile.
   * cwd is ALWAYS a fresh temp dir, never the workspace. Python goes through prelude.py, which
   * installs the audit-hook sandbox and then runs the script as __main__.
   */
  async runLearnerCode(scriptPath: string, args: string[], opts: LearnerRunOptions): Promise<RunResult> {
    opts.signal?.throwIfAborted();
    const rt = this.runtime as DetectedRuntime;
    const tmp = await this.makeTmp('l-');
    try {
      const argv =
        rt.lang === 'python'
          ? [...rt.learnerArgv, path.join(this.o.runnerDir, 'prelude.py'), scriptPath, ...args]
          : [...rt.learnerArgv, ...this.nodeFsFlags(tmp, [opts.workspaceDir, path.dirname(scriptPath), ...(opts.readDirs ?? [])]), scriptPath, ...args];
      const env = buildEnv('learner', tmp, rt.tsMode === 'tsx' ? { ESBUILD_WORKER_THREADS: '0' } : {});
      const r = await spawnCapped(rt.exe, argv, {
        cwd: tmp,
        env,
        stdin: opts.stdin,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        maxOut: LEARNER_MAX_OUT,
      });
      const res: RunResult = { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: r.timedOut, ms: r.ms };
      if (!r.timedOut && r.exitCode !== 0) {
        const ex = parseException(r.stderr, rt.lang);
        if (ex) res.exception = ex;
      }
      return res;
    } finally {
      await removeDir(tmp);
    }
  }

  /**
   * Which of `names` the snippet profile can import (importlib.util.find_spec), for the allowlist
   * of concepts tagged 'other'. Always-denied modules never count.
   */
  async findPythonModules(names: string[], signal?: AbortSignal): Promise<string[]> {
    const wanted = [...new Set(names)].filter((n) => /^[A-Za-z_]\w*$/.test(n) && !PY_DENIED_MODULES.has(n));
    if (this.runtime.lang !== 'python' || !wanted.length) return [];
    const code =
      'import importlib.util, json, sys\n' +
      'def ok(n):\n    try:\n        return importlib.util.find_spec(n) is not None\n    except Exception:\n        return False\n' +
      'print(json.dumps([n for n in json.loads(sys.argv[1]) if ok(n)]))';
    const tmp = await this.makeTmp('m-');
    try {
      const r = await spawnCapped(this.runtime.exe, [...this.runtime.snippetArgv, '-c', code, JSON.stringify(wanted)], {
        cwd: tmp,
        env: buildEnv('snippet', tmp),
        timeoutMs: PROBE_TIMEOUT_MS,
        signal,
      });
      const found: unknown = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() || '[]');
      return Array.isArray(found) ? found.filter((n): n is string => typeof n === 'string' && wanted.includes(n)) : [];
    } catch (e) {
      if (signal?.aborted) throw e;
      return [];
    } finally {
      await removeDir(tmp);
    }
  }

  private async makeTmp(prefix: string): Promise<string> {
    await fsp.mkdir(this.o.runRoot, { recursive: true });
    return fsp.mkdtemp(path.join(this.o.runRoot, prefix));
  }
}

function ancestorConfigFiles(dirs: string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) {
    for (let cur = path.resolve(d); ; cur = path.dirname(cur)) {
      out.push(path.join(cur, 'package.json'), path.join(cur, 'tsconfig.json'));
      if (path.dirname(cur) === cur) break;
    }
  }
  return out;
}

async function removeDir(dir: string): Promise<void> {
  // Windows can hold a killed process's files for a moment.
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
}
