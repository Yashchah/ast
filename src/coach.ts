// The coaching flow (spec v0.2 "fast loop"): goal -> language -> project shell -> PlanOutline in the
// background while placement runs in the pad -> plan merge (concept aliases by tag) -> task start with
// the interface card and the gate decision -> gap atoms -> building with the spec ladder, own-code
// probes and the prefetched hint ladder -> hidden specs -> what-ifs -> next task at once.
//
// The model is never between the learner and their next action: every call the learner did not ask to
// wait for goes through the Prefetcher (background lane, generation tokens). The foreground lane is
// used only for Ask, Reveal, a mini-atom Teach and spec-less Check my work. Local modal flows (pad,
// gate QuickPicks, own-code InputBoxes) take the InteractionLock; when it is held they queue a tempo
// action instead of opening.
//
// Everything vscode-facing is behind small interfaces (CoachHost, PadLike, GateRunner, SpecsLike, ...)
// so test/flow.test.ts drives the whole flow with fakes; vscodeCoachHost() is the thin real host.

import * as nodePath from 'path';
import * as vscode from 'vscode';
import type {
  Action, AtomResult, Gen, HintPrefetch, Lang, PauseKind, Runner, StoredAtom, TaskInterface,
} from './contracts';
import { auditDue, parSelf, touch, type EvidenceRecord } from './evidence';
import { Emitter, isAbortError, type Disposable, type Event, type JobQueue } from './jobs';
import type { InteractionLock, LockKind } from './lock';
import {
  concept, conceptChip, conceptMastered, DECOMPOSITION, recordEvidence, recordHintEvidence, recordMistake, recordSolve, slug, snapshot,
  stuckThreshold, upsertConcepts, weakest,
} from './learner';
import {
  HINT_RUNGS, MAX_RUNG, SYSTEM, askPrompt, explanationReviewPrompt, gradePrompt, guideApproachPrompt, interfaceLine, projectBrief,
  revealPrompt, rungHintPrompt, shortLessonPrompt, taskBrief, workReviewPrompt,
} from './prompts';
import {
  AnswerSchema, ExplanationReviewSchema, GradeSchema, HintSchema, RevealSchema, WorkReviewSchema, type ExplanationReview, type FollowUp,
  type HintResult, type PlanOutline, type TaskOut,
} from './schemas';
import type { Card, ConceptState, Learner, Phase, Project, StuckSignals, Task } from './types';
import { md, uid } from './util';
import { gatherCodeContext, type CodeContextMonitor } from './context';
import { gateDecision, routeGaps, taskFade, type GateRouting } from './gateCore';
import { CACHE_MISS_CARD, gateRouting, type GatePrep, type GateResult, type GateRunOptions, type GateTaskLike } from './gate';
import { hintLadderPrompt, prefetchedRung, prefetchKey, type OwnProbeResult, type Rung0, type ShowHintRequest, type ShownHint, type HintClearReason } from './hints';
import {
  ModelProbeTrigger, conflictFlag, ownCodeProbePrompt, specsGreenFast, whatIfCount, type PredictContext, type PredictResult,
  type PreparedProbe, type WhatIfContext, type WhatIfRunResult,
} from './owncode';
import type { AttachOptions, AttachResult, HiddenResult, RunTrigger, SpecCallbacks, SpecTask } from './specs';
import { DESIGN_DIFFERS, type VisibleLadder } from './specsCore';
import { STATE_FLASH_MS, sprintCapReached, status, statusText } from './tempo';
import type { ActionSink } from './tempoBar';
import type { AtomCache } from './atoms/cache';
import type { AtomPad, AtomRunOptions, LessonRequest, PadLogCard } from './atoms/pad';
import type { PlacementRunOptions, PlacementRunResult } from './atoms/placementRun';
import type { SprintOptions, SprintResult } from './atoms/sprint';
import { commentToken } from './atoms/grade';
import { indentTo4, snippetString, type LessonText, type PadRender, type SnippetPart } from './atoms/render';
import { OTHER_TAG, PLACEMENT_FUNDAMENTALS, TAXONOMY, tagInfo } from './atoms/tags';
import { NO_RUNNER_REASON, packKey, planTag, Prefetcher, type HintContext, type LlmLike, type PrefetchDeps, type PreparedTask, type SeedSource } from './atoms/prefetch';
import { runtimeLabel, taxonomyFor } from './atoms/prompts';
import type { StuckDetector } from './stuck';

// =====================================================================================
// Constants
// =====================================================================================

export const COACH = {
  /** A wait the learner started is filled with a sprint after this long (spec V1-9 b). */
  waitFillMs: 3000,
  /** No edit in this long before a sprint may open by itself. */
  noEditMs: 8000,
  /** Solo tasks stop at rung 2 (spec V1-8). */
  soloMaxRung: 2,
  /** Placement usually ends this long after Start (TaskPrep's neededBy before task 1). */
  placementExpectedMs: 3 * 60_000,
  /** How long completeTask waits for a follow-up that is still being written. */
  followUpWaitMs: 20_000,
  /** Own-code predict offers: at most once per 3 active minutes. */
  ownPredictSpacingMs: 3 * 60_000,
  /** The known-gap shortcut and the conflict flag scale the stuck threshold. */
  knownGapFactor: 0.6,
  notUnderstoodFactor: 0.75,
  /** Follow-up policy (spec V1-9 f). */
  followUpMaxP: 0.6,
  /** Warm-up offer: at least this many due items. */
  warmupDue: 2,
  warmupMs: 60_000,
  sprintMs: 180_000,
  feedCap: 200,
} as const;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

// =====================================================================================
// Ports (all injected; the extension passes the real modules, tests pass fakes)
// =====================================================================================

export interface CoachConfig {
  stuckMinutes: number;
  proactive: 'offer' | 'auto' | 'off';
  maxFollowUps: number;
  planEffort: 'medium' | 'high';
  polishReview: boolean;
}

/** The vscode-facing bits of the coach (vscodeCoachHost() in the extension, a fake in tests). */
export interface CoachHost {
  config(): CoachConfig;
  /** Code-file extensions in the workspace with their counts, most frequent first: [['py', 12], ...]. */
  workspaceExtensions(): Promise<[string, number][]>;
  /** 'Which language?' QuickPick (Other opens an InputBox). Undefined = Esc. */
  pickLanguage(): Promise<string | undefined>;
  /** Modal confirmation; true when the learner picked `action`. */
  confirm(message: string, action: string): Promise<boolean>;
  /** vscode.window.state.focused */
  windowFocused(): boolean;
  /** workbench.action.focusActiveEditorGroup */
  focusEditor(): void;
  /** Reveal the sidebar and focus the composer (e.g. 'explain' after "I'd do it differently"). */
  focusComposer?(mode: string): void;
  /** withProgress(ProgressLocation.Window, title) around a promise. */
  withProgress?(title: string, p: Promise<unknown>): void;
  /** gatherCodeContext() for the task files. */
  codeSnapshot(taskFiles: string[]): Promise<string>;
  workspaceDir(): string | undefined;
  /** uri string of an absolute path (what the monitor and the annotation sinks key on). */
  uriOf(fsPath: string): string;
  /** Current text of an absolute path (open editor first, else disk). */
  readText(fsPath: string): Promise<string | undefined>;
  /** Function names in a file (document symbols, regex fallback). */
  functionNames?(fsPath: string, text: string, lang: Lang): Promise<string[]>;
  /** Current lines of a workspace-relative file. */
  readLines(file: string): Promise<string[] | undefined>;
  /** A short listing of the workspace's source files (prompts). */
  fileList?(): Promise<string>;
}

/** What the coach reads from src/store.ts Store. */
export interface StoreLike {
  learner: Learner;
  project: Project | undefined;
  save(): void;
  flush(): Promise<void>;
  resetProject(): Promise<void>;
  resetLearner(): Promise<void>;
  readEvidence?(since: number, until?: number): Promise<EvidenceRecord[]>;
}

/** What the coach reads from src/monitor.ts Monitor. */
export interface MonitorLike extends CodeContextMonitor {
  detector: StuckDetector;
  touchedFiles: Set<string>;
  lastEditAt: number;
  onTick: Event<number>;
  onPause?: Event<{ kind: PauseKind; at: number }>;
  startTask(): void;
  currentErrors(): { file: string; line: number; message: string }[];
  setTaskFiles?(uris: readonly string[]): void;
  mark?(): number;
  changedLinesSince?(mark: number): number;
  errorSetHash?(): string;
  taskFileHash?(files: readonly string[]): Promise<string>;
  rung0?(lang?: Lang, now?: number): Rung0 | undefined;
}

/** The tempo bar (src/tempoBar.ts TempoBar): the single 'what next' surface. */
export interface TempoSink extends ActionSink {
  update?(): void;
  onDidSkip?: Event<Action>;
}

/** src/atoms/pad.ts AtomPad as the coach uses it (tests inject a fake). */
export interface PadLike {
  run(atom: StoredAtom, opts?: AtomRunOptions): Promise<AtomResult>;
  /** lock.acquire(kind) with the pad's abort callback; undefined when another modal flow holds the lock. */
  acquire(kind: LockKind): (() => void) | undefined;
  /** Close the pad tab when it is open with no flow running (e.g. left open for a drill that never came). */
  closeIdle?(): Promise<void>;
}

export interface PlacementLike {
  run(opts?: PlacementRunOptions): Promise<PlacementRunResult>;
  addCandidates(conceptIds: readonly string[]): void;
}

export interface SprintLike {
  run(opts: SprintOptions): Promise<SprintResult>;
  available(max?: number): number;
}

/** Rung 4: a skeleton in the pad (never in the project). Resolves when the pad closes. */
export type SkeletonRunner = (lang: Lang, code: string) => Promise<void>;

export interface GateRunner {
  run(task: GateTaskLike, prep: GatePrep | undefined, opts?: GateRunOptions): Promise<GateResult>;
}

/** src/specs.ts SpecController as the coach drives it. */
export interface SpecsLike {
  on: SpecCallbacks;
  readonly applicable: boolean;
  readonly taskId: string | undefined;
  attach(task: SpecTask, lang: Lang, runner: Runner | undefined, opts: AttachOptions): Promise<AttachResult>;
  detach(): void;
  runNow(trigger?: RunTrigger): Promise<unknown>;
  setAllowRun(allow: boolean): void;
  addDeferredConcepts(ids: readonly string[]): void;
  ladder(): VisibleLadder | undefined;
}

export interface PredictLike {
  prepare(ctx: PredictContext, o?: { skipAnsweredFunctions?: boolean }): Promise<PreparedProbe | undefined>;
  offer(ctx: PredictContext): Promise<PreparedProbe | undefined>;
  run(ctx: PredictContext, prepared?: PreparedProbe): Promise<PredictResult>;
  clearOffer(): void;
}

export interface WhatIfLike {
  run(ctx: WhatIfContext): Promise<WhatIfRunResult>;
}

/** src/hints.ts HintDisplay. */
export interface HintDisplayLike {
  show(req: ShowHintRequest): Promise<ShownHint | undefined>;
  clear(reason: HintClearReason): void;
}

/** src/atoms/stock.ts Stock as the coach uses it. */
export interface StockLike extends SeedSource {
  cacheKeyFor(learner: Learner, conceptId: string): string | undefined;
}

export interface RuntimeAccess {
  /** The runner for a language when execution is allowed (consent + workspace trust), else undefined. */
  runner(lang: Lang): Runner | undefined;
  /** Consent 'all' and a trusted workspace (spec ladders and own-code probes run learner code). */
  allowRun(): boolean;
}

export interface CoachDeps {
  store: StoreLike;
  llm: LlmLike;
  monitor: MonitorLike;
  jobs: JobQueue;
  lock: InteractionLock;
  host: CoachHost;
  tempo: TempoSink;
  runtime: RuntimeAccess;
  caches: (lang: Lang) => AtomCache | undefined;
  stocks: (lang: Lang) => StockLike | undefined;
  /** Built from these deps when omitted (prefetchDeps adds what only the prefetcher needs). */
  prefetcher?: Prefetcher;
  prefetchDeps?: Partial<Pick<PrefetchDeps, 'specs' | 'workspace' | 'contentLog'>>;
  pad?: PadLike;
  /** A fresh PlacementRun per run (it runs once). */
  placement?: (lang: Lang) => PlacementLike | undefined;
  /** A fresh Sprint per run (it runs once). */
  sprint?: (lang: Lang) => SprintLike | undefined;
  skeleton?: SkeletonRunner;
  gate?: GateRunner;
  specs?: SpecsLike;
  predict?: PredictLike;
  whatIf?: WhatIfLike;
  hints?: HintDisplayLike;
  log?: (line: string) => void;
  now?: () => number;
  /** Timer for the 3 s wait-fill rule and the follow-up wait (tests shorten it). */
  delays?: { waitFillMs?: number; followUpWaitMs?: number };
}

export interface InputMode {
  mode: string;
  placeholder: string;
  submitLabel: string;
  extras: { label: string; command: string; arg?: string }[];
  /** One line shown above the composer (the old MODE_LABELS). */
  label?: string;
}

// =====================================================================================
// Pure helpers (exported for tests)
// =====================================================================================

/** Runnable languages (seeds, pad, specs) by label. */
export function runnableLang(language: string | undefined): Lang | undefined {
  const l = (language ?? '').trim().toLowerCase();
  return l === 'python' || l === 'javascript' || l === 'typescript' ? l : undefined;
}

const EXT_LANG: Record<string, string> = {
  py: 'python', pyw: 'python', ipynb: 'python',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  go: 'go', java: 'java', rs: 'rust',
};

export function languageOfExtension(ext: string): string | undefined {
  return EXT_LANG[ext.replace(/^\./, '').toLowerCase()];
}

const KEYWORDS: [RegExp, string][] = [
  [/\b(python|py|django|flask|pandas)\b/i, 'python'],
  [/\b(typescript|ts|angular|nest(js|\.js)?)\b/i, 'typescript'],
  [/\b(javascript|js|node(\.js|js)?|react|express)\b/i, 'javascript'],
  [/\b(golang)\b|\b(in|with|using|learn|learning) go\b|\bgo (language|lang|program|cli|module|server)\b/i, 'go'],
  [/\b(java|spring)\b/i, 'java'],
  [/\b(rust|cargo)\b/i, 'rust'],
];

/** Languages named in the goal or background (spec V1-7 keyword table). */
export function languagesInText(text: string): string[] {
  const found = new Set<string>();
  for (const [re, lang] of KEYWORDS) if (re.test(text)) found.add(lang);
  // 'typescript' mentions also say 'javascript' only when both are named.
  return [...found];
}

/**
 * The project language: the top workspace code extension, or keywords in the goal or background.
 * No match, or a conflict between them (or between keywords), asks with a QuickPick.
 */
export function decideLanguage(exts: readonly [string, number][], goal: string, background: string): { lang?: string; ask: boolean } {
  const ws = exts.map(([e]) => languageOfExtension(e)).find((l): l is string => !!l);
  const kw = languagesInText(`${goal}\n${background}`);
  if (kw.length > 1) return { ask: true };
  if (ws && kw.length === 1 && kw[0] !== ws) return { ask: true };
  if (ws) return { lang: ws, ask: false };
  if (kw.length === 1) return { lang: kw[0], ask: false };
  return { ask: true };
}

/** A short project title from the goal (the plan no longer returns one). */
export function titleFromGoal(goal: string): string {
  const words = goal.trim().replace(/\s+/g, ' ').split(' ');
  const t = words.slice(0, 7).join(' ');
  const out = words.length > 7 ? `${t}...` : t;
  return out ? out[0].toUpperCase() + out.slice(1) : 'My project';
}

/** Fill the v0.2 task fields (stored v0.1 tasks and hand-built ones lack them). Returns the task. */
export function normTask(t: Task): Task & Required<Pick<Task, 'interface' | 'fade' | 'solo' | 'ownProbes' | 'whatIfs' | 'atomRuns' | 'pastedChars' | 'assistedChars' | 'assistedFunctions'>> {
  t.interface ??= { file: '', functions: [] };
  t.interface.functions ??= [];
  t.solo ??= false;
  t.fade ??= t.solo ? 'solo' : 'full';
  t.ownProbes ??= [];
  t.whatIfs ??= [];
  t.atomRuns ??= [];
  t.pastedChars ??= 0;
  t.assistedChars ??= 0;
  t.assistedFunctions ??= [];
  t.hints ??= [];
  t.feed ??= [];
  const legacy = t as Task & { pendingCheck?: unknown };
  if (legacy.pendingCheck !== undefined) {
    delete legacy.pendingCheck;
    if (t.phase === 'learning') t.phase = t.resumePhase ?? 'building';
  }
  // v0.1's mid-task 'Lock it in' check (after a hint) went back to building; v0.2's explain-back
  // only ever follows criteria met, and answering it completes the task.
  if (t.phase === 'explain-back' && t.resumePhase === 'building' && !t.criteriaMetAt) {
    t.phase = 'building';
    t.resumePhase = undefined;
    t.explainBackQuestion = undefined;
  }
  return t as ReturnType<typeof normTask>;
}

/** Fill the v0.2 project fields (a v0.1 project: placement done, no plan pending). */
export function normProject(p: Project): Project {
  const legacy = p as Project & { diagnostic?: unknown; pendingRecall?: unknown };
  delete legacy.diagnostic;
  delete legacy.pendingRecall;
  p.placement ??= { asked: [], startedAt: p.createdAt, done: true, selfRated: false, planPending: false, calibrated: false };
  p.prefetch ??= {};
  p.taskSwitch ??= 0;
  p.feed ??= [];
  p.milestones ??= [];
  p.tasks ??= {};
  p.conceptIds ??= [];
  p.lang ??= runnableLang(p.language);
  for (const t of Object.values(p.tasks)) normTask(t);
  return p;
}

/** Tasks in roadmap order (milestone by milestone). */
export function roadmapOrder(p: Project): Task[] {
  return p.milestones.flatMap((m) => m.taskIds).map((id) => p.tasks[id]).filter((t): t is Task => !!t);
}

/** The code of the first fenced block, else the whole text. */
export function fencedCode(text: string): string {
  const m = /```[^\n]*\n([\s\S]*?)```/.exec(text);
  return (m ? m[1] : text).replace(/\s+$/, '');
}

/** The skeleton pad render: header comments, then the code with each ___ as a snippet tab stop. */
export function skeletonRender(lang: Lang, code: string): PadRender {
  const tok = commentToken(lang);
  const head = [
    `${tok} Skeleton for the stuck piece - fill the ___ here, then write it in your own file`,
    `${tok} Esc Esc closes this tab (nothing here is copied into your project)`,
  ];
  const body = indentTo4(code.replace(/\r\n?/g, '\n').replace(/\s+$/, ''));
  const parts: SnippetPart[] = [];
  let text = `${head.join('\n')}\n`;
  let pending = text;
  let n = 0;
  let firstBlank: number | undefined;
  const pieces = body.split('___');
  pieces.forEach((piece, i) => {
    pending += piece;
    text += piece;
    if (i < pieces.length - 1) {
      if (pending) parts.push({ text: pending });
      pending = '';
      firstBlank ??= text.split('\n').length - 1;
      parts.push({ placeholder: ++n, value: '___' });
      text += '___';
    }
  });
  if (pending) parts.push({ text: pending });
  return {
    text, snippet: parts, snippetText: snippetString(parts), await: 'read', decorations: [], codeStart: head.length,
    answerLine: firstBlank ?? head.length,
  };
}

/**
 * Rung 4 in the pad through AtomPad's public flow API (the caller holds the lock as 'skeleton' only
 * while it renders). The skeleton is reference material, not a modal flow: it resolves once shown
 * and the pad stays open as an idle tab (Esc Esc or closing it ends it; the next pad flow reuses
 * it). Holding the flow or the lock while the learner codes would stall task completion (what-ifs
 * wait for the lock), tempo offers and the next hint.
 */
export function padSkeleton(pad: AtomPad): SkeletonRunner {
  return async (lang, code) => {
    const end = await pad.beginFlow('skeleton');
    try {
      const s = await pad.openSession(lang);
      await s.show(skeletonRender(lang, code));
    } catch (err) {
      await pad.closeSession().catch(() => undefined);
      throw err;
    } finally {
      end();
    }
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 'done' when p settles first, 'wait' after ms (the timer is cleared as soon as p settles). */
export function settleOrTimeout(p: Promise<unknown>, ms: number): Promise<'done' | 'wait'> {
  return new Promise((resolve) => {
    const h = setTimeout(() => resolve('wait'), Math.max(0, ms));
    const done = () => {
      clearTimeout(h);
      resolve('done');
    };
    p.then(done, done);
  });
}

const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

// =====================================================================================
// Coach
// =====================================================================================

type FullTask = ReturnType<typeof normTask>;
type AtomOpen = 'ran' | 'unavailable' | 'busy' | 'queued';

export interface PaceData {
  milestones: { title: string; tasksDone: number; activeMin: number; waitSec: number }[];
  solo: { title: string; activeMin: number; unaided: boolean }[];
  /** Median evidence bits per finished task. */
  bitsPerTask?: number;
  /** Share of hint rungs 1-3 served from the prefetch (target 70%). */
  prefetchedHints?: number;
  placement?: { items?: number; summary?: string };
  conflictFlags: number;
  overfitFlags: number;
  deadlineMisses: number;
}

export class Coach implements Disposable {
  signals: StuckSignals | undefined;
  readonly prefetcher: Prefetcher;
  private readonly changeEmitter = new Emitter<void>();
  private readonly statusEmitter = new Emitter<void>();
  readonly onChange = this.changeEmitter.event;
  readonly onStatus = this.statusEmitter.event;
  private readonly subs: Disposable[] = [];
  private readonly ownsPrefetcher: boolean;
  private readonly normalized = new WeakSet<Project>();
  private ticksSinceSave = 0;
  private placementRun: PlacementLike | undefined;
  private planJob: Promise<unknown> | undefined;
  private hintFlight: { taskId: string; p: Promise<void> } | undefined;
  private waitJob: Promise<unknown> | undefined;
  private readonly modelProbeTrigger = new ModelProbeTrigger();
  private readonly flows = new Set<Promise<unknown>>();
  private followUps = new Map<string, Promise<unknown>>();
  /** Tasks inside criteriaMet (what-ifs, then completion): a second trigger meanwhile is ignored. */
  private readonly completing = new Set<string>();
  private day = '';
  activeMsToday = 0;
  sprintMsToday = 0;
  /** (wall time, cumulative active ms) samples, for 'active ms since' (spec latency, 2x par). */
  private activeSamples: [number, number][] = [];
  private activeTotal = 0;
  private lastOwnOfferActive = Number.NEGATIVE_INFINITY;
  private episodeHinted = false;
  private lastSinceProgress = 0;
  private pace: PaceData | undefined;
  private prevNotUnderstood = false;

  constructor(private readonly deps: CoachDeps) {
    this.ownsPrefetcher = !deps.prefetcher;
    this.prefetcher = deps.prefetcher ?? new Prefetcher({
      jobs: deps.jobs, llm: deps.llm, gen: () => this.gen(), project: () => this.project, learner: () => this.learner,
      runner: (l) => deps.runtime.runner(l), allowRun: () => deps.runtime.allowRun(), cache: (l) => deps.caches(l), seeds: (l) => deps.stocks(l),
      planEffort: () => deps.host.config().planEffort, progress: (title, p) => deps.host.withProgress?.(title, p),
      onChange: () => this.changed(), onLate: (e) => this.onLate(e.key), log: (l) => this.log(l),
      workspace: { fileList: () => deps.host.fileList?.() ?? Promise.resolve(''), read: (rel) => this.readRelative(rel) },
      now: () => this.now(),
      ...deps.prefetchDeps,
    });
    this.subs.push(deps.monitor.onTick((ms) => this.onTick(ms)));
    if (deps.monitor.onPause) this.subs.push(deps.monitor.onPause((e) => this.onPause(e.kind)));
    if (deps.tempo.onDidSkip) this.subs.push(deps.tempo.onDidSkip((a) => this.onSkip(a)));
    if (deps.specs) deps.specs.on = this.specCallbacks();
    this.subs.push(deps.jobs.onDidChange(() => this.statusEmitter.fire()));
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs.length = 0;
    if (this.ownsPrefetcher) this.prefetcher.dispose();
    this.changeEmitter.dispose();
    this.statusEmitter.dispose();
  }

  // ------------------------------------------------------------ state access

  get project(): Project | undefined {
    const p = this.deps.store.project;
    if (p && !this.normalized.has(p)) {
      normProject(p);
      this.normalized.add(p);
    }
    return p;
  }

  get task(): FullTask | undefined {
    const p = this.project;
    const t = p?.currentTaskId ? p.tasks[p.currentTaskId] : undefined;
    return t ? normTask(t) : undefined;
  }

  get learner(): Learner {
    return this.deps.store.learner;
  }

  /** The foreground label while a call the learner waits on runs (the webview's busy bar). */
  get busy(): string | undefined {
    return this.deps.jobs.stats().fg;
  }

  /** The generation token every background job captures (spec V1-1 race rule). */
  gen(): Gen {
    const p = this.deps.store.project;
    return { projectCreatedAt: p?.createdAt ?? 0, taskId: p?.currentTaskId, taskSwitch: p?.taskSwitch ?? 0 };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }

  private get monitor(): MonitorLike {
    return this.deps.monitor;
  }

  private cfg(): CoachConfig {
    return this.deps.host.config();
  }

  /** Re-render after external state changes. */
  refresh(): void {
    this.signals = undefined;
    this.changed();
  }

  private changed(): void {
    this.deps.store.save();
    this.changeEmitter.fire();
    this.deps.tempo.update?.();
  }

  /** Track an async flow (tests await idle()). */
  private track<T>(p: Promise<T>): Promise<T> {
    this.flows.add(p);
    const done = () => this.flows.delete(p);
    p.then(done, done);
    return p;
  }

  /** Resolves when every flow the coach started has settled (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 50 && this.flows.size; i++) await Promise.allSettled([...this.flows]);
  }

  private feedOf(t?: Task): Card[] {
    return t?.feed ?? this.task?.feed ?? this.project?.feed ?? [];
  }

  private push(card: Omit<Card, 'id' | 'at'>, feed = this.feedOf()): Card {
    const full: Card = { id: uid('card'), at: this.now(), ...card };
    feed.push(full);
    if (feed.length > COACH.feedCap) feed.splice(0, feed.length - COACH.feedCap);
    return full;
  }

  private logCard(title: string, lines: string[], feed = this.feedOf()): Card {
    return this.push({ kind: 'log', title, html: md(lines.filter(Boolean).join('\n\n')) }, feed);
  }

  private errorCard(err: unknown, feed = this.feedOf()): void {
    this.push({ kind: 'error', title: 'Coach error', html: md(errorMessage(err)) }, feed);
    if (!(err && typeof err === 'object' && 'kind' in err)) this.log(`[coach] ${errorMessage(err)}`);
  }

  private learnerFor(ids: string[]): string {
    const withPrereqs = new Set(ids.map((id) => concept(this.learner, id)?.id ?? slug(id)));
    for (const id of ids) for (const pr of concept(this.learner, id)?.prerequisites ?? []) withPrereqs.add(pr);
    return snapshot(this.learner, [...withPrereqs]);
  }

  private recordTouchedFiles(t: Task): void {
    t.files ??= [];
    for (const u of this.monitor.touchedFiles) if (!t.files.includes(u)) t.files.push(u);
  }

  private codeSnapshot(t?: Task): Promise<string> {
    if (t) this.recordTouchedFiles(t);
    return this.deps.host.codeSnapshot(t ? this.taskFileUris(t) : []);
  }

  /** Absolute path of a workspace-relative file, or undefined without a workspace. */
  private absPath(rel: string): string | undefined {
    const ws = this.deps.host.workspaceDir();
    if (!ws || !rel) return undefined;
    return nodePath.isAbsolute(rel) ? rel : nodePath.join(ws, rel);
  }

  private async readRelative(rel: string): Promise<string | undefined> {
    const abs = this.absPath(rel);
    return abs ? this.deps.host.readText(abs) : undefined;
  }

  /** Task files (edited ones plus the interface file) as uri strings. */
  private taskFileUris(t: Task): string[] {
    const out = [...(t.files ?? [])];
    const abs = t.interface?.file ? this.absPath(t.interface.file) : undefined;
    if (abs) {
      const u = this.deps.host.uriOf(abs);
      if (!out.includes(u)) out.push(u);
    }
    return out;
  }

  private runner(lang: Lang | undefined): Runner | undefined {
    return lang ? this.deps.runtime.runner(lang) : undefined;
  }

  private allowRun(): boolean {
    return this.deps.runtime.allowRun();
  }

  private runtimeText(p: Project): string {
    const r = this.runner(p.lang);
    return r ? runtimeLabel(r.runtime) : `no local ${p.language} runtime found`;
  }

  /**
   * The foreground lane with wait accounting (busy label = jobs.stats().fg). scope 'task': the call
   * is aborted on a task switch (its result would be thrown away). wait false: the learner keeps
   * working meanwhile, so it is not learner-visible wait (Pace).
   */
  private fg<T>(label: string, run: (signal: AbortSignal) => Promise<T>, o: { scope?: 'task'; wait?: boolean } = {}): Promise<T> {
    const t = this.task;
    const start = this.now();
    return this.deps.jobs.fg(label, run, o.scope ? { scope: o.scope } : {}).finally(() => {
      if (t && o.wait !== false) t.waitMs = (t.waitMs ?? 0) + (this.now() - start);
      this.statusEmitter.fire();
    });
  }

  /** A card about task t: into its feed, and also into the visible feed when t is no longer on screen. */
  private pushFor(t: Task, card: Omit<Card, 'id' | 'at'>): void {
    this.push(card, t.feed);
    const cur = this.task;
    if (cur === t) return;
    const n = this.taskNumber(t);
    this.push({ ...card, title: `${n ? `Task ${n}` : t.title} · ${card.title}` }, cur ? cur.feed : (this.project?.feed ?? []));
  }

  // ------------------------------------------------------------ active time

  private rollDay(now: number): void {
    const d = new Date(now).toDateString();
    if (d === this.day) return;
    this.day = d;
    this.activeMsToday = 0;
    this.sprintMsToday = 0;
  }

  /** Active (not idle) ms since a wall-clock time, from the tick samples (SpecController.activeMsSince). */
  activeMsSince(wallMs: number): number {
    let before = 0;
    for (const [at, total] of this.activeSamples) {
      if (at > wallMs) break;
      before = total;
    }
    if (!this.activeSamples.length || wallMs < this.activeSamples[0][0]) return Math.max(0, this.now() - wallMs);
    return Math.max(0, this.activeTotal - before);
  }

  /**
   * Do the in-memory samples reach back to `wallMs`? They start empty after a reload and keep about
   * 5.5 hours: older times have no active-time measure (activeMsSince falls back to wall time).
   */
  activeCovers(wallMs: number): boolean {
    return this.activeSamples.length > 0 && wallMs >= this.activeSamples[0][0];
  }

  // ------------------------------------------------------------ project setup

  /**
   * Start (spec V1-7): the language is decided now (workspace, goal keywords or a QuickPick) and is fixed
   * input to every later prompt; the project shell is saved at once; PlanOutline runs in the background
   * while placement runs in the pad. Resolves when placement has ended (and task 1 began if the plan
   * already landed).
   */
  async startProject(goal: string, background = ''): Promise<void> {
    goal = goal.trim();
    background = background.trim();
    if (!goal) return;
    const exts = await this.deps.host.workspaceExtensions().catch(() => [] as [string, number][]);
    const d = decideLanguage(exts, goal, background);
    let language = d.lang;
    if (!language) language = (await this.deps.host.pickLanguage())?.trim().toLowerCase();
    if (!language) return;
    this.abortFlows('project');
    const old = this.deps.store.project;
    const now = this.now();
    const lang = runnableLang(language);
    const stocked = !!lang && !!this.deps.pad && !!this.deps.placement;
    const p: Project = {
      goal, background, title: titleFromGoal(goal), summary: '', language, lang,
      createdAt: Math.max(now, (old?.createdAt ?? 0) + 1),
      conceptIds: [], milestones: [], tasks: {}, feed: [],
      placement: { asked: [], startedAt: now, done: false, selfRated: false, planPending: true, calibrated: false },
      prefetch: {}, taskSwitch: 0,
    };
    this.deps.store.project = p;
    this.normalized.add(p);
    this.prefetcher.reset();
    this.push({
      kind: 'info',
      title: 'Designing your roadmap',
      html: md(stocked
        ? `Language: **${language}**. Designing your roadmap (~1-2 min) - placement is open in the editor: ~2 min of quick predict-the-output checks while I plan. No essays.`
        : !lang
          ? `Language: **${language}**. Designing your roadmap (~1-2 min). Placement checks, the practice tab, behaviour specs and what-ifs run for Python, JavaScript and TypeScript only: for ${language} you get the roadmap, hints, Teach me lessons and Check my work reviews.`
          : `Language: **${language}**. Designing your roadmap (~1-2 min).`),
    }, p.feed);
    this.changed();
    await this.deps.llm.ensureBackgroundConsent?.().catch(() => false);
    if (this.deps.store.project !== p) return;
    this.enqueuePlan(p);
    await this.runPlacement(p);
  }

  /** Retry button on the 'Roadmap failed' card. */
  retryPlan(): void {
    const p = this.project;
    if (!p || p.milestones.some((m) => m.taskIds.length)) return;
    // The plan job is still queued (a usage-limit retry after the pause) or running: a second
    // enqueue would dedupe onto it and apply the plan twice.
    if (this.deps.jobs.has('plan')) {
      const paused = this.deps.jobs.stats().pausedUntil !== undefined;
      this.deps.tempo.flash(paused ? 'The roadmap retries by itself when the usage-limit pause ends' : 'The roadmap is still being designed', STATE_FLASH_MS);
      return;
    }
    this.logCard('Roadmap', ['Trying the roadmap again...'], p.feed);
    this.enqueuePlan(p);
    this.changed();
  }

  private enqueuePlan(p: Project): void {
    p.placement.planPending = true;
    p.placement.planError = undefined;
    const job = this.prefetcher.planOutline(
      { goal: p.goal, background: p.background ?? '', lang: p.language, runtime: this.runtimeText(p) },
      (outline) => this.onPlan(p, outline),
      (reason) => this.planFailed(p, reason),
    );
    this.planJob = job;
    void this.track(job.then((r) => {
      if (!r.ok && !r.stale && this.deps.store.project === p && p.placement.planPending) this.planFailed(p, r.reason);
    }));
  }

  private planFailed(p: Project, reason: string): void {
    if (this.deps.store.project !== p) return;
    if (p.placement.planError === reason) return;
    p.placement.planError = reason;
    this.push({
      kind: 'error', title: `Roadmap failed: ${reason}`,
      html: md('Your placement results are kept. Retry when you are ready.'),
      actions: [{ label: 'Retry', command: 'retryPlan', primary: true }],
    }, p.feed);
    this.changed();
  }

  /** The plan landed (gen matched): merge concepts by tag, build milestone 1, prefetch tasks 1-3. */
  private onPlan(p: Project, o: PlanOutline): void {
    // Applied once: a second apply (a Retry that deduped onto the queued retry of the same job)
    // would replace the milestones and orphan the task the first one started.
    if (this.deps.store.project !== p || !p.placement.planPending || p.milestones.some((m) => m.taskIds.length)) return;
    if (!o.milestone1Tasks?.length) {
      // Nothing to build: the learner would wait forever with no task and no error.
      this.planFailed(p, 'the roadmap came back without tasks');
      return;
    }
    const learner = this.learner;
    const now = this.now();
    const lang = p.lang;
    const stock = lang ? this.deps.stocks(lang) : undefined;
    // Seed concepts own their tags, so plan ids become aliases and placement evidence is never orphaned.
    if (lang) {
      const candidates = unique(o.concepts.map((c) => planTag(c.tag)))
        .filter((t) => t !== OTHER_TAG && TAXONOMY[t]?.langs.includes(lang) && (stock?.hasSeeds(t) || PLACEMENT_FUNDAMENTALS[lang].includes(t)));
      // An older concept whose id is the tag (a v0.1 profile, an untagged task concept) owns it too.
      for (const t of candidates) {
        const old = learner.concepts[t];
        if (old && !old.tag) {
          old.tag = t;
          touch(old, now);
        }
      }
      const seedTags = candidates.filter((t) => !learner.concepts[t]);
      if (seedTags.length) {
        upsertConcepts(learner, seedTags.map((t) => ({
          id: t, name: TAXONOMY[t].patternName, tag: t, kind: TAXONOMY[t].kind, prerequisites: TAXONOMY[t].prereqs.filter((x) => TAXONOMY[x]?.langs.includes(lang)),
        })), now);
      }
    }
    upsertConcepts(learner, o.concepts.map((c) => {
      const tag = planTag(c.tag);
      return { id: c.id, name: c.name, description: c.description, prerequisites: c.prerequisites, tag, kind: tagInfo(tag)?.kind };
    }), now);
    p.conceptIds = unique(o.concepts.map((c) => concept(learner, c.id)?.id ?? slug(c.id)));
    p.summary = o.summary?.trim() || p.summary;
    p.milestones = (o.milestones ?? []).map((m) => ({ title: m.title, goal: m.goal, taskIds: [] }));
    if (!p.milestones.length) p.milestones.push({ title: 'Milestone 1', taskIds: [] });
    const added = this.addTasks(p, 0, o.milestone1Tasks ?? []);
    p.placement.planPending = false;
    p.placement.planError = undefined;
    this.placementRun?.addCandidates(p.conceptIds);
    this.logCard('Roadmap ready', [`${p.milestones.length} milestones · ${added.length} tasks in milestone 1 · ${p.conceptIds.length} concepts`], p.feed);
    // Prefetch: TaskPrep for tasks 1-3 (needed by the predicted end of placement), packs for their non-seed concepts.
    const first = this.upcoming(p, 3);
    const neededBy = p.placement.done ? now + 30_000 : Math.max(now + 30_000, p.placement.startedAt + COACH.placementExpectedMs);
    this.prepTasks(first, neededBy);
    if (lang) this.prefetcher.prepareConcepts(lang, first.flatMap((t) => t.conceptIds), { priority: 1 });
    this.deps.tempo.remove('sprint:wait');
    if (p.placement.done && !this.task) void this.track(this.beginNext());
    this.changed();
  }

  /** Build tasks for milestone k from plan/batch output; the last task of the milestone is solo. */
  private addTasks(p: Project, k: number, outs: readonly TaskOut[]): Task[] {
    const m = p.milestones[k];
    if (!m) return [];
    const learner = this.learner;
    const tasks = outs.map((o) => this.newTask(o, 'roadmap'));
    for (const t of tasks) {
      // Unknown ids still get a concept, so evidence on them is never dropped.
      const missing = t.conceptIds.filter((id) => !concept(learner, id));
      if (missing.length) upsertConcepts(learner, missing.map((id) => ({ id, name: id.replace(/-/g, ' ') })), this.now());
      t.conceptIds = unique(t.conceptIds.map((id) => concept(learner, id)?.id ?? slug(id)));
      p.tasks[t.id] = t;
      m.taskIds.push(t.id);
    }
    const last = tasks[tasks.length - 1];
    if (last && tasks.length > 1) {
      last.solo = true;
      last.fade = 'solo';
    }
    for (const id of unique(tasks.flatMap((t) => t.conceptIds))) if (!p.conceptIds.includes(id)) p.conceptIds.push(id);
    return tasks;
  }

  private newTask(o: TaskOut & { why?: string }, kind: Task['kind'], parentId?: string, depth = 0): FullTask {
    const iface: TaskInterface = {
      file: String(o.interface?.file ?? '').trim().replace(/^\.[\\/]/, '').replace(/\\/g, '/'),
      functions: (o.interface?.functions ?? []).slice(0, 3).map((f) => ({ name: f.name.trim(), signature: f.signature.trim(), purpose: f.purpose.trim() })),
    };
    return normTask({
      id: uid('task'),
      title: o.title,
      description: o.why ? `${o.description}\n\n_Why: ${o.why}_` : o.description,
      acceptanceCriteria: o.acceptanceCriteria ?? [],
      conceptIds: (o.conceptIds ?? []).map(slug).filter(Boolean),
      estimatedMinutes: Math.max(3, Math.round(o.estimatedMinutes || 10)),
      kind, parentId, followUpDepth: depth, status: 'todo', phase: 'building', activeMs: 0, stuckMs: 0, explainAttempts: 0,
      hints: [], revealed: false, offeredRung: 0, feed: [], interface: iface, fade: 'full', solo: false,
    });
  }

  /** Todo tasks in roadmap order (optionally only those after `after`). */
  private upcoming(p: Project, n: number, after?: Task): Task[] {
    const order = roadmapOrder(p);
    const from = after ? order.indexOf(after) + 1 : 0;
    return order.slice(Math.max(0, from)).filter((t) => t.status === 'todo').slice(0, n);
  }

  /** Concepts needed by tasks 1-3 (placement's stop rule). */
  private neededConcepts(p: Project): string[] {
    return unique(this.upcoming(p, 3).flatMap((t) => t.conceptIds));
  }

  // ------------------------------------------------------------ placement

  private async runPlacement(p: Project): Promise<void> {
    const lang = p.lang;
    const pad = this.deps.pad;
    const pr = lang && pad ? this.deps.placement?.(lang) : undefined;
    if (!pr || !pad) {
      p.placement.done = true;
      p.placement.finishedAt = this.now();
      await this.afterPlacement(p);
      return;
    }
    const release = pad.acquire('placement');
    if (!release) {
      this.deps.tempo.enqueue({ id: 'placement', kind: 'placement', label: statusText('beaker', 'placement check (~2 min)'), priority: 0, blocking: true, command: 'deliberate.placement' });
      return;
    }
    this.deps.tempo.remove('placement');
    this.placementRun = pr;
    if (p.conceptIds.length) pr.addCandidates(p.conceptIds);
    this.changed();
    let r: PlacementRunResult | undefined;
    try {
      r = await pr.run({
        needed: () => this.neededConcepts(p),
        planPending: () => p.placement.planPending && !p.placement.planError,
        calibrated: p.placement.calibrated,
        tickPicker: !p.placement.selfRated,
      });
    } catch (err) {
      this.log(`[coach] placement failed: ${errorMessage(err)}`);
    } finally {
      release();
      if (this.placementRun === pr) this.placementRun = undefined;
    }
    if (this.deps.store.project !== p) return;
    if (r) {
      p.placement.selfRated ||= r.selfRated;
      p.placement.calibrated ||= r.calibrated;
      p.placement.asked = unique([...p.placement.asked, ...r.state.items.map((i) => i.conceptId)]);
      p.placement.dontKnow = unique([...(p.placement.dontKnow ?? []), ...r.state.items.filter((i) => i.correct === null).map((i) => concept(this.learner, i.conceptId)?.id ?? i.conceptId)]);
      if (r.reason !== 'aborted') p.placement.summary = r.summary.text;
    }
    p.placement.done = true;
    p.placement.finishedAt = this.now();
    if (r?.reason === 'aborted') {
      this.changed();
      return;
    }
    await this.afterPlacement(p);
  }

  /** deliberate.placement: placement that could not open because another flow held the lock. */
  async placement(): Promise<void> {
    const p = this.project;
    if (!p || p.placement.done || this.placementRun) return;
    await this.track(this.runPlacement(p));
  }

  private async afterPlacement(p: Project): Promise<void> {
    if (this.deps.store.project !== p) return;
    if (p.milestones.some((m) => m.taskIds.length)) {
      if (!this.task) await this.beginNext();
      return;
    }
    if (!p.placement.planError) {
      const practice = this.sprintFor() ? ' Practice while you wait from the status bar if you like.' : '';
      this.push({ kind: 'info', title: 'Your roadmap is almost ready', html: md(`It starts the moment it lands.${practice}`) }, p.feed);
      this.waitJob = this.planJob;
      this.offerWaitSprint();
    }
    this.changed();
  }

  // ------------------------------------------------------------ reconcile (activation)

  /**
   * After a window reload (spec V1-1 EDGE CASES, V1-7 RECONCILE): re-enqueue what is missing (keys
   * make it idempotent): the plan, TaskPrep for the current and next task, the next TaskBatch, stock
   * refills; reattach the current task's specs.
   */
  async reconcile(): Promise<void> {
    const p = this.project;
    if (!p) return;
    const hasTasks = p.milestones.some((m) => m.taskIds.length);
    if (p.placement.planPending && !hasTasks) {
      if (!p.placement.done) {
        // A reload interrupted placement: keep what was recorded, do not restart it.
        p.placement.done = true;
        p.placement.finishedAt ??= this.now();
      }
      this.enqueuePlan(p);
    } else if (!p.placement.done) {
      p.placement.done = true;
      p.placement.finishedAt ??= this.now();
    }
    // Interrupted preps never landed.
    for (const t of Object.values(p.tasks)) if (t.prep?.state === 'pending' && !this.prefetcher.prepInFlight(t.id)) t.prep = undefined;
    this.ensureNextBatch(p);
    const cur = this.task;
    const next = this.upcoming(p, 1, cur)[0];
    this.prepTasks([cur, next].filter((t): t is FullTask => !!t && t.status !== 'done'));
    if (cur && cur.status === 'active') {
      if (cur.phase === 'learning') cur.phase = cur.resumePhase && cur.resumePhase !== 'learning' ? cur.resumePhase : 'building';
      if (cur.phase === 'gate') {
        this.push({ kind: 'info', title: 'Plan it in your head', html: md(CACHE_MISS_CARD) }, cur.feed);
        cur.phase = 'building';
      }
      this.monitor.setTaskFiles?.(this.taskFileUris(cur));
      if (cur.phase === 'building') await this.attachSpecs(cur, false);
      // The reload came between criteria met and completion (what-ifs open, or a lock wait).
      if (cur.phase === 'building' && cur.criteriaMetAt) void this.track(this.criteriaMet(cur, 'resume'));
    } else if (p.placement.done) {
      // A roadmap but no active task: a reload during completeTask's follow-up wait, during
      // placement after the plan landed, or a v0.1 project saved mid-diagnostic.
      if (cur?.status === 'done' && cur.completedAt !== undefined && this.now() - cur.completedAt < 10 * MIN) this.maybeFollowUp(cur);
      if (this.nextRoadmapTask()) void this.track(this.beginNext());
    }
    if (p.lang) this.prefetcher.refillLowStock(p.lang);
    void this.refreshPace();
    this.changed();
  }

  /** The next TaskBatch when the current milestone is the last one with tasks. */
  private ensureNextBatch(p: Project): void {
    const withTasks = p.milestones.map((m, i) => (m.taskIds.length ? i : -1)).filter((i) => i >= 0);
    const last = withTasks[withTasks.length - 1];
    if (last === undefined || last + 1 >= p.milestones.length || p.milestones[last + 1].taskIds.length) return;
    const cur = this.task;
    const curMilestone = cur ? p.milestones.findIndex((m) => m.taskIds.includes(cur.id)) : last;
    if (curMilestone === last || !cur || cur.status === 'done') this.enqueueBatch(p, last + 1);
  }

  private enqueueBatch(p: Project, k: number): void {
    const m = p.milestones[k];
    if (!m || m.taskIds.length) return;
    const prev = p.milestones[k - 1];
    const remainingMin = (prev?.taskIds ?? []).map((id) => p.tasks[id]).filter((t) => t && t.status !== 'done').reduce((n, t) => n + t.estimatedMinutes, 0);
    const job = this.prefetcher.taskBatch(
      k,
      { lang: p.language, runtime: this.runtimeText(p), fade: taskFade(this.learner), neededBy: this.now() + Math.max(5, remainingMin) * MIN },
      (tasks) => this.onBatch(p, k, tasks),
    );
    void this.track(job.then((tasks) => this.afterBatch(p, k, tasks)));
  }

  /**
   * The batch settled. Failed, dropped or empty while the learner waits at the milestone end: an
   * error card with Retry (nothing else would ever react). Not waiting: completeTask enqueues it
   * again when the milestone ends.
   */
  private afterBatch(p: Project, k: number, tasks: readonly TaskOut[] | undefined): void {
    if (this.deps.store.project !== p || !p.milestones[k] || p.milestones[k].taskIds.length) return;
    if (this.deps.jobs.has(`batch:${k}`)) return; // still queued (a usage-limit retry) or enqueued again
    const cur = this.task;
    if (cur && cur.status !== 'done') return;
    this.push({
      kind: 'error', title: `Milestone ${k + 1} failed: ${tasks ? 'the model wrote no tasks' : 'the call failed or was dropped'}`,
      html: md('Your progress is kept. Retry when you are ready.'),
      actions: [{ label: 'Retry', command: 'retryBatch', primary: true }],
    }, this.feedOf());
    this.changed();
  }

  /** Retry button on the 'Milestone failed' card. */
  retryBatch(): void {
    const p = this.project;
    if (!p) return;
    const k = p.milestones.findIndex((m) => !m.taskIds.length);
    if (k < 0 || this.deps.jobs.has(`batch:${k}`)) return;
    this.logCard(`Milestone ${k + 1}`, ['Trying again...'], this.feedOf());
    this.enqueueBatch(p, k);
    this.changed();
  }

  private onBatch(p: Project, k: number, tasks: readonly TaskOut[]): void {
    if (this.deps.store.project !== p || !p.milestones[k] || p.milestones[k].taskIds.length) return;
    if (!tasks.length) return; // an empty batch is a failure (afterBatch reports it)
    const added = this.addTasks(p, k, tasks);
    this.logCard(`Milestone ${k + 1} ready`, [`${p.milestones[k].title}: ${added.length} tasks`], this.feedOf());
    const cur = this.task;
    if (!cur || cur.status === 'done') {
      // The learner is waiting at the milestone end: prepare and start at once.
      this.prepTasks(this.upcoming(p, 3));
      this.deps.tempo.remove('sprint:wait');
      void this.track(this.beginNext());
    }
    this.changed();
  }

  // ------------------------------------------------------------ prefetch triggers

  /** TaskPrep for tasks with neither a gate nor a ladder (specsOnly: tasks still missing a ladder, gate or not). */
  private prepTasks(tasks: readonly Task[], neededBy?: number, o: { specsOnly?: boolean } = {}): void {
    const p = this.project;
    if (!p) return;
    const want = tasks.filter((t) => t.status !== 'done' && (o.specsOnly || !t.gate) && !t.spec && t.prep?.state !== 'done' && t.prep?.state !== 'pending' && t.interface?.file);
    if (!want.length) return;
    const job = this.prefetcher.taskPrep(want, { lang: p.language, runtime: this.runtimeText(p), runLang: p.lang, neededBy }, (prepared) => this.onPrep(p, prepared));
    void this.track(job);
  }

  /**
   * TaskPrep landed. A part attaches to a task that has not started yet, or to the current task (a
   * late prep: its specs attach now). A task the learner already left is ignored (the race rule):
   * reconcile prepares it again when they come back.
   */
  private onPrep(p: Project, prepared: readonly PreparedTask[]): void {
    if (this.deps.store.project !== p) return;
    for (const r of prepared) {
      const t = p.tasks[r.taskId];
      if (!t) continue;
      const current = p.currentTaskId === t.id && t.status === 'active';
      if (t.status !== 'todo' && !current) {
        t.prep = { state: 'failed', at: this.now(), reason: 'landed after a task switch' };
        this.log(`[coach] TaskPrep for '${t.title}' landed after a task switch: ignored`);
        continue;
      }
      if (r.gate && !t.gate) t.gate = r.gate;
      if (r.spec && !t.spec) t.spec = r.spec;
      if (current && t.spec?.applicable && (t.phase === 'building' || t.phase === 'learning')) void this.track(this.attachSpecs(normTask(t), true));
    }
    this.changed();
  }

  /**
   * Running code became possible (consent, trust or a runtime): tasks prepared before that have a
   * gate but no verified ladder; prepare their ladders now, current task first, 3 per call.
   */
  private reprepLadders(): void {
    const p = this.project;
    if (!p?.lang) return;
    const cur = this.task;
    const order = roadmapOrder(p);
    const tasks = [...(cur ? [cur] : []), ...order.filter((t) => t !== cur)]
      .filter((t) => t.status !== 'done' && !t.spec && t.prep?.state === 'done' && t.prep.reason === NO_RUNNER_REASON);
    for (const t of tasks) t.prep = undefined;
    for (let i = 0; i < tasks.length; i += 3) this.prepTasks(tasks.slice(i, i + 3), this.now() + 30_000 + i * MIN, { specsOnly: true });
  }

  /** Task N enters building: packs for N+1, the next trio's TaskPrep, refills. */
  private prefetchOnBuilding(t: Task): void {
    const p = this.project;
    if (!p) return;
    const next = this.upcoming(p, 6, t);
    if (p.lang && next[0]) this.prefetcher.prepareConcepts(p.lang, next[0].conceptIds, { priority: 1 });
    // The trio rule: when at most one prepared task is left before an unprepared one, prepare the next trio.
    const firstUnprepared = next.findIndex((x) => !x.gate && !x.spec && x.prep?.state !== 'pending' && x.prep?.state !== 'done');
    if (firstUnprepared >= 0 && firstUnprepared <= 1) {
      const ahead = next.slice(0, firstUnprepared).reduce((n, x) => n + x.estimatedMinutes, t.estimatedMinutes);
      this.prepTasks(next.slice(firstUnprepared, firstUnprepared + 3), this.now() + ahead * MIN);
      if (p.lang) this.prefetcher.prepareConcepts(p.lang, next.slice(firstUnprepared, firstUnprepared + 3).flatMap((x) => x.conceptIds), { priority: 1 });
    }
    if (p.lang) this.prefetcher.refillLowStock(p.lang);
  }

  /** A needed-next job missed its deadline: log it (the degraded paths are applied where the result is used). */
  private onLate(key: string): void {
    const t = this.task;
    if (key.startsWith('prep:') && t && key.includes(t.id) && t.phase === 'building') this.deps.tempo.flash('Specs for this task are still being prepared', STATE_FLASH_MS);
    this.statusEmitter.fire();
  }

  // ------------------------------------------------------------ task lifecycle

  nextRoadmapTask(): Task | undefined {
    const p = this.project;
    return p ? roadmapOrder(p).find((t) => t.status === 'todo') : undefined;
  }

  private async beginNext(): Promise<void> {
    const next = this.nextRoadmapTask();
    if (next) await this.beginTask(next);
  }

  /** Start (or return to) a task. */
  async startTask(id: string): Promise<void> {
    const t = this.project?.tasks[id];
    if (!t) return;
    await this.track(this.beginTask(t));
  }

  /**
   * A task switch: the active modal flow is aborted (recorded as Esc, no penalty), task-scoped jobs
   * are cancelled, taskSwitch bumps; per-task surfaces are cleared.
   */
  private abortFlows(scope: 'task' | 'project'): void {
    this.deps.lock.abortActive();
    this.deps.jobs.cancelWhere((s) => s.scope === 'task' || (scope === 'project' && s.scope === 'project'));
    // A foreground call for the old task (Check my work, a hint, Reveal) would keep the one-at-a-
    // time lane busy for minutes and its result is thrown away.
    this.deps.jobs.cancelTaskFg();
    const p = this.deps.store.project;
    if (p) p.taskSwitch = (p.taskSwitch ?? 0) + 1;
    const prev = p?.currentTaskId;
    if (prev) this.prefetcher.hints.reset(prev);
    this.deps.specs?.detach();
    this.deps.predict?.clearOffer();
    this.deps.hints?.clear('task-changed');
    for (const id of ['hint-ready', 'sprint:wait', 'placement']) this.deps.tempo.remove(id);
    this.hintFlight = undefined;
    this.signals = undefined;
    this.episodeHinted = false;
    if (scope === 'project') {
      this.placementRun = undefined;
      this.planJob = undefined;
      this.waitJob = undefined;
      this.followUps.clear();
    }
  }

  private async beginTask(raw: Task): Promise<void> {
    const p = this.project;
    if (!p) return;
    const t = normTask(raw);
    const prev = this.task;
    if (prev && prev !== t) this.prevNotUnderstood = !!prev.notUnderstood;
    this.abortFlows('task');
    p.currentTaskId = t.id;
    this.monitor.startTask();
    this.monitor.setTaskFiles?.(this.taskFileUris(t));
    this.modelProbeTrigger.reset();
    if (t.status !== 'todo') {
      // Returning to a task: keep its state.
      if (t.status === 'active' && t.phase !== 'done') {
        if (t.phase === 'learning' || t.phase === 'gate') t.phase = 'building';
        // A TaskPrep that landed while the learner was away was dropped: prepare it again.
        if (!t.gate && !t.spec && !this.prefetcher.prepInFlight(t.id)) this.prepTasks([t], this.now() + 30_000);
        await this.attachSpecs(t, false);
        // Left between criteria met and completion (what-ifs open): finish it now.
        if (this.task === t && t.phase === 'building' && t.criteriaMetAt) void this.track(this.criteriaMet(t, 'resume'));
      }
      this.changed();
      return;
    }
    const now = this.now();
    t.status = 'active';
    t.startedAt = now;
    t.fade = t.solo ? 'solo' : taskFade(this.learner);
    const order = roadmapOrder(p);
    if (order.indexOf(t) === 0 && p.placement.summary) this.logCard('Placement', [p.placement.summary], t.feed);
    this.pushTaskCard(t);
    // Milestone k starts: TaskBatch for milestone k+1.
    const k = p.milestones.findIndex((m) => m.taskIds[0] === t.id);
    if (k >= 0 && p.milestones[k + 1] && !p.milestones[k + 1].taskIds.length) this.enqueueBatch(p, k + 1);
    this.changed();

    // No prep and none coming (a follow-up, a failed or interrupted prep): a late TaskPrep; specs attach when it lands.
    if (!t.gate && !t.spec && !this.prefetcher.prepInFlight(t.id)) this.prepTasks([t], now + 30_000);
    const decision = gateDecision({ conceptIds: t.conceptIds, solo: t.solo, fade: t.fade }, order.slice(0, order.indexOf(t)), this.learner);
    if (decision.run && this.deps.gate) {
      if (t.gate) {
        await this.runGate(t);
        return;
      }
      // TaskPrep late (or failed): never block; specs attach when they land.
      this.push({ kind: 'info', title: 'Plan it in your head', html: md(CACHE_MISS_CARD) }, t.feed);
    }
    if (!t.solo) await this.repairGaps(t, routeGaps({ learner: this.learner, taskConceptIds: t.conceptIds, now }));
    await this.goBuilding(t);
  }

  /** The 2-4 line task card: what to build, the interface, the spec titles the fade allows. */
  private pushTaskCard(t: FullTask): void {
    const p = this.project!;
    const iface = interfaceLine(t.interface, p.language);
    const titles = t.spec && t.fade === 'full' ? t.spec.specs.map((s) => `- [ ] ${s.title}`) : t.spec && t.fade === 'partial' ? [`- [ ] ${t.spec.specs[0]?.title ?? ''}`] : [];
    const crit = !t.spec?.applicable && t.acceptanceCriteria.length ? t.acceptanceCriteria.map((c) => `- [ ] ${c}`) : [];
    const kindLabel = t.kind === 'followup' ? 'Follow-up' : t.solo ? 'Solo task' : 'Task';
    this.push({
      kind: 'task',
      title: `${kindLabel} ${this.taskNumber(t) ?? ''}: ${t.title}`.replace(/\s+:/, ':'),
      html: md([t.description, iface ? `**${iface}**` : '', titles.join('\n') || crit.join('\n'), `_Target: ~${t.estimatedMinutes} min${t.solo ? ' · no hints past rung 2' : ''}_`].filter(Boolean).join('\n\n')),
    }, t.feed);
  }

  private taskNumber(t: Task): number | undefined {
    const p = this.project;
    if (!p) return undefined;
    const i = roadmapOrder(p).indexOf(t);
    return i >= 0 ? i + 1 : undefined;
  }

  /** Phase 'building': the stuck clock restarts, specs attach, the editor gets focus. */
  private async goBuilding(t: FullTask, flash = 'Go build'): Promise<void> {
    if (this.task !== t || t.status !== 'active') return;
    t.phase = 'building';
    t.resumePhase = undefined;
    this.monitor.startTask();
    this.monitor.setTaskFiles?.(this.taskFileUris(t));
    this.deps.tempo.flash(flash, STATE_FLASH_MS);
    this.deps.host.focusEditor();
    await this.attachSpecs(t, false);
    this.prefetchOnBuilding(t);
    this.changed();
  }

  /** Interface names of earlier tasks in the same file (never mapped by arity onto this task's functions). */
  private reservedNames(t: Task): string[] {
    const p = this.project;
    if (!p || !t.interface?.file) return [];
    const out: string[] = [];
    for (const o of roadmapOrder(p)) {
      if (o === t) break;
      if (o.interface?.file !== t.interface.file) continue;
      for (const f of o.interface.functions) out.push(f.name);
      out.push(...Object.values(o.interface.mappedNames ?? {}));
    }
    return unique(out);
  }

  private async attachSpecs(t: FullTask, announce: boolean): Promise<void> {
    const specs = this.deps.specs;
    const p = this.project;
    if (!specs || !p?.lang || this.task !== t || !t.spec) return;
    try {
      const res = await specs.attach(t as FullTask & SpecTask, p.lang, this.runner(p.lang), {
        allowRun: this.allowRun(), deferredConcepts: t.gateDeferred ?? [], announce, reservedNames: this.reservedNames(t),
      });
      if (this.task !== t) return;
      if (!res.applicable && res.reason === DESIGN_DIFFERS) this.push({ kind: 'info', title: 'Your own design', html: md(DESIGN_DIFFERS) }, t.feed);
      if (announce && res.applicable) this.logCard(`Specs ready (${t.spec.specs.length})`, ['They run on your next save.'], t.feed);
    } catch (err) {
      this.log(`[coach] attaching specs failed: ${errorMessage(err)}`);
    }
    this.changed();
  }

  // ------------------------------------------------------------ the gate

  private async runGate(t: FullTask): Promise<void> {
    const gate = this.deps.gate;
    const p = this.project;
    if (!gate || !p) return this.goBuilding(t);
    t.phase = 'gate';
    this.changed();
    let res: GateResult;
    try {
      res = await gate.run({ id: t.id, title: t.title, number: this.taskNumber(t) }, t.gate, { fade: t.fade, priorFlawedTasks: p.flawedTasks ?? 0 });
    } catch (err) {
      this.log(`[coach] gate failed: ${errorMessage(err)}`);
      return this.goBuilding(t);
    }
    if (this.task !== t || t.phase !== 'gate') return;
    await this.gateDone(t, res);
  }

  /** deliberate.gate: the gate action queued while another modal flow held the lock. */
  async openGate(): Promise<void> {
    const t = this.task;
    if (!t || t.phase !== 'gate') return;
    this.deps.tempo.remove(`gate:${t.id}`);
    await this.track(this.runGate(t));
  }

  /** Route the gate result: evidence, flash, log card, gap atoms (2 / 120 s), JIT offers, then building. */
  private async gateDone(t: FullTask, res: GateResult): Promise<void> {
    const p = this.project!;
    const learner = this.learner;
    switch (res.kind) {
      case 'busy':
        this.deps.tempo.enqueue({ id: `gate:${t.id}`, kind: 'gate', label: statusText('checklist', 'plan check for this task'), priority: 0, blocking: true, command: 'deliberate.gate' });
        return;
      case 'not-needed':
        return this.goBuilding(t);
      case 'no-pack':
      case 'skipped':
        if (res.kind === 'no-pack') this.push({ kind: 'info', title: 'Plan it in your head', html: md(res.card ?? CACHE_MISS_CARD) }, t.feed);
        await this.repairGaps(t, routeGaps({ learner, taskConceptIds: t.conceptIds, now: this.now() }));
        return this.goBuilding(t);
      case 'own-plan':
        // 'I'd do it differently': step A's answers (if given) stand; the free-text plan is reviewed in the background.
        for (const e of res.evidence) recordEvidence(learner, e);
        if (t.gate && res.record) t.gate.result = res.record;
        t.phase = 'explain';
        this.changed();
        this.deps.host.focusComposer?.('explain');
        return;
      case 'done':
        break;
    }
    for (const e of res.evidence) recordEvidence(learner, e);
    if (t.gate && res.record) t.gate.result = res.record;
    if (res.flawedTasks !== undefined) p.flawedTasks = res.flawedTasks;
    if (res.flash) this.deps.tempo.flash(res.flash, 3000);
    const lines = res.notes.map((n) => `**${n.name}**${n.kind === 'lure' ? ' (not here)' : ''}: ${n.text}`);
    if (res.pattern) lines.unshift(`${res.pattern.requiredHit}/${res.pattern.requiredTotal} patterns${res.plan ? ` · plan ${res.plan.workable ? 'workable' : 'flawed'}` : ''}`);
    if (lines.length) this.logCard('Gate', lines, t.feed);
    if (res.guideApproach) this.guideApproach(t);
    const routing = t.gate ? gateRouting(res, t.gate, learner, t.conceptIds, this.now()) : routeGaps({ learner, taskConceptIds: t.conceptIds, now: this.now() });
    await this.repairGaps(t, routing);
    await this.goBuilding(t, res.goBuild);
  }

  /** Gap atoms before building (at most 2 / 120 s); the rest, and late packs, become JIT offers. */
  private async repairGaps(t: FullTask, routing: GateRouting): Promise<void> {
    const deferred = new Set(routing.jit.map((g) => g.conceptId));
    for (const g of routing.atoms) {
      if (this.task !== t) return;
      const r = await this.openAtom(g.conceptId, 'gap', t);
      if (r !== 'ran') deferred.add(g.conceptId);
    }
    if (deferred.size) {
      t.gateDeferred = unique([...(t.gateDeferred ?? []), ...deferred]);
      if (this.deps.specs?.taskId === t.id) this.deps.specs.addDeferredConcepts([...deferred]);
    }
  }

  /** 2 flawed plan picks in one task: a background-generated 'how to think about it' card. */
  private guideApproach(t: FullTask): void {
    const p = this.project!;
    const job = this.deps.jobs.bg({
      key: `guide:${t.id}`, priority: 1, effort: 'low', label: 'Writing a planning guide', scope: 'task', gen: this.gen(),
      run: (signal) => this.deps.llm.json({
        system: SYSTEM, prompt: guideApproachPrompt({ projectBrief: projectBrief(p), taskBrief: taskBrief(t, p.language), learnerProfile: this.learnerFor(t.conceptIds) }),
        schema: AnswerSchema, effort: 'low',
      }, { signal, fast: false, background: true }),
    }, (r) => {
      this.push({ kind: 'lesson', title: 'How to think about this task', html: md(r.answer) }, t.feed);
      this.changed();
    });
    void this.track(job);
  }

  // ------------------------------------------------------------ atoms

  /** The cached atom for a concept (seed key by tag, model pack by concept id or tag). */
  private cachedAtom(lang: Lang, conceptId: string): StoredAtom | undefined {
    const cache = this.deps.caches(lang);
    if (!cache) return undefined;
    const learner = this.learner;
    const key = this.deps.stocks(lang)?.cacheKeyFor(learner, conceptId);
    if (key && cache.has(key)) return cache.get(key);
    const c = concept(learner, conceptId);
    if (!c) return undefined;
    for (const k of unique([c.id, ...c.aliases, packKey(learner, c)])) if (cache.has(k)) return cache.get(k);
    return undefined;
  }

  /** Atom history from the evidence log: confirmed beliefs, groups right in the last 7 days. */
  private async atomHistory(conceptId: string): Promise<{ confirmed: string[]; groups: string[] }> {
    const now = this.now();
    let ev: EvidenceRecord[] = [];
    try {
      ev = (await this.deps.store.readEvidence?.(now - 90 * DAY, now)) ?? [];
    } catch {
      ev = [];
    }
    const mine = ev.filter((e) => e.conceptId === conceptId);
    return {
      confirmed: unique(mine.filter((e) => e.beliefConfirmed && e.misconceptionId).map((e) => e.misconceptionId!)),
      groups: unique(mine.filter((e) => e.correct === true && !e.guessFlag && !e.implicitGuess && e.siblingGroup && e.at >= now - 7 * DAY).map((e) => e.siblingGroup!)),
    };
  }

  /**
   * Open one atom (mechanism 6). Context 'gap' never waits: no cached atom means a JIT offer (and a
   * pack is queued). Teach / JIT / offers wait for an in-flight pack or make the mini atom, filling
   * the wait with a sprint when not building; while building the pad is not opened: the tempo bar
   * offers the drill when it is ready.
   */
  private async openAtom(conceptId: string, context: 'gap' | 'teach' | 'jit' | 'offer', t?: FullTask): Promise<AtomOpen> {
    const p = this.project;
    const lang = p?.lang;
    const pad = this.deps.pad;
    const c = concept(this.learner, conceptId);
    if (!p || !lang || !pad || !c) return 'unavailable';
    let atom = this.cachedAtom(lang, c.id);
    if (!atom && c.tag && this.deps.stocks(lang)?.hasSeeds(c.tag)) {
      await this.deps.stocks(lang)?.refillIfLow(c.tag)?.catch(() => undefined);
      atom = this.cachedAtom(lang, c.id);
    }
    if (!atom) {
      if (context === 'gap') {
        this.prefetcher.prepareConcepts(lang, [c.id], { priority: 1 });
        return 'unavailable';
      }
      const switches = p.taskSwitch;
      const got = await this.atomForTeach(lang, c);
      if (got === 'deferred') return 'queued';
      if (this.deps.store.project !== p || p.taskSwitch !== switches) {
        // The learner moved on while the drill was being prepared: never open it over the new task
        // (or record it on the old one); offer it instead.
        await this.deps.pad?.closeIdle?.().catch(() => undefined);
        if (got && this.deps.store.project === p) {
          this.deps.tempo.enqueue({ id: `atom:${c.id}`, kind: 'atom', label: status.jitOffer(this.patternName(c)), priority: 2, blocking: false, command: 'deliberate.jitAtom', args: [c.id] });
        }
        return 'queued';
      }
      if (!got) {
        // The wait sprint may have left the pad open for the drill that never came.
        await this.deps.pad?.closeIdle?.().catch(() => undefined);
        this.push({ kind: 'info', title: `No practice for ${c.name} yet`, html: md('I could not build verified practice items for this concept. Ask the coach about it, or try again later.') });
        this.changed();
        return 'unavailable';
      }
      atom = got;
    }
    return this.runAtom(atom, c, t ?? this.task);
  }

  private async atomForTeach(lang: Lang, c: ConceptState): Promise<StoredAtom | undefined | 'deferred'> {
    const inflight = this.prefetcher.packInFlight(lang, c.id);
    const building = this.task?.phase === 'building';
    if (building) {
      // Building: the pad is not opened; the tempo bar shows the wait and offers the drill when ready.
      const id = `prep-atom:${c.id}`;
      this.deps.tempo.enqueue({ id, kind: 'atom', label: statusText('sync~spin', `preparing ${c.name} drill (~20 s)`), priority: 4, blocking: false, command: 'deliberate.jitAtom', args: [c.id] });
      // The learner keeps building meanwhile: not a learner-visible wait.
      const ready = inflight ?? this.fg(`Preparing a ${c.name} drill`, (signal) => this.prefetcher.miniAtom(lang, c.id, signal), { wait: false }).then(() => undefined);
      void this.track(ready.catch(() => undefined).then(() => {
        this.deps.tempo.remove(id);
        if (this.cachedAtom(lang, c.id)) {
          this.deps.tempo.enqueue({ id: `atom:${c.id}`, kind: 'atom', label: status.jitOffer(this.patternName(c)), priority: 2, blocking: false, command: 'deliberate.jitAtom', args: [c.id] });
        }
        this.changed();
      }));
      return 'deferred';
    }
    try {
      if (inflight) {
        // Waiting on a background pack is learner-visible wait too (fg() counts only its own calls).
        const t = this.task;
        const w0 = this.now();
        await this.fillWait(inflight, { learnerStarted: true, atomFollows: true });
        if (t) t.waitMs = (t.waitMs ?? 0) + (this.now() - w0);
      } else await this.fgWithSprint(`Preparing a ${c.name} drill`, (signal) => this.prefetcher.miniAtom(lang, c.id, signal), { learnerStarted: true, atomFollows: true });
    } catch (err) {
      this.errorCard(err);
    }
    return this.cachedAtom(lang, c.id);
  }

  private patternName(c: ConceptState): string {
    return (c.tag && TAXONOMY[c.tag]?.patternName) || c.name;
  }

  private async runAtom(atom: StoredAtom, c: ConceptState, t: FullTask | undefined): Promise<AtomOpen> {
    const pad = this.deps.pad!;
    const release = pad.acquire('atom');
    if (!release) {
      this.deps.tempo.enqueue({ id: `atom:${c.id}`, kind: 'atom', label: status.jitOffer(this.patternName(c)), priority: 0, blocking: true, command: 'deliberate.jitAtom', args: [c.id] });
      return 'busy';
    }
    this.deps.tempo.remove(`atom:${c.id}`);
    if (t && t.phase !== 'learning') {
      t.resumePhase = t.phase;
      t.phase = 'learning';
    }
    this.changed();
    const p = this.project;
    try {
      const hist = await this.atomHistory(c.id);
      const r = await pad.run(atom, {
        conceptId: c.id, taskId: t?.id, confirmedMisconceptions: hist.confirmed, recentCorrectGroups: hist.groups,
        placementDontKnow: !!p?.placement.dontKnow?.includes(c.id),
      });
      if (t) t.atomRuns.push(r);
      return 'ran';
    } catch (err) {
      this.log(`[coach] atom failed: ${errorMessage(err)}`);
      return 'unavailable';
    } finally {
      release();
      if (t && t.phase === 'learning') {
        t.phase = t.resumePhase && t.resumePhase !== 'learning' ? t.resumePhase : 'building';
        t.resumePhase = undefined;
      }
      this.changed();
    }
  }

  /** Teach me (sidebar button, deliberate.teach): the atom for a concept (default: the task's weakest). */
  async teach(conceptId?: string): Promise<void> {
    const p = this.project;
    const t = this.task;
    if (!p) return;
    const id = conceptId ?? (t ? (weakest(this.learner, t.conceptIds)?.id ?? t.conceptIds[0]) : undefined);
    if (!id) return;
    if (!p.lang || !this.deps.pad) {
      await this.track(this.shortLesson(id));
      return;
    }
    await this.track(this.openAtom(id, 'teach', t));
  }

  /** deliberate.jitAtom (tempo JIT / stuck / atom offers): [conceptId, specId?]. */
  async jitAtom(conceptId?: string): Promise<void> {
    const id = conceptId ?? (this.task ? weakest(this.learner, this.task.conceptIds)?.id : undefined);
    if (!id) return;
    await this.track(this.openAtom(id, 'jit', this.task));
  }

  /** 'I have no idea': the atom for the weakest task concept. */
  async noIdea(): Promise<void> {
    const t = this.task;
    if (!t) return;
    this.push({ kind: 'you', title: 'You', html: md("_I don't know how to approach this yet._") }, t.feed);
    t.explainAttempts++;
    await this.teach(weakest(this.learner, t.conceptIds)?.id ?? t.conceptIds[0]);
  }

  /** Languages without a pad: a short lesson card in the foreground. */
  private async shortLesson(conceptId: string): Promise<void> {
    const p = this.project!;
    const c = concept(this.learner, conceptId);
    try {
      const r = await this.fg('Writing a short lesson', (signal) => this.deps.llm.json({
        system: SYSTEM, prompt: shortLessonPrompt({ projectBrief: projectBrief(p), concept: c ? `${c.id} - ${c.name}: ${c.description}` : conceptId, learnerProfile: this.learnerFor([conceptId]) }),
        schema: AnswerSchema, effort: 'low',
      }, { signal }));
      this.push({ kind: 'lesson', title: c?.name ?? conceptId, html: md(r.answer) });
    } catch (err) {
      this.errorCard(err);
    }
    this.changed();
  }

  // ------------------------------------------------------------ pad hooks (AtomPad deps)

  /** AtomPad 'lesson' dep: project.prefetch at once, else the background escalation-lesson job. */
  escalationLesson(req: LessonRequest): LessonText | undefined | Promise<LessonText | undefined> {
    const p = this.project;
    return this.prefetcher.lesson(req, p?.lang, p ? projectBrief(p) : '');
  }

  /** AtomPad 'onLog' dep: one compact sidebar card per atom, placement and sprint. */
  pushLogCard(card: PadLogCard): void {
    const p = this.project;
    if (!p) return;
    if (card.kind === 'placement') p.placement.summary = card.lines.join(' ');
    const feed = this.task?.status === 'active' ? this.task.feed : p.feed;
    this.logCard(card.title, card.lines, feed);
    this.changed();
  }

  /** AtomPad 'onExit' dep. */
  onAtomExit(r: AtomResult): void {
    const p = this.project;
    if (p?.lang) this.prefetcher.refillLowStock(p.lang);
    this.log(`[coach] atom ${r.conceptId}: ${r.path} (${r.items} items, ${Math.round(r.ms / 1000)} s)`);
  }

  /** AtomPad 'markProgress' dep: only while a task is being built. */
  markProgressIfBuilding(now: number, why: string): void {
    const t = this.task;
    if (t && (t.phase === 'building' || (t.phase === 'learning' && (t.resumePhase ?? 'building') === 'building'))) this.monitor.detector.markProgress(now, why);
  }

  // ------------------------------------------------------------ sprints and waits

  private sprintFor(): SprintLike | undefined {
    const lang = this.project?.lang;
    return lang ? this.deps.sprint?.(lang) : undefined;
  }

  private async runSprint(s: SprintLike, opts: SprintOptions): Promise<SprintResult | undefined> {
    const kind: LockKind = opts.reason === 'warmup' ? 'warmup' : 'sprint';
    const release = this.deps.pad?.acquire(kind) ?? this.deps.lock.acquire(kind);
    if (!release) return undefined;
    try {
      const r = await s.run(opts);
      this.sprintMsToday += r.ms;
      return r;
    } catch (err) {
      this.log(`[coach] sprint failed: ${errorMessage(err)}`);
      return undefined;
    } finally {
      release();
      this.changed();
    }
  }

  /** deliberate.sprint (Ctrl+Alt+S): a local 3-minute interleaved sprint. */
  async sprint(budgetMs: number = COACH.sprintMs): Promise<void> {
    const s = this.sprintFor();
    if (!s) {
      this.deps.tempo.flash('No practice items for this language yet', STATE_FLASH_MS);
      return;
    }
    const r = await this.track(this.runSprint(s, { reason: 'sprint', budgetMs }));
    if (!r) this.deps.tempo.flash('Finish the open practice first', STATE_FLASH_MS);
  }

  /** deliberate.warmup: the 60 s warm-up the tempo bar offers at session start. */
  async warmup(): Promise<void> {
    const s = this.sprintFor();
    this.deps.tempo.remove('warmup');
    if (s) await this.track(this.runSprint(s, { reason: 'warmup', budgetMs: COACH.warmupMs }));
  }

  /** deliberate.practiceWhileWaiting: a sprint until the current wait (roadmap, review, drill) lands. */
  async practiceWhileWaiting(): Promise<void> {
    const s = this.sprintFor();
    this.deps.tempo.remove('sprint:wait');
    if (!s) return;
    const until = this.waitJob ?? (this.project?.placement.planPending ? this.planJob : undefined);
    await this.track(this.runSprint(s, until ? { reason: 'wait', until } : { reason: 'sprint', budgetMs: 90_000 }));
  }

  private offerWaitSprint(): void {
    const s = this.sprintFor();
    if (!s || s.available(2) < 2 || sprintCapReached(this)) return;
    this.deps.tempo.enqueue({ id: 'sprint:wait', kind: 'sprint', label: statusText('zap', 'practice while you wait'), priority: 2, blocking: false, command: 'deliberate.practiceWhileWaiting' });
  }

  /**
   * On activation (after stock is ready): when a project exists and 2+ items are due, offer the 60 s
   * warm-up in the tempo bar. Never opened automatically.
   */
  offerWarmup(): void {
    const p = this.project;
    const s = this.sprintFor();
    if (!p || !s) return;
    const now = this.now();
    const learner = this.learner;
    const due = Object.values(learner.concepts).filter((c) =>
      (c.nextReview > 0 && c.nextReview <= now) || Object.values(c.misconceptions ?? {}).some((m) => m.nextCheckAt !== undefined && m.nextCheckAt <= now),
    ).length + auditDue(learner.concepts, now).length;
    if (due < COACH.warmupDue || s.available(2) < 2) return;
    this.deps.tempo.enqueue({ id: 'warmup', kind: 'warmup', label: status.warmup(due, 60), priority: 3, blocking: false, command: 'deliberate.warmup' });
  }

  /**
   * Fill a wait over 3 s (spec V1-9 b): the sprint opens by itself only when the learner started the
   * wait, the window is focused, the phase is not building, the lock is free and there was no edit in
   * 8 s; otherwise a 'practice while you wait' action is offered. Needs 2+ items and the 15% cap.
   */
  private async fillWait<T>(p: Promise<T>, o: { learnerStarted: boolean; atomFollows?: boolean; offerOnly?: boolean }): Promise<T> {
    const first = await settleOrTimeout(p, this.deps.delays?.waitFillMs ?? COACH.waitFillMs);
    if (first === 'done') return p;
    const s = this.sprintFor();
    if (s && s.available(2) >= 2 && !sprintCapReached(this)) {
      const now = this.now();
      const auto = o.learnerStarted && !o.offerOnly && this.deps.host.windowFocused() && this.task?.phase !== 'building'
        && !this.deps.lock.held && now - this.monitor.lastEditAt >= COACH.noEditMs;
      if (auto) await this.runSprint(s, { reason: 'wait', until: p, ...(o.atomFollows ? { keepOpen: true } : {}) });
      else {
        this.waitJob = p;
        this.offerWaitSprint();
        void p.finally(() => {
          if (this.waitJob === p) this.waitJob = undefined;
          this.deps.tempo.remove('sprint:wait');
        }).catch(() => undefined);
      }
    }
    return p;
  }

  /** A foreground call the learner started, with the wait filled (Teach on a miss, Check my work). */
  private fgWithSprint<T>(label: string, run: (signal: AbortSignal) => Promise<T>, o: { learnerStarted: boolean; atomFollows?: boolean; offerOnly?: boolean }): Promise<T> {
    return this.fillWait(this.fg(label, run), o);
  }

  // ------------------------------------------------------------ hints

  private maxRung(t: Task): number {
    return t.solo ? COACH.soloMaxRung : MAX_RUNG;
  }

  private servedRungs(t: Task): number {
    return t.hints.filter((h) => h.rung >= 1).length;
  }

  private hintContext(t: FullTask): HintContext {
    const p = this.project!;
    const m = this.monitor;
    return {
      task: t, score: this.signals?.score ?? 0, mode: this.cfg().proactive, files: this.taskFileUris(t),
      taskFileHash: (f) => m.taskFileHash?.(f) ?? Promise.resolve(''),
      mark: () => m.mark?.() ?? 0,
      errorSetHash: () => m.errorSetHash?.() ?? '',
      changedLinesSince: (mk) => m.changedLinesSince?.(mk) ?? 0,
      readLines: (file) => this.deps.host.readLines(file),
      prompt: async (speculative, ownProbe) => hintLadderPrompt({
        projectBrief: projectBrief(p), taskBrief: taskBrief(t, p.language), learnerProfile: this.learnerFor(t.conceptIds),
        stuckReasons: this.signals?.reasons ?? [], ownProbe, codeSnapshot: await this.codeSnapshot(t), speculative,
        previousHints: t.hints.filter((h) => h.rung >= 1).map((h) => h.diagnosis).filter(Boolean),
        misconceptions: p.lang ? taxonomyFor(t.conceptIds.map((id) => concept(this.learner, id)?.tag ?? '').filter((tag) => !!tagInfo(tag)), p.lang) : [],
      }),
    };
  }

  /**
   * Hint (Ctrl+Alt+H, deliberate.hint): single-flight per task. Order: rung 0 for a persistent error
   * (local), the pre-hint own prediction once per stuck episode, rungs 1-3 from the prefetch (else one
   * low-effort call), rung 4 a skeleton in the pad (never the project), rung 5 the smallest piece.
   * Solo tasks stop at rung 2.
   */
  hint(): Promise<void> {
    const t = this.task;
    if (!t) return Promise.resolve();
    if (this.hintFlight?.taskId === t.id) return this.hintFlight.p;
    const p = this.track(this.hintInner(t)).catch((err) => {
      if (!isAbortError(err)) this.errorCard(err, t.feed);
    }).finally(() => {
      if (this.hintFlight?.p === p) this.hintFlight = undefined;
      this.changed();
    });
    this.hintFlight = { taskId: t.id, p };
    return p;
  }

  private async hintInner(t: FullTask): Promise<void> {
    const p = this.project!;
    if (t.status !== 'active' || t.phase !== 'building') return;
    const now = this.now();
    this.deps.tempo.remove('hint-ready');
    // (a) Rung 0: a persistent project error, handled locally (0 wait). Got it there records nothing.
    const r0 = this.monitor.rung0?.(p.lang, now);
    t.rung0Keys ??= [];
    if (r0 && !t.rung0Keys.includes(r0.key)) {
      t.rung0Keys.push(r0.key);
      await this.showHint(t, 0, r0.text, { file: r0.file, line: r0.line, lineText: '' });
      t.hints.push({ rung: 0, at: now, diagnosis: r0.exception ? `persistent ${r0.exception}` : 'persistent error', html: md(r0.text), source: 'local' });
      this.push({ kind: 'hint', title: 'Hint · read the error', html: md(r0.text), actions: this.hintActions(t, 0) }, t.feed);
      return;
    }
    const rung = this.servedRungs(t) + 1;
    if (rung > this.maxRung(t)) {
      this.push({
        kind: 'info', title: t.solo ? 'Solo task: hints stop at rung 2' : 'Hint ladder exhausted',
        html: md(t.solo ? 'This task measures what you can do on your own. Teach me still works for any concept.' : 'You have every hint for this piece. Use **Teach me** for the concept, or **Reveal** as a last resort.'),
      }, t.feed);
      return;
    }
    // (b) Pre-hint step: predict one call of your own function, once per stuck episode.
    let ownProbe: OwnProbeResult | undefined;
    if (rung <= 3 && !this.episodeHinted) ownProbe = await this.preHintPredict(t);
    if (this.task !== t) return;
    if (rung <= 3) await this.ladderRung(t, rung, ownProbe);
    else if (rung === 4) await this.skeletonRung(t);
    else await this.pieceRung(t);
    if (this.task !== t) return;
    t.offeredRung = Math.max(t.offeredRung, rung);
    this.episodeHinted = true;
    this.monitor.detector.markProgress(this.now(), `hint ${rung}`);
  }

  private hintActions(t: Task, rung: number, gapConcept?: string): NonNullable<Card['actions']> {
    const actions: NonNullable<Card['actions']> = [{ label: 'I got it', command: 'gotIt', primary: true }];
    if (rung < this.maxRung(t)) actions.push({ label: `Next hint (${HINT_RUNGS[rung + 1]?.name ?? 'Nudge'})`, command: 'hint' });
    else if (!t.solo) actions.push({ label: 'Reveal...', command: 'reveal' });
    if (gapConcept) {
      const c = concept(this.learner, gapConcept);
      if (c) actions.push({ label: `Practice ${c.name}`, command: 'teach', arg: c.id });
    }
    return actions;
  }

  private async showHint(t: Task, rung: number, text: string, anchor: HintPrefetch['anchor'] | undefined, drill?: { patternName: string }): Promise<void> {
    if (!anchor?.file || !this.deps.hints) return;
    const shown = await this.deps.hints.show({ rung, text, anchor, ...(drill ? { drill } : {}) });
    if (shown && this.task === t) this.deps.tempo.flash(status.hintReady(shown.file, shown.line + 1), STATE_FLASH_MS);
  }

  private async preHintPredict(t: FullTask): Promise<OwnProbeResult | undefined> {
    const predict = this.deps.predict;
    const ctx = this.predictContext(t, 'pre-hint');
    if (!predict || !ctx) return undefined;
    const prepared = await predict.prepare(ctx).catch(() => undefined);
    if (!prepared || this.task !== t) return undefined;
    this.deps.tempo.flash('Before a hint: predict one call (15 s)', STATE_FLASH_MS);
    const r = await predict.run(ctx, prepared).catch(() => undefined);
    if (!r) return undefined;
    this.onPredictResult(t, r);
    if (r.status !== 'answered') return undefined;
    return { call: r.probe.callExpr, predicted: r.predicted.trim() || 'no idea', actual: r.actual, match: r.correct === true };
  }

  private async ladderRung(t: FullTask, rung: number, ownProbe?: OwnProbeResult): Promise<void> {
    const ctx = this.hintContext(t);
    await this.prefetcher.checkHints(ctx);
    let pf = t.hintPrefetch;
    let text = prefetchedRung(pf, rung);
    let source: 'prefetch' | 'on-demand' = 'prefetch';
    if (!text) {
      source = 'on-demand';
      pf = await this.prefetcher.onDemandHints(ctx, (label, run) => this.fg(label, run, { scope: 'task' }), ownProbe);
      text = prefetchedRung(pf, rung);
    }
    let diagnosis = pf?.diagnosis ?? '';
    let conceptIds = (pf?.conceptIds ?? []).map((id) => concept(this.learner, id)?.id).filter((id): id is string => !!id);
    let stuckType = pf?.stuckType ?? '';
    if (!text) {
      // The rung was dropped by post-parse validation: one HintSchema call for just this rung.
      const r = await this.rungHint(t, rung);
      if (!r || this.task !== t) return;
      text = r.hint;
      diagnosis = r.diagnosis;
      stuckType = r.stuckType;
      conceptIds = r.conceptIds.map((id) => concept(this.learner, id)?.id).filter((id): id is string => !!id);
    }
    if (this.task !== t) return;
    if (pf && text === prefetchedRung(pf, rung)) this.prefetcher.hints.markUsed(pf);
    t.hintServe ??= { prefetched: 0, onDemand: 0 };
    t.hintServe[source === 'prefetch' ? 'prefetched' : 'onDemand']++;
    // Rung 2 with a verified atom for the diagnosed concept: the drill offer.
    const gap = conceptIds[0] ?? (stuckType === 'concept-gap' ? weakest(this.learner, t.conceptIds)?.id : undefined);
    const gapConcept = gap ? concept(this.learner, gap) : undefined;
    let drill: { patternName: string } | undefined;
    if (rung === 2 && gapConcept && this.project?.lang) {
      const atom = this.cachedAtom(this.project.lang, gapConcept.id);
      if (atom?.verified) {
        drill = { patternName: this.patternName(gapConcept) };
        this.deps.tempo.enqueue({ id: `atom:${gapConcept.id}`, kind: 'atom', label: status.jitOffer(drill.patternName), priority: 1, blocking: false, command: 'deliberate.jitAtom', args: [gapConcept.id] });
      }
    }
    await this.showHint(t, rung, text, pf?.anchor, drill);
    t.hints.push({ rung, at: this.now(), diagnosis, html: md(text), conceptIds, source });
    if (pf?.misconceptionId && (stuckType === 'concept-gap' || stuckType === 'slip')) {
      recordMistake(this.learner, { pattern: pf.misconceptionId, detail: diagnosis, conceptIds, taskId: t.id, misconceptionId: pf.misconceptionId });
    }
    this.push({ kind: 'hint', title: `Hint ${rung}/${this.maxRung(t)} · ${HINT_RUNGS[rung].name}`, html: md(text), actions: this.hintActions(t, rung, stuckType === 'concept-gap' ? gapConcept?.id : undefined) }, t.feed);
  }

  /** Rungs 4-5 (and a dropped rung 1-3): HintSchema at low effort in the foreground. */
  private async rungHint(t: FullTask, rung: number): Promise<HintResult | undefined> {
    const p = this.project!;
    try {
      const prompt = rungHintPrompt({
        projectBrief: projectBrief(p), taskBrief: taskBrief(t, p.language), learnerProfile: this.learnerFor(t.conceptIds),
        stuckReasons: this.signals?.reasons ?? [], previousHints: t.hints.filter((h) => h.rung >= 1).map((h) => h.diagnosis).filter(Boolean),
        codeSnapshot: await this.codeSnapshot(t), rung,
      });
      return await this.fg(`Preparing hint ${rung}`, (signal) => this.deps.llm.json({ system: SYSTEM, prompt, schema: HintSchema, effort: 'low' }, { signal }), { scope: 'task' });
    } catch (err) {
      if (!isAbortError(err)) this.errorCard(err, t.feed);
      return undefined;
    }
  }

  private recordRungMistake(t: Task, r: HintResult): string[] {
    const ids = r.conceptIds.map((id) => concept(this.learner, id)?.id).filter((id): id is string => !!id);
    if (r.mistakePattern && (r.stuckType === 'slip' || r.stuckType === 'concept-gap')) {
      const m = recordMistake(this.learner, { pattern: r.mistakePattern, detail: r.diagnosis, conceptIds: ids, taskId: t.id });
      if (m.count > 1) this.logCard(`Recurring mistake x${m.count}`, [`**${m.pattern}**: you have hit this before.`], t.feed);
    }
    return ids;
  }

  /** Rung 4: the skeleton opens in the pad, never in the project files. */
  private async skeletonRung(t: FullTask): Promise<void> {
    const r = await this.rungHint(t, 4);
    if (!r || this.task !== t) return;
    const ids = this.recordRungMistake(t, r);
    const code = fencedCode(r.hint);
    const lang = this.project?.lang;
    const pad = this.deps.pad;
    t.hints.push({ rung: 4, at: this.now(), diagnosis: r.diagnosis, html: md(r.hint), conceptIds: ids, source: 'on-demand' });
    // The lock first: when another flow holds it (a sprint), the card keeps the code instead of
    // pointing at a pad that never opens.
    const release = lang && pad && this.deps.skeleton && code.includes('___') ? pad.acquire('skeleton') : undefined;
    const inPad = !!release;
    this.push({
      kind: 'hint', title: `Hint 4/${MAX_RUNG} · Skeleton`,
      html: md(inPad ? `${r.hint.replace(/```[\s\S]*?```/g, '').trim() || 'Fill the blanks.'}\n\n_The skeleton is open in the practice tab. Fill it there, then write it in your own file._` : r.hint),
      actions: this.hintActions(t, 4),
    }, t.feed);
    this.changed();
    if (!release) return;
    try {
      await this.deps.skeleton!(lang!, code);
    } catch (err) {
      this.log(`[coach] skeleton failed: ${errorMessage(err)}`);
    } finally {
      release();
    }
  }

  /** Rung 5: the smallest piece, in the comment thread and a 'retype it' card. */
  private async pieceRung(t: FullTask): Promise<void> {
    const r = await this.rungHint(t, 5);
    if (!r || this.task !== t) return;
    const ids = this.recordRungMistake(t, r);
    t.hints.push({ rung: 5, at: this.now(), diagnosis: r.diagnosis, html: md(r.hint), conceptIds: ids, source: 'on-demand' });
    await this.showHint(t, 5, r.hint, t.hintPrefetch?.anchor);
    this.push({ kind: 'hint', title: `Hint 5/${MAX_RUNG} · Smallest piece`, html: md(`${r.hint}\n\n**Retype it, don't paste.**`), actions: this.hintActions(t, 5) }, t.feed);
  }

  /** Got it: rung evidence (spec V1-3 passive a), annotations cleared, progress, back to building. */
  gotIt(): void {
    const t = this.task;
    if (!t) return;
    const last = t.hints[t.hints.length - 1];
    this.deps.hints?.clear('got-it');
    this.deps.tempo.remove('hint-ready');
    if (last && last.rung >= 1) {
      const ids = last.conceptIds?.length ? last.conceptIds : (t.hintPrefetch?.conceptIds ?? []).map((id) => concept(this.learner, id)?.id).filter((id): id is string => !!id);
      recordHintEvidence(this.learner, t.id, last.rung, ids.length ? ids : t.conceptIds);
    }
    this.monitor.detector.markProgress(this.now(), 'unblocked by a hint');
    if (t.phase !== 'building' && t.status === 'active' && t.phase !== 'learning') t.phase = 'building';
    this.changed();
  }

  /** "I'm fine": the offer re-arms only after another full stuck threshold. */
  imFine(): void {
    const t = this.task;
    if (t) t.offeredRung = this.servedRungs(t);
    this.deps.tempo.remove('hint-ready');
    this.monitor.detector.markProgress(this.now(), 'learner declined help');
    this.changed();
  }

  /** Reveal (foreground, confirmed). Not in solo tasks. */
  async reveal(): Promise<void> {
    const t = this.task;
    const p = this.project;
    if (!t || !p) return;
    if (t.solo) {
      this.push({ kind: 'info', title: 'Solo task', html: md('Reveal is off in solo tasks: they measure what you can do on your own.') }, t.feed);
      this.changed();
      return;
    }
    const ok = await this.deps.host.confirm('Reveal the code for the piece you are stuck on? It counts as a reveal for these concepts and adds a rebuild-from-memory challenge.', 'Reveal');
    if (!ok) return;
    try {
      const r = await this.fg('Revealing the stuck piece', async (signal) => this.deps.llm.json({
        system: SYSTEM,
        prompt: revealPrompt({ projectBrief: projectBrief(p), taskBrief: taskBrief(t, p.language), hints: t.hints.map((h) => h.diagnosis).filter(Boolean).join(' | '), code: await this.codeSnapshot(t) }),
        schema: RevealSchema, effort: 'medium',
      }, { signal }));
      if (this.task !== t) return;
      t.revealed = true;
      const ids = unique(t.hints.flatMap((h) => h.conceptIds ?? []));
      recordHintEvidence(this.learner, t.id, 'reveal', ids.length ? ids : t.conceptIds);
      this.push({
        kind: 'hint', title: 'Revealed',
        html: md(`${r.explanation}\n\n${r.code}\n\n**Retype it, don't paste.**\n\n**Rebuild challenge (from memory, later):** ${r.rebuildChallenge}`),
        actions: [{ label: 'I got it', command: 'gotIt', primary: true }],
      }, t.feed);
      this.monitor.detector.markProgress(this.now(), 'revealed');
    } catch (err) {
      this.errorCard(err, t.feed);
    }
    this.changed();
  }

  // ------------------------------------------------------------ own code

  /** Predict / what-if context for the task's interface file (undefined without a runnable language or file). */
  private predictContext(t: FullTask, via?: PredictContext['via']): PredictContext | undefined {
    const p = this.project;
    const lang = p?.lang;
    const file = t.interface.file ? this.absPath(t.interface.file) : undefined;
    if (!p || !lang || !file) return undefined;
    const names = t.interface.functions.map((f) => t.interface.mappedNames?.[f.name] ?? f.name);
    const ctx: PredictContext = {
      taskId: t.id, lang, file, conceptId: weakest(this.learner, t.conceptIds)?.id ?? t.conceptIds[0] ?? 'decomposition',
      asked: t.ownProbes, speed: { cps: this.learner.cps, speedFactor: this.learner.speedFactor },
      ...(names.length ? { functions: names } : {}),
      ...(t.interface.mappedNames ? { mappedNames: t.interface.mappedNames } : {}),
      ...(t.spec?.applicable ? { visible: t.spec.specs, hidden: t.spec.hidden } : { modelProbes: this.prefetcher.modelProbes(t.id) }),
      ...(via ? { via } : {}),
    };
    return ctx;
  }

  /** deliberate.predictOwn (Ctrl+Alt+P, or the accepted offer). */
  async predictOwn(cursorLine?: number): Promise<void> {
    const t = this.task;
    const predict = this.deps.predict;
    if (!t || !predict) return;
    const ctx = this.predictContext(t, cursorLine === undefined ? 'offer' : 'key');
    if (!ctx) return;
    if (cursorLine !== undefined) ctx.cursorLine = cursorLine;
    const r = await this.track(predict.run(ctx).catch((err): PredictResult => ({ status: 'unavailable', reason: errorMessage(err) })));
    this.onPredictResult(t, r);
    if (r.status === 'unavailable' && r.reason !== 'busy') this.deps.tempo.flash(r.reason, STATE_FLASH_MS);
  }

  private onPredictResult(t: FullTask, r: PredictResult): void {
    if (r.status !== 'answered') return;
    if (r.evidence) recordEvidence(this.learner, r.evidence);
    t.ownProbes.push(r.probe);
    const p = this.project;
    if (r.mismatch && p?.lang && !t.solo) {
      const c = concept(this.learner, r.conceptId);
      if (c && this.cachedAtom(p.lang, c.id)) {
        this.deps.tempo.enqueue({ id: `atom:${c.id}`, kind: 'atom', label: status.jitOffer(this.patternName(c)), priority: 2, blocking: false, command: 'deliberate.jitAtom', args: [c.id] });
      }
    }
    if (t.spec) t.notUnderstood = conflictFlag({ ownProbes: t.ownProbes, specsFast: specsGreenFast(t.spec, { activeMs: t.activeMs }) });
    this.changed();
  }

  /** A real pause (manual clean save, spec green, terminal ok, idle): maybe offer an own-code prediction. */
  private onPause(kind: PauseKind): void {
    const t = this.task;
    const predict = this.deps.predict;
    if (!t || !predict || t.phase !== 'building' || t.criteriaMetAt) return;
    const score = this.signals?.score ?? 0;
    if (score >= 0.5 && score < 1) return;
    if (this.activeTotal - this.lastOwnOfferActive < COACH.ownPredictSpacingMs) return;
    const ctx = this.predictContext(t, 'offer');
    if (!ctx) return;
    this.lastOwnOfferActive = this.activeTotal;
    void this.track(predict.offer(ctx).catch(() => undefined));
    void kind;
  }

  /**
   * A saved code file (Monitor.onSave): OwnCodeProbe inputs for a spec-less task, when the file's
   * function set changed, at most once per 2 min, building only (spec V1-12 (2)).
   */
  async onSave(e: { uri: string; fsPath: string }): Promise<void> {
    const t = this.task;
    const p = this.project;
    if (!t || !p?.lang || t.phase !== 'building') return;
    const hasLadder = !!this.deps.specs?.applicable && this.deps.specs.taskId === t.id;
    if (hasLadder || !this.allowRun()) return;
    const text = await this.deps.host.readText(e.fsPath);
    if (text === undefined) return;
    const names = (await this.deps.host.functionNames?.(e.fsPath, text, p.lang).catch(() => [] as string[])) ?? [];
    if (!this.modelProbeTrigger.onSave(e.fsPath, names, this.now(), { building: true, hasLadder })) return;
    const ws = this.deps.host.workspaceDir();
    const rel = ws ? nodePath.relative(ws, e.fsPath).replace(/\\/g, '/') : e.fsPath;
    const prompt = ownCodeProbePrompt({ taskBrief: taskBrief(t, p.language), conceptIds: t.conceptIds, path: rel, code: text });
    void this.track(this.prefetcher.ownCodeProbes(t, { path: rel, code: text }, prompt));
  }

  /** Monitor.onInsert: pasted / assisted characters (never a message). */
  onInsert(e: { kind: 'paste' | 'assisted'; chars: number; functions?: string[] }): void {
    const t = this.task;
    if (!t || t.status !== 'active') return;
    if (e.kind === 'paste') t.pastedChars += e.chars;
    else {
      t.assistedChars += e.chars;
      for (const f of e.functions ?? []) if (!t.assistedFunctions.includes(f)) t.assistedFunctions.push(f);
    }
    this.deps.store.save();
  }

  // ------------------------------------------------------------ specs

  private specCallbacks(): SpecCallbacks {
    return {
      onGreen: (_specId, weight, info) => {
        const t = this.task;
        if (!t || this.deps.specs?.taskId !== t.id) return;
        const since = info.previousGreenAt ?? t.startedAt ?? info.at;
        const latencyMs = this.activeMsSince(since);
        const item = { kind: 'spec' as const, codeLines: 0, answerChars: 0, parSec: info.spec.parSec };
        recordEvidence(this.learner, {
          conceptId: info.spec.conceptId, kind: 'spec', source: 'spec', correct: true, production: true, weight, taskId: t.id,
          itemId: `spec:${t.id}:${info.spec.id}`, at: info.at, latencyMs, latencyValid: latencyMs > 0,
          parSelfMs: parSelf(item, this.learner), parAbsMs: parSelf(item, { cps: this.learner.cps, speedFactor: 1 }),
        });
        this.monitor.detector.markProgress(info.at, `spec ${info.number} green`);
        this.deps.hints?.clear('spec-green');
        this.changed();
      },
      onSignature: (spec, sig, info) => {
        const t = this.task;
        if (!t || t.solo) return;
        recordEvidence(this.learner, {
          conceptId: spec.conceptId, kind: 'passive', source: 'spec', correct: false, weight: 0.5, taskId: t.id,
          ...(sig.misconceptionId ? { misconceptionId: sig.misconceptionId, misconceptionOdds: 1.5 } : {}),
        });
        recordMistake(this.learner, {
          pattern: sig.misconceptionId || sig.nudge, detail: `spec ${info.number}: ${spec.title}`, conceptIds: [spec.conceptId], taskId: t.id,
          ...(sig.misconceptionId ? { misconceptionId: sig.misconceptionId } : {}),
        });
        this.changed();
      },
      onSignatureStuck: (spec) => {
        const lang = this.project?.lang;
        if (lang && !this.cachedAtom(lang, spec.conceptId)) this.prefetcher.prepareConcepts(lang, [spec.conceptId], { priority: 1 });
      },
      onAllVisibleGreen: () => {
        this.deps.tempo.flash('Every visible behaviour passes · checking hidden ones', STATE_FLASH_MS);
      },
      onHiddenResult: (r) => void this.track(this.onHidden(r)),
      onLoadError: (n) => {
        const t = this.task;
        if (!t) return;
        const last = t.feed[t.feed.length - 1];
        if (last?.title === 'Your module did not load' && last.html.includes(n.message)) return;
        this.logCard('Your module did not load', [n.message], t.feed);
        this.changed();
      },
      onApplicableChange: (applicable, reason) => {
        const t = this.task;
        if (t && !applicable && reason === DESIGN_DIFFERS) this.push({ kind: 'info', title: 'Your own design', html: md(DESIGN_DIFFERS) }, t.feed);
        this.changed();
      },
      onUpdate: () => this.changed(),
    };
  }

  private async onHidden(r: HiddenResult): Promise<void> {
    const t = this.task;
    if (!t || this.deps.specs?.taskId !== t.id) return;
    if (r.pass) {
      await this.criteriaMet(t, 'specs');
      return;
    }
    this.push({ kind: 'review', title: 'Passes your checks, not this one', html: md(r.card) }, t.feed);
    recordEvidence(this.learner, { conceptId: r.spec.conceptId, kind: 'spec', source: 'spec', correct: false, taskId: t.id, itemId: `hidden:${t.id}:${r.spec.id}` });
    this.changed();
  }

  // ------------------------------------------------------------ check my work, criteria, completion

  /**
   * Check my work. With an applicable spec ladder the specs decide (this just runs them). Without one:
   * the review runs in the foreground lane at medium effort; the sprint is offer-only while building.
   */
  async checkWork(): Promise<void> {
    const t = this.task;
    const p = this.project;
    if (!t || !p || t.status !== 'active') return;
    const specs = this.deps.specs;
    if (specs?.applicable && specs.taskId === t.id) {
      this.deps.tempo.flash('Running your specs', STATE_FLASH_MS);
      await this.track(specs.runNow('coach').catch(() => undefined));
      return;
    }
    if (t.criteriaMetAt) return;
    await this.track(this.reviewWork(t, p));
  }

  private async reviewWork(t: FullTask, p: Project): Promise<void> {
    let r;
    try {
      const prompt = workReviewPrompt({
        projectBrief: projectBrief(p), taskBrief: taskBrief(t, p.language), learnerProfile: this.learnerFor(t.conceptIds),
        code: await this.codeSnapshot(t), previous: t.lastReview, now: this.now(),
      });
      r = await this.fgWithSprint('Reviewing your work', (signal) => this.deps.llm.json({ system: SYSTEM, prompt, schema: WorkReviewSchema, effort: 'medium' }, { signal }), {
        learnerStarted: true, offerOnly: t.phase === 'building',
      });
    } catch (err) {
      this.errorCard(err, t.feed);
      this.changed();
      return;
    }
    if (this.task !== t || t.status !== 'active') return;
    t.lastReview = { at: this.now(), summary: r.summary, issues: r.issues.map((i) => `${i.severity}: ${i.prompt}`) };
    for (const m of r.mistakePatterns) recordMistake(this.learner, { ...m, conceptIds: m.conceptIds.map(slug), taskId: t.id });
    this.deps.tempo.flash('Review ready', STATE_FLASH_MS);
    const issues = r.issues.map((i) => `- **${i.severity}**: ${i.prompt}`).join('\n');
    if (!r.meetsCriteria) {
      this.push({ kind: 'review', title: 'Not done yet', html: md(`${r.summary}\n\n${issues}`) }, t.feed);
      this.changed();
      return;
    }
    this.push({ kind: 'review', title: 'Criteria met', html: md(`${r.summary}${issues ? `\n\n${issues}` : ''}`) }, t.feed);
    if (r.explainBackQuestion.trim()) t.explainBackQuestion = r.explainBackQuestion.trim();
    await this.criteriaMet(t, 'review');
  }

  /**
   * Criteria met (hidden specs pass, or the review says so): the follow-up is prefetched now (when
   * policy says so), then what-ifs on the learner's own lines, else the background-graded explain-back
   * fallback, then the next task at once.
   */
  private async criteriaMet(t: FullTask, via: 'specs' | 'review'): Promise<void> {
    if (t.criteriaMetAt || t.status !== 'active') return;
    t.criteriaMetAt = this.now();
    this.deps.tempo.flash(via === 'specs' ? 'Every behaviour passes' : 'Criteria met', STATE_FLASH_MS);
    this.maybeFollowUp(t);
    if (via === 'specs' && this.cfg().polishReview) this.polishReview(t);
    this.changed();
    const what = await this.whatIfs(t);
    if (this.task !== t || t.status !== 'active') return;
    if (what === 'unavailable' || (what === 'done' && t.notUnderstood)) {
      this.askExplainBack(t);
      return;
    }
    await this.completeTask(t);
  }

  /** Opt-in (deliberate.polishReview): a background design/naming review once every spec passes. */
  private polishReview(t: FullTask): void {
    const p = this.project;
    if (!p) return;
    const job = (async () => {
      const prompt = workReviewPrompt({
        projectBrief: projectBrief(p), taskBrief: taskBrief(t, p.language), learnerProfile: this.learnerFor(t.conceptIds),
        code: await this.codeSnapshot(t), now: this.now(), polishOnly: true,
      });
      return this.deps.jobs.bg({
        key: `polish:${t.id}`, priority: 3, effort: 'medium', label: 'Polish review', scope: 'project', gen: this.gen(),
        run: (signal) => this.deps.llm.json({ system: SYSTEM, prompt, schema: WorkReviewSchema, effort: 'medium' }, { signal, fast: false, background: true }),
      }, (r) => {
        const issues = r.issues.map((i) => `- **${i.severity}**: ${i.prompt}`);
        this.push({ kind: 'review', title: 'Polish review', html: md([r.summary, issues.join('\n')].filter(Boolean).join('\n\n')) }, t.feed);
        this.changed();
      });
    })();
    void this.track(job);
  }

  private async whatIfs(t: FullTask): Promise<'done' | 'skipped' | 'unavailable' | 'later'> {
    const learner = this.learner;
    const allFluent = t.conceptIds.length > 0 && t.conceptIds.every((id) => {
      const c = concept(learner, id);
      return !!c && conceptChip(learner, c) === 'Fluent';
    });
    if (allFluent) return 'skipped';
    const wf = this.deps.whatIf;
    const base = this.predictContext(t);
    if (!wf || !base || !this.allowRun() || !this.runner(this.project?.lang)) return 'unavailable';
    if (t.spec) t.notUnderstood = conflictFlag({ ownProbes: t.ownProbes, specsFast: specsGreenFast(t.spec, { activeMs: t.activeMs }) });
    const weakestC = weakest(learner, t.conceptIds);
    const ctx: WhatIfContext = {
      ...base, count: whatIfCount(t.notUnderstood), journal: learner.mistakes, allFluent,
      conceptForTag: (tag) => this.conceptForTag(tag, t),
      ...(weakestC?.tag ? { weakestTag: weakestC.tag } : {}),
    };
    await this.lockFree();
    let res: WhatIfRunResult;
    try {
      res = await wf.run(ctx);
    } catch (err) {
      this.log(`[coach] what-ifs failed: ${errorMessage(err)}`);
      return 'unavailable';
    }
    for (const e of res.evidence) recordEvidence(learner, e);
    t.whatIfs.push(...res.whatIfs);
    if (res.whatIfs.length) {
      const right = res.whatIfs.filter((w) => w.correct).length;
      this.logCard('What-ifs', [`${right}/${res.whatIfs.length} predicted right on your own code`], t.feed);
    }
    if (res.status === 'unavailable') return res.reason === 'busy' ? 'later' : 'unavailable';
    return res.status === 'skipped' ? 'skipped' : res.status === 'later' ? 'later' : 'done';
  }

  /** The concept an operator's tag belongs to: a task concept with that tag, else any concept with it. */
  private conceptForTag(tag: string, t: Task): string | undefined {
    const learner = this.learner;
    const inTask = t.conceptIds.map((id) => concept(learner, id)).find((c) => c?.tag === tag);
    return inTask?.id ?? concept(learner, tag)?.id ?? Object.values(learner.concepts).find((c) => c.tag === tag)?.id;
  }

  /** Wait until no modal flow holds the lock (bounded). */
  private async lockFree(maxMs = 5 * MIN): Promise<void> {
    if (!this.deps.lock.held) return;
    let sub: Disposable | undefined;
    const released = new Promise<void>((resolve) => {
      sub = this.deps.lock.onDidRelease(() => resolve());
    });
    await settleOrTimeout(released, maxMs);
    sub?.dispose();
  }

  /** The explain-back fallback (no runtime or probe) and the conflict-flag question: graded in the background. */
  private askExplainBack(t: FullTask): void {
    const q = t.explainBackQuestion?.trim() || 'In two or three sentences: how does your solution work, and which case was the trickiest to get right?';
    t.explainBackQuestion = q;
    t.phase = 'explain-back';
    this.push({ kind: 'question', title: 'Explain it back', html: md(q) }, t.feed);
    this.changed();
    this.deps.host.focusComposer?.('explain-back');
  }

  /** Answer to the explain-back question: graded in the background (llm-grade, weight .5); the next task starts at once. */
  async answerExplainBack(text: string): Promise<void> {
    const t = this.task;
    const p = this.project;
    if (!t || !p || t.phase !== 'explain-back') return;
    this.push({ kind: 'you', title: 'You', html: md(text) }, t.feed);
    const q = t.explainBackQuestion ?? '';
    t.explainBackQuestion = undefined;
    const context = `Context, the task and their code:\n${taskBrief(t, p.language)}\n${await this.codeSnapshot(t)}`;
    const ids = [...t.conceptIds];
    const job = this.deps.jobs.bg({
      key: `explain:${t.id}`, priority: 1, effort: 'low', label: 'Grading your explanation', scope: 'project', gen: this.gen(),
      run: (signal) => this.deps.llm.json({ system: SYSTEM, prompt: gradePrompt(q, '', text, context), schema: GradeSchema, effort: 'low' }, { signal, fast: false, background: true }),
    }, (g) => {
      for (const id of ids) recordEvidence(this.learner, { conceptId: id, kind: 'llm-grade', source: 'llm', correct: g.correct, weight: 0.5, taskId: t.id });
      if (!g.correct && g.misconception) recordMistake(this.learner, { pattern: g.misconception, detail: `Explaining: ${q}`, conceptIds: ids, taskId: t.id });
      this.logCard(g.correct ? 'Explanation: clear' : 'Explanation: partly there', [g.feedback], t.feed);
      this.changed();
    });
    void this.track(job);
    await this.completeTask(t);
  }

  async skipExplainBack(): Promise<void> {
    const t = this.task;
    if (!t || t.phase !== 'explain-back') return;
    t.explainBackQuestion = undefined;
    await this.completeTask(t);
  }

  /** Follow-up policy: the weakest task concept below P .6, or an active misconception on a task concept. */
  followUpTarget(t: Task): { id: string; p: number; chip: string; belief?: string } | undefined {
    const learner = this.learner;
    const cs = unique(t.conceptIds.map((id) => concept(learner, id)).filter((c): c is ConceptState => !!c && c.id !== DECOMPOSITION));
    for (const c of cs) {
      const active = Object.values(c.misconceptions ?? {}).find((m) => m.status === 'active');
      if (active) return { id: c.id, p: c.mastery, chip: conceptChip(learner, c), belief: active.belief };
    }
    const w = cs.sort((a, b) => a.mastery - b.mastery)[0];
    return w && w.mastery < COACH.followUpMaxP ? { id: w.id, p: w.mastery, chip: conceptChip(learner, w) } : undefined;
  }

  private maybeFollowUp(t: FullTask): void {
    const p = this.project;
    if (!p || t.kind === 'drill' || t.followUpDepth >= this.cfg().maxFollowUps || this.followUps.has(t.id)) return;
    const w = this.followUpTarget(t);
    if (!w) return;
    const upcoming = this.upcoming(p, 4, t).map((x) => x.title);
    const how = `${Math.round(t.activeMs / 60000)} min active vs ${t.estimatedMinutes} estimated; ${this.servedRungs(t)} hints; ${t.revealed ? 'needed a reveal' : 'no reveal'}; follow-up depth ${t.followUpDepth}.`;
    const job = this.prefetcher.followUp(t, {
      projectBrief: projectBrief(p), taskBrief: taskBrief(t, p.language), howItWent: how, learnerProfile: this.learnerFor(t.conceptIds), upcoming, weakest: w,
    }, (fu) => this.onFollowUp(p, t, fu));
    this.followUps.set(t.id, job);
    void this.track(job);
  }

  private onFollowUp(p: Project, parent: Task, fu: FollowUp): void {
    if (this.deps.store.project !== p) return;
    const task = this.newTask(fu, 'followup', parent.id, parent.followUpDepth + 1);
    const missing = task.conceptIds.filter((id) => !concept(this.learner, id));
    task.conceptIds = task.conceptIds.filter((id) => !missing.includes(id));
    if (!task.conceptIds.length) task.conceptIds = [...parent.conceptIds];
    task.conceptIds = unique(task.conceptIds.map((id) => concept(this.learner, id)?.id ?? id));
    insertAfter(p, rootOf(p, parent), task);
    this.logCard('Follow-up added', [`**${fu.title}**: ${fu.why}`], this.feedOf());
    this.prepTasks([task], this.now() + 2 * MIN);
    if (p.lang) this.prefetcher.prepareConcepts(p.lang, task.conceptIds, { priority: 1 });
    const cur = this.task;
    if (!cur || cur.status === 'done') void this.track(this.beginTask(task));
    this.changed();
  }

  /** Task solved: 'task' evidence, summary card, then the next task at once. */
  private async completeTask(t: FullTask): Promise<void> {
    const p = this.project;
    if (!p || t.status === 'done') return;
    const learner = this.learner;
    const before = Object.fromEntries(t.conceptIds.map((id) => [id, concept(learner, id)?.mastery ?? 0]));
    t.status = 'done';
    t.phase = 'done';
    t.completedAt = this.now();
    if (this.deps.specs?.taskId === t.id) this.deps.specs.detach();
    this.deps.predict?.clearOffer();
    this.deps.hints?.clear('task-changed');
    this.deps.tempo.remove('hint-ready');
    recordSolve(learner, t, { solo: t.solo });
    const deltas = t.conceptIds
      .map((id) => {
        const c = concept(learner, id);
        if (!c) return '';
        const d = c.mastery - (before[id] ?? 0);
        return `- ${c.name}: ${conceptChip(learner, c)} ${(c.mastery * 100).toFixed(0)}% (${d >= 0 ? '+' : ''}${(d * 100).toFixed(0)})`;
      })
      .filter(Boolean)
      .join('\n');
    const specLine = t.spec?.specs.length ? ` · ${t.spec.specs.filter((s) => t.spec!.greenAt[s.id] !== undefined).length}/${t.spec.specs.length} specs` : '';
    this.push({
      kind: 'info', title: 'Task complete',
      html: md(`**${Math.round(t.activeMs / 60000)} min** active (target ${t.estimatedMinutes}) · **${this.servedRungs(t)}** hints${t.revealed ? ' · revealed' : ''}${specLine}\n\n${deltas}`),
    }, t.feed);
    if (p.lang) this.prefetcher.refillLowStock(p.lang);
    // A follow-up still being written gets a short grace period, so it comes next.
    const fu = this.followUps.get(t.id);
    if (fu) await settleOrTimeout(fu, this.deps.delays?.followUpWaitMs ?? COACH.followUpWaitMs);
    if (this.deps.store.project !== p) return;
    void this.refreshPace();
    const cur = this.task;
    if (cur && cur !== t && cur.status === 'active') {
      this.changed();
      return; // a follow-up landing meanwhile already started
    }
    const next = this.nextRoadmapTask();
    if (next) {
      await this.beginTask(next);
      return;
    }
    const k = p.milestones.findIndex((m) => !m.taskIds.length);
    if (k >= 0) {
      this.enqueueBatch(p, k);
      this.push({ kind: 'info', title: 'The next milestone is being prepared', html: md('It starts the moment it lands. A sprint keeps your concepts warm meanwhile.') }, t.feed);
      this.waitJob = undefined;
      this.offerWaitSprint();
    } else {
      this.push({ kind: 'info', title: 'Roadmap complete', html: md('You built the whole project. Run a 3-minute sprint to keep the concepts fast, or start a new goal.'), actions: [{ label: 'Sprint (3 min)', command: 'sprint' }] }, t.feed);
    }
    this.changed();
  }

  // ------------------------------------------------------------ free text

  /** The free-text own plan ("I'd do it differently"): reviewed in the background; building starts at once. */
  async submitExplanation(text: string): Promise<void> {
    const t = this.task;
    const p = this.project;
    if (!t || !p) return;
    this.push({ kind: 'you', title: 'Your plan', html: md(text) }, t.feed);
    // A plan typed while the gate QuickPick is open replaces the gate (closed as Esc, nothing recorded).
    if (t.phase === 'gate' && this.deps.lock.active === 'gate') this.deps.lock.abortActive();
    t.explainAttempts++;
    t.explanation = text;
    const ids = [...t.conceptIds];
    const job = this.deps.jobs.bg({
      key: `review:${t.id}`, priority: 1, effort: 'low', label: 'Reviewing your plan', scope: 'task', gen: this.gen(),
      run: (signal) => this.deps.llm.json({
        system: SYSTEM,
        prompt: explanationReviewPrompt({ projectBrief: projectBrief(p), taskBrief: taskBrief({ ...t, explanation: undefined }, p.language), learnerProfile: this.learnerFor(ids), attempt: t.explainAttempts, text }),
        schema: ExplanationReviewSchema, effort: 'low',
      }, { signal, fast: false, background: true }),
    }, (r) => this.onPlanReview(t, r));
    void this.track(job);
    if (t.phase === 'explain' || t.phase === 'gate') await this.goBuilding(t, 'Go build · your plan is being reviewed');
    this.changed();
  }

  private onPlanReview(t: FullTask, r: ExplanationReview): void {
    const learner = this.learner;
    const title = r.verdict === 'ready' ? 'Your plan looks workable' : r.verdict === 'gaps' ? 'Your plan: some gaps' : 'Your plan: not there yet';
    this.push({ kind: 'review', title, html: md(r.feedback + (r.probingQuestion ? `\n\n> ${r.probingQuestion}` : '')) }, t.feed);
    const gapIds = r.gaps.map((g) => concept(learner, g.conceptId)?.id).filter((id): id is string => !!id);
    for (const id of t.conceptIds) {
      recordEvidence(learner, { conceptId: id, kind: 'llm-grade', source: 'llm', correct: r.verdict === 'ready' || (r.verdict === 'gaps' && !gapIds.includes(id)), weight: 0.5, taskId: t.id });
    }
    const offer = gapIds[0] ?? (r.verdict === 'lost' ? weakest(learner, t.conceptIds)?.id : undefined);
    const c = offer ? concept(learner, offer) : undefined;
    if (c && r.verdict !== 'ready') {
      this.deps.tempo.enqueue({ id: `atom:${c.id}`, kind: 'atom', label: status.jitOffer(this.patternName(c)), priority: 2, blocking: false, command: 'deliberate.jitAtom', args: [c.id] });
    }
    this.changed();
  }

  /** 'Build without a plan' in explain mode. */
  async buildNow(): Promise<void> {
    const t = this.task;
    if (t && (t.phase === 'explain' || t.phase === 'gate')) await this.goBuilding(t);
  }

  /** Ask the coach (foreground). */
  async askCoach(question: string): Promise<void> {
    const t = this.task;
    const p = this.project;
    if (!question.trim()) return;
    this.push({ kind: 'you', title: 'You asked', html: md(question) });
    this.changed();
    try {
      const code = t && t.phase === 'building' ? await this.codeSnapshot(t) : undefined;
      const r = await this.fg('Thinking', (signal) => this.deps.llm.json({
        system: SYSTEM,
        prompt: askPrompt({
          projectBrief: p ? projectBrief(p) : undefined, taskBrief: t ? taskBrief(t, p?.language) : undefined,
          learnerProfile: t ? this.learnerFor(t.conceptIds) : snapshot(this.learner), code, question,
        }),
        schema: AnswerSchema, effort: 'medium',
      }, { signal }));
      this.push({ kind: 'answer', title: 'Coach', html: md(r.answer) });
    } catch (err) {
      this.errorCard(err);
    }
    this.changed();
  }

  /** Main composer submit: meaning depends on the mode. */
  async submit(text: string): Promise<void> {
    const t = this.task;
    text = text.trim();
    if (!text || !this.project) return;
    if (!t || t.status !== 'active') return this.askCoach(text);
    switch (t.phase) {
      case 'explain':
      case 'gate':
        return this.submitExplanation(text);
      case 'explain-back':
        return this.answerExplainBack(text);
      default:
        return this.askCoach(text);
    }
  }

  // ------------------------------------------------------------ new project / reset

  /** Abandon the project (after the shell's confirmation): flows aborted, project jobs cancelled. */
  async newProject(): Promise<void> {
    this.abortFlows('project');
    this.prefetcher.reset();
    await this.deps.store.resetProject();
    this.refresh();
  }

  /** Erase the learner profile (after confirmation). */
  async resetProfile(): Promise<void> {
    this.abortFlows('project');
    this.prefetcher.reset();
    await this.deps.store.resetLearner();
    this.refresh();
  }

  /** Consent or workspace trust changed. */
  setAllowRun(allow: boolean): void {
    this.deps.specs?.setAllowRun(allow);
    if (allow) this.reprepLadders();
  }

  // ------------------------------------------------------------ monitoring

  private stuckThresholdFor(t: FullTask): number {
    let th = stuckThreshold(this.learner, t, this.cfg().stuckMinutes);
    if (this.knownGap(t)) th *= COACH.knownGapFactor;
    if (this.prevNotUnderstood) th *= COACH.notUnderstoodFactor;
    return Math.max(1, th);
  }

  /** The next red spec's concept is a gate-deferred gap whose JIT offer was skipped. */
  private knownGap(t: FullTask): boolean {
    const target = t.spec?.specs.find((s) => !t.spec!.greenAt[s.id] && !t.spec!.last?.[s.id]?.pass);
    if (!target) return false;
    const id = concept(this.learner, target.conceptId)?.id ?? target.conceptId;
    return !!t.gateDeferred?.includes(id) && !!t.jitSkipped?.includes(id);
  }

  private onSkip(a: Action): void {
    const t = this.task;
    if (!t) return;
    if ((a.kind === 'jit-atom' || a.kind === 'atom') && typeof a.args?.[0] === 'string') {
      const id = concept(this.learner, a.args[0] as string)?.id ?? (a.args[0] as string);
      t.jitSkipped = unique([...(t.jitSkipped ?? []), id]);
      this.deps.store.save();
    }
  }

  private onTick(addedMs: number): void {
    const now = this.now();
    this.rollDay(now);
    this.activeMsToday += addedMs;
    this.activeTotal += addedMs;
    this.activeSamples.push([now, this.activeTotal]);
    if (this.activeSamples.length > 4000) this.activeSamples.splice(0, this.activeSamples.length - 4000);
    const t = this.task;
    if (t && t.status === 'active') {
      t.activeMs += addedMs;
      this.recordTouchedFiles(t);
      if (t.phase === 'building') {
        const d = this.monitor.detector;
        // Real progress (not a hint) starts a new stuck episode: the pre-hint step comes back.
        if (d.activeMsSinceProgress < this.lastSinceProgress && !/^hint \d/.test(d.progressReason)) this.episodeHinted = false;
        this.lastSinceProgress = d.activeMsSinceProgress;
        this.signals = d.signals(now, this.stuckThresholdFor(t));
        if (this.signals.score >= 1) t.stuckMs += addedMs;
        void this.prefetcher.maybePrefetchHints(this.hintContext(t)).catch((err) => this.log(`[coach] hint prefetch: ${errorMessage(err)}`));
        this.maybeOfferHelp(t);
      } else {
        this.signals = undefined;
      }
    } else {
      this.signals = undefined;
    }
    if (++this.ticksSinceSave >= 6) {
      this.ticksSinceSave = 0;
      this.deps.store.save();
    }
    this.statusEmitter.fire();
    this.deps.tempo.update?.();
  }

  /** At stuck >= 1: a 'hint-ready' tempo action ('offer'), or the next rung ('auto'); never a pop-up message. */
  private maybeOfferHelp(t: FullTask): void {
    const s = this.signals;
    const rung = this.servedRungs(t) + 1;
    if (!s || s.score < 1 || rung > this.maxRung(t) || t.offeredRung >= rung) return;
    if (this.deps.jobs.has(prefetchKey(t.id)) || this.hintFlight) return; // a hint job for this task is in flight
    const mode = this.cfg().proactive;
    if (mode === 'off') return;
    t.offeredRung = rung;
    if (mode === 'auto') {
      void this.hint();
      return;
    }
    const a = t.hintPrefetch?.anchor;
    this.deps.tempo.enqueue({
      id: 'hint-ready', kind: 'hint-ready', label: a?.file ? status.hintReady(a.file, a.line) : statusText('lightbulb', 'stuck? hint ready'),
      priority: 1, blocking: false, command: 'deliberate.hint',
    });
    this.logCard('Looks like you might be stuck', [`_${s.reasons.join(', ') || 'no progress for a while'}_`, `Hint ${rung}/${this.maxRung(t)} is ready (Alt+N or Ctrl+Alt+H).`], t.feed);
    this.changed();
  }

  // ------------------------------------------------------------ view models

  /** Snapshot for the tempo bar (TempoBar state()). */
  tempoState(): { phase: string; stuckScore: number; lastEditAt: number; activeMsToday: number; sprintMsToday: number; task?: { title: string; activeMin: number; estimateMin?: number }; progressReason?: string; calibration?: number; idleText?: string } {
    const t = this.task;
    const p = this.project;
    const phase: Phase | 'idle' = t?.status === 'active' ? t.phase : p && !p.placement.done ? 'placement' : 'idle';
    const ladder = t && this.deps.specs?.taskId === t.id ? this.deps.specs.ladder() : undefined;
    const sure = this.learner.calibration?.sure ?? [0, 0];
    let idleText: string | undefined;
    if (ladder && ladder.total) idleText = status.specProgress(ladder.passed, ladder.total, ladder.next);
    else if (p?.placement.planPending && !p.placement.planError) idleText = status.preparing('designing roadmap');
    else if (t?.phase === 'building' && t.prep?.state === 'pending') idleText = status.preparing('preparing specs');
    return {
      phase, stuckScore: this.signals?.score ?? 0, lastEditAt: this.monitor.lastEditAt, activeMsToday: this.activeMsToday, sprintMsToday: this.sprintMsToday,
      ...(t ? { task: { title: t.title, activeMin: t.activeMs / 60000, estimateMin: t.estimatedMinutes } } : {}),
      progressReason: this.monitor.detector.progressReason,
      ...(sure[1] ? { calibration: sure[0] / sure[1] } : {}),
      ...(idleText ? { idleText } : {}),
    };
  }

  inputMode(): InputMode {
    const p = this.project;
    const t = this.task;
    if (!p) return { mode: 'none', placeholder: '', submitLabel: '', extras: [] };
    const ask = (mode: string, label?: string, extras: InputMode['extras'] = []): InputMode => ({
      mode, placeholder: 'Ask the coach anything…', submitLabel: 'Ask', extras, ...(label ? { label } : {}),
    });
    if (!t || t.status !== 'active') {
      if (this.placementRun) return ask('placement', 'Placement is open in the editor (Esc Esc to leave)');
      if (p.placement.planError && !p.milestones.some((m) => m.taskIds.length)) return ask('ask', undefined, [{ label: 'Retry roadmap', command: 'retryPlan' }]);
      if (p.placement.planPending) return ask('waiting', 'Your roadmap is being designed', [{ label: 'Practice while you wait', command: 'practiceWhileWaiting' }]);
      return ask('ask', undefined, [{ label: 'Sprint (3 min)', command: 'sprint' }]);
    }
    switch (t.phase) {
      case 'learning':
        return ask('atom', 'Practice is open in the editor (Esc Esc to leave)');
      case 'gate':
        return { mode: 'gate', placeholder: 'Or write your own plan: steps, data structures, APIs…', submitLabel: 'Submit plan', extras: [], label: 'Answer in the popup (or explain your own plan)' };
      case 'explain':
        return {
          mode: 'explain', placeholder: 'Your plan: steps, data structures, APIs you will use…', submitLabel: 'Submit plan',
          extras: [{ label: 'I have no idea', command: 'noIdea' }, { label: 'Build without a plan', command: 'buildNow' }],
          label: 'Your own plan is reviewed in the background; you build right away',
        };
      case 'explain-back':
        return { mode: 'explain-back', placeholder: 'Explain in your own words…', submitLabel: 'Submit', extras: [{ label: 'Skip', command: 'skipExplainBack' }] };
      default: {
        const served = this.servedRungs(t);
        const ladder = !!this.deps.specs?.applicable && this.deps.specs.taskId === t.id;
        const extras: InputMode['extras'] = [
          { label: served ? `Hint ${Math.min(served + 1, this.maxRung(t))}/${this.maxRung(t)}` : "I'm stuck", command: 'hint' },
          { label: 'Teach me', command: 'teach' },
          ladder ? { label: 'Run my specs', command: 'checkWork' } : { label: 'Check my work', command: 'checkWork' },
        ];
        return { mode: 'building', placeholder: "Ask the coach (it won't hand you the solution)…", submitLabel: 'Ask', extras };
      }
    }
  }

  statusInfo() {
    const t = this.task;
    const stats = this.deps.jobs.stats();
    const s = this.signals;
    const sprintable = !!this.sprintFor() && t?.phase !== 'building';
    return {
      busy: stats.fg,
      background: { running: stats.running, queued: stats.queued, used: stats.used, limit: stats.limit, pausedUntil: stats.pausedUntil },
      practiceWhileWaiting: sprintable && (!!stats.fg || !!this.project?.placement.planPending),
      taskTitle: t?.title,
      phase: t?.phase,
      activeMin: t ? t.activeMs / 60000 : 0,
      estimate: t?.estimatedMinutes ?? 0,
      hints: t ? this.servedRungs(t) : 0,
      stuck: s ? { score: s.score, minutes: s.minutesSinceProgress, threshold: s.thresholdMinutes, reasons: s.reasons, since: this.monitor.detector.progressReason } : undefined,
    };
  }

  /** Pace metrics from the evidence log and task timestamps (Progress tab). */
  async refreshPace(): Promise<void> {
    const p = this.project;
    if (!p) {
      this.pace = undefined;
      return;
    }
    let ev: EvidenceRecord[] = [];
    try {
      ev = (await this.deps.store.readEvidence?.(p.createdAt)) ?? [];
    } catch {
      ev = [];
    }
    const tasks = Object.values(p.tasks).map(normTask);
    const done = tasks.filter((t) => t.status === 'done');
    const bitsBy = new Map<string, number>();
    for (const e of ev) if (e.taskId) bitsBy.set(e.taskId, (bitsBy.get(e.taskId) ?? 0) + (e.bits || 0));
    const bits = done.map((t) => bitsBy.get(t.id) ?? 0).sort((a, b) => a - b);
    const served = tasks.reduce((acc, t) => ({ pre: acc.pre + (t.hintServe?.prefetched ?? 0), all: acc.all + (t.hintServe?.prefetched ?? 0) + (t.hintServe?.onDemand ?? 0) }), { pre: 0, all: 0 });
    this.pace = {
      milestones: p.milestones.map((m) => {
        const ts = m.taskIds.map((id) => p.tasks[id]).filter((t): t is Task => !!t && t.status === 'done');
        return { title: m.title, tasksDone: ts.length, activeMin: Math.round(ts.reduce((n, t) => n + t.activeMs, 0) / 60000), waitSec: Math.round(ts.reduce((n, t) => n + (t.waitMs ?? 0), 0) / 1000) };
      }),
      solo: done.filter((t) => t.solo).map((t) => ({
        title: t.title, activeMin: Math.round(t.activeMs / 60000),
        unaided: !t.revealed && !t.hints.some((h) => h.rung >= 2) && t.pastedChars + t.assistedChars < 120,
      })),
      ...(bits.length ? { bitsPerTask: Math.round(bits[Math.floor(bits.length / 2)] * 100) / 100 } : {}),
      ...(served.all ? { prefetchedHints: served.pre / served.all } : {}),
      placement: { items: ev.filter((e) => e.source === 'placement').length, summary: p.placement.summary },
      conflictFlags: done.filter((t) => t.notUnderstood).length,
      overfitFlags: done.filter((t) => t.spec?.overfit).length,
      deadlineMisses: this.deps.jobs.stats().deadlineMisses,
    };
    this.changeEmitter.fire();
  }

  viewModel() {
    const p = this.project;
    const t = this.task;
    const learner = this.learner;
    const now = this.now();
    const inProject = new Set((p?.conceptIds ?? []).map((id) => concept(learner, id)?.id ?? id));
    const conceptStates = Object.values(learner.concepts)
      .filter((c) => !p || inProject.has(c.id) || c.tested || c.attempts > 0)
      .sort((a, b) => a.mastery - b.mastery)
      .map((c) => ({
        id: c.id,
        name: c.name,
        mastery: c.mastery,
        chip: conceptChip(learner, c),
        inferred: c.inferred,
        tested: c.tested,
        attempts: c.attempts,
        hints: c.hintsUsed,
        mastered: conceptMastered(learner, c),
        avgMin: c.solveTimesMin.length ? avg(c.solveTimesMin) : null,
        trend: speedTrend(c.solveTimesMin),
        due: c.nextReview > 0 && c.nextReview <= now,
        fragile: c.fragile,
        misconceptions: Object.entries(c.misconceptions ?? {})
          .filter(([, m]) => m.status === 'active' || m.status === 'suppressed' || (m.status === 'candidate' && m.p >= 0.3))
          .map(([id, m]) => ({ id, belief: m.belief, status: m.status === 'suppressed' ? 'fixing' : m.status, p: m.p })),
      }));
    const cal = learner.calibration ?? { sure: [0, 0], guess: [0, 0] };
    const pct = (x: [number, number]) => (x[1] ? Math.round((x[0] / x[1]) * 100) : undefined);
    const sureP = pct(cal.sure);
    const guessP = pct(cal.guess);
    const ladder = t && this.deps.specs?.taskId === t.id ? this.deps.specs.ladder() : undefined;
    return {
      hasProject: !!p,
      project: p && {
        title: p.title,
        goal: p.goal,
        language: p.language,
        summary: p.summary,
        planPending: p.placement.planPending,
        planError: p.placement.planError,
        placement: { done: p.placement.done, running: !!this.placementRun, summary: p.placement.summary },
        milestones: p.milestones.map((m, k) => ({
          title: m.title,
          goal: m.goal,
          preparing: !m.taskIds.length && this.deps.jobs.has(`batch:${k}`),
          tasks: m.taskIds
            .map((id) => p.tasks[id])
            .filter(Boolean)
            .map((x) => ({ id: x.id, title: x.title, status: x.status, kind: x.kind, current: x.id === p.currentTaskId, depth: x.followUpDepth, solo: !!x.solo })),
        })),
      },
      task: t && {
        id: t.id, title: t.title, phase: t.phase, kind: t.kind, solo: t.solo, fade: t.fade,
        interface: interfaceLine(t.interface, p?.language),
        ladder: ladder ? { titles: ladder.titles, summary: ladder.summary, passed: ladder.passed, total: ladder.total, next: ladder.next, target: ladder.target?.text } : undefined,
        specsApplicable: !!this.deps.specs?.applicable && this.deps.specs.taskId === t.id,
        notUnderstood: !!t.notUnderstood,
      },
      feed: (t ? t.feed : (p?.feed ?? [])).slice(-80),
      input: this.inputMode(),
      status: this.statusInfo(),
      progress: {
        concepts: conceptStates,
        mistakes: [...learner.mistakes].sort((a, b) => b.count - a.count || b.at - a.at).slice(0, 10),
        totals: learner.totals,
        deck: (learner.patternDeck ?? []).map((c) => ({ conceptId: c.conceptId, name: c.name, kind: c.kind, useWhen: c.useWhen, template: c.template, rule: c.rule, pitfall: c.pitfall })),
        calibration: {
          sure: cal.sure, guess: cal.guess,
          text: sureP !== undefined || guessP !== undefined ? `flagged guesses right ${guessP ?? '-'}% / sure answers right ${sureP ?? '-'}%` : '',
        },
        audits: { ...learner.audits, falseMastery: learner.falseMastery?.length ?? 0 },
        pace: this.pace,
      },
    };
  }
}

// =====================================================================================
// helpers
// =====================================================================================

function rootOf(p: Project, t: Task): Task {
  let cur = t;
  const seen = new Set<string>();
  while (cur.parentId && p.tasks[cur.parentId] && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = p.tasks[cur.parentId];
  }
  return cur;
}

/** Insert a follow-up after the last task in its chain, inside the root task's milestone. */
function insertAfter(p: Project, root: Task, task: Task): void {
  p.tasks[task.id] = task;
  const m = p.milestones.find((x) => x.taskIds.includes(root.id)) ?? p.milestones[p.milestones.length - 1];
  if (!m) {
    p.milestones.push({ title: 'Follow-ups', taskIds: [task.id] });
    return;
  }
  let idx = m.taskIds.indexOf(root.id);
  while (idx + 1 < m.taskIds.length && p.tasks[m.taskIds[idx + 1]] && rootOf(p, p.tasks[m.taskIds[idx + 1]]).id === root.id) idx++;
  m.taskIds.splice(idx + 1, 0, task.id);
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Negative = getting faster. Compares the latest 3 solves with the earlier ones. */
function speedTrend(xs: number[]): number | null {
  if (xs.length < 4) return null;
  const recent = avg(xs.slice(-3));
  const earlier = avg(xs.slice(0, -3));
  return earlier > 0 ? (recent - earlier) / earlier : null;
}

// =====================================================================================
// The vscode host (thin; not exercised under node)
// =====================================================================================

const EXCLUDE_GLOB = '**/{node_modules,.git,dist,out,build,.venv,venv,__pycache__,target}/**';

export interface VscodeHostOptions {
  monitor: CodeContextMonitor;
  /** globalStorageUri.fsPath: never part of the learner's code context. */
  globalStoragePath?: string;
  /** Reveal the sidebar and focus its composer. */
  focusComposer?(mode: string): void;
  functionNames?(fsPath: string, text: string, lang: Lang): Promise<string[]>;
}

/** The real CoachHost. */
export function vscodeCoachHost(o: VscodeHostOptions): CoachHost {
  const workspaceDir = () => vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri.fsPath;
  const readText = async (fsPath: string): Promise<string | undefined> => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath.toLowerCase() === fsPath.toLowerCase());
    if (doc) return doc.getText();
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath)));
    } catch {
      return undefined;
    }
  };
  return {
    config() {
      const c = vscode.workspace.getConfiguration('deliberate');
      return {
        stuckMinutes: c.get<number>('stuckThresholdMinutes', 7),
        proactive: c.get<'offer' | 'auto' | 'off'>('proactiveHints', 'offer'),
        maxFollowUps: c.get<number>('maxFollowUps', 2),
        planEffort: c.get<'medium' | 'high'>('planEffort', 'medium'),
        polishReview: c.get<boolean>('polishReview', false),
      };
    },
    async workspaceExtensions() {
      const files = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, 400);
      const counts = new Map<string, number>();
      for (const f of files) {
        const ext = f.path.split('/').pop()?.split('.').slice(1).pop();
        if (ext && languageOfExtension(ext)) counts.set(ext.toLowerCase(), (counts.get(ext.toLowerCase()) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    },
    async pickLanguage() {
      const items = ['Python', 'JavaScript', 'TypeScript', 'Go', 'Java', 'Rust', 'Other'];
      const pick = await vscode.window.showQuickPick(items, { title: 'Which language?', placeHolder: 'The roadmap, practice and specs use this language', ignoreFocusOut: true });
      if (!pick) return undefined;
      if (pick !== 'Other') return pick.toLowerCase();
      const other = await vscode.window.showInputBox({ title: 'Which language?', prompt: 'Language name', ignoreFocusOut: true });
      return other?.trim() || undefined;
    },
    async confirm(message, action) {
      return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
    },
    windowFocused: () => vscode.window.state.focused,
    focusEditor: () => void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'),
    focusComposer: o.focusComposer,
    withProgress(title, p) {
      void vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, () => p.catch(() => undefined));
    },
    codeSnapshot: (files) => gatherCodeContext(o.monitor, files, { excludeDirs: o.globalStoragePath ? [o.globalStoragePath] : [] }),
    workspaceDir,
    uriOf: (fsPath) => vscode.Uri.file(fsPath).toString(),
    readText,
    functionNames: o.functionNames,
    async readLines(file) {
      const ws = workspaceDir();
      const abs = nodePath.isAbsolute(file) ? file : ws ? nodePath.join(ws, file) : undefined;
      if (!abs) return undefined;
      const text = await readText(abs);
      return text?.replace(/\r\n?/g, '\n').split('\n');
    },
    async fileList() {
      const files = await vscode.workspace.findFiles('**/*.{py,js,mjs,cjs,ts,tsx,jsx,go,java,rs,json,md,txt,csv}', EXCLUDE_GLOB, 60);
      return files.map((f) => vscode.workspace.asRelativePath(f)).sort().join(', ');
    },
  };
}
