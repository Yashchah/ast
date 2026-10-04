import { createHash } from 'node:crypto';
import * as nodePath from 'node:path';
import type { Annotation, HintPrefetch, Lang } from './contracts';
import type { HintLadder } from './schemas';
import type { AnnotationSink } from './annotations';
import { routeText } from './annotationModel';
import { Emitter, type Event } from './jobs';
import { parseException } from './runner';

/**
 * Prefetched hint ladder anchored on the learner's line (spec V1-10).
 *
 * Pure (no vscode import): the prefetch gates, the four staleness rules, the unused cap, post-parse
 * validation, anchor re-resolution, the local rung-0 detector, the HINTLADDER prompt text and the
 * HintDisplay, which draws through an AnnotationSink (src/annotations.ts LineAnnotationManager).
 * The model call itself (a HintLadderSchema job on the JobQueue) belongs to the coach.
 */

const SEC = 1000;
const MIN = 60 * SEC;

/** Speculative prefetch fires at this stuck score. */
export const PREFETCH_SCORE = 0.6;
/** Stop prefetching after this many unused prefetches in one task. */
export const MAX_UNUSED_PREFETCHES = 2;
/** A prefetch is stale after this many changed lines (Monitor edit counter). */
export const STALE_LINES = 20;
/** Rung 0: a diagnostics error must persist this long. */
export const RUNG0_DIAGNOSTIC_MS = 1 * MIN;
/** Job parameters for the coach: speculative prefetch vs the on-demand call on a miss. */
export const HINT_JOB = { priority: 2, effortSpeculative: 'medium', effortOnDemand: 'low', kind: 'hint', scope: 'task' } as const;

export type ProactiveMode = 'offer' | 'auto' | 'off';

// =====================================================================================
// Keys and hashes
// =====================================================================================

/** Job and prefetch key: the task only. Cursor moves and minute ticks never change it. */
export function prefetchKey(taskId: string): string {
  return `hint:${taskId}`;
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** One error, as it enters the error set: file and message (line numbers excluded, so a moved error is the same error). */
export function errorKey(e: string | { file: string; message: string }): string {
  const s = typeof e === 'string' ? e : `${e.file}: ${e.message}`;
  return s.replace(/\s+/g, ' ').trim();
}

function sortedErrorKeys(errors: readonly (string | { file: string; message: string })[]): string[] {
  return [...new Set(errors.map(errorKey))].sort();
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** Hash of the sorted, de-duplicated error set. */
export function errorHash(errors: readonly (string | { file: string; message: string })[]): string {
  return sha1(sortedErrorKeys(errors).join('\n'));
}

/**
 * contentHash = sha1 of the task files' text (CRLF normalised) plus the sorted error set.
 * Computed from the files themselves, never from the rendered prompt (which embeds <<CURSOR>>
 * and 'N min ago' notes). Used only to avoid re-firing for an identical state.
 */
export function contentHash(
  files: readonly { key: string; text: string }[],
  errors: readonly (string | { file: string; message: string })[],
): string {
  const h = createHash('sha1');
  for (const f of [...files].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    h.update(`${f.key}\n`, 'utf8');
    h.update(normalizeEol(f.text), 'utf8');
    h.update('\n\u0000\n', 'utf8');
  }
  h.update('#errors\n', 'utf8');
  h.update(sortedErrorKeys(errors).join('\n'), 'utf8');
  return h.digest('hex');
}

// =====================================================================================
// Anchor re-resolution
// =====================================================================================

export interface HintAnchor {
  file: string;
  /** 1-based. */
  line: number;
  lineText?: string;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Minimum length for the containment fallback (a model that trimmed a trailing comment). */
const CONTAINS_MIN = 12;

/**
 * 0-based line of the anchor in `lines`: the line whose text matches lineText (whitespace
 * collapsed) nearest to the original line, ties going to the earlier line. Without lineText the
 * original line is used when it exists. Undefined when the text is no longer in the file.
 */
export function resolveAnchor(lines: readonly string[], anchor: Pick<HintAnchor, 'line' | 'lineText'>): number | undefined {
  const want = norm(anchor.lineText ?? '');
  const orig = Number.isFinite(anchor.line) ? Math.round(anchor.line) - 1 : 0;
  if (!want) return orig >= 0 && orig < lines.length ? orig : undefined;
  const nearest = (hit: (l: string) => boolean): number | undefined => {
    let best: number | undefined;
    for (let i = 0; i < lines.length; i++) {
      if (!hit(lines[i])) continue;
      if (best === undefined || Math.abs(i - orig) < Math.abs(best - orig)) best = i;
    }
    return best;
  };
  const exact = nearest((l) => norm(l) === want);
  if (exact !== undefined || want.length < CONTAINS_MIN) return exact;
  return nearest((l) => norm(l).includes(want));
}

// =====================================================================================
// Staleness, gates and the unused cap
// =====================================================================================

export type StaleReason = 'task-changed' | 'anchor-gone' | 'errors-changed' | 'lines-changed';

export interface StaleInput {
  /** Current task id. */
  taskId: string | undefined;
  /** errorHash() of the current error set. */
  errorHash: string;
  /** Lines changed since the prefetch landed (Monitor edit counter). Undefined = unknown (rule skipped). */
  linesChanged?: number;
  /** Current lines of the anchor file; undefined when the file cannot be read. */
  anchorLines?: readonly string[];
}

/**
 * The four staleness rules. Any one makes the prefetch invalid:
 * the task changed; the anchor's lineText is no longer in the file; the error set changed;
 * 20 or more lines changed since the prefetch.
 */
export function staleReason(p: HintPrefetch, s: StaleInput, staleLines = STALE_LINES): StaleReason | undefined {
  if (!s.taskId || p.key !== prefetchKey(s.taskId)) return 'task-changed';
  if (!s.anchorLines || resolveAnchor(s.anchorLines, p.anchor) === undefined) return 'anchor-gone';
  if (s.errorHash !== p.errorHash) return 'errors-changed';
  if (s.linesChanged !== undefined && s.linesChanged >= staleLines) return 'lines-changed';
  return undefined;
}

export interface PrefetchGate {
  taskId: string | undefined;
  /** signals.score */
  score: number;
  /** deliberate.proactiveHints */
  mode: ProactiveMode | string;
  /** The task has a prefetch that passed staleReason() (used or not). */
  hasValidPrefetch: boolean;
  /** jobs.has(prefetchKey(taskId)): a hint job (speculative or on demand) is in flight. */
  inFlight?: boolean;
  /** Hint reserve left this hour (stats.hintLimit - stats.hintUsed); undefined = unknown. */
  hintBudgetLeft?: number;
  /** Task phase; prefetch only while building. Undefined = not checked. */
  phase?: string;
}

interface TaskPrefetchState {
  lastFiredHash?: string;
  unused: number;
  inFlight: boolean;
  /** Edit-counter mark and error hash when the job in flight fired (the state the model saw). */
  fired?: { hash: string; mark?: number; errorHash?: string };
  /** Monitor edit-counter mark of the current prefetch. */
  mark?: number;
  /** Prefetch currently counted as live (so discard() counts it once). */
  live?: HintPrefetch;
}

export interface PrefetcherOptions {
  threshold?: number;
  maxUnused?: number;
  staleLines?: number;
}

/**
 * Speculative prefetch bookkeeping per task (in memory; a window reload starts the counters over).
 *
 * Coach wiring, on each tick while building (see the notes in the stage-2 report):
 *   1. if (t.hintPrefetch && pf.check(t.hintPrefetch, {...})) { pf.discard(t.hintPrefetch); t.hintPrefetch = undefined }
 *   2. if (pf.wants({...})) { const h = await monitor.taskFileHash(t.files);
 *        if (pf.tryFire(t.id, h, { mark: monitor.mark(), errorHash: monitor.errorSetHash() })) fire the job }
 *   3. job apply: t.hintPrefetch = pf.accept(ladder, { taskId: t.id, now: Date.now() })
 *   4. job settled (any outcome): pf.settled(t.id)
 */
export class HintPrefetcher {
  private readonly tasks = new Map<string, TaskPrefetchState>();
  readonly threshold: number;
  readonly maxUnused: number;
  readonly staleLines: number;

  constructor(opts: PrefetcherOptions = {}) {
    this.threshold = opts.threshold ?? PREFETCH_SCORE;
    this.maxUnused = opts.maxUnused ?? MAX_UNUSED_PREFETCHES;
    this.staleLines = opts.staleLines ?? STALE_LINES;
  }

  private state(taskId: string): TaskPrefetchState {
    let s = this.tasks.get(taskId);
    if (!s) this.tasks.set(taskId, (s = { unused: 0, inFlight: false }));
    return s;
  }

  /** Why no speculative prefetch fires now (undefined = the cheap gates pass). */
  whyNot(g: PrefetchGate): string | undefined {
    if (!g.taskId) return 'no task';
    if (g.phase !== undefined && g.phase !== 'building') return 'not building';
    if (g.mode === 'off') return 'proactive hints off';
    if (!(g.score >= this.threshold)) return 'score below threshold';
    if (g.hasValidPrefetch) return 'valid prefetch exists';
    const s = this.tasks.get(g.taskId);
    if (g.inFlight || s?.inFlight) return 'hint job in flight';
    if ((s?.unused ?? 0) >= this.maxUnused) return 'unused cap reached';
    if (g.hintBudgetLeft !== undefined && g.hintBudgetLeft <= 0) return 'hint reserve used up';
    return undefined;
  }

  /** Cheap gates, checked before the content hash is computed. */
  wants(g: PrefetchGate): boolean {
    return this.whyNot(g) === undefined;
  }

  /**
   * Final gate with the content hash: fires only when it differs from the last fired one.
   * On true, the task is marked in flight and the hash remembered.
   */
  tryFire(taskId: string, hash: string, at: { mark?: number; errorHash?: string } = {}): boolean {
    const s = this.state(taskId);
    if (s.inFlight || s.unused >= this.maxUnused || s.lastFiredHash === hash) return false;
    s.inFlight = true;
    s.lastFiredHash = hash;
    s.fired = { hash, mark: at.mark, errorHash: at.errorHash };
    return true;
  }

  /** The job settled (done, dropped, stale, error). Always call it. */
  settled(taskId: string): void {
    const s = this.tasks.get(taskId);
    if (!s) return;
    s.inFlight = false;
    s.fired = undefined;
  }

  inFlight(taskId: string): boolean {
    return this.tasks.get(taskId)?.inFlight ?? false;
  }

  unusedCount(taskId: string): number {
    return this.tasks.get(taskId)?.unused ?? 0;
  }

  /** Edit-counter mark taken when the task's current prefetch landed. */
  markOf(taskId: string): number | undefined {
    return this.tasks.get(taskId)?.mark;
  }

  /**
   * Validate a parsed ladder and build the HintPrefetch to store (Task.hintPrefetch).
   * Rungs 1 and 2 that do not end with '?' or contain a code fence are dropped ('' = served on
   * demand). Undefined when no rung survives.
   * contentHash, errorHash and mark default to the values given to tryFire() (the state the model
   * saw); an on-demand ladder, which never went through tryFire(), passes them itself.
   */
  accept(
    ladder: HintLadder,
    ctx: { taskId: string; now: number; contentHash?: string; errorHash?: string; mark?: number },
  ): HintPrefetch | undefined {
    const s = this.state(ctx.taskId);
    const fired = s.fired;
    const p = ladderToPrefetch(ladder, {
      taskId: ctx.taskId,
      now: ctx.now,
      contentHash: ctx.contentHash ?? fired?.hash ?? '',
      errorHash: ctx.errorHash ?? fired?.errorHash ?? '',
    });
    if (!p) return undefined;
    if (s.live && s.live !== p && !s.live.used) s.unused++; // replaced before use
    s.live = p;
    s.mark = ctx.mark ?? fired?.mark;
    return p;
  }

  /**
   * Run the staleness rules for the stored prefetch. `changedLinesSince` is Monitor.changedLinesSince;
   * the mark comes from accept(). Undefined = still valid.
   */
  check(p: HintPrefetch, s: Omit<StaleInput, 'linesChanged'> & { changedLinesSince?: (mark: number) => number }): StaleReason | undefined {
    const taskId = p.key.startsWith('hint:') ? p.key.slice(5) : p.key;
    const mark = this.tasks.get(taskId)?.mark;
    const linesChanged = mark !== undefined && s.changedLinesSince ? s.changedLinesSince(mark) : undefined;
    return staleReason(p, { ...s, linesChanged }, this.staleLines);
  }

  /** The stored prefetch is dropped (stale, or the task ended). An unused one counts toward the cap. */
  discard(p: HintPrefetch | undefined): void {
    if (!p) return;
    const taskId = p.key.startsWith('hint:') ? p.key.slice(5) : p.key;
    const s = this.state(taskId);
    if (!p.used) s.unused++;
    if (s.live === p || !s.live) {
      s.live = undefined;
      s.mark = undefined;
    }
  }

  /** A rung was served from the prefetch. */
  markUsed(p: HintPrefetch): void {
    p.used = true;
  }

  /** Forget one task (or all): new task, new project, reset. */
  reset(taskId?: string): void {
    if (taskId === undefined) this.tasks.clear();
    else this.tasks.delete(taskId);
  }
}

// =====================================================================================
// Post-parse validation
// =====================================================================================

const CODE_FENCE = /```|~~~/;
/** Ends with '?' (closing quotes or brackets after it are fine). */
const ENDS_WITH_QUESTION = /\?["'\u201d\u2019)\]]*$/;

/** Strip a leading label the model may add ('Hint 1:', 'Rung 2 -', 'Nudge:'). */
export function stripRungLabel(text: string): string {
  return text.replace(/^\s*(?:\*\*)?(?:hint|rung|nudge|concept|steps?)\s*\d*\s*(?:\*\*)?\s*[:.)-]\s*(?:\*\*)?\s*/i, '').trim();
}

/**
 * Rungs 1 and 2 must end with '?' and contain no code fence (zod refine is not enforced by
 * constrained decoding). Rung 1 of an environment problem carries the direct fix instead and is
 * exempt. Every rung must be non-empty.
 */
export function rungValid(rung: number, text: string, stuckType?: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (rung === 1 && stuckType === 'environment') return true;
  if (rung === 1 || rung === 2) return ENDS_WITH_QUESTION.test(t) && !CODE_FENCE.test(t);
  return true;
}

/** Rungs 1-3 by rung number when the model numbered them 1..3 uniquely, else by position. */
export function ladderRungs(ladder: Pick<HintLadder, 'rungs' | 'stuckType'>): string[] {
  const rs = Array.isArray(ladder.rungs) ? ladder.rungs : [];
  const nums = rs.map((r) => r.rung);
  const numbered = nums.length > 0 && nums.every((n) => n >= 1 && n <= 3 && Number.isInteger(n)) && new Set(nums).size === nums.length;
  const out = ['', '', ''];
  rs.forEach((r, i) => {
    const idx = numbered ? r.rung - 1 : i;
    if (idx < 0 || idx > 2) return;
    const text = stripRungLabel(String(r.text ?? ''));
    out[idx] = rungValid(idx + 1, text, ladder.stuckType) ? text : '';
  });
  return out;
}

export function ladderToPrefetch(
  ladder: HintLadder,
  ctx: { taskId: string; contentHash: string; errorHash: string; now: number },
): HintPrefetch | undefined {
  const rungs = ladderRungs(ladder);
  if (!rungs.some(Boolean)) return undefined;
  const a = ladder.anchor ?? { file: '', line: 1, lineText: '' };
  return {
    key: prefetchKey(ctx.taskId),
    contentHash: ctx.contentHash,
    errorHash: ctx.errorHash,
    at: ctx.now,
    anchor: {
      file: String(a.file ?? '').trim().replace(/^\.[\\/]/, ''),
      line: Number.isFinite(a.line) && a.line >= 1 ? Math.round(a.line) : 1,
      lineText: String(a.lineText ?? ''),
    },
    rungs,
    diagnosis: ladder.diagnosis ?? '',
    stuckType: ladder.stuckType ?? 'not-stuck',
    conceptIds: Array.isArray(ladder.conceptIds) ? ladder.conceptIds : [],
    misconceptionId: ladder.misconceptionId ?? '',
    used: false,
  };
}

/** Text of rung 1-3 from a prefetch, or undefined when it is missing or was dropped (serve on demand). */
export function prefetchedRung(p: HintPrefetch | undefined, rung: number): string | undefined {
  if (!p || rung < 1 || rung > 3) return undefined;
  const t = p.rungs[rung - 1];
  return t && t.trim() ? t : undefined;
}

// =====================================================================================
// Rung 0: a persistent project error, handled locally
// =====================================================================================

export interface TerminalRunInfo {
  at: number;
  command: string;
  exitCode: number | undefined;
  /** ANSI-stripped output tail. */
  output: string;
  /** Terminal cwd (fsPath), to resolve relative trace paths. */
  cwd?: string;
}

export interface DiagnosticAge {
  /** Workspace-relative file. */
  file: string;
  /** 1-based. */
  line: number;
  message: string;
  firstSeen: number;
}

export interface Rung0 {
  /** Stable per error (serve rung 0 once per key). */
  key: string;
  source: 'terminal' | 'diagnostics';
  exception?: string;
  /** Workspace-relative file of the traced line. */
  file: string;
  /** 1-based traced line. */
  line: number;
  text: string;
}

export interface Rung0Input {
  now: number;
  /** Task language; undefined tries Python then Node. */
  lang?: Lang;
  /** Terminal runs of this task, oldest first. */
  runs: readonly TerminalRunInfo[];
  diagnostics?: readonly DiagnosticAge[];
  /**
   * Map a path printed in a trace to a workspace-relative project file, or undefined for library,
   * runtime-internal or out-of-workspace frames.
   */
  toProjectFile: (path: string, cwd?: string) => string | undefined;
  diagnosticMs?: number;
}

export interface TraceFrameRef {
  path: string;
  /** 1-based. */
  line: number;
}

const PY_FRAME = /^\s*File "([^"]+)", line (\d+)(?:, in .*)?\s*$/;
const NODE_FRAME = /^\s*at (?:async )?(?:(?:new )?[^\s(][^(]*? \()?(.+?):(\d+):(\d+)\)?\s*$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** file:///C:/x/y.js -> C:/x/y.js; file:///home/x.js -> /home/x.js. Other text is returned as is. */
export function framePath(p: string): string {
  if (!/^file:\/\//i.test(p)) return p;
  let rest = p.replace(/^file:\/\//i, '');
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // keep the raw text
  }
  return /^\/[A-Za-z]:/.test(rest) ? rest.slice(1) : rest;
}

/** Frames of the LAST traceback in `text`, innermost first. */
export function traceFrames(text: string, lang: Lang): TraceFrameRef[] {
  const lines = text.replace(ANSI, '').split(/\r?\n/);
  if (lang === 'python') {
    const tb = lines.map((l) => /^Traceback \(most recent call last\):/.test(l.trim())).lastIndexOf(true);
    const out: TraceFrameRef[] = [];
    for (let i = Math.max(0, tb); i < lines.length; i++) {
      const m = PY_FRAME.exec(lines[i]);
      if (m) out.push({ path: m[1], line: Number(m[2]) });
    }
    return out.reverse();
  }
  // Node prints 'Name: message' then its frames; take the last such block.
  let end = lines.length - 1;
  while (end >= 0 && !NODE_FRAME.test(lines[end])) end--;
  if (end < 0) return [];
  let start = end;
  while (start > 0 && NODE_FRAME.test(lines[start - 1])) start--;
  const out: TraceFrameRef[] = [];
  for (let i = start; i <= end; i++) {
    const m = NODE_FRAME.exec(lines[i]);
    if (m) out.push({ path: framePath(m[1]), line: Number(m[2]) });
  }
  // Node also prints 'file:line' above the source excerpt of the throwing line. A SyntaxError has
  // only runtime-internal frames, so this header is its one project location: keep it last.
  for (let i = start - 1; i >= 0 && i >= start - 12; i--) {
    const m = /^(\S.*?):(\d+)$/.exec(lines[i].trim());
    if (m && !/^\s/.test(lines[i])) {
      out.push({ path: framePath(m[1]), line: Number(m[2]) });
      break;
    }
  }
  return out;
}

export interface ProjectRoot {
  /** Workspace folder name (prefixed to paths in a multi-root workspace, like asRelativePath). */
  name: string;
  /** Workspace folder fsPath. */
  fsPath: string;
}

/** Path segments that mark installed or generated code, never the learner's project code. */
const NOT_PROJECT_SEGMENTS = new Set([
  'site-packages', 'dist-packages', '__pypackages__', 'node_modules', '.venv', 'venv', '.tox', '.nox', '.git', '__pycache__',
]);

/**
 * Builds Rung0Input.toProjectFile: maps a path printed in a trace (absolute, relative to the
 * terminal cwd, or a file:// URL) to a workspace-relative project file with '/' separators, or
 * undefined for runtime internals ('node:internal/...', '<frozen ...>', '<stdin>'), installed
 * packages and virtual environments, and anything outside the workspace folders.
 * In a multi-root workspace the folder name comes first, as vscode.workspace.asRelativePath does.
 * `pathApi` defaults to the platform's path module (traces come from the same machine).
 */
export function projectFileResolver(
  roots: readonly ProjectRoot[],
  pathApi: typeof nodePath.posix = nodePath,
): (path: string, cwd?: string) => string | undefined {
  const P = pathApi;
  const usable = roots.filter((r) => r.fsPath && P.isAbsolute(r.fsPath));
  return (raw: string, cwd?: string) => {
    const p = framePath(String(raw ?? '').trim());
    // Runtime internals and pseudo files: 'node:fs', 'internal/x.js', '<frozen importlib._bootstrap>', '<stdin>'.
    if (!p || /^(?:node|internal|bun|deno|data|https?):/i.test(p) || /^internal[\\/]/.test(p) || p.includes('<')) return undefined;
    const base = cwd && P.isAbsolute(cwd) ? cwd : usable[0]?.fsPath;
    if (!P.isAbsolute(p) && !base) return undefined;
    const abs = P.resolve(base ?? '', p);
    for (const root of usable) {
      const rel = P.relative(root.fsPath, abs);
      if (!rel || rel.startsWith('..') || P.isAbsolute(rel)) continue;
      const parts = rel.split(/[\\/]+/).filter(Boolean);
      if (parts.some((s) => NOT_PROJECT_SEGMENTS.has(s.toLowerCase()))) return undefined;
      return (usable.length > 1 ? [root.name, ...parts] : parts).join('/');
    }
    return undefined;
  };
}

export function rung0Text(exception: string): string {
  return `Which line does the trace point at, and what does ${exception} mean?`;
}

function clipText(s: string, max: number): string {
  const one = norm(s);
  return one.length <= max ? one : one.slice(0, max - 1).trimEnd() + '…';
}

/** Rung-0 question for a diagnostics error (no exception class to name, unless the message starts with one). */
export function rung0DiagnosticText(message: string): string {
  const m = /^([A-Za-z_][\w.]*(?:Error|Exception))\b/.exec(message.trim());
  if (m) return rung0Text(m[1].split('.').pop() ?? m[1]);
  return `What does "${clipText(message, 60)}" mean, and what on this line causes it?`;
}

interface ParsedRun {
  run: TerminalRunInfo;
  exception: string;
  file: string;
  line: number;
}

function parseRun(run: TerminalRunInfo, lang: Lang | undefined, toProjectFile: Rung0Input['toProjectFile']): ParsedRun | undefined {
  if (run.exitCode === 0 || !run.output) return undefined;
  const langs: Lang[] = lang ? [lang === 'typescript' ? 'javascript' : lang] : ['python', 'javascript'];
  for (const l of langs) {
    const exception = parseException(run.output, l);
    if (!exception) continue;
    for (const f of traceFrames(run.output, l)) {
      const file = toProjectFile(f.path, run.cwd);
      if (file) return { run, exception, file, line: f.line };
    }
  }
  return undefined;
}

/**
 * Rung 0 (local, no model): a project-code error that persists, i.e. the same exception in 2
 * terminal runs (innermost project frame in the same file, and no later success of that command),
 * or an Error diagnostic present for 1+ minute. Terminal errors win over diagnostics.
 */
export function detectRung0(i: Rung0Input): Rung0 | undefined {
  const parsed = i.runs.map((r) => parseRun(r, i.lang, i.toProjectFile));
  for (let k = parsed.length - 1; k >= 0; k--) {
    const latest = parsed[k];
    if (!latest) continue;
    // Fixed since: the same command later succeeded.
    if (i.runs.slice(k + 1).some((r) => r.command === latest.run.command && r.exitCode === 0)) break;
    const earlier = parsed.slice(0, k).some((p) => p && p.exception === latest.exception && p.file === latest.file);
    if (earlier) {
      return {
        key: `terminal:${latest.exception}:${latest.file}`,
        source: 'terminal',
        exception: latest.exception,
        file: latest.file,
        line: latest.line,
        text: rung0Text(latest.exception),
      };
    }
    break; // only the newest project error can be the persistent one
  }
  const minMs = i.diagnosticMs ?? RUNG0_DIAGNOSTIC_MS;
  const old = (i.diagnostics ?? []).filter((d) => i.now - d.firstSeen >= minMs).sort((a, b) => a.firstSeen - b.firstSeen)[0];
  if (old) {
    const m = /^([A-Za-z_][\w.]*(?:Error|Exception))\b/.exec(old.message.trim());
    return {
      key: `diagnostics:${errorKey(old)}`,
      source: 'diagnostics',
      exception: m ? m[1].split('.').pop() : undefined,
      file: old.file,
      line: old.line,
      text: rung0DiagnosticText(old.message),
    };
  }
  return undefined;
}

// =====================================================================================
// Display through the LineAnnotationManager
// =====================================================================================

export const HINT_COMMANDS: readonly string[] = ['deliberate.hint', 'deliberate.gotIt', 'deliberate.teach'];
export const HINT_LINKS = '[Next hint](command:deliberate.hint) · [Got it](command:deliberate.gotIt)';

/** 'Hint 2' (rung 0 is plain 'Hint'). */
export function hintLabel(rung: number): string {
  return rung > 0 ? `Hint ${rung}` : 'Hint';
}

/** Annotation text: 'Hint 1: <text>'. */
export function hintAnnotationText(rung: number, text: string): string {
  return `${hintLabel(rung)}: ${text.trim()}`;
}

/** Split 'Hint 2: body' into its label and body (threads use the label as their title). */
export function splitHintLabel(text: string): { label: string; body: string } {
  const m = /^(Hint(?: \d+)?):\s*/.exec(text.trim());
  return m ? { label: m[1], body: text.trim().slice(m[0].length).trim() } : { label: 'Hint', body: text.trim() };
}

/** The deliberate.next key as the learner presses it (alt+n is a dead key on macOS). */
export function nextKeyLabel(platform: string = process.platform): string {
  return platform === 'darwin' ? 'Ctrl+Alt+N' : 'Alt+N';
}

/** Rung 2 with a verified atom: 'this is <pattern name>. 60 s drill: Alt+N'. */
export function drillText(patternName: string, keyLabel = nextKeyLabel()): string {
  return `this is ${patternName.trim()}. 60 s drill: ${keyLabel}`;
}

/** Where a hint rung shows: after-text when 'Hint N: <text>' fits in 52 characters, else a comment thread. */
export function hintRoute(rung: number, text: string): 'after' | 'thread' {
  return routeText('hint', hintAnnotationText(rung, text));
}

export interface HintHost {
  sink: AnnotationSink;
  /** Current lines of a workspace-relative file (or uri string), with the document's uri string. */
  readLines(file: string): Promise<{ uri: string; file: string; lines: string[] } | undefined>;
  /** If the document is visible: revealRange(InCenterIfOutsideViewport), without taking focus. */
  reveal?(uri: string, line: number): void;
  /** An extra comment thread (rung 2 with a drill: the thread also shows the rung-2 text). */
  openThread?(uri: string, line: number, label: string, markdown: string): { dispose(): void };
  /** Annotations the sink removed because their anchored line text changed. */
  onDidRemove?: Event<Annotation[]>;
}

export interface ShowHintRequest {
  rung: number;
  /** The rung text (no 'Hint N:' label). */
  text: string;
  anchor: HintAnchor;
  /** Rung 2 with a verified atom for the diagnosed concept. */
  drill?: { patternName: string };
  /** Platform for the key label (tests). */
  platform?: string;
}

export interface ShownHint {
  rung: number;
  uri: string;
  /** Workspace-relative file. */
  file: string;
  /** 0-based line the hint is anchored on. */
  line: number;
  route: 'after' | 'thread';
  /** Annotation text as set ('Hint 1: ...'). */
  text: string;
}

export type HintClearReason = 'got-it' | 'spec-green' | 'anchor-changed' | 'replaced' | 'task-changed' | 'closed';

/**
 * Shows one hint rung in the editor through the AnnotationSink: 'Hint 1: <text>' after-text when it
 * fits 52 characters, otherwise a comment thread with Next hint / Got it links. One hint at a time.
 * Cleared when its line text changes, on Got it, or when a spec turns green (callers pass the reason).
 */
export class HintDisplay {
  private shown: ShownHint | undefined;
  private extraThread: { dispose(): void } | undefined;
  private seq = 0;
  private readonly clearEmitter = new Emitter<{ hint: ShownHint; reason: HintClearReason }>();
  readonly onDidClear = this.clearEmitter.event;
  private readonly subscription: { dispose(): void } | undefined;

  constructor(private readonly host: HintHost) {
    this.subscription = host.onDidRemove?.((removed) => {
      const s = this.shown;
      if (s && removed.some((a) => a.source === 'hint' && a.uri === s.uri && a.text === s.text)) this.finish('anchor-changed', false);
    });
  }

  get current(): ShownHint | undefined {
    return this.shown;
  }

  /**
   * Show a rung on its anchored line. The anchor is re-resolved by lineText (nearest match);
   * returns undefined when it cannot be found, and the hint then stays a sidebar card only.
   */
  async show(req: ShowHintRequest): Promise<ShownHint | undefined> {
    const token = ++this.seq;
    if (this.shown) this.finish('replaced', true);
    const text = req.text.trim();
    if (!text || !req.anchor?.file) return undefined;
    const doc = await this.host.readLines(req.anchor.file);
    if (token !== this.seq || !doc) return undefined;
    const line = resolveAnchor(doc.lines, req.anchor);
    if (line === undefined) return undefined;

    const key = nextKeyLabel(req.platform);
    let annText = hintAnnotationText(req.rung, text);
    let hover = HINT_LINKS;
    let extra: string | undefined;
    if (req.drill?.patternName.trim()) {
      const short = hintAnnotationText(req.rung, drillText(req.drill.patternName, key));
      if (routeText('hint', short) === 'after') {
        annText = short;
        hover = `${text}\n\n${HINT_LINKS}`;
        extra = text;
      } else {
        annText = `${short}\n\n${text}`;
      }
    }
    const route = routeText('hint', annText);
    this.host.sink.set({ uri: doc.uri, line, source: 'hint', text: annText, hover });
    if (extra !== undefined && this.host.openThread) this.extraThread = this.host.openThread(doc.uri, line, hintLabel(req.rung), extra);
    this.host.reveal?.(doc.uri, line);
    this.shown = { rung: req.rung, uri: doc.uri, file: doc.file, line, route, text: annText };
    return this.shown;
  }

  /** Got it, spec green, task change...: remove the annotation and any thread. */
  clear(reason: HintClearReason): void {
    this.seq++;
    if (this.shown) this.finish(reason, true);
  }

  private finish(reason: HintClearReason, clearSink: boolean): void {
    const s = this.shown;
    this.shown = undefined;
    this.extraThread?.dispose();
    this.extraThread = undefined;
    if (!s) return;
    if (clearSink) this.host.sink.clear('hint', s.uri);
    this.clearEmitter.fire({ hint: s, reason });
  }

  dispose(): void {
    this.clear('closed');
    this.subscription?.dispose();
    this.clearEmitter.dispose();
  }
}

// =====================================================================================
// HINTLADDER prompt (the coach makes the call with HintLadderSchema)
// =====================================================================================

export interface OwnProbeResult {
  call: string;
  predicted: string;
  actual: string;
  /** The prediction matched the code's behaviour. */
  match: boolean;
}

export interface HintLadderPromptInput {
  projectBrief: string;
  taskBrief: string;
  /** learnerFor(t.conceptIds) */
  learnerProfile: string;
  /** signals.reasons */
  stuckReasons: readonly string[];
  /** Pre-hint own-code prediction from this stuck episode (mechanism 12). */
  ownProbe?: OwnProbeResult;
  /** gatherCodeContext() output. */
  codeSnapshot: string;
  /** true: speculative prefetch (medium effort); false: the learner asked (low effort). */
  speculative: boolean;
  /** Earlier hints in this task (diagnoses or texts), oldest first. */
  previousHints?: readonly string[];
  /** Known misconceptions of the task's tags (taxonomyFor), so misconceptionId reuses their ids. */
  misconceptions?: readonly { id: string; belief: string }[];
}

/** The pre-hint own-prediction sentence (spec V1-10 HINTLADDER, from the mechanism-12 probe), plus how to use it. */
export function ownProbeSentence(p: OwnProbeResult): string {
  return (
    `Before this they predicted ${p.call} returns ${p.predicted}; it actually returns ${p.actual}. ` +
    (p.match ? 'Their mental model of this function matches the code, so look for the problem elsewhere.' : 'Start from this mismatch.')
  );
}

/** HINTLADDER prompt text (spec V1-10). Use with HintLadderSchema; effort HINT_JOB.effortSpeculative / effortOnDemand. */
export function hintLadderPrompt(i: HintLadderPromptInput): string {
  const reasons = i.stuckReasons.filter((r) => r.trim());
  const lines: (string | undefined)[] = [
    i.projectBrief,
    i.taskBrief,
    `Learner profile: ${i.learnerProfile}`,
    `Stuck signals: ${reasons.length ? reasons.join('; ') : i.speculative ? 'stalled' : 'learner asked for a hint'}`,
    i.ownProbe ? ownProbeSentence(i.ownProbe) : undefined,
    i.previousHints?.length ? `Hints already given (do not repeat; build on them):\n${i.previousHints.map((h, k) => `${k + 1}. ${h}`).join('\n')}` : undefined,
    `Their code right now: ${i.codeSnapshot}`,
    '',
    `${i.speculative ? 'They have not asked yet; prepare help in advance.' : 'They asked for a hint.'} Diagnose what they are most likely stuck on, then write rungs 1-3 of the hint ladder, each building on the previous one:`,
    '- rung 1 (Nudge): one short question pointing at a line, value or assumption; aim for 44 characters or fewer so it fits on their line. Must end with a question mark. No code, and do not name the fix.',
    '- rung 2 (Concept): name the missing concept in <= 25 words and ask how it applies to a specific line of theirs. Must end with a question mark. No code.',
    '- rung 3 (Steps): 2-5 plain-language steps for just the stuck piece, using their names. No real code.',
    'anchor: the workspace-relative file and 1-based line they should look at, plus that line exact text (lineText).',
    'stuckType, conceptIds (reuse the given ids), misconceptionId (a taxonomy id or empty), mistakePattern (a short reusable name if it is a slip or a recurring mistake from their profile, else empty). If it is an environment problem, put the direct fix in rung 1 and set stuckType environment. If they are not stuck, use not-stuck.',
    i.misconceptions?.length
      ? `Taxonomy ids for this task (misconceptionId: the one their code shows, else empty): ${i.misconceptions.map((m) => `${m.id} (${m.belief})`).join('; ')}`
      : undefined,
  ];
  return lines.filter((l): l is string => l !== undefined).join('\n');
}
