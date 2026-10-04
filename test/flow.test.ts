// The v0.2 coach flows end to end, with a FakeLlm whose answers can arrive out of order (defer), a
// real JobQueue, InteractionLock, GateUi (fake QuickPick port) and Prefetcher, and fakes for the pad,
// placement, specs, own-code flows, hints display and tempo bar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Coach, decideLanguage, fencedCode, normProject, skeletonRender, titleFromGoal, type CoachConfig, type CoachHost, type MonitorLike, type PadLike, type PlacementLike, type SpecsLike, type SprintLike, type TempoSink, type WhatIfLike } from '../src/coach';
import type { Action, AtomResult, Gen, Runner, StoredAtom, TaskGateState, TaskSpecState } from '../src/contracts';
import { JobQueue } from '../src/jobs';
import { InteractionLock } from '../src/lock';
import { bindEvidenceEnv, concept, emptyLearner, recordEvidence, upsertConcepts } from '../src/learner';
import type { EvidenceRecord } from '../src/evidence';
import { StuckDetector } from '../src/stuck';
import * as S from '../src/schemas';
import { GateUi, type PickOutcome, type PickPort, type PickRequest } from '../src/gate';
import type { AttachOptions, AttachResult, HiddenResult, SpecCallbacks, SpecTask } from '../src/specs';
import type { SpecLadderDraft, VerifyResult } from '../src/specsCore';
import type { ShowHintRequest, ShownHint } from '../src/hints';
import type { WhatIfContext, WhatIfRunResult } from '../src/owncode';
import { AtomCache } from '../src/atoms/cache';
import type { PlacementRunOptions, PlacementRunResult } from '../src/atoms/placementRun';
import type { SprintOptions, SprintResult } from '../src/atoms/sprint';
import type { Learner, Project, Task } from '../src/types';
import { EventEmitter } from './vscode-stub';

// =====================================================================================
// FakeLlm with out-of-order answers
// =====================================================================================

type Responder = (prompt: string) => unknown;

class Deferred {
  resolve!: (v: unknown) => void;
  reject!: (e: unknown) => void;
  readonly promise = new Promise<unknown>((res, rej) => {
    this.resolve = res;
    this.reject = rej;
  });
  private markCalled!: () => void;
  /** Resolves when the coach made the call. */
  readonly called = new Promise<void>((r) => (this.markCalled = r));
  call(): void {
    this.markCalled();
  }
}

function schemaName(schema: z.ZodType): string {
  return Object.entries(S).find(([, v]) => v === schema)?.[0] ?? '?';
}

class FakeLlm {
  calls: { schema: string; prompt: string; effort?: string; fast?: boolean; background?: boolean }[] = [];
  private readonly queue = new Map<z.ZodType, (Responder | Deferred)[]>();
  private readonly defaults = new Map<z.ZodType, Responder>();
  on(schema: z.ZodType, ...rs: Responder[]): this {
    this.queue.set(schema, [...(this.queue.get(schema) ?? []), ...rs]);
    return this;
  }
  /** Used whenever nothing is queued for the schema. */
  otherwise(schema: z.ZodType, r: Responder): this {
    this.defaults.set(schema, r);
    return this;
  }
  /** The next call for this schema waits until the test resolves it. */
  defer(schema: z.ZodType): Deferred {
    const d = new Deferred();
    this.queue.set(schema, [...(this.queue.get(schema) ?? []), d]);
    return d;
  }
  async json<T extends z.ZodType>({ prompt, schema, effort }: { prompt: string; schema: T; effort?: string }, opts: { fast?: boolean; background?: boolean } = {}): Promise<z.infer<T>> {
    const name = schemaName(schema);
    this.calls.push({ schema: name, prompt, effort, fast: opts.fast, background: opts.background });
    const r = this.queue.get(schema)?.shift() ?? this.defaults.get(schema);
    if (!r) throw new Error(`no fake response queued for ${name}`);
    if (r instanceof Deferred) {
      r.call();
      return schema.parse(await r.promise);
    }
    return schema.parse(r(prompt));
  }
  count(name: string): number {
    return this.calls.filter((c) => c.schema === name).length;
  }
  last(name: string) {
    return [...this.calls].reverse().find((c) => c.schema === name);
  }
}

// =====================================================================================
// Fakes for the surfaces
// =====================================================================================

class FakeMonitor implements MonitorLike {
  detector = new StuckDetector();
  touchedFiles = new Set<string>();
  lastEditAt = 0;
  tick = new EventEmitter<number>();
  onTick = this.tick.event;
  pause = new EventEmitter<{ kind: 'manual-save' | 'spec-green' | 'terminal-ok' | 'idle'; at: number }>();
  onPause = this.pause.event;
  taskFiles: string[] = [];
  startTask() {
    this.detector = new StuckDetector();
  }
  currentErrors() {
    return [];
  }
  setTaskFiles(uris: readonly string[]) {
    this.taskFiles = [...uris];
  }
  mark() {
    return 0;
  }
  changedLinesSince() {
    return 0;
  }
  errorSetHash() {
    return 'e0';
  }
  async taskFileHash() {
    return 'h0';
  }
  rung0() {
    return undefined;
  }
}

class FakeTempo implements TempoSink {
  actions = new Map<string, Omit<Action, 'id' | 'createdAt'>>();
  flashes: string[] = [];
  skip = new EventEmitter<Action>();
  onDidSkip = this.skip.event;
  enqueue(a: Omit<Action, 'id' | 'createdAt'> & { id?: string }): string {
    const id = a.id ?? `${a.kind}:${a.command}`;
    this.actions.set(id, a);
    return id;
  }
  remove(idOrKind: string): void {
    this.actions.delete(idOrKind);
    for (const [id, a] of this.actions) if (a.kind === idOrKind) this.actions.delete(id);
  }
  flash(text: string): void {
    this.flashes.push(text);
  }
  update(): void {}
}

class FakePad implements PadLike {
  runs: { atom: StoredAtom; opts: unknown }[] = [];
  constructor(private readonly lock: InteractionLock) {}
  acquire(kind: string) {
    return this.lock.acquire(kind);
  }
  async run(atom: StoredAtom, opts: { conceptId?: string } = {}): Promise<AtomResult> {
    this.runs.push({ atom, opts });
    return { conceptId: opts.conceptId ?? atom.conceptId, path: 'learned', items: 3, ms: 70_000, stateBefore: 'Unknown', stateAfter: 'Learning' };
  }
}

function placementResult(conceptIds: string[], reason: PlacementRunResult['reason'] = 'classified'): PlacementRunResult {
  const items = conceptIds.map((c, i) => ({ conceptId: c, itemId: `p${i}`, kind: 'predict' as const, correct: true, guess: false, latencyValid: true, underPar: true, extra: false, at: i }));
  return {
    state: { startedAt: 0, calibrated: true, esc: false, items, askedIds: items.map((i) => i.itemId) },
    summary: { items: items.length, ms: 60_000, solid: conceptIds, newConcepts: [], misconceptions: [], text: `Placement: ${items.length} items, 1m00s.`, flash: 'Placement done' },
    reason, selfRated: false, calibrated: true,
  };
}

class FakePlacement implements PlacementLike {
  candidates: string[] = [];
  opts: PlacementRunOptions | undefined;
  onRun?: (opts: PlacementRunOptions) => Promise<void> | void;
  answered: string[] = ['list-indexing'];
  addCandidates(ids: readonly string[]): void {
    this.candidates.push(...ids);
  }
  async run(opts: PlacementRunOptions = {}): Promise<PlacementRunResult> {
    this.opts = opts;
    await this.onRun?.(opts);
    return placementResult(this.answered);
  }
}

class FakeSprint implements SprintLike {
  static runs: SprintOptions[] = [];
  available(): number {
    return 3;
  }
  async run(opts: SprintOptions): Promise<SprintResult> {
    FakeSprint.runs.push(opts);
    if (opts.until) await opts.until.catch(() => undefined);
    return { items: 2, correct: 2, ms: 20_000, auditsRun: 0, delayedChecks: 0, score: 6, newBest: false, stopReason: 'until', conceptIds: [] };
  }
}

class FakeSpecs implements SpecsLike {
  on: SpecCallbacks = {};
  applicable = false;
  taskId: string | undefined;
  attached: { taskId: string; opts: AttachOptions }[] = [];
  deferred: string[] = [];
  runs = 0;
  async attach(task: SpecTask, _lang: string, _runner: Runner | undefined, opts: AttachOptions): Promise<AttachResult> {
    this.taskId = task.id;
    this.applicable = !!task.spec?.applicable && opts.allowRun;
    this.attached.push({ taskId: task.id, opts });
    return { applicable: this.applicable, mappedNames: {}, pending: [] };
  }
  detach(): void {
    this.taskId = undefined;
    this.applicable = false;
  }
  async runNow(): Promise<void> {
    this.runs++;
  }
  setAllowRun(): void {}
  addDeferredConcepts(ids: readonly string[]): void {
    this.deferred.push(...ids);
  }
  ladder() {
    return undefined;
  }
}

class FakeWhatIf implements WhatIfLike {
  contexts: WhatIfContext[] = [];
  result: (ctx: WhatIfContext) => WhatIfRunResult = (ctx) => ({
    status: 'done',
    whatIfs: [{ file: ctx.file, line: 2, op: 'lt-le', tag: 'off-by-one', callExpr: 'add_todo([], "a")', mutatedLine: 'x', actual: "['a']", unmutated: "['a']", predicted: "['a']", correct: true, attributable: false }],
    evidence: [{ conceptId: ctx.conceptId, kind: 'what-if', source: 'own-code', correct: true, taskId: ctx.taskId }],
  });
  async run(ctx: WhatIfContext): Promise<WhatIfRunResult> {
    this.contexts.push(ctx);
    return this.result(ctx);
  }
}

class FakeHints {
  shown: ShowHintRequest[] = [];
  cleared: string[] = [];
  async show(req: ShowHintRequest): Promise<ShownHint | undefined> {
    this.shown.push(req);
    return { rung: req.rung, uri: `file:///ws/${req.anchor.file}`, file: req.anchor.file, line: req.anchor.line - 1, route: 'after', text: req.text };
  }
  clear(reason: string): void {
    this.cleared.push(reason);
  }
}

class FakePick implements PickPort {
  requests: PickRequest[] = [];
  answers: ((req: PickRequest) => PickOutcome)[] = [];
  async pick(req: PickRequest): Promise<PickOutcome> {
    this.requests.push(req);
    const a = this.answers.shift();
    return a ? a(req) : { kind: 'esc' };
  }
}

/** Select the items whose labels contain these words. */
const choose = (...names: string[]) => (req: PickRequest): PickOutcome => ({
  kind: 'accept',
  selected: req.items.map((it, i) => (names.some((n) => it.label.includes(n)) ? i : -1)).filter((i) => i >= 0),
});

const fakeRunner: Runner = {
  runtime: { lang: 'python', exe: 'python', snippetArgv: [], learnerArgv: [], version: '3.14.0' },
  runBatch: async () => [],
  runLearnerCode: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, ms: 1 }),
};

// =====================================================================================
// Harness
// =====================================================================================

interface HarnessOptions {
  config?: Partial<CoachConfig>;
  gate?: boolean;
  placement?: boolean;
  allowRun?: boolean;
  /** Spec verification through the prefetcher (TaskPrep). */
  verify?: (draft: SpecLadderDraft) => VerifyResult;
}

function harness(o: HarnessOptions = {}) {
  const evs: EvidenceRecord[] = [];
  const learner = emptyLearner() as Learner;
  bindEvidenceEnv(learner, { log: (ev) => evs.push(ev) });
  const store = {
    learner,
    project: undefined as Project | undefined,
    save() {},
    async flush() {},
    async resetProject() {
      this.project = undefined;
    },
    async resetLearner() {},
    async readEvidence() {
      return evs;
    },
  };
  const llm = new FakeLlm()
    .otherwise(S.TaskPrepSchema, () => ({ tasks: [] }))
    .otherwise(S.AtomPackSchema, () => ({ atoms: [] }))
    .otherwise(S.TaskBatchSchema, () => ({ tasks: [] }));
  // eslint-disable-next-line prefer-const
  let coach!: Coach;
  const jobs = new JobQueue({ currentGen: (): Gen => coach.gen() });
  const lock = new InteractionLock();
  const monitor = new FakeMonitor();
  const tempo = new FakeTempo();
  const pad = new FakePad(lock);
  const placement = new FakePlacement();
  const specs = new FakeSpecs();
  const whatIf = new FakeWhatIf();
  const hints = new FakeHints();
  const pick = new FakePick();
  const cache = new AtomCache('python');
  const skeletons: { lang: string; code: string }[] = [];
  const composer: string[] = [];
  const verified: SpecLadderDraft[] = [];
  const host: CoachHost = {
    config: () => ({ stuckMinutes: 7, proactive: 'offer', maxFollowUps: 2, planEffort: 'medium', polishReview: false, ...o.config }),
    workspaceExtensions: async () => [['py', 3]],
    pickLanguage: async () => 'python',
    confirm: async () => true,
    windowFocused: () => true,
    focusEditor() {},
    focusComposer: (m) => void composer.push(m),
    codeSnapshot: async () => 'CODE',
    workspaceDir: () => '/ws',
    uriOf: (p) => `file://${p.replace(/\\/g, '/')}`,
    readText: async () => 'def add_todo(todos, text):\n    return todos\n',
    readLines: async () => ['def add_todo(todos, text):', '    todos.append(text)', '    return todos'],
    fileList: async () => 'todo.py',
  };
  coach = new Coach({
    store, llm, monitor, jobs, lock, host, tempo,
    runtime: { runner: () => fakeRunner, allowRun: () => o.allowRun ?? true },
    caches: (l) => (l === 'python' ? cache : undefined),
    stocks: () => undefined,
    prefetchDeps: {
      specs: {
        verifyLadder: async (draft) => {
          verified.push({ ...draft });
          return o.verify?.(draft) ?? { applicable: draft.applicable, verified: true, specs: draft.specs, hidden: draft.hidden, dropped: [], repaired: false };
        },
      },
    },
    pad,
    placement: o.placement === false ? undefined : () => placement,
    sprint: () => new FakeSprint(),
    skeleton: async (lang, code) => void skeletons.push({ lang, code }),
    gate: o.gate === false ? undefined : new GateUi({ pick, lock }),
    specs, whatIf, hints,
    delays: { waitFillMs: 5, followUpWaitMs: 50 },
  });
  return { coach, store, learner, llm, jobs, lock, monitor, tempo, pad, placement, specs, whatIf, hints, pick, cache, skeletons, composer, evs, verified };
}

type H = ReturnType<typeof harness>;

// ---------------------------------------------------------------- model outputs

const iface = (file: string, name: string, sig: string) => ({ file, functions: [{ name, signature: sig, purpose: 'does the thing' }] });

const taskOut = (title: string, conceptIds: string[], fn: string) => ({
  title, description: `${title}.`, acceptanceCriteria: ['it works'], conceptIds, estimatedMinutes: 10, interface: iface('todo.py', fn, `${fn}(todos, text)`),
});

const plan = () => ({
  summary: 'A command line todo app.',
  milestones: [{ title: 'Basics', goal: 'Add and list todos' }, { title: 'Persistence', goal: 'Save to disk' }],
  concepts: [
    { id: 'list-indexing', name: 'List indexing', description: 'Index into a list', prerequisites: [], tag: 'list-indexing' },
    { id: 'todo-list', name: 'A list of todos', description: 'Append to a list', prerequisites: [], tag: 'list-mutation-methods' },
    { id: 'parse-command', name: 'Parse a command', description: 'Split input', prerequisites: [], tag: 'string-split-join' },
  ],
  milestone1Tasks: [
    taskOut('Add a todo', ['todo-list'], 'add_todo'),
    taskOut('List todos', ['list-indexing', 'todo-list'], 'list_todos'),
    taskOut('Parse a command', ['parse-command'], 'parse_command'),
  ],
});

const spec = (id: string, call: string, conceptId: string) => ({ id, title: `behaviour ${id}`, conceptId, call, expected: "['a']", expectError: '', parSec: 60, failureSignatures: [] });

/** Exactly 5 patterns: the required ones, the given lures, then neutral lures (no competing concept). */
function gatePack(required: [string, string][], lures: [string, string][]): TaskGateState {
  const fillers = ['Sort with a key', 'Recursion', 'Read a file', 'Use a set'].slice(0, Math.max(0, 5 - required.length - lures.length));
  return {
    patterns: [
      ...required.map(([name, conceptId]) => ({ name, conceptId, required: true, competesWith: '', useWhen: `use ${name}`, whyNot: '' })),
      ...lures.map(([name, competesWith]) => ({ name, conceptId: 'lure-x', required: false, competesWith, useWhen: '', whyNot: `${name} does not fit` })),
      ...fillers.map((name) => ({ name, conceptId: 'lure-x', required: false, competesWith: '', useWhen: '', whyNot: '' })),
    ],
    plans: [
      { text: 'Append each new todo to one list', workable: true, flawConceptId: '', misconceptionId: '', whyFlawed: '' },
      { text: 'Make a new list for each todo', workable: false, flawConceptId: 'todo-list', misconceptionId: 'list-recreated', whyFlawed: 'What happens to the earlier todos?' },
      { text: 'Store todos in one string variable', workable: false, flawConceptId: 'todo-list', misconceptionId: '', whyFlawed: 'How would you remove one?' },
    ],
  };
}

function specState(conceptId: string): TaskSpecState {
  return {
    specs: [spec('s1', 'add_todo([], "a")', conceptId), spec('s2', 'add_todo(["a"], "b")', conceptId), spec('s3', 'add_todo([], "")', conceptId)],
    hidden: [spec('h1', 'add_todo(["x"], "y")', conceptId)],
    greenAt: {}, firstRedAt: {}, savesSinceRed: {}, runs: 0, verified: true, applicable: true,
  };
}

/** A project with ready-made tasks (the plan already landed, placement done). */
function seedProject(h: H, tasks: Partial<Task>[], opts: { milestoneSplit?: number } = {}): Project {
  upsertConcepts(h.learner, [
    { id: 'todo-list', name: 'A list of todos', tag: 'other' },
    { id: 'list-indexing', name: 'List indexing', tag: 'list-indexing' },
    { id: 'parse-command', name: 'Parse a command', tag: 'other' },
    { id: 'lure-x', name: 'Lure', tag: 'other' },
  ]);
  const p: Project = {
    goal: 'todo app', title: 'Todo app', summary: 'A todo CLI', language: 'python', lang: 'python', createdAt: 1000,
    conceptIds: ['todo-list', 'list-indexing', 'parse-command'], milestones: [], tasks: {}, feed: [],
    placement: { asked: [], startedAt: 0, done: true, selfRated: false, planPending: false, calibrated: true },
    prefetch: {}, taskSwitch: 0,
  };
  const ids: string[] = [];
  tasks.forEach((t, i) => {
    const id = t.id ?? `t${i + 1}`;
    p.tasks[id] = {
      id, title: `Task ${i + 1}`, description: 'Build it.', acceptanceCriteria: ['works'], conceptIds: ['todo-list'], estimatedMinutes: 10,
      kind: 'roadmap', followUpDepth: 0, status: 'todo', phase: 'building', activeMs: 0, stuckMs: 0, explainAttempts: 0, hints: [],
      revealed: false, offeredRung: 0, feed: [], interface: iface('todo.py', 'add_todo', 'add_todo(todos, text)'), fade: 'full', solo: false,
      // TaskPrep already ran for these tasks (no late prep unless a test clears it).
      prep: { state: 'done', at: 0 },
      ...t,
    } as Task;
    ids.push(id);
  });
  const split = opts.milestoneSplit ?? ids.length;
  p.milestones = [{ title: 'Basics', taskIds: ids.slice(0, split) }];
  if (split < ids.length) p.milestones.push({ title: 'More', taskIds: ids.slice(split) });
  h.store.project = normProject(p);
  return p;
}

function atomFor(conceptId: string): StoredAtom {
  return {
    key: conceptId, lang: 'python', conceptId, tag: 'other', source: 'model', verified: true, createdAt: 0,
    pattern: { kind: 'shape', name: 'Append to a list', useWhen: 'collect items', template: 'xs.append(<x>)', rule: '', howItRuns: '', pitfall: '', useCases: [] },
    probes: [], examples: [], completions: [], contrasts: [], tracebacks: [],
  };
}

/** Let background jobs and their applies run. */
async function settle(h: H): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
    await h.coach.idle();
  }
}

// =====================================================================================
// Pure helpers
// =====================================================================================

test('language decision: workspace first, keywords next, a conflict asks', () => {
  assert.deepEqual(decideLanguage([['py', 4], ['md', 9]], 'a todo app', ''), { lang: 'python', ask: false });
  assert.deepEqual(decideLanguage([], 'a react dashboard', ''), { lang: 'javascript', ask: false });
  assert.deepEqual(decideLanguage([], 'learn golang by building a cli', ''), { lang: 'go', ask: false });
  assert.deepEqual(decideLanguage([['ts', 2]], 'a flask api', ''), { ask: true }, 'workspace vs keyword conflict');
  assert.deepEqual(decideLanguage([], 'django or express?', ''), { ask: true }, 'two keywords');
  assert.deepEqual(decideLanguage([], 'I want to go faster at coding', ''), { ask: true }, "plain 'go' is not a language");
  assert.equal(titleFromGoal('build a tiny todo app for my terminal with tags'), 'Build a tiny todo app for my...');
  assert.equal(fencedCode('Do this:\n```py\nx = ___\n```\nok'), 'x = ___');
});

test('the rung-4 skeleton render puts each ___ on a snippet tab stop under a header', () => {
  const r = skeletonRender('python', 'def f(xs):\n  for x in ___:\n    ___');
  assert.equal(r.await, 'read');
  assert.match(r.text, /^# Skeleton for the stuck piece/);
  assert.equal(r.snippet!.filter((s) => 'placeholder' in s).length, 2);
  assert.equal(r.text.split('\n')[r.answerLine!].includes('___'), true);
});

// =====================================================================================
// Start, placement and the split roadmap (V1-7)
// =====================================================================================

test('placement answers are graded while PlanOutline is pending (no GradeSchema); task 1 starts after the plan', async () => {
  const h = harness();
  const planD = h.llm.defer(S.PlanOutlineSchema);
  h.placement.onRun = async (opts) => {
    await planD.called;
    assert.equal(opts.planPending!(), true, 'placement knows the plan is pending');
    assert.equal(h.coach.inputMode().mode, 'placement');
    assert.equal(h.coach.tempoState().phase, 'placement');
    // The pad grades locally and records evidence (source placement).
    upsertConcepts(h.learner, [{ id: 'list-indexing', name: 'List indexing', tag: 'list-indexing' }]);
    recordEvidence(h.learner, { conceptId: 'list-indexing', kind: 'predict', source: 'placement', correct: true, g: 0.06, siblingGroup: 'a' });
  };
  await h.coach.startProject('a todo app', '');
  const p = h.store.project!;
  assert.equal(p.language, 'python');
  assert.equal(p.placement.done, true);
  assert.equal(p.placement.planPending, true);
  assert.equal(h.coach.task, undefined, 'no task before the plan');
  assert.ok(p.feed.some((c) => c.title === 'Your roadmap is almost ready'));
  assert.ok(h.tempo.actions.has('sprint:wait'), 'practice-while-you-wait offer');
  assert.equal(h.llm.count('GradeSchema'), 0);
  assert.equal(h.llm.last('PlanOutlineSchema')!.fast, false, 'background calls never use the priority tier');
  assert.match(h.llm.last('PlanOutlineSchema')!.prompt, /The language is fixed: python/);
  const pBefore = concept(h.learner, 'list-indexing')!.mastery;

  planD.resolve(plan());
  await settle(h);
  const t = h.coach.task!;
  assert.equal(t.title, 'Add a todo');
  assert.equal(t.status, 'active');
  assert.equal(p.milestones.length, 2);
  assert.equal(p.milestones[0].taskIds.length, 3);
  assert.equal(p.tasks[p.milestones[0].taskIds[2]].solo, true, 'the last task of a milestone is solo');
  assert.ok(concept(h.learner, 'list-indexing')!.mastery >= pBefore, 'placement evidence survives the merge');
  // The plan concept with a seed tag merges into the seed concept (alias), so ids resolve to the seed id.
  assert.equal(concept(h.learner, 'todo-list')!.id, 'list-mutation-methods');
  assert.deepEqual(t.conceptIds, ['list-mutation-methods']);
  assert.ok(h.llm.count('TaskPrepSchema') >= 1, 'TaskPrep for tasks 1-3 when the plan lands');
  assert.equal(h.llm.count('GradeSchema'), 0);
});

test('a failed plan shows Retry and keeps placement evidence; Retry builds the roadmap', async () => {
  const h = harness();
  h.llm.on(S.PlanOutlineSchema, () => {
    throw new Error('codex exited with code 1');
  });
  h.placement.onRun = () => {
    upsertConcepts(h.learner, [{ id: 'list-indexing', name: 'List indexing', tag: 'list-indexing' }]);
    recordEvidence(h.learner, { conceptId: 'list-indexing', kind: 'predict', source: 'placement', correct: true, g: 0.06, siblingGroup: 'a' });
  };
  await h.coach.startProject('a todo app', '');
  await settle(h);
  const p = h.store.project!;
  const card = p.feed.find((c) => c.title.startsWith('Roadmap failed'));
  assert.ok(card, 'failure card');
  assert.match(card!.title, /codex exited with code 1/);
  assert.deepEqual(card!.actions!.map((a) => a.command), ['retryPlan']);
  assert.ok(concept(h.learner, 'list-indexing')!.mastery > 0.3, 'placement evidence kept');
  assert.equal(h.coach.inputMode().extras[0].command, 'retryPlan');

  h.llm.on(S.PlanOutlineSchema, plan);
  h.coach.retryPlan();
  await settle(h);
  assert.equal(p.placement.planError, undefined);
  assert.equal(h.coach.task?.title, 'Add a todo');
});

test('reconcile re-enqueues a pending plan after a reload', async () => {
  const h = harness();
  const p: Project = {
    goal: 'todo app', title: 'Todo app', summary: '', language: 'python', createdAt: 5000, conceptIds: [], milestones: [], tasks: {}, feed: [],
    placement: { asked: [], startedAt: 0, done: false, selfRated: false, planPending: true, calibrated: true },
    prefetch: {}, taskSwitch: 0,
  };
  h.store.project = p;
  h.llm.on(S.PlanOutlineSchema, plan);
  await h.coach.reconcile();
  await settle(h);
  assert.equal(h.llm.count('PlanOutlineSchema'), 1);
  assert.equal(p.placement.done, true, 'an interrupted placement is not restarted');
  assert.equal(p.milestones[0].taskIds.length, 3);
  assert.equal(h.coach.task?.title, 'Add a todo');
  await h.coach.reconcile();
  await settle(h);
  assert.equal(h.llm.count('PlanOutlineSchema'), 1, 'no plan call once the roadmap exists');
});

test('a TaskPrep result that lands after the learner switched task is ignored', async () => {
  const h = harness();
  seedProject(h, [{ prep: undefined, conceptIds: ['todo-list'] }, { conceptIds: ['parse-command'] }]);
  const prepD = h.llm.defer(S.TaskPrepSchema);
  await h.coach.startTask('t1'); // no prep yet: a late TaskPrep for t1
  await prepD.called;
  const a = h.store.project!.tasks.t1;
  assert.equal(a.phase, 'building', 'never blocked on the prep');
  assert.ok(a.feed.some((c) => c.title === 'Plan it in your head'));
  await h.coach.startTask('t2');
  prepD.resolve({ tasks: [{ taskTitle: 'Task 1', gate: gatePack([['Append to a list', 'todo-list']], []), specs: { applicable: true, reason: '', specs: specState('todo-list').specs, hidden: specState('todo-list').hidden, reference: 'def add_todo(t, x): return t + [x]' } }] });
  await settle(h);
  assert.equal(a.gate, undefined);
  assert.equal(a.spec, undefined);
  assert.equal(a.prep?.state, 'failed', 'reconcile prepares it again on return');
  assert.ok(!h.specs.attached.some((x) => x.taskId === 't1'), 'nothing attached to the old task');
  assert.equal(h.coach.task!.id, 't2');
});

test('TaskPrep that lands while the task is building attaches its specs (the reference is never stored)', async () => {
  const h = harness();
  seedProject(h, [{ prep: undefined }]);
  const prepD = h.llm.defer(S.TaskPrepSchema);
  await h.coach.startTask('t1');
  await prepD.called;
  prepD.resolve({ tasks: [{ taskTitle: 'Task 1', gate: gatePack([['Append to a list', 'todo-list']], []), specs: { applicable: true, reason: '', specs: specState('todo-list').specs, hidden: specState('todo-list').hidden, reference: 'def add_todo(t, x): return t + [x]' } }] });
  await settle(h);
  const t = h.coach.task!;
  assert.ok(t.spec?.applicable);
  assert.equal(h.verified[0].reference, 'def add_todo(t, x): return t + [x]', 'verified against the reference');
  assert.equal(JSON.stringify(h.store.project).includes('return t + [x]'), false, 'the reference is not in project state');
  assert.ok(h.specs.attached.some((x) => x.taskId === 't1' && x.opts.announce === true), "specs attach with 'specs ready'");
});

// =====================================================================================
// The gate (V1-8)
// =====================================================================================

test('a gate pass goes to building, attaches specs, and makes no ExplanationReview call', async () => {
  const h = harness();
  seedProject(h, [{ gate: gatePack([['Append to a list', 'todo-list']], [['Count with dict', 'todo-list']]), spec: specState('todo-list') }]);
  h.pick.answers.push(choose('Append to a list'), choose('Append each new todo'));
  await h.coach.startTask('t1');
  const t = h.coach.task!;
  assert.equal(h.pick.requests.length, 2, 'step A and step B (fade full)');
  assert.match(h.pick.requests[0].title, /Task 1 · Task 1: which patterns will you need\?/);
  assert.match(h.pick.requests[1].title, /^1\/1 patterns · Which plan works\?/);
  assert.equal(t.phase, 'building');
  assert.deepEqual(t.gate!.result!.missed, []);
  assert.ok(h.evs.some((e) => e.kind === 'pattern-pick' && e.correct === true && e.conceptId === 'todo-list'));
  assert.ok(h.evs.some((e) => e.kind === 'plan-pick' && e.correct === true));
  assert.ok(h.specs.attached.some((x) => x.taskId === 't1'));
  assert.ok(h.tempo.flashes.includes('Go build'));
  assert.equal(h.pad.runs.length, 0);
  assert.equal(h.llm.count('ExplanationReviewSchema'), 0);
  assert.equal(h.llm.calls.length, 0, 'the gate is graded locally');
});

test('a missed required pattern with P < .5 runs an atom before building; its gap is not deferred', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list', 'parse-command'], gate: gatePack([['Append to a list', 'todo-list'], ['Split the input', 'parse-command']], []) }]);
  h.cache.put(atomFor('parse-command'));
  h.pick.answers.push(choose('Append to a list'), () => ({ kind: 'esc' }));
  await h.coach.startTask('t1');
  const t = h.coach.task!;
  assert.equal(h.pad.runs.length, 1);
  assert.equal(h.pad.runs[0].atom.conceptId, 'parse-command');
  assert.equal((h.pad.runs[0].opts as { taskId?: string }).taskId, 't1');
  assert.equal(t.atomRuns.length, 1);
  assert.equal(t.phase, 'building', 'back to building after the atom');
  assert.ok(h.evs.some((e) => e.kind === 'pattern-pick' && e.correct === false && e.conceptId === 'parse-command'));
  assert.equal(h.lock.held, false, 'the lock is released');
});

test('a missed pattern without a cached atom becomes a JIT offer (the pack is queued, nothing blocks)', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list', 'parse-command'], gate: gatePack([['Append to a list', 'todo-list'], ['Split the input', 'parse-command']], []), spec: specState('todo-list') }]);
  h.pick.answers.push(choose('Append to a list'), () => ({ kind: 'esc' }));
  await h.coach.startTask('t1');
  const t = h.coach.task!;
  assert.equal(h.pad.runs.length, 0);
  assert.deepEqual(t.gateDeferred, ['parse-command']);
  assert.deepEqual(h.specs.attached.at(-1)!.opts.deferredConcepts, ['parse-command']);
  await settle(h);
  assert.ok(h.llm.count('AtomPackSchema') >= 1, 'a pack for the gap is prepared in the background');
  assert.equal(t.phase, 'building');
});

test('a lure pick is weight .3 wrong evidence with no misconception', async () => {
  const h = harness();
  seedProject(h, [{ gate: gatePack([['Append to a list', 'todo-list']], [['Count with dict', 'todo-list']]) }]);
  h.pick.answers.push(choose('Append to a list', 'Count with dict'), () => ({ kind: 'esc' }));
  await h.coach.startTask('t1');
  const lure = h.evs.find((e) => e.kind === 'pattern-pick' && e.correct === false);
  assert.ok(lure);
  assert.equal(lure!.weight, 0.3);
  assert.equal(lure!.misconceptionId, undefined);
  assert.deepEqual(Object.keys(concept(h.learner, 'todo-list')!.misconceptions), []);
  assert.ok(h.coach.task!.feed.some((c) => c.title === 'Gate' && c.html.includes('does not fit')), 'the lure whyNot goes to the log card');
});

test('the gate is skipped when the task brings no new concept', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list'] }, { conceptIds: ['todo-list'], gate: gatePack([['Append to a list', 'todo-list']], []) }]);
  await h.coach.startTask('t2');
  assert.equal(h.pick.requests.length, 0);
  assert.equal(h.coach.task!.phase, 'building');
});

test('a gate cache miss goes straight to building with the one-line card', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list'] }]);
  await h.coach.startTask('t1');
  const t = h.coach.task!;
  assert.equal(h.pick.requests.length, 0);
  assert.equal(t.phase, 'building');
  assert.ok(t.feed.some((c) => c.title === 'Plan it in your head'));
});

test('solo tasks never gate', async () => {
  const h = harness();
  seedProject(h, [{ solo: true, fade: 'solo', gate: gatePack([['Append to a list', 'todo-list']], []) }]);
  await h.coach.startTask('t1');
  assert.equal(h.pick.requests.length, 0);
  assert.equal(h.coach.task!.fade, 'solo');
  assert.equal(h.coach.task!.phase, 'building');
});

test("'I'd do it differently': the free-text plan is reviewed in the background and building starts at once", async () => {
  const h = harness();
  seedProject(h, [{ gate: gatePack([['Append to a list', 'todo-list']], []) }]);
  h.pick.answers.push(() => ({ kind: 'own-plan' }));
  await h.coach.startTask('t1');
  const t = h.coach.task!;
  assert.equal(t.phase, 'explain');
  assert.deepEqual(h.composer, ['explain']);
  assert.equal(h.coach.inputMode().mode, 'explain');
  const review = h.llm.defer(S.ExplanationReviewSchema);
  await h.coach.submit('Keep a list and append each todo');
  assert.equal(t.phase, 'building', 'building at once, the review runs in the background');
  review.resolve({ verdict: 'gaps', feedback: 'How will you remove one?', gaps: [{ conceptId: 'parse-command', issue: 'x' }], probingQuestion: '' });
  await settle(h);
  assert.equal(h.llm.last('ExplanationReviewSchema')!.effort, 'low');
  assert.ok(t.feed.some((c) => c.title === 'Your plan: some gaps'));
  assert.ok(h.evs.some((e) => e.kind === 'llm-grade' && e.weight === 0.5));
  assert.ok(h.tempo.actions.has('atom:parse-command'), 'gaps queue an atom offer instead of blocking');
});

// =====================================================================================
// Building -> done (V1-11, V1-12, V1-9)
// =====================================================================================

test('all specs green -> hidden -> what-ifs -> complete -> the next task starts at once', async () => {
  const h = harness();
  seedProject(h, [{ spec: specState('todo-list') }, { conceptIds: ['todo-list'] }]);
  h.learner.concepts['todo-list'].mastery = 0.9; // no follow-up by policy
  await h.coach.startTask('t1');
  const t = h.store.project!.tasks.t1;
  assert.equal(h.specs.taskId, 't1');
  for (const [i, s] of t.spec!.specs.entries()) h.specs.on.onGreen!(s.id, 1, { spec: s, number: i + 1, assisted: false, at: Date.now(), trigger: 'manual' });
  assert.equal(h.evs.filter((e) => e.kind === 'spec' && e.production).length, 3);
  assert.equal(h.coach.inputMode().extras.find((x) => x.command === 'checkWork')!.label, 'Run my specs');
  h.specs.on.onAllVisibleGreen!();
  h.specs.on.onHiddenResult!({ pass: true } as HiddenResult);
  await settle(h);
  assert.equal(t.status, 'done');
  assert.ok(t.criteriaMetAt);
  assert.equal(h.whatIf.contexts.length, 1);
  assert.equal(h.whatIf.contexts[0].count, 2);
  assert.equal(t.whatIfs?.length, 1);
  assert.ok(h.evs.some((e) => e.kind === 'what-if'));
  assert.ok(h.evs.some((e) => e.kind === 'task' && e.source === 'task'), 'task evidence on completion');
  assert.equal(h.coach.task!.id, 't2', 'the next task starts at once');
  assert.equal(h.llm.count('FollowUpSchema'), 0);
  assert.equal(h.llm.count('WorkReviewSchema'), 0, 'the ladder decides done, not a review');
});

test('a hidden spec failure keeps the task open and records transfer evidence', async () => {
  const h = harness();
  seedProject(h, [{ spec: specState('todo-list') }]);
  await h.coach.startTask('t1');
  const s = h.store.project!.tasks.t1.spec!.hidden[0];
  h.specs.on.onHiddenResult!({ pass: false, spec: s, result: { id: s.id, pass: false, actual: '[]' }, card: "Passes your checks but not add_todo(['x'], 'y')" });
  await settle(h);
  const t = h.coach.task!;
  assert.equal(t.status, 'active');
  assert.equal(t.phase, 'building');
  assert.ok(t.feed.some((c) => c.title === 'Passes your checks, not this one'));
  assert.ok(h.evs.some((e) => e.kind === 'spec' && e.correct === false && e.itemId === `hidden:t1:${s.id}`));
});

test('follow-ups only when policy says so (weakest P < .6 or an active misconception)', async () => {
  // Strong concepts: no FollowUp call, straight to the next roadmap task.
  const strong = harness();
  seedProject(strong, [{ spec: specState('todo-list') }, { conceptIds: ['list-indexing'] }]);
  strong.learner.concepts['todo-list'].mastery = 0.75;
  await strong.coach.startTask('t1');
  strong.specs.on.onHiddenResult!({ pass: true } as HiddenResult);
  await settle(strong);
  assert.equal(strong.llm.count('FollowUpSchema'), 0);
  assert.equal(strong.coach.task!.id, 't2');

  // Weak concept: the follow-up is written in the background at criteria-met and comes next.
  const weak = harness();
  seedProject(weak, [{ spec: specState('todo-list') }, { conceptIds: ['list-indexing'] }]);
  weak.llm.on(S.FollowUpSchema, () => ({ ...taskOut('Remove a todo', ['todo-list'], 'remove_todo'), why: 'index practice' }));
  await weak.coach.startTask('t1');
  weak.specs.on.onHiddenResult!({ pass: true } as HiddenResult);
  await settle(weak);
  assert.equal(weak.llm.count('FollowUpSchema'), 1);
  assert.equal(weak.llm.last('FollowUpSchema')!.effort, 'medium');
  assert.match(weak.llm.last('FollowUpSchema')!.prompt, /Weakest concept: todo-list \(P 0\.\d\d, state \w+\)/);
  const p = weak.store.project!;
  const fu = p.tasks[p.milestones[0].taskIds[1]];
  assert.equal(fu.kind, 'followup');
  assert.equal(fu.parentId, 't1');
  assert.equal(fu.interface?.functions[0].name, 'remove_todo');
  assert.equal(weak.coach.task!.id, fu.id, 'the follow-up comes next');

  // Depth cap (maxFollowUps).
  const capped = harness({ config: { maxFollowUps: 0 } });
  seedProject(capped, [{ spec: specState('todo-list') }]);
  await capped.coach.startTask('t1');
  capped.specs.on.onHiddenResult!({ pass: true } as HiddenResult);
  await settle(capped);
  assert.equal(capped.llm.count('FollowUpSchema'), 0);
});

test('Check my work without a spec ladder runs in the foreground at medium effort, then what-ifs', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list'] }]);
  h.learner.concepts['todo-list'].mastery = 0.9;
  await h.coach.startTask('t1');
  h.llm.on(S.WorkReviewSchema, () => ({ meetsCriteria: true, summary: 'Works.', issues: [], mistakePatterns: [], explainBackQuestion: 'Why a list?' }));
  await h.coach.checkWork();
  await settle(h);
  const c = h.llm.last('WorkReviewSchema')!;
  assert.equal(c.effort, 'medium');
  assert.notEqual(c.fast, false, 'foreground calls keep codexFast');
  assert.equal(h.store.project!.tasks.t1.status, 'done');
  assert.equal(h.whatIf.contexts.length, 1);
  assert.ok(h.tempo.flashes.includes('Review ready'));
});

test('without a runtime the explain-back fallback is graded in the background and the task completes at once', async () => {
  const h = harness({ allowRun: false });
  seedProject(h, [{ conceptIds: ['todo-list'] }, { conceptIds: ['todo-list'] }]);
  h.learner.concepts['todo-list'].mastery = 0.9;
  await h.coach.startTask('t1');
  h.llm.on(S.WorkReviewSchema, () => ({ meetsCriteria: true, summary: 'Works.', issues: [], mistakePatterns: [], explainBackQuestion: 'Why a list?' }));
  await h.coach.checkWork();
  await settle(h);
  const t = h.store.project!.tasks.t1;
  assert.equal(t.phase, 'explain-back');
  assert.equal(h.coach.inputMode().mode, 'explain-back');
  const grade = h.llm.defer(S.GradeSchema);
  await h.coach.submit('Because a list keeps the order');
  assert.equal(t.status, 'done', 'not awaited behind the grade');
  assert.equal(h.coach.task!.id, 't2');
  grade.resolve({ correct: true, score: 1, feedback: 'Yes.', misconception: '' });
  await settle(h);
  assert.equal(h.llm.last('GradeSchema')!.effort, 'low');
  assert.ok(h.evs.some((e) => e.kind === 'llm-grade' && e.taskId === 't1'));
});

// =====================================================================================
// Hints (V1-10)
// =====================================================================================

function prefetch(taskId: string) {
  return {
    key: `hint:${taskId}`, contentHash: 'h0', errorHash: 'e0', at: Date.now(),
    anchor: { file: 'todo.py', line: 2, lineText: '    todos.append(text)' },
    rungs: ['What does append return?', 'Which concept decides what a function hands back here?', '1. Append. 2. Return the list.'],
    diagnosis: 'returns None', stuckType: 'concept-gap', conceptIds: ['todo-list'], misconceptionId: '', used: false,
  };
}

test('hint serves rungs 1-3 from the prefetch without a model call; Got it records rung evidence', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list'] }]);
  await h.coach.startTask('t1');
  const t = h.coach.task!;
  t.hintPrefetch = prefetch('t1');
  await h.coach.hint();
  assert.equal(h.llm.calls.length, 0, 'served from the prefetch');
  assert.equal(h.hints.shown[0].rung, 1);
  assert.equal(h.hints.shown[0].text, 'What does append return?');
  assert.equal(t.hints.length, 1);
  assert.equal(t.hintPrefetch!.used, true);
  assert.equal(t.hintServe!.prefetched, 1);
  h.coach.gotIt();
  const ev = h.evs.find((e) => e.source === 'hint');
  assert.ok(ev);
  assert.equal(ev!.weight, 0.3, 'rung 1 is weight .3');
  assert.ok(h.hints.cleared.includes('got-it'));
  assert.equal(t.phase, 'building', 'no explain-back after a hint');
});

test('a prefetch miss makes one low-effort on-demand ladder call (single-flight per task)', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list'] }]);
  await h.coach.startTask('t1');
  const d = h.llm.defer(S.HintLadderSchema);
  const a = h.coach.hint();
  const b = h.coach.hint();
  await d.called;
  d.resolve({
    diagnosis: 'x', stuckType: 'concept-gap', conceptIds: ['todo-list'], misconceptionId: '', mistakePattern: '',
    anchor: { file: 'todo.py', line: 2, lineText: '    todos.append(text)' },
    rungs: [{ rung: 1, text: 'What does append return?' }, { rung: 2, text: 'Not a question' }, { rung: 3, text: 'Steps.' }],
  });
  await Promise.all([a, b]);
  assert.equal(h.llm.count('HintLadderSchema'), 1);
  assert.equal(h.llm.last('HintLadderSchema')!.effort, 'low');
  const t = h.coach.task!;
  assert.equal(t.hints.length, 1);
  assert.equal(t.hintPrefetch!.rungs[1], '', "rung 2 without '?' was dropped by post-parse validation");
});

test('rung 4 opens a skeleton in the pad (never the project); solo tasks stop at rung 2 with no Reveal', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list'] }, { conceptIds: ['todo-list'], solo: true, fade: 'solo' }]);
  await h.coach.startTask('t1');
  const t = h.coach.task!;
  t.hints.push({ rung: 1, at: 0, diagnosis: 'a', html: '' }, { rung: 2, at: 0, diagnosis: 'b', html: '' }, { rung: 3, at: 0, diagnosis: 'c', html: '' });
  h.llm.on(S.HintSchema, () => ({ diagnosis: 'd', stuckType: 'approach', conceptIds: ['todo-list'], hint: 'Fill it:\n```py\ndef add_todo(todos, text):\n    todos.___(text)\n    return ___\n```', mistakePattern: '' }));
  await h.coach.hint();
  assert.equal(h.llm.last('HintSchema')!.effort, 'low');
  assert.equal(h.skeletons.length, 1);
  assert.match(h.skeletons[0].code, /todos\.___\(text\)/);
  assert.equal(h.lock.held, false);
  assert.equal(t.hints.at(-1)!.rung, 4);

  await h.coach.startTask('t2');
  const solo = h.coach.task!;
  solo.hints.push({ rung: 1, at: 0, diagnosis: 'a', html: '' }, { rung: 2, at: 0, diagnosis: 'b', html: '' });
  const calls = h.llm.calls.length;
  await h.coach.hint();
  assert.equal(h.llm.calls.length, calls, 'no rung 3 in a solo task');
  assert.ok(solo.feed.some((c) => c.title === 'Solo task: hints stop at rung 2'));
  await h.coach.reveal();
  assert.equal(solo.revealed, false);
});

test("at stuck >= 1 'offer' mode queues a hint-ready action instead of a pop-up", async () => {
  const h = harness({ config: { stuckMinutes: 4 } });
  seedProject(h, [{ conceptIds: ['todo-list'] }]);
  await h.coach.startTask('t1');
  let now = Date.now();
  for (let i = 0; i < 120; i++) {
    now += 5000;
    h.monitor.detector.onEdit(now, 3, 3);
    h.monitor.tick.fire(h.monitor.detector.tick(now, true));
  }
  assert.ok(h.coach.signals!.score >= 1);
  assert.ok(h.tempo.actions.has('hint-ready'));
  assert.equal(h.tempo.actions.get('hint-ready')!.command, 'deliberate.hint');
  const t = h.coach.task!;
  assert.equal(t.offeredRung, 1);
  h.coach.imFine();
  assert.equal(t.offeredRung, 0);
  assert.equal(h.tempo.actions.has('hint-ready'), false);
});

// =====================================================================================
// Teach, sprints, locks, generation
// =====================================================================================

test('Teach on a concept with no atom builds the mini atom in the foreground (low), then runs it', async () => {
  const h = harness({ gate: false });
  seedProject(h, [{ conceptIds: ['parse-command'] }]);
  h.store.project!.tasks.t1.status = 'active';
  h.store.project!.tasks.t1.phase = 'explain'; // not building: the pad may open
  h.store.project!.currentTaskId = 't1';
  // The mini atom pack fails verification (no probes): the learner gets a card, not a hang.
  h.llm.on(S.AtomPackSchema, () => ({ atoms: [] }));
  await h.coach.teach('parse-command');
  await settle(h);
  const mini = h.llm.calls.find((c) => c.schema === 'AtomPackSchema')!;
  assert.equal(mini.effort, 'low');
  assert.match(mini.prompt, /Write the pattern, 2 probes/);
  assert.ok(h.coach.task!.feed.some((c) => c.title.startsWith('No practice for')));
  // A cached atom runs at once, with no model call.
  h.cache.put(atomFor('parse-command'));
  const n = h.llm.calls.length;
  await h.coach.teach('parse-command');
  assert.equal(h.llm.calls.length, n);
  assert.equal(h.pad.runs.length, 1);
});

test('starting a task aborts the active modal flow and bumps the generation; task jobs are cancelled', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list'] }, { conceptIds: ['todo-list'] }]);
  await h.coach.startTask('t1');
  const g1 = h.coach.gen();
  let aborted = false;
  const release = h.lock.acquire('sprint', () => {
    aborted = true;
  });
  assert.ok(release);
  const d = h.llm.defer(S.OwnCodeProbeSchema);
  const job = h.coach.prefetcher.ownCodeProbes(h.coach.task!, { path: 'todo.py', code: 'x' }, 'prompt');
  await d.called;
  await h.coach.startTask('t2');
  assert.equal(aborted, true);
  assert.equal(h.lock.held, false);
  const g2 = h.coach.gen();
  assert.equal(g2.taskSwitch, g1.taskSwitch + 1);
  assert.equal(g2.taskId, 't2');
  assert.equal(await job, undefined, 'the old task job was cancelled');
});

test('the sprint command runs a 3-minute local sprint under the lock', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list'] }]);
  FakeSprint.runs = [];
  await h.coach.sprint();
  assert.deepEqual(FakeSprint.runs.map((r) => [r.reason, r.budgetMs]), [['sprint', 180_000]]);
  assert.equal(h.lock.held, false);
  assert.equal(h.llm.calls.length, 0);
});

test('paste and assisted inserts add to the task counters silently', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list'] }]);
  await h.coach.startTask('t1');
  h.coach.onInsert({ kind: 'paste', chars: 150 });
  h.coach.onInsert({ kind: 'assisted', chars: 60, functions: ['add_todo'] });
  h.coach.onInsert({ kind: 'assisted', chars: 45, functions: ['add_todo'] });
  const t = h.coach.task!;
  assert.equal(t.pastedChars, 150);
  assert.equal(t.assistedChars, 105);
  assert.deepEqual(t.assistedFunctions, ['add_todo']);
});

test('the view model carries chips, misconceptions, the deck and calibration', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list'] }]);
  await h.coach.startTask('t1');
  recordEvidence(h.learner, { conceptId: 'todo-list', kind: 'predict', source: 'atom', correct: false, g: 0.06, siblingGroup: 'a', misconceptionId: 'list-recreated', beliefConfirmed: true, misconceptionOdds: 6, belief: 'append makes a new list' } as never);
  const vm = h.coach.viewModel();
  const c = vm.progress.concepts.find((x) => x.id === 'todo-list')!;
  assert.ok(c.chip);
  assert.equal(typeof c.inferred, 'boolean');
  assert.ok(Array.isArray(vm.progress.deck));
  assert.ok('calibration' in vm.progress);
  assert.equal(vm.task!.interface, 'Write in todo.py: add_todo(todos, text)');
  assert.equal(vm.input.mode, 'building');
  const ts = h.coach.tempoState();
  assert.equal(ts.phase, 'building');
  assert.equal(ts.task!.title, 'Task 1');
});

// =====================================================================================
// Real pad + placement + stock (neutral items: no runtime needed)
// =====================================================================================

test('integration: the real AtomPad and PlacementRun grade placement locally while the plan is pending', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { AtomPad, ManualClock, MemoryPadEditor, ScriptedPadUi } = await import('../src/atoms/pad');
  const { PlacementRun } = await import('../src/atoms/placementRun');
  const { Stock } = await import('../src/atoms/stock');
  const root = path.resolve(__dirname, '..');

  const evs: EvidenceRecord[] = [];
  const learner = emptyLearner() as Learner;
  bindEvidenceEnv(learner, { log: (ev) => evs.push(ev) });
  const store = { learner, project: undefined as Project | undefined, save() {}, async flush() {}, async resetProject() {}, async resetLearner() {}, async readEvidence() { return evs; } };
  const llm = new FakeLlm().otherwise(S.TaskPrepSchema, () => ({ tasks: [] })).otherwise(S.AtomPackSchema, () => ({ atoms: [] })).otherwise(S.TaskBatchSchema, () => ({ tasks: [] }));
  // eslint-disable-next-line prefer-const
  let coach!: Coach;
  const jobs = new JobQueue({ currentGen: (): Gen => coach.gen() });
  const lock = new InteractionLock();
  const cache = new AtomCache('python');
  const stock = new Stock({ lang: 'python', cache, readFile: (rel) => fs.readFile(path.join(root, rel), 'utf8'), runner: () => undefined });
  const report = await stock.ensureStock();
  assert.equal(report.neutral, true);
  const editor = new MemoryPadEditor();
  const ui = new ScriptedPadUi();
  const clock = new ManualClock(Date.now());
  const pad = new AtomPad({
    editor, ui, clock, lock, learner: () => learner, recordEvidence: (e) => recordEvidence(learner, e), cache: () => cache, runner: () => undefined,
    onLog: (card) => coach.pushLogCard(card), onExit: (r) => coach.onAtomExit(r), markProgress: (now, why) => coach.markProgressIfBuilding(now, why),
    lesson: (req) => coach.escalationLesson(req),
  });
  coach = new Coach({
    store, llm, monitor: new FakeMonitor(), jobs, lock, tempo: new FakeTempo(),
    host: {
      config: () => ({ stuckMinutes: 7, proactive: 'offer', maxFollowUps: 2, planEffort: 'medium', polishReview: false }),
      workspaceExtensions: async () => [], pickLanguage: async () => 'python', confirm: async () => true, windowFocused: () => true, focusEditor() {},
      codeSnapshot: async () => 'CODE', workspaceDir: () => '/ws', uriOf: (p) => p, readText: async () => undefined, readLines: async () => undefined,
    },
    runtime: { runner: () => undefined, allowRun: () => false },
    caches: () => cache, stocks: () => stock, pad,
    placement: () => new PlacementRun(pad, stock),
    delays: { waitFillMs: 5, followUpWaitMs: 50 },
  });
  const planD = llm.defer(S.PlanOutlineSchema);
  const started = coach.startProject('a python todo app', '');
  let ended = false;
  void started.then(() => (ended = true));
  let answered = 0;
  for (let i = 0; i < 40 && !ended; i++) {
    const r = await Promise.race([pad.whenAwaiting(), started.then(() => undefined)]);
    if (!r || ended) break;
    clock.advance(9000);
    const lines = editor.doc.split('\n');
    if (lines[0].includes('copy this exactly')) {
      editor.answer(lines.slice(r.codeStart ?? 1, r.answerLine).join(' | ').trim());
    } else {
      editor.answer('?');
      answered++;
    }
    assert.equal(store.project!.placement.planPending, true, 'answered while the roadmap is still being designed');
    pad.submit(false);
  }
  await started;
  assert.ok(answered >= 1, 'placement items were shown and answered');
  assert.ok(evs.some((e) => e.source === 'placement'), 'graded locally into placement evidence');
  assert.equal(llm.count('GradeSchema'), 0);
  assert.equal(editor.isOpen, false, 'the pad closed after placement');
  assert.equal(lock.held, false);
  assert.ok(store.project!.feed.some((c) => c.title === 'Placement'), 'one compact placement card');
  planD.resolve(plan());
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
    await coach.idle();
  }
  assert.equal(coach.task?.title, 'Add a todo');
  assert.ok(coach.task!.feed[0].title === 'Placement', 'the placement summary tops the first task');
});

// =====================================================================================
// More edges
// =====================================================================================

test('a language conflict asks with the QuickPick; Esc starts nothing', async () => {
  const h = harness();
  (h.coach as unknown as { deps: { host: CoachHost } }).deps.host.pickLanguage = async () => undefined;
  (h.coach as unknown as { deps: { host: CoachHost } }).deps.host.workspaceExtensions = async () => [['ts', 5]];
  await h.coach.startProject('a flask api', '');
  assert.equal(h.store.project, undefined);
  assert.equal(h.llm.calls.length, 0);
});

test('rung 0: a persistent project error is served locally first; Got it there records nothing', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list'] }]);
  await h.coach.startTask('t1');
  h.monitor.rung0 = () => ({ key: 'KeyError@todo.py:2', source: 'terminal', exception: 'KeyError', file: 'todo.py', line: 2, text: 'Which line does the trace point at, and what does KeyError mean?' }) as never;
  await h.coach.hint();
  assert.equal(h.llm.calls.length, 0);
  assert.equal(h.hints.shown[0].rung, 0);
  h.coach.gotIt();
  assert.equal(h.evs.filter((e) => e.source === 'hint').length, 0);
  // The same error is not served twice: the next hint is rung 1 (on demand here).
  h.llm.on(S.HintLadderSchema, () => ({
    diagnosis: 'x', stuckType: 'slip', conceptIds: [], misconceptionId: '', mistakePattern: '',
    anchor: { file: 'todo.py', line: 2, lineText: '    todos.append(text)' }, rungs: [{ rung: 1, text: 'Which key is missing?' }, { rung: 2, text: 'Why?' }, { rung: 3, text: 'Steps.' }],
  }));
  await h.coach.hint();
  assert.equal(h.hints.shown[1].rung, 1);
});

test('a save in a spec-less task fires the OwnCodeProbe job once (low, priority 2), not with a ladder', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list'] }]);
  (h.coach as unknown as { deps: { host: CoachHost } }).deps.host.functionNames = async () => ['add_todo'];
  await h.coach.startTask('t1');
  h.llm.on(S.OwnCodeProbeSchema, () => ({ probes: [{ file: 'todo.py', functionName: 'add_todo', callExpr: 'add_todo([], "")', conceptId: 'todo-list', edgeCase: 'empty text', misconceptionIfWrong: '' }] }));
  await h.coach.onSave({ uri: 'file:///ws/todo.py', fsPath: '/ws/todo.py' });
  await h.coach.onSave({ uri: 'file:///ws/todo.py', fsPath: '/ws/todo.py' });
  await settle(h);
  assert.equal(h.llm.count('OwnCodeProbeSchema'), 1, 'rate-limited and only on a changed function set');
  assert.equal(h.llm.last('OwnCodeProbeSchema')!.effort, 'low');
  assert.equal(h.coach.prefetcher.modelProbes('t1')[0].callExpr, 'add_todo([], "")');

  const withLadder = harness();
  seedProject(withLadder, [{ spec: specState('todo-list') }]);
  (withLadder.coach as unknown as { deps: { host: CoachHost } }).deps.host.functionNames = async () => ['add_todo'];
  await withLadder.coach.startTask('t1');
  await withLadder.coach.onSave({ uri: 'file:///ws/todo.py', fsPath: '/ws/todo.py' });
  await settle(withLadder);
  assert.equal(withLadder.llm.count('OwnCodeProbeSchema'), 0);
});

test('the polish review is opt-in and runs in the background after every spec passes', async () => {
  const h = harness({ config: { polishReview: true } });
  seedProject(h, [{ spec: specState('todo-list') }]);
  h.learner.concepts['todo-list'].mastery = 0.9;
  h.llm.on(S.WorkReviewSchema, () => ({ meetsCriteria: true, summary: 'Clean.', issues: [{ severity: 'polish', prompt: 'Name it todos?' }], mistakePatterns: [], explainBackQuestion: '' }));
  await h.coach.startTask('t1');
  h.specs.on.onHiddenResult!({ pass: true } as HiddenResult);
  await settle(h);
  const c = h.llm.last('WorkReviewSchema')!;
  assert.equal(c.fast, false);
  assert.match(c.prompt, /Review only design, naming, structure and robustness/);
  assert.ok(h.store.project!.tasks.t1.feed.some((x) => x.title === 'Polish review'));
});

test('a new project aborts flows, cancels project jobs and clears the project', async () => {
  const h = harness();
  seedProject(h, [{ conceptIds: ['todo-list'] }]);
  await h.coach.startTask('t1');
  const d = h.llm.defer(S.TaskBatchSchema);
  const batch = h.coach.prefetcher.taskBatch(0, { lang: 'python', runtime: 'Python', fade: 'full' }, () => assert.fail('stale batch applied'));
  await d.called;
  await h.coach.newProject();
  assert.equal(h.store.project, undefined);
  assert.equal(await batch, undefined);
  assert.equal(h.coach.inputMode().mode, 'none');
});

// =====================================================================================
// Compile-time: the real modules fit the coach's ports (the shell passes them in)
// =====================================================================================

import type { Monitor } from '../src/monitor';
import type { AtomPad } from '../src/atoms/pad';
import type { PlacementRun } from '../src/atoms/placementRun';
import type { Sprint } from '../src/atoms/sprint';
import type { Stock } from '../src/atoms/stock';
import type { SpecController } from '../src/specs';
import type { PredictFlow, WhatIfFlow } from '../src/owncode';
import type { HintDisplay } from '../src/hints';
import type { TempoBar } from '../src/tempoBar';
import type { Llm } from '../src/llm';
import type { Store } from '../src/store';
import type { GateRunner, HintDisplayLike, PredictLike, StockLike, StoreLike } from '../src/coach';
import type { LlmLike, SpecVerifier } from '../src/atoms/prefetch';

test('the real modules fit the coach ports (compile-time)', () => {
  const fits = {
    monitor: {} as Monitor satisfies MonitorLike,
    pad: {} as AtomPad satisfies PadLike,
    placement: {} as PlacementRun satisfies PlacementLike,
    sprint: {} as Sprint satisfies SprintLike,
    stock: {} as Stock satisfies StockLike,
    specs: {} as SpecController satisfies SpecsLike,
    verifier: {} as SpecController satisfies SpecVerifier,
    predict: {} as PredictFlow satisfies PredictLike,
    whatIf: {} as WhatIfFlow satisfies WhatIfLike,
    hints: {} as HintDisplay satisfies HintDisplayLike,
    tempo: {} as TempoBar satisfies TempoSink,
    gate: {} as GateUi satisfies GateRunner,
    llm: {} as Llm satisfies LlmLike,
    store: {} as Store satisfies StoreLike,
  };
  assert.equal(Object.keys(fits).length, 14);
});
