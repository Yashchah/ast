import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvidence, auditDue, baseGS, bits, chip, effGS, isMastered, parAbs, parSelf, PARAMS, posterior, scaleOdds,
  scheduleOutcome,
} from '../src/evidence';
import { emptyLearner, EvidenceInput, Recorded, recordEvidence, setMastery, upsertConcepts } from '../src/learner';
import { ConceptState, Learner } from '../src/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function learner(...ids: (string | [string, string[]])[]): Learner {
  const l = emptyLearner();
  upsertConcepts(
    l,
    ids.map((x) => (Array.isArray(x) ? { id: x[0], name: x[0], prerequisites: x[1] } : { id: x, name: x })),
    T0,
  );
  return l;
}

/** One observation; defaults: a committed, focused-latency-free item with feedback (T .05) at T0. */
function rec(l: Learner, conceptId: string, over: Partial<EvidenceInput> = {}): Recorded {
  const r = recordEvidence(l, { conceptId, kind: 'predict', source: 'atom', correct: true, at: T0, ...over });
  assert.ok(r, `concept ${conceptId} exists`);
  return r;
}

const predict = (group: string, over: Partial<EvidenceInput> = {}): Partial<EvidenceInput> => ({ kind: 'predict', g: 0.06, siblingGroup: group, ...over });

// ---------------------------------------------------------------- the spec's worked numbers (s .10, T .05)

test('a correct structured predict takes P from .30 to .734 (g .06 raised to the cap .15)', () => {
  assert.equal(r3(effGS(0.06, 0.1).g), 0.15);
  const l = learner('slicing');
  const r = rec(l, 'slicing', predict('names'));
  assert.equal(r3(l.concepts.slicing.mastery), 0.734);
  assert.equal(r.result.weight, 1);
  assert.equal(l.concepts.slicing.tested, true);
  assert.deepEqual(l.concepts.slicing.groupsCorrect, ['names']);
});

test('a second correct predict from another group reaches the .8 cap; a passing completion then gives .962 and mastery', () => {
  const l = learner('slicing');
  rec(l, 'slicing', predict('names'));
  rec(l, 'slicing', predict('story'));
  assert.equal(l.concepts.slicing.mastery, 0.8, 'two groups but no production item: capped');
  assert.equal(isMastered(l.concepts.slicing), false);
  const r = rec(l, 'slicing', { kind: 'completion', siblingGroup: 'data', production: true });
  assert.equal(r3(l.concepts.slicing.mastery), 0.962);
  assert.equal(isMastered(l.concepts.slicing), true);
  assert.equal(r.result.masteredNow, true);
  assert.equal(l.concepts.slicing.auditDueAt, T0 + DAY, 'a delayed audit is scheduled one day out');
});

test('one item never masters: not from the prior, not from a completion, not from a legacy high P', () => {
  for (const over of [predict('names'), { kind: 'completion' as const, siblingGroup: 'a', production: true }, { kind: 'spec' as const, production: true }]) {
    const l = learner('x');
    rec(l, 'x', over);
    assert.ok(l.concepts.x.mastery <= 0.8, `${over.kind} stays at or under the cap`);
    assert.equal(isMastered(l.concepts.x), false);
  }
  // A migrated v0.1 profile at .95 is not lowered by a correct answer, but is not mastered either.
  const l = learner('x');
  setMastery(l, 'x', 0.95);
  rec(l, 'x', predict('names'));
  assert.equal(l.concepts.x.mastery, 0.95);
  assert.equal(isMastered(l.concepts.x), false);
});

test('a correct boolean predict (g .5) takes .30 to .464', () => {
  const l = learner('x');
  rec(l, 'x', predict('a', { g: 0.5 }));
  assert.equal(r3(l.concepts.x.mastery), 0.464);
});

test('a committed wrong structured predict takes .30 to .113', () => {
  const l = learner('x');
  const r = rec(l, 'x', predict('a', { correct: false }));
  assert.equal(r3(l.concepts.x.mastery), 0.113);
  assert.equal(r.result.weight, 1);
});

test("a don't-know and a guess-flagged wrong answer both take .30 to .224 (half weight)", () => {
  const dk = learner('x');
  const r1 = rec(dk, 'x', predict('a', { correct: null, verdict: 'dont-know', weight: 1 }));
  assert.equal(r3(dk.concepts.x.mastery), 0.224);
  assert.equal(r1.evidence.weight, 0.5, 'the logged weight is the effective one');

  const flagged = learner('x');
  rec(flagged, 'x', predict('a', { correct: false, guessFlag: true }));
  assert.equal(r3(flagged.concepts.x.mastery), 0.224);

  // Implicit guess: latency under .3 x par_self.
  const fast = learner('x');
  const r3_ = rec(fast, 'x', predict('a', { correct: false, latencyMs: 1000, parSelfMs: 5000, latencyValid: true }));
  assert.equal(r3(fast.concepts.x.mastery), 0.224);
  assert.equal(r3_.evidence.implicitGuess, true);
});

test('a correct plan-pick takes .30 to .562', () => {
  const l = learner('x');
  rec(l, 'x', { kind: 'plan-pick', source: 'gate' });
  assert.equal(r3(l.concepts.x.mastery), 0.562);
});

test('no single update moves the odds more than 6x', () => {
  const odds = (p: number) => p / (1 - p);
  for (const p of [0.01, 0.1, 0.3, 0.5, 0.8, 0.99]) {
    for (const g of [0.001, 0.04, 0.06, 0.2, 0.5, 0.9]) {
      for (const s of [0.001, 0.05, 0.1, 0.3]) {
        for (const correct of [true, false]) {
          const k = odds(posterior(p, correct, g, s)) / odds(p);
          assert.ok(k <= 6 + 1e-9 && k >= 1 / 6 - 1e-9, `p ${p} g ${g} s ${s} ${correct}: x${k}`);
        }
      }
    }
  }
});

test('a guess-flagged correct answer counts but stays capped at .8, adds no sibling group, and comes back this session', () => {
  const l = learner('x');
  rec(l, 'x', predict('a'));
  rec(l, 'x', { kind: 'completion', siblingGroup: 'b', production: true });
  rec(l, 'x', predict('a', { correct: false }));
  const before = l.concepts.x.mastery;
  assert.ok(before < 0.8, 'caps hold, P below .8');
  const r = rec(l, 'x', predict('c', { guessFlag: true, at: T0 + MIN }));
  assert.ok(l.concepts.x.mastery > before, 'counts as correct');
  assert.equal(l.concepts.x.mastery, 0.8, 'but cannot pass .8');
  assert.deepEqual(l.concepts.x.groupsCorrect, ['a', 'b'], 'a guess is not a sibling group');
  assert.equal(r.result.outcome, 'guess');
  assert.equal(l.concepts.x.nextReview, T0 + MIN + 10 * MIN);
  assert.equal(l.concepts.x.fragile, false);
  assert.deepEqual(l.calibration.guess, [1, 1]);
});

test('format-only and zero-weight (assisted) answers record no evidence but are still logged', () => {
  const logged: unknown[] = [];
  const l = learner('x');
  const r = recordEvidence(l, { conceptId: 'x', kind: 'predict', source: 'atom', correct: false, verdict: 'format-only', at: T0 }, { log: (e) => logged.push(e) });
  assert.equal(r!.result.discarded, true);
  assert.equal(l.concepts.x.mastery, 0.3);
  assert.equal(l.concepts.x.tested, false);
  assert.equal(l.gradedCount, 0);
  assert.equal(logged.length, 1);
  assert.equal(r!.evidence.weight, 0);
  rec(l, 'x', predict('a', { weight: 0 }));
  assert.equal(l.concepts.x.mastery, 0.3);
});

test('evidence caps also need coverage of the tag misconceptions with prior >= .2', () => {
  const l = learner('alias');
  const coverage = () => ['alias-copy-is-new-list'];
  const opts = { coverage };
  recordEvidence(l, { conceptId: 'alias', kind: 'predict', source: 'atom', correct: true, g: 0.06, siblingGroup: 'a', at: T0 }, opts);
  recordEvidence(l, { conceptId: 'alias', kind: 'predict', source: 'atom', correct: true, g: 0.06, siblingGroup: 'b', at: T0 }, opts);
  recordEvidence(l, { conceptId: 'alias', kind: 'completion', source: 'atom', correct: true, siblingGroup: 'c', production: true, at: T0 }, opts);
  assert.equal(l.concepts.alias.mastery, 0.8, 'not covered yet');
  recordEvidence(l, { conceptId: 'alias', kind: 'predict', source: 'atom', correct: true, g: 0.06, siblingGroup: 'd', avoidedMisconceptionIds: ['alias-copy-is-new-list'], at: T0 }, opts);
  assert.ok(l.concepts.alias.mastery > 0.85);
  assert.equal(isMastered(l.concepts.alias, coverage()), true);
});

test('spec greens are production only at full weight (within 3 saves, not assisted)', () => {
  const tinkered = learner('x');
  rec(tinkered, 'x', { kind: 'spec', source: 'spec', production: true, weight: 0.3 });
  assert.equal(tinkered.concepts.x.production, false);
  const clean = learner('x');
  rec(clean, 'x', { kind: 'spec', source: 'spec', production: true });
  assert.equal(clean.concepts.x.production, true);
  const predicted = learner('x');
  rec(predicted, 'x', predict('a', { production: true }));
  assert.equal(predicted.concepts.x.production, false, 'a predict item is never production');
});

test('the learning transition comes from the record (T .3 after a refutation + correct contrast pick)', () => {
  const l = learner('x');
  rec(l, 'x', { kind: 'contrast-pick', learnT: 0.3 });
  // contrast-pick g .5: .27/.62 = .4355; + .5645 x .3
  assert.equal(r3(l.concepts.x.mastery), r3(0.27 / 0.62 + (1 - 0.27 / 0.62) * 0.3));
});

test('bits are KL(posterior || prior): a structured item carries more than a boolean one', () => {
  const a = learner('x');
  const b = learner('x');
  const structured = rec(a, 'x', predict('a')).evidence.bits;
  const boolean = rec(b, 'x', predict('a', { g: 0.5 })).evidence.bits;
  assert.ok(structured > boolean && boolean > 0);
  assert.equal(r3(structured), r3(bits(0.3, 0.72)));
  assert.equal(bits(0.4, 0.4), 0);
});

test('calibration: unflagged guessing (sure accuracy < 70% over 30+) raises answer-space g by .05', () => {
  assert.equal(r3(baseGS({ kind: 'predict', g: 0.06 } as never, true).g), 0.11);
  assert.equal(baseGS({ kind: 'completion' } as never, true).g, 0.1, 'only answer-space kinds');
  const l = learner('x');
  l.calibration.sure = [20, 30];
  rec(l, 'x', predict('a', { g: 0.5 }));
  const pb = 0.27 / (0.27 + 0.7 * 0.55);
  assert.equal(r3(l.concepts.x.mastery), r3(pb + (1 - pb) * 0.05));
  assert.deepEqual(l.calibration.sure, [21, 31]);
});

test('unverified items use slip .2 and guess +.1', () => {
  assert.deepEqual(
    Object.values(baseGS({ kind: 'predict', g: 0.06, unverified: true } as never)).map(r3),
    [0.16, 0.2],
  );
});

// ---------------------------------------------------------------- misconceptions

test('a misconception becomes active only after matches from 2 sibling groups (and p > .6)', () => {
  const l = learner('slicing');
  const wrong = (group: string, odds: number) =>
    rec(l, 'slicing', predict(group, { correct: false, misconceptionId: 'slice-end-inclusive', misconceptionOdds: odds }));

  wrong('names', 6); // .15 -> .514
  let m = l.concepts.slicing.misconceptions['slice-end-inclusive'];
  assert.equal(m.status, 'candidate');
  assert.equal(r3(m.p), r3(scaleOdds(0.15, 6)));
  wrong('names', 6); // .864, still one group
  assert.equal(m.status, 'candidate');
  wrong('story', 6);
  assert.equal(m.status, 'active');

  // Two groups but p <= .6 stays a candidate (unconfirmed x2 matches).
  const k = learner('slicing');
  const weak = (group: string) => rec(k, 'slicing', predict(group, { correct: false, misconceptionId: 'm', misconceptionOdds: 2 }));
  weak('a');
  weak('b');
  m = k.concepts.slicing.misconceptions.m;
  assert.equal(m.groups.length, 2);
  assert.ok(m.p < 0.6);
  assert.equal(m.status, 'candidate');
  weak('a');
  weak('b');
  assert.equal(m.status, 'active');
});

test('a new misconception starts at its taxonomy prior (else .15) and takes the belief text from the taxonomy or the mutant', () => {
  const l = learner('x');
  const taxonomy = (id: string) => (id === 'known' ? { belief: 'thinks range includes the end', prior: 0.3 } : undefined);
  recordEvidence(l, { conceptId: 'x', kind: 'predict', source: 'atom', correct: false, g: 0.06, siblingGroup: 'a', misconceptionId: 'known', misconceptionOdds: 6, at: T0 }, { taxonomy });
  recordEvidence(l, { conceptId: 'x', kind: 'predict', source: 'atom', correct: false, g: 0.06, siblingGroup: 'a', misconceptionId: 'model-made', misconceptionOdds: 2, belief: 'thinks pop takes from the front', at: T0 }, { taxonomy });
  const ms = l.concepts.x.misconceptions;
  assert.equal(r3(ms.known.p), r3(scaleOdds(0.3, 6)));
  assert.equal(ms.known.belief, 'thinks range includes the end');
  assert.equal(r3(ms['model-made'].p), r3(scaleOdds(0.15, 2)));
  assert.equal(ms['model-made'].belief, 'thinks pop takes from the front');
  assert.equal(ms.known.nextCheckAt, T0 + 10 * MIN);
});

test("'n' to the belief check and '?' never update a misconception; a passive signature never activates one", () => {
  const l = learner('x');
  const r = rec(l, 'x', predict('a', { correct: false, misconceptionId: 'm', beliefConfirmed: false }));
  assert.ok(!('m' in l.concepts.x.misconceptions));
  assert.equal(r.result.weight, 0.5, "'n' is a slip: half-weight wrong evidence");
  rec(l, 'x', predict('a', { correct: null, misconceptionId: 'm' }));
  assert.ok(!('m' in l.concepts.x.misconceptions));

  for (const g of ['a', 'b', 'c', 'd', 'e', 'f']) rec(l, 'x', { kind: 'passive', source: 'spec', correct: false, weight: 0.5, siblingGroup: g, misconceptionId: 'm', misconceptionOdds: 1.5 });
  const m = l.concepts.x.misconceptions.m;
  assert.ok(m.p > 0.6, 'passive evidence can raise p');
  assert.equal(m.groups.length, 0, 'but never counts toward the 2-group rule');
  assert.equal(m.status, 'candidate');
});

test('an immediate correct re-probe suppresses (not clears); 2 delayed hits clear; a later match relapses', () => {
  const l = learner('slicing');
  const M = 'slice-end-inclusive';
  rec(l, 'slicing', predict('names', { correct: false, misconceptionId: M, beliefConfirmed: true, misconceptionOdds: 6 }));
  rec(l, 'slicing', predict('story', { correct: false, misconceptionId: M, beliefConfirmed: true, misconceptionOdds: 6 }));
  const m = l.concepts.slicing.misconceptions[M];
  assert.equal(m.status, 'active');
  const pActive = m.p;

  const t = T0 + MIN;
  rec(l, 'slicing', predict('data', { at: t, suppresses: M, avoidedMisconceptionIds: [M] }));
  assert.equal(m.status, 'suppressed');
  assert.equal(r3(m.p), r3(scaleOdds(pActive, 0.25)));
  assert.equal(m.refutedAt, t);
  assert.equal(isMastered(l.concepts.slicing), false, 'suppressed still blocks mastery');
  assert.equal(chip(l.concepts.slicing), 'Fixing');

  const hit = (at: number, over: Partial<EvidenceInput> = {}) =>
    rec(l, 'slicing', predict('cities', { at, source: 'sprint', delayedCheckFor: M, avoidedMisconceptionIds: [M], ...over }));
  hit(t + 5 * MIN);
  assert.equal(m.delayedHits, 0, 'under 10 minutes is not a delayed hit');
  hit(t + 12 * MIN, { guessFlag: true });
  assert.equal(m.delayedHits, 0, 'a guess is not a hit');
  hit(t + 12 * MIN);
  assert.equal(m.delayedHits, 1);
  assert.equal(m.nextCheckAt, t + DAY);
  hit(t + 3 * HOUR);
  assert.equal(m.delayedHits, 1, 'the second hit needs a day');
  hit(t + DAY + HOUR);
  assert.equal(m.status, 'cleared');

  rec(l, 'slicing', predict('fruits', { at: t + 3 * DAY, correct: false, misconceptionId: M, misconceptionOdds: 3 }));
  assert.equal(m.status, 'active');
  assert.equal(m.relapses, 1);
  assert.equal(m.delayedHits, 0);
  assert.equal(chip(l.concepts.slicing), 'Misconception');
});

test('an unconfirmed placement candidate stops blocking once an item carrying its mutant is answered right', () => {
  const l = learner('x');
  rec(l, 'x', predict('a', { source: 'placement', correct: false, misconceptionId: 'm', misconceptionOdds: 3 }));
  assert.ok(l.concepts.x.misconceptions.m.p >= 0.3, 'placement candidate routes to a belief check');
  rec(l, 'x', predict('b', { avoidedMisconceptionIds: ['m'] }));
  assert.ok(l.concepts.x.misconceptions.m.p < 0.3);
});

// ---------------------------------------------------------------- propagation

test('upward propagation needs 2 supporting descendants, one with production, for inferred-mastered', () => {
  const l = learner('variables', ['loops', ['variables']], ['nested-loops', ['loops']], ['loop-accumulator', ['loops']]);
  rec(l, 'nested-loops', predict('a'));
  assert.equal(l.concepts.loops.mastery, 0.75, 'single support: at most .75');
  assert.equal(l.concepts.variables.mastery, 0.75, 'two hops up');
  assert.equal(l.concepts.loops.inferred, false);

  rec(l, 'loop-accumulator', predict('a'));
  assert.equal(l.concepts.loops.mastery, 0.75, 'two supporters without production are not enough');

  rec(l, 'loop-accumulator', { kind: 'completion', siblingGroup: 'b', production: true });
  assert.equal(l.concepts.loops.mastery, 0.9);
  assert.equal(l.concepts.loops.inferred, true);
  assert.equal(l.concepts.loops.tested, false);
  assert.equal(isMastered(l.concepts.loops), true);
  assert.ok(l.concepts.loops.auditDueAt, 'inferred-mastered concepts are audited');
  assert.deepEqual(auditDue(l.concepts, T0 + DAY + 1, () => 0).map((c) => c.id)[0], 'loops', 'inferred ones first');
});

test('propagation never raises an ancestor that just failed on its own', () => {
  const l = learner('loops', ['nested-loops', ['loops']]);
  rec(l, 'loops', predict('a', { correct: false }));
  const p = l.concepts.loops.mastery;
  rec(l, 'nested-loops', predict('a', { at: T0 + HOUR }));
  assert.equal(l.concepts.loops.mastery, p);
  assert.deepEqual(l.concepts.loops.supportFrom, ['nested-loops'], 'support is still recorded');
});

test('a single wrong answer caps only direct children; two from different groups cap 3 hops at P + .25', () => {
  const l = learner('variables', ['loops', ['variables']], ['nested-loops', ['loops']], ['busy', ['variables']]);
  for (const id of ['loops', 'nested-loops', 'busy']) setMastery(l, id, 0.9);
  rec(l, 'busy', predict('a', { at: T0 - DAY })); // own evidence yesterday: never lowered
  setMastery(l, 'variables', 0.3); // undo the support busy's answer gave its parent

  rec(l, 'variables', predict('a', { correct: false }));
  const pa = l.concepts.variables.mastery;
  assert.ok(pa < 0.3);
  assert.equal(r3(l.concepts.loops.mastery), r3(pa + 0.35));
  assert.equal(l.concepts['nested-loops'].mastery, 0.9, 'grandchildren untouched by one answer');
  assert.ok(l.concepts.busy.mastery >= 0.8);

  rec(l, 'variables', predict('a', { correct: false }));
  assert.ok(l.concepts['nested-loops'].mastery === 0.9, 'same group twice still caps only children');

  rec(l, 'variables', predict('b', { correct: false }));
  const pb = l.concepts.variables.mastery;
  assert.equal(r3(l.concepts['nested-loops'].mastery), r3(pb + 0.25));
  assert.equal(r3(l.concepts.loops.mastery), r3(pb + 0.25));
  assert.ok(l.concepts.busy.mastery >= 0.8);

  // Half-weight wrong answers never propagate down.
  const k = learner('a', ['b', ['a']]);
  setMastery(k, 'b', 0.9);
  setMastery(k, 'a', 0.1);
  rec(k, 'a', predict('a', { correct: null }));
  assert.equal(k.concepts.b.mastery, 0.9);
});

test('propagation is cycle-safe and stops after 3 hops', () => {
  const l = learner(['a', ['c']], ['b', ['a']], ['c', ['b']], ['d', ['c']], ['e', ['d']], ['f', ['e']], ['g', ['f']]);
  rec(l, 'g', predict('a'));
  for (const id of ['f', 'e', 'd']) assert.equal(l.concepts[id].mastery, 0.75, `${id} within 3 hops`);
  assert.equal(l.concepts.c.mastery, 0.3, '4 hops away');
  rec(l, 'a', predict('a')); // a -> c -> b -> a cycle
  assert.equal(l.concepts.c.mastery, 0.75);
  assert.equal(l.concepts.b.mastery, 0.75);
  assert.ok(!l.concepts.a.supportFrom.includes('a'));
});

// ---------------------------------------------------------------- latency, fragile, fluent

test('latency is discarded when the window lost focus or it exceeds 60 s', () => {
  const l = learner('x');
  l.gradedCount = 20;
  const slow = { latencyMs: 30_000, parSelfMs: 5_000, parAbsMs: 4_000 };
  let r = rec(l, 'x', predict('a', { ...slow, latencyValid: false }));
  assert.equal(r.result.latencyValid, false);
  assert.equal(l.concepts.x.fragile, false);
  assert.deepEqual(l.recentRatios, []);
  assert.deepEqual(l.concepts.x.fluency, []);

  r = rec(l, 'x', predict('b', { latencyMs: 61_000, parSelfMs: 5_000, parAbsMs: 4_000, latencyValid: true }));
  assert.equal(r.evidence.latencyValid, false, 'over 60 s');
  assert.equal(l.concepts.x.fragile, false);

  r = rec(l, 'x', predict('c', { ...slow, latencyValid: true }));
  assert.equal(r.result.latencyValid, true);
  assert.equal(l.concepts.x.fragile, true);
  assert.deepEqual(l.recentRatios, [7.5]);
  assert.equal(l.speedFactor, 2, 'speedFactor is clamped to .7-2');
});

test('no Fragile during the first 15 graded items; set on the 16th; cleared by a fast answer 1 h later', () => {
  const l = learner('x');
  const slow = { latencyMs: 20_000, parSelfMs: 5_000, parAbsMs: 5_000, latencyValid: true };
  for (let i = 0; i < 15; i++) {
    rec(l, 'x', predict(`g${i}`, slow));
    assert.equal(l.concepts.x.fragile, false, `item ${i + 1}`);
  }
  assert.equal(l.gradedCount, 15);
  const r = rec(l, 'x', predict('g15', slow));
  assert.equal(l.concepts.x.fragile, true);
  assert.equal(r.result.outcome, 'fragile');
  assert.equal(chip(l.concepts.x), 'Fragile');

  const fast = { latencyMs: 5_500, parSelfMs: 5_000, parAbsMs: 5_000, latencyValid: true };
  rec(l, 'x', predict('h', { ...fast, at: T0 + 30 * MIN }));
  assert.equal(l.concepts.x.fragile, true, 'needs an hour');
  rec(l, 'x', predict('h', { ...fast, at: T0 + 2 * HOUR }));
  assert.equal(l.concepts.x.fragile, false);
});

test('par_self and par_abs: reading + typing + clamped thinking', () => {
  const item = { codeLines: 4, answerChars: 6, parSec: 5 };
  assert.equal(parSelf(item, { cps: 2.5, speedFactor: 1.5 }), 15_900); // 6 + 2.4 + 7.5
  assert.equal(parAbs(item, { cps: 2.5 }), 13_400);
  assert.equal(parAbs({ ...item, parSec: 20 }, { cps: 2.5 }), 16_400, 'probe thinking clamps to 8 s');
  assert.equal(parAbs({ kind: 'completion', codeLines: 8, answerChars: 10, parSec: 30 }, { cps: 5 }), 44_000);
  assert.equal(parSelf(item, { cps: 2.5, speedFactor: 9 }), parSelf(item, { cps: 2.5, speedFactor: 2 }));
});

test('chips in priority order, and Fluent needs fast answers over 2+ calendar days', () => {
  const l = learner('x');
  assert.equal(chip(l.concepts.x), 'Unknown');
  rec(l, 'x', predict('a'));
  assert.equal(chip(l.concepts.x), 'Learning');
  rec(l, 'x', predict('b'));
  rec(l, 'x', { kind: 'completion', siblingGroup: 'c', production: true });
  assert.equal(chip(l.concepts.x), 'Solid');
  const c = l.concepts.x;
  c.fluency = [{ ratio: 0.8, at: T0 }, { ratio: 0.9, at: T0 + HOUR }, { ratio: 1.4, at: T0 + 2 * HOUR }];
  assert.equal(chip(c), 'Solid', 'one day only');
  c.fluency.push({ ratio: 0.7, at: T0 + DAY + HOUR });
  assert.equal(chip(c), 'Fluent');
  c.misconceptions.m = { p: 0.2, belief: '', status: 'candidate', groups: [], delayedHits: 0, relapses: 0, lastAt: T0 };
  assert.equal(chip(c), 'Fluent', 'a weak candidate does not block');
  c.misconceptions.m.p = 0.35;
  assert.equal(chip(c), 'Learning', 'a candidate at p >= .3 blocks mastery');
});

// ---------------------------------------------------------------- audits and scheduling

test('a missed delayed audit revokes mastery, sets P <= .6 and logs false mastery; a pass keeps it', () => {
  const master = (l: Learner, id: string) => {
    rec(l, id, predict('a'));
    rec(l, id, predict('b'));
    rec(l, id, { kind: 'completion', siblingGroup: 'c', production: true });
    assert.equal(isMastered(l.concepts[id]), true);
  };
  const l = learner('x', 'y');
  master(l, 'x');
  master(l, 'y');
  assert.deepEqual(auditDue(l.concepts, T0 + HOUR), []);
  assert.equal(auditDue(l.concepts, T0 + DAY).length, 2);

  const miss = rec(l, 'x', { kind: 'completion', source: 'audit', correct: false, at: T0 + DAY + 1, production: true });
  assert.equal(miss.result.revoked, true);
  assert.ok(l.concepts.x.mastery <= 0.6);
  assert.equal(isMastered(l.concepts.x), false);
  assert.equal(l.concepts.x.production, false, 'production must be earned again');
  assert.deepEqual(l.falseMastery, [{ conceptId: 'x', at: T0 + DAY + 1 }]);

  rec(l, 'y', { kind: 'completion', source: 'audit', correct: true, at: T0 + DAY + 1, siblingGroup: 'd', production: true });
  assert.equal(isMastered(l.concepts.y), true);
  assert.equal(l.concepts.y.auditDueAt, undefined);
  assert.deepEqual(l.audits, { passed: 1, failed: 1 });
  assert.deepEqual(auditDue(l.concepts, T0 + 5 * DAY), []);

  // One more correct item on x cannot re-master it without a new production item.
  rec(l, 'x', predict('e', { at: T0 + DAY + 2 }));
  assert.ok(l.concepts.x.mastery <= 0.8);
});

test('scheduling by outcome: misconception 10 min then .25 day, fragile 10 min then 1 day, solid x2.2 only when due, fail .25 day', () => {
  const c = learner('x').concepts.x;
  scheduleOutcome(c, 'misconception', T0, true);
  assert.equal(c.nextReview, T0 + 10 * MIN);
  scheduleOutcome(c, 'misconception', T0 + MIN);
  assert.equal(c.nextReview, T0 + 10 * MIN, 'not due: the check stays where it is');
  scheduleOutcome(c, 'misconception', T0 + 11 * MIN);
  assert.equal(c.nextReview, T0 + 11 * MIN + DAY / 4);

  const f = learner('x').concepts.x;
  scheduleOutcome(f, 'fragile', T0, true);
  scheduleOutcome(f, 'fragile', T0 + 10 * MIN);
  assert.equal(f.nextReview, T0 + 10 * MIN + DAY);

  const s = learner('x').concepts.x;
  scheduleOutcome(s, 'solid', T0);
  assert.equal(s.intervalDays, 1);
  scheduleOutcome(s, 'solid', T0 + HOUR);
  assert.equal(s.intervalDays, 1, 'more answers before the review do not stretch it');
  scheduleOutcome(s, 'solid', T0 + DAY);
  assert.equal(s.intervalDays, 2.2);
  for (let i = 0; i < 10; i++) scheduleOutcome(s, 'solid', s.nextReview);
  assert.equal(s.intervalDays, 60);
  scheduleOutcome(s, 'fail', T0);
  assert.equal(s.nextReview, T0 + DAY / 4);
});

test('applyEvidence on a lone concept (no learner) updates only that concept', () => {
  const l = learner('x');
  const c: ConceptState = l.concepts.x;
  const r = applyEvidence(c, {
    id: 'e1', at: T0, conceptId: 'x', kind: 'predict', g: 0.06, correct: true, guessFlag: false, latencyValid: false,
    source: 'atom', weight: 1, learnT: PARAMS.learnT.feedback, bits: 0, window: 'w',
  });
  assert.equal(r3(c.mastery), 0.734);
  assert.deepEqual(r.propagated, []);
  assert.equal(l.gradedCount, 0);
});

test('random evidence streams never produce NaN or out-of-range state (fuzz, seeded)', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const kinds = Object.keys(PARAMS.gs) as (keyof typeof PARAMS.gs)[];
  const sources = ['atom', 'placement', 'sprint', 'gate', 'spec', 'audit', 'hint', 'llm', 'passive'] as const;
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const l = learner(['a', ['e']], ['b', ['a']], ['c', ['a', 'b']], ['d', ['c']], ['e', ['d']]);
  let t = T0;
  for (let i = 0; i < 3000; i++) {
    t += Math.floor(rnd() * 6 * HOUR);
    const id = pick(ids);
    const lastAt = l.concepts[id].lastAt;
    const r = rec(l, id, {
      at: t,
      kind: pick(kinds),
      source: pick(sources),
      correct: pick([true, false, null] as const),
      g: rnd() < 0.5 ? pick([0.04, 0.06, 0.12, 0.2, 0.25, 0.5]) : undefined,
      guessFlag: rnd() < 0.15,
      weight: pick([1, 1, 0.5, 0.3, 0]),
      learnT: pick([0.05, 0.05, 0.3, 0]),
      siblingGroup: rnd() < 0.8 ? pick(['g1', 'g2', 'g3']) : undefined,
      latencyMs: rnd() * 90_000,
      parSelfMs: rnd() * 20_000,
      parAbsMs: rnd() * 20_000,
      latencyValid: rnd() < 0.8,
      misconceptionId: rnd() < 0.3 ? pick(['m1', 'm2']) : undefined,
      misconceptionOdds: pick([undefined, 1.5, 2, 3, 6]),
      beliefConfirmed: pick([undefined, true, false]),
      suppresses: rnd() < 0.1 ? pick(['m1', 'm2']) : undefined,
      delayedCheckFor: rnd() < 0.1 ? pick(['m1', 'm2']) : undefined,
      avoidedMisconceptionIds: rnd() < 0.3 ? [pick(['m1', 'm2'])] : undefined,
      production: rnd() < 0.3,
    });
    if (!r.result.discarded) assert.ok(l.concepts[id].lastAt > lastAt, 'lastAt strictly increases');
    else assert.equal(l.concepts[id].lastAt, lastAt, 'discarded evidence changes nothing');
    for (const c of Object.values(l.concepts)) {
      assert.ok(Number.isFinite(c.mastery) && c.mastery >= 0 && c.mastery <= 1, `${c.id} P ${c.mastery}`);
      for (const m of Object.values(c.misconceptions)) assert.ok(m.p >= 0 && m.p <= 1);
      if (!isMastered(c)) assert.ok(c.masteredAt === undefined, 'masteredAt follows isMastered');
      assert.ok(Number.isFinite(c.nextReview) && Number.isFinite(c.intervalDays));
    }
  }
  assert.ok(Number.isFinite(l.speedFactor) && l.speedFactor >= 0.7 && l.speedFactor <= 2);
});
