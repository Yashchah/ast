import type { Gen, JobKind, JobPriority, JobScope, JobSpec } from './contracts';

export type { Gen, JobKind, JobPriority, JobScope, JobSpec } from './contracts';

/**
 * Two-lane job queue for model calls (spec V1-1). Pure: no vscode import, clock injected.
 *
 * - fg: one call at a time, for the few actions the learner explicitly waits on (Ask, Reveal,
 *   mini-atom Teach, spec-less Check). Not budgeted, not paused.
 * - bg: everything prepared one step ahead. Concurrency 1-3, a rolling hourly call budget with a
 *   hint reserve, dedupe by key, priority/neededBy/FIFO ordering, cancellation, generation checks.
 */

const MIN = 60_000;
export const WINDOW_MS = 60 * MIN;
export const DEFAULT_CALLS_PER_HOUR = 20;
export const HINT_RESERVE = 4;
export const MIN_HALVED_BUDGET = 6;
export const LIMIT_PAUSE_MS = 15 * MIN;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 3;
// Longest single timer we arm; a later wake-up just re-arms (setTimeout overflows past ~24.8 days).
const MAX_TIMER_MS = WINDOW_MS;

// ---------------------------------------------------------------- small runtime helpers

export interface Disposable {
  dispose(): void;
}
export type Event<T> = (listener: (e: T) => void) => Disposable;

/** Minimal event emitter with the same listener shape as vscode.Event. */
export class Emitter<T> {
  private listeners: { fn: (e: T) => void }[] = [];
  readonly event: Event<T> = (fn) => {
    const entry = { fn };
    this.listeners.push(entry);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== entry)) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try {
        l.fn(e);
      } catch (err) {
        // A broken listener must never break the queue or the lock.
        console.error('[deliberate]', err);
      }
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.(); // never keep a test process (or a shutting-down host) alive
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** The race rule: may a result captured at `job` still be applied under `current`? */
export function genMatches(job: Gen, current: Gen, scope: JobScope): boolean {
  switch (scope) {
    case 'global':
      return true;
    case 'project':
      return job.projectCreatedAt === current.projectCreatedAt;
    case 'task':
      return job.projectCreatedAt === current.projectCreatedAt && job.taskId === current.taskId && job.taskSwitch === current.taskSwitch;
  }
}

/** LlmError (and anything else) with kind 'limit': the provider's usage limit was hit. */
export function isLimitError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { kind?: unknown }).kind === 'limit';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function abortError(): Error {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** An abort (a cancelled job or foreground call), not a failure worth a card. */
export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

// ---------------------------------------------------------------- budget

export interface BudgetOptions {
  /** Calls per rolling window (deliberate.backgroundCallsPerHour). Default 20. */
  perHour?: number;
  /** Calls reserved for kind 'hint'. Default 4. */
  hintReserve?: number;
  windowMs?: number;
  now?: () => number;
}

/**
 * Rolling-window call budget with two shares: 'hint' (the reserve) and 'other' (the rest).
 * Each share is a hard cap: other jobs never eat the hint reserve, and hints never exceed it.
 */
export class RollingBudget {
  private spent: { at: number; kind: JobKind }[] = [];
  private base: number;
  private halved = false;
  private readonly reserve: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: BudgetOptions = {}) {
    this.base = sanePerHour(opts.perHour);
    this.reserve = Math.max(0, Math.floor(opts.hintReserve ?? HINT_RESERVE));
    this.windowMs = opts.windowMs ?? WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Calls per window, after any halving. */
  get limit(): number {
    return this.halved ? halvedLimit(this.base) : this.base;
  }

  /** The hint reserve, but never more than half the limit, so other jobs always keep a share. */
  get hintLimit(): number {
    return Math.min(this.reserve, Math.floor(this.limit / 2));
  }

  get isHalved(): boolean {
    return this.halved;
  }

  share(kind: JobKind): number {
    return kind === 'hint' ? this.hintLimit : this.limit - this.hintLimit;
  }

  /** Calls in the current window, for one share or in total. */
  used(kind?: JobKind): number {
    this.prune();
    return kind ? this.spent.filter((s) => s.kind === kind).length : this.spent.length;
  }

  canSpend(kind: JobKind): boolean {
    return this.used(kind) < this.share(kind);
  }

  spend(kind: JobKind): void {
    this.spent.push({ at: this.now(), kind });
  }

  /** When the next call of this share becomes available: now if it already is, Infinity for an empty share. */
  nextFreeAt(kind: JobKind): number {
    this.prune();
    const share = this.share(kind);
    if (share <= 0) return Infinity;
    const mine = this.spent.filter((s) => s.kind === kind); // already in time order
    if (mine.length < share) return this.now();
    // Enough calls must leave the window to bring usage below the share.
    return mine[mine.length - share].at + this.windowMs;
  }

  /** Tier-aware: the first usage-limit error halves the budget (min 6) for the session. Returns true the first time. */
  halve(): boolean {
    if (this.halved) return false;
    this.halved = true;
    return true;
  }

  /** Settings change. A halving already applied stays applied. */
  setPerHour(perHour: number | undefined): void {
    this.base = sanePerHour(perHour);
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.spent.length && this.spent[0].at <= cutoff) this.spent.shift();
  }
}

function sanePerHour(n: number | undefined): number {
  // At least 2, so both shares can hold one call.
  return n === undefined || !Number.isFinite(n) ? DEFAULT_CALLS_PER_HOUR : Math.max(2, Math.round(n));
}

function halvedLimit(n: number): number {
  // Halve, but never below 6 (and never raise a budget that was already below 6).
  return Math.max(Math.min(n, MIN_HALVED_BUDGET), Math.floor(n / 2));
}

export function clampConcurrency(n: number | undefined): number {
  return n === undefined || !Number.isFinite(n) ? DEFAULT_CONCURRENCY : Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(n)));
}

// ---------------------------------------------------------------- queue

export interface JobQueueOptions {
  /** deliberate.backgroundConcurrency: default 2, clamped to 1-3. */
  concurrency?: number;
  /** deliberate.backgroundCallsPerHour: default 20. */
  callsPerHour?: number;
  hintReserve?: number;
  clock?: Clock;
  /**
   * The current generation. When given, a job whose gen no longer matches for its scope is
   * never started, its apply callbacks never run, and its promise resolves undefined.
   */
  currentGen?: () => Gen;
  /** Output-channel logger: errored bg jobs go here, never to the task feed. */
  log?: (line: string) => void;
}

export type JobOutcome = 'done' | 'error' | 'dropped' | 'canceled' | 'stale';

export interface JobSettled {
  key: string;
  label: string;
  priority: JobPriority;
  kind: JobKind;
  scope: JobScope;
  outcome: JobOutcome;
  /** 'budget' | 'paused' for drops, 'superseded' for a key re-enqueued under a newer gen. */
  reason?: string;
  /** Queue wait: enqueue to (last) start. Absent when the job never started. */
  waitMs?: number;
  /** Start to settle. Absent when the job never started. */
  runMs?: number;
  error?: unknown;
}

export interface DeadlineMissed {
  key: string;
  label: string;
  priority: JobPriority;
  neededBy: number;
  /** The job keeps going either way; its result can still attach later. */
  state: 'queued' | 'running';
  waitingFor?: 'budget' | 'pause' | 'slot';
}

export interface JobPaused {
  until: number;
  reason: 'limit' | 'manual';
  /** True when this limit error halved the hourly budget (first one in the session). */
  halved: boolean;
}

export interface JobStats {
  /** Label of the running foreground call, if any. */
  fg?: string;
  /** Foreground calls waiting behind it. */
  fgQueued: number;
  running: number;
  queued: number;
  runningLabels: string[];
  /** Background calls in the last 60 minutes, and the current limit ('7/20 this hour'). */
  used: number;
  limit: number;
  hintUsed: number;
  hintLimit: number;
  halved: boolean;
  pausedUntil?: number;
  deadlineMisses: number;
}

interface Entry {
  spec: JobSpec<unknown>;
  kind: JobKind;
  priority: JobPriority;
  neededBy?: number;
  seq: number;
  enqueuedAt: number;
  startedAt?: number;
  state: 'queued' | 'running' | 'settled';
  ac: AbortController;
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  applies: ((v: unknown) => void)[];
  waitingFor?: 'budget' | 'pause' | 'slot';
  deadlineFired: boolean;
  retried: boolean;
}

export class JobQueue implements Disposable {
  readonly budget: RollingBudget;
  private concurrency: number;
  private readonly clock: Clock;
  private readonly currentGen?: () => Gen;
  private readonly log: (line: string) => void;

  private readonly jobs = new Map<string, Entry>();
  private queue: Entry[] = [];
  private readonly running = new Set<Entry>();
  private seq = 0;
  private pausedUntil = 0;
  private deadlineMisses = 0;
  private pumpScheduled = false;
  private wakeTimer: unknown;
  private wakeAt?: number;
  private disposed = false;

  private fgTail: Promise<void> = Promise.resolve();
  private fgLabel: string | undefined;
  private fgWaiting = 0;
  private fgAbort: AbortController | undefined;
  private fgScope: 'task' | undefined;
  /** Bumped by cancelTaskFg(): task-scoped fg calls still waiting for their turn never run. */
  private fgEpoch = 0;

  private readonly settledEmitter = new Emitter<JobSettled>();
  private readonly changeEmitter = new Emitter<void>();
  private readonly deadlineEmitter = new Emitter<DeadlineMissed>();
  private readonly pauseEmitter = new Emitter<JobPaused>();
  /** Every bg job that resolves, for any reason. */
  readonly onDidSettle = this.settledEmitter.event;
  /** Anything in stats() may have changed (busy bar, tempo tooltip). */
  readonly onDidChange = this.changeEmitter.event;
  /** A job with neededBy has not settled by then: apply the degraded path; the job keeps going. */
  readonly onDeadlineMissed = this.deadlineEmitter.event;
  /** The bg lane paused (tempo bar flashes 'Plan limit: background prep paused 15 min'). */
  readonly onDidPause = this.pauseEmitter.event;

  constructor(opts: JobQueueOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.concurrency = clampConcurrency(opts.concurrency);
    this.budget = new RollingBudget({ perHour: opts.callsPerHour, hintReserve: opts.hintReserve, now: () => this.clock.now() });
    this.currentGen = opts.currentGen;
    this.log = opts.log ?? (() => undefined);
  }

  /** Settings change (backgroundConcurrency / backgroundCallsPerHour). */
  configure(opts: { concurrency?: number; callsPerHour?: number }): void {
    if (opts.concurrency !== undefined) this.concurrency = clampConcurrency(opts.concurrency);
    if (opts.callsPerHour !== undefined) this.budget.setPerHour(opts.callsPerHour);
    this.schedulePump();
  }

  // ------------------------------------------------------------ foreground lane

  /**
   * Run a call the learner is explicitly waiting on. One at a time: a second fg call waits its
   * turn. Errors propagate to the caller; a usage-limit error also pauses the bg lane.
   */
  async fg<T>(label: string, run: (signal: AbortSignal) => Promise<T>, opts: { scope?: 'task' } = {}): Promise<T> {
    const epoch = this.fgEpoch;
    const turn = this.fgTail;
    let done!: () => void;
    this.fgTail = new Promise<void>((r) => (done = r));
    this.fgWaiting++;
    this.changeEmitter.fire();
    await turn;
    this.fgWaiting--;
    // A task-scoped call whose task was left while it waited: it never runs (cancelTaskFg).
    if (opts.scope === 'task' && epoch !== this.fgEpoch) {
      done();
      this.changeEmitter.fire();
      throw abortError();
    }
    const ac = new AbortController();
    if (this.disposed) ac.abort();
    this.fgAbort = ac;
    this.fgScope = opts.scope;
    this.fgLabel = label;
    this.changeEmitter.fire();
    try {
      return await run(ac.signal);
    } catch (err) {
      if (isLimitError(err)) this.hitLimit();
      throw err;
    } finally {
      this.fgLabel = undefined;
      this.fgAbort = undefined;
      this.fgScope = undefined;
      done();
      this.changeEmitter.fire();
    }
  }

  /**
   * A task switch or a new project: abort the running task-scoped foreground call (its result
   * would be thrown away) and drop task-scoped calls still waiting, so the lane is free at once.
   */
  cancelTaskFg(): void {
    this.fgEpoch++;
    if (this.fgScope === 'task') this.fgAbort?.abort();
  }

  /**
   * Charge one nested model call (a repair inside a running job) to the hourly budget, so the cap
   * counts calls, not jobs. False when the share is spent: the caller skips the call.
   */
  charge(kind: JobKind = 'other'): boolean {
    if (this.disposed || !this.budget.canSpend(kind)) return false;
    this.budget.spend(kind);
    this.changeEmitter.fire();
    return true;
  }

  /** 'queued' or 'running' for a job with this key, else undefined. */
  state(key: string): 'queued' | 'running' | undefined {
    const e = this.jobs.get(key);
    return e && e.state !== 'settled' ? e.state : undefined;
  }

  // ------------------------------------------------------------ background lane

  /**
   * Enqueue a background job. Resolves to its result, or undefined when it was dropped
   * (budget, pause), canceled, stale, or errored (errors are logged, never thrown).
   * An identical key returns the in-flight promise; `apply` (if given) runs only when the
   * job succeeds and its gen still matches for its scope.
   */
  bg<T>(spec: JobSpec<T>, apply?: (value: T) => void): Promise<T | undefined> {
    const existing = this.jobs.get(spec.key);
    if (existing) {
      if (genMatches(existing.spec.gen, spec.gen, spec.scope)) {
        if (apply) existing.applies.push(apply as (v: unknown) => void);
        // A more urgent request for the same work (e.g. Ctrl+Alt+H while the hint prefetch is queued).
        if (existing.state === 'queued') {
          existing.priority = Math.min(existing.priority, spec.priority) as JobPriority;
          if (spec.neededBy !== undefined) existing.neededBy = Math.min(existing.neededBy ?? Infinity, spec.neededBy);
          this.schedulePump();
        }
        return existing.promise as Promise<T | undefined>;
      }
      // Same key from an older project/task: that result could never be applied.
      this.cancelEntry(existing, 'superseded');
    }

    const now = this.clock.now();
    let resolve!: (v: unknown) => void;
    const promise = new Promise<unknown>((r) => (resolve = r));
    const entry: Entry = {
      spec: spec as JobSpec<unknown>,
      kind: spec.kind ?? 'other',
      priority: spec.priority,
      neededBy: spec.neededBy,
      seq: this.seq++,
      enqueuedAt: now,
      state: 'queued',
      ac: new AbortController(),
      promise,
      resolve,
      applies: apply ? [apply as (v: unknown) => void] : [],
      deadlineFired: false,
      retried: false,
    };

    if (this.disposed) {
      this.settle(entry, 'canceled');
    } else if (!this.isCurrent(entry)) {
      this.settle(entry, 'stale');
    } else if (entry.priority >= 2 && this.isPaused(now)) {
      this.settle(entry, 'dropped', undefined, 'paused');
    } else if (entry.priority >= 2 && !this.budget.canSpend(entry.kind)) {
      // Speculative work is dropped silently when its share is full.
      this.settle(entry, 'dropped', undefined, 'budget');
    } else {
      this.jobs.set(spec.key, entry);
      this.queue.push(entry);
      this.changeEmitter.fire();
      this.schedulePump();
    }
    return promise as Promise<T | undefined>;
  }

  /** Is a job with this key queued or running? (e.g. 'a hint job for this task is in flight') */
  has(key: string): boolean {
    return this.jobs.has(key);
  }

  /** Abort one job. Its promise resolves undefined. Returns false when no such job exists. */
  cancel(key: string): boolean {
    const e = this.jobs.get(key);
    if (!e) return false;
    this.cancelEntry(e);
    return true;
  }

  /** Abort every queued or running job whose spec matches. Returns how many were canceled. */
  cancelWhere(pred: (spec: JobSpec<unknown>) => boolean): number {
    const hits = [...this.jobs.values()].filter((e) => pred(e.spec));
    for (const e of hits) this.cancelEntry(e);
    return hits.length;
  }

  /**
   * Pause the bg lane (default 15 min). Running jobs finish; queued speculative jobs
   * (priority >= 2) are dropped; priority 0-1 jobs wait for the pause to end.
   */
  pause(ms = LIMIT_PAUSE_MS, reason: 'limit' | 'manual' = 'manual', halved = false): void {
    const now = this.clock.now();
    this.pausedUntil = Math.max(this.pausedUntil, now + ms);
    for (const e of [...this.queue]) {
      if (e.priority >= 2) this.settle(e, 'dropped', undefined, 'paused');
    }
    this.pauseEmitter.fire({ until: this.pausedUntil, reason, halved });
    this.changeEmitter.fire();
    this.schedulePump();
  }

  stats(): JobStats {
    const now = this.clock.now();
    return {
      fg: this.fgLabel,
      fgQueued: this.fgWaiting,
      running: this.running.size,
      queued: this.queue.length,
      runningLabels: [...this.running].map((e) => e.spec.label),
      used: this.budget.used(),
      limit: this.budget.limit,
      hintUsed: this.budget.used('hint'),
      hintLimit: this.budget.hintLimit,
      halved: this.budget.isHalved,
      pausedUntil: this.isPaused(now) ? this.pausedUntil : undefined,
      deadlineMisses: this.deadlineMisses,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const e of [...this.jobs.values()]) this.cancelEntry(e);
    this.fgAbort?.abort();
    this.clearWake();
    this.settledEmitter.dispose();
    this.changeEmitter.dispose();
    this.deadlineEmitter.dispose();
    this.pauseEmitter.dispose();
  }

  // ------------------------------------------------------------ internals

  private isPaused(now: number): boolean {
    return now < this.pausedUntil;
  }

  /** The race rule against the current gen. If the gen cannot be read, only global results count. */
  private isCurrent(e: Entry): boolean {
    if (!this.currentGen || e.spec.scope === 'global') return true;
    try {
      return genMatches(e.spec.gen, this.currentGen(), e.spec.scope);
    } catch (err) {
      this.log(`[jobs] reading the current generation failed: ${errorText(err)}`);
      return false;
    }
  }

  private hitLimit(): void {
    const halved = this.budget.halve();
    this.log(`[jobs] usage limit reached: background prep paused ${LIMIT_PAUSE_MS / MIN} min${halved ? `, hourly budget now ${this.budget.limit}` : ''}`);
    this.pause(LIMIT_PAUSE_MS, 'limit', halved);
  }

  /** Batch synchronous enqueues so ordering sees all of them (not just the first one). */
  private schedulePump(): void {
    if (this.pumpScheduled || this.disposed) return;
    this.pumpScheduled = true;
    queueMicrotask(() => this.pump());
  }

  private pump(): void {
    this.pumpScheduled = false;
    if (this.disposed) return;
    const now = this.clock.now();
    this.checkDeadlines(now);
    const paused = this.isPaused(now);
    let running = this.running.size;
    let speculative = [...this.running].filter((e) => e.priority >= 2).length;
    // Speculative work never takes the last free slot, so needed-next work starts at once.
    const speculativeCap = Math.max(1, this.concurrency - 1);
    let changed = false;

    for (const e of [...this.queue].sort(byOrder)) {
      if (e.state !== 'queued') continue; // a listener canceled it during this pass
      if (!this.isCurrent(e)) {
        this.settle(e, 'stale');
        continue;
      }
      if (paused) {
        e.waitingFor = 'pause';
        continue;
      }
      if (running >= this.concurrency || (e.priority >= 2 && speculative >= speculativeCap)) {
        e.waitingFor = 'slot';
        continue;
      }
      if (!this.budget.canSpend(e.kind)) {
        if (e.priority >= 2) this.settle(e, 'dropped', undefined, 'budget');
        else e.waitingFor = 'budget';
        continue;
      }
      this.start(e, now);
      changed = true;
      running++;
      if (e.priority >= 2) speculative++;
    }
    this.armWake(now);
    if (changed) this.changeEmitter.fire();
  }

  private start(e: Entry, now: number): void {
    e.state = 'running';
    e.startedAt = now;
    e.waitingFor = undefined;
    this.queue = this.queue.filter((q) => q !== e);
    this.running.add(e);
    this.budget.spend(e.kind);
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(e.spec.run(e.ac.signal));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (v) => this.onResult(e, v),
      (err) => this.onError(e, err),
    ).catch((err) => this.log(`[jobs] ${e.spec.label}: internal error: ${errorText(err)}`));
  }

  private onResult(e: Entry, v: unknown): void {
    if (e.state !== 'running') return; // canceled meanwhile: the late result is ignored
    this.running.delete(e);
    if (!this.isCurrent(e)) {
      this.settle(e, 'stale');
    } else {
      // Free the key first, so an apply may enqueue follow-up work under the same key.
      if (this.jobs.get(e.spec.key) === e) this.jobs.delete(e.spec.key);
      for (const apply of e.applies) {
        try {
          apply(v);
        } catch (err) {
          this.log(`[jobs] ${e.spec.label}: applying the result failed: ${errorText(err)}`);
        }
      }
      this.settle(e, 'done', v);
    }
    this.schedulePump();
  }

  private onError(e: Entry, err: unknown): void {
    if (e.state !== 'running') return;
    this.running.delete(e);
    if (isLimitError(err)) {
      this.hitLimit();
      // Needed work gets one more try once the pause ends; speculative work is just dropped.
      if (e.priority <= 1 && !e.retried) {
        e.retried = true;
        e.state = 'queued';
        this.queue.push(e);
        this.log(`[jobs] ${e.spec.label}: will retry after the pause`);
        this.schedulePump();
        return;
      }
    }
    this.log(`[jobs] ${e.spec.label} (${e.spec.key}) failed: ${errorText(err)}`);
    this.settle(e, 'error', undefined, undefined, err);
    this.schedulePump();
  }

  private cancelEntry(e: Entry, reason?: string): void {
    if (e.state === 'settled') return;
    this.settle(e, 'canceled', undefined, reason);
    try {
      e.ac.abort();
    } catch {
      // abort listeners belong to the job; their failures are not ours
    }
    this.schedulePump();
  }

  private settle(e: Entry, outcome: JobOutcome, value?: unknown, reason?: string, error?: unknown): void {
    if (e.state === 'settled') return;
    const startedAt = e.startedAt;
    e.state = 'settled';
    this.queue = this.queue.filter((q) => q !== e);
    this.running.delete(e);
    if (this.jobs.get(e.spec.key) === e) this.jobs.delete(e.spec.key);
    e.resolve(outcome === 'done' ? value : undefined);
    const now = this.clock.now();
    this.settledEmitter.fire({
      key: e.spec.key,
      label: e.spec.label,
      priority: e.priority,
      kind: e.kind,
      scope: e.spec.scope,
      outcome,
      reason,
      waitMs: startedAt === undefined ? undefined : startedAt - e.enqueuedAt,
      runMs: startedAt === undefined ? undefined : now - startedAt,
      error,
    });
    this.changeEmitter.fire();
  }

  private checkDeadlines(now: number): void {
    for (const e of [...this.queue, ...this.running]) {
      if (e.neededBy === undefined || e.deadlineFired || now < e.neededBy) continue;
      e.deadlineFired = true;
      this.deadlineMisses++;
      this.deadlineEmitter.fire({
        key: e.spec.key,
        label: e.spec.label,
        priority: e.priority,
        neededBy: e.neededBy,
        state: e.state === 'running' ? 'running' : 'queued',
        waitingFor: e.state === 'running' ? undefined : (e.waitingFor ?? 'slot'),
      });
    }
  }

  /** One timer for the next time-driven event: pause end, a budget slot freeing up, a deadline. */
  private armWake(now: number): void {
    let at = Infinity;
    if (this.isPaused(now)) at = this.pausedUntil;
    for (const e of this.queue) {
      if (e.waitingFor === 'budget') at = Math.min(at, this.budget.nextFreeAt(e.kind));
    }
    for (const e of [...this.queue, ...this.running]) {
      if (e.neededBy !== undefined && !e.deadlineFired) at = Math.min(at, e.neededBy);
    }
    if (at === this.wakeAt) return;
    this.clearWake();
    if (!Number.isFinite(at)) return;
    this.wakeAt = at;
    this.wakeTimer = this.clock.setTimeout(() => {
      this.wakeTimer = undefined;
      this.wakeAt = undefined;
      this.pump();
    }, Math.min(MAX_TIMER_MS, Math.max(0, at - now)));
  }

  private clearWake(): void {
    if (this.wakeTimer !== undefined) this.clock.clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.wakeAt = undefined;
  }
}

/** Priority, then earliest neededBy (none = last), then FIFO. */
function byOrder(a: Entry, b: Entry): number {
  return a.priority - b.priority || (a.neededBy ?? Infinity) - (b.neededBy ?? Infinity) || a.seq - b.seq;
}

/** Tooltip line: 'running 2 · queued 1 · 7/20 this hour'. */
export function describeJobs(s: JobStats, now = Date.now()): string {
  const parts = [`running ${s.running}`, `queued ${s.queued}`, `${s.used}/${s.limit} this hour`];
  if (s.pausedUntil !== undefined) parts.push(`paused ${Math.max(1, Math.ceil((s.pausedUntil - now) / MIN))} min`);
  return parts.join(' · ');
}
