// src/atoms/prefetch.ts: the background prefetcher's pure helpers and its job flows, with a fake LLM
// and a real JobQueue.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { Gen, Runner } from '../src/contracts';
import { JobQueue } from '../src/jobs';
import { emptyLearner, upsertConcepts } from '../src/learner';
import * as S from '../src/schemas';
import type { SpecLadderDraft, VerifyFailure, VerifyResult } from '../src/specsCore';
import type { Learner, PrefetchEntry, Project, Task } from '../src/types';
import { AtomCache } from '../src/atoms/cache';
import { taxonomyFor } from '../src/atoms/prompts';
import {
  knownConstructs, lruPut, matchPrep, packKey, Prefetcher, sanitizeGate, specState, type HintContext, type PrefetchDeps,
} from '../src/atoms/prefetch';

// ---------------------------------------------------------------- fakes

type Responder = (prompt: string) => unknown;

class FakeLlm {
  calls: { schema: string; prompt: string; effort?: string; fast?: boolean }[] = [];
  private readonly queue = new Map<z.ZodType, Responder[]>();
  on(schema: z.ZodType, ...rs: Responder[]): this {
    this.queue.set(schema, [...(this.queue.get(schema) ?? []), ...rs]);
    return this;
  }
  async json<T extends z.ZodType>({ prompt, schema, effort }: { prompt: string; schema: T; effort?: string }, opts: { fast?: boolean } = {}): Promise<z.infer<T>> {
    const name = Object.entries(S).find(([, v]) => (v as unknown) === schema)?.[0] ?? '?';
    this.calls.push({ schema: name, prompt, effort, fast: opts.fast });
    const r = this.queue.get(schema)?.shift();
    if (!r) throw new Error(`no fake response for ${name}`);
    return schema.parse(r(prompt));
  }
  count(name: string): number {
    return this.calls.filter((c) => c.schema === name).length;
  }
}

const runner: Runner = {
  runtime: { lang: 'python', exe: 'python', snippetArgv: [], learnerArgv: [], version: '3.14.0' },
  runBatch: async () => [],
  runLearnerCode: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, ms: 1 }),
};

function project(): Project {
  return {
    goal: 'todo app', title: 'Todo', summary: 'A todo CLI', language: 'python', lang: 'python', createdAt: 7, conceptIds: [], milestones: [],
    tasks: {}, feed: [], placement: { asked: [], startedAt: 0, done: true, selfRated: false, planPending: false, calibrated: true }, prefetch: {}, taskSwitch: 0,
  };
}

function task(id: string, title: string, over: Partial<Task> = {}): Task {
  return {
    id, title, description: `${title}.`, acceptanceCriteria: ['works'], conceptIds: ['todo-list'], estimatedMinutes: 10, kind: 'roadmap',
    followUpDepth: 0, status: 'todo', phase: 'building', activeMs: 0, stuckMs: 0, explainAttempts: 0, hints: [], revealed: false, offeredRung: 0,
    feed: [], interface: { file: 'todo.py', functions: [{ name: 'add_todo', signature: 'add_todo(todos, text)', purpose: 'adds' }] }, ...over,
  };
}

function setup(over: Partial<PrefetchDeps> = {}) {
  const learner = emptyLearner() as Learner;
  upsertConcepts(learner, [
    { id: 'todo-list', name: 'A list of todos', tag: 'other' },
    { id: 'json-x', name: 'JSON parsing', tag: 'other' },
    { id: 'list-indexing', name: 'List indexing', tag: 'list-indexing' },
  ]);
  const p = project();
  const llm = new FakeLlm();
  const jobs = new JobQueue({ currentGen: (): Gen => ({ projectCreatedAt: p.createdAt, taskId: p.currentTaskId, taskSwitch: p.taskSwitch }) });
  const cache = new AtomCache('python');
  const refills: string[] = [];
  const verified: SpecLadderDraft[] = [];
  const content: string[] = [];
  const pf = new Prefetcher({
    jobs, llm, gen: () => ({ projectCreatedAt: p.createdAt, taskId: p.currentTaskId, taskSwitch: p.taskSwitch }),
    project: () => p, learner: () => learner, runner: () => undefined, allowRun: () => true, cache: () => cache,
    seeds: () => ({ hasSeeds: (tag) => tag === 'list-indexing', refillIfLow: (k) => (refills.push(k), undefined) }),
    specs: {
      verifyLadder: async (draft, _iface, o) => {
        verified.push({ ...draft });
        const failures: VerifyFailure[] = draft.specs.filter((s) => s.id === 'bad').map((s) => ({ id: s.id, reason: 'reference fails', actual: '[]' }));
        let specs = draft.specs.filter((s) => s.id !== 'bad');
        if (failures.length && o.repair) {
          const fixed = await o.repair(failures);
          specs = [...specs, ...(fixed?.specs ?? []).filter((s) => s.id === 'bad')];
        }
        return { applicable: specs.length >= 3, verified: true, specs, hidden: draft.hidden, dropped: [], repaired: !!failures.length } as VerifyResult;
      },
    },
    workspace: { fileList: async () => 'todo.py', read: async () => 'def add_todo(todos, text):\n    pass\n' },
    contentLog: (l) => content.push(l),
    ...over,
  });
  return { pf, p, llm, jobs, cache, learner, refills, verified, content };
}

const spec = (id: string) => ({ id, title: `behaviour ${id}`, conceptId: 'todo-list', call: `add_todo([], "${id}")`, expected: `['${id}']`, expectError: '', parSec: 60, failureSignatures: [] });

const gate = () => ({
  patterns: ['Append to a list', 'Count with dict', 'Sort with a key', 'Recursion', 'Use a set'].map((name, i) => ({
    name, conceptId: i === 0 ? 'todo-list' : 'json-x', required: i === 0, competesWith: i === 0 ? '' : 'todo-list', useWhen: 'x', whyNot: i ? 'no' : '',
  })),
  plans: [
    { text: 'Append each todo to one list', workable: true, flawConceptId: '', misconceptionId: '', whyFlawed: '' },
    { text: 'Make a new list for each todo', workable: false, flawConceptId: 'todo-list', misconceptionId: 'list-recreated', whyFlawed: 'Earlier todos?' },
    { text: 'Keep todos in a single string', workable: false, flawConceptId: 'todo-list', misconceptionId: '', whyFlawed: 'Remove one?' },
  ],
});

const probe = (id: string, g: string, a: number, b: number) => ({
  id, siblingGroup: g, code: `xs = [${a}, ${b}]\nprint(xs[0])`, answer: `${a}`, parSec: 4,
  mutants: [{ misconceptionId: 'index-starts-at-one', belief: 'indexes start at one', refutation: 'Python counts positions from zero.', code: `xs = [${a}, ${b}]\nprint(xs[1])`, prints: `${b}` }],
});

const pack = (conceptId: string) => ({
  atoms: [{
    conceptId, tag: 'other',
    pattern: { kind: 'shape', name: 'Index a list', useWhen: 'pick one item', template: 'xs[<i>]', rule: '', howItRuns: '', pitfall: 'starts at zero', useCases: ['a', 'b', 'c', 'd', 'e', 'f'] },
    probes: [probe('p1', 'names', 3, 4), probe('p2', 'data', 7, 8)],
    example: { code: 'xs = [5, 6]\nfirst = xs[0]\nprint(first)', subgoals: [{ line: 2, label: 'take the first' }] },
    completion: { code: '', solutions: [], wrongFills: [], harness: '', parSec: 20 },
    contrast: { wrong: '', right: '', misconceptionId: '', rule: '' },
  }],
});

const tick = () => new Promise((r) => setImmediate(r));
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await tick();
}

// ---------------------------------------------------------------- pure helpers

test('lruPut keeps the 50 most recently used entries', () => {
  const store: Record<string, PrefetchEntry> = {};
  for (let i = 0; i < 55; i++) lruPut(store, `k${i}`, { at: i, value: i });
  assert.equal(Object.keys(store).length, 50);
  assert.equal('k0' in store, false);
  assert.equal('k54' in store, true);
  lruPut(store, 'k5', { at: 100, value: 'fresh' }, 3);
  assert.deepEqual(Object.keys(store).sort(), ['k5', 'k53', 'k54']);
});

test('matchPrep matches by title, then normalised title, then position', () => {
  const ts = [{ title: 'Add a todo' }, { title: 'List todos!' }, { title: 'Parse' }];
  const prep = { tasks: [{ taskTitle: 'list todos', gate: gate(), specs: undefined as never }, { taskTitle: 'Add a todo', gate: gate(), specs: undefined as never }, { taskTitle: 'zzz', gate: gate(), specs: undefined as never }] };
  const m = matchPrep(ts, prep as never);
  assert.equal(m.get(ts[0])!.taskTitle, 'Add a todo');
  assert.equal(m.get(ts[1])!.taskTitle, 'list todos');
  assert.equal(m.get(ts[2])!.taskTitle, 'zzz');
});

test('packKey: the tag when the concept owns it, else the concept id', () => {
  const l = emptyLearner() as Learner;
  upsertConcepts(l, [{ id: 'closure-capture', name: 'Closures', tag: 'closure-capture' }, { id: 'a', name: 'A', tag: 'json-parse-serialize' }, { id: 'b', name: 'B', tag: 'json-parse-serialize' }, { id: 'c', name: 'C', tag: 'other' }]);
  assert.equal(packKey(l, l.concepts['closure-capture']), 'closure-capture');
  assert.equal(packKey(l, l.concepts.a), 'a', 'several project concepts on one tag get their own packs');
  assert.equal(packKey(l, l.concepts.c), 'c');
  const solo = emptyLearner() as Learner;
  upsertConcepts(solo, [{ id: 'parse-json', name: 'Parse JSON', tag: 'json-parse-serialize' }]);
  assert.equal(packKey(solo, solo.concepts['parse-json']), 'json-parse-serialize');
});

test('sanitizeGate resolves concept ids through aliases; specState starts an empty run state', () => {
  const l = emptyLearner() as Learner;
  upsertConcepts(l, [{ id: 'list-mutation-methods', name: 'List methods', tag: 'list-mutation-methods' }]);
  upsertConcepts(l, [{ id: 'todo-list', name: 'Todos', tag: 'list-mutation-methods' }]);
  const g = sanitizeGate(l, gate() as never)!;
  assert.equal(g.patterns[0].conceptId, 'list-mutation-methods');
  assert.equal(g.plans[1].flawConceptId, 'list-mutation-methods');
  assert.equal(sanitizeGate(l, { patterns: [], plans: [] } as never), undefined);
  const s = specState({ applicable: true, verified: true, specs: [spec('a')], hidden: [], dropped: [], repaired: false, importMs: 30 });
  assert.deepEqual([s.greenAt, s.runs, s.importMs], [{}, 0, 30]);
  assert.ok(knownConstructs(l, 'python').includes('variables'));
});

// ---------------------------------------------------------------- jobs

test('TaskPrep: one medium call for up to 3 tasks, ladders verified with a low-effort repair, the reference dropped', async () => {
  const { pf, p, llm, verified } = setup({ runner: () => runner });
  const ts = [task('t1', 'Add a todo'), task('t2', 'List todos'), task('t3', 'Parse'), task('t4', 'Save')];
  for (const t of ts) p.tasks[t.id] = t;
  llm.on(S.TaskPrepSchema, () => ({
    tasks: ['Add a todo', 'List todos', 'Parse'].map((title) => ({
      taskTitle: title, gate: gate(),
      specs: { applicable: true, reason: '', specs: [spec('a'), spec('b'), spec('bad')], hidden: [spec('h')], reference: 'SECRET_REFERENCE' },
    })),
  }));
  llm.on(S.SpecLadderPartSchema, ...[1, 2, 3].map(() => () => ({ applicable: true, reason: '', specs: [spec('bad')], hidden: [], reference: '' })));
  let applied: unknown[] = [];
  const out = await pf.taskPrep(ts, { lang: 'python', runtime: 'Python 3.14.0', runLang: 'python', neededBy: Date.now() + 60_000 }, (r) => (applied = r));
  assert.equal(llm.count('TaskPrepSchema'), 1);
  assert.equal(llm.calls[0].effort, 'medium');
  assert.equal(llm.calls[0].fast, false);
  assert.match(llm.calls[0].prompt, /1\. Add a todo/);
  assert.doesNotMatch(llm.calls[0].prompt, /Save/, 'at most 3 tasks per call');
  assert.equal(llm.count('SpecLadderPartSchema'), 3, 'one repair call per failing ladder');
  assert.ok(llm.calls.filter((c) => c.schema === 'SpecLadderPartSchema').every((c) => c.effort === 'low' && !c.prompt.includes('SECRET_REFERENCE')));
  assert.equal(verified[0].reference, 'SECRET_REFERENCE');
  assert.equal(out!.length, 3);
  assert.equal(applied.length, 3);
  assert.equal(out![0].spec!.specs.length, 3, 'the repaired spec is back');
  assert.equal(JSON.stringify(out).includes('SECRET_REFERENCE'), false);
  assert.equal(out![0].gate!.patterns.length, 5);
  assert.equal(ts[0].prep!.state, 'done');
  assert.equal(pf.prepInFlight('t1'), false);
});

test("TaskPrep lists the known misconception ids of its tasks' tags and asks for escaped literals", async () => {
  const { pf, p, llm } = setup({ runner: () => runner });
  const t1 = task('t1', 'Pick an item', { conceptIds: ['list-indexing'] });
  const t2 = task('t2', 'Add a todo');
  p.tasks.t1 = t1;
  p.tasks.t2 = t2;
  llm.on(S.TaskPrepSchema, () => ({ tasks: [] }), () => ({ tasks: [] }));
  await pf.taskPrep([t1], { lang: 'python', runtime: 'Python 3.14.0', runLang: 'python' }, () => undefined);
  const prompt = llm.calls[0].prompt;
  const known = taxonomyFor(['list-indexing'], 'python');
  assert.ok(known.length > 0);
  assert.ok(prompt.includes(`Known misconception ids for these concepts (reuse one whenever it fits): list-indexing: ${known[0].id} (${known[0].belief})`), prompt);
  for (const m of known) assert.ok(prompt.includes(m.id), m.id);
  assert.match(prompt, /inside a string literal write a newline or tab as the escape \\n or \\t, never as the character itself/);
  // Live gates ran 47-51 words: canonical names take ~21, so 10-word plans overflow GATE.maxWords.
  assert.match(prompt, /The 5 pattern names and the 3 plans together must total <= 50 words/);
  // Only 'other' concepts: no list.
  await pf.taskPrep([t2], { lang: 'python', runtime: 'Python 3.14.0', runLang: 'python' }, () => undefined);
  assert.doesNotMatch(llm.calls[1].prompt, /Known misconception ids/);
});

test('TaskPrep without a runtime keeps the gate pack and says why there is no ladder', async () => {
  const { pf, p, llm } = setup({ specs: undefined });
  const t = task('t1', 'Add a todo');
  p.tasks.t1 = t;
  llm.on(S.TaskPrepSchema, () => ({ tasks: [{ taskTitle: 'Add a todo', gate: gate(), specs: { applicable: true, reason: '', specs: [spec('a')], hidden: [], reference: 'x' } }] }));
  const out = await pf.taskPrep([t], { lang: 'python', runtime: 'Python', runLang: 'python' }, () => undefined);
  assert.ok(out![0].gate);
  assert.equal(out![0].spec, undefined);
  assert.match(out![0].reason!, /no local runtime/);
});

test('packs: seeded tags refill locally; others get 1-2 concept packs with one repair round; total failure -> probeable false', async () => {
  const { pf, llm, cache, learner, refills } = setup();
  upsertConcepts(learner, [{ id: 'yaml-x', name: 'YAML', tag: 'other' }, { id: 'csv-x', name: 'CSV', tag: 'other' }]);
  llm.on(S.AtomPackSchema, () => pack('json-x'), () => ({ atoms: [] }), () => ({ atoms: [] }), () => ({ atoms: [] }));
  const jobs = pf.prepareConcepts('python', ['list-indexing', 'json-x', 'yaml-x', 'csv-x'], { priority: 1 });
  assert.deepEqual(refills, ['list-indexing'], 'seeded tag: local refill, no model call');
  assert.equal(jobs.length, 2, '3 concepts -> 2 calls (2 + 1)');
  await Promise.all(jobs);
  const first = llm.calls[0];
  assert.equal(first.schema, 'AtomPackSchema');
  assert.equal(first.effort, 'medium');
  assert.match(first.prompt, /json-x, other, shape/);
  assert.ok(cache.has('json-x'), 'the accepted (unverified, no runtime) atom is cached');
  assert.equal(cache.get('json-x')!.verified, false);
  assert.equal(learner.concepts['json-x'].probeable, true);
  assert.equal(learner.concepts['csv-x'].probeable, false, 'no atom in either round');
  assert.ok(llm.calls.some((c) => c.effort === 'low' && /failed when run locally/.test(c.prompt)), 'one low-effort repair round');
  assert.equal(pf.packCandidates('python', ['json-x', 'csv-x']).length, 0, 'cached or unprobeable concepts are not asked again');
});

test('mini atom: low effort in the caller lane, then the full pack in the background at priority 3', async () => {
  const { pf, llm, cache } = setup();
  llm.on(S.AtomPackSchema, () => pack('json-x'), () => pack('json-x'));
  const ac = new AbortController();
  const atom = await pf.miniAtom('python', 'json-x', ac.signal);
  assert.equal(atom?.conceptId, 'json-x');
  assert.equal(llm.calls[0].effort, 'low');
  assert.notEqual(llm.calls[0].fast, false, 'foreground: codexFast applies');
  assert.match(llm.calls[0].prompt, /Write the pattern, 2 probes/);
  await settle();
  assert.ok(cache.has('json-x'));
  assert.equal(llm.calls.filter((c) => c.schema === 'AtomPackSchema' && c.effort === 'medium').length, 1, 'the full pack follows in the background');
});

test('escalation lesson: a stored one returns at once; a miss runs a low-effort priority-0 job and stores it', async () => {
  const { pf, p, llm } = setup();
  p.prefetch['lesson:json-x:m1'] = { at: 1, value: { title: 'T', explanation: 'E', example: 'X', rule: 'R' } };
  const hit = pf.lesson({ key: 'lesson:json-x:m1', conceptId: 'json-x', misconceptionId: 'm1', belief: 'b', items: [] }, 'python', 'Project: todo');
  assert.equal((hit as { title: string }).title, 'T');
  llm.on(S.EscalationLessonSchema, () => ({ title: 'Why zero', explanation: 'Because.', example: '```py\nprint([1][0])\n```', rule: 'Count from zero' }));
  const miss = await pf.lesson({ key: 'lesson:json-x:m2', conceptId: 'json-x', misconceptionId: 'm2', belief: 'starts at one', items: [{ code: 'print([1, 2][1])', answer: '1', actual: '2' }] }, 'python', 'Project: todo');
  assert.equal(miss?.title, 'Why zero');
  assert.equal(llm.calls.at(-1)!.effort, 'low');
  assert.match(llm.calls.at(-1)!.prompt, /The learner confirmed holding this wrong belief: starts at one \(misconception m2\)/);
  assert.equal((p.prefetch['lesson:json-x:m2'].value as { rule: string }).rule, 'Count from zero');
  // A failing job resolves undefined (never rejects).
  const none = await pf.lesson({ key: 'lesson:json-x:m3', conceptId: 'json-x', misconceptionId: 'm3', belief: 'b', items: [] }, 'python', '');
  assert.equal(none, undefined);
});

function hintCtx(t: Task, score: number): HintContext & { prompts: boolean[] } {
  const prompts: boolean[] = [];
  return {
    prompts, task: t, score, mode: 'offer', files: ['file:///ws/todo.py'], taskFileHash: async () => 'h1', mark: () => 0, errorSetHash: () => 'e1',
    changedLinesSince: () => 0, readLines: async () => ['def add_todo(todos, text):', '    todos.append(text)'],
    prompt: async (speculative) => (prompts.push(speculative), 'HINT PROMPT'),
  };
}

const ladder = (r2: string) => ({
  diagnosis: 'returns None', stuckType: 'concept-gap', conceptIds: ['todo-list'], misconceptionId: '', mistakePattern: '',
  anchor: { file: 'todo.py', line: 2, lineText: '    todos.append(text)' },
  rungs: [{ rung: 1, text: 'What does append return?' }, { rung: 2, text: r2 }, { rung: 3, text: 'Return the list.' }],
});

test('hint prefetch fires at stuck .6 (medium, hint kind, task scope) and validates rungs after parsing', async () => {
  const { pf, p, llm, jobs } = setup();
  const t = task('t1', 'Add a todo', { status: 'active' });
  p.tasks.t1 = t;
  p.currentTaskId = 't1';
  assert.equal(await pf.maybePrefetchHints(hintCtx(t, 0.5)), false, 'below .6 nothing fires');
  llm.on(S.HintLadderSchema, () => ladder('This is not a question.'));
  const ctx = hintCtx(t, 0.65);
  assert.equal(await pf.maybePrefetchHints(ctx), true);
  assert.deepEqual(ctx.prompts, [true]);
  await settle();
  assert.equal(llm.calls[0].effort, 'medium');
  assert.equal(jobs.stats().hintUsed, 1, 'drawn from the hint reserve');
  assert.equal(t.hintPrefetch!.rungs[0], 'What does append return?');
  assert.equal(t.hintPrefetch!.rungs[1], '', "rung 2 without '?' is dropped");
  assert.equal(await pf.maybePrefetchHints(hintCtx(t, 0.9)), false, 'a valid prefetch exists');
});

test('on-demand hints: the caller lane at low effort', async () => {
  const { pf, p, llm } = setup();
  const t = task('t1', 'Add a todo', { status: 'active' });
  p.tasks.t1 = t;
  p.currentTaskId = 't1';
  llm.on(S.HintLadderSchema, () => ladder('Which concept applies here?'));
  const lanes: string[] = [];
  const got = await pf.onDemandHints(hintCtx(t, 1.2), (label, run) => (lanes.push(label), run(new AbortController().signal)));
  assert.deepEqual(lanes, ['Preparing a hint']);
  assert.equal(llm.calls[0].effort, 'low');
  assert.equal(got!.rungs[1], 'Which concept applies here?');
});

test('PlanOutline failure reports its reason; TaskBatch and FollowUp are medium priority-1 background jobs', async () => {
  const { pf, p, llm } = setup();
  llm.on(S.PlanOutlineSchema, () => {
    throw new Error('network down');
  });
  const r = await pf.planOutline({ goal: 'g', background: '', lang: 'python', runtime: 'Python 3.14.0' }, () => assert.fail('no apply'));
  assert.deepEqual(r, { ok: false, reason: 'network down', stale: false });
  p.milestones = [{ title: 'M1', taskIds: [] }, { title: 'M2', goal: 'save', taskIds: [] }];
  llm.on(S.TaskBatchSchema, () => ({ tasks: [{ title: 'Save', description: 'd', acceptanceCriteria: [], conceptIds: ['todo-list'], estimatedMinutes: 15, interface: { file: 'todo.py', functions: [] } }] }));
  let got = 0;
  await pf.taskBatch(1, { lang: 'python', runtime: 'Python', fade: 'partial' }, (ts) => (got = ts.length));
  assert.equal(got, 1);
  assert.match(llm.calls.at(-1)!.prompt, /Write the tasks for milestone 2: M2 - save\. .*Scaffolding level: partial/s);
  assert.equal(llm.calls.at(-1)!.effort, 'medium');
});

test('low stock: seeded concepts refill locally, model concepts get a single low-effort refill pack', async () => {
  const { pf, llm, cache, learner, refills } = setup();
  const now = Date.now();
  learner.concepts['list-indexing'].nextReview = now - 1;
  learner.concepts['json-x'].fragile = true;
  cache.put({ key: 'json-x', lang: 'python', conceptId: 'json-x', tag: 'other', source: 'model', verified: true, createdAt: 0, pattern: pack('json-x').atoms[0].pattern as never, probes: [], examples: [], completions: [], contrasts: [], tracebacks: [] });
  llm.on(S.AtomPackSchema, () => ({ atoms: [] }), () => ({ atoms: [] }));
  assert.equal(pf.refillLowStock('python'), 1);
  assert.deepEqual(refills, ['list-indexing']);
  await settle();
  assert.equal(llm.calls[0].effort, 'low');
  assert.match(llm.calls[0].prompt, /json-x/);
});

test('a usage-limit pause flashes once (when asked to) and a missed neededBy is reported for its degraded path', async () => {
  const flashes: string[] = [];
  const late: string[] = [];
  const { pf, p, llm, jobs } = setup({ flash: (t) => void flashes.push(t), onLate: (e) => void late.push(e.key) });
  jobs.pause(1000, 'limit', true);
  assert.deepEqual(flashes, ['Plan limit: background prep paused 15 min']);
  jobs.pause(0, 'manual');
  const t = task('t1', 'Add a todo');
  p.tasks.t1 = t;
  let release!: (v: unknown) => void;
  llm.on(S.TaskPrepSchema, () => ({ tasks: [] }));
  const gate = new Promise((r) => (release = r));
  const origJson = llm.json.bind(llm);
  llm.json = (async (req: never, opts: never) => {
    await gate;
    return origJson(req, opts);
  }) as typeof llm.json;
  const job = pf.taskPrep([t], { lang: 'python', runtime: 'Python', neededBy: Date.now() - 1 }, () => undefined);
  await settle();
  assert.deepEqual(late, ['prep:t1']);
  assert.equal(pf.isLate('prep:t1'), true);
  release(undefined);
  await job;
  await settle();
  assert.equal(pf.isLate('prep:t1'), false, 'cleared once the job settles');
});
