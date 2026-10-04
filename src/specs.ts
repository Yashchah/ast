// Behaviour specs on save (spec V1-11): the SpecController runs the bundled harness against the
// learner's interface file when they save, and reports only the target spec (the first red one in
// ladder order) through the gutter, the line annotations and the tempo bar.
//
// Wiring (docs/stage1-notes.md "harness" SPEC RUNS):
// - the spec JSON goes to globalStorage/specs/<taskId>.json (never the workspace), then
//   runLearnerCode(media/harness/harness.{py,mjs}, [interface file, spec json]) with the same
//   timeout in the JSON and as the process timeout, then parseHarnessOutput()
// - spec calls are rewritten to the learner's names at run time (rewriteSpecCalls); the stored
//   specs keep the interface names
// Decision logic is pure and runs under node:test with a fake runner and fake sinks; the vscode
// pieces (documentFunctions, vscodeSpecHost, SpecTestView) are thin and touch `vscode` only inside
// functions, so importing this module under the test stub is safe.
//
// Save-triggered runs never create a TestRun: Testing-view results are published only for runs the
// learner starts there, or continuous runs (spec V1-11 REPORTING).

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
  FadeLevel, FailureSignature, Lang, Runner, Runtime, SpecItem, SpecResult, TaskInterface, TaskSpecState,
} from './contracts';
import type { AnnotationSink } from './annotations';
import type { ActionSink } from './tempoBar';
import { Emitter, systemClock, type Clock, type Event } from './jobs';
import { clip, mdEscape, status, statusText } from './tempo';
import { hash53 } from './atoms/rng';
import {
  DESIGN_DIFFERS, SLOW_IMPORT_MS, actualLine, arityOf, buildHarnessInput, countParams, findTopLevelFunctions, hiddenFailureCard,
  parseHarnessOutput, rewriteSpecCalls, signatureMatch, specEvidenceWeight, specTimeoutMs, targetSpec, verifySpecLadder,
  visibleTitles, type FunctionRange, type HarnessLoadError, type HarnessRun, type HarnessSpecResult, type SpecDisplay,
  type SpecLadderDraft, type VerifyDeps, type VerifyFs, type VerifyResult, type VisibleLadder,
} from './specsCore';

// =====================================================================================
// Constants
// =====================================================================================

/** Manual saves run at once, debounced (spec V1-11 TRIGGERS). */
export const MANUAL_DEBOUNCE_MS = 300;
/** Auto-saves (AfterDelay, FocusOut) run only after this long without edits and with no Error diagnostics. */
export const AUTO_IDLE_MS = 1500;
/** JIT atom offers: the target spec's concept is below this P (or a gate-deferred gap). */
export const JIT_MAX_P = 0.5;

/** Tempo-bar action ids owned by the controller (ActionSink.remove accepts ids). */
export const SPEC_ACTION_IDS = {
  progress: 'specs:progress',
  running: 'specs:running',
  jit: 'specs:jit',
  stuck: 'specs:stuck',
  ready: 'specs:ready',
} as const;

/** Action priorities (lower comes first): progress is the resting status text. */
const PRIORITY = { running: 1, jit: 2, stuck: 2, ready: 4, progress: 6 } as const;

/** Par seconds when a spec's parSec is missing or not a positive number. */
const DEFAULT_PAR_SEC = 60;

/**
 * Spec V1-11 EVIDENCE: a target spec still red past 2x its par (active time since it became the
 * target) with the same failure signature seen on 2 attempts queues an 'atom' offer for its concept.
 */
export function signatureStuck(count: number, activeMsSinceRed: number, parSec: number): boolean {
  const par = Number.isFinite(parSec) && parSec > 0 ? parSec : DEFAULT_PAR_SEC;
  return count >= 2 && activeMsSinceRed > 2 * par * 1000;
}

/** '$(mortar-board) stuck? Count with dict · 60s drill' (<= 40 characters after the icon). */
export function stuckOfferLabel(pattern: string): string {
  const suffix = ' · 60s drill';
  return statusText('mortar-board', `stuck? ${clip(pattern, 40 - 'stuck? '.length - suffix.length)}${suffix}`);
}

/** Hash of a text ignoring line-ending and trailing-whitespace changes: did the learner change the code? */
export function codeHash(text: string): string {
  return hash53(text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trimEnd()).toString(36);
}

const FILE_EXTS: Record<Lang, readonly string[]> = {
  python: ['.py'],
  javascript: ['.js', '.mjs', '.cjs', '.jsx'],
  typescript: ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs'],
};

// =====================================================================================
// Function locations (executeDocumentSymbolProvider, with the regex fallback)
// =====================================================================================

export interface FunctionLoc {
  name: string;
  /** 0-based first line (decorators included). */
  startLine: number;
  /** 0-based last line, inclusive. */
  endLine: number;
  /** 0-based line of the def / function keyword: where gutters and nudges go. */
  defLine: number;
  /** Positional parameter count, when readable. */
  arity?: number;
}

/** A DocumentSymbol flattened to what matters here (top-level symbols only). */
export interface SymbolLike {
  name: string;
  kind: 'function' | 'other';
  startLine: number;
  endLine: number;
  /** Line of the symbol's name (selectionRange.start.line). */
  selectionLine: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The def / function line of `name` inside [start, end]; else the first non-decorator line. */
function defLineOf(lines: string[], start: number, end: number, name: string, lang: Lang): number {
  const n = escapeRe(name);
  const re = lang === 'python'
    ? new RegExp(`^\\s*(?:async\\s+)?def\\s+${n}\\b`)
    : new RegExp(`\\bfunction\\s*\\*?\\s*${n}\\b|\\b(?:const|let|var)\\s+${n}\\b|^\\s*(?:export\\s+)?(?:async\\s+)?${n}\\s*\\(`);
  const last = Math.min(end, lines.length - 1);
  for (let i = Math.max(0, start); i <= last; i++) if (re.test(lines[i])) return i;
  for (let i = Math.max(0, start); i <= last; i++) {
    const t = lines[i].trim();
    if (t && !t.startsWith('@')) return i;
  }
  return Math.max(0, start);
}

/** Positional arity of the function whose name appears on `line` (looks ahead up to 30 lines). */
export function arityAt(lines: string[], line: number, name: string): number | undefined {
  const text = lines.slice(line, line + 30).join('\n');
  const at = text.search(new RegExp(`\\b${escapeRe(name)}\\b`));
  if (at < 0) return undefined;
  const rest = text.slice(at + name.length);
  const open = rest.indexOf('(');
  const arrow = /^\s*(?::[^=]*)?=\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(rest);
  if (arrow && (open < 0 || rest.indexOf('=>') < open)) return 1;
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < rest.length; i++) {
    const c = rest[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return countParams(rest.slice(open + 1, i));
  }
  return undefined;
}

/** Top-level functions from the text alone (findTopLevelFunctions, the regex fallback). */
export function functionsFromText(text: string, lang: Lang): FunctionLoc[] {
  const lf = text.replace(/\r\n?/g, '\n');
  const lines = lf.split('\n');
  return findTopLevelFunctions(lf, lang).map((f) => {
    const loc: FunctionLoc = { name: f.name, startLine: f.startLine, endLine: f.endLine, defLine: defLineOf(lines, f.startLine, f.endLine, f.name, lang) };
    if (f.arity !== undefined) loc.arity = f.arity;
    return loc;
  });
}

/**
 * DocumentSymbol functions first (their ranges are exact), then any top-level function only the
 * regex finds (e.g. `const f = () => ...`, which some providers list as a variable).
 */
export function mergeFunctionLocs(symbols: readonly SymbolLike[] | undefined, text: string, lang: Lang): FunctionLoc[] {
  const fromText = functionsFromText(text, lang);
  if (!symbols?.length) return fromText;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: FunctionLoc[] = [];
  const seen = new Set<string>();
  for (const s of symbols) {
    if (s.kind !== 'function' || !s.name || seen.has(s.name)) continue;
    seen.add(s.name);
    const regex = fromText.find((f) => f.name === s.name);
    const defLine = lines[s.selectionLine] !== undefined ? s.selectionLine : s.startLine;
    const loc: FunctionLoc = { name: s.name, startLine: Math.min(s.startLine, defLine), endLine: Math.max(s.endLine, defLine), defLine };
    const arity = regex?.arity ?? arityAt(lines, defLine, s.name);
    if (arity !== undefined) loc.arity = arity;
    out.push(loc);
  }
  for (const f of fromText) if (!seen.has(f.name)) out.push(f);
  return out.sort((a, b) => a.startLine - b.startLine);
}

/** Function locations of a document: executeDocumentSymbolProvider (Function / Method), regex fallback. */
export async function documentFunctions(uri: vscode.Uri, text: string, lang: Lang): Promise<FunctionLoc[]> {
  let symbols: SymbolLike[] | undefined;
  try {
    const raw = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>('vscode.executeDocumentSymbolProvider', uri);
    symbols = (raw ?? [])
      .filter((s): s is vscode.DocumentSymbol => 'selectionRange' in s && 'children' in s)
      .map((s) => ({
        name: s.name.replace(/\(.*$/, '').trim(),
        kind: s.kind === vscode.SymbolKind.Function || s.kind === vscode.SymbolKind.Method ? ('function' as const) : ('other' as const),
        startLine: s.range.start.line,
        endLine: s.range.end.line,
        selectionLine: s.selectionRange.start.line,
      }));
  } catch {
    symbols = undefined; // no provider (or it failed): the regex fallback alone
  }
  return mergeFunctionLocs(symbols, text, lang);
}

/** FunctionRange[] for verifySpecLadder from function locations. */
export function toFunctionRanges(locs: readonly FunctionLoc[]): FunctionRange[] {
  return locs.map((l) => ({ name: l.name, startLine: l.startLine, endLine: l.endLine, ...(l.arity !== undefined ? { arity: l.arity } : {}) }));
}

/** Hash of a function's text: what changed between saves (JIT re-offer, own-code probe store). */
export function functionHash(text: string, loc: Pick<FunctionLoc, 'startLine' | 'endLine'>): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').slice(loc.startLine, loc.endLine + 1);
  return hash53(lines.map((l) => l.trimEnd()).join('\n')).toString(36);
}

// =====================================================================================
// Interface mapping (spec V1-11 ATTACHING)
// =====================================================================================

export interface MappingResult {
  /** Interface name -> learner name, only for functions they named differently. */
  mappedNames: Record<string, string>;
  /** Interface functions not written yet: no exact name and no function of the same arity. */
  pending: string[];
  /** Interface functions with several same-arity candidates: no mapping is possible. */
  ambiguous: string[];
}

/** Never an arity-mapping candidate: entry points and private helpers. */
const NOT_A_CANDIDATE = /^(?:main|_.*)$/;

/**
 * Map each interface function to the learner's (mapInterface's rules): the exact name, else a
 * still-valid earlier mapping, else the unique function of the same arity that is not itself an
 * interface name. Never forces a rename. Unlike mapInterface, a function with no candidate at all
 * is 'pending' (not written yet) rather than a design difference: the learner usually writes the
 * interface one function at a time. `reserved` names (earlier tasks' functions in a shared file),
 * `main` and _private helpers are never candidates.
 */
export function resolveMapping(
  iface: TaskInterface, fns: readonly { name: string; arity?: number }[], previous: Record<string, string> = {}, reserved: ReadonlySet<string> = new Set(),
): MappingResult {
  const ifaceNames = new Set(iface.functions.map((f) => f.name));
  const have = new Set(fns.map((f) => f.name));
  const used = new Set<string>();
  const out: MappingResult = { mappedNames: {}, pending: [], ambiguous: [] };
  const candidate = (name: string) => !ifaceNames.has(name) && !reserved.has(name) && !NOT_A_CANDIDATE.test(name) && !used.has(name);
  for (const f of iface.functions) {
    const prev = previous[f.name];
    if (have.has(f.name) || !prev || !have.has(prev) || !candidate(prev)) continue;
    out.mappedNames[f.name] = prev;
    used.add(prev);
  }
  for (const f of iface.functions) {
    if (have.has(f.name) || out.mappedNames[f.name]) continue;
    const arity = arityOf(f.signature || `${f.name}()`);
    const cands = [...new Set(fns.filter((l) => arity >= 0 && l.arity === arity && candidate(l.name)).map((l) => l.name))];
    if (cands.length === 1) {
      out.mappedNames[f.name] = cands[0];
      used.add(cands[0]);
    } else if (cands.length === 0) out.pending.push(f.name);
    else out.ambiguous.push(f.name);
  }
  return out;
}

/**
 * The learner's file follows another design (DESIGN_DIFFERS): some interface function has several
 * same-arity candidates, and nothing in the file matches the interface (no exact name, no mapping).
 * A file whose interface functions are merely not written yet is not a different design.
 */
export function designDiffers(iface: TaskInterface, fns: readonly { name: string }[], m: MappingResult): boolean {
  if (!m.ambiguous.length) return false;
  const names = new Set(fns.map((f) => f.name));
  return !iface.functions.some((f) => names.has(f.name)) && Object.keys(m.mappedNames).length === 0;
}

// =====================================================================================
// Small pure helpers
// =====================================================================================

const CALLEE = /^\s*([A-Za-z_$\p{L}][\w$\p{L}\p{N}]*)/u;

export function calleeOf(call: string): string | undefined {
  return CALLEE.exec(call)?.[1];
}

/** Does this file belong to the task (same language family)? */
export function isLangFile(fsPath: string, lang: Lang): boolean {
  return FILE_EXTS[lang].includes(path.extname(fsPath).toLowerCase());
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function within(p: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** A file name for the task's spec JSON. */
export function specFileName(taskId: string): string {
  const safe = taskId.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '_').slice(0, 80) || 'task';
  return `${safe}.json`;
}

/** Node 22.6-22.14 / 23.0-23.4 lack module.registerHooks: TS './x.js' imports cannot resolve under --permission. */
export function tsImportCaveat(runtime: Pick<Runtime, 'lang' | 'version' | 'tsMode' | 'permissionFlag'>, source: string | undefined): string | undefined {
  if (runtime.lang !== 'typescript' || runtime.tsMode === 'tsx' || !runtime.permissionFlag) return undefined;
  const m = /(\d+)\.(\d+)/.exec(runtime.version);
  if (!m) return undefined;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  const affected = (maj === 22 && min >= 6 && min < 15) || (maj === 23 && min < 5);
  if (!affected) return undefined;
  if (!source || !/\b(?:from|import)\s*\(?\s*['"]\.\.?\//.test(source)) return undefined;
  return `Node ${runtime.version} cannot resolve relative TypeScript imports in the sandbox; Check my work will review this task instead (Node 22.15+ fixes it).`;
}

// =====================================================================================
// SpecController
// =====================================================================================

/** What the controller needs from a Task (src/types.ts Task once stage 2 adds these fields). */
export interface SpecTask {
  id: string;
  title?: string;
  interface: TaskInterface;
  /** Updated in place: greenAt, firstRedAt, savesSinceRed, runs, importMs, last, overfit. */
  spec?: TaskSpecState;
  fade: FadeLevel;
  solo?: boolean;
  /** Functions that received assisted inserts: their spec evidence drops to weight .3. */
  assistedFunctions?: string[];
}

export interface SaveEvent {
  uri: string;
  fsPath: string;
  /** 'manual' = TextDocumentSaveReason.Manual; 'auto' = AfterDelay or FocusOut. */
  reason: 'manual' | 'auto';
  /** Error-severity diagnostics of the file at save time. */
  errorCount: number;
}

/**
 * A TextDocumentSaveReason (Manual = 1, AfterDelay = 2, FocusOut = 3; e.g. Monitor.onSave's reason)
 * as a spec trigger. An unknown reason counts as auto: it waits for idle and no errors.
 */
export function saveTrigger(reason: number | undefined): SaveEvent['reason'] {
  return reason === 1 ? 'manual' : 'auto';
}

export interface EditEvent {
  uri: string;
  fsPath?: string;
}

/** 'learner' = started from the Testing view; 'continuous' = a continuous Testing run; 'coach' = runNow(). */
export type RunTrigger = 'manual' | 'auto' | 'learner' | 'continuous' | 'coach';

export interface GreenInfo {
  spec: SpecItem;
  /** 1-based position in the ladder. */
  number: number;
  savesSinceRed?: number;
  assisted: boolean;
  at: number;
  /** Wall time of the previous first-green (latency is active ms since then, or task start). */
  previousGreenAt?: number;
  trigger: RunTrigger;
}

export interface SignatureInfo {
  /**
   * Attempts that showed this signature on this spec so far (1 = first). A new attempt is a run
   * after the interface file's code changed; re-saving unchanged code is not one.
   */
  count: number;
  result: SpecResult;
  number: number;
  firstRedAt?: number;
}

export interface StuckInfo extends SignatureInfo {
  /** Active ms since the spec became the target (wall ms when no activeMsSince dep is given). */
  activeMs: number;
}

export type HiddenResult = { pass: true } | { pass: false; spec: SpecItem; result: SpecResult; card: string };

export interface LoadNudge {
  kind: HarnessLoadError['kind'] | 'runner';
  /** Learner-facing text (the harness's nudge). */
  message: string;
  /** Where it points, when known (0-based line). */
  uri?: string;
  fsPath?: string;
  line?: number;
  name?: string;
  why?: string;
}

export interface SpecUpdate {
  ladder: VisibleLadder;
  target?: string;
  display: Record<string, SpecDisplay>;
  turnedGreen: string[];
  turnedRed: string[];
  /** Interface functions not in the file yet. */
  pending: string[];
  trigger?: RunTrigger;
  loadError?: LoadNudge;
}

export interface SpecCallbacks {
  /** First green of a spec: record 'spec' evidence (production) at `weight` and markProgress. */
  onGreen?(specId: string, weight: number, info: GreenInfo): void;
  /**
   * A failureSignature matched the target on a new attempt: passive misconception evidence
   * (x1.5 odds, weight .5) + recordMistake(sig.misconceptionId).
   */
  onSignature?(spec: SpecItem, sig: FailureSignature, info: SignatureInfo): void;
  /**
   * The target has been red past 2x par with the same signature on 2 attempts (signatureStuck).
   * The controller has already queued the 'atom' offer (kind 'atom', the jit command with
   * [conceptId, specId]); fires once per spec per attach. Use it to log or to drop the offer when the
   * concept has no cached atom.
   */
  onSignatureStuck?(spec: SpecItem, sig: FailureSignature, info: StuckInfo): void;
  /** Every visible spec is green (fires once per transition); hidden specs run next. */
  onAllVisibleGreen?(): void;
  onHiddenResult?(r: HiddenResult): void;
  /** The module did not load (or the runner failed): show the nudge. */
  onLoadError?(nudge: LoadNudge): void;
  /**
   * The ladder stopped or started applying while attached: DESIGN_DIFFERS when the learner's file
   * cannot be mapped (show the card; Check my work reviews instead), and back to applicable once a
   * save makes the mapping clear (e.g. they wrote the planned function).
   */
  onApplicableChange?(applicable: boolean, reason?: string): void;
  /** Ladder state changed (card, tempo tooltip); task.spec was updated in place: persist it. */
  onUpdate?(u: SpecUpdate): void;
}

export interface SpecFs {
  mkdir(p: string): Promise<void>;
  writeFile(p: string, text: string): Promise<void>;
  exists(p: string): Promise<boolean>;
}

export const nodeSpecFs: SpecFs = {
  mkdir: async (p) => void (await fsp.mkdir(p, { recursive: true })),
  writeFile: (p, text) => fsp.writeFile(p, text, 'utf8'),
  exists: async (p) => {
    try {
      return (await fsp.stat(p)).isFile();
    } catch {
      return false;
    }
  },
};

export interface ConceptInfo {
  /** P(known). */
  p: number;
  /** Canonical pattern name for the JIT text. */
  pattern?: string;
}

export interface SpecControllerDeps {
  annotations: AnnotationSink;
  actions: ActionSink;
  /** media/harness (absolute). */
  harnessDir: string;
  /** globalStorage/specs (absolute): spec JSON lives here, never in the workspace. */
  specDir: string;
  /** globalStorage/verify (absolute): verifyLadder's temp copies. */
  verifyDir?: string;
  workspaceDir(): string | undefined;
  /** uri string (vscode.Uri.toString()) of a file path: what the sinks key on. */
  uriOf(fsPath: string): string;
  /** Current text of a file (open editor text, else disk). */
  readText(fsPath: string): Promise<string | undefined>;
  /** Function locations (vscodeSpecHost: DocumentSymbols + regex); default: the regex fallback. */
  functions?(fsPath: string, text: string, lang: Lang): Promise<FunctionLoc[]>;
  /** Error diagnostics now (checked when a deferred auto-save run fires). */
  errorCount?(uri: string): number;
  /** P and pattern name of a concept, for JIT offers. */
  conceptInfo?(conceptId: string): ConceptInfo | undefined;
  /**
   * Active (not idle) ms since a wall-clock time, from the tempo / stuck detector, for the 2x-par
   * rule. Default: wall ms (clock.now() - since), which over-counts breaks.
   */
  activeMsSince?(wallMs: number): number;
  /** Commands the tempo actions run. */
  commands?: { jit?: string; ladder?: string };
  fs?: SpecFs;
  clock?: Clock;
  log?(msg: string): void;
  on?: SpecCallbacks;
}

export interface AttachOptions {
  /** Consent 'all' and a trusted workspace. Without it nothing runs and applicable is false. */
  allowRun: boolean;
  /** Gate-deferred gaps (routeGaps().jit concept ids): JIT offers regardless of P. */
  deferredConcepts?: readonly string[];
  /** Specs landed while building: show 'specs ready (n)' (no pop); they run on the next save. */
  announce?: boolean;
  /**
   * Functions of earlier tasks (their interface names and mapped names): in a file several tasks
   * share they are never mistaken for this task's interface functions by arity.
   */
  reservedNames?: readonly string[];
}

export interface AttachResult {
  applicable: boolean;
  reason?: string;
  mappedNames: Record<string, string>;
  pending: string[];
}

export interface SpecRunOutcome {
  trigger: RunTrigger;
  report: HarnessRun;
  /** Visible specs as run (calls rewritten to the learner's names). */
  specs: SpecItem[];
  results: Record<string, HarnessSpecResult>;
  target?: string;
  display: Record<string, SpecDisplay>;
  /** The interface file and its function locations at run time. */
  file: string;
  functions: FunctionLoc[];
  hidden?: HiddenResult;
  ms: number;
}

interface SigSeen {
  key: string;
  counts: Record<string, number>;
}

/** Trigger precedence when runs coalesce: a learner-visible kind wins over a save kind. */
const TRIGGER_RANK: Record<RunTrigger, number> = { auto: 0, manual: 1, coach: 2, continuous: 3, learner: 4 };

export class SpecController {
  private readonly clock: Clock;
  private readonly fs: SpecFs;
  private readonly runEmitter = new Emitter<SpecRunOutcome>();
  /** Every finished visible run (the Testing view publishes learner-started and continuous ones). */
  readonly onDidRun: Event<SpecRunOutcome> = this.runEmitter.event;
  on: SpecCallbacks;

  private task?: SpecTask;
  private lang: Lang = 'python';
  private runner?: Runner;
  private allowRun = false;
  private applicableState = false;
  private reasonText?: string;
  private deferred = new Set<string>();
  private pending: string[] = [];
  private ifaceAbs?: string;
  private ifaceUri?: string;
  /** Bumped on attach/detach: results of an older generation are dropped. */
  private gen = 0;
  private abort?: AbortController;
  private inflight?: Promise<unknown>;
  private queued?: RunTrigger;
  private debounceTimer?: unknown;
  private autoTimer?: unknown;
  private pendingAuto?: { uri: string; errorCount: number };
  private continuous = false;
  private lastTarget?: string;
  private lastAllGreen = false;
  private hiddenPassed = false;
  private fnHashes = new Map<string, string>();
  private jit?: { specId: string; fn: string; hash?: string; reoffered: boolean };
  private sigSeen = new Map<string, SigSeen>();
  /** Specs whose stuck 'atom' offer was queued (once per spec per attach). */
  private stuckOffered = new Set<string>();
  private gutterFiles = new Set<string>();
  private reserved: ReadonlySet<string> = new Set();
  /** Attached, but the learner's file cannot be mapped onto the interface (DESIGN_DIFFERS). */
  private differs = false;

  constructor(private readonly deps: SpecControllerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.fs = deps.fs ?? nodeSpecFs;
    this.on = deps.on ?? {};
  }

  // ------------------------------------------------------------------ state

  /** True when specs run for the attached task (consent, runtime, applicable ladder). */
  get applicable(): boolean {
    return this.applicableState && this.allowRun && !!this.task;
  }

  get reason(): string | undefined {
    return this.reasonText;
  }

  get taskId(): string | undefined {
    return this.task?.id;
  }

  /** The interface file of the attached task (absolute), once attached. */
  get interfaceFile(): string | undefined {
    return this.ifaceAbs;
  }

  /** Titles and summary the fade level allows, for the task card. */
  ladder(): VisibleLadder | undefined {
    const t = this.task;
    return t?.spec ? visibleTitles(t.fade, t.spec) : undefined;
  }

  // ------------------------------------------------------------------ attach / detach

  /**
   * Attach a task's ladder. Maps the interface onto the learner's current file (a mapping in
   * Task.interface.mappedNames, never a rename); several same-arity candidates for one function
   * means the design differs (applicable = false, DESIGN_DIFFERS).
   */
  async attach(task: SpecTask, lang: Lang, runner: Runner | undefined, opts: AttachOptions): Promise<AttachResult> {
    this.detach();
    const gen = this.gen;
    this.task = task;
    this.lang = lang;
    this.runner = runner;
    this.allowRun = opts.allowRun;
    this.deferred = new Set(opts.deferredConcepts ?? []);
    this.reserved = new Set(opts.reservedNames ?? []);
    const spec = task.spec;
    const result = (applicable: boolean, reason?: string): AttachResult => {
      this.applicableState = applicable;
      this.reasonText = reason;
      return { applicable: applicable && this.allowRun, reason, mappedNames: { ...(task.interface.mappedNames ?? {}) }, pending: [...this.pending] };
    };
    if (!spec || !spec.specs.length) return result(false, spec?.reason || 'no behaviour specs for this task');
    if (!spec.applicable) return result(false, spec.reason || 'the spec ladder does not apply to this task');
    if (!runner) return result(false, `no ${lang === 'python' ? 'Python' : 'Node'} runtime found`);
    const rl = runner.runtime.lang;
    if ((lang === 'python') !== (rl === 'python') || (lang === 'typescript' && rl !== 'typescript')) {
      return result(false, `no ${lang} runtime for the spec harness`);
    }
    const ws = this.deps.workspaceDir();
    if (!ws) return result(false, 'open the project folder to run behaviour specs');
    const abs = path.resolve(ws, task.interface.file);
    if (!within(abs, ws)) return result(false, `the interface file is outside the workspace: ${task.interface.file}`);
    this.ifaceAbs = abs;
    this.ifaceUri = this.deps.uriOf(abs);

    const order = spec.specs.map((s) => s.id);
    const prev = targetSpec(order, spec.last ?? {});
    this.lastTarget = prev.target;
    this.lastAllGreen = order.length > 0 && prev.passed === order.length;

    const text = (await this.fs.exists(abs)) ? await this.deps.readText(abs) : undefined;
    if (gen !== this.gen) return { applicable: false, reason: 'detached', mappedNames: {}, pending: [] };
    if (text !== undefined) {
      const fns = await this.functionsOf(abs, text);
      if (gen !== this.gen) return { applicable: false, reason: 'detached', mappedNames: {}, pending: [] };
      for (const f of fns) this.fnHashes.set(f.name, functionHash(text, f));
      const m = resolveMapping(task.interface, fns, task.interface.mappedNames, this.reserved);
      if (designDiffers(task.interface, fns, m)) {
        // Not sticky: a later save that makes the mapping clear brings the ladder back.
        this.differs = true;
        this.pending = [...m.pending, ...m.ambiguous];
        return result(false, DESIGN_DIFFERS);
      }
      this.applyMapping(m);
    } else {
      this.pending = task.interface.functions.map((f) => f.name);
    }
    if (!this.allowRun) {
      const r = result(true);
      return { ...r, applicable: false, reason: 'running your code is off (needs consent and a trusted workspace)' };
    }
    const res = result(true);
    this.showProgress();
    if (opts.announce) {
      this.deps.actions.enqueue({ id: SPEC_ACTION_IDS.ready, kind: 'specs-ready', label: status.specsReady(spec.specs.length), priority: PRIORITY.ready, blocking: false, command: this.ladderCommand });
    }
    this.emitUpdate({ turnedGreen: [], turnedRed: [] });
    return res;
  }

  /** Consent or workspace trust changed. */
  setAllowRun(allow: boolean): void {
    if (allow === this.allowRun) return;
    this.allowRun = allow;
    if (!allow) {
      this.cancelTimers();
      this.abort?.abort();
      this.clearSurfaces();
    } else if (this.applicable) this.showProgress();
  }

  /** Continuous Testing-view mode: saves then produce 'continuous' runs (published as TestRuns). */
  setContinuous(on: boolean): void {
    this.continuous = on;
  }

  get isContinuous(): boolean {
    return this.continuous;
  }

  /** Gate routing finished later than attach: more deferred gaps for JIT offers. */
  addDeferredConcepts(ids: readonly string[]): void {
    for (const id of ids) this.deferred.add(id);
  }

  detach(): void {
    this.gen++;
    this.cancelTimers();
    this.abort?.abort();
    this.abort = undefined;
    this.queued = undefined;
    this.clearSurfaces();
    this.task = undefined;
    this.runner = undefined;
    this.applicableState = false;
    this.reasonText = undefined;
    this.ifaceAbs = undefined;
    this.ifaceUri = undefined;
    this.pending = [];
    this.lastTarget = undefined;
    this.lastAllGreen = false;
    this.hiddenPassed = false;
    this.fnHashes.clear();
    this.jit = undefined;
    this.sigSeen.clear();
    this.stuckOffered.clear();
    this.reserved = new Set();
    this.differs = false;
  }

  dispose(): void {
    this.detach();
    this.runEmitter.dispose();
  }

  // ------------------------------------------------------------------ triggers

  /** Call from onDidChangeTextDocument for any document: an edit to a task file cancels a pending auto-save run. */
  onEdit(e: EditEvent): void {
    if (!this.task || !this.autoTimer) return;
    if (e.fsPath && !this.isTaskFile(e.fsPath)) return;
    this.clock.clearTimeout(this.autoTimer);
    this.autoTimer = undefined;
    this.pendingAuto = undefined;
  }

  /**
   * Call from onDidSaveTextDocument with the reason recorded in onWillSaveTextDocument. Manual:
   * run at once (debounced 300 ms). Auto (AfterDelay, FocusOut): run after 1.5 s without edits,
   * and only with no Error diagnostics.
   */
  onSave(e: SaveEvent): void {
    if (this.differs && this.task && this.allowRun && this.ifaceAbs && samePath(e.fsPath, this.ifaceAbs)) {
      void this.recheckDesign(e);
      return;
    }
    if (!this.applicable || !this.isTaskFile(e.fsPath)) return;
    if (e.reason === 'manual') {
      this.cancelAuto();
      if (this.debounceTimer) this.clock.clearTimeout(this.debounceTimer);
      this.debounceTimer = this.clock.setTimeout(() => {
        this.debounceTimer = undefined;
        this.schedule(this.continuous ? 'continuous' : 'manual');
      }, MANUAL_DEBOUNCE_MS);
      return;
    }
    if (this.debounceTimer) return; // a manual run is already on its way
    this.cancelAuto();
    this.pendingAuto = { uri: e.uri, errorCount: e.errorCount };
    this.autoTimer = this.clock.setTimeout(() => {
      this.autoTimer = undefined;
      const p = this.pendingAuto;
      this.pendingAuto = undefined;
      if (!p) return;
      const errors = this.deps.errorCount ? this.deps.errorCount(p.uri) : p.errorCount;
      if (errors > 0) {
        this.log(`specs: auto-save run skipped (${errors} error${errors === 1 ? '' : 's'})`);
        return;
      }
      this.schedule(this.continuous ? 'continuous' : 'auto');
    }, AUTO_IDLE_MS);
  }

  /** DESIGN_DIFFERS at attach: a save of the interface file re-checks the mapping and may bring the ladder back. */
  private async recheckDesign(e: SaveEvent): Promise<void> {
    const gen = this.gen;
    const task = this.task!;
    const file = this.ifaceAbs!;
    const text = await this.deps.readText(file);
    if (text === undefined || gen !== this.gen) return;
    const fns = await this.functionsOf(file, text);
    if (gen !== this.gen || !this.differs) return;
    const m = resolveMapping(task.interface, fns, task.interface.mappedNames, this.reserved);
    if (designDiffers(task.interface, fns, m)) return;
    this.differs = false;
    this.applicableState = true;
    this.reasonText = undefined;
    this.applyMapping(m);
    this.on.onApplicableChange?.(true);
    this.showProgress();
    this.emitUpdate({ turnedGreen: [], turnedRed: [] });
    this.onSave(e);
  }

  /** Resolves once no run is in flight or queued (timers still pending are not waited for). */
  async idle(): Promise<void> {
    while (this.inflight) await this.inflight;
  }

  /** Run now (no debounce); waits for an in-flight run first. Resolves undefined when nothing ran. */
  async runNow(trigger: RunTrigger = 'coach'): Promise<SpecRunOutcome | undefined> {
    while (this.inflight) await this.inflight;
    if (!this.applicable) return undefined;
    return this.start(trigger);
  }

  private schedule(trigger: RunTrigger): void {
    if (!this.applicable) return;
    if (this.inflight) {
      if (!this.queued || TRIGGER_RANK[trigger] > TRIGGER_RANK[this.queued]) this.queued = trigger;
      return;
    }
    void this.start(trigger);
  }

  private start(trigger: RunTrigger): Promise<SpecRunOutcome | undefined> {
    const p = this.execute(trigger).catch((e) => {
      this.log(`specs: run failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
    const tracked: Promise<void> = p.then(() => {
      if (this.inflight === tracked) this.inflight = undefined;
      const q = this.queued;
      this.queued = undefined;
      if (q && !this.inflight) this.schedule(q);
    });
    this.inflight = tracked;
    return p;
  }

  private cancelAuto(): void {
    if (this.autoTimer) this.clock.clearTimeout(this.autoTimer);
    this.autoTimer = undefined;
    this.pendingAuto = undefined;
  }

  private cancelTimers(): void {
    this.cancelAuto();
    if (this.debounceTimer) this.clock.clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  private isTaskFile(fsPath: string): boolean {
    const ws = this.deps.workspaceDir();
    if (this.ifaceAbs && samePath(fsPath, this.ifaceAbs)) return true;
    return !!ws && within(fsPath, ws) && isLangFile(fsPath, this.lang);
  }

  // ------------------------------------------------------------------ one run

  private async execute(trigger: RunTrigger): Promise<SpecRunOutcome | undefined> {
    const gen = this.gen;
    const task = this.task;
    const spec = task?.spec;
    const runner = this.runner;
    const ws = this.deps.workspaceDir();
    const file = this.ifaceAbs;
    if (!task || !spec || !runner || !ws || !file || !this.applicable) return undefined;
    const t0 = this.clock.now();
    this.deps.actions.remove(SPEC_ACTION_IDS.ready);
    if (!(await this.fs.exists(file))) {
      this.pending = task.interface.functions.map((f) => f.name);
      this.emitUpdate({ turnedGreen: [], turnedRed: [], trigger });
      return undefined;
    }
    const text = (await this.deps.readText(file)) ?? '';
    const fns = await this.functionsOf(file, text);
    if (gen !== this.gen) return undefined;
    this.applyMapping(resolveMapping(task.interface, fns, task.interface.mappedNames, this.reserved));
    const mapped = task.interface.mappedNames ?? {};
    const visible = rewriteSpecCalls(spec.specs, mapped);

    const report = await this.harness(visible, ws, file, spec, runner, gen);
    if (!report || gen !== this.gen) return undefined;
    if (spec.importMs === undefined && typeof report.importMs === 'number') spec.importMs = report.importMs;

    const hashes = new Map(fns.map((f) => [f.name, functionHash(text, f)] as const));
    const changedFns = new Set([...hashes].filter(([n, h]) => this.fnHashes.get(n) !== h).map(([n]) => n));
    this.fnHashes = hashes;

    const results: Record<string, HarnessSpecResult> = {};
    for (const r of report.results) results[r.id] = r;
    const order = spec.specs.map((s) => s.id);
    const le = report.loadError;
    const blocked = !!le && le.kind !== 'not-exported' && order.every((id) => (results[id]?.status ?? 'not-run') === 'not-run');
    const outcome: SpecRunOutcome = { trigger, report, specs: visible, results, display: {}, file, functions: fns, ms: this.clock.now() - t0 };

    if (blocked) {
      // Nothing ran: keep the last results (the ladder does not flicker to 0), show the nudge.
      const nudge = this.toNudge(le!, ws, file);
      this.deps.annotations.clear('spec');
      if (nudge.uri && nudge.line !== undefined) {
        this.deps.annotations.set({ uri: nudge.uri, line: nudge.line, source: 'spec', text: nudge.message, hover: mdEscape([nudge.message, nudge.why].filter(Boolean).join(' · ')) });
      }
      this.on.onLoadError?.(nudge);
      this.emitUpdate({ turnedGreen: [], turnedRed: [], trigger, loadError: nudge });
      outcome.display = targetSpec(order, spec.last ?? {}).display;
      this.runEmitter.fire(outcome);
      return outcome;
    }

    const now = this.clock.now();
    spec.runs = (spec.runs ?? 0) + 1;
    const prevLast = spec.last ?? {};
    spec.greenAt ??= {};
    spec.firstRedAt ??= {};
    spec.savesSinceRed ??= {};
    const rep = targetSpec(order, results);
    outcome.target = rep.target;
    outcome.display = rep.display;

    // Saves while a spec is the target: full spec weight only within 3 of them.
    if (this.lastTarget && order.includes(this.lastTarget) && spec.greenAt[this.lastTarget] === undefined) {
      spec.savesSinceRed[this.lastTarget] = (spec.savesSinceRed[this.lastTarget] ?? 0) + 1;
    }
    if (rep.target && spec.savesSinceRed[rep.target] === undefined) {
      spec.savesSinceRed[rep.target] = 0;
      spec.firstRedAt[rep.target] = now;
    }

    const turnedGreen: string[] = [];
    const turnedRed: string[] = [];
    const firstGreens: string[] = [];
    for (const id of order) {
      const r = results[id];
      const was = prevLast[id];
      if (r?.pass && !was?.pass) turnedGreen.push(id);
      if (r && !r.pass && r.status !== 'not-run' && was?.pass) turnedRed.push(id);
      if (r?.pass && spec.greenAt[id] === undefined) firstGreens.push(id);
    }
    const previousGreenAt = Object.values(spec.greenAt).reduce<number | undefined>((m, v) => (m === undefined || v > m ? v : m), undefined);
    for (const id of firstGreens) spec.greenAt[id] = now;
    spec.last = Object.fromEntries(order.filter((id) => results[id]).map((id) => [id, storedResult(results[id])]));

    const ladder = visibleTitles(task.fade, spec);
    this.report(task, spec, visible, results, rep.target, rep.display, ladder, fns, changedFns, trigger, codeHash(text));
    if (le) {
      // 'not-exported' (or a crash part-way): the other specs still ran. The export nudge goes on
      // the function's def line, above any signature nudge there.
      const nudge = this.toNudge(le, ws, file);
      if (nudge.line === undefined && le.kind === 'not-exported' && le.name) {
        const loc = fns.find((f) => f.name === le.name);
        if (loc) {
          nudge.line = loc.defLine;
          nudge.uri = this.ifaceUri;
          nudge.fsPath = file;
        }
      }
      if (le.kind === 'not-exported' && nudge.uri && nudge.line !== undefined) {
        this.deps.annotations.set({ uri: nudge.uri, line: nudge.line, source: 'spec', text: nudge.message, hover: mdEscape(nudge.message) });
      }
      this.on.onLoadError?.(nudge);
    }

    // Evidence: first greens, in ladder order.
    for (const id of firstGreens) {
      const s = spec.specs.find((x) => x.id === id)!;
      const learnerFn = calleeOf(visible.find((x) => x.id === id)?.call ?? s.call);
      const ifaceFn = calleeOf(s.call);
      const assisted = !!task.assistedFunctions?.some((f) => f === learnerFn || f === ifaceFn);
      const saves = spec.savesSinceRed[id];
      const info: GreenInfo = { spec: s, number: order.indexOf(id) + 1, savesSinceRed: saves, assisted, at: now, previousGreenAt, trigger };
      this.on.onGreen?.(id, specEvidenceWeight(saves, assisted), info);
    }

    this.lastTarget = rep.target;
    const allGreen = order.length > 0 && order.every((id) => results[id]?.pass);
    this.emitUpdate({ turnedGreen, turnedRed, trigger, ladder, target: rep.target, display: rep.display });
    this.runEmitter.fire(outcome);

    if (allGreen && !this.lastAllGreen) this.on.onAllVisibleGreen?.();
    this.lastAllGreen = allGreen;
    if (allGreen && !this.hiddenPassed) {
      const hidden = await this.runHidden(spec, mapped, ws, file, runner, gen);
      if (hidden && gen === this.gen) {
        outcome.hidden = hidden;
        if (hidden.pass) this.hiddenPassed = true;
        else spec.overfit = true;
        this.on.onHiddenResult?.(hidden);
        this.emitUpdate({ turnedGreen: [], turnedRed: [], trigger });
      }
    }
    return outcome;
  }

  /** One harness process: spec JSON in globalStorage/specs, the same timeout in the JSON and for the process. */
  private async harness(specs: SpecItem[], ws: string, file: string, state: TaskSpecState, runner: Runner, gen: number): Promise<HarnessRun | undefined> {
    const timeoutMs = specTimeoutMs(state.importMs);
    const slow = (state.importMs ?? 0) > SLOW_IMPORT_MS;
    if (slow) {
      this.deps.actions.enqueue({ id: SPEC_ACTION_IDS.running, kind: 'info', label: status.runningSpecs(), priority: PRIORITY.running, blocking: false, command: this.ladderCommand });
    }
    const ac = new AbortController();
    this.abort = ac;
    try {
      await this.fs.mkdir(this.deps.specDir);
      const json = path.join(this.deps.specDir, specFileName(this.task!.id));
      const functions = this.task!.interface.functions.map((f) => this.task!.interface.mappedNames?.[f.name] ?? f.name);
      await this.fs.writeFile(json, JSON.stringify(buildHarnessInput(specs, { workspace: ws, timeoutMs, functions })));
      if (gen !== this.gen || ac.signal.aborted) return undefined;
      const script = path.join(this.deps.harnessDir, this.lang === 'python' ? 'harness.py' : 'harness.mjs');
      const r = await runner.runLearnerCode(script, [file, json], { workspaceDir: ws, readDirs: [this.deps.specDir], timeoutMs, signal: ac.signal });
      if (gen !== this.gen || ac.signal.aborted) return undefined;
      return parseHarnessOutput(r.stdout, r.stderr, r.timedOut, { ids: specs.map((s) => s.id) });
    } catch (e) {
      if (ac.signal.aborted || gen !== this.gen) return undefined;
      const message = e instanceof Error ? e.message : String(e);
      this.log(`specs: harness run failed: ${message}`);
      this.on.onLoadError?.({ kind: 'runner', message: `The spec run failed: ${message}` });
      return undefined;
    } finally {
      if (this.abort === ac) this.abort = undefined;
      if (slow) this.deps.actions.remove(SPEC_ACTION_IDS.running);
    }
  }

  /** Hidden specs: the first one that fails (or does not finish) gives the card; not-run is inconclusive. */
  private async runHidden(spec: TaskSpecState, mapped: Record<string, string>, ws: string, file: string, runner: Runner, gen: number): Promise<HiddenResult | undefined> {
    const hidden = rewriteSpecCalls(spec.hidden ?? [], mapped);
    if (!hidden.length) return { pass: true };
    const rep = await this.harness(hidden, ws, file, spec, runner, gen);
    if (!rep || gen !== this.gen) return undefined;
    const by = new Map(rep.results.map((r) => [r.id, r]));
    const failed = hidden.find((s) => {
      const r = by.get(s.id);
      return !!r && !r.pass && r.status !== 'not-run';
    });
    if (failed) {
      const result = storedResult(by.get(failed.id)!);
      return { pass: false, spec: failed, result, card: hiddenFailureCard(failed, result) };
    }
    if (hidden.every((s) => by.get(s.id)?.pass)) return { pass: true };
    this.log(`specs: hidden run inconclusive${rep.loadError ? `: ${rep.loadError.message}` : ''}`);
    return undefined;
  }

  // ------------------------------------------------------------------ reporting

  private report(
    task: SpecTask, spec: TaskSpecState, visible: SpecItem[], results: Record<string, HarnessSpecResult>, target: string | undefined,
    display: Record<string, SpecDisplay>, ladder: VisibleLadder, fns: FunctionLoc[], changedFns: Set<string>, trigger: RunTrigger,
    textKey: string,
  ): void {
    const uri = this.ifaceUri!;
    const order = spec.specs.map((s) => s.id);
    const solo = task.solo || task.fade === 'solo';
    const fnLoc = (name: string | undefined) => (name ? fns.find((f) => f.name === name) : undefined);
    const targetIdx = target ? order.indexOf(target) : -1;
    const targetRun = target ? visible.find((s) => s.id === target) : undefined;
    const targetFn = fnLoc(calleeOf(targetRun?.call ?? ''));
    const titleVisible = !!target && ladder.titles.some((t) => t.id === target);

    // Gutter: one icon per spec function, failed only for the target's function.
    this.deps.annotations.clearGutter(uri, 'pass');
    this.deps.annotations.clearGutter(uri, 'fail');
    this.gutterFiles.add(uri);
    const byFn = new Map<string, string[]>();
    for (const s of visible) {
      const fn = calleeOf(s.call);
      if (fn) byFn.set(fn, [...(byFn.get(fn) ?? []), s.id]);
    }
    for (const [fn, ids] of byFn) {
      const loc = fnLoc(fn);
      if (!loc) continue;
      if (target && ids.includes(target)) {
        const head = titleVisible ? `**Spec ${targetIdx + 1}: ${mdEscape(spec.specs[targetIdx].title)}**` : `**${mdEscape(ladder.summary)}**`;
        this.deps.annotations.setGutter(uri, loc.defLine, 'fail', `${head}\n\n${mdEscape(actualLine(targetRun!.call, results[target]))}`);
      } else if (ids.every((id) => results[id]?.pass)) {
        this.deps.annotations.setGutter(uri, loc.defLine, 'pass', mdEscape(`${ids.length} of ${ids.length} specs pass`));
      }
    }

    // Signature nudge on the target's def line (never in solo tasks).
    this.deps.annotations.clear('spec');
    if (target !== this.lastTarget) this.deps.actions.remove(SPEC_ACTION_IDS.stuck);
    if (target && !solo) {
      const original = spec.specs[targetIdx];
      const r = results[target];
      const sig = signatureMatch(r, original, this.lang);
      if (sig) {
        const text = `spec ${targetIdx + 1}: ${sig.nudge}`;
        if (targetFn) {
          this.deps.annotations.set({ uri, line: targetFn.defLine, source: 'spec', text, hover: mdEscape(`${text} · ${actualLine(targetRun!.call, r)}`) });
        }
        // One observation per attempt: the same signature after the code changed counts again;
        // re-saving unchanged code does not.
        const k = String(original.failureSignatures.indexOf(sig));
        const obs = `${k}|${textKey}`;
        const seen = this.sigSeen.get(target) ?? { key: '', counts: {} };
        const info: SignatureInfo = { count: seen.counts[k] ?? 0, result: storedResult(r), number: targetIdx + 1, firstRedAt: spec.firstRedAt[target] };
        if (seen.key !== obs) {
          seen.key = obs;
          seen.counts[k] = (seen.counts[k] ?? 0) + 1;
          this.sigSeen.set(target, seen);
          info.count = seen.counts[k];
          this.on.onSignature?.(original, sig, info);
        }
        this.checkStuck(original, sig, info);
      }
    }

    // Tempo bar: '3/5 · next: <title>' (or 'n of m behaviours pass' when titles fade out).
    this.showProgress(ladder);

    // JIT atom offer when the target changes (not solo), once more on the first save touching its function.
    if (solo) return;
    const save = trigger === 'manual' || trigger === 'auto' || trigger === 'continuous';
    if (target !== this.lastTarget) {
      this.deps.actions.remove(SPEC_ACTION_IDS.jit);
      this.jit = undefined;
      if (target && this.offerJit(spec.specs[targetIdx], titleVisible)) {
        const fn = calleeOf(targetRun?.call ?? '') ?? '';
        this.jit = { specId: target, fn, hash: this.fnHashes.get(fn), reoffered: false };
      }
    } else if (save && this.jit && this.jit.specId === target && !this.jit.reoffered && changedFns.has(this.jit.fn) && !this.stuckOffered.has(target)) {
      this.jit.reoffered = true;
      this.deps.actions.remove(SPEC_ACTION_IDS.jit);
      this.offerJit(spec.specs[targetIdx], titleVisible);
    }
  }

  /** 'next: <title> uses <pattern> · 60s drill?' when the concept is weak or a deferred gap. Returns whether it offered. */
  private offerJit(s: SpecItem, titleVisible: boolean): boolean {
    const info = this.deps.conceptInfo?.(s.conceptId);
    const deferred = this.deferred.has(s.conceptId);
    if (!deferred && !(info && info.p < JIT_MAX_P)) return false;
    const pattern = info?.pattern || s.conceptId;
    this.deps.actions.enqueue({
      id: SPEC_ACTION_IDS.jit, kind: 'jit-atom', label: status.jitOffer(pattern, titleVisible ? s.title : undefined),
      priority: PRIORITY.jit, blocking: false, command: this.deps.commands?.jit ?? 'deliberate.jitAtom', args: [s.conceptId, s.id],
    });
    return true;
  }

  /** The 2x-par rule (signatureStuck): queue one 'atom' offer for the spec's concept and tell the coach. */
  private checkStuck(s: SpecItem, sig: FailureSignature, info: SignatureInfo): void {
    if (this.stuckOffered.has(s.id) || info.count < 2 || info.firstRedAt === undefined) return;
    const now = this.clock.now();
    let activeMs = now - info.firstRedAt;
    if (this.deps.activeMsSince) {
      try {
        activeMs = this.deps.activeMsSince(info.firstRedAt);
      } catch (e) {
        this.log(`specs: active time lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!signatureStuck(info.count, activeMs, s.parSec)) return;
    this.stuckOffered.add(s.id);
    const pattern = this.deps.conceptInfo?.(s.conceptId)?.pattern || s.conceptId;
    if (this.jit?.specId === s.id) this.deps.actions.remove(SPEC_ACTION_IDS.jit); // superseded: one offer per concept
    this.deps.actions.enqueue({
      id: SPEC_ACTION_IDS.stuck, kind: 'atom', label: stuckOfferLabel(pattern), priority: PRIORITY.stuck, blocking: false,
      command: this.deps.commands?.jit ?? 'deliberate.jitAtom', args: [s.conceptId, s.id],
    });
    this.on.onSignatureStuck?.(s, sig, { ...info, activeMs });
  }

  private showProgress(ladder = this.ladder()): void {
    const t = this.task;
    if (!t || !ladder || !this.applicable) return;
    const faded = t.fade === 'minimal' || t.fade === 'solo';
    const label = faded ? statusText('beaker', ladder.summary) : status.specProgress(ladder.passed, ladder.total, ladder.next);
    this.deps.actions.remove(SPEC_ACTION_IDS.progress);
    this.deps.actions.enqueue({ id: SPEC_ACTION_IDS.progress, kind: 'spec', label, priority: PRIORITY.progress, blocking: false, command: this.ladderCommand });
  }

  private get ladderCommand(): string {
    return this.deps.commands?.ladder ?? 'deliberate.open';
  }

  private emitUpdate(u: Partial<SpecUpdate> & Pick<SpecUpdate, 'turnedGreen' | 'turnedRed'>): void {
    const t = this.task;
    if (!t?.spec) return;
    const ladder = u.ladder ?? visibleTitles(t.fade, t.spec);
    const rep = targetSpec(t.spec.specs.map((s) => s.id), t.spec.last ?? {});
    this.on.onUpdate?.({
      ladder, target: u.target ?? rep.target, display: u.display ?? rep.display, turnedGreen: u.turnedGreen, turnedRed: u.turnedRed,
      pending: [...this.pending], trigger: u.trigger, loadError: u.loadError,
    });
  }

  private clearSurfaces(): void {
    this.deps.annotations.clear('spec');
    for (const uri of this.gutterFiles) {
      this.deps.annotations.clearGutter(uri, 'pass');
      this.deps.annotations.clearGutter(uri, 'fail');
    }
    this.gutterFiles.clear();
    for (const id of Object.values(SPEC_ACTION_IDS)) this.deps.actions.remove(id);
  }

  private toNudge(le: HarnessLoadError, ws: string, file: string): LoadNudge {
    const nudge: LoadNudge = { kind: le.kind, message: le.message };
    if (le.name) nudge.name = le.name;
    if (le.why) nudge.why = le.why;
    const target = le.file ? path.resolve(ws, le.file) : file;
    if (within(target, ws) || samePath(target, file)) {
      nudge.fsPath = target;
      nudge.uri = this.deps.uriOf(target);
      if (typeof le.line === 'number' && le.line >= 1) nudge.line = le.line - 1;
    }
    return nudge;
  }

  // ------------------------------------------------------------------ mapping and functions

  private applyMapping(m: MappingResult): void {
    const t = this.task!;
    this.pending = [...m.pending, ...m.ambiguous];
    const names = Object.keys(m.mappedNames);
    if (names.length) t.interface.mappedNames = { ...m.mappedNames };
    else if (t.interface.mappedNames && Object.keys(t.interface.mappedNames).length) t.interface.mappedNames = {};
  }

  private async functionsOf(file: string, text: string): Promise<FunctionLoc[]> {
    try {
      return this.deps.functions ? await this.deps.functions(file, text, this.lang) : functionsFromText(text, this.lang);
    } catch (e) {
      this.log(`specs: function lookup failed: ${e instanceof Error ? e.message : String(e)}`);
      return functionsFromText(text, this.lang);
    }
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }

  // ------------------------------------------------------------------ verification (prefetch)

  /**
   * verifySpecLadder with this controller's harness and temp dirs. Reads the interface file's
   * current text and function ranges when not given. Runs learner code (the merged reference and
   * stub variants), so it needs the same consent and trust as spec runs.
   */
  async verifyLadder(
    draft: SpecLadderDraft,
    iface: TaskInterface,
    o: { runner: Runner | undefined; allowRun: boolean; repair?: VerifyDeps['repair']; signal?: AbortSignal; learnerSource?: string; functionRanges?: FunctionRange[] },
  ): Promise<VerifyResult> {
    const ws = this.deps.workspaceDir();
    if (!ws) return notApplicable('open the project folder to run behaviour specs');
    if (!o.runner) return notApplicable('no runtime for the spec harness');
    let source = o.learnerSource;
    let ranges = o.functionRanges;
    const abs = path.resolve(ws, iface.file);
    if (source === undefined && within(abs, ws) && (await this.fs.exists(abs))) source = await this.deps.readText(abs);
    if (!ranges && source !== undefined) ranges = toFunctionRanges(await this.functionsOf(abs, source));
    return verifyLadder(draft, iface, {
      runner: o.runner, allowRun: o.allowRun, workspaceDir: ws, harnessDir: this.deps.harnessDir,
      tmpRoot: this.deps.verifyDir ?? path.join(path.dirname(this.deps.specDir), 'verify'),
      learnerSource: source, functionRanges: ranges, repair: o.repair, signal: o.signal, log: this.deps.log,
    });
  }
}

/** The fields of a harness result worth persisting in Task.spec.last. */
function storedResult(r: HarnessSpecResult): HarnessSpecResult {
  const out: HarnessSpecResult = { id: r.id, pass: r.pass };
  if (r.status) out.status = r.status;
  if (r.actual !== undefined) out.actual = r.actual;
  if (r.error !== undefined) out.error = r.error;
  if (r.exception) out.exception = r.exception;
  if (r.line !== undefined) out.line = r.line;
  if (r.sig !== undefined) out.sig = r.sig;
  if (r.stdout) out.stdout = r.stdout;
  if (r.val && JSON.stringify(r.val).length <= 2000) out.val = r.val;
  return out;
}

function notApplicable(reason: string): VerifyResult {
  return { applicable: false, verified: false, reason, specs: [], hidden: [], dropped: [], repaired: false };
}

// =====================================================================================
// verifyLadder (prefetch)
// =====================================================================================

export interface VerifyLadderDeps {
  runner: Runner;
  /** Consent 'all' and a trusted workspace: verification runs learner code too. */
  allowRun: boolean;
  workspaceDir: string;
  harnessDir: string;
  /** globalStorage/verify. */
  tmpRoot: string;
  learnerSource?: string;
  functionRanges?: FunctionRange[];
  /** The coach's one low-effort SpecLadderPart repair call. */
  repair?: VerifyDeps['repair'];
  signal?: AbortSignal;
  log?: (msg: string) => void;
  fs?: VerifyFs;
}

/** specsCore.verifySpecLadder behind the consent check and the Node TS import caveat. */
export async function verifyLadder(draft: SpecLadderDraft, iface: TaskInterface, deps: VerifyLadderDeps): Promise<VerifyResult> {
  if (!deps.allowRun) return notApplicable('running your code is off (needs consent and a trusted workspace)');
  const caveat = tsImportCaveat(deps.runner.runtime, deps.learnerSource ?? draft.reference);
  if (caveat) return notApplicable(caveat);
  return verifySpecLadder(draft, iface, {
    runner: deps.runner, workspaceDir: deps.workspaceDir, harnessDir: deps.harnessDir, tmpRoot: deps.tmpRoot,
    learnerSource: deps.learnerSource, functionRanges: deps.functionRanges, repair: deps.repair, signal: deps.signal, log: deps.log, fs: deps.fs,
  });
}

// =====================================================================================
// VS Code host pieces (thin)
// =====================================================================================

/** The vscode-facing SpecControllerDeps (and PredictFlow/WhatIfFlow deps): text, symbols, diagnostics, uris. */
export function vscodeSpecHost(): Pick<SpecControllerDeps, 'workspaceDir' | 'uriOf' | 'readText' | 'functions' | 'errorCount'> {
  return {
    workspaceDir: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    uriOf: (fsPath) => vscode.Uri.file(fsPath).toString(),
    readText: async (fsPath) => {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, fsPath));
      if (doc) return doc.getText();
      try {
        return await fsp.readFile(fsPath, 'utf8');
      } catch {
        return undefined;
      }
    },
    functions: (fsPath, text, lang) => documentFunctions(vscode.Uri.file(fsPath), text, lang),
    errorCount: (uri) => vscode.languages.getDiagnostics(vscode.Uri.parse(uri)).filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
  };
}

/** Pure: what a Testing-view run publishes for each spec (target-only reporting). */
export type TestPublish =
  | { id: string; kind: 'passed'; ms?: number }
  | { id: string; kind: 'failed'; message: string; expected: string; actual: string; line?: number }
  | { id: string; kind: 'skipped' }
  | { id: string; kind: 'errored'; message: string };

/**
 * Testing-view results for one run: passed, failed for the target only (TestMessage.diff with the
 * expected and actual values, at the def line), skipped for the rest, errored with the stderr tail
 * on a harness crash or load problem.
 */
export function testResults(o: SpecRunOutcome, original: readonly SpecItem[]): TestPublish[] {
  const le = o.report.loadError;
  const blocked = !!le && le.kind !== 'not-exported' && o.specs.every((s) => (o.results[s.id]?.status ?? 'not-run') === 'not-run');
  return o.specs.map((s): TestPublish => {
    if (blocked) return { id: s.id, kind: 'errored', message: le!.message };
    const r = o.results[s.id];
    if (r?.pass) return { id: s.id, kind: 'passed', ms: undefined };
    if (s.id !== o.target) return { id: s.id, kind: 'skipped' };
    if (le?.kind === 'crash' && r?.error && /harness crashed/.test(r.error)) return { id: s.id, kind: 'errored', message: r.error };
    const spec = original.find((x) => x.id === s.id) ?? s;
    const expected = spec.expectError ? `raises ${spec.expectError}` : spec.expected;
    const actual = r?.status === 'timeout' ? 'does not finish (infinite loop?)' : r?.actual !== undefined && !r.error ? r.actual : r?.error ? `raises ${r.error}` : 'nothing';
    const out: TestPublish = { id: s.id, kind: 'failed', message: `${spec.title}: ${actualLine(s.call, r ?? { id: s.id, pass: false })}`, expected, actual };
    const loc = o.functions.find((f) => f.name === calleeOf(s.call));
    if (loc) out.line = loc.defLine;
    return out;
  });
}

/**
 * The Testing view (spec V1-11 REPORTING): one root item per task, one child per visible spec at
 * its function's def line, and a 'Run specs' profile with continuous support. Results are published
 * only for runs the learner starts here, or continuous runs; save-triggered runs never create a
 * TestRun.
 */
export class SpecTestView {
  private readonly ctrl: vscode.TestController;
  private readonly subs: vscode.Disposable[] = [];
  private items = new Map<string, vscode.TestItem>();
  private root?: vscode.TestItem;
  private task?: SpecTask;
  /** Active continuous requests: each change creates one TestRun per request. */
  private continuous = new Map<vscode.TestRunRequest, () => void>();

  constructor(private readonly specs: SpecController) {
    this.ctrl = vscode.tests.createTestController('deliberate.specs', 'Deliberate specs');
    this.ctrl.createRunProfile('Run specs', vscode.TestRunProfileKind.Run, (req, token) => this.handle(req, token), true, undefined, true);
    this.subs.push(specs.onDidRun((o) => this.afterRun(o)));
  }

  /** Show the attached task's visible specs (call after SpecController.attach succeeds). */
  show(task: SpecTask, file: string, functions: readonly FunctionLoc[] = []): void {
    this.clear();
    const spec = task.spec;
    if (!spec || !this.specs.applicable) return;
    this.task = task;
    const uri = vscode.Uri.file(file);
    const root = this.ctrl.createTestItem(`task:${task.id}`, task.title || task.id, uri);
    for (const s of spec.specs) {
      const item = this.ctrl.createTestItem(s.id, s.id, uri);
      root.children.add(item);
      this.items.set(s.id, item);
    }
    this.ctrl.items.replace([root]);
    this.root = root;
    this.refresh(functions);
  }

  clear(): void {
    for (const stop of [...this.continuous.values()]) stop();
    this.continuous.clear();
    this.ctrl.items.replace([]);
    this.items.clear();
    this.root = undefined;
    this.task = undefined;
    this.specs.setContinuous(false);
  }

  /** Labels follow the fade (titles appear as earlier specs turn green); ranges follow the def lines. */
  private refresh(functions: readonly FunctionLoc[]): void {
    const task = this.task;
    if (!task?.spec) return;
    const ladder = visibleTitles(task.fade, task.spec);
    task.spec.specs.forEach((s, i) => {
      const item = this.items.get(s.id);
      if (!item) return;
      item.label = ladder.titles.some((t) => t.id === s.id) ? `${i + 1}. ${s.title}` : `Spec ${i + 1}`;
      const fn = calleeOf(rewriteSpecCalls([s], task.interface.mappedNames ?? {})[0].call);
      const loc = functions.find((f) => f.name === fn);
      if (loc) item.range = new vscode.Range(loc.defLine, 0, loc.defLine, 0);
    });
  }

  /** Spec ids a request covers (include / exclude; the root means all). */
  private selected(req: vscode.TestRunRequest): Set<string> {
    const all = [...this.items.keys()];
    const inc = req.include?.length && !req.include.some((i) => i === this.root) ? req.include.map((i) => i.id).filter((id) => this.items.has(id)) : all;
    const exc = new Set((req.exclude ?? []).map((i) => i.id));
    return new Set(inc.filter((id) => !exc.has(id)));
  }

  private handle(req: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    if (req.continuous) {
      // Runs come from saves from now on (the controller marks them 'continuous'); one TestRun each.
      return new Promise<void>((resolve) => {
        const stop = () => {
          this.continuous.delete(req);
          if (!this.continuous.size) this.specs.setContinuous(false);
          resolve();
        };
        this.continuous.set(req, stop);
        this.specs.setContinuous(true);
        token.onCancellationRequested(stop);
      });
    }
    return this.runOnce(req, token);
  }

  private async runOnce(req: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const run = this.ctrl.createTestRun(req, 'Deliberate specs', false);
    const ids = this.selected(req);
    try {
      for (const id of ids) run.started(this.items.get(id)!);
      const o = await this.specs.runNow('learner');
      if (token.isCancellationRequested) return;
      if (!o) {
        for (const id of ids) run.skipped(this.items.get(id)!);
        return;
      }
      this.publish(run, o, ids);
    } finally {
      run.end();
    }
  }

  private afterRun(o: SpecRunOutcome): void {
    if (!this.task) return;
    this.refresh(o.functions);
    if (o.trigger !== 'continuous') return; // save-triggered runs never create a TestRun
    for (const req of this.continuous.keys()) {
      const run = this.ctrl.createTestRun(req, 'Deliberate specs (continuous)', false);
      try {
        this.publish(run, o, this.selected(req));
      } finally {
        run.end();
      }
    }
  }

  private publish(run: vscode.TestRun, o: SpecRunOutcome, ids: Set<string>): void {
    const original = this.task?.spec?.specs ?? o.specs;
    const uri = vscode.Uri.file(o.file);
    for (const p of testResults(o, original)) {
      const item = this.items.get(p.id);
      if (!item || !ids.has(p.id)) continue;
      switch (p.kind) {
        case 'passed':
          run.passed(item, p.ms);
          break;
        case 'skipped':
          run.skipped(item);
          break;
        case 'errored':
          run.errored(item, new vscode.TestMessage(p.message));
          break;
        case 'failed': {
          const msg = vscode.TestMessage.diff(p.message, p.expected, p.actual);
          if (p.line !== undefined) msg.location = new vscode.Location(uri, new vscode.Position(p.line, 0));
          run.failed(item, msg);
          break;
        }
      }
    }
  }

  dispose(): void {
    this.clear();
    for (const s of this.subs) s.dispose();
    this.ctrl.dispose();
  }
}
