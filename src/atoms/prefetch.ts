// Background prefetching (spec latencyStrategy, V1-1, V1-5, V1-7, V1-8, V1-9, V1-10, V1-11, V1-12):
// every model call the learner did not explicitly ask to wait for runs here, one step ahead, through
// the JobQueue's background lane with generation tokens.
//
// - PlanOutline (key 'plan', priority 0, medium or deliberate.planEffort, project scope)
// - TaskBatch per milestone (key 'batch:<k>', priority 1, medium, project scope)
// - TaskPrep for up to 3 tasks (key 'prep:<ids>', priority 1, medium, project scope): the gate pack and
//   the spec ladder, verified locally through SpecController.verifyLadder with one low-effort repair
//   call; the private reference is dropped right after verification and never stored
// - AtomPacks for non-seed tags and 'other' concepts (key 'pack:<lang>:<ids>', 1-2 concepts per call,
//   global scope): verifyPack plus one low-effort repair round; probeable = false on total failure
// - the foreground MINI ATOM (low) for Teach on a cache miss, then the full pack in the background
// - escalation lessons (key 'lesson:<concept>:<M>', low, priority 0), verified with verifyLesson and
//   stored in project.prefetch (an LRU of 50 entries)
// - HintLadder (key 'hint:<taskId>', kind 'hint'): medium speculative at stuck .6 (priority 2), low on
//   demand; rungs are validated after parsing ('?' rule) through hints.ts
// - OwnCodeProbe inputs (key 'probes:<taskId>', low, priority 2, rate-limited by the caller)
// - FollowUp (key 'followup:<taskId>', medium, priority 1; the coach applies the policy gate)
// - low-stock refills (seeded tags locally, others a single-concept pack at low effort, priority 3)
// Degraded paths: deadline misses are recorded (isLate) and reported to the coach, which applies them.
// No vscode import: the coach injects the LLM, the queue, the store and the workspace readers.

import type { z } from 'zod';
import type { Gen, HintPrefetch, JobPriority, Lang, Runner, StoredAtom, TaskGateState, TaskInterface, TaskSpecState } from '../contracts';
import { genMatches, isLimitError, type DeadlineMissed, type JobQueue } from '../jobs';
import { LIMIT_FLASH } from '../tempo';
import { touch } from '../evidence';
import { concept, conceptChip, conceptMastered, slug, snapshot } from '../learner';
import { HintPrefetcher, prefetchKey, type OwnProbeResult } from '../hints';
import type { ModelProbe } from '../owncode';
import {
  SYSTEM, followUpPrompt, planOutlinePrompt, specRepairPrompt, taskBatchPrompt, taskPrepPrompt, type FollowUpPromptInput,
} from '../prompts';
import {
  AtomPackSchema, EscalationLessonSchema, FollowUpSchema, HintLadderSchema, OwnCodeProbeSchema, PlanOutlineSchema, SpecLadderPartSchema,
  TaskBatchSchema, TaskPrepSchema, type AtomPack, type EscalationLesson, type FollowUp, type HintLadder, type PlanOutline, type TaskOut,
  type TaskPrep,
} from '../schemas';
import type { SpecLadderDraft, VerifyFailure, VerifyResult } from '../specsCore';
import type { ConceptState, Learner, PrefetchEntry, Project, Task } from '../types';
import type { AtomCache } from './cache';
import {
  allowedImportsFor, anyTypeSensitive, atomPackPrompt, escalationLessonPrompt, miniAtomPrompt, packConcept, repairPrompt, runtimeLabel,
  taxonomyFor, type AtomPackPromptInput,
} from './prompts';
import type { LessonText } from './render';
import { CANONICAL_TAGS, OTHER_TAG, TAXONOMY, canonicalTag, tagInfo } from './tags';
import { verifyLesson, verifyPack, type PackVariant } from './verify';

// =====================================================================================
// Constants
// =====================================================================================

/** How long the usage-limit flash stays (matches tempoBar.ts LIMIT_FLASH_MS). */
export const LIMIT_FLASH_MS = 8000;

export const PREFETCH = {
  /** project.prefetch LRU cap. */
  lruCap: 50,
  /** Concepts per AtomPack call (spec: 1-2). */
  packConcepts: 2,
  /** Tasks per TaskPrep call. */
  prepTasks: 3,
  /** A concept at or above this P gets no pack (it is close to mastered). */
  packMaxP: 0.85,
  /** Most single-concept refill packs one refillLowStock() pass may enqueue. */
  refillsPerPass: 2,
  /** Interface file text quoted in TaskPrep, per file. */
  contentChars: 6000,
  /** Model probes kept per task. */
  modelProbes: 9,
} as const;

// =====================================================================================
// Ports
// =====================================================================================

export type Effort = 'low' | 'medium' | 'high';

/** The part of src/llm.ts Llm the prefetcher and the coach use (tests inject a fake). */
export interface LlmLike {
  json<S extends z.ZodType>(
    req: { system: string; prompt: string; schema: S; effort?: Effort },
    opts?: { signal?: AbortSignal; fast?: boolean; background?: boolean },
  ): Promise<z.infer<S>>;
  /** vscode-lm: one tiny request after a user action so background calls may run. */
  ensureBackgroundConsent?(): Promise<boolean>;
}

/** Seed stock per language (src/atoms/stock.ts Stock satisfies it). */
export interface SeedSource {
  hasSeeds(tag: string): boolean;
  /** Local background refill of a seeded key (no model call); undefined when nothing to do. */
  refillIfLow(key: string): Promise<void> | undefined;
}

/** SpecController.verifyLadder (src/specs.ts). */
export interface SpecVerifier {
  verifyLadder(
    draft: SpecLadderDraft,
    iface: TaskInterface,
    o: { runner: Runner | undefined; allowRun: boolean; repair?: (failures: VerifyFailure[], signal?: AbortSignal) => Promise<SpecLadderDraft | undefined>; signal?: AbortSignal },
  ): Promise<VerifyResult>;
}

/** Workspace reads for prompts (vscode in the extension, a fake in tests). */
export interface WorkspaceInfo {
  /** Short listing of the workspace's source files ('' when the workspace is empty). */
  fileList(): Promise<string>;
  /** Current text of a workspace-relative file (open buffer first), or undefined. */
  read(relPath: string): Promise<string | undefined>;
}

export interface PrefetchDeps {
  jobs: JobQueue;
  llm: LlmLike;
  /** The coach's current generation token. */
  gen(): Gen;
  project(): Project | undefined;
  learner(): Learner;
  /** The runner for a language, already gated by execution consent and workspace trust. */
  runner(lang: Lang): Runner | undefined;
  /** Consent 'all' and a trusted workspace: spec ladders and own-code probes may run learner code. */
  allowRun(): boolean;
  cache(lang: Lang): AtomCache | undefined;
  seeds?(lang: Lang): SeedSource | undefined;
  specs?: SpecVerifier;
  workspace?: WorkspaceInfo;
  /** deliberate.planEffort (default medium). */
  planEffort?(): 'medium' | 'high';
  /** withProgress(ProgressLocation.Window, title) around a promise (the roadmap call). */
  progress?(title: string, p: Promise<unknown>): void;
  /** State changed in the background (persist and re-render). */
  onChange?(): void;
  /** A needed-next job missed its neededBy: the coach applies the degraded path for that key. */
  onLate?(e: DeadlineMissed): void;
  /**
   * Status flash for the usage-limit pause ('Plan limit: background prep paused 15 min'). Leave it unset
   * when the TempoBar is wired with the JobQueue: it flashes LIMIT_FLASH on onDidPause itself.
   */
  flash?(text: string, ms: number): void;
  /** Output channel (errors, drops). */
  log?(line: string): void;
  /** 'Deliberate: content' channel (verification problems). */
  contentLog?(line: string): void;
  now?(): number;
}

// =====================================================================================
// Pure helpers (exported for tests)
// =====================================================================================

/**
 * The AtomCache key a model pack for this concept is stored under, as Stock.cacheKeyFor resolves it:
 * the tag when the concept owns it (the seed concept, or the only concept carrying that tag), else
 * the concept id (several project concepts on one tag, and 'other').
 */
export function packKey(learner: Learner, c: ConceptState): string {
  const tag = c.tag && c.tag !== OTHER_TAG && tagInfo(c.tag) ? c.tag : undefined;
  if (!tag) return c.id;
  const tagged = Object.values(learner.concepts).filter((x) => x.tag === tag);
  const owner = learner.concepts[tag] ?? (tagged.length === 1 ? tagged[0] : undefined);
  return owner === c ? tag : c.id;
}

/** Constructs (as pattern names) the learner already knows, for the ATOMPACK prompt. */
export function knownConstructs(learner: Learner, lang: Lang): string[] {
  const base = ['variables', 'print', 'arithmetic', 'string and number literals'];
  const known = Object.values(learner.concepts)
    .filter((c) => c.tag && c.mastery >= 0.5 && TAXONOMY[c.tag]?.langs.includes(lang))
    .map((c) => TAXONOMY[c.tag!].patternName);
  return [...new Set([...base, ...known])];
}

/** Insert or refresh an entry; evict least-recently-used entries past the cap. */
export function lruPut(store: Record<string, PrefetchEntry>, key: string, entry: PrefetchEntry, cap: number = PREFETCH.lruCap): void {
  delete store[key];
  store[key] = entry;
  const keys = Object.keys(store);
  if (keys.length <= cap) return;
  keys
    .sort((a, b) => store[a].at - store[b].at)
    .slice(0, keys.length - cap)
    .forEach((k) => delete store[k]);
}

const normTitle = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** TaskPrep results matched to tasks by title (exact, then normalised), else by position. */
export function matchPrep<T extends { title: string }>(tasks: readonly T[], prep: TaskPrep): Map<T, TaskPrep['tasks'][number]> {
  const out = new Map<T, TaskPrep['tasks'][number]>();
  const items = [...(prep.tasks ?? [])];
  const used = new Set<number>();
  for (const t of tasks) {
    let i = items.findIndex((x, k) => !used.has(k) && x.taskTitle === t.title);
    if (i < 0) i = items.findIndex((x, k) => !used.has(k) && normTitle(x.taskTitle) === normTitle(t.title));
    if (i >= 0) {
      used.add(i);
      out.set(t, items[i]);
    }
  }
  tasks.forEach((t, k) => {
    if (out.has(t) || used.has(k) || !items[k]) return;
    used.add(k);
    out.set(t, items[k]);
  });
  return out;
}

/** A gate pack with concept ids resolved through aliases (the GateUi checks its shape). */
export function sanitizeGate(learner: Learner, g: TaskPrep['tasks'][number]['gate'] | undefined): TaskGateState | undefined {
  if (!g || !Array.isArray(g.patterns) || !g.patterns.length) return undefined;
  const id = (raw: string) => (raw?.trim() ? (concept(learner, raw)?.id ?? slug(raw)) : '');
  return {
    patterns: g.patterns.map((p) => ({
      name: String(p.name ?? '').trim(), conceptId: id(p.conceptId), required: !!p.required, competesWith: id(p.competesWith),
      useWhen: String(p.useWhen ?? '').trim(), whyNot: String(p.whyNot ?? '').trim(),
    })),
    plans: (g.plans ?? []).map((p) => ({
      text: String(p.text ?? '').trim(), workable: !!p.workable, flawConceptId: id(p.flawConceptId),
      misconceptionId: String(p.misconceptionId ?? '').trim(), whyFlawed: String(p.whyFlawed ?? '').trim(),
    })),
  };
}

/** A verified ladder as Task.spec (empty run state). */
export function specState(v: VerifyResult): TaskSpecState {
  const s: TaskSpecState = {
    specs: v.specs, hidden: v.hidden, greenAt: {}, firstRedAt: {}, savesSinceRed: {}, runs: 0, verified: v.verified, applicable: v.applicable,
  };
  if (v.importMs !== undefined) s.importMs = v.importMs;
  if (v.reason) s.reason = v.reason;
  return s;
}

function errorText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error';
}

// =====================================================================================
// Results
// =====================================================================================

export type PlanOutcome = { ok: true; outline: PlanOutline } | { ok: false; reason: string; stale: boolean };

/** One task's TaskPrep result after local verification (the reference is already gone). */
export interface PreparedTask {
  taskId: string;
  gate?: TaskGateState;
  spec?: TaskSpecState;
  /** Why there is no usable ladder (not applicable, no runtime, verification). */
  reason?: string;
  /** The ladder applies but could not be verified (no runner, consent or trust yet): prepare again later. */
  noRunner?: boolean;
}

/** TaskPrep's reason when the ladder could not be verified for want of a runner, consent or trust. */
export const NO_RUNNER_REASON = 'no local runtime (or no consent) for behaviour specs yet';

export interface LessonRequestLike {
  key: string;
  conceptId: string;
  misconceptionId: string;
  belief: string;
  items: { code: string; answer: string; actual: string }[];
}

/** What the coach gives the hint jobs (the prompt needs signals and a fresh code snapshot). */
export interface HintContext {
  task: Task;
  score: number;
  /** deliberate.proactiveHints */
  mode: string;
  /** Task file uris for the content hash. */
  files: string[];
  taskFileHash(files: readonly string[]): Promise<string>;
  mark(): number;
  errorSetHash(): string;
  changedLinesSince(mark: number): number;
  /** Current lines of a workspace-relative file (anchor re-resolution). */
  readLines(file: string): Promise<string[] | undefined>;
  /** hintLadderPrompt() with a fresh snapshot. */
  prompt(speculative: boolean, ownProbe?: OwnProbeResult): Promise<string>;
}

/** The foreground lane, as the coach runs it (busy label, wait accounting, sprint filling). */
export type ForegroundRun = <T>(label: string, run: (signal: AbortSignal) => Promise<T>) => Promise<T>;

// =====================================================================================
// Prefetcher
// =====================================================================================

export class Prefetcher {
  /** Speculative hint bookkeeping (stale rules, the 2-unused cap, in-flight). */
  readonly hints = new HintPrefetcher();
  private readonly packs = new Map<string, Promise<void>>();
  private readonly prepTasks = new Map<string, string>();
  private readonly late = new Set<string>();
  private readonly hintChecks = new Set<string>();
  /** Speculative hint jobs in flight, with the generation they were enqueued under. */
  private readonly hintJobs = new Map<string, { gen: Gen; job: Promise<unknown> }>();
  private readonly subs: { dispose(): void }[] = [];

  constructor(readonly deps: PrefetchDeps) {
    this.subs.push(
      deps.jobs.onDeadlineMissed((e) => {
        this.late.add(e.key);
        this.log(`[prefetch] ${e.label} (${e.key}) missed its deadline (${e.state}${e.waitingFor ? `, waiting for ${e.waitingFor}` : ''})`);
        try {
          deps.onLate?.(e);
        } catch (err) {
          this.log(`[prefetch] degraded path for ${e.key} failed: ${errorText(err)}`);
        }
      }),
      deps.jobs.onDidPause((e) => {
        if (e.reason !== 'limit') return;
        this.log(`[prefetch] usage limit: background prep paused until ${new Date(e.until).toLocaleTimeString()}${e.halved ? ' (hourly budget halved)' : ''}`);
        deps.flash?.(LIMIT_FLASH, LIMIT_FLASH_MS);
      }),
      deps.jobs.onDidSettle((s) => {
        if (s.outcome === 'done' || s.outcome === 'canceled' || s.outcome === 'stale') this.late.delete(s.key);
        if (s.outcome === 'dropped') this.log(`[prefetch] ${s.label} dropped (${s.reason ?? 'budget'})`);
      }),
    );
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs.length = 0;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }

  private changed(): void {
    this.deps.onChange?.();
  }

  /** A needed-next job with this key missed its neededBy and has not settled. */
  isLate(key: string): boolean {
    return this.late.has(key);
  }

  /** Forget per-project state (new project, profile reset). */
  reset(): void {
    this.hints.reset();
    this.late.clear();
    this.prepTasks.clear();
  }

  // ------------------------------------------------------------ project.prefetch (LRU 50)

  /** Store a prefetched value in project.prefetch (LRU 50). */
  put(key: string, value: unknown, taskId?: string, contentHash?: string): void {
    const p = this.deps.project();
    if (!p) return;
    p.prefetch ??= {};
    const entry: PrefetchEntry = { at: this.now(), value };
    if (taskId) entry.taskId = taskId;
    if (contentHash) entry.contentHash = contentHash;
    lruPut(p.prefetch, key, entry);
  }

  /** A stored value (refreshes its LRU position), or undefined. */
  get<T>(key: string): T | undefined {
    const p = this.deps.project();
    const e = p?.prefetch?.[key];
    if (!e) return undefined;
    e.at = this.now();
    return e.value as T;
  }

  // ------------------------------------------------------------ PlanOutline

  /**
   * PlanOutline in the background (key 'plan', priority 0). `apply` runs only when the project is
   * unchanged. `onTrouble` hears about a usage-limit error at once (the queue retries needed work
   * once after its 15-minute pause), so the coach can show 'Roadmap failed' with Retry meanwhile.
   */
  async planOutline(
    input: { goal: string; background: string; lang: string; runtime: string },
    apply: (outline: PlanOutline) => void,
    onTrouble?: (reason: string) => void,
  ): Promise<PlanOutcome> {
    const gen = this.deps.gen();
    const learner = this.deps.learner();
    let failure: string | undefined;
    const seedIds = Object.values(learner.concepts)
      .filter((c) => c.tag && c.tag !== OTHER_TAG)
      .map((c) => `${c.id} (tag ${c.tag})`);
    const workspaceFiles = (await this.deps.workspace?.fileList().catch(() => '')) ?? '';
    const prompt = planOutlinePrompt({
      lang: input.lang, runtimeVersion: input.runtime, goal: input.goal, background: input.background, snapshot: snapshot(learner),
      canonicalTags: CANONICAL_TAGS.filter((t) => t !== OTHER_TAG), seedIdsWithTags: seedIds, workspaceFiles,
    });
    const effort = this.deps.planEffort?.() ?? 'medium';
    // A cancelled plan (shutdown, new project, profile reset) is not a failure: whoever cancelled it
    // re-enqueues it, so it must not leave a 'Roadmap failed' card (which shutdown would persist).
    let canceled = false;
    const sub = this.deps.jobs.onDidSettle((s) => {
      if (s.key === 'plan' && s.outcome === 'canceled' && s.reason !== 'superseded') canceled = true;
    });
    const job = this.deps.jobs.bg<PlanOutline>(
      {
        key: 'plan', priority: 0, effort, label: 'Designing your roadmap', scope: 'project', gen,
        run: async (signal) => {
          try {
            return await this.deps.llm.json({ system: SYSTEM, prompt, schema: PlanOutlineSchema, effort }, { signal, fast: false, background: true });
          } catch (err) {
            failure = isLimitError(err) ? 'usage limit reached (background prep is paused; it retries after the pause)' : errorText(err);
            if (isLimitError(err)) onTrouble?.(failure);
            throw err;
          }
        },
      },
      (outline) => apply(outline),
    );
    this.deps.progress?.('Deliberate: designing roadmap', job);
    const outline = await job.finally(() => sub.dispose());
    if (outline) return { ok: true, outline };
    const stale = canceled || !genMatches(gen, this.deps.gen(), 'project');
    return { ok: false, reason: failure ?? 'the roadmap call was cancelled or dropped', stale };
  }

  // ------------------------------------------------------------ TaskBatch

  /**
   * TaskBatch for milestone index `k` (0-based; key 'batch:<k>', priority 1, medium). Fired when
   * milestone k-1 starts. `apply` gets the tasks when the project is unchanged.
   */
  taskBatch(k: number, input: { lang: string; runtime: string; fade: Task['fade']; neededBy?: number }, apply: (tasks: TaskOut[]) => void): Promise<TaskOut[] | undefined> {
    const key = `batch:${k}`;
    const p = this.deps.project();
    const m = p?.milestones[k];
    if (!p || !m) return Promise.resolve(undefined);
    const learner = this.deps.learner();
    const gen = this.deps.gen();
    return this.deps.jobs.bg<TaskOut[]>(
      {
        key, priority: 1, effort: 'medium', label: `Preparing milestone ${k + 1}`, scope: 'project', gen, neededBy: input.neededBy,
        run: async (signal) => {
          const tasks = Object.values(p.tasks);
          const prompt = taskBatchPrompt({
            lang: input.lang, runtimeVersion: input.runtime, goal: p.goal, projectSummary: p.summary || p.goal,
            milestoneNumber: k + 1, milestone: `${m.title}${m.goal ? ` - ${m.goal}` : ''}`,
            concepts: p.conceptIds.map((id) => {
              const c = concept(learner, id);
              return c ? `${c.id} (${c.tag ?? OTHER_TAG}, ${c.name})` : id;
            }),
            snapshot: snapshot(learner, p.conceptIds), codeSoFar: await this.codeSoFar(p), fade: input.fade ?? 'full',
            doneTitles: tasks.map((t) => t.title),
          });
          const out = await this.deps.llm.json({ system: SYSTEM, prompt, schema: TaskBatchSchema, effort: 'medium' }, { signal, fast: false, background: true });
          return out.tasks;
        },
      },
      (tasks) => apply(tasks),
    );
  }

  /** 'cli.py: parse_args(argv) -> dict; ...' from the interfaces of earlier tasks, plus the file list. */
  private async codeSoFar(p: Project): Promise<string> {
    const byFile = new Map<string, string[]>();
    for (const t of Object.values(p.tasks)) {
      const f = t.interface?.file;
      if (!f) continue;
      const sigs = byFile.get(f) ?? [];
      for (const fn of t.interface!.functions ?? []) if (!sigs.includes(fn.signature || fn.name)) sigs.push(fn.signature || fn.name);
      byFile.set(f, sigs);
    }
    const lines = [...byFile].map(([f, sigs]) => `${f}: ${sigs.join('; ')}`);
    const list = (await this.deps.workspace?.fileList().catch(() => '')) ?? '';
    return [lines.join(' | '), list ? `files: ${list}` : ''].filter(Boolean).join('. ');
  }

  // ------------------------------------------------------------ TaskPrep

  /** A TaskPrep covering this task is queued or running. */
  prepInFlight(taskId: string): boolean {
    const key = this.prepTasks.get(taskId);
    return !!key && this.deps.jobs.has(key);
  }

  /**
   * TaskPrep for up to 3 tasks in one call (priority 1, medium, project scope): the gate pack and the
   * spec ladder, each ladder verified locally (reference + stub, one low-effort repair call) before
   * `apply` sees it. Tasks with a prep in flight are skipped. Resolves to the prepared tasks, or
   * undefined when nothing was asked or the job failed.
   */
  taskPrep(
    tasks: readonly Task[],
    input: { lang: string; runtime: string; runLang?: Lang; neededBy?: number },
    apply: (prepared: PreparedTask[]) => void,
  ): Promise<PreparedTask[] | undefined> {
    const todo = tasks.filter((t) => !this.prepInFlight(t.id) && t.interface?.file).slice(0, PREFETCH.prepTasks);
    if (!todo.length) return Promise.resolve(undefined);
    const key = `prep:${todo.map((t) => t.id).join('+')}`;
    for (const t of todo) {
      this.prepTasks.set(t.id, key);
      t.prep = { state: 'pending', at: this.now() };
    }
    const gen = this.deps.gen();
    const learner = this.deps.learner();
    const job = this.deps.jobs.bg<PreparedTask[]>(
      {
        key, priority: 1, effort: 'medium', label: `Preparing task${todo.length > 1 ? 's' : ''} ${todo.map((t) => `'${t.title}'`).join(', ')}`,
        scope: 'project', gen, neededBy: input.neededBy,
        run: async (signal) => {
          const prompt = await this.prepPrompt(todo, input, learner);
          const prep = await this.deps.llm.json({ system: SYSTEM, prompt, schema: TaskPrepSchema, effort: 'medium' }, { signal, fast: false, background: true });
          return this.verifyPrep(todo, prep, input, learner, signal);
        },
      },
      (prepared) => {
        for (const p of prepared) {
          const t = todo.find((x) => x.id === p.taskId);
          if (t) t.prep = { state: 'done', at: this.now(), ...(p.reason ? { reason: p.reason } : {}) };
        }
        apply(prepared);
        this.changed();
      },
    );
    void job.then((r) => {
      for (const t of todo) {
        if (this.prepTasks.get(t.id) === key) this.prepTasks.delete(t.id);
        if (!r && t.prep?.state === 'pending') t.prep = { state: 'failed', at: this.now(), reason: 'the TaskPrep call failed or was dropped' };
      }
    });
    return job;
  }

  private async prepPrompt(tasks: readonly Task[], input: { lang: string; runtime: string; runLang?: Lang }, learner: Learner): Promise<string> {
    const p = this.deps.project();
    const ids = [...new Set([...tasks.flatMap((t) => t.conceptIds), ...(p?.conceptIds ?? [])])];
    const patternNames = ids
      .map((id) => concept(learner, id))
      .filter((c): c is ConceptState => !!c && !!c.tag && !!TAXONOMY[c.tag])
      .map((c) => `${TAXONOMY[c.tag!].patternName} (${c.id})`);
    // The tasks' known misconceptions, so plan flaws and failure signatures reuse the ids the atom
    // mutants confirm (live, without this list: 'string-method-mutates-input' next to the taxonomy's
    // 'string-method-mutates', which then never meet).
    const taskTags = tasks.flatMap((t) => t.conceptIds).map((id) => concept(learner, id)?.tag).filter((t): t is string => !!t && !!tagInfo(t));
    const misconceptions = input.runLang ? taxonomyFor(taskTags, input.runLang).map((m) => `${m.tag}: ${m.id} (${m.belief})`) : [];
    const files = [...new Set(tasks.map((t) => t.interface!.file))];
    const contents: string[] = [];
    for (const f of files) {
      const text = await this.deps.workspace?.read(f).catch(() => undefined);
      if (text === undefined) continue;
      const clipped = text.length > PREFETCH.contentChars ? `${text.slice(0, PREFETCH.contentChars)}\n[... cut]` : text;
      contents.push(`${f}:\n\`\`\`\n${clipped}\n\`\`\``);
    }
    return taskPrepPrompt({
      lang: input.lang, runtimeVersion: input.runtime,
      tasks: tasks.map((t) => ({ title: t.title, description: t.description, acceptanceCriteria: t.acceptanceCriteria, conceptIds: t.conceptIds, interface: t.interface! })),
      patternNames: [...new Set(patternNames)], misconceptions, snapshot: snapshot(learner, ids), fileList: (await this.deps.workspace?.fileList().catch(() => '')) ?? '',
      contents: contents.join('\n'),
    });
  }

  /** Match the model's tasks, resolve ids, verify each ladder locally; the reference never leaves this function. */
  private async verifyPrep(tasks: readonly Task[], prep: TaskPrep, input: { runLang?: Lang }, learner: Learner, signal: AbortSignal): Promise<PreparedTask[]> {
    const matched = matchPrep(tasks, prep);
    const out: PreparedTask[] = [];
    for (const t of tasks) {
      signal.throwIfAborted();
      const item = matched.get(t);
      const r: PreparedTask = { taskId: t.id };
      if (!item) {
        r.reason = 'TaskPrep returned nothing for this task';
        out.push(r);
        continue;
      }
      r.gate = sanitizeGate(learner, item.gate);
      const draft = this.draftOf(item.specs, learner);
      if (!draft.applicable) r.reason = draft.reason || 'the spec ladder does not apply to this task';
      else if (!input.runLang || !this.deps.specs) r.reason = NO_RUNNER_REASON;
      else {
        const runner = this.deps.runner(input.runLang);
        const allowRun = this.deps.allowRun();
        if (!runner || !allowRun) {
          // Nothing can be verified yet: no ladder is stored, so granting consent or trust (or a
          // runtime turning up) prepares the task again (Coach.setAllowRun).
          r.reason = NO_RUNNER_REASON;
          r.noRunner = true;
        } else {
          try {
            const v = await this.deps.specs.verifyLadder(draft, t.interface!, {
              runner, allowRun, signal,
              repair: (failures, sig) => this.repairLadder(failures, draft, sig ?? signal),
            });
            r.spec = specState(v);
            if (!v.applicable) r.reason = v.reason ?? 'the ladder did not survive verification';
            for (const d of v.dropped) this.deps.contentLog?.(`spec ${t.title}: dropped ${d.id}: ${d.reason}`);
          } catch (err) {
            // A usage limit fails the whole job, so the queue pauses and retries it.
            if (signal.aborted || isLimitError(err)) throw err;
            r.reason = `spec verification failed: ${errorText(err)}`;
            this.log(`[prefetch] ${r.reason}`);
          }
        }
      }
      // The private reference stays inside this function: drop it now.
      draft.reference = '';
      out.push(r);
    }
    return out;
  }

  private draftOf(part: TaskPrep['tasks'][number]['specs'] | undefined, learner: Learner): SpecLadderDraft {
    const id = (raw: string) => (raw?.trim() ? (concept(learner, raw)?.id ?? slug(raw)) : '');
    const fix = (s: SpecLadderDraft['specs'][number]) => ({ ...s, conceptId: id(s.conceptId) });
    return {
      applicable: !!part?.applicable,
      reason: part?.reason ?? '',
      specs: (part?.specs ?? []).map(fix),
      hidden: (part?.hidden ?? []).map(fix),
      reference: part?.reference ?? '',
    };
  }

  /** The one low-effort repair call (inside the TaskPrep job: a nested bg job could deadlock the lane). */
  private async repairLadder(failures: VerifyFailure[], draft: SpecLadderDraft, signal?: AbortSignal): Promise<SpecLadderDraft | undefined> {
    // A nested call: charged to the hourly budget like a job (skipped when the share is spent).
    if (!this.deps.jobs.charge()) {
      this.log('[prefetch] spec repair skipped: the hourly background budget is spent');
      return undefined;
    }
    const fixed = await this.deps.llm.json(
      { system: SYSTEM, prompt: specRepairPrompt(failures, { specs: draft.specs, hidden: draft.hidden }), schema: SpecLadderPartSchema, effort: 'low' },
      { signal, fast: false, background: true },
    );
    return this.draftOf(fixed, this.deps.learner());
  }

  // ------------------------------------------------------------ AtomPacks

  /** A pack (or mini atom) for this concept is in flight. */
  packInFlight(lang: Lang, conceptId: string): Promise<void> | undefined {
    const c = concept(this.deps.learner(), conceptId);
    return this.packs.get(`${lang}:${c?.id ?? conceptId}`);
  }

  /** Concepts that need a model pack: no seed template for their tag, nothing cached, probeable, P < .85. */
  packCandidates(lang: Lang, ids: readonly string[]): ConceptState[] {
    const learner = this.deps.learner();
    const cache = this.deps.cache(lang);
    const seeds = this.deps.seeds?.(lang);
    const out: ConceptState[] = [];
    for (const raw of ids) {
      const c = concept(learner, raw);
      if (!c || out.includes(c) || c.id === 'decomposition') continue;
      const tag = c.tag && tagInfo(c.tag) ? c.tag : OTHER_TAG;
      if (tag !== OTHER_TAG && !TAXONOMY[tag]?.langs.includes(lang)) continue;
      // Seeds serve only the concept that owns the tag; separate plan concepts on a seeded tag
      // (Stock.cacheKeyFor gives them nothing) get their own pack under their id.
      if (tag !== OTHER_TAG && seeds?.hasSeeds(tag) && packKey(learner, c) === tag) continue;
      if (c.probeable === false || c.mastery >= PREFETCH.packMaxP || conceptMastered(learner, c)) continue;
      if (cache?.has(packKey(learner, c)) || this.packs.has(`${lang}:${c.id}`)) continue;
      out.push(c);
    }
    return out;
  }

  /**
   * Seeded concepts get a local refill (no model call); the rest get model AtomPacks, 1-2 concepts per
   * call. Returns the pack promises (each resolves when its atoms are cached or it failed).
   */
  prepareConcepts(lang: Lang, ids: readonly string[], o: { priority: JobPriority; effort?: Effort; label?: string } = { priority: 1 }): Promise<void>[] {
    const learner = this.deps.learner();
    const seeds = this.deps.seeds?.(lang);
    for (const raw of ids) {
      const c = concept(learner, raw);
      const tag = c?.tag;
      if (tag && tag !== OTHER_TAG && seeds?.hasSeeds(tag)) void seeds.refillIfLow(tag)?.catch(() => undefined);
    }
    const need = this.packCandidates(lang, ids);
    const out: Promise<void>[] = [];
    for (let i = 0; i < need.length; i += PREFETCH.packConcepts) out.push(this.pack(lang, need.slice(i, i + PREFETCH.packConcepts), o));
    return out;
  }

  private pack(lang: Lang, cs: ConceptState[], o: { priority: JobPriority; effort?: Effort; label?: string }): Promise<void> {
    const ids = cs.map((c) => c.id);
    const key = `pack:${lang}:${ids.join('+')}`;
    const effort = o.effort ?? 'medium';
    const job = this.deps.jobs
      .bg<void>({
        key, priority: o.priority, effort, label: o.label ?? `Preparing practice: ${cs.map((c) => c.name).join(', ')}`, scope: 'global', gen: this.deps.gen(),
        run: async (signal) => void (await this.buildPack(lang, cs, 'full', effort, signal)),
      })
      .then(() => undefined)
      .finally(() => {
        for (const id of ids) if (this.packs.get(`${lang}:${id}`) === job) this.packs.delete(`${lang}:${id}`);
      });
    for (const id of ids) this.packs.set(`${lang}:${id}`, job);
    return job;
  }

  /** Prompt input for ATOMPACK and its variants. */
  private packInput(lang: Lang, cs: readonly ConceptState[], runner: Runner | undefined): AtomPackPromptInput {
    const learner = this.deps.learner();
    const p = this.deps.project();
    const tags = cs.map((c) => (c.tag && tagInfo(c.tag) ? c.tag : OTHER_TAG));
    return {
      runtime: runner ? runtimeLabel(runner.runtime) : `${lang} (not run locally)`,
      lang,
      concepts: cs.map((c, i) => packConcept(c.id, tags[i], c.description || c.name, c.name)),
      taxonomy: taxonomyFor(tags.filter((t) => t !== OTHER_TAG), lang),
      allowedConstructs: knownConstructs(learner, lang),
      allowedImports: allowedImportsFor(lang, tags),
      snapshot: snapshot(learner, cs.map((c) => c.id)),
      projectSummary: p?.summary || p?.goal || '',
      taskTitles: Object.values(p?.tasks ?? {}).map((t) => t.title),
      typeSensitive: anyTypeSensitive(tags),
    };
  }

  /**
   * Generate, verify (one repair round) and cache atoms for these concepts (spec V1-5 PACK FLOW).
   * Concepts with no accepted atom after both rounds become probeable = false (full packs only).
   * Returns the atoms put in the cache.
   */
  private async buildPack(lang: Lang, cs: ConceptState[], variant: PackVariant, effort: Effort, signal: AbortSignal, fg = false): Promise<StoredAtom[]> {
    const learner = this.deps.learner();
    const runner = this.deps.runner(lang);
    const cache = this.deps.cache(lang);
    const input = this.packInput(lang, cs, runner);
    const prompt = variant === 'mini' ? miniAtomPrompt(input) : atomPackPrompt(input);
    const opts = fg ? { signal } : { signal, fast: false, background: true };
    const pack = await this.deps.llm.json({ system: SYSTEM, prompt, schema: AtomPackSchema, effort }, opts);
    const ctx = {
      variant, signal, now: this.now(),
      concepts: cs.map((c) => ({ id: c.id, tag: c.tag && tagInfo(c.tag) ? c.tag : OTHER_TAG })),
      keyFor: (conceptId: string) => {
        const c = concept(learner, conceptId);
        return c ? packKey(learner, c) : conceptId;
      },
    };
    let r = await verifyPack(pack, runner ?? null, lang, ctx);
    const accepted = new Map<string, StoredAtom>();
    const take = (res: typeof r) => {
      for (const v of res.results) if (v.atom) accepted.set(v.conceptId, v.atom);
    };
    take(r);
    // probeable = false needs a verdict from the last round: the first one when it asked for no
    // repair, else the repair round. A repair call that failed or was skipped decides nothing.
    let decided = !r.needsRepair;
    if (r.needsRepair && !(fg && accepted.size)) {
      // A nested background call is charged to the hourly budget (fg calls are not budgeted).
      if (!fg && !this.deps.jobs.charge()) {
        this.log('[prefetch] pack repair skipped: the hourly background budget is spent');
      } else {
        try {
          const fixed: AtomPack = await this.deps.llm.json(
            { system: SYSTEM, prompt: repairPrompt(input.runtime, r.repairs, pack), schema: AtomPackSchema, effort: 'low' },
            opts,
          );
          r = await verifyPack(fixed, runner ?? null, lang, ctx);
          take(r);
          decided = true;
        } catch (err) {
          // A usage limit fails the job: the queue pauses (and retries needed work), nothing is marked.
          if (signal.aborted || isLimitError(err)) throw err;
          this.log(`[prefetch] pack repair failed: ${errorText(err)}`);
        }
      }
    }
    for (const line of r.log) this.deps.contentLog?.(`pack ${lang}: ${line}`);
    const stored: StoredAtom[] = [];
    for (const atom of accepted.values()) {
      if (atom.lang !== lang) continue;
      cache?.put(atom);
      stored.push(atom);
    }
    if (variant === 'full' && decided) {
      const now = this.now();
      for (const c of cs) {
        if (accepted.has(c.id)) continue;
        c.probeable = false;
        touch(c, now);
        this.deps.contentLog?.(`pack ${lang}: ${c.id} failed verification twice: probeable = false (which-pattern and lessons only)`);
      }
    }
    this.changed();
    return stored;
  }

  /**
   * MINI ATOM (foreground, low effort, about 20-30 s with verification): pattern, 2 probes and the
   * completion. Run it through the coach's foreground lane (fgWithSprint). The full pack is queued in
   * the background afterwards (priority 3). Resolves to the cached atom, or undefined.
   */
  async miniAtom(lang: Lang, conceptId: string, signal: AbortSignal): Promise<StoredAtom | undefined> {
    const learner = this.deps.learner();
    const c = concept(learner, conceptId);
    if (!c) return undefined;
    const key = `${lang}:${c.id}`;
    let done!: () => void;
    const marker = new Promise<void>((r) => (done = r));
    this.packs.set(key, marker);
    try {
      const atoms = await this.buildPack(lang, [c], 'mini', 'low', signal, true);
      return atoms.find((a) => a.conceptId === c.id) ?? atoms[0];
    } finally {
      done();
      if (this.packs.get(key) === marker) this.packs.delete(key);
      // The full pack for variety later (refill-class work).
      if (!signal.aborted && c.probeable !== false) {
        void this.pack(lang, [c], { priority: 3, effort: 'medium', label: `Preparing more practice: ${c.name}` }).catch(() => undefined);
      }
    }
  }

  /**
   * Low stock (fewer than 3 unseen probes) for a due, fragile, Fixing or misconception concept:
   * seeded tags refill locally; other tags get a single-concept pack (low effort, priority 3).
   */
  refillLowStock(lang: Lang): number {
    const learner = this.deps.learner();
    const cache = this.deps.cache(lang);
    const seeds = this.deps.seeds?.(lang);
    const now = this.now();
    let packs = 0;
    for (const c of Object.values(learner.concepts)) {
      const chip = conceptChip(learner, c);
      const wants = (c.nextReview > 0 && c.nextReview <= now) || c.fragile || chip === 'Fixing' || chip === 'Misconception'
        || Object.values(c.misconceptions ?? {}).some((m) => m.status === 'active' || m.status === 'suppressed');
      if (!wants) continue;
      const tag = c.tag && tagInfo(c.tag) ? c.tag : OTHER_TAG;
      const key = packKey(learner, c);
      if (tag !== OTHER_TAG && seeds?.hasSeeds(tag) && key === tag) {
        void seeds.refillIfLow(tag)?.catch(() => undefined);
        continue;
      }
      if (!cache?.has(key) || !cache.lowStock(key) || c.probeable === false || this.packs.has(`${lang}:${c.id}`)) continue;
      if (packs >= PREFETCH.refillsPerPass) break;
      packs++;
      void this.pack(lang, [c], { priority: 3, effort: 'low', label: `Refilling practice: ${c.name}` }).catch(() => undefined);
    }
    return packs;
  }

  // ------------------------------------------------------------ escalation lessons

  /**
   * The escalation lesson for a confirmed belief (low effort, priority 0): from project.prefetch at
   * once, else a background job that runs the lesson's example (verifyLesson) and stores the result.
   * Never rejects; undefined when the job fails or is dropped.
   */
  lesson(req: LessonRequestLike, lang: Lang | undefined, projectBrief: string): LessonText | Promise<LessonText | undefined> {
    const hit = this.get<LessonText>(req.key);
    if (hit) return hit;
    const learner = this.deps.learner();
    const c = concept(learner, req.conceptId);
    return this.deps.jobs
      .bg<LessonText>(
        {
          key: req.key, priority: 0, effort: 'low', label: 'Preparing a short lesson', scope: 'project', gen: this.deps.gen(),
          run: async (signal) => {
            const lesson: EscalationLesson = await this.deps.llm.json(
              {
                system: SYSTEM,
                prompt: escalationLessonPrompt({
                  projectBrief, concept: { id: c?.id ?? req.conceptId, name: c?.name ?? req.conceptId, description: c?.description ?? '' },
                  belief: req.belief, misconceptionId: req.misconceptionId, items: req.items,
                }),
                schema: EscalationLessonSchema,
                effort: 'low',
              },
              { signal, fast: false, background: true },
            );
            const v = await verifyLesson(lesson, lang ? (this.deps.runner(lang) ?? null) : null, { signal });
            for (const line of v.log) this.deps.contentLog?.(`lesson ${req.key}: ${line}`);
            return v.lesson;
          },
        },
        (lesson) => this.put(req.key, lesson),
      )
      .catch(() => undefined);
  }

  // ------------------------------------------------------------ hint ladders

  /** Run the stale rules on the task's prefetch; a stale one is discarded (it counts toward the cap if unused). */
  async checkHints(c: Pick<HintContext, 'task' | 'errorSetHash' | 'changedLinesSince' | 'readLines'>): Promise<void> {
    const t = c.task;
    const p = t.hintPrefetch;
    if (!p) return;
    const lines = p.anchor.file ? await c.readLines(p.anchor.file).catch(() => undefined) : undefined;
    if (t.hintPrefetch !== p) return;
    const why = this.hints.check(p, { taskId: t.id, errorHash: c.errorSetHash(), anchorLines: lines, changedLinesSince: (m) => c.changedLinesSince(m) });
    if (!why) return;
    this.hints.discard(p);
    t.hintPrefetch = undefined;
    this.log(`[prefetch] hint prefetch for '${t.title}' is stale (${why})`);
    this.changed();
  }

  /**
   * Speculative HintLadder (rungs 1-3) at stuck score .6: medium effort, priority 2, from the hint
   * reserve, keyed by task. One check at a time per task (the tick may call it every 5 s).
   */
  async maybePrefetchHints(c: HintContext): Promise<boolean> {
    const t = c.task;
    if (this.hintChecks.has(t.id)) return false;
    this.hintChecks.add(t.id);
    try {
      await this.checkHints(c);
      const key = prefetchKey(t.id);
      const stats = this.deps.jobs.stats();
      const gate = {
        taskId: t.id, score: c.score, mode: c.mode, hasValidPrefetch: !!t.hintPrefetch, inFlight: this.deps.jobs.has(key),
        hintBudgetLeft: stats.hintLimit - stats.hintUsed, phase: t.phase,
      };
      if (!this.hints.wants(gate)) return false;
      const hash = await c.taskFileHash(c.files);
      if (!this.hints.tryFire(t.id, hash, { mark: c.mark(), errorHash: c.errorSetHash() })) return false;
      let prompt: string;
      try {
        prompt = await c.prompt(true);
      } catch (err) {
        this.hints.settled(t.id);
        this.log(`[prefetch] hint prompt failed: ${errorText(err)}`);
        return false;
      }
      const gen = this.deps.gen();
      const job = this.deps.jobs
        .bg<HintLadder>(
          {
            key, priority: 2, effort: 'medium', label: 'Preparing hints', scope: 'task', kind: 'hint', gen,
            run: (signal) => this.deps.llm.json({ system: SYSTEM, prompt, schema: HintLadderSchema, effort: 'medium' }, { signal, fast: false, background: true }),
          },
          (ladder) => {
            const p = this.hints.accept(ladder, { taskId: t.id, now: this.now() });
            if (p) t.hintPrefetch = p;
            this.changed();
          },
        )
        .finally(() => {
          this.hints.settled(t.id);
          if (this.hintJobs.get(t.id)?.job === job) this.hintJobs.delete(t.id);
        });
      this.hintJobs.set(t.id, { gen, job });
      return true;
    } finally {
      this.hintChecks.delete(t.id);
    }
  }

  /**
   * The ladder for a hint the learner asked for. A speculative job in flight for this task is awaited
   * (raised to priority 0); otherwise one on-demand call at LOW effort through the foreground lane.
   * Rungs failing the '?' rule are dropped by accept(). Undefined when no rung survives.
   */
  async onDemandHints(c: HintContext, fg: ForegroundRun, ownProbe?: OwnProbeResult): Promise<HintPrefetch | undefined> {
    const t = c.task;
    const key = prefetchKey(t.id);
    const inflight = this.hintJobs.get(t.id);
    const state = this.deps.jobs.state(key);
    if (inflight && state === 'running' && genMatches(inflight.gen, this.deps.gen(), 'task')) {
      // Dedupe onto the running ladder (its apply stores the prefetch). Its priority stays
      // speculative: a usage-limit error drops it at once instead of parking the learner's hint
      // behind a 15-minute retry, and the on-demand call below takes over.
      await this.deps.jobs.bg<HintLadder>({
        key, priority: 2, effort: 'medium', label: 'Preparing hints', scope: 'task', kind: 'hint', gen: inflight.gen,
        run: () => Promise.reject(new Error('dedupe only: never runs')),
      });
      await this.checkHints(c);
      if (t.hintPrefetch) return t.hintPrefetch;
    } else if (state === 'queued') {
      // Still waiting for a slot: the learner asked now, so the on-demand call replaces it.
      this.deps.jobs.cancel(key);
    }
    const hash = await c.taskFileHash(c.files);
    const mark = c.mark();
    const errorHash = c.errorSetHash();
    const prompt = await c.prompt(false, ownProbe);
    const ladder = await fg('Preparing a hint', (signal) =>
      this.deps.llm.json({ system: SYSTEM, prompt, schema: HintLadderSchema, effort: 'low' }, { signal }),
    );
    const p = this.hints.accept(ladder, { taskId: t.id, now: this.now(), contentHash: hash, errorHash, mark });
    if (p) t.hintPrefetch = p;
    this.changed();
    return p;
  }

  // ------------------------------------------------------------ own-code probe inputs

  /** Stored model probes for a task (OwnCodeProbeSchema results). */
  modelProbes(taskId: string): ModelProbe[] {
    return this.get<ModelProbe[]>(`probes:${taskId}`) ?? [];
  }

  /**
   * OwnCodeProbe inputs for a spec-less task (low effort, priority 2, task scope). The caller rate-
   * limits (ModelProbeTrigger: a changed function set, at most once per 2 min, building only).
   */
  ownCodeProbes(t: Task, file: { path: string; code: string }, prompt: string): Promise<ModelProbe[] | undefined> {
    const key = `probes:${t.id}`;
    return this.deps.jobs.bg<ModelProbe[]>(
      {
        key, priority: 2, effort: 'low', label: 'Preparing a prediction question', scope: 'task', gen: this.deps.gen(),
        run: async (signal) => {
          const out = await this.deps.llm.json({ system: SYSTEM, prompt, schema: OwnCodeProbeSchema, effort: 'low' }, { signal, fast: false, background: true });
          return out.probes.slice(0, 3).map((p) => ({ ...p, file: p.file || file.path }));
        },
      },
      (probes) => {
        const merged = [...this.modelProbes(t.id)];
        for (const p of probes) if (!merged.some((m) => m.callExpr === p.callExpr)) merged.push(p);
        this.put(key, merged.slice(-PREFETCH.modelProbes), t.id);
        this.changed();
      },
    );
  }

  // ------------------------------------------------------------ follow-ups

  /** FollowUp in the background (priority 1, medium). The caller has checked the policy. */
  followUp(t: Task, input: FollowUpPromptInput, apply: (fu: FollowUp) => void): Promise<FollowUp | undefined> {
    return this.deps.jobs.bg<FollowUp>(
      {
        key: `followup:${t.id}`, priority: 1, effort: 'medium', label: 'Designing a follow-up task', scope: 'project', gen: this.deps.gen(),
        run: (signal) => this.deps.llm.json({ system: SYSTEM, prompt: followUpPrompt(input), schema: FollowUpSchema, effort: 'medium' }, { signal, fast: false, background: true }),
      },
      (fu) => apply(fu),
    );
  }
}

/** Canonical tag of a plan concept's tag output ('other' when unknown). */
export function planTag(tag: string | undefined): string {
  return tag ? canonicalTag(tag) : OTHER_TAG;
}
