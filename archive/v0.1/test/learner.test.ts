import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allMastered, dueForReview, emptyLearner, nudge, recordMistake, recordSolve, snapshot, stuckThreshold, upsertConcepts,
} from '../src/learner';
import { Task } from '../src/types';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1', title: 'T', description: '', acceptanceCriteria: [], conceptIds: ['loops'], estimatedMinutes: 20,
    kind: 'roadmap', followUpDepth: 0, status: 'active', phase: 'building', activeMs: 15 * 60_000, stuckMs: 0,
    explainAttempts: 1, hints: [], revealed: false, offeredRung: 0, feed: [], ...over,
  };
}

function learner() {
  const l = emptyLearner();
  upsertConcepts(l, [
    { id: 'Loops', name: 'Loops', description: '', prerequisites: [] },
    { id: 'recursion', name: 'Recursion', description: '', prerequisites: ['loops'] },
  ]);
  return l;
}

test('concept ids are slugged and not duplicated', () => {
  const l = learner();
  upsertConcepts(l, [{ id: 'loops', name: 'Loops again', description: '', prerequisites: [] }]);
  assert.deepEqual(Object.keys(l.concepts).sort(), ['loops', 'recursion']);
  assert.equal(l.concepts.loops.name, 'Loops');
});

test('nudge stays within 0..1 and has diminishing returns', () => {
  const l = learner();
  for (let i = 0; i < 50; i++) nudge(l, ['loops'], 0.3);
  assert.ok(l.concepts.loops.mastery <= 1 && l.concepts.loops.mastery > 0.95);
  for (let i = 0; i < 50; i++) nudge(l, ['loops'], -0.3);
  assert.ok(l.concepts.loops.mastery >= 0 && l.concepts.loops.mastery < 0.05);
});

test('unaided solve raises mastery more than a hinted one; reveal lowers it', () => {
  const a = learner(), b = learner(), c = learner();
  recordSolve(a, task());
  recordSolve(b, task({ hints: [{ rung: 4, at: 0, diagnosis: '', html: '' }] }));
  recordSolve(c, task({ revealed: true }));
  assert.ok(a.concepts.loops.mastery > b.concepts.loops.mastery);
  assert.ok(b.concepts.loops.mastery > 0.3);
  assert.ok(c.concepts.loops.mastery < 0.3);
  assert.equal(c.totals.reveals, 1);
  assert.equal(b.totals.hintsUsed, 1);
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
  const afterHint = stuckThreshold(l, task({ hints: [{ rung: 1, at: 0, diagnosis: '', html: '' }] }), 10);
  assert.ok(afterHint < strong);
});

test('mistakes with the same pattern are counted, and show up in the snapshot', () => {
  const l = learner();
  recordMistake(l, { pattern: 'Off-by-one in loop bound', detail: 'a', conceptIds: ['loops'], taskId: 't1' });
  const m = recordMistake(l, { pattern: 'off by one in loop bound', detail: 'b', conceptIds: ['loops'], taskId: 't2' });
  assert.equal(m.count, 2);
  assert.equal(l.mistakes.length, 1);
  assert.match(snapshot(l, ['loops']), /x2/);
});

test('allMastered requires every concept at target', () => {
  const l = learner();
  l.concepts.loops.mastery = 0.9;
  l.concepts.recursion.mastery = 0.5;
  assert.equal(allMastered(l, ['loops']), true);
  assert.equal(allMastered(l, ['loops', 'recursion']), false);
});
