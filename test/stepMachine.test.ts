import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AtomPattern, PrintedArg, RecordedOutput, StoredAtom, StoredCompletion, StoredContrast, StoredExample, StoredMutant, StoredProbe, Val,
} from '../src/contracts';
import type { CompletionGrade } from '../src/atoms/grade';
import {
  ATOM_CAPS, activeMs, atomDeadline, chooseItem, routeAtom, startAtom, stepAtom, type AtomEffect, type AtomEvent, type AtomRunState,
  type AtomStart, type StepOutput,
} from '../src/atoms/stepMachine';
import { emptyLearner, recordEvidence, upsertConcepts, type EvidenceInput } from '../src/learner';
import type { ConceptState, Learner } from '../src/types';

const T0 = Date.UTC(2026, 9, 3, 10, 0, 0);
const M = 'assignment-copies';
const BELIEF = 'b = a makes a separate copy of the list';

// ---------------------------------------------------------------- fixtures

const int = (n: number): Val => ({ t: 'int', v: String(n) });
const pyList = (ns: number[]): PrintedArg => ({ type: 'list', repr: `[${ns.join(', ')}]`, val: { t: 'list', v: ns.map(int) } });
const printed = (...calls: PrintedArg[][]): RecordedOutput => ({
  stdout: calls.map((a) => a.map((x) => (x.val.t === 'str' ? x.val.v : x.repr)).join(' ')).join('\n') + '\n', values: calls,
});
const stats = () => ({ seenAt: [] as number[], n: 0, nCorrect: 0 });

/** a = [x, y]; b = a; b.append(z); print(a) -- the alias mutant prints the list unchanged. */
function aliasProbe(id: string, group: string, start: number[], add: number): StoredProbe {
  const code = `a = [${start.join(', ')}]\nb = a\nb.append(${add})\nprint(a)`;
  const m: StoredMutant = {
    id: `${id}~${M}`, misconceptionId: M, belief: BELIEF, refutation: 'b = a gives the list a second name; appending through b changes a.',
    rule: 'Assignment shares the list; .copy() makes a new one.', code: code.replace('b = a', 'b = a.copy()'),
    output: printed([pyList(start)]), diffLine: 2, source: 'curated', ambiguous: false, matches: 0, confirmations: 0, rejections: 0,
  };
  return {
    id, group, code, output: printed([pyList([...start, add])]), parSec: 5, answerSpaceG: 0.06, constructs: ['list-literal', 'call'],
    discriminating: true, mutants: [m], stats: stats(),
    trace: [{ line: 1, text: `a=[${start.join(', ')}]` }, { line: 2, text: 'b is a' }],
  };
}

const right = (p: StoredProbe) => p.output.stdout.trim();
const wrongM = (p: StoredProbe) => p.mutants[0].output.stdout.trim();

const examples: StoredExample[] = [1, 2].map((k) => ({
  id: `ex${k}`, group: `ex:${k}`, code: `a = [${k}]\nb = a\nb.append(0)\nprint(a)`, subgoals: [{ line: 2, label: 'one list, two names' }],
  output: printed([pyList([k, 0])]),
}));

const completion = (id: string, group: string, blanks: 1 | 2): StoredCompletion => ({
  id, group, parSec: 25, stats: stats(),
  code: blanks === 1 ? 'def add_all(xs, ys):\n    out = [[1]]\n    out.extend(ys)\n    return out' : 'def add_all(xs, ys):\n    out = [[1]]\n    out.extend([[2]])\n    return out',
  solutions: blanks === 1 ? ['xs.copy()'] : ['xs.copy()', 'ys'],
  wrongFills: [{ blank: 1, fill: 'xs', misconceptionId: M }],
  harness: "a = [1]\ncheck(add_all(a, [2]) == [1, 2], 'returns both')\ncheck(a == [1], 'leaves xs alone')",
});

const contrast: StoredContrast = {
  id: 'ct1', misconceptionId: M, rule: 'b = a shares one list; a.copy() makes a new one.',
  wrong: 'a = [1]\nb = a.copy()\nb.append(9)\nprint(a)', right: 'a = [1]\nb = a\nb.append(9)\nprint(a)',
  wrongOutput: printed([pyList([1])]), rightOutput: printed([pyList([1, 9])]),
};

const pattern: AtomPattern = {
  kind: 'semantics', name: 'Aliases share one object', useWhen: '', template: '', rule: 'Assignment never copies a list.',
  howItRuns: '', pitfall: '', useCases: [],
};

function atom(over: Partial<StoredAtom> = {}): StoredAtom {
  return {
    key: 'alias-copy', lang: 'python', conceptId: 'alias-copy', tag: 'alias-copy', source: 'seed', verified: true, createdAt: T0, pattern,
    probes: [aliasProbe('p1', 'g1', [1, 2], 3), aliasProbe('p2', 'g2', [4, 5], 6), aliasProbe('p3', 'g3', [7, 8], 9), aliasProbe('p4', 'g4', [3, 6], 1)],
    examples, completions: [completion('c1', 'gc1', 1), completion('c2', 'gc2', 2), completion('c3', 'gc3', 1)], contrasts: [contrast], tracebacks: [],
    ...over,
  };
}

function learner(over: Partial<ConceptState> = {}): Learner {
  const l = emptyLearner();
  upsertConcepts(l, [{ id: 'alias-copy', name: 'Aliases', tag: 'alias-copy' }], T0);
  Object.assign(l.concepts['alias-copy'], over);
  return l;
}

const pass = (): CompletionGrade => ({ empty: false, pass: true, blankLines: [2], checkFailed: false, timedOut: false, ms: 40 });
const fail = (misconceptionId?: string): CompletionGrade => ({
  empty: false, pass: false, blankLines: [2], checkFailed: true, message: 'leaves xs alone', timedOut: false, ms: 40,
  ...(misconceptionId ? { misconceptionId, wrongFillBlank: 1 } : {}),
});

/** Runs the reducer like the pad: answers 'pick' from the atom and 'run-completion' from a queue. */
class Driver {
  state!: AtomRunState;
  effects: AtomEffect[] = [];
  now: number;
  grades: CompletionGrade[] = [];
  /** Leave 'run-completion' unanswered (the test sends 'completion-graded' itself). */
  hold = false;

  constructor(readonly content: StoredAtom, readonly l: Learner, over: Partial<AtomStart> = {}) {
    this.now = over.at ?? T0;
    this.take(startAtom({
      conceptId: 'alias-copy', conceptKey: 'alias-copy', tag: 'alias-copy', lang: 'python', pattern, concept: l.concepts['alias-copy'],
      at: this.now, large: false, ...over,
    }));
  }

  private take(o: StepOutput): void {
    this.state = o.state;
    this.effects.push(...o.effects);
    for (const e of o.effects) {
      if (e.type === 'pick') this.send({ type: 'item', at: this.now, item: chooseItem(this.content, e.request, { now: this.now }) });
      if (e.type === 'run-completion' && !this.hold) {
        const g = this.grades.shift();
        assert.ok(g, 'a completion grade is queued');
        this.send({ type: 'completion-graded', at: this.now, grade: g });
      }
    }
  }

  send(ev: AtomEvent): void {
    this.take(stepAtom(this.state, ev));
  }

  wait(ms: number): this {
    this.now += ms;
    return this;
  }

  answer(text: string, opts: { after?: number; guess?: boolean; assisted?: boolean } = {}): this {
    this.now += opts.after ?? 6000;
    this.send({ type: 'submit', at: this.now, text: `# what does this print?\n# -> ${text}`, guess: opts.guess, assisted: opts.assisted, latencyMs: opts.after ?? 6000, latencyValid: true });
    return this;
  }

  /** Answer the probe on screen right (or with its mutant's output). */
  answerProbe(kind: 'right' | 'mutant', opts: { after?: number; guess?: boolean } = {}): this {
    const item = this.state.item;
    assert.equal(item?.kind, 'probe', `a probe is on screen (step ${this.state.step})`);
    const p = (item as { probe: StoredProbe }).probe;
    return this.answer(kind === 'right' ? right(p) : wrongM(p), opts);
  }

  submitDoc(grade: CompletionGrade): this {
    this.grades.push(grade);
    this.now += 20_000;
    this.send({ type: 'submit', at: this.now, text: '# fill the blank\n...', latencyMs: 20_000, latencyValid: true });
    return this;
  }

  yn(yes: boolean): this {
    this.now += 2000;
    this.send({ type: 'yn', at: this.now, yes });
    return this;
  }

  pickRight(correct: boolean): this {
    this.now += 4000;
    const rightKey = this.state.rightFirst ? 1 : 2;
    this.send({ type: 'pick', at: this.now, choice: correct ? rightKey : 3 - rightKey, latencyMs: 4000, latencyValid: true });
    return this;
  }

  next(after = 8000): this {
    this.now += after;
    this.send({ type: 'continue', at: this.now });
    return this;
  }

  evidence(): EvidenceInput[] {
    return this.effects.flatMap((e) => (e.type === 'evidence' ? [e.evidence] : []));
  }

  views(): string[] {
    return this.effects.flatMap((e) => (e.type === 'render' ? [e.view.kind] : []));
  }

  exit() {
    return this.effects.flatMap((e) => (e.type === 'exit' ? [e.result] : []))[0];
  }

  /** Replay the evidence effects into the learner, as the pad does. */
  apply(): void {
    for (const e of this.evidence()) recordEvidence(this.l, e);
  }
}

// ---------------------------------------------------------------- ROUTE

test('ROUTE: misconceptions first, then UNKNOWN, else PROBE', () => {
  const c = learner().concepts['alias-copy'];
  assert.deepEqual(routeAtom(c, { now: T0 }), { to: 'probe' });
  const cand = { p: 0.35, belief: BELIEF, status: 'candidate' as const, groups: ['g1'], delayedHits: 0, relapses: 0, lastAt: T0 };
  assert.deepEqual(routeAtom({ ...c, misconceptions: { [M]: cand } }, { now: T0 }), { to: 'belief-check', misconceptionId: M, belief: BELIEF });
  assert.equal(routeAtom({ ...c, misconceptions: { [M]: { ...cand, p: 0.2 } } }, { now: T0 }).to, 'probe', 'a weak candidate does not route');
  assert.equal(routeAtom({ ...c, misconceptions: { [M]: { ...cand, status: 'active', p: 0.7 } } }, { now: T0 }).to, 'refute');
  assert.equal(routeAtom({ ...c, misconceptions: { [M]: cand } }, { now: T0, confirmedMisconceptions: [M] }).to, 'refute');
  const sup = { ...cand, status: 'suppressed' as const, nextCheckAt: T0 + 60_000 };
  assert.equal(routeAtom({ ...c, misconceptions: { [M]: sup } }, { now: T0 }).to, 'probe', 'suppressed, not due');
  assert.equal(routeAtom({ ...c, misconceptions: { [M]: sup } }, { now: T0 + 60_000 }).to, 'refute', 'suppressed and due');
  assert.equal(routeAtom({ ...c, mastery: 0.1, lastWrongAt: T0 - 1 }, { now: T0 }).to, 'unknown');
  assert.equal(routeAtom({ ...c, mastery: 0.1 }, { now: T0 }).to, 'probe', 'low P alone is not enough');
  assert.equal(routeAtom(c, { now: T0, placementDontKnow: true }).to, 'unknown');
  assert.equal(routeAtom({ ...c, selfRating: 'not-used' }, { now: T0 }).to, 'unknown');
  assert.equal(routeAtom({ ...c, selfRating: 'not-used', groupsCorrect: ['g9'] }, { now: T0 }).to, 'probe');
});

// ---------------------------------------------------------------- tested-out

test('tested-out via 2 groups: PROBE and PROBE2 correct, P capped at .8', () => {
  const d = new Driver(atom(), learner());
  assert.deepEqual(d.views(), ['probe']);
  d.answerProbe('right');
  assert.equal(d.state.step, 'probe2');
  d.answerProbe('right');
  const r = d.exit();
  assert.equal(r.path, 'tested-out');
  assert.equal(r.items, 2);
  assert.equal(r.misconceptionId, undefined);
  const ev = d.evidence();
  assert.deepEqual(ev.map((e) => [e.correct, e.siblingGroup, e.source]), [[true, 'g1', 'atom'], [true, 'g2', 'atom']]);
  assert.deepEqual(ev[0].avoidedMisconceptionIds, [M]);
  assert.ok(ev.every((e) => e.parSelfMs! > 0 && e.parAbsMs! > 0 && e.latencyValid));
  d.apply();
  assert.equal(d.l.concepts['alias-copy'].mastery, 0.8, 'no production yet: capped at .8');
});

test('tested-out at PROBE when another group was answered right in the last 7 days', () => {
  const d = new Driver(atom(), learner(), { recentCorrectGroups: ['g9'] });
  d.answerProbe('right');
  assert.equal(d.exit().path, 'tested-out');
  assert.equal(d.exit().items, 1);
  // A guess is no shortcut.
  const g = new Driver(atom(), learner(), { recentCorrectGroups: ['g9'] });
  g.answerProbe('right', { guess: true });
  assert.equal(g.state.step, 'probe2');
});

test('a flagged guess in PROBE2 adds no steps: exit partial', () => {
  const d = new Driver(atom(), learner());
  d.answerProbe('right').answerProbe('right', { guess: true });
  assert.equal(d.exit().path, 'partial');
  assert.equal(d.evidence()[1].guessFlag, true);
});

// ---------------------------------------------------------------- misconception paths

test('belief y -> contrast pick -> reveal -> re-probe -> fixed (suppressed)', () => {
  const d = new Driver(atom(), learner());
  d.answerProbe('mutant');
  assert.equal(d.state.step, 'belief-check');
  assert.equal(d.evidence().length, 0, 'the wrong answer waits for y / n');
  const check = d.effects.find((e) => e.type === 'render' && e.view.kind === 'belief-check');
  assert.ok(check && check.type === 'render' && check.view.kind === 'belief-check' && check.view.actual === '[1, 2, 3]' && check.view.belief === BELIEF);
  assert.ok(d.effects.some((e) => e.type === 'mutant' && e.response === 'match'));

  d.yn(true);
  const confirmed = d.evidence()[0];
  assert.equal(confirmed.correct, false);
  assert.equal(confirmed.misconceptionId, M);
  assert.equal(confirmed.beliefConfirmed, true);
  assert.equal(confirmed.misconceptionOdds, 6);
  assert.ok(d.effects.some((e) => e.type === 'mutant' && e.response === 'yes'));
  assert.equal(d.state.step, 'contrast-pick');

  d.pickRight(true);
  const pick = d.evidence()[1];
  assert.equal(pick.kind, 'contrast-pick');
  assert.equal(pick.correct, true);
  assert.equal(pick.learnT, 0.3, 'a confirmed refutation followed by a correct contrast pick');
  assert.equal(d.state.step, 'reveal');
  const reveal = [...d.effects].reverse().find((e) => e.type === 'render');
  assert.ok(reveal?.type === 'render' && reveal.view.kind === 'reveal' && reveal.view.mutant?.diffLine === 2 && !!reveal.view.contrast);

  d.next();
  assert.equal(d.state.step, 'reprobe');
  const req = d.effects.filter((e) => e.type === 'pick').pop();
  assert.ok(req?.type === 'pick' && req.request.misconceptionId === M && req.request.excludeGroups.includes('g1'));
  d.answerProbe('right');
  const fixed = d.evidence()[2];
  assert.equal(fixed.suppresses, M);
  assert.equal(fixed.learnT, 0.3);
  const r = d.exit();
  assert.equal(r.path, 'fixed');
  assert.equal(r.misconceptionId, M);
  assert.equal(r.misconceptionStatus, 'suppressed');
  assert.equal(r.items, 3);

  d.apply();
  assert.equal(d.l.concepts['alias-copy'].misconceptions[M].status, 'suppressed', 'suppressed, not cleared');
});

test('belief n -> a slip: half-weight wrong, no misconception, one more PROBE; a second miss goes to UNKNOWN', () => {
  const d = new Driver(atom(), learner());
  d.answerProbe('mutant').yn(false);
  const slip = d.evidence()[0];
  assert.equal(slip.beliefConfirmed, false);
  assert.equal(slip.weight, 0.5);
  assert.ok(d.effects.some((e) => e.type === 'mutant' && e.response === 'no'));
  assert.equal(d.state.step, 'probe');
  assert.ok(d.state.groupsUsed.includes('g1'));
  d.apply();
  assert.deepEqual(d.l.concepts['alias-copy'].misconceptions, {}, "'n' never creates the misconception");

  d.answerProbe('mutant');
  assert.equal(d.state.step, 'example', 'no second belief check: UNKNOWN');
  const second = d.evidence()[1];
  assert.equal(second.misconceptionId, M);
  assert.equal(second.beliefConfirmed, undefined);
  assert.equal(second.misconceptionOdds, 3, 'an unconfirmed curated match');
});

test('re-probe fails -> the lesson is requested at once -> SECOND SIBLING fails -> ESCALATE (lesson above a fresh completion)', () => {
  const d = new Driver(atom(), learner());
  d.answerProbe('mutant').yn(true).pickRight(false).next();
  assert.equal(d.evidence()[1].learnT, 0.05, 'a wrong contrast pick gets no boost');
  const before = d.effects.length;
  d.answerProbe('mutant');
  const fx = d.effects.slice(before);
  const lesson = fx.find((e) => e.type === 'request-lesson');
  assert.ok(lesson && lesson.type === 'request-lesson');
  assert.equal(lesson.key, `lesson:alias-copy:${M}`);
  assert.equal(lesson.belief, BELIEF);
  assert.deepEqual(lesson.items.map((i) => i.answer), ['[1, 2]', '[4, 5]']);
  assert.ok(fx.findIndex((e) => e.type === 'request-lesson') < fx.findIndex((e) => e.type === 'pick'), 'requested before the second sibling item');
  assert.equal(d.state.step, 'second-sibling');

  d.answerProbe('mutant');
  assert.equal(d.state.step, 'escalate');
  assert.equal(d.state.phase, 'wait-lesson');
  const pending = [...d.effects].reverse().find((e) => e.type === 'render');
  assert.ok(pending?.type === 'render' && pending.view.kind === 'escalate' && pending.view.pending === true);
  assert.equal(d.effects.filter((e) => e.type === 'request-lesson').length, 1, 'requested once');

  d.wait(9000).send({ type: 'lesson', at: d.now, lesson: { title: 'One list, two names', explanation: 'b = a shares.', example: 'a = [1]', rule: 'Assignment shares.' } });
  const shown = [...d.effects].reverse().find((e) => e.type === 'render');
  assert.ok(shown?.type === 'render' && shown.view.kind === 'escalate' && !!shown.view.lesson && !!shown.view.completion);

  d.submitDoc(pass());
  const last = d.evidence().pop()!;
  assert.equal(last.kind, 'completion');
  assert.equal(last.production, true);
  assert.equal(last.learnT, 0.3, 'after an escalation lesson');
  const r = d.exit();
  assert.equal(r.path, 'escalated');
  assert.ok(d.effects.some((e) => e.type === 'review' && e.inMs <= 24 * 3600_000), 'a same-day review');
});

test('second sibling right: fixed, and the lesson stays cached (no more effects for it)', () => {
  const d = new Driver(atom(), learner());
  d.answerProbe('mutant').yn(true).pickRight(true).next().answerProbe('mutant').answerProbe('right');
  assert.equal(d.exit().path, 'fixed');
  assert.equal(d.evidence().pop()!.suppresses, M);
  assert.equal(d.effects.filter((e) => e.type === 'request-lesson').length, 1);
});

test('ROUTE from a placement candidate: the belief check first, then REFUTE with a probe carrying M for the reveal', () => {
  const l = learner({ misconceptions: { [M]: { p: 0.4, belief: BELIEF, status: 'candidate', groups: ['gp'], delayedHits: 0, relapses: 0, lastAt: T0 } } });
  const d = new Driver(atom(), l);
  assert.deepEqual(d.views(), ['belief-check']);
  d.yn(true);
  assert.equal(d.evidence()[0].beliefConfirmed, true);
  assert.equal(d.evidence()[0].weight, 0.5, 'a self-report, not an observed answer');
  d.pickRight(true);
  assert.equal(d.state.step, 'reveal');
  const reveal = [...d.effects].reverse().find((e) => e.type === 'render');
  assert.ok(reveal?.type === 'render' && reveal.view.kind === 'reveal' && reveal.view.probe?.code === atom().probes[0].code);
  d.next().answerProbe('right');
  assert.equal(d.exit().path, 'fixed');
});

// ---------------------------------------------------------------- UNKNOWN

test('UNKNOWN -> learned, for a large tag: 2 examples, a 1-blank and a 2-blank completion, then a final predict', () => {
  const d = new Driver(atom(), learner({ selfRating: 'not-used' }), { large: true });
  assert.equal(d.state.step, 'example');
  d.next().next();
  d.submitDoc(pass());
  d.submitDoc(pass());
  assert.equal(d.state.step, 'final-predict');
  d.answerProbe('right');
  assert.deepEqual(d.views(), ['example', 'example', 'completion', 'completion', 'probe']);
  const ev = d.evidence();
  assert.deepEqual(ev.map((e) => e.kind), ['completion', 'completion', 'predict']);
  assert.ok(ev.slice(0, 2).every((e) => e.production && e.learnT === 0.3), 'worked example then a passing completion');
  const picks = d.effects.flatMap((e) => (e.type === 'pick' ? [e.request] : []));
  assert.deepEqual(picks.map((p) => [p.role, p.blanks]), [['example', undefined], ['example2', undefined], ['completion', 1], ['completion2', 2], ['final-predict', undefined]]);
  assert.notEqual(picks[1].excludeGroups.length, 0, 'the second example comes from another surface');
  assert.equal(d.exit().path, 'learned');
});

test('UNKNOWN: one completion retry, then the fill is revealed; a wrong final predict exits partial with a 10 min review', () => {
  const d = new Driver(atom(), learner({ selfRating: 'not-used' }));
  d.next();
  d.submitDoc(fail(M));
  assert.equal(d.state.step, 'completion');
  assert.equal(d.state.phase, 'show', 'one retry on the same item');
  const fb = [...d.effects].reverse().find((e) => e.type === 'feedback');
  assert.ok(fb?.type === 'feedback' && fb.feedback.kind === 'check' && typeof fb.target === 'object' && fb.target.line === 2);
  d.submitDoc(fail());
  const ev = d.evidence();
  assert.equal(ev[0].misconceptionId, M);
  assert.equal(ev[0].misconceptionOdds, 3, 'a tagged wrong fill');
  assert.equal(ev[1].weight, 0.5, 'the retry is not independent');
  assert.equal(d.state.phase, 'reveal-fill');
  assert.equal(d.views().pop(), 'completion-reveal');
  d.next();
  assert.equal(d.state.step, 'final-predict', 'not large: no second completion');
  d.answer('?');
  assert.equal(d.evidence().pop()!.correct, null);
  assert.equal(d.exit().path, 'partial');
  assert.ok(d.effects.some((e) => e.type === 'review' && e.inMs === 10 * 60_000));
});

test('format-only: the note, no evidence, then PROBE2', () => {
  const str = (id: string, group: string, s: string): StoredProbe => ({
    ...aliasProbe(id, group, [1], 2), code: `word = '${s}'\nprint(word)`, mutants: [],
    output: printed([{ type: 'str', repr: `'${s}'`, val: { t: 'str', v: s } }]),
  });
  const d = new Driver(atom({ probes: [str('s1', 'g1', 'hello'), str('s2', 'g2', 'bye')] }), learner());
  d.answer("'hello'");
  assert.equal(d.evidence().length, 0);
  const fb = [...d.effects].reverse().find((e) => e.type === 'feedback');
  assert.ok(fb?.type === 'feedback' && fb.feedback.kind === 'format');
  assert.equal(d.state.step, 'probe2');
  assert.equal(d.state.graded[0].scored, false);
  d.answer('bye');
  assert.equal(d.evidence().length, 1);
  assert.equal(d.exit().path, 'tested-out');
});

test('an empty answer re-prompts without a graded item', () => {
  const d = new Driver(atom(), learner());
  d.answer('');
  assert.equal(d.state.graded.length, 0);
  const fb = [...d.effects].reverse().find((e) => e.type === 'feedback');
  assert.ok(fb?.type === 'feedback' && fb.feedback.kind === 'empty');
  assert.equal(d.state.step, 'probe');
});

test('an assisted answer is discarded: no evidence, a note, the same item stays', () => {
  const e = new Driver(atom(), learner());
  e.now += 3000;
  e.send({ type: 'submit', at: e.now, text: '# -> [1, 2, 3]', assisted: true, latencyMs: 3000, latencyValid: true });
  assert.equal(e.evidence().length, 0);
  const fb = [...e.effects].reverse().find((x) => x.type === 'feedback');
  assert.ok(fb?.type === 'feedback' && fb.feedback.kind === 'assisted');
  assert.equal(e.state.step, 'probe');
  assert.equal(e.state.graded[0].assisted, true);
  assert.equal(e.state.graded[0].scored, false);
  assert.equal(e.state.shownAt, e.now, 'the latency clock restarts');
  e.answerProbe('right');
  assert.equal(e.evidence().length, 1, 'the typed answer counts as usual');
  assert.equal(e.state.step, 'probe2');
});

// ---------------------------------------------------------------- caps and leaving

test('CAPS: 150 s of active time exits at the current state', () => {
  const d = new Driver(atom(), learner());
  assert.equal(atomDeadline(d.state), T0 + ATOM_CAPS.ms);
  d.send({ type: 'tick', at: T0 + 149_000 });
  assert.equal(d.exit(), undefined);
  d.send({ type: 'tick', at: T0 + 150_000 });
  assert.equal(d.exit().path, 'partial');
  assert.equal(d.exit().items, 0);
});

test('CAPS: a completion being graded when the time runs out is still recorded, then the atom exits', () => {
  const d = new Driver(atom(), learner({ selfRating: 'not-used' }));
  d.next();
  assert.equal(d.state.step, 'completion');
  d.hold = true;
  d.now = T0 + 149_500;
  d.send({ type: 'submit', at: d.now, text: '...', latencyMs: 30_000, latencyValid: true });
  assert.equal(d.state.phase, 'grading');
  d.send({ type: 'tick', at: T0 + 150_000 });
  assert.equal(d.exit(), undefined, 'waits for the grade');
  d.send({ type: 'completion-graded', at: T0 + 150_300, grade: pass() });
  assert.equal(d.evidence().length, 1);
  assert.equal(d.exit().path, 'partial');
  assert.ok(!d.effects.some((e) => e.type === 'pick' && e.request.role === 'final-predict'));
});

test('CAPS: the 7th graded item ends the atom; the next item is never shown', () => {
  const d = new Driver(atom(), learner(), { large: true });
  d.answerProbe('mutant').yn(false); // 1 (slip)
  d.answerProbe('right'); // 2
  d.answerProbe('mutant'); // 3: a second miss -> UNKNOWN
  assert.equal(d.state.step, 'example');
  d.next().next();
  d.submitDoc(fail()).submitDoc(fail()); // 4, 5
  d.next();
  assert.equal(d.state.step, 'completion2');
  d.submitDoc(fail()); // 6
  assert.equal(d.exit(), undefined);
  const before = d.effects.length;
  d.submitDoc(fail()); // 7
  const r = d.exit();
  assert.equal(r.items, 7);
  assert.equal(r.path, 'partial');
  const after = d.effects.slice(before);
  assert.ok(!after.some((e) => e.type === 'render' || e.type === 'pick'), 'nothing more is shown');
  assert.equal(after.filter((e) => e.type === 'evidence').length, 1, 'the 7th item is still recorded');
});

test('CAPS: the clock pauses in ESCALATE, which has its own 150 s', () => {
  const d = new Driver(atom(), learner());
  d.answerProbe('mutant', { after: 20_000 }).yn(true).pickRight(true).next(10_000);
  d.answerProbe('mutant', { after: 20_000 }).answerProbe('mutant', { after: 40_000 });
  assert.equal(d.state.step, 'escalate');
  const escAt = d.now;
  const active = activeMs(d.state, escAt);
  assert.ok(active > 90_000 && active < 150_000, `active ${active}`);
  assert.equal(atomDeadline(d.state), escAt + ATOM_CAPS.escalateMs);
  d.send({ type: 'tick', at: T0 + 160_000 });
  assert.equal(d.exit(), undefined, 'past the main 150 s, but its clock is paused');
  assert.equal(activeMs(d.state, T0 + 200_000), active, 'active time does not grow in ESCALATE');
  d.send({ type: 'lesson', at: escAt + 100_000, lesson: undefined });
  assert.equal(d.state.phase, 'show', 'a failed lesson still shows the completion');
  d.send({ type: 'tick', at: escAt + ATOM_CAPS.escalateMs });
  assert.equal(d.exit().path, 'escalated');
});

test('double Esc (within 600 ms) aborts and keeps the evidence; a single Esc does nothing', () => {
  const d = new Driver(atom(), learner());
  d.answerProbe('right');
  d.send({ type: 'esc', at: d.now + 100 });
  d.send({ type: 'esc', at: d.now + 1200 });
  assert.equal(d.exit(), undefined, '1.1 s apart: two single presses');
  d.send({ type: 'esc', at: d.now + 1500 });
  const r = d.exit();
  assert.equal(r.path, 'aborted');
  assert.equal(r.items, 1);
  assert.equal(d.evidence().length, 1, 'kept');
  // A wrong answer waiting for its belief check is kept as an unconfirmed match.
  const b = new Driver(atom(), learner());
  b.answerProbe('mutant');
  b.send({ type: 'esc', at: b.now + 100 });
  b.send({ type: 'esc', at: b.now + 300 });
  const kept = b.evidence();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].misconceptionId, M);
  assert.equal(kept[0].beliefConfirmed, undefined);
  // Events after the exit change nothing.
  const s = b.state;
  assert.deepEqual(stepAtom(s, { type: 'continue', at: b.now + 5000 }), { state: s, effects: [] });
});

test('closing the tab (abort) exits aborted', () => {
  const d = new Driver(atom(), learner());
  d.send({ type: 'abort', at: T0 + 1000 });
  assert.equal(d.exit().path, 'aborted');
});

// ---------------------------------------------------------------- item choice

test('chooseItem: unseen groups and ids, items carrying M first, confounded fallback at weight .5', () => {
  const a = atom();
  const base = { conceptKey: 'alias-copy', excludeGroups: ['g1'], excludeIds: ['p1'] };
  const p = chooseItem(a, { ...base, role: 'probe', kind: 'probe' }, { now: T0 });
  assert.equal(p?.kind === 'probe' && p.probe.group, 'g2');
  const seen = atom({ probes: a.probes.map((x) => (x.id === 'p2' ? { ...x, stats: { ...x.stats, seenAt: [T0 - 3600_000] } } : x)) });
  const q = chooseItem(seen, { ...base, role: 'probe', kind: 'probe' }, { now: T0 });
  assert.equal(q?.kind === 'probe' && q.probe.id, 'p3', 'seen within 7 days');
  const conf = chooseItem(a, { ...base, role: 'probe', kind: 'probe' }, { now: T0, allowedConstructs: new Set(['list-literal']) });
  assert.ok(conf?.kind === 'probe' && conf.confounded === true);
  const clean = chooseItem(a, { ...base, role: 'probe', kind: 'probe' }, { now: T0, allowedConstructs: new Set(['list-literal', 'call']) });
  assert.ok(clean?.kind === 'probe' && !clean.confounded);
  const c2 = chooseItem(a, { ...base, role: 'completion2', kind: 'completion', blanks: 2 }, { now: T0 });
  assert.equal(c2?.kind === 'completion' && c2.completion.id, 'c2');
  const ct = chooseItem(a, { ...base, role: 'contrast', kind: 'contrast', misconceptionId: 'other' }, { now: T0 });
  assert.equal(ct, undefined);
  // Examples have no stats: their show times come from the cache (AtomCache.seenIds).
  const ex = chooseItem(a, { ...base, role: 'example', kind: 'example' }, { now: T0, seen: new Set(['ex1']) });
  assert.equal(ex?.kind === 'example' && ex.example.id, 'ex2');
});

test('a confounded probe is recorded at weight .5; items arriving when none was asked for are ignored', () => {
  const s0 = startAtom({ conceptId: 'alias-copy', conceptKey: 'alias-copy', tag: 'alias-copy', lang: 'python', pattern, concept: learner().concepts['alias-copy'], at: T0 });
  assert.equal(s0.state.phase, 'pick');
  const o = stepAtom(s0.state, { type: 'item', at: T0, item: { kind: 'probe', probe: atom().probes[0], confounded: true } });
  assert.equal(o.state.phase, 'show');
  const stray = stepAtom(o.state, { type: 'item', at: T0, item: { kind: 'probe', probe: atom().probes[1] } });
  assert.equal(stray.effects.length, 0);
  assert.equal(stray.state.item, o.state.item);
  const o2 = stepAtom(o.state, { type: 'submit', at: T0 + 6000, text: '# -> [1, 2, 3]', latencyMs: 6000, latencyValid: true });
  const ev = o2.effects.find((e) => e.type === 'evidence');
  assert.ok(ev?.type === 'evidence' && ev.evidence.weight === 0.5);
});

test('nothing in stock: no probe -> teach (UNKNOWN); no reprobe -> exit confirmed', () => {
  const d = new Driver(atom({ probes: [] }), learner());
  assert.equal(d.state.step, 'example');
  const one = new Driver(atom({ probes: [atom().probes[0]] }), learner());
  one.answerProbe('mutant').yn(true).pickRight(true).next();
  const r = one.exit();
  assert.equal(r.path, 'confirmed', 'refuted but no other surface to re-check it on');
  assert.equal(r.misconceptionStatus, 'confirmed');
});

test('a fast answer (under .3 x par_self) is an implicit guess; a copied literal too, unless a mutant explains it', () => {
  const d = new Driver(atom(), learner());
  d.answerProbe('right', { after: 1500 });
  assert.equal(d.evidence()[0].implicitGuess, true);
  assert.equal(d.state.graded[0].guess, true);
  const c = new Driver(atom(), learner());
  c.answer('[1, 2]');
  assert.equal(c.state.step, 'belief-check');
  c.yn(true);
  assert.equal(c.evidence()[0].implicitGuess, undefined, 'the alias belief predicts the list as written');
});
