import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GatePattern, GatePlan } from '../src/contracts';
import {
  GATE, atomCostSec, fadeLevel, gateDecision, gateRuns, gateSteps, gateWords, gradePatternPick, gradePlanPick, isSoloTask, patternTitle,
  planLengthsOk, routeGaps, shuffled, taskFade,
} from '../src/gateCore';
import { DECOMPOSITION, emptyLearner, recordEvidence, upsertConcepts } from '../src/learner';
import type { Learner } from '../src/types';

const T0 = Date.UTC(2026, 9, 3, 11, 0, 0);

function learner(): Learner {
  const l = emptyLearner();
  upsertConcepts(l, ['counting-with-dict', 'dict-iteration', 'string-split-join', 'sorting-key', 'collections-counter', 'loop-accumulator'].map((id) => ({ id, name: id, tag: id })), T0);
  return l;
}

/** Make a concept Solid: P .9, two groups, production, nothing blocking. */
function master(l: Learner, id: string): void {
  Object.assign(l.concepts[id], { mastery: 0.9, groupsCorrect: ['a', 'b'], production: true, tested: true });
}

test('fade thresholds: full < .5 <= partial < .8 <= minimal; solo overrides', () => {
  assert.equal(fadeLevel(0.49), 'full');
  assert.equal(fadeLevel(0.5), 'partial');
  assert.equal(fadeLevel(0.79), 'partial');
  assert.equal(fadeLevel(0.8), 'minimal');
  assert.equal(fadeLevel(0.95, true), 'solo');
  assert.equal(fadeLevel(NaN), 'full', 'no evidence: the .3 prior');
  const l = learner();
  assert.equal(taskFade(l), 'full');
  upsertConcepts(l, [{ id: DECOMPOSITION, name: 'Decomposition' }], T0);
  l.concepts[DECOMPOSITION].mastery = 0.6;
  assert.equal(taskFade(l), 'partial');
  assert.equal(isSoloTask([{ title: 'm1', taskIds: ['t1', 't2', 't3'] }], 't3'), true);
  assert.equal(isSoloTask([{ title: 'm1', taskIds: ['t1', 't2', 't3'] }], 't2'), false);
});

test('the gate runs only for a new unmastered concept, not solo, fade not minimal', () => {
  const l = learner();
  const earlier = [{ conceptIds: ['string-split-join'] }];
  assert.equal(gateRuns({ conceptIds: ['string-split-join', 'counting-with-dict'], fade: 'full' }, earlier, l), true);
  assert.deepEqual(gateDecision({ conceptIds: ['string-split-join', 'counting-with-dict'], fade: 'partial' }, earlier, l).newConcepts, ['counting-with-dict']);
  assert.equal(gateRuns({ conceptIds: ['string-split-join'], fade: 'full' }, earlier, l), false, 'consecutive tasks reusing concepts skip it');
  assert.equal(gateRuns({ conceptIds: ['counting-with-dict'], fade: 'minimal' }, earlier, l), false);
  assert.equal(gateRuns({ conceptIds: ['counting-with-dict'], fade: 'solo', solo: true }, earlier, l), false);
  master(l, 'counting-with-dict');
  assert.equal(gateRuns({ conceptIds: ['counting-with-dict'], fade: 'full' }, earlier, l), false, 'new but mastered');
  // Plan ids aliased into seed ids count as the same concept.
  l.concepts['dict-iteration'].aliases.push('loop-over-dict');
  assert.equal(gateRuns({ conceptIds: ['dict-iteration'], fade: 'full' }, [{ conceptIds: ['loop-over-dict'] }], l), false);
});

const plans: GatePlan[] = [
  { text: 'Split words, count each in a dict', workable: true, flawConceptId: '', misconceptionId: '', whyFlawed: '' },
  { text: 'Sort the words, then count them all', workable: false, flawConceptId: 'sorting-key', misconceptionId: 'sort-counts', whyFlawed: 'Does sorting tell you how many?' },
  { text: 'Count words with one shared counter', workable: false, flawConceptId: 'loop-accumulator', misconceptionId: 'assign-instead-of-add', whyFlawed: 'What does = do to the old count?' },
];

test('plan length check: each within +-20% of the mean, else step B is dropped', () => {
  assert.equal(planLengthsOk(plans), true);
  const long = [...plans.slice(0, 2), { ...plans[2], text: 'Count every single word with one big shared counter dict' }];
  assert.equal(planLengthsOk(long), false);
  assert.deepEqual(gateSteps('full', plans), { stepA: true, stepB: true });
  assert.deepEqual(gateSteps('full', long), { stepA: true, stepB: false });
  assert.deepEqual(gateSteps('partial', plans), { stepA: true, stepB: false }, 'step B only at full');
  assert.deepEqual(gateSteps('full', plans.map((p) => ({ ...p, workable: true }))), { stepA: true, stepB: false }, 'exactly one workable plan');
  assert.equal(planLengthsOk([]), false);
});

const patterns: GatePattern[] = [
  { name: 'Count with a dictionary', conceptId: 'counting-with-dict', required: true, competesWith: '', useWhen: 'tally how often each thing appears', whyNot: '' },
  { name: 'Split and join text', conceptId: 'string-split-join', required: true, competesWith: '', useWhen: 'break text into words', whyNot: '' },
  { name: 'Sort by a key', conceptId: 'sorting-key', required: false, competesWith: 'counting-with-dict', useWhen: '', whyNot: 'order does not give counts' },
  { name: 'Loop over a dictionary', conceptId: 'dict-iteration', required: false, competesWith: 'string-split-join', useWhen: '', whyNot: 'there is no dict to read yet' },
  { name: 'Accumulate in a loop', conceptId: 'loop-accumulator', required: false, competesWith: '', useWhen: '', whyNot: '' },
];

test('pattern pick: required selected correct, required missed wrong, lure wrong at .3 with NO misconception', () => {
  const g = gradePatternPick(patterns, ['split and join text', 'Sort by a key', 'Accumulate in a loop'], T0, 'task-2');
  assert.deepEqual(g.selected, ['Split and join text', 'Sort by a key', 'Accumulate in a loop']);
  assert.deepEqual(g.missed, ['Count with a dictionary']);
  assert.deepEqual(g.lures, ['Sort by a key', 'Accumulate in a loop']);
  assert.deepEqual(
    g.evidence.map((e) => [e.conceptId, e.correct, e.weight ?? 1, e.kind, e.source]),
    [
      ['counting-with-dict', false, 1, 'pattern-pick', 'gate'],
      ['string-split-join', true, 1, 'pattern-pick', 'gate'],
      ['counting-with-dict', false, GATE.lureWeight, 'pattern-pick', 'gate'],
    ],
    'the lure with no competing concept records nothing',
  );
  assert.ok(g.evidence.every((e) => e.misconceptionId === undefined && e.taskId === 'task-2'));
  assert.deepEqual(g.notes.map((n) => [n.kind, n.text]), [['missed', 'tally how often each thing appears'], ['lure', 'order does not give counts']]);
  assert.equal(patternTitle(g, true), '1/2 patterns · missed: Count with a dictionary · Which plan works?');
  assert.equal(patternTitle({ requiredHit: 2, requiredTotal: 2, missed: [] }, false), '2/2 patterns');
  // Applied to the learner model: a lure never plants a named belief.
  const l = learner();
  for (const e of g.evidence) recordEvidence(l, e);
  assert.deepEqual(l.concepts['counting-with-dict'].misconceptions, {});
  assert.ok(l.concepts['counting-with-dict'].mastery < 0.3);
});

test('plan pick: workable is correct on decomposition; flawed is wrong on its concept with the misconception at x2', () => {
  const ok = gradePlanPick(plans, 0, { at: T0 });
  assert.equal(ok.workable, true);
  assert.deepEqual(ok.evidence.map((e) => [e.conceptId, e.correct, e.kind]), [[DECOMPOSITION, true, 'plan-pick']]);
  const bad = gradePlanPick(plans, 1, { at: T0, taskId: 't2' });
  assert.equal(bad.workable, false);
  assert.equal(bad.whyFlawed, 'Does sorting tell you how many?');
  assert.equal(bad.workablePlan, 'Split words, count each in a dict');
  assert.deepEqual(bad.evidence.map((e) => [e.conceptId, e.correct, e.misconceptionId, e.misconceptionOdds]), [['sorting-key', false, 'sort-counts', 2]]);
  assert.equal(bad.flawedTasks, 1);
  assert.equal(bad.guideApproach, false);
  const third = gradePlanPick(plans, 2, { at: T0, priorFlawedTasks: 2 });
  assert.deepEqual(third.evidence.map((e) => [e.conceptId, e.correct]), [['loop-accumulator', false], [DECOMPOSITION, false]], 'flawed picks in 3 tasks lower decomposition');
  assert.equal(gradePlanPick(plans, 1, { at: T0, flawedPicksThisTask: 1 }).guideApproach, true, '2 flawed picks in one task');
  assert.equal(gradePlanPick(plans, 1, { at: T0, flawedPicksThisTask: 1, priorFlawedTasks: 1 }).flawedTasks, 1, 'the same task is counted once');
  const l = learner();
  for (const e of bad.evidence) recordEvidence(l, e);
  assert.equal(l.concepts['sorting-key'].misconceptions['sort-counts'].status, 'candidate');
});

test('routing: missed patterns under P .5, flawed plans and candidate misconceptions open atoms; cap 2 atoms / 120 s; the rest become JIT offers', () => {
  const l = learner();
  l.concepts['counting-with-dict'].mastery = 0.2;
  l.concepts['string-split-join'].mastery = 0.6;
  l.concepts['dict-iteration'].misconceptions['dict-iter-values'] = { p: 0.4, belief: 'looping a dict gives values', status: 'candidate', groups: ['g'], delayedHits: 0, relapses: 0, lastAt: T0 };
  const pg = gradePatternPick(patterns, ['Sort by a key'], T0);
  const r = routeGaps({
    learner: l, now: T0, taskConceptIds: ['counting-with-dict', 'string-split-join', 'dict-iteration'],
    patterns, patternGrade: pg, plans, planGrade: gradePlanPick(plans, 1, { at: T0 }),
  });
  assert.deepEqual(r.atoms.map((a) => [a.conceptId, a.reasons, a.costSec]), [['dict-iteration', ['misconception'], 55], ['sorting-key', ['flawed-plan'], 25]]);
  assert.deepEqual(r.jit.map((a) => [a.conceptId, a.reasons]), [['counting-with-dict', ['missed-pattern']]], 'split-join (P .6) is not routed at all');
  assert.ok(r.atoms.reduce((s, a) => s + a.costSec, 0) <= GATE.atomBudgetSec);
});

test('routing respects the 120 s budget and never starts atoms for Solid concepts', () => {
  const l = learner();
  for (const id of ['counting-with-dict', 'string-split-join']) Object.assign(l.concepts[id], { mastery: 0.1, lastWrongAt: T0 - 1 });
  assert.equal(atomCostSec(l, 'counting-with-dict', T0), GATE.atomSec.unknown);
  const pg = gradePatternPick(patterns, [], T0);
  const r = routeGaps({ learner: l, now: T0, taskConceptIds: [], patterns, patternGrade: pg });
  assert.equal(r.atoms.length, 1, '95 + 95 s would pass 120 s');
  assert.equal(r.jit.length, 1);
  master(l, 'sorting-key');
  const solid = routeGaps({ learner: l, now: T0, taskConceptIds: [], plans, planGrade: { workable: false, picked: 1 } });
  assert.deepEqual(solid, { atoms: [], jit: [] });
});

test('shuffle and the 50-word budget helpers', () => {
  let k = 0;
  const seq = [0.9, 0.1, 0.5];
  const order = shuffled(['a', 'b', 'c'], () => seq[k++ % seq.length]);
  assert.deepEqual([...order].sort(), ['a', 'b', 'c']);
  assert.ok(gateWords(patterns, plans) <= GATE.maxWords);
});
