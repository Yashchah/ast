// Red-green spec ladder logic (spec V1-11) and own-code probe results (V1-12). Pure: no vscode
// import, so it runs under node:test. src/specs.ts (VS Code wiring) builds on it:
// - harness I/O: buildHarnessInput() writes what media/harness/harness.{py,mjs} read;
//   parseHarnessOutput() / parseProbeOutput() read what they print
// - ladder state: targetSpec(), visibleTitles(), specEvidenceWeight(), hiddenFailureCard(), signatureMatch()
// - interface: mapInterface(), rewriteSpecCalls(), findTopLevelFunctions() (the regex fallback)
// - prefetch: validateSpecs(), buildVerificationPlan(), verifySpecLadder() (reference + stub runs)
// The reference implementation exists only inside verifySpecLadder(): it is written to a temp
// copy of the workspace, run, and deleted; nothing returned or stored contains it.

import * as fsp from 'fs/promises';
import * as path from 'path';
import type {
  FadeLevel, FailureSignature, HarnessReport, Lang, Runner, SpecItem, SpecResult, TaskInterface, TaskSpecState, Val,
} from './contracts';
import { renameCallee, validateCall } from './calls';
import { parseLiteral, valEquals } from './compare';
import { isLimitError } from './jobs';

// =====================================================================================
// Constants
// =====================================================================================

export const TIMEOUT_TEXT = 'timeout (infinite loop?)';
export const DESIGN_DIFFERS = 'Your design differs from the planned interface; Check my work will review it instead.';
/** Spec V1-11 RUNS: total harness timeout; the first run's import time extends it. */
export const SPEC_TIMEOUT_MS = 5000;
/** Imports slower than this (pandas, flask) extend the timeout and show 'running specs...'. */
export const SLOW_IMPORT_MS = 1000;
/** Fewer visible specs than this after verification: the ladder is not applicable. */
export const MIN_SPECS = 3;
const ACTUAL_MAX = 200;
const ERROR_MAX = 300;
const COPY_MAX_BYTES = 2 * 1024 * 1024;
const COPY_MAX_FILES = 300;
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'venv', '.venv', 'dist', 'build', '__pycache__']);
const SOURCE_EXT: Record<'python' | 'js', string[]> = {
  python: ['.py'],
  js: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json'],
};
const KNOWN_LOAD_KINDS = ['top-level', 'unsafe-top-level', 'not-exported', 'import', 'sandbox', 'crash'] as const;
const TOP_LEVEL_TIMEOUT = 'loading the module took longer than the time limit: top-level code runs on import, so keep slow or endless work under a main guard';

// =====================================================================================
// Harness input (what harness.py / harness.mjs read)
// =====================================================================================

export interface HarnessSpecInput {
  id: string;
  call: string;
  expected: string;
  expectError: string;
  /** failureSignatures, matched inside the harness with the same equality as the spec. */
  signatures?: { match: 'equals' | 'error'; value: string }[];
}

export interface HarnessInput {
  /** Workspace root: prepended to sys.path (Python); bounds the import safety walk (Node). */
  workspace?: string;
  /** The parent's process timeout; the harness stops itself a little earlier. */
  timeoutMs?: number;
  /** Interface functions (after mapping): Node reports defined-but-not-exported ones. */
  functions?: string[];
  specs: HarnessSpecInput[];
}

/** The spec JSON for one harness run. Only the fields the harness needs; never the reference. */
export function buildHarnessInput(specs: SpecItem[], o: { workspace?: string; timeoutMs?: number; functions?: string[] } = {}): HarnessInput {
  const input: HarnessInput = {
    specs: specs.map((s) => {
      const item: HarnessSpecInput = { id: s.id, call: s.call, expected: s.expected, expectError: s.expectError };
      if (s.failureSignatures?.length) item.signatures = s.failureSignatures.map((f) => ({ match: f.match, value: f.value }));
      return item;
    }),
  };
  if (o.workspace) input.workspace = o.workspace;
  if (o.timeoutMs) input.timeoutMs = o.timeoutMs;
  if (o.functions) input.functions = [...o.functions];
  return input;
}

/** Timeout for the next run: 5 s, plus the measured import time once it is over 1 s. */
export function specTimeoutMs(importMs: number | undefined): number {
  return importMs !== undefined && importMs > SLOW_IMPORT_MS ? SPEC_TIMEOUT_MS + Math.ceil(importMs) : SPEC_TIMEOUT_MS;
}

// =====================================================================================
// Harness output
// =====================================================================================

export type HarnessLoadError = NonNullable<HarnessReport['loadError']> & {
  /** 1-based line in the learner's file. */
  line?: number;
  /** Workspace-relative module that failed the safety check, when it is not the module itself. */
  file?: string;
  /** Why the top level is unsafe, e.g. 'main() runs on import'. */
  why?: string;
};

/** contracts SpecResult plus what the harness adds. */
export interface HarnessSpecResult extends SpecResult {
  /** Exception class name, when the call raised. */
  exception?: string;
  /** 1-based line in the learner's file where it raised. */
  line?: number;
  /** Index into the spec's failureSignatures that the harness matched. */
  sig?: number;
  /** What the call printed (<= 300 chars). */
  stdout?: string;
  /** Typed value of the result, when small. */
  val?: Val;
}

export interface HarnessRun extends HarnessReport {
  results: HarnessSpecResult[];
  loadError?: HarnessLoadError;
  /** The harness printed its END line: it was neither killed nor crashed. */
  finished: boolean;
}

interface ProtocolLines {
  plan?: string[];
  load?: Record<string, unknown>;
  started: string[];
  records: Map<string, Record<string, unknown>>;
  end?: Record<string, unknown>;
}

/** Protocol lines may follow learner output on the same line: find the tag anywhere. */
function readProtocol(stdout: string): ProtocolLines {
  const out: ProtocolLines = { started: [], records: new Map() };
  const json = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  for (const raw of stdout.split(/\r?\n/)) {
    const at = raw.indexOf('@@DLB');
    if (at < 0) continue;
    const line = raw.slice(at);
    if (line.startsWith('@@DLB_PLAN ')) {
      const v = json(line.slice(11));
      if (Array.isArray(v)) out.plan = v.map(String);
    } else if (line.startsWith('@@DLB_LOAD ')) {
      const v = json(line.slice(11));
      if (v && typeof v === 'object') out.load = v as Record<string, unknown>;
    } else if (line.startsWith('@@DLB_START ')) {
      out.started.push(line.slice(12).trim());
    } else if (line.startsWith('@@DLB_END')) {
      const v = json(line.slice(9).trim() || '{}');
      out.end = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } else if (line.startsWith('@@DLB ')) {
      const v = json(line.slice(6));
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const rec = v as Record<string, unknown>;
        const id = String(rec.id ?? '');
        if (id && !out.records.has(id)) out.records.set(id, rec); // the first complete record wins
      }
    }
  }
  return out;
}

/** stderr tail without Node's experimental/security warnings. */
export function stderrTail(stderr: string, max = 1000): string {
  const text = stderr
    .split(/\r?\n/)
    .filter((l) => !/ExperimentalWarning|SecurityWarning|--trace-warnings|^\(node:\d+\)/.test(l))
    .join('\n')
    .trim();
  return text.length > max ? text.slice(-max) : text;
}

function str(v: unknown, max?: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  return max !== undefined ? clip(v, max) : v;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

function normalizeLoadError(v: unknown): HarnessLoadError | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const kind = (KNOWN_LOAD_KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as HarnessLoadError['kind']) : 'crash';
  const err: HarnessLoadError = { kind, message: str(o.message, 500) ?? kind };
  if (typeof o.name === 'string' && o.name) err.name = o.name;
  if (typeof o.line === 'number') err.line = o.line;
  if (typeof o.file === 'string') err.file = o.file;
  if (typeof o.why === 'string') err.why = o.why;
  return err;
}

function normalizeRecord(id: string, rec: Record<string, unknown>): HarnessSpecResult {
  const status = rec.status === 'timeout' || rec.status === 'not-run' ? rec.status : 'ok';
  const r: HarnessSpecResult = { id, pass: rec.pass === true && status === 'ok', status };
  const actual = str(rec.actual, ACTUAL_MAX);
  if (actual !== undefined) r.actual = actual;
  const error = str(rec.error, ERROR_MAX);
  if (error !== undefined) r.error = error;
  if (typeof rec.exception === 'string' && rec.exception) r.exception = rec.exception;
  if (typeof rec.line === 'number') r.line = rec.line;
  if (typeof rec.sig === 'number' && Number.isInteger(rec.sig)) r.sig = rec.sig;
  const stdout = str(rec.stdout, 300);
  if (stdout) r.stdout = stdout;
  if (rec.val && typeof rec.val === 'object') r.val = rec.val as Val;
  return r;
}

/**
 * The harness's report. On a timeout the spec that started last is 'timeout (infinite loop?)'
 * and the rest 'not-run'; on a crash the running spec gets the stderr tail and loadError is
 * {kind: 'crash'}. `opts.ids` (ladder order) is used when the harness died before its PLAN line.
 */
export function parseHarnessOutput(stdout: string, stderr: string, timedOut: boolean, opts: { ids?: string[] } = {}): HarnessRun {
  const p = readProtocol(stdout);
  const ids: string[] = [...(p.plan ?? opts.ids ?? [])];
  for (const id of [...p.started, ...p.records.keys()]) if (!ids.includes(id)) ids.push(id);
  const finished = p.end !== undefined;
  const crashed = !finished && !timedOut;
  const tail = stderrTail(stderr);
  const report: HarnessRun = { results: [], timedOut: timedOut || p.end?.timedOut === true, finished };
  if (typeof p.load?.importMs === 'number') report.importMs = p.load.importMs;
  report.loadError = normalizeLoadError(p.load?.loadError);
  if (!p.load && !report.loadError) {
    if (timedOut) {
      report.loadError = p.plan
        ? { kind: 'top-level', message: TOP_LEVEL_TIMEOUT, name: 'timeout' }
        : { kind: 'crash', message: 'the spec harness did not start in time' };
    } else if (crashed) {
      report.loadError = { kind: 'crash', message: tail || 'the spec harness exited without a report' };
    }
  } else if (crashed && !report.loadError) {
    report.loadError = { kind: 'crash', message: tail || 'the spec harness exited without a report' };
  }
  const lastStarted = p.started[p.started.length - 1];
  for (const id of ids) {
    const rec = p.records.get(id);
    if (rec) {
      report.results.push(normalizeRecord(id, rec));
    } else if (id === lastStarted && p.started.includes(id)) {
      report.results.push(
        timedOut
          ? { id, pass: false, status: 'timeout', error: TIMEOUT_TEXT }
          : { id, pass: false, status: 'ok', error: clip(`the spec harness crashed: ${tail || 'no output'}`, ERROR_MAX) },
      );
    } else {
      report.results.push({ id, pass: false, status: 'not-run' });
    }
  }
  if (report.results.some((r) => r.status === 'timeout')) report.timedOut = true;
  return report;
}

/** One own-code probe (media/harness/probe.py / probe.mjs). */
export interface ProbeOutcome {
  /** The call returned (its value is in type/repr/val). */
  ok: boolean;
  type?: string;
  repr?: string;
  val?: Val;
  /** Exception class name, when the call raised. */
  exception?: string;
  error?: string;
  line?: number;
  stdout?: string;
  ms?: number;
  importMs?: number;
  loadError?: HarnessLoadError;
  timedOut: boolean;
}

export function parseProbeOutput(stdout: string, stderr: string, timedOut: boolean): ProbeOutcome {
  let rec: Record<string, unknown> | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    const at = raw.indexOf('@@DLB ');
    if (at < 0) continue;
    try {
      const v = JSON.parse(raw.slice(at + 6));
      if (v && typeof v === 'object' && !Array.isArray(v)) rec = v as Record<string, unknown>;
    } catch {
      // keep looking
    }
  }
  if (!rec) {
    if (timedOut) return { ok: false, timedOut: true, error: TIMEOUT_TEXT };
    return { ok: false, timedOut: false, loadError: { kind: 'crash', message: stderrTail(stderr) || 'the probe exited without a report' } };
  }
  const out: ProbeOutcome = { ok: rec.ok === true, timedOut: rec.timedOut === true };
  for (const k of ['type', 'repr', 'exception', 'error', 'stdout'] as const) if (typeof rec[k] === 'string') out[k] = rec[k] as string;
  for (const k of ['line', 'ms', 'importMs'] as const) if (typeof rec[k] === 'number') out[k] = rec[k] as number;
  if (rec.val && typeof rec.val === 'object') out.val = rec.val as Val;
  const le = normalizeLoadError(rec.loadError);
  if (le) out.loadError = le;
  return out;
}

// =====================================================================================
// Target-only reporting and fading (spec V1-11 REPORTING, FADING)
// =====================================================================================

export type SpecDisplay = 'passed' | 'failed' | 'not-yet' | 'not-run';

export interface TargetReport {
  /** The first red spec in ladder order: the only one reported as failed. */
  target?: string;
  display: Record<string, SpecDisplay>;
  passed: number;
  total: number;
}

type ResultsLike = Record<string, SpecResult | undefined> | SpecResult[];

function resultMap(results: ResultsLike): Map<string, SpecResult> {
  const m = new Map<string, SpecResult>();
  if (Array.isArray(results)) for (const r of results) m.set(r.id, r);
  else for (const [id, r] of Object.entries(results)) if (r) m.set(id, r);
  return m;
}

const isRed = (r: SpecResult | undefined): boolean => !!r && !r.pass && r.status !== 'not-run';

/**
 * Only the first red spec in ladder order is 'failed'; anything after it that is not green is
 * 'not-yet' (no message, no location), so the learner never sees several failures at once.
 */
export function targetSpec(order: string[], results: ResultsLike): TargetReport {
  const m = resultMap(results);
  const target = order.find((id) => isRed(m.get(id)));
  const targetAt = target === undefined ? -1 : order.indexOf(target);
  const display: Record<string, SpecDisplay> = {};
  let passed = 0;
  order.forEach((id, i) => {
    const r = m.get(id);
    if (r?.pass) {
      passed++;
      display[id] = 'passed';
    } else if (id === target) display[id] = 'failed';
    else if (targetAt >= 0 && i > targetAt) display[id] = 'not-yet';
    else display[id] = 'not-run';
  });
  return { target, display, passed, total: order.length };
}

/** "count_words('a  b') returns {'': 1}" / "... raises KeyError: 'x'" / "... does not finish (infinite loop?)". */
export function actualLine(call: string, result: SpecResult | string): string {
  if (typeof result === 'string') return `${call} returns ${result}`;
  if (result.status === 'timeout') return `${call} does not finish (infinite loop?)`;
  if (result.actual !== undefined && !result.error) return `${call} returns ${result.actual}`;
  if (result.error) return `${call} raises ${result.error}`;
  return `${call} returns ${result.actual ?? 'nothing'}`;
}

export interface LadderLine {
  id: string;
  title: string;
  display: SpecDisplay;
}

export interface VisibleLadder {
  /** Titles the learner may see, in ladder order (empty for minimal and solo). */
  titles: LadderLine[];
  /** 'n of m behaviours pass'. */
  summary: string;
  passed: number;
  total: number;
  /** Title of the target spec when it is visible (tempo bar: '3/5 · next: <title>'). */
  next?: string;
  /** minimal / solo: the failing target's call and the learner's actual result, never the expected value. */
  target?: { id: string; call: string; actual: string; text: string };
}

/**
 * FADING (Task.fade): full shows every title; partial shows the next title only, revealing each
 * later one once every spec before it has been green; minimal and solo show 'n of m behaviours
 * pass' plus the failing target's call and actual result.
 */
export function visibleTitles(fade: FadeLevel, state: Pick<TaskSpecState, 'specs' | 'greenAt' | 'last'>): VisibleLadder {
  const order = state.specs.map((s) => s.id);
  const results = state.last ?? {};
  const rep = targetSpec(order, results);
  const out: VisibleLadder = {
    titles: [],
    summary: `${rep.passed} of ${rep.total} behaviours pass`,
    passed: rep.passed,
    total: rep.total,
  };
  const line = (s: SpecItem): LadderLine => ({ id: s.id, title: s.title, display: rep.display[s.id] ?? 'not-run' });
  if (fade === 'full') out.titles = state.specs.map(line);
  else if (fade === 'partial') {
    let shown = 0;
    while (shown < state.specs.length && (shown === 0 || state.greenAt[state.specs[shown - 1].id] !== undefined)) shown++;
    out.titles = state.specs.slice(0, shown).map(line);
  }
  if (rep.target !== undefined) {
    const spec = state.specs.find((s) => s.id === rep.target)!;
    if (out.titles.some((t) => t.id === rep.target)) out.next = spec.title;
    if (fade === 'minimal' || fade === 'solo') {
      const r = resultMap(results).get(rep.target)!;
      const actual = r.status === 'timeout' ? TIMEOUT_TEXT : (r.error ?? r.actual ?? '');
      out.target = { id: spec.id, call: spec.call, actual, text: actualLine(spec.call, r) };
    }
  } else if (fade !== 'minimal' && fade !== 'solo') {
    const firstOpen = state.specs.find((s) => !resultMap(results).get(s.id)?.pass && out.titles.some((t) => t.id === s.id));
    if (firstOpen) out.next = firstOpen.title;
  }
  return out;
}

/**
 * Weight of the 'spec' evidence when a spec first turns green: full only within 3 saves since it
 * went red and with the function not assisted (hint, reveal); otherwise .3.
 */
export function specEvidenceWeight(savesSinceRed: number | undefined, assisted: boolean): number {
  return (savesSinceRed ?? 0) <= 3 && !assisted ? 1 : 0.3;
}

/**
 * Hidden-spec failure card: the call and the learner's actual result, never the expected value.
 * 'Passes your checks but not count_words('a  b'): you return {'': 1, 'a': 1, 'b': 1}. What did you assume about the input?'
 */
export function hiddenFailureCard(spec: SpecItem, actual: SpecResult | string): string {
  const call = spec.call.trim();
  let what: string;
  if (typeof actual === 'string') what = `you return ${actual}`;
  else if (actual.status === 'timeout') what = 'it does not finish (infinite loop?)';
  else if (actual.error && actual.actual === undefined) what = `it raises ${actual.error}`;
  else what = `you return ${actual.actual ?? 'nothing'}`;
  return `Passes your checks but not ${call}: ${what}. What did you assume about the input?`;
}

/** Exception class name of a result: the harness's field, else the 'Name: message' prefix. */
function exceptionOf(r: HarnessSpecResult): string | undefined {
  if (r.exception) return r.exception;
  const m = r.error ? /^([A-Za-z_$][\w$.]*)(?::|$)/.exec(r.error) : null;
  return m ? m[1].split('.').pop() : undefined;
}

/**
 * The failureSignature a red result matches: the harness's own match (same equality as the spec)
 * when it reported one; otherwise the exception name, or the typed / printed value compared with
 * the signature literal.
 */
export function signatureMatch(result: SpecResult, spec: SpecItem, lang?: Lang): FailureSignature | undefined {
  const r = result as HarnessSpecResult;
  if (r.pass || r.status === 'not-run' || r.status === 'timeout') return undefined;
  const sigs = spec.failureSignatures ?? [];
  if (r.sig !== undefined) return sigs[r.sig];
  const exc = r.actual === undefined ? exceptionOf(r) : undefined;
  for (const sig of sigs) {
    if (sig.match === 'error') {
      if (exc && exc === sig.value.trim().split('.').pop()) return sig;
      continue;
    }
    if (r.actual === undefined) continue;
    if (sameLiteral(r, sig.value, lang)) return sig;
  }
  return undefined;
}

function sameLiteral(r: HarnessSpecResult, literal: string, lang: Lang | undefined): boolean {
  const norm = (s: string) => s.replace(/\s+/g, '');
  if (r.actual !== undefined && norm(r.actual) === norm(literal)) return true;
  const langs: Lang[] = lang ? [lang] : ['python', 'javascript'];
  for (const l of langs) {
    try {
      const want = parseLiteral(literal, l, 'repr');
      const got = r.val ?? parseLiteral(r.actual ?? '', l, 'repr');
      if (valEquals(got, want, { strict: false })) return true;
    } catch {
      // not a literal in this language
    }
  }
  return false;
}

// =====================================================================================
// Interface mapping (spec V1-11 ATTACHING)
// =====================================================================================

export interface LearnerFunction {
  name: string;
  arity: number;
}

export interface InterfaceMapping {
  ok: boolean;
  /** Interface name -> learner's name, only for functions they named differently. */
  mappedNames: Record<string, string>;
  /** DESIGN_DIFFERS when some interface function has no counterpart. */
  reason?: string;
}

/** Split on top-level commas (brackets, and TS type arguments, nest). */
function splitParams(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c) && !(c === '>' && text[i - 1] === '=')) depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Positional parameter count of a parameter list (self/cls, *args, **kwargs, ...rest, this: T excluded). */
export function countParams(params: string): number {
  return splitParams(params).filter((p, i) => {
    if (p === '*' || p === '/' || p.startsWith('*') || p.startsWith('...')) return false;
    if (/^this\s*:/.test(p)) return false;
    if (i === 0 && /^(?:self|cls)\b\s*(?:[:=,]|$)/.test(p)) return false;
    return true;
  }).length;
}

/** Arity of a signature such as 'parse_args(argv) -> dict' or 'parseArgs(argv: string[]): Args'; -1 if unreadable. */
export function arityOf(signature: string): number {
  const open = signature.indexOf('(');
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < signature.length; i++) {
    if (signature[i] === '(') depth++;
    else if (signature[i] === ')' && --depth === 0) return countParams(signature.slice(open + 1, i));
  }
  return -1;
}

/**
 * Map each interface function to the learner's: the exact name, else the unique function of the
 * same arity in the interface file. Never forces a rename. With no functions written yet nothing
 * differs, so the mapping is ok and empty.
 */
export function mapInterface(iface: TaskInterface, learnerFunctions: LearnerFunction[]): InterfaceMapping {
  const mappedNames: Record<string, string> = {};
  if (!learnerFunctions.length) return { ok: true, mappedNames };
  const ifaceNames = new Set(iface.functions.map((f) => f.name));
  const have = new Set(learnerFunctions.map((f) => f.name));
  const used = new Set<string>();
  for (const f of iface.functions) {
    if (have.has(f.name)) continue;
    const arity = arityOf(f.signature || `${f.name}()`);
    const cands = learnerFunctions.filter((l) => l.arity === arity && arity >= 0 && !ifaceNames.has(l.name) && !used.has(l.name));
    const unique = [...new Set(cands.map((c) => c.name))];
    if (unique.length !== 1) return { ok: false, mappedNames, reason: DESIGN_DIFFERS };
    mappedNames[f.name] = unique[0];
    used.add(unique[0]);
  }
  return { ok: true, mappedNames };
}

/** Spec calls rewritten to the learner's function names (calls.ts renameCallee). */
export function rewriteSpecCalls(specs: SpecItem[], mappedNames: Record<string, string>): SpecItem[] {
  return specs.map((s) => {
    const callee = /^\s*([A-Za-z_$\p{L}][\w$\p{L}\p{N}]*)/u.exec(s.call)?.[1];
    const to = callee !== undefined ? mappedNames[callee] : undefined;
    return to ? { ...s, call: renameCallee(s.call, to) } : s;
  });
}

// =====================================================================================
// Spec validation (spec V1-11 CALL AND EXPECTED VALIDATION)
// =====================================================================================

export interface DroppedSpec {
  id: string;
  reason: string;
}

const ERROR_NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** JSON text for a JS literal, or undefined when JSON cannot say it (undefined, NaN, bigint, Map...). */
function valToJson(v: Val): { ok: true; value: unknown } | { ok: false } {
  switch (v.t) {
    case 'str':
    case 'bool':
      return { ok: true, value: v.v };
    case 'num':
      return typeof v.v === 'number' ? { ok: true, value: v.v } : { ok: false };
    case 'null':
      return { ok: true, value: null };
    case 'list': {
      const out: unknown[] = [];
      for (const x of v.v) {
        const j = valToJson(x);
        if (!j.ok) return j;
        out.push(j.value);
      }
      return { ok: true, value: out };
    }
    case 'dict': {
      const out: Record<string, unknown> = {};
      for (const [k, x] of v.v) {
        if (k.t !== 'str' || k.v === '__proto__') return { ok: false };
        const j = valToJson(x);
        if (!j.ok) return j;
        out[k.v] = j.value;
      }
      return { ok: true, value: out };
    }
    default:
      return { ok: false };
  }
}

/**
 * An expected literal as the harness will read it: Python text that ast.literal_eval accepts, or
 * JSON for JS/TS (a JSON5-style literal such as {a: 1} is converted). Undefined when invalid.
 */
export function normalizeExpected(text: string, lang: Lang): string | undefined {
  const t = (text ?? '').trim();
  if (!t) return undefined;
  if (lang === 'python') {
    try {
      parseLiteral(t, 'python', 'source');
      return t;
    } catch {
      return undefined;
    }
  }
  try {
    JSON.parse(t);
    return t;
  } catch {
    // not JSON: maybe a JS literal JSON can still express
  }
  try {
    const j = valToJson(parseLiteral(t, lang, 'source'));
    return j.ok ? JSON.stringify(j.value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every spec call goes through validateCall (one call to an interface function, literal
 * arguments only) and every expected value through the literal parser before anything is stored.
 * Invalid specs are dropped; invalid failure signatures are dropped from their spec.
 */
export function validateSpecs(items: SpecItem[], iface: TaskInterface, lang: Lang, seenIds: Set<string> = new Set()): { kept: SpecItem[]; dropped: DroppedSpec[] } {
  const names = iface.functions.map((f) => f.name);
  const kept: SpecItem[] = [];
  const dropped: DroppedSpec[] = [];
  for (const raw of items ?? []) {
    const id = String(raw?.id ?? '').trim().replace(/\s+/g, '-');
    if (!id || seenIds.has(id)) {
      dropped.push({ id: id || '(no id)', reason: id ? 'duplicate id' : 'missing id' });
      continue;
    }
    const check = validateCall(String(raw.call ?? ''), lang, names);
    if (!check.ok || !check.call) {
      dropped.push({ id, reason: `call: ${check.error ?? 'invalid'}` });
      continue;
    }
    const expectError = String(raw.expectError ?? '').trim();
    let expected = '';
    if (expectError) {
      if (!ERROR_NAME.test(expectError)) {
        dropped.push({ id, reason: `expectError is not an exception name: ${clip(expectError, 40)}` });
        continue;
      }
    } else {
      const e = normalizeExpected(String(raw.expected ?? ''), lang);
      if (e === undefined) {
        dropped.push({ id, reason: `expected is not a ${lang === 'python' ? 'Python literal' : 'JSON value'}` });
        continue;
      }
      expected = e;
    }
    const failureSignatures: FailureSignature[] = [];
    for (const sig of Array.isArray(raw.failureSignatures) ? raw.failureSignatures : []) {
      if (!sig || typeof sig !== 'object') continue;
      const value = String(sig.value ?? '').trim();
      let v: string | undefined;
      if (sig.match === 'error') v = ERROR_NAME.test(value) ? value : undefined;
      else if (sig.match === 'equals') v = normalizeExpected(value, lang);
      if (v === undefined) continue;
      failureSignatures.push({ match: sig.match, value: v, misconceptionId: String(sig.misconceptionId ?? ''), nudge: String(sig.nudge ?? '') });
    }
    seenIds.add(id);
    kept.push({
      id,
      title: String(raw.title ?? '').trim() || id,
      conceptId: String(raw.conceptId ?? ''),
      call: check.call,
      expected,
      expectError,
      parSec: typeof raw.parSec === 'number' && Number.isFinite(raw.parSec) && raw.parSec > 0 ? raw.parSec : 60,
      failureSignatures,
    });
  }
  return { kept, dropped };
}

// =====================================================================================
// Top-level chunks and function ranges (regex fallback for executeDocumentSymbolProvider)
// =====================================================================================

/** 0-based inclusive line range of a top-level definition. */
export interface FunctionRange {
  name: string;
  startLine: number;
  endLine: number;
  arity?: number;
}

type ChunkKind = 'function' | 'class' | 'import' | 'main' | 'exports' | 'assign' | 'other';

interface Chunk {
  kind: ChunkKind;
  name?: string;
  start: number;
  end: number;
  arity?: number;
  exported?: boolean;
  /** JS: bindings the chunk declares (import names, destructured names). */
  declares?: string[];
}

const isJs = (lang: Lang): boolean => lang !== 'python';

/**
 * Python source with comments and string contents blanked (newlines kept), plus whether each
 * line starts at statement level (outside brackets, strings and backslash continuations).
 */
function scanPython(src: string): { code: string; clean: boolean[] } {
  let code = '';
  const clean: boolean[] = [true];
  let depth = 0;
  let i = 0;
  let cont = false;
  const n = src.length;
  const newline = (inString: boolean) => {
    clean.push(!inString && depth === 0 && !cont);
    cont = false;
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      code += c;
      newline(false);
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      code += ' ';
      cont = true;
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') {
        code += ' ';
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const q = src.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      code += q;
      i += q.length;
      while (i < n && !src.startsWith(q, i)) {
        // A backslash keeps the next character inside the string, raw strings included.
        if (src[i] === '\\' && i + 1 < n) {
          code += src[i + 1] === '\n' ? ' \n' : '  ';
          if (src[i + 1] === '\n') newline(true);
          i += 2;
          continue;
        }
        if (src[i] === '\n') {
          if (q.length === 1) break; // unterminated: stop at the line end
          code += '\n';
          newline(true);
        } else code += ' ';
        i++;
      }
      if (src.startsWith(q, i)) {
        code += q;
        i += q.length;
      }
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    code += c;
    i++;
  }
  return { code, clean };
}

/** JS/TS source with comments, string, template and regex contents blanked (newlines kept). */
function stripJsCode(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  let lastSig = '';
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const j = src.indexOf('\n', i);
      const end = j < 0 ? n : j;
      out += blank(src.slice(i, end));
      i = end;
    } else if (c === '/' && d === '*') {
      const j = src.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      out += blank(src.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let braces = 0;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (c !== '`' && (ch === c || ch === '\n')) break;
        if (c === '`') {
          if (ch === '$' && src[j + 1] === '{') {
            braces++;
            j += 2;
            continue;
          }
          if (ch === '}' && braces > 0) braces--;
          else if (ch === '`' && braces === 0) break;
        }
        j++;
      }
      const closed = j < n && src[j] === c;
      out += c + blank(src.slice(i + 1, Math.min(j, n))) + (closed ? c : '');
      i = closed ? j + 1 : j;
      lastSig = c;
    } else if (c === '/' && (lastSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || /\b(?:return|typeof|case|do|else|in|of|void|yield|await)\s*$/.test(out))) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== '\n') {
        const r = src[j];
        if (r === '\\') {
          j += 2;
          continue;
        }
        if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if (r === '/' && !cls) break;
        j++;
      }
      const closed = j < n && src[j] === '/';
      out += '/' + blank(src.slice(i + 1, Math.min(j, n))) + (closed ? '/' : '');
      i = closed ? j + 1 : j;
      lastSig = '/';
    } else {
      out += c;
      i++;
      if (!/\s/.test(c)) lastSig = c;
    }
  }
  return out;
}

/** Trim trailing blank / comment-only lines (blank in `code`) off [start, end]. */
function trimEnd(code: string[], start: number, end: number): number {
  while (end > start && !code[end].trim()) end--;
  return end;
}

function pyChunks(src: string): Chunk[] {
  const lines = src.split('\n');
  const { code: stripped, clean } = scanPython(src);
  const code = stripped.split('\n');
  const starts: number[] = [];
  let decorating = false; // decorators belong to the def/class that follows them
  for (let i = 0; i < code.length; i++) {
    const l = code[i];
    if (!clean[i] || !l.trim() || /^\s/.test(l)) continue;
    if (l.startsWith('@')) {
      if (!decorating) starts.push(i);
      decorating = true;
      continue;
    }
    if (!(decorating && /^(?:async\s+def|def|class)\b/.test(l))) starts.push(i);
    decorating = false;
  }
  return starts.map((s, k) => {
    const end = trimEnd(code, s, (k + 1 < starts.length ? starts[k + 1] : code.length) - 1);
    let head = s;
    while (head < end && code[head].startsWith('@')) head++;
    const first = code[head];
    const chunk: Chunk = { kind: 'other', start: s, end };
    let m: RegExpExecArray | null;
    if ((m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(first))) {
      chunk.kind = 'function';
      chunk.name = m[1];
      const text = code.slice(head, end + 1).join('\n');
      const open = text.indexOf('(');
      const close = matchParen(text, open);
      if (close > open) chunk.arity = countParams(text.slice(open + 1, close));
    } else if ((m = /^class\s+([A-Za-z_]\w*)/.exec(first))) {
      chunk.kind = 'class';
      chunk.name = m[1];
    } else if (/^(?:import|from)\s/.test(first)) chunk.kind = 'import';
    else if (/^if\s+(?:__name__\s*==\s*(['"])__main__\1|(['"])__main__\2\s*==\s*__name__)\s*:/.test(lines[head].trim())) chunk.kind = 'main';
    else if ((m = /^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/.exec(first))) {
      chunk.kind = 'assign';
      chunk.name = m[1];
    }
    return chunk;
  });
}

function matchParen(text: string, open: number): number {
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

const JS_CONT = /^[)\]}.,?:+\-*/%&|^=<>]/;

function jsChunks(src: string): Chunk[] {
  const code = stripJsCode(src).split('\n');
  const starts: number[] = [];
  let depth = 0;
  let decorating = false; // TS decorators belong to the class that follows them
  for (let i = 0; i < code.length; i++) {
    const l = code[i];
    if (depth === 0 && l.trim() && !/^\s/.test(l) && !JS_CONT.test(l)) {
      if (l.startsWith('@')) {
        if (!decorating) starts.push(i);
        decorating = true;
      } else {
        if (!decorating) starts.push(i);
        decorating = false;
      }
    }
    for (const c of l) {
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
    }
  }
  return starts.map((s, k) => {
    const end = trimEnd(code, s, (k + 1 < starts.length ? starts[k + 1] : code.length) - 1);
    let head = s;
    while (head < end && code[head].startsWith('@')) head++;
    const text = code.slice(head, end + 1).join('\n');
    const chunk: Chunk = { kind: 'other', start: s, end, exported: /^export\b/.test(text) };
    let m: RegExpExecArray | null;
    if ((m = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(text))) {
      chunk.kind = 'function';
      chunk.name = m[1];
      chunk.arity = jsArity(text, m[0].length);
    } else if ((m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=(?!=)/.exec(text)) && isFunctionInit(text.slice(m[0].length))) {
      chunk.kind = 'function';
      chunk.name = m[1];
      chunk.arity = jsArity(text, m[0].length);
    } else if ((m = /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(text))) {
      chunk.kind = 'class';
      chunk.name = m[1];
    } else if (/^import\s*[\w$*{]/.test(text) && !/^import\s*\(/.test(text)) {
      chunk.kind = 'import';
      chunk.declares = importBindings(text);
    } else if (/^if\s*\(/.test(text) && /require\.main|import\.meta\.main|process\.argv\[1\]/.test(text.slice(0, text.indexOf(')') + 1 || undefined))) {
      chunk.kind = 'main';
    } else if (/^(?:module\.exports\b|exports\.|export\s*(?:\{|\*|default\s+[A-Za-z_$][\w$]*\s*;?\s*$))/.test(text)) {
      chunk.kind = 'exports';
    } else if ((m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(text))) {
      chunk.kind = 'assign';
      chunk.name = m[1];
      chunk.declares = [m[1]];
    } else if ((m = /^(?:export\s+)?(?:const|let|var)\s*([{[][^=]*)=/.exec(text))) {
      chunk.kind = 'assign';
      chunk.declares = [...m[1].matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0]);
    }
    if (chunk.name && !chunk.declares) chunk.declares = [chunk.name];
    return chunk;
  });
}

/** An initialiser that is a function: `function`, `x =>`, `(a, b) =>`, `async (...) =>`, `<T>(x: T): T =>`. */
function isFunctionInit(rest: string): boolean {
  let s = rest.trimStart().replace(/^async\b\s*/, '');
  if (/^function\b/.test(s) || /^[A-Za-z_$][\w$]*\s*=>/.test(s)) return true;
  if (s.startsWith('<')) s = s.slice(s.indexOf('>') + 1).trimStart();
  if (!s.startsWith('(')) return false;
  const close = matchParen(s, 0);
  if (close < 0) return false;
  const after = s.slice(close + 1).trimStart();
  return after.startsWith('=>') || /^:[^;{}]*?=>/.test(after);
}

/** Parameter count of the function whose parameter list starts after `from` in stripped text. */
function jsArity(text: string, from: number): number | undefined {
  const rest = text.slice(from);
  const open = rest.indexOf('(');
  const arrow = rest.indexOf('=>');
  if (arrow >= 0 && (open < 0 || arrow < open)) return 1; // x => ...
  const close = matchParen(rest, open);
  return close > open ? countParams(rest.slice(open + 1, close)) : undefined;
}

function importBindings(text: string): string[] {
  const clause = /^import\s+(?:type\s+)?([\s\S]*?)\s+from\b/.exec(text)?.[1] ?? '';
  const names: string[] = [];
  const brace = /\{([\s\S]*)\}/.exec(clause);
  for (const part of (brace?.[1] ?? '').split(',')) {
    const p = part.trim().replace(/^type\s+/, '');
    if (!p) continue;
    const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(p);
    names.push(as ? as[1] : p.split(/\s/)[0]);
  }
  const outside = clause.replace(/\{[\s\S]*\}/, '');
  const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(outside);
  if (ns) names.push(ns[1]);
  const def = /^\s*([A-Za-z_$][\w$]*)/.exec(outside.replace(/\*\s*as\s+[A-Za-z_$][\w$]*/, ''));
  if (def) names.push(def[1]);
  return names;
}

function topLevelChunks(src: string, lang: Lang): Chunk[] {
  return isJs(lang) ? jsChunks(src) : pyChunks(src);
}

/** Top-level functions with 0-based line ranges: the fallback when no DocumentSymbol ranges are available. */
export function findTopLevelFunctions(source: string, lang: Lang): FunctionRange[] {
  return topLevelChunks(source, lang)
    .filter((c) => c.kind === 'function' && c.name)
    .map((c) => ({ name: c.name!, startLine: c.start, endLine: c.end, ...(c.arity !== undefined ? { arity: c.arity } : {}) }));
}

// =====================================================================================
// Reference and stub variants (spec V1-11 VERIFICATION)
// =====================================================================================

export type ModuleKind = 'esm' | 'cjs';

/** ESM or CommonJS for a JS/TS interface file: extension, package.json "type", then the file's own style. */
export function moduleKindFor(file: string, packageType: string | undefined, learnerSource: string | undefined): ModuleKind {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mjs' || ext === '.mts') return 'esm';
  if (ext === '.cjs' || ext === '.cts') return 'cjs';
  if (packageType === 'module') return 'esm';
  if (packageType === 'commonjs') return 'cjs';
  if (learnerSource) {
    const code = stripJsCode(learnerSource);
    const esm = /(?:^|[;}\n])\s*(?:export\b|import\s*[\w$*{'"])/.test(code);
    if (!esm && /\bmodule\.exports\b|\bexports\.[A-Za-z_$]|\brequire\s*\(/.test(code)) return 'cjs';
  }
  return 'esm';
}

function stubFor(name: string, lang: Lang): string {
  if (lang === 'python') return `def ${name}(*args, **kwargs):\n    raise NotImplementedError('${name}')`;
  if (lang === 'typescript') return `function ${name}(...args: any[]): any {\n  throw new Error('not implemented: ${name}');\n}`;
  return `function ${name}(...args) {\n  throw new Error('not implemented: ${name}');\n}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does JS/TS text export `name` (ESM forms, or CommonJS module.exports / exports.name)? */
function exportsName(text: string, name: string, kind: ModuleKind): boolean {
  const code = stripJsCode(text);
  const n = escapeRe(name);
  if (kind === 'esm') {
    return new RegExp(`\\bexport\\s+(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${n}\\b`).test(code)
      || new RegExp(`\\bexport\\s+(?:const|let|var|class)\\s+${n}\\b`).test(code)
      || new RegExp(`\\bexport\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`).test(code);
  }
  return new RegExp(`\\bmodule\\.exports\\s*=\\s*\\{[^}]*\\b${n}\\b`).test(code) || new RegExp(`\\b(?:module\\.)?exports\\.${n}\\s*=`).test(code);
}

/** Append an export for every interface function the text does not export yet. */
function ensureExports(text: string, names: string[], kind: ModuleKind): string {
  const missing = names.filter((n) => !exportsName(text, n, kind));
  if (!missing.length) return text;
  const lines = missing.map((n) => (kind === 'esm' ? `export { ${n} };` : `module.exports.${n} = ${n};`));
  return text.replace(/\s*$/, '\n') + '\n' + lines.join('\n') + '\n';
}

/** A chunk's text without its leading `export` / `export default` (exports are added once, at the end). */
function unexported(text: string): string {
  return text.replace(/^(\s*(?:@[^\n]*\n\s*)*)export\s+default\s+(?=(?:async\s+)?function\b|(?:abstract\s+)?class\b)/, '$1').replace(/^(\s*(?:@[^\n]*\n\s*)*)export\s+/, '$1');
}

interface MergeOptions {
  lang: Lang;
  names: string[];
  learner?: string;
  ranges?: FunctionRange[];
  kind: ModuleKind;
}

function chunkText(lines: string[], c: { start: number; end: number }): string {
  return lines.slice(c.start, c.end + 1).join('\n');
}

interface Insert {
  name?: string;
  text: string;
  /** An interface function (always kept: replaces the learner's or is appended). */
  iface: boolean;
  /** JS: bindings it declares; one the learner already declares is skipped (a duplicate is a SyntaxError). */
  declares?: string[];
}

/**
 * The learner's file with each insert put in place of the learner's top-level definition of the
 * same name (DocumentSymbol ranges first, the regex chunker otherwise); the rest are appended in
 * their own order. JS/TS exports are normalised: inserted chunks lose their `export`, and the
 * interface functions that end up unexported get one export statement each at the end.
 */
function mergeInto(o: MergeOptions, inserts: Insert[]): string {
  const js = isJs(o.lang);
  const learner = (o.learner ?? '').replace(/\r\n/g, '\n');
  const lines = learner.trim() ? learner.split('\n') : [];
  const chunks = lines.length ? topLevelChunks(learner, o.lang) : [];
  const rangeOf = (name: string, iface: boolean): { start: number; end: number } | undefined => {
    const r = iface ? o.ranges?.find((x) => x.name === name) : undefined;
    if (r && r.startLine >= 0 && r.endLine >= r.startLine && r.endLine < lines.length) return { start: r.startLine, end: r.endLine };
    const c = chunks.find((x) => x.name === name && (x.kind === 'function' || x.kind === 'class' || x.kind === 'assign'));
    return c ? { start: c.start, end: c.end } : undefined;
  };
  const edits: { start: number; end: number; text: string }[] = [];
  const appended: string[] = [];
  const overlaps = (r: { start: number; end: number }) => edits.some((e) => r.start <= e.end && e.start <= r.end);
  const learnerDeclares = new Set(chunks.flatMap((c) => c.declares ?? (c.name ? [c.name] : [])));
  for (const x of inserts) {
    const text = js ? unexported(x.text) : x.text;
    const r = x.name ? rangeOf(x.name, x.iface) : undefined;
    if (r && !overlaps(r)) {
      edits.push({ ...r, text });
      continue;
    }
    if (!x.iface) {
      if (js && (x.declares ?? []).some((d) => learnerDeclares.has(d))) continue; // keep the learner's import or constant
      if (!x.name && lines.some((l) => l.trim() === x.text.trim())) continue; // the same import line
    }
    appended.push(text);
  }
  for (const e of edits.sort((a, b) => b.start - a.start)) lines.splice(e.start, e.end - e.start + 1, ...e.text.split('\n'));
  let text = lines.join('\n').replace(/\s*$/, '');
  if (appended.length) text += (text ? '\n\n\n' : '') + appended.join('\n\n\n');
  text += '\n';
  return js ? ensureExports(text, o.names, o.kind) : text;
}

/**
 * The reference variant. When the learner's file defines none of the interface functions (or does
 * not exist), it is the reference itself (JS/TS: with exports normalised to the module kind);
 * otherwise the learner's file with the interface functions, and same-named helpers, replaced by
 * the reference's and the remaining reference helpers appended.
 */
function referenceVariant(reference: string, o: MergeOptions): string {
  const ref = reference.replace(/\r\n/g, '\n');
  const definesAny = !!o.learner?.trim()
    && o.names.some((n) => o.ranges?.some((r) => r.name === n) || topLevelChunks(o.learner!, o.lang).some((c) => c.name === n && c.kind === 'function'));
  if (!definesAny && !isJs(o.lang)) return ref.replace(/\s*$/, '\n');
  const refLines = ref.split('\n');
  const inserts: Insert[] = [];
  for (const c of topLevelChunks(ref, o.lang)) {
    if (c.kind === 'main' || c.kind === 'exports') continue; // its own entry code and export lists
    if (isJs(o.lang) && c.kind === 'other') continue; // top-level statements would fail the safety check
    const iface = !!c.name && o.names.includes(c.name) && (c.kind === 'function' || c.kind === 'class');
    inserts.push({ name: c.kind === 'import' ? undefined : c.name, text: chunkText(refLines, c), iface, declares: c.declares });
  }
  return mergeInto(definesAny ? o : { ...o, learner: undefined, ranges: undefined }, inserts);
}

/** The stub variant: the learner's file (or an empty one) with every interface function raising. */
function stubVariant(o: MergeOptions): string {
  return mergeInto(o, o.names.map((n) => ({ name: n, text: stubFor(n, o.lang), iface: true })));
}


export interface SpecLadderDraft {
  applicable: boolean;
  reason: string;
  specs: SpecItem[];
  hidden: SpecItem[];
  /** Private complete implementation, used only for verification. Never stored. */
  reference: string;
}

export interface VerificationPlan {
  /** Workspace-relative interface file. */
  file: string;
  /** Visible then hidden spec ids, in order. */
  ids: string[];
  hiddenIds: string[];
  referenceSource: string;
  /** Pure reference file: used when the learner's file around it does not load. */
  referenceOnlySource: string;
  stubSource: string;
  /** Stubs alone: used when the learner's current file does not load. */
  stubOnlySource: string;
  input: HarnessInput;
}

/**
 * Pure part of verification: the sources written as the interface file for the reference and stub
 * runs, and the spec input (every visible and hidden spec). `ladder` holds validated specs.
 */
export function buildVerificationPlan(
  ladder: SpecLadderDraft,
  iface: TaskInterface,
  o: { lang: Lang; learnerSource?: string; functionRanges?: FunctionRange[]; moduleKind?: ModuleKind; timeoutMs?: number; workspace?: string },
): VerificationPlan {
  const names = iface.functions.map((f) => f.name);
  const kind = o.moduleKind ?? 'esm';
  const merge: MergeOptions = { lang: o.lang, names, learner: o.learnerSource, ranges: o.functionRanges, kind };
  const empty: MergeOptions = { ...merge, learner: undefined, ranges: undefined };
  const all = [...ladder.specs, ...ladder.hidden];
  return {
    file: iface.file,
    ids: all.map((s) => s.id),
    hiddenIds: ladder.hidden.map((s) => s.id),
    referenceSource: referenceVariant(ladder.reference, merge),
    referenceOnlySource: referenceVariant(ladder.reference, empty),
    stubSource: stubVariant(merge),
    stubOnlySource: stubVariant(empty),
    input: buildHarnessInput(all, { workspace: o.workspace, timeoutMs: o.timeoutMs ?? SPEC_TIMEOUT_MS, functions: names }),
  };
}

// =====================================================================================
// verifySpecLadder (spec V1-11 VERIFICATION AT PREFETCH TIME)
// =====================================================================================

export interface VerifyFs {
  readdir(dir: string): Promise<{ name: string; isDirectory: boolean; isFile: boolean }[]>;
  stat(p: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean } | undefined>;
  readFile(p: string): Promise<string>;
  writeFile(p: string, text: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  mkdir(p: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  rm(p: string): Promise<void>;
  /** A directory link: a junction on win32 (no admin rights needed), a symlink elsewhere. */
  linkDir(target: string, linkPath: string): Promise<void>;
  /** Remove a link (not what it points to). */
  unlink(p: string): Promise<void>;
}

export const nodeVerifyFs: VerifyFs = {
  readdir: async (dir) => (await fsp.readdir(dir, { withFileTypes: true })).map((d) => ({ name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile() })),
  stat: async (p) => {
    try {
      const s = await fsp.stat(p);
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch {
      return undefined;
    }
  },
  readFile: (p) => fsp.readFile(p, 'utf8'),
  writeFile: (p, text) => fsp.writeFile(p, text, 'utf8'),
  copyFile: (a, b) => fsp.copyFile(a, b),
  mkdir: async (p) => void (await fsp.mkdir(p, { recursive: true })),
  mkdtemp: (prefix) => fsp.mkdtemp(prefix),
  rm: (p) => fsp.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  linkDir: (target, linkPath) => fsp.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir'),
  unlink: (p) => fsp.unlink(p),
};

export interface VerifyFailure {
  id: string;
  reason: string;
  /** The actual result (or error) of the failing run: what the repair prompt quotes. */
  actual?: string;
}

export interface VerifyDeps {
  /** runLearnerCode runs the harness in the learner-code profile; runtime.lang picks harness.py or harness.mjs. */
  runner: Runner;
  workspaceDir: string;
  /** media/harness. */
  harnessDir: string;
  /** Parent of the temp copies (e.g. globalStorageUri/verify); created on demand. */
  tmpRoot: string;
  fs?: VerifyFs;
  /** The interface file's current text (unsaved editor text); default: read from disk. */
  learnerSource?: string;
  /** Interface function ranges from executeDocumentSymbolProvider; the regex fallback otherwise. */
  functionRanges?: FunctionRange[];
  /** Per run; default 5 s (spec V1-11 RUNS). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** One low-effort repair call with the failing spec ids, reasons and actual values. */
  repair?: (failures: VerifyFailure[], signal?: AbortSignal) => Promise<SpecLadderDraft | undefined>;
  log?: (msg: string) => void;
}

export interface VerifyResult {
  applicable: boolean;
  /** The specs were run against a reference and a stub. */
  verified: boolean;
  reason?: string;
  specs: SpecItem[];
  hidden: SpecItem[];
  dropped: DroppedSpec[];
  /** Import time on the reference run (seeds the timeout extension). */
  importMs?: number;
  repaired: boolean;
}

/** Copy the workspace's source files (language globs, excluded dirs, 2 MB / 300 files). */
async function copyWorkspace(fs: VerifyFs, from: string, to: string, lang: Lang, first: string): Promise<{ files: number; bytes: number; truncated: boolean }> {
  const exts = SOURCE_EXT[isJs(lang) ? 'js' : 'python'];
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const copyOne = async (rel: string, size: number): Promise<boolean> => {
    if (files + 1 > COPY_MAX_FILES || bytes + size > COPY_MAX_BYTES) {
      truncated = true;
      return false;
    }
    await fs.mkdir(path.dirname(path.join(to, rel)));
    await fs.copyFile(path.join(from, rel), path.join(to, rel));
    files++;
    bytes += size;
    return true;
  };
  const firstStat = await fs.stat(path.join(from, first));
  if (firstStat?.isFile) await copyOne(first, firstStat.size);
  const queue = [''];
  while (queue.length && !truncated) {
    const dir = queue.shift()!;
    let entries: { name: string; isDirectory: boolean; isFile: boolean }[];
    try {
      entries = await fs.readdir(path.join(from, dir));
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = dir ? path.join(dir, e.name) : e.name;
      if (e.isDirectory) {
        if (!EXCLUDED_DIRS.has(e.name)) queue.push(rel);
        continue;
      }
      if (!e.isFile || !exts.includes(path.extname(e.name).toLowerCase())) continue;
      if (path.normalize(rel) === path.normalize(first)) continue;
      const st = await fs.stat(path.join(from, rel));
      if (!st?.isFile) continue;
      if (!(await copyOne(rel, st.size))) break;
    }
  }
  return { files, bytes, truncated };
}

function within(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Verify a spec ladder at prefetch time (spec V1-11): validate every call and expected value, then
 * in a temp copy of the workspace run all visible and hidden specs against the reference variant
 * (each must pass) and a stub variant (each must fail cleanly: failed, not timed out or crashed).
 * One repair call may fix failing specs; those still failing are dropped. Fewer than 3 visible
 * specs left: applicable = false. Temp dirs are deleted at once; the reference is never returned.
 */
export async function verifySpecLadder(ladder: SpecLadderDraft, iface: TaskInterface, deps: VerifyDeps): Promise<VerifyResult> {
  const lang = deps.runner.runtime.lang;
  const fs = deps.fs ?? nodeVerifyFs;
  const result: VerifyResult = { applicable: false, verified: false, specs: [], hidden: [], dropped: [], repaired: false };
  if (!ladder.applicable) return { ...result, reason: ladder.reason || 'the model marked this task not applicable' };
  if (!iface.functions.length) return { ...result, reason: 'the task interface names no functions' };
  if (!ladder.reference?.trim()) return { ...result, reason: 'no reference implementation to verify the specs against' };

  const seen = new Set<string>();
  const vis = validateSpecs(ladder.specs, iface, lang, seen);
  const hid = validateSpecs(ladder.hidden, iface, lang, seen);
  result.dropped.push(...vis.dropped, ...hid.dropped);
  if (vis.kept.length < MIN_SPECS) return { ...result, reason: `only ${vis.kept.length} valid specs (need ${MIN_SPECS})` };

  const ifaceAbs = path.resolve(deps.workspaceDir, iface.file);
  if (!within(ifaceAbs, path.resolve(deps.workspaceDir))) return { ...result, reason: `the interface file is outside the workspace: ${iface.file}` };
  const rel = path.relative(path.resolve(deps.workspaceDir), ifaceAbs);
  let learnerSource = deps.learnerSource;
  if (learnerSource === undefined && (await fs.stat(ifaceAbs))?.isFile) learnerSource = await fs.readFile(ifaceAbs).catch(() => undefined);
  let packageType: string | undefined;
  if (isJs(lang)) {
    try {
      packageType = JSON.parse(await fs.readFile(path.join(deps.workspaceDir, 'package.json')))?.type;
    } catch {
      packageType = undefined;
    }
  }
  const kind = moduleKindFor(iface.file, packageType, learnerSource);
  const timeoutMs = deps.timeoutMs ?? SPEC_TIMEOUT_MS;
  const script = path.join(deps.harnessDir, lang === 'python' ? 'harness.py' : 'harness.mjs');

  await fs.mkdir(deps.tmpRoot);
  const root = await fs.mkdtemp(path.join(deps.tmpRoot, 'v-'));
  const copy = path.join(root, 'ws');
  const nodeModules = path.join(path.resolve(deps.workspaceDir), 'node_modules');
  let linked: string | undefined;
  try {
    await fs.mkdir(copy);
    const copied = await copyWorkspace(fs, deps.workspaceDir, copy, lang, rel);
    deps.log?.(`verify: copied ${copied.files} files (${copied.bytes} bytes)${copied.truncated ? ', capped' : ''}`);
    if (isJs(lang) && (await fs.stat(nodeModules))?.isDirectory) {
      try {
        await fs.linkDir(nodeModules, path.join(copy, 'node_modules'));
        linked = path.join(copy, 'node_modules');
      } catch (e) {
        deps.log?.(`verify: node_modules link failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const moduleFile = path.join(copy, rel);
    const specFile = path.join(root, 'specs.json');
    await fs.mkdir(path.dirname(moduleFile));
    // Node resolves packages through the link to their real path, which must be readable too.
    const readDirs = linked ? [root, nodeModules] : [root];

    const run = async (source: string, specs: SpecItem[]): Promise<HarnessRun> => {
      deps.signal?.throwIfAborted();
      await fs.writeFile(moduleFile, source);
      await fs.writeFile(specFile, JSON.stringify(buildHarnessInput(specs, { workspace: copy, timeoutMs, functions: iface.functions.map((f) => f.name) })));
      const r = await deps.runner.runLearnerCode(script, [moduleFile, specFile], { workspaceDir: copy, readDirs, timeoutMs, signal: deps.signal });
      return parseHarnessOutput(r.stdout, r.stderr, r.timedOut, { ids: specs.map((s) => s.id) });
    };

    /** Runs both variants for `specs`; returns the ids that passed both checks and the failures. */
    const verifyOnce = async (specs: SpecItem[], reference: string): Promise<{ ok: Set<string>; failures: VerifyFailure[]; importMs?: number }> => {
      const draft: SpecLadderDraft = { applicable: true, reason: '', specs, hidden: [], reference };
      const plan = buildVerificationPlan(draft, iface, { lang, learnerSource, functionRanges: deps.functionRanges, moduleKind: kind, timeoutMs });
      // A load problem (or crash) may come from the learner's code around the functions: retry alone.
      const blocked = (r: HarnessRun) => !!r.loadError && r.loadError.kind !== 'not-exported';
      let ref = await run(plan.referenceSource, specs);
      if (blocked(ref) && plan.referenceOnlySource !== plan.referenceSource) ref = await run(plan.referenceOnlySource, specs);
      let stub = await run(plan.stubSource, specs);
      if (blocked(stub) && plan.stubOnlySource !== plan.stubSource) stub = await run(plan.stubOnlySource, specs);
      const ok = new Set<string>();
      const failures: VerifyFailure[] = [];
      const loadNote = (r: HarnessRun) => (r.loadError ? ` (${clip(r.loadError.message, 120)})` : '');
      for (const s of specs) {
        const r = ref.results.find((x) => x.id === s.id);
        if (!r?.pass) {
          const why = r?.status === 'timeout' ? 'times out on the reference'
            : r?.status === 'not-run' ? `did not run on the reference${loadNote(ref)}` : 'fails on the reference';
          failures.push({ id: s.id, reason: why, actual: r?.error ?? r?.actual });
          continue;
        }
        // Failed cleanly: a red result of its own, not a timeout, a crash or a harness complaint.
        const u = stub.results.find((x) => x.id === s.id);
        const clean = !!u && u.status === 'ok' && !u.pass && !/^Bad(?:Call|Expected):|harness crashed/.test(u.error ?? '');
        if (!clean) {
          const why = u?.pass ? 'passes on an empty stub'
            : `does not fail cleanly on a stub${u?.status === 'timeout' ? ' (timeout)' : u?.status === 'not-run' ? loadNote(stub) : ''}`;
          failures.push({ id: s.id, reason: why, actual: u?.error ?? u?.actual });
          continue;
        }
        ok.add(s.id);
      }
      return { ok, failures, importMs: ref.importMs };
    };

    const hiddenIds = new Set(hid.kept.map((s) => s.id));
    const all = [...vis.kept, ...hid.kept];
    const first = await verifyOnce(all, ladder.reference);
    result.verified = true;
    result.importMs = first.importMs;
    const final = new Map<string, SpecItem>(all.filter((s) => first.ok.has(s.id)).map((s) => [s.id, s]));
    let failures = first.failures;
    if (failures.length && deps.repair) {
      let fixed: SpecLadderDraft | undefined;
      try {
        fixed = await deps.repair(failures, deps.signal);
      } catch (e) {
        // A usage limit fails the TaskPrep job, so the queue pauses and retries it.
        if (deps.signal?.aborted || isLimitError(e)) throw e;
        deps.log?.(`verify: repair failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (fixed) {
        result.repaired = true;
        const failing = new Set(failures.map((f) => f.id));
        const pick = (list: SpecItem[] | undefined) => (list ?? []).filter((s) => failing.has(String(s?.id ?? '').trim()));
        const taken = new Set(final.keys());
        const rv = validateSpecs(pick(fixed.specs).filter((s) => !hiddenIds.has(String(s.id).trim())), iface, lang, taken);
        const rh = validateSpecs(pick(fixed.hidden).filter((s) => hiddenIds.has(String(s.id).trim())), iface, lang, taken);
        const retry = [...rv.kept, ...rh.kept];
        const stillFailing = failures.filter((f) => !retry.some((s) => s.id === f.id));
        if (retry.length) {
          const second = await verifyOnce(retry, fixed.reference?.trim() ? fixed.reference : ladder.reference);
          for (const s of retry) if (second.ok.has(s.id)) final.set(s.id, s);
          failures = [...stillFailing, ...second.failures];
        } else failures = stillFailing;
      }
    }
    result.dropped.push(...failures.map((f) => ({ id: f.id, reason: f.reason + (f.actual ? ` (actual: ${clip(f.actual, 80)})` : '') })));
    // Original ladder order; a repaired spec keeps its place.
    result.specs = vis.kept.map((s) => final.get(s.id)).filter((s): s is SpecItem => !!s);
    result.hidden = hid.kept.map((s) => final.get(s.id)).filter((s): s is SpecItem => !!s);
    result.applicable = result.specs.length >= MIN_SPECS;
    if (!result.applicable) result.reason = `only ${result.specs.length} specs survived verification (need ${MIN_SPECS})`;
    return result;
  } finally {
    // Remove the node_modules link itself first, so nothing can ever reach the real folder.
    if (linked) await fs.unlink(linked).catch(() => undefined);
    await fs.rm(root).catch(() => undefined);
  }
}
