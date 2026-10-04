import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MisconceptionState, PatternCard, StoredCompletion, StoredContrast, StoredMutant, StoredProbe, TracebackItem } from '../src/contracts';
import {
  SPRINT, newSprint, nextSprintItem, recordSprintPick, sprintItemId, sprintShouldStop, type SprintContext, type SprintPick, type SprintState,
  type SprintStock,
} from '../src/atoms/sprintSelect';
import { mulberry32 } from '../src/atoms/seeds';
import { emptyLearner, upsertConcepts } from '../src/learner';
import type { ConceptState, Learner } from '../src/types';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

const stats = (seenAt: number[] = []) => ({ seenAt, n: 0, nCorrect: 0 });

function mutant(mid: string): StoredMutant {
  return { id: `m-${mid}`, misconceptionId: mid, belief: '', refutation: '', rule: '', code: '', output: { stdout: '', values: [] }, diffLine: 1, source: 'curated', ambiguous: false, matches: 0, confirmations: 0, rejections: 0 };
}

function probe(concept: string, k: number, mids: string[] = [], seenAt: number[] = []): StoredProbe {
  return {
    id: `${concept}-p${k}`, group: `${concept}-g${k}`, code: `print(${k})`, output: { stdout: `${k}\n`, values: [] }, parSec: 5, answerSpaceG: 0.2,
    constructs: [], discriminating: mids.length > 0, mutants: mids.map(mutant), stats: stats(seenAt),
  };
}

const completion = (concept: string, k = 1): StoredCompletion => ({
  id: `${concept}-c${k}`, group: `${concept}-cg${k}`, code: 'x = [[1]]', solutions: ['1'], wrongFills: [], harness: 'check(x == 1)', parSec: 25, stats: stats(),
});

const traceback = (k: number, frames: 1 | 2): TracebackItem => ({
  id: `tb${k}`, code: 'x', line: 2, exception: 'IndexError', meanings: ['a', 'b', 'c'], correctMeaning: 0, siblingGroup: `tb:${k}`, conceptId: 'reading-tracebacks',
  trace: frames === 2
    ? 'Traceback (most recent call last):\n  File "pad", line 5, in <module>\n    f()\n  File "pad", line 2, in f\n    xs[9]\nIndexError: list index out of range'
    : 'Traceback (most recent call last):\n  File "pad", line 2, in <module>\n    xs[9]\nIndexError: list index out of range',
});

const IDS = ['alias-copy', 'list-slicing', 'loop-accumulator', 'string-methods', 'counting-with-dict', 'collections-counter', 'reading-tracebacks'];

function learner(): Learner {
  const l = emptyLearner();
  upsertConcepts(l, IDS.map((id) => ({ id, name: id, tag: id })), NOW - 30 * DAY);
  return l;
}

function stockAll(): Record<string, SprintStock> {
  const s: Record<string, SprintStock> = {};
  for (const id of IDS) s[id] = { probes: [1, 2, 3, 4].map((k) => probe(id, k)), completions: [completion(id)] };
  s['alias-copy'].probes = [probe('alias-copy', 1, ['assignment-copies']), probe('alias-copy', 2), probe('alias-copy', 3, ['assignment-copies'])];
  s['reading-tracebacks'] = { tracebacks: [traceback(1, 1), traceback(2, 2), traceback(3, 1)] };
  return s;
}

const mis = (over: Partial<MisconceptionState>): MisconceptionState => ({ p: 0.5, belief: '', status: 'suppressed', groups: [], delayedHits: 0, relapses: 0, lastAt: NOW - DAY, ...over });

function ctx(l: Learner, over: Partial<SprintContext> = {}): SprintContext {
  return { now: NOW, lang: 'python', learner: l, stock: stockAll(), rng: mulberry32(7), ...over };
}

function run(state: SprintState, c: SprintContext, n: number): { state: SprintState; picks: SprintPick[] } {
  const picks: SprintPick[] = [];
  for (let i = 0; i < n; i++) {
    const p = nextSprintItem(state, c);
    if (!p) break;
    picks.push(p);
    state = recordSprintPick(state, p, NOW + i * 20_000);
  }
  return { state, picks };
}

function set(l: Learner, id: string, over: Partial<ConceptState>): void {
  Object.assign(l.concepts[id], over);
}

test('selection order: delayed misconception checks, audits, guess/fragile, due, single-support confirmations, then which-pattern', () => {
  const l = learner();
  set(l, 'alias-copy', { misconceptions: { 'assignment-copies': mis({ status: 'suppressed', nextCheckAt: NOW - MIN, refutedAt: NOW - 20 * MIN }) } });
  set(l, 'list-slicing', { masteredAt: NOW - 2 * DAY, auditDueAt: NOW - DAY, mastery: 0.9 });
  set(l, 'loop-accumulator', { fragile: true, fragileSince: NOW - DAY });
  set(l, 'string-methods', { nextReview: NOW - 1000, intervalDays: 1 });
  set(l, 'counting-with-dict', { tested: false, supportFrom: ['loop-accumulator'] });
  const deck: PatternCard[] = [card('collections-counter', 'Count with Counter'), card('alias-copy', 'Aliases share one object'), card('list-slicing', 'Slice a sequence'), card('string-methods', 'Call string methods')];
  const { picks } = run(newSprint(NOW), ctx(l, { deck }), 6);
  assert.deepEqual(picks.map((p) => p.reason), ['delayed-check', 'audit', 'fragile', 'due', 'traceback', 'confirm-inferred']);
  const first = picks[0];
  assert.ok(first.kind === 'predict' && first.delayedCheckFor === 'assignment-copies' && first.probe.mutants.some((m) => m.misconceptionId === 'assignment-copies'));
  assert.ok(picks[1].kind === 'completion' && picks[1].audit === true);
});

function card(tag: string, name: string, useCases = ['count words in a sentence', 'tally votes by name', 'find the most common letter', 'group scores', 'merge two lists', 'track seen ids']): PatternCard {
  return { conceptId: tag, tag, kind: 'shape', name, useWhen: '', template: '', rule: '', pitfall: '', useCases, useCaseSeenAt: {}, addedAt: NOW - DAY };
}

test('active misconceptions get items from a sibling group that has not matched yet', () => {
  const l = learner();
  set(l, 'alias-copy', { misconceptions: { 'assignment-copies': mis({ status: 'active', groups: ['alias-copy-g1'], nextCheckAt: NOW - 1 }) } });
  const p = nextSprintItem(newSprint(NOW), ctx(l))!;
  assert.ok(p.kind === 'predict' && p.probe.id === 'alias-copy-p3' && p.delayedCheckFor === 'assignment-copies');
  set(l, 'alias-copy', { misconceptions: { 'assignment-copies': mis({ status: 'suppressed', nextCheckAt: NOW + 5 * MIN }) } });
  assert.notEqual(nextSprintItem(newSprint(NOW), ctx(l))?.reason, 'delayed-check', 'not due yet');
});

test('never two consecutive items on the same concept', () => {
  const l = learner();
  for (const id of IDS) set(l, id, { nextReview: NOW - 1000 });
  set(l, 'alias-copy', { misconceptions: { 'assignment-copies': mis({ nextCheckAt: NOW - 1 }), 'param-gets-copy': mis({ nextCheckAt: NOW - 1 }) } });
  const s = stockAll();
  s['alias-copy'].probes = [probe('alias-copy', 1, ['assignment-copies']), probe('alias-copy', 2, ['param-gets-copy'])];
  const { picks } = run(newSprint(NOW), ctx(l, { stock: s }), 12);
  for (let i = 1; i < picks.length; i++) assert.notEqual(picks[i].conceptId, picks[i - 1].conceptId, `items ${i - 1} and ${i}`);
  assert.ok(picks.filter((p) => p.reason === 'delayed-check').length === 2);
  // With only one concept in stock the sprint ends rather than repeat it.
  const solo = learner();
  set(solo, 'list-slicing', { nextReview: NOW - 1 });
  const only = run(newSprint(NOW), ctx(solo, { stock: { 'list-slicing': stockAll()['list-slicing'] } }), 5);
  assert.equal(only.picks.length, 1);
});

test('traceback items fill 1 in every 5 slots, multi-frame traces first', () => {
  const l = learner();
  for (const id of IDS) set(l, id, { nextReview: NOW - 1000 });
  const deck = [card('alias-copy', 'Aliases share one object'), card('list-slicing', 'Slice a sequence'), card('string-methods', 'Call string methods'), card('loop-accumulator', 'Accumulate in a loop')];
  const { picks } = run(newSprint(NOW), ctx(l, { deck }), 10);
  assert.equal(picks.length, 10);
  assert.deepEqual(picks.map((p, i) => [i + 1, p.kind === 'traceback']).filter(([, tb]) => tb).map(([i]) => i), [5, 10]);
  const tb = picks[4];
  assert.ok(tb.kind === 'traceback' && tb.item.id === 'tb2', 'the trace through a helper function first');
  assert.equal(tb.conceptId, 'reading-tracebacks');
});

test('no exact repeat within 7 days, nor within the sprint', () => {
  const l = learner();
  set(l, 'list-slicing', { nextReview: NOW - 1 });
  const s = stockAll();
  s['list-slicing'].probes = [probe('list-slicing', 1, [], [NOW - 2 * DAY]), probe('list-slicing', 2, [], [NOW - 8 * DAY])];
  s['list-slicing'].completions = [];
  const p = nextSprintItem(newSprint(NOW), ctx(l, { stock: s }))!;
  assert.ok(p.kind === 'predict' && p.probe.id === 'list-slicing-p2', 'seen 2 days ago is skipped; 8 days ago is fine');
  const st = recordSprintPick(newSprint(NOW), p, NOW);
  const again = nextSprintItem({ ...st, picks: [...st.picks, { conceptId: 'x', itemId: 'z', kind: 'predict', reason: 'due', at: NOW }] }, ctx(l, { stock: s }));
  assert.equal(again, undefined, 'the fresh one was used in this sprint; nothing else fits');
});

test('which-pattern: a use case not seen in 7 days; distractors never from valid alternatives', () => {
  const l = learner();
  const right = card('counting-with-dict', 'Count with a dictionary');
  right.useCaseSeenAt = { 'count words in a sentence': NOW - DAY };
  const deck = [right, card('collections-counter', 'Count with Counter'), card('alias-copy', 'Aliases share one object'), card('list-slicing', 'Slice a sequence')];
  for (let seed = 1; seed < 20; seed++) {
    const p = nextSprintItem(newSprint(NOW), ctx(l, { deck: [deck[0]], rng: mulberry32(seed), stock: {} }))!;
    assert.ok(p.kind === 'which-pattern');
    assert.notEqual(p.useCase, 'count words in a sentence');
    assert.equal(p.options.length, 4);
    assert.equal(p.options[p.correct], 'Count with a dictionary');
    assert.ok(!p.options.includes('Count with Counter'), 'collections-counter is a valid alternative');
    assert.equal(new Set(p.options).size, 4);
  }
  const fromDeck = nextSprintItem(newSprint(NOW), ctx(l, { deck, stock: {} }))!;
  assert.ok(fromDeck.kind === 'which-pattern');
  if (fromDeck.card.tag === 'counting-with-dict') assert.ok(!fromDeck.options.includes('Count with Counter'));
  assert.equal(sprintItemId(fromDeck), `${fromDeck.card.conceptId}::${fromDeck.useCase}`);
});

test('a selectionGap concept gets which-pattern and contrast items instead of more predicts', () => {
  const l = learner();
  set(l, 'alias-copy', { selectionGap: true, nextReview: NOW - 1 });
  const deck = [card('alias-copy', 'Aliases share one object'), card('list-slicing', 'Slice a sequence')];
  const p = nextSprintItem(newSprint(NOW), ctx(l, { deck }))!;
  assert.ok(p.kind === 'which-pattern' && p.conceptId === 'alias-copy' && p.reason === 'due');
  const ct: StoredContrast = { id: 'ct', wrong: 'a', right: 'b', wrongOutput: { stdout: '', values: [] }, rightOutput: { stdout: '', values: [] }, misconceptionId: 'assignment-copies', rule: '' };
  const s = stockAll();
  s['alias-copy'].contrasts = [ct];
  const q = nextSprintItem(newSprint(NOW), ctx(l, { deck: [], stock: s }))!;
  assert.ok(q.kind === 'contrast' && q.contrast.id === 'ct');
});

test('stop: Esc at once; until settles after the current item (abandoned after 15 s); budget; max items', () => {
  const s0 = newSprint(NOW);
  assert.deepEqual(sprintShouldStop(s0, { now: NOW + 1000, esc: true, itemOpen: true }), { stop: true, reason: 'esc', abandonCurrent: true });
  assert.deepEqual(sprintShouldStop(s0, { now: NOW + 5000, untilSettledAt: NOW + 4000, itemOpen: true }), { stop: false });
  assert.deepEqual(sprintShouldStop(s0, { now: NOW + 5000, untilSettledAt: NOW + 4000, itemOpen: false }), { stop: true, reason: 'until', abandonCurrent: false });
  assert.deepEqual(sprintShouldStop(s0, { now: NOW + 4000 + SPRINT.untilGraceMs, untilSettledAt: NOW + 4000, itemOpen: true }), { stop: true, reason: 'until', abandonCurrent: true });
  assert.deepEqual(sprintShouldStop(s0, { now: NOW + SPRINT.budgetMs, itemOpen: true }), { stop: false }, 'the current item finishes');
  assert.deepEqual(sprintShouldStop(s0, { now: NOW + SPRINT.budgetMs }), { stop: true, reason: 'budget' });
  let s = s0;
  const l = learner();
  for (const id of IDS) set(l, id, { nextReview: NOW - 1 });
  s = run(s, ctx(l), SPRINT.maxItems).state;
  assert.deepEqual(sprintShouldStop(s, { now: NOW + 1000 }), { stop: true, reason: 'max-items' });
  assert.deepEqual(sprintShouldStop(s, { now: NOW + 1000, maxItems: 10 }), { stop: false });
});
