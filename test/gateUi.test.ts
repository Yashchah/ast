// GateUi (src/gate.ts): the two QuickPick steps driven through a scripted PickPort.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GatePattern, GatePlan } from '../src/contracts';
import {
  CACHE_MISS_CARD, GateUi, OWN_PLAN_TOOLTIP, PATTERN_PLACEHOLDER, gatePackProblem, gateRouting, planLabels, stepATitle, stepBRuns,
  type GatePrep, type PickOutcome, type PickPort, type PickRequest,
} from '../src/gate';
import { DECOMPOSITION, emptyLearner, upsertConcepts } from '../src/learner';
import { mulberry32 } from '../src/atoms/rng';

const T0 = Date.UTC(2026, 9, 3, 11, 0, 0);

const patterns: GatePattern[] = [
  { name: 'Count with dict', conceptId: 'counting-with-dict', required: true, competesWith: '', useWhen: 'tallying how often each item appears', whyNot: '' },
  { name: 'Split and join', conceptId: 'string-split-join', required: true, competesWith: '', useWhen: 'breaking text into words', whyNot: '' },
  { name: 'Loop with index', conceptId: 'for-range-bounds', required: true, competesWith: '', useWhen: 'walking positions in order', whyNot: '' },
  { name: 'Sort by key', conceptId: 'sorting-key', required: false, competesWith: 'counting-with-dict', useWhen: '', whyNot: 'order is not needed to count' },
  { name: 'Nested loops', conceptId: 'nested-loops', required: false, competesWith: 'for-range-bounds', useWhen: '', whyNot: 'one pass is enough here' },
];

const plans: GatePlan[] = [
  { text: 'Split words, count each in a dict', workable: true, flawConceptId: '', misconceptionId: '', whyFlawed: '' },
  { text: 'Sort the words, then count them all', workable: false, flawConceptId: 'sorting-key', misconceptionId: 'sort-counts', whyFlawed: 'Does sorting tell you how many?' },
  { text: 'Count words with one shared counter', workable: false, flawConceptId: 'loop-accumulator', misconceptionId: 'assign-instead-of-add', whyFlawed: 'What does = do to the old count?' },
];

const prep: GatePrep = { patterns, plans };
const task = { id: 't2', title: 'Word counter', number: 2 };

type Step = (req: PickRequest) => PickOutcome;

/** Picks by label text, so the shuffled order does not matter. */
const pickLabels = (...labels: string[]): Step => (req) => ({ kind: 'accept', selected: labels.map((l) => req.items.findIndex((i) => i.label === l || i.label.endsWith(` ${l}`))) });

class ScriptedPick implements PickPort {
  requests: PickRequest[] = [];
  constructor(private readonly steps: Step[]) {}
  async pick(req: PickRequest): Promise<PickOutcome> {
    this.requests.push(req);
    const s = this.steps.shift();
    return s ? s(req) : { kind: 'esc' };
  }
}

function ui(steps: Step[], lock?: { acquire: () => (() => void) | undefined }) {
  const pick = new ScriptedPick(steps);
  let t = T0;
  const clock = { now: () => (t += 4000), setTimeout: () => 0, clearTimeout: () => undefined };
  return { pick, gate: new GateUi({ pick, clock, ...(lock ? { lock } : {}) }) };
}

const rng = () => mulberry32(7);

describe('GateUi', () => {
  test('step A: the title, placeholder, 5 shuffled names only, multi-select and the own-plan button', async () => {
    const { pick, gate } = ui([pickLabels('Count with dict', 'Split and join', 'Loop with index')]);
    await gate.run(task, prep, { fade: 'partial', rng: rng() });
    const a = pick.requests[0];
    assert.equal(a.title, 'Task 2 · Word counter: which patterns will you need?');
    assert.equal(a.placeholder, PATTERN_PLACEHOLDER);
    assert.equal(a.canSelectMany, true);
    assert.equal(a.buttonTooltip, OWN_PLAN_TOOLTIP);
    assert.deepEqual([...a.items.map((i) => i.label)].sort(), patterns.map((p) => p.name).sort());
    assert.notDeepEqual(a.items.map((i) => i.label), patterns.map((p) => p.name), 'shuffled (seeded)');
  });

  test('full fade: step B carries step A feedback in its title; a workable plan is correct on decomposition', async () => {
    const { pick, gate } = ui([pickLabels('Count with dict', 'Loop with index', 'Sort by key'), pickLabels('Split words, count each in a dict')]);
    const r = await gate.run(task, prep, { fade: 'full', rng: rng() });
    assert.equal(r.kind, 'done');
    assert.equal(r.stepB, true);
    const b = pick.requests[1];
    assert.equal(b.title, '2/3 patterns · missed: Split and join · Which plan works?');
    assert.equal(b.canSelectMany, false);
    assert.deepEqual(b.items.map((i) => i.label.slice(0, 2)), ['1 ', '2 ', '3 ']);
    const ev = r.evidence.map((e) => [e.conceptId, e.kind, e.correct, e.weight ?? 1, e.misconceptionId]);
    assert.deepEqual(ev, [
      ['counting-with-dict', 'pattern-pick', true, 1, undefined],
      ['string-split-join', 'pattern-pick', false, 1, undefined],
      ['for-range-bounds', 'pattern-pick', true, 1, undefined],
      ['counting-with-dict', 'pattern-pick', false, 0.3, undefined], // the lure: weight .3 and NO misconception
      [DECOMPOSITION, 'plan-pick', true, 1, undefined],
    ]);
    assert.deepEqual(r.record, { selected: ['Count with dict', 'Loop with index', 'Sort by key'], missed: ['Split and join'], lures: ['Sort by key'], planPicked: 0, ms: r.ms });
    assert.ok(r.ms > 0);
    assert.equal(r.goBuild, 'Go build');
    assert.deepEqual(r.notes.map((n) => n.kind), ['missed', 'lure']);
    assert.deepEqual(r.required, ['Count with dict', 'Split and join', 'Loop with index']);
  });

  test('a flawed plan: wrong on its concept with the misconception at x2, whyFlawed in the Go build flash', async () => {
    const { gate } = ui([pickLabels('Count with dict', 'Split and join', 'Loop with index'), pickLabels('Sort the words, then count them all')]);
    const r = await gate.run(task, prep, { fade: 'full', rng: rng(), priorFlawedTasks: 2 });
    const flawed = r.evidence.find((e) => e.kind === 'plan-pick' && e.conceptId === 'sorting-key')!;
    assert.equal(flawed.correct, false);
    assert.equal(flawed.misconceptionId, 'sort-counts');
    assert.equal(flawed.misconceptionOdds, 2);
    assert.ok(r.evidence.some((e) => e.conceptId === DECOMPOSITION && e.correct === false), 'a third task with a flawed pick lowers decomposition');
    assert.equal(r.flawedTasks, 3);
    assert.equal(r.goBuild, 'Go build · Does sorting tell you how many?');
    assert.deepEqual(r.notes.at(-1), { name: 'A plan that works', text: 'Split words, count each in a dict', kind: 'workable' });
    assert.equal(r.record!.planPicked, 1, 'indexes prep.plans, not the shuffled order');
    assert.equal(r.plansShown![r.plan!.picked].text, plans[1].text);
  });

  test('partial fade: step A only, its feedback is the 3 s flash', async () => {
    const { pick, gate } = ui([pickLabels('Count with dict')]);
    const r = await gate.run(task, prep, { fade: 'partial', rng: rng() });
    assert.equal(pick.requests.length, 1);
    assert.equal(r.stepB, false);
    assert.equal(r.flash, '1/3 patterns · missed: Split and join, Loop with index');
    assert.equal(r.record!.planPicked, -1);
  });

  test('the plan length check drops step B even at full fade', async () => {
    const lopsided: GatePlan[] = [{ ...plans[0], text: 'Split the text into words, then count every word with a dict' }, plans[1], { ...plans[2], text: 'Count it' }];
    assert.equal(stepBRuns('full', { patterns, plans: lopsided }), false);
    const { pick, gate } = ui([pickLabels('Count with dict', 'Split and join', 'Loop with index')]);
    const r = await gate.run(task, { patterns, plans: lopsided }, { fade: 'full', rng: rng() });
    assert.equal(pick.requests.length, 1);
    assert.equal(r.stepB, false);
    assert.equal(r.flash, '3/3 patterns');
  });

  test("'I'd do it differently' and Esc on step A record nothing", async () => {
    for (const kind of ['own-plan', 'esc'] as const) {
      const { gate } = ui([() => ({ kind })]);
      const r = await gate.run(task, prep, { fade: 'full', rng: rng() });
      assert.equal(r.kind, kind === 'own-plan' ? 'own-plan' : 'skipped');
      assert.equal(r.step, 'A');
      assert.deepEqual(r.evidence, []);
      assert.equal(r.record, undefined);
    }
  });

  test("on step B, 'I'd do it differently' and Esc record no plan evidence; the submitted step A stands", async () => {
    const own = await ui([pickLabels('Count with dict', 'Split and join', 'Loop with index'), () => ({ kind: 'own-plan' })]).gate.run(task, prep, { fade: 'full', rng: rng() });
    assert.equal(own.kind, 'own-plan');
    assert.equal(own.step, 'B');
    assert.ok(own.evidence.every((e) => e.kind === 'pattern-pick'));
    const esc = await ui([pickLabels('Count with dict', 'Split and join', 'Loop with index'), () => ({ kind: 'esc' })]).gate.run(task, prep, { fade: 'full', rng: rng() });
    assert.equal(esc.kind, 'done');
    assert.equal(esc.plan, undefined);
    assert.equal(esc.record!.planPicked, -1);
    assert.ok(esc.evidence.every((e) => e.kind === 'pattern-pick'));
  });

  test('cache miss, minimal / solo fade and a held lock', async () => {
    const miss = await ui([]).gate.run(task, undefined, { fade: 'full' });
    assert.deepEqual([miss.kind, miss.card, miss.evidence.length], ['no-pack', CACHE_MISS_CARD, 0]);
    const bad = await ui([]).gate.run(task, { patterns: patterns.map((p) => ({ ...p, required: false })), plans }, { fade: 'full' });
    assert.equal(bad.kind, 'no-pack');
    for (const fade of ['minimal', 'solo'] as const) assert.equal((await ui([]).gate.run(task, prep, { fade })).kind, 'not-needed');
    assert.equal((await ui([], { acquire: () => undefined }).gate.run(task, prep, { fade: 'full' })).kind, 'busy');
    assert.equal((await ui([]).gate.run(task, prep, { decompositionP: 0.85 })).kind, 'not-needed', 'fade from decomposition P');
  });
});

describe('gate helpers', () => {
  test('pack problems: duplicates, no required pattern, the reading budget', () => {
    assert.equal(gatePackProblem(prep), undefined);
    assert.match(gatePackProblem({ patterns: [...patterns.slice(0, 4), { ...patterns[0] }], plans })!, /duplicate/);
    assert.match(gatePackProblem({ patterns: patterns.slice(0, 2), plans })!, /expected 5/);
    const wordy = patterns.map((p, i) => ({ ...p, name: `${'very '.repeat(10)}long name ${i}` }));
    assert.match(gatePackProblem({ patterns: wordy, plans })!, /reading budget/);
  });

  test('titles and labels', () => {
    assert.equal(stepATitle({ id: 'x', title: ' Word counter ' }), 'Word counter: which patterns will you need?');
    assert.deepEqual(planLabels(plans.slice(0, 2)).map((p) => p.label), ['1 Split words, count each in a dict', '2 Sort the words, then count them all']);
  });

  test('gateRouting: a missed pattern below P .5 opens an atom; the rest become JIT offers', async () => {
    const l = emptyLearner();
    upsertConcepts(l, ['counting-with-dict', 'string-split-join', 'for-range-bounds', 'sorting-key', 'nested-loops'].map((id) => ({ id, name: id, tag: id })), T0);
    l.concepts['string-split-join'].mastery = 0.3;
    l.concepts['for-range-bounds'].mastery = 0.6;
    const r = await ui([pickLabels('Count with dict'), pickLabels('Sort the words, then count them all')]).gate.run(task, prep, { fade: 'full', rng: rng() });
    const routing = gateRouting(r, prep, l, ['counting-with-dict', 'string-split-join', 'for-range-bounds'], T0);
    const atoms = routing.atoms.map((g) => g.conceptId);
    assert.ok(atoms.includes('sorting-key'), 'the flawed plan concept');
    assert.ok([...atoms, ...routing.jit.map((g) => g.conceptId)].includes('string-split-join'), 'the missed weak pattern');
    assert.ok(![...atoms, ...routing.jit.map((g) => g.conceptId)].includes('for-range-bounds'), 'missed, but P .6: no atom');
  });
});
