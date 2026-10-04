import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredCompletion, StoredProbe } from '../src/contracts';
import {
  PLACEMENT, escape, formatDuration, importance, newPlacement, nextItem, placementScore, record, shouldStop, summary, typingLiteral,
  type PlacementCandidate, type PlacementDag, type PlacementItem, type PlacementSources, type PlacementState,
} from '../src/atoms/placement';
import { emptyLearner, recordEvidence, upsertConcepts } from '../src/learner';
import type { Learner } from '../src/types';

const T0 = Date.UTC(2026, 9, 3, 9, 0, 0);
const S = 1000;

// vars <- loops <- acc;  vars <- lists <- slicing
const DAG: [string, string[]][] = [['vars', []], ['loops', ['vars']], ['acc', ['loops']], ['lists', ['vars']], ['slicing', ['lists']]];

function learner(p: Record<string, number> = {}, ticked: string[] = []): Learner {
  const l = emptyLearner();
  upsertConcepts(l, DAG.map(([id, prerequisites]) => ({ id, name: id, prerequisites })), T0);
  for (const [id, v] of Object.entries(p)) l.concepts[id].mastery = v;
  for (const id of ticked) l.concepts[id].selfRating = 'used';
  return l;
}

const stats = (seenAt: number[] = []) => ({ seenAt, n: 0, nCorrect: 0 });

function probe(concept: string, k: number, over: Partial<StoredProbe> = {}): StoredProbe {
  return {
    id: `${concept}-p${k}`, group: `${concept}-g${k}`, code: `print(${k})`, output: { stdout: `${k}\n`, values: [] }, parSec: 5,
    answerSpaceG: 0.2, constructs: [], discriminating: true, mutants: [], stats: stats(), ...over,
  };
}

function completion(concept: string): StoredCompletion {
  return { id: `${concept}-c`, group: `${concept}-cg`, code: 'x = [[1]]', solutions: ['1'], wrongFills: [], harness: 'check(x == 1)', parSec: 25, stats: stats() };
}

function sources(now = T0, over: Partial<PlacementCandidate>[] = []): PlacementSources {
  const candidates: PlacementCandidate[] = DAG.map(([id]) => ({ conceptId: id, probes: [1, 2, 3].map((k) => probe(id, k)), completions: [completion(id)] }));
  for (const o of over) Object.assign(candidates.find((c) => c.conceptId === o.conceptId)!, o);
  return { candidates, now, lang: 'python' };
}

function calibrated(): PlacementState {
  return record(newPlacement(T0), { kind: 'typing', at: T0 + 6 * S });
}

/** Answer an item: correct (under par unless slow), at `at`. */
function answer(state: PlacementState, item: PlacementItem, at: number, o: { correct?: boolean | null; slow?: boolean; extra?: boolean } = {}): PlacementState {
  assert.notEqual(item.kind, 'typing');
  if (item.kind === 'typing') return state;
  const id = item.kind === 'predict' ? item.probe.id : item.completion.id;
  const group = item.kind === 'predict' ? item.probe.group : item.completion.group;
  return record(state, {
    conceptId: item.conceptId, itemId: id, kind: item.kind, group, correct: o.correct === undefined ? true : o.correct, guess: false,
    latencyMs: o.slow ? 40 * S : 5 * S, latencyValid: true, parSelfMs: 12 * S, at, extra: o.extra ?? !!item.extra,
  });
}

test('item 1 is the typing calibration; record() marks it done', () => {
  const s = newPlacement(T0);
  const first = nextItem(s, sources(), learner(), {});
  assert.deepEqual(first, { kind: 'typing', literal: typingLiteral('python', T0) });
  assert.match(typingLiteral('python', T0), /True|False|None|\{/);
  assert.match(typingLiteral('javascript', T0), /true|false|null|\{ x/);
  const s2 = record(s, { kind: 'typing', at: T0 + 5000 });
  assert.equal(s2.calibrated, true);
  assert.equal(nextItem(s2, sources(), learner(), {})?.kind, 'predict');
  assert.equal(nextItem(escape(s), sources(), learner(), {}), undefined, 'Esc during the typing item ends placement');
});

test('score = importance x (1 - |P - .5| x 2) + leafBonus; importance = 1 + descendants + 2 x needed', () => {
  const l = learner();
  const src = sources();
  const dag: PlacementDag = { needed: ['acc'] };
  assert.equal(importance(l, src, dag, 'vars'), 5);
  assert.equal(importance(l, src, dag, 'loops'), 2);
  assert.equal(importance(l, src, dag, 'acc'), 3, '1 + 0 descendants + 2 (needed)');
  const s = calibrated();
  assert.equal(placementScore(l, src, dag, s, 'vars').toFixed(3), (5 * 0.6).toFixed(3));
  assert.equal(placementScore(l, src, dag, s, 'acc').toFixed(3), (3 * 0.6).toFixed(3));
  const first = nextItem(s, src, l, dag);
  assert.equal(first?.kind === 'predict' && first.conceptId, 'vars', 'the most important uncertain concept first');
});

test('ticked concepts start at the deepest ticked leaves (leafBonus 3)', () => {
  const l = learner({ vars: 0.7, loops: 0.7, acc: 0.7, lists: 0.2, slicing: 0.2 }, ['vars', 'loops', 'acc']);
  const s = calibrated();
  const src = sources();
  assert.equal(placementScore(l, src, {}, s, 'acc').toFixed(3), (1 * 0.6 + 3).toFixed(3));
  assert.equal(placementScore(l, src, {}, s, 'loops').toFixed(3), (2 * 0.6).toFixed(3), 'a ticked descendant takes the bonus');
  const first = nextItem(s, src, l, {});
  assert.equal(first?.kind === 'predict' && first.conceptId, 'acc');
  // Once asked, the bonus is spent.
  const s2 = answer(s, first!, T0 + 20 * S);
  assert.equal(placementScore(l, src, {}, s2, 'acc').toFixed(3), (0.6).toFixed(3));
});

test('a correct leaf supports its ancestors (propagation), which lowers their selection score', () => {
  const l = learner();
  const src = sources();
  const s = calibrated();
  const before = placementScore(l, src, {}, s, 'loops');
  recordEvidence(l, { conceptId: 'acc', kind: 'predict', source: 'placement', correct: true, at: T0 + 10 * S, siblingGroup: 'acc-g1', g: 0.2 });
  assert.equal(l.concepts.loops.mastery, 0.75, 'single support: P .75');
  assert.equal(l.concepts.vars.mastery, 0.75);
  const after = placementScore(l, src, {}, s, 'loops');
  assert.ok(after < before, `${after} < ${before}`);
});

test('predict items come from an unseen sibling group and never repeat an item seen within 7 days', () => {
  const l = learner();
  const src = sources(T0, [{ conceptId: 'vars', probes: [probe('vars', 1, { stats: stats([T0 - 3600_000]) }), probe('vars', 2), probe('vars', 3)] }]);
  let s = calibrated();
  const a = nextItem(s, src, l, {})!;
  assert.equal(a.kind === 'predict' && a.probe.id, 'vars-p2', 'p1 was seen an hour ago');
  s = answer(s, a, T0 + 20 * S, { correct: true });
  l.concepts.vars.mastery = 0.5;
  const b = nextItem(s, src, l, {})!;
  assert.ok(b.kind === 'predict' && b.conceptId === 'vars' && b.probe.group !== 'vars-g2', 'another surface');
});

test('constructs the learner does not know are avoided; when unavoidable the item is confounded', () => {
  const l = learner({ vars: 0.2 });
  const src = sources(T0, [{ conceptId: 'loops', probes: [probe('loops', 1, { constructs: ['def'] }), probe('loops', 2, { constructs: ['for'] })] }]);
  src.constructConcept = (c) => (c === 'def' ? 'vars' : c === 'for' ? 'loops' : undefined);
  const s = calibrated();
  const only = { ...src, candidates: src.candidates.filter((c) => c.conceptId === 'loops') };
  const item = nextItem(s, only, l, {})!;
  assert.ok(item.kind === 'predict' && item.probe.id === 'loops-p2' && !item.confounded);
  const forced = { ...only, candidates: [{ ...only.candidates[0], probes: [only.candidates[0].probes[0]] }] };
  const f = nextItem(s, forced, l, {})!;
  assert.ok(f.kind === 'predict' && f.confounded === true);
});

test('STOP: every needed concept classified (P outside [.25, .8] or 2 items)', () => {
  const l = learner();
  const dag: PlacementDag = { needed: ['acc', 'slicing'] };
  let s = calibrated();
  assert.equal(shouldStop(s, sources(), l, dag).stop, false);
  l.concepts.acc.mastery = 0.1;
  for (let k = 1; k <= 2; k++) s = answer(s, { kind: 'predict', conceptId: 'slicing', probe: probe('slicing', k) }, T0 + k * 20 * S);
  const d = shouldStop(s, sources(), l, dag);
  assert.deepEqual(d, { stop: true, reason: 'classified' }, 'no concept at P >= .7 for the completions: stop now');
  assert.equal(nextItem(s, sources(), l, dag), undefined);
});

test('the last 2 items are completions on the highest-importance concepts at P >= .7', () => {
  const l = learner({ vars: 0.75, lists: 0.75, loops: 0.75, acc: 0.1, slicing: 0.1 });
  const dag: PlacementDag = { needed: ['acc', 'slicing'] };
  let s = calibrated();
  const c1 = nextItem(s, sources(), l, dag)!;
  assert.ok(c1.kind === 'completion' && c1.conceptId === 'vars', 'importance 5');
  s = answer(s, c1, T0 + 40 * S);
  const c2 = nextItem(s, sources(), l, dag)!;
  assert.ok(c2.kind === 'completion' && c2.conceptId === 'lists', 'importance 2, tie broken by id');
  s = answer(s, c2, T0 + 80 * S);
  assert.deepEqual(shouldStop(s, sources(), l, dag), { stop: true, reason: 'classified' });
});

test('STOP: 14 items, 4 minutes, Esc', () => {
  const l = learner();
  let s = calibrated();
  for (let k = 0; k < PLACEMENT.maxItems; k++) s = answer(s, { kind: 'predict', conceptId: 'vars', probe: probe('vars', 100 + k) }, T0 + k * S, { correct: null });
  assert.deepEqual(shouldStop(s, sources(T0 + 30 * S), l, {}), { stop: true, reason: 'max-items' });
  const t = calibrated();
  assert.deepEqual(shouldStop(t, sources(T0 + 4 * 60 * S), l, {}), { stop: true, reason: 'time' });
  assert.deepEqual(shouldStop(escape(t), sources(), l, {}), { stop: true, reason: 'esc' });
});

test('the predict phase ends at 12 items, leaving the last 2 for completions', () => {
  const l = learner({ vars: 0.75 });
  let s = calibrated();
  for (let k = 0; k < PLACEMENT.predictItems; k++) {
    s = answer(s, { kind: 'predict', conceptId: 'lists', probe: probe('lists', 200 + k) }, T0 + (k + 1) * 5 * S, { correct: k % 2 === 0 });
  }
  l.concepts.lists.mastery = 0.5;
  const item = nextItem(s, sources(T0 + 70 * S), l, {})!;
  assert.ok(item.kind === 'completion' && item.conceptId === 'vars');
});

test('EXPERIENCED FAST LANE: 2 quick correct leaf predicts bring a leaf completion; a third quick correct one ends placement', () => {
  const l = learner({ vars: 0.75, loops: 0.75, acc: 0.75, lists: 0.75, slicing: 0.75 });
  let s = calibrated();
  s = answer(s, { kind: 'predict', conceptId: 'acc', probe: probe('acc', 1) }, T0 + 15 * S);
  s = answer(s, { kind: 'predict', conceptId: 'slicing', probe: probe('slicing', 1) }, T0 + 25 * S);
  const c = nextItem(s, sources(T0 + 25 * S), l, {})!;
  assert.ok(c.kind === 'completion' && (c.conceptId === 'acc' || c.conceptId === 'slicing'), 'a completion on a leaf');
  s = answer(s, c, T0 + 50 * S);
  assert.deepEqual(shouldStop(s, sources(T0 + 50 * S), l, {}), { stop: true, reason: 'fast-lane' });
  // A slow answer breaks the streak.
  let slow = calibrated();
  slow = answer(slow, { kind: 'predict', conceptId: 'acc', probe: probe('acc', 1) }, T0 + 15 * S);
  slow = answer(slow, { kind: 'predict', conceptId: 'slicing', probe: probe('slicing', 1) }, T0 + 60 * S, { slow: true });
  const n = nextItem(slow, sources(T0 + 60 * S), l, {})!;
  assert.equal(n.kind, 'predict');
  // Non-leaf concepts never start the fast lane.
  let mid = calibrated();
  mid = answer(mid, { kind: 'predict', conceptId: 'vars', probe: probe('vars', 1) }, T0 + 15 * S);
  mid = answer(mid, { kind: 'predict', conceptId: 'loops', probe: probe('loops', 1) }, T0 + 25 * S);
  assert.equal(nextItem(mid, sources(T0 + 25 * S), l, {})!.kind, 'predict');
});

test('plan still pending at the stop: up to 5 harder items at P .6-.85, labelled, then stop "plan-pending"', () => {
  const l = learner({ vars: 0.7, lists: 0.65, loops: 0.2, acc: 0.1, slicing: 0.9 });
  let s = calibrated();
  for (let k = 0; k < PLACEMENT.maxItems; k++) s = answer(s, { kind: 'predict', conceptId: 'loops', probe: probe('loops', 300 + k) }, T0 + k * S);
  const src = () => sources(T0 + 60 * S, [
    { conceptId: 'vars', probes: [1, 2, 3, 4, 5, 6].map((k) => probe('vars', k, { answerSpaceG: k % 2 ? 0.5 : 0.04 })) },
  ]);
  assert.deepEqual(shouldStop(s, src(), l, {}, { planPending: true }), { stop: false, extraPhase: true });
  const seen: string[] = [];
  for (let k = 0; k < PLACEMENT.extraItems; k++) {
    const item = nextItem(s, src(), l, {}, { planPending: true })!;
    assert.ok(item && item.kind === 'predict' && item.extra && item.label === 'roadmap almost ready', `extra ${k}`);
    assert.ok(['vars', 'lists'].includes(item.conceptId));
    if (item.conceptId === 'vars' && !seen.some((x) => x.startsWith('vars'))) assert.equal(item.probe.answerSpaceG, 0.04, 'structured answers first');
    seen.push(item.probe.id);
    s = answer(s, item, T0 + (70 + k) * S, { extra: true });
  }
  assert.equal(new Set(seen).size, 5, 'no repeats');
  assert.deepEqual(shouldStop(s, src(), l, {}, { planPending: true }), { stop: true, reason: 'plan-pending' });
  assert.deepEqual(shouldStop(s, src(), l, {}), { stop: true, reason: 'max-items' }, 'once the plan lands');
});

test('summary: one card text and a status flash', () => {
  const l = learner({ vars: 0.8, loops: 0.75, acc: 0.2, lists: 0.3 });
  l.concepts.lists.misconceptions['assignment-copies'] = { p: 0.4, belief: 'b = a copies', status: 'candidate', groups: ['g'], delayedHits: 0, relapses: 0, lastAt: T0 };
  let s = calibrated();
  s = answer(s, { kind: 'predict', conceptId: 'vars', probe: probe('vars', 1) }, T0 + 30 * S);
  s = answer(s, { kind: 'predict', conceptId: 'loops', probe: probe('loops', 1) }, T0 + 60 * S);
  s = record(s, { conceptId: 'lists', itemId: 'lists-p1', kind: 'predict', group: 'lists-g1', correct: false, guess: false, latencyValid: true, at: T0 + 90 * S, misconceptionId: 'assignment-copies' });
  s = answer(s, { kind: 'predict', conceptId: 'acc', probe: probe('acc', 1) }, T0 + 130 * S, { correct: false });
  const sum = summary(s, l, { now: T0 + 130 * S, names: { vars: 'variables', loops: 'loops', lists: 'lists', acc: 'accumulators' } });
  assert.equal(sum.items, 4);
  assert.equal(sum.text, 'Placement: 4 items, 2m10s. Solid: variables, loops. Possible misconception: lists (seen once). New: lists, accumulators');
  assert.equal(sum.flash, 'Placement done: 4 items, 2m10s');
  assert.equal(sum.misconceptions[0].belief, 'b = a copies');
  assert.equal(formatDuration(45 * S), '45s');
  assert.equal(formatDuration(130 * S), '2m10s');
});
