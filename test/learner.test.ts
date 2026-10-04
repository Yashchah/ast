import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceRecord, isMastered } from '../src/evidence';
import {
  allMastered, bindEvidenceEnv, concept, conceptLine, DECOMPOSITION, dueForReview, emptyLearner, migrateLearner, nudge,
  recordEvidence, recordHintEvidence, recordMistake, recordSolve, recordTypingCalibration, setMastery, setPrior, snapshot,
  stuckThreshold, upsertConcepts,
} from '../src/learner';
import { Learner, Task } from '../src/types';

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1', title: 'T', description: '', acceptanceCriteria: [], conceptIds: ['loops'], estimatedMinutes: 20,
    kind: 'roadmap', followUpDepth: 0, status: 'active', phase: 'building', activeMs: 15 * 60_000, stuckMs: 0,
    explainAttempts: 1, hints: [], revealed: false, offeredRung: 0, feed: [], ...over,
  };
}

const hint = (rung: number) => ({ rung, at: 0, diagnosis: '', html: '' });

function learner(): Learner {
  const l = emptyLearner();
  upsertConcepts(l, [
    { id: 'Loops', name: 'Loops', description: '', prerequisites: [] },
    { id: 'recursion', name: 'Recursion', description: '', prerequisites: ['loops'] },
  ]);
  return l;
}

/** Earn mastery the only way the model allows: 2 sibling groups + a production item. */
function master(l: Learner, id: string): void {
  recordEvidence(l, { conceptId: id, kind: 'predict', source: 'atom', correct: true, g: 0.06, siblingGroup: 'a' });
  recordEvidence(l, { conceptId: id, kind: 'predict', source: 'atom', correct: true, g: 0.06, siblingGroup: 'b' });
  recordEvidence(l, { conceptId: id, kind: 'completion', source: 'atom', correct: true, siblingGroup: 'c', production: true });
}

test('concept ids are slugged and not duplicated', () => {
  const l = learner();
  upsertConcepts(l, [{ id: 'loops', name: 'Loops again', description: '', prerequisites: [] }]);
  assert.deepEqual(Object.keys(l.concepts).sort(), ['loops', 'recursion']);
  assert.equal(l.concepts.loops.name, 'Loops');
  assert.equal(l.concepts.loops.mastery, 0.3);
  assert.equal(l.concepts.loops.tested, false);
});

test('a plan concept with a seed tag merges into the seed concept as an alias; several for one tag build on it', () => {
  const l = emptyLearner();
  upsertConcepts(l, [{ id: 'list-slicing', name: 'List slicing', tag: 'list-slicing', kind: 'semantics' }]);
  upsertConcepts(l, [
    { id: 'slicing-lists', name: 'Slicing', description: '', prerequisites: ['list-basics'], tag: 'list-slicing' },
    { id: 'parse-rows', name: 'Parse rows', description: '', prerequisites: [], tag: 'string-split-join' },
    { id: 'write-csv', name: 'Write CSV', description: '', prerequisites: [], tag: 'other' },
    { id: 'csv-other', name: 'CSV other', description: '', prerequisites: [], tag: 'other' },
  ]);
  assert.equal(l.concepts['slicing-lists'], undefined);
  assert.deepEqual(l.concepts['list-slicing'].aliases, ['slicing-lists']);
  assert.ok(l.concepts['list-slicing'].prerequisites.includes('list-basics'));
  assert.equal(concept(l, 'Slicing Lists')?.id, 'list-slicing', 'lookups go through the alias map');
  assert.ok(l.concepts['write-csv'] && l.concepts['csv-other'], "'other' never merges");
  assert.equal(l.concepts['parse-rows'].tag, 'string-split-join');

  // Evidence on the plan id lands on the seed concept.
  const r = recordEvidence(l, { conceptId: 'slicing-lists', kind: 'predict', source: 'placement', correct: true, g: 0.06 });
  assert.equal(r?.evidence.conceptId, 'list-slicing');
  assert.equal(r3(l.concepts['list-slicing'].mastery), 0.734);

  // Many-to-one: keep the plan concepts, each with the seed concept as a prerequisite.
  upsertConcepts(l, [
    { id: 'slice-head', name: 'Head', description: '', prerequisites: [], tag: 'list-slicing' },
    { id: 'slice-tail', name: 'Tail', description: '', prerequisites: [], tag: 'list-slicing' },
  ]);
  assert.deepEqual(l.concepts['slice-head'].prerequisites, ['list-slicing']);
  assert.deepEqual(l.concepts['slice-tail'].prerequisites, ['list-slicing']);
});

test('recordEvidence fills the record, resolves the concept and appends to the bound log', () => {
  const l = learner();
  const log: EvidenceRecord[] = [];
  bindEvidenceEnv(l, { log: (e) => log.push(e), window: 'win-a' });
  const r = recordEvidence(l, { conceptId: 'LOOPS', kind: 'predict', source: 'atom', correct: null, g: 0.06 });
  assert.equal(log.length, 1);
  assert.equal(log[0], r!.evidence);
  assert.equal(log[0].conceptId, 'loops');
  assert.equal(log[0].window, 'win-a');
  assert.equal(log[0].weight, 0.5, "'?' is logged at its effective weight");
  assert.ok(log[0].bits > 0 && log[0].id && log[0].at > 0);
  assert.equal(recordEvidence(l, { conceptId: 'nope', kind: 'predict', source: 'atom', correct: true }), undefined);
  assert.equal(log.length, 1, 'unknown concepts are not logged');
  // Another learner object has its own (empty) binding.
  recordEvidence(learner(), { conceptId: 'loops', kind: 'predict', source: 'atom', correct: true });
  assert.equal(log.length, 1);
});

test('nudge is a deprecated llm-grade wrapper: half weight, bounded, and it never masters', () => {
  const l = learner();
  for (let i = 0; i < 50; i++) nudge(l, ['loops'], 0.3);
  assert.equal(l.concepts.loops.mastery, 0.8, 'capped until production evidence');
  assert.equal(allMastered(l, ['loops']), false);
  for (let i = 0; i < 50; i++) nudge(l, ['loops'], -0.3);
  // Half-weight wrong evidence with T .05 settles near .13 (the learning transition keeps a floor).
  assert.ok(l.concepts.loops.mastery > 0.1 && l.concepts.loops.mastery < 0.15);
  const before = l.concepts.loops.mastery;
  nudge(l, ['loops'], 0);
  assert.equal(l.concepts.loops.mastery, before);
});

test('recordSolve emits task evidence: unaided is correct, rung 1-2 correct with slip .2, rung 3+, reveal or paste wrong', () => {
  const run = (over: Partial<Task>) => {
    const l = learner();
    recordSolve(l, task(over));
    return l;
  };
  const unaided = run({});
  const rung2 = run({ hints: [hint(1), hint(2)] });
  const rung4 = run({ hints: [hint(4)] });
  const revealed = run({ revealed: true });
  const pasted = run({ pastedChars: 80, assistedChars: 40 });
  assert.equal(r3(unaided.concepts.loops.mastery), 0.584);
  assert.equal(r3(rung2.concepts.loops.mastery), 0.557);
  assert.equal(r3(rung4.concepts.loops.mastery), 0.113);
  assert.equal(r3(revealed.concepts.loops.mastery), 0.113);
  assert.equal(r3(pasted.concepts.loops.mastery), 0.113, '120+ pasted/assisted characters is not an unaided solve');
  assert.equal(revealed.totals.reveals, 1);
  assert.equal(rung2.totals.hintsUsed, 2);
  assert.equal(rung2.concepts.loops.attempts, 1);
  assert.deepEqual(unaided.concepts.loops.solveTimesMin, [15]);
  assert.equal(unaided.concepts[DECOMPOSITION], undefined);

  const solo = learner();
  recordSolve(solo, task(), { solo: true });
  assert.equal(r3(solo.concepts[DECOMPOSITION].mastery), 0.584, 'solo tasks also measure decomposition');
});

test('hint evidence by rung: 1 at .3, 2 at .5, 3 on decomposition, reveal at full weight', () => {
  const l = learner();
  const log: EvidenceRecord[] = [];
  bindEvidenceEnv(l, { log: (e) => log.push(e) });
  recordHintEvidence(l, 't1', 1, ['loops']);
  recordHintEvidence(l, 't1', 3, ['loops']);
  recordHintEvidence(l, 't1', 4, ['loops']);
  recordHintEvidence(l, 't1', 'reveal', ['loops']);
  assert.deepEqual(log.map((e) => [e.conceptId, e.weight, e.correct, e.source]), [
    ['loops', 0.3, false, 'hint'],
    [DECOMPOSITION, 0.5, false, 'hint'],
    ['loops', 0.5, false, 'hint'],
    [DECOMPOSITION, 0.5, false, 'hint'],
    ['loops', 1, false, 'hint'],
  ]);
});

test('solves schedule spaced review; failures come back sooner', () => {
  const a = learner(), b = learner();
  recordSolve(a, task());
  recordSolve(b, task({ revealed: true }));
  assert.ok(a.concepts.loops.nextReview > b.concepts.loops.nextReview);
  assert.equal(dueForReview(a).length, 0);
  a.concepts.loops.nextReview = Date.now() - 1;
  assert.equal(dueForReview(a)[0].id, 'loops');
});

test('weak concepts get help sooner, and each hint shortens the next wait', () => {
  const l = learner();
  l.concepts.loops.mastery = 0.1;
  const weak = stuckThreshold(l, task(), 10);
  l.concepts.loops.mastery = 0.9;
  const strong = stuckThreshold(l, task(), 10);
  assert.ok(weak < strong);
  const afterHint = stuckThreshold(l, task({ hints: [hint(1)] }), 10);
  assert.ok(afterHint < strong);
});

test('mistakes merge by stable misconception id, else by pattern slug, and show up in the snapshot', () => {
  const l = learner();
  recordMistake(l, { pattern: 'Off-by-one in loop bound', detail: 'a', conceptIds: ['loops'], taskId: 't1' });
  const m = recordMistake(l, { pattern: 'off by one in loop bound', detail: 'b', conceptIds: ['loops'], taskId: 't2' });
  assert.equal(m.count, 2);
  recordMistake(l, { pattern: 'range end included', detail: 'x', conceptIds: ['loops'], taskId: 't1', misconceptionId: 'range-end-inclusive' });
  const k = recordMistake(l, { pattern: 'thinks range(n) reaches n', detail: 'y', conceptIds: ['recursion'], taskId: 't2', misconceptionId: 'range-end-inclusive' });
  assert.equal(k.count, 2);
  assert.equal(k.id, 'range-end-inclusive');
  assert.deepEqual(k.conceptIds, ['loops', 'recursion']);
  assert.equal(l.mistakes.length, 2);
  assert.match(snapshot(l, ['loops']), /x2/);
});

test('snapshot lines give P, the chip, tested/inferred, groups and live misconception beliefs', () => {
  const l = emptyLearner();
  upsertConcepts(l, [{ id: 'list-slicing', name: 'List slicing' }]);
  recordEvidence(l, { conceptId: 'list-slicing', kind: 'predict', source: 'atom', correct: true, g: 0.06, siblingGroup: 'names' });
  setMastery(l, 'list-slicing', 0.62);
  const c = l.concepts['list-slicing'];
  assert.equal(conceptLine(c), '- list-slicing (List slicing): P 0.62 [Learning, tested, 1 group]');
  c.misconceptions['slice-end-inclusive'] = {
    p: 0.71, belief: 'thinks the slice end is included', status: 'active', groups: ['names', 'story'], delayedHits: 0, relapses: 0, lastAt: 0,
  };
  c.misconceptions['old-one'] = { p: 0.9, belief: 'gone', status: 'cleared', groups: [], delayedHits: 2, relapses: 0, lastAt: 0 };
  assert.equal(
    conceptLine(c),
    '- list-slicing (List slicing): P 0.62 [Misconception, tested, 1 group]; misconception slice-end-inclusive p .71 active: thinks the slice end is included',
  );
  c.misconceptions['slice-end-inclusive'].status = 'suppressed';
  assert.match(snapshot(l), /\[Fixing, tested, 1 group\]; misconception slice-end-inclusive p \.71 recently corrected/);
  upsertConcepts(l, [{ id: 'loops', name: 'Loops' }]);
  assert.match(snapshot(l, ['loops']), /- loops \(Loops\): P 0\.30 \[Unknown, untested, 0 groups\]/);
});

test('allMastered uses isMastered: P alone is not enough', () => {
  const l = learner();
  setMastery(l, 'loops', 0.9);
  assert.equal(allMastered(l, ['loops']), false);
  master(l, 'loops');
  assert.equal(isMastered(l.concepts.loops), true);
  assert.equal(allMastered(l, ['loops']), true);
  assert.equal(allMastered(l, ['loops', 'recursion']), false);
  assert.equal(allMastered(l, ['missing']), false);
});

test('migration keeps mastery as the prior, defaults new fields, sets tested from attempts, and is idempotent', () => {
  const old = {
    concepts: {
      loops: {
        id: 'loops', name: 'Loops', description: '', prerequisites: [], mastery: 0.72, attempts: 2, hintsUsed: 1, lessonsSeen: 0,
        lastPracticed: 1000, nextReview: 0, intervalDays: 1, solveTimesMin: [12],
      },
      lists: {
        id: 'lists', name: 'Lists', description: '', prerequisites: ['loops'], mastery: 0.3, attempts: 0, hintsUsed: 0, lessonsSeen: 1,
        lastPracticed: 0, nextReview: 0, intervalDays: 0, solveTimesMin: [],
      },
    },
    mistakes: [{ id: 'm1', at: 1, conceptIds: ['loops'], pattern: 'p', detail: 'd', taskId: 't', count: 3 }],
    totals: { tasksDone: 4, hintsUsed: 2, reveals: 0, activeMinutes: 60 },
    futureField: 'kept',
  };
  const l = migrateLearner(old);
  const loops = l.concepts.loops;
  assert.equal(loops.mastery, 0.72);
  assert.equal(loops.tested, true);
  assert.equal(l.concepts.lists.tested, false);
  assert.deepEqual(
    [loops.misconceptions, loops.fluency, loops.fragile, loops.aliases, loops.supportFrom, loops.groupsCorrect, loops.production, loops.probeable],
    [{}, [], false, [], [], [], false, true],
  );
  assert.equal(loops.lastAt, 1000);
  assert.deepEqual([l.patternDeck, l.calibration, l.speedFactor, l.cps, l.keyUse, l.gradedCount], [[], { sure: [0, 0], guess: [0, 0] }, 1, 2.5, {}, 0]);
  assert.equal(l.mistakes[0].count, 3);
  assert.equal(l.totals.tasksDone, 4);
  assert.equal((l as unknown as { futureField: string }).futureField, 'kept');
  const json = (x: unknown) => JSON.stringify(x);
  assert.equal(json(migrateLearner(JSON.parse(json(l)))), json(l));
  assert.equal(json(migrateLearner(undefined)), json(emptyLearner()));
});

test('placement priors and typing calibration', () => {
  const l = learner();
  setPrior(l, 'loops', 0.7, 'used');
  assert.equal(l.concepts.loops.mastery, 0.7);
  assert.equal(l.concepts.loops.selfRating, 'used');
  recordEvidence(l, { conceptId: 'recursion', kind: 'predict', source: 'placement', correct: false, g: 0.06 });
  const p = l.concepts.recursion.mastery;
  setPrior(l, 'recursion', 0.7, 'used');
  assert.equal(l.concepts.recursion.mastery, p, 'never overrides tested concepts');
  assert.equal(recordTypingCalibration(l, 12, 4000), 3);
  assert.equal(recordTypingCalibration(l, 0, 4000), 3, 'a bad sample keeps the old value');
});
