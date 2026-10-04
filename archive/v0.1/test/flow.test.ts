import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Coach } from '../src/coach';
import { emptyLearner } from '../src/learner';
import { StuckDetector } from '../src/stuck';
import * as S from '../src/schemas';
import { Learner, Project } from '../src/types';
import { stubState, EventEmitter } from './vscode-stub';

// ---------------------------------------------------------------- fakes

type Responder = (prompt: string) => unknown;

class FakeLlm {
  calls: { schema: string; prompt: string }[] = [];
  queue = new Map<z.ZodType, Responder[]>();
  on(schema: z.ZodType, ...rs: Responder[]): this {
    this.queue.set(schema, [...(this.queue.get(schema) ?? []), ...rs]);
    return this;
  }
  async json({ prompt, schema }: { prompt: string; schema: z.ZodType }) {
    const name = Object.entries(S).find(([, v]) => v === schema)?.[0] ?? '?';
    this.calls.push({ schema: name, prompt });
    const q = this.queue.get(schema);
    const r = q?.shift();
    if (!r) throw new Error(`no fake response queued for ${name}`);
    // Validate the fake against the real schema so the test catches schema drift.
    return schema.parse(r(prompt));
  }
  count(name: string) {
    return this.calls.filter((c) => c.schema === name).length;
  }
}

class FakeMonitor {
  detector = new StuckDetector();
  touchedFiles = new Set<string>();
  tick = new EventEmitter<number>();
  onTick = this.tick.event;
  startTask() {
    this.detector = new StuckDetector();
  }
  currentErrors() {
    return [];
  }
}

function setup() {
  const store = {
    learner: emptyLearner() as Learner,
    project: undefined as Project | undefined,
    save() {},
    async flush() {},
  };
  const llm = new FakeLlm();
  const monitor = new FakeMonitor();
  const coach = new Coach(store as never, llm as never, monitor as never);
  return { store, llm, monitor, coach };
}

const plan = () => ({
  title: 'Todo CLI',
  summary: 'A command line todo app.',
  language: 'Python',
  concepts: [
    { id: 'variables', name: 'Variables', description: '', prerequisites: [] },
    { id: 'lists', name: 'Lists', description: '', prerequisites: ['variables'] },
    { id: 'file-io', name: 'File IO', description: '', prerequisites: ['lists'] },
  ],
  milestones: [
    {
      title: 'Basics',
      tasks: [
        { title: 'Add a todo', description: 'Store todos in memory', acceptanceCriteria: ['can add'], conceptIds: ['lists'], estimatedMinutes: 15 },
        { title: 'Save todos', description: 'Persist to JSON', acceptanceCriteria: ['survives restart'], conceptIds: ['file-io'], estimatedMinutes: 30 },
      ],
    },
  ],
});

const grade = (correct: boolean) => () => ({ correct, score: correct ? 1 : 0, feedback: correct ? 'Yes.' : 'No, because…', misconception: correct ? '' : 'thinks lists are immutable' });

// ---------------------------------------------------------------- the full loop

test('goal → placement → explain gate → lesson → build → hints → done → follow-up', async () => {
  const { store, llm, monitor, coach } = setup();
  llm
    .on(S.PlanSchema, plan)
    .on(S.DiagnosticSchema, () => ({
      questions: [
        { conceptId: 'variables', format: 'predict-output', question: 'x=1; x+=1; print(x)?', code: '' },
        { conceptId: 'lists', format: 'explain', question: 'What does append do?', code: '' },
      ],
    }));

  await coach.startProject('todo app', 'some JS');
  const p = store.project!;
  assert.equal(p.title, 'Todo CLI');
  assert.equal(Object.keys(p.tasks).length, 2);
  assert.ok(p.diagnostic && !p.diagnostic.done);
  assert.equal(coach.inputMode().mode, 'diagnostic');

  // Placement: right on variables, "I don't know" on lists (no model call).
  llm.on(S.GradeSchema, grade(true));
  await coach.submit('2');
  assert.ok(store.learner.concepts.variables.mastery >= 0.5);
  await coach.answerDiagnostic(null);
  assert.ok(store.learner.concepts.lists.mastery <= 0.15);
  assert.ok(store.learner.concepts['file-io'].mastery <= 0.3, 'failed prerequisite caps dependents');
  assert.equal(llm.count('GradeSchema'), 1);

  // First task starts in the explain gate, with the placement summary kept on top.
  const t = coach.task!;
  assert.equal(t.title, 'Add a todo');
  assert.equal(t.phase, 'explain');
  assert.equal(t.feed[0].title, 'Placement done');

  // Explanation reveals a gap → micro-lesson + check question.
  llm
    .on(S.ExplanationReviewSchema, () => ({ verdict: 'gaps', feedback: 'How will you store many todos?', gaps: [{ conceptId: 'lists', issue: 'no collection' }], probingQuestion: '' }))
    .on(S.LessonSchema, () => ({ title: 'Lists', explanation: 'A list holds many values.', example: '```py\nxs=[1]\n```', keyPoints: ['ordered'], checkQuestion: 'xs=[1]; xs.append(2); len(xs)?', checkExpected: '2' }));
  await coach.submit('I will use a variable');
  assert.equal(t.phase, 'learning');
  assert.equal(t.resumePhase, 'explain');
  assert.equal(coach.inputMode().mode, 'check');

  // Wrong once → retry; then right → back to explain.
  llm.on(S.GradeSchema, grade(false), grade(true));
  await coach.submit('1');
  assert.equal(t.phase, 'learning', 'gets a second try');
  assert.equal(store.learner.mistakes.length, 1);
  await coach.submit('2');
  assert.equal(t.phase, 'explain');

  llm.on(S.ExplanationReviewSchema, () => ({ verdict: 'ready', feedback: 'Workable.', gaps: [], probingQuestion: 'What if the list is empty?' }));
  await coach.submit('Keep todos in a list and append new ones');
  assert.equal(t.phase, 'building');
  assert.equal(coach.inputMode().mode, 'building');

  // Two rungs of hints, each different, then "I got it" → explain-back → back to building.
  llm.on(
    S.HintSchema,
    () => ({ diagnosis: 'appends to a new list each call', stuckType: 'slip', conceptIds: ['lists'], hint: 'Where is the list created?', mistakePattern: 'recreating state inside a function' }),
    (prompt) => {
      assert.match(prompt, /Hints already given/);
      assert.match(prompt, /Skeleton|Concept/);
      return { diagnosis: 'same', stuckType: 'concept-gap', conceptIds: ['lists'], hint: 'Lists are…', mistakePattern: '' };
    },
  );
  await coach.hint();
  await coach.hint();
  assert.equal(t.hints.length, 2);
  assert.deepEqual(t.hints.map((h) => h.rung), [1, 2]);
  assert.ok(t.feed.at(-1)!.actions!.some((a) => a.command === 'teach'), 'concept gap offers a lesson');

  coach.gotIt();
  assert.equal(t.phase, 'explain-back');
  llm.on(S.GradeSchema, grade(true));
  await coach.submit('The list was recreated on every call, so I moved it out.');
  assert.equal(t.phase, 'building');
  assert.equal(t.status, 'active');

  // Check work: not done, then done → explain-back → completion → follow-up.
  llm.on(
    S.WorkReviewSchema,
    () => ({ meetsCriteria: false, summary: 'Close.', issues: [{ severity: 'blocker', prompt: 'What happens on empty input?' }], mistakePatterns: [], explainBackQuestion: '' }),
    () => ({ meetsCriteria: true, summary: 'Works.', issues: [], mistakePatterns: [], explainBackQuestion: 'Why is the list global?' }),
  );
  await coach.checkWork();
  assert.equal(t.phase, 'building');
  await coach.checkWork();
  assert.equal(t.phase, 'explain-back');

  t.activeMs = 20 * 60_000;
  llm
    .on(S.GradeSchema, grade(true))
    .on(S.FollowUpSchema, () => ({ title: 'Remove a todo', description: 'Delete by index', acceptanceCriteria: ['can remove'], conceptIds: ['lists'], estimatedMinutes: 15, why: 'index practice' }));
  await coach.submit('So it persists across calls');
  assert.equal(t.status, 'done');
  assert.equal(store.learner.totals.tasksDone, 1);
  assert.equal(store.learner.totals.hintsUsed, 2);

  // Follow-up sits right after its parent in the roadmap, and the next card offers it.
  const ids = p.milestones[0].taskIds;
  const fu = p.tasks[ids[1]];
  assert.equal(fu.kind, 'followup');
  assert.equal(fu.parentId, t.id);
  assert.equal(fu.followUpDepth, 1);
  const offer = t.feed.at(-1)!;
  assert.equal(offer.actions![0].arg, fu.id);
  assert.equal(offer.actions![1].arg, ids[2], 'can skip to the next roadmap task');

  coach.startTask(fu.id);
  assert.equal(coach.task!.id, fu.id);
  assert.equal(coach.task!.phase, 'explain');
  assert.ok(monitor.detector instanceof StuckDetector);
});

test('stuck detection offers each hint rung once and "I\'m fine" re-arms it', async () => {
  const { store, llm, monitor, coach } = setup();
  stubState.config = { proactiveHints: 'offer', stuckThresholdMinutes: 4 };
  llm.on(S.PlanSchema, plan).on(S.DiagnosticSchema, () => ({ questions: [] }));
  await coach.startProject('todo', '');
  const t = coach.task!;
  coach.skipExplain();
  assert.equal(t.phase, 'building');

  // Drive 10 minutes of focused activity with no progress.
  let now = Date.now();
  for (let i = 0; i < 120; i++) {
    now += 5000;
    monitor.detector.onEdit(now, 3, 3);
    const added = monitor.detector.tick(now, true);
    monitor.tick.fire(added);
  }
  assert.ok(coach.signals!.score >= 1);
  const offers = t.feed.filter((c) => c.title === 'Looks like you might be stuck');
  assert.equal(offers.length, 1, 'offered exactly once');
  assert.equal(t.offeredRung, 1);
  assert.ok(t.activeMs > 9 * 60_000);

  coach.imFine();
  assert.equal(t.offeredRung, 0);
  assert.equal(monitor.detector.activeMsSinceProgress, 0);
  void store;
  stubState.config = {};
});

test('"I have no idea" twice escalates from a lesson to a guided walkthrough', async () => {
  const { llm, coach } = setup();
  llm.on(S.PlanSchema, plan).on(S.DiagnosticSchema, () => ({ questions: [] }));
  await coach.startProject('todo', '');
  const t = coach.task!;
  llm.on(S.LessonSchema, () => ({ title: 'L', explanation: 'e', example: 'x', keyPoints: [], checkQuestion: 'q', checkExpected: 'a' }));
  await coach.noIdea();
  assert.equal(t.phase, 'learning');
  llm.on(S.GradeSchema, grade(true));
  await coach.submit('a');
  assert.equal(t.phase, 'explain');
  llm.on(S.AnswerSchema, () => ({ answer: 'Step 1…', conceptIds: [] }));
  await coach.noIdea();
  assert.equal(t.feed.at(-1)!.title, 'How to think about this task');
  assert.equal(t.phase, 'explain');
});

test('reveal requires confirmation and marks the task', async () => {
  const { llm, coach } = setup();
  llm.on(S.PlanSchema, plan).on(S.DiagnosticSchema, () => ({ questions: [] }));
  await coach.startProject('todo', '');
  coach.skipExplain();
  stubState.warningAnswer = undefined;
  await coach.reveal();
  assert.equal(coach.task!.revealed, false);
  stubState.warningAnswer = 'Reveal';
  llm.on(S.RevealSchema, () => ({ explanation: 'because', code: '```py\nx\n```', rebuildChallenge: 'do y' }));
  await coach.reveal();
  assert.equal(coach.task!.revealed, true);
  stubState.warningAnswer = undefined;
});

test('model errors surface as an error card and release the busy lock', async () => {
  const { llm, coach } = setup();
  llm.on(S.PlanSchema, plan).on(S.DiagnosticSchema, () => ({ questions: [] }));
  await coach.startProject('todo', '');
  coach.skipExplain();
  await coach.hint(); // nothing queued → fake throws
  assert.equal(coach.busy, undefined);
  assert.equal(coach.task!.feed.at(-1)!.kind, 'error');
  assert.equal(coach.task!.hints.length, 0);
});

test('code context never shows a fixed failure as current, and flags output older than the code', async () => {
  const { gatherCodeContext } = await import('../src/context');
  const monitor = new FakeMonitor() as FakeMonitor & { lastEditAt: number };
  monitor.detector.onTerminal(1000, 'python main.py', 1, 'NameError: foo');
  monitor.lastEditAt = 2000;
  let ctx = await gatherCodeContext(monitor as never);
  assert.match(ctx, /FAILED \(exit 1\)/);
  assert.match(ctx, /edited AFTER this run/);
  monitor.detector.onTerminal(3000, 'python main.py', 0, 'ok');
  ctx = await gatherCodeContext(monitor as never);
  assert.doesNotMatch(ctx, /NameError/);
  assert.match(ctx, /succeeded \(exit 0\)/);
});

test('a re-check is told what the previous check said and to judge only the current code', async () => {
  const { llm, coach } = setup();
  llm.on(S.PlanSchema, plan).on(S.DiagnosticSchema, () => ({ questions: [] }));
  await coach.startProject('todo', '');
  coach.skipExplain();
  llm.on(
    S.WorkReviewSchema,
    () => ({ meetsCriteria: false, summary: 'Crashes on empty input.', issues: [{ severity: 'blocker', prompt: 'What happens when the file is empty?' }], mistakePatterns: [], explainBackQuestion: '' }),
    () => ({ meetsCriteria: false, summary: 'Empty input fixed; one more.', issues: [], mistakePatterns: [], explainBackQuestion: '' }),
  );
  await coach.checkWork();
  assert.doesNotMatch(llm.calls.at(-1)!.prompt, /RE-CHECK/);
  await coach.checkWork();
  const prompt = llm.calls.at(-1)!.prompt;
  assert.match(prompt, /RE-CHECK/);
  assert.match(prompt, /What happens when the file is empty\?/);
  assert.match(prompt, /Judge ONLY the current code/);
});
