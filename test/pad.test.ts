// The Atom Pad driving the step machine through an in-memory editor (spec V1-6 test list): tested-out,
// belief y -> contrast -> re-probe -> fixed, belief n -> slip, re-probe fail -> second sibling ->
// escalate (lesson requested at the re-probe), unknown -> learned on a large tag, format-only, caps
// with the clock paused in ESCALATE, double Esc, an assisted insert discarding an answer; plus the
// pad's own duties: EXIT steps, latency and focus, tab closed, lock abort, no-runner and unverified
// content, keyUse, undo protection, keepOpen.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AtomPattern, AtomResult, BatchItem, BatchRecord, PrintedArg, RecordedOutput, Runner, Runtime, StoredAtom, StoredCompletion, StoredContrast,
  StoredExample, StoredMutant, StoredProbe, Val,
} from '../src/contracts';
import { AtomCache } from '../src/atoms/cache';
import {
  atomFlash, AtomPad, isAssistedInsert, lastAnswerLine, LatencyClock, ManualClock, MemoryPadEditor, PAD, padLangOf, padLanguageId, padPath,
  ScriptedPadUi, upsertPatternCard, type LessonRequest, type PadLogCard,
} from '../src/atoms/pad';
import type { LessonText, PadDecoration, PadRender } from '../src/atoms/render';
import { emptyLearner, recordEvidence, upsertConcepts, type EvidenceInput } from '../src/learner';
import { InteractionLock } from '../src/lock';
import type { ConceptState, Learner } from '../src/types';

const T0 = Date.UTC(2026, 9, 4, 9, 0, 0);
const M = 'assignment-copies';
const BELIEF = 'b = a makes a separate copy of the list';

// ---------------------------------------------------------------- fixtures

const int = (n: number): Val => ({ t: 'int', v: String(n) });
const pyList = (ns: number[]): PrintedArg => ({ type: 'list', repr: `[${ns.join(', ')}]`, val: { t: 'list', v: ns.map(int) } });
const pyInt = (n: number): PrintedArg => ({ type: 'int', repr: String(n), val: int(n) });
const printed = (...calls: PrintedArg[][]): RecordedOutput => ({
  stdout: calls.map((a) => a.map((x) => x.repr).join(' ')).join('\n') + '\n', values: calls,
});
const stats = () => ({ seenAt: [] as number[], n: 0, nCorrect: 0 });

function aliasProbe(id: string, group: string, start: number[], add: number): StoredProbe {
  const code = `a = [${start.join(', ')}]\nb = a\nb.append(${add})\nprint(a)`;
  const m: StoredMutant = {
    id: `${id}~${M}`, misconceptionId: M, belief: BELIEF, refutation: 'b = a gives the list a second name; appending through b changes a.',
    rule: 'Assignment shares the list; .copy() makes a new one.', code: code.replace('b = a', 'b = a.copy()'),
    output: printed([pyList(start)]), diffLine: 2, source: 'curated', ambiguous: false, matches: 0, confirmations: 0, rejections: 0,
  };
  return {
    id, group, code, output: printed([pyList([...start, add])]), parSec: 5, answerSpaceG: 0.06, constructs: ['list-literal'],
    discriminating: true, mutants: [m], stats: stats(),
    trace: [{ line: 1, text: `a=[${start.join(', ')}]` }, { line: 2, text: 'b is a' }],
  };
}

const right = (p: StoredProbe) => p.output.stdout.trim();
const wrongM = (p: StoredProbe) => p.mutants[0].output.stdout.trim();

const aliasExamples: StoredExample[] = [1, 2].map((k) => ({
  id: `ex${k}`, group: `ex:${k}`, code: `a = [${k}]\nb = a\nb.append(0)\nprint(a)`, subgoals: [{ line: 2, label: 'one list, two names' }],
  output: printed([pyList([k, 0])]),
}));

const aliasCompletion = (id: string, group: string, blanks: 1 | 2): StoredCompletion => ({
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

const aliasPattern: AtomPattern = {
  kind: 'semantics', name: 'Aliases share one object', useWhen: '', template: '', rule: 'Assignment never copies a list.',
  howItRuns: 'Both names point at one list in memory.', pitfall: 'Use .copy() for a separate list', useCases: ['Keep the original list while editing a copy'],
};

function aliasAtom(over: Partial<StoredAtom> = {}): StoredAtom {
  return {
    key: 'alias-copy', lang: 'python', conceptId: 'alias-copy', tag: 'alias-copy', source: 'seed', verified: true, createdAt: T0, pattern: aliasPattern,
    probes: [aliasProbe('p1', 'g1', [1, 2], 3), aliasProbe('p2', 'g2', [4, 5], 6), aliasProbe('p3', 'g3', [7, 8], 9), aliasProbe('p4', 'g4', [3, 6], 1)],
    examples: aliasExamples, completions: [aliasCompletion('c1', 'gc1', 1), aliasCompletion('c2', 'gc2', 2)], contrasts: [contrast], tracebacks: [],
    ...over,
  };
}

// A large tag (function-def-call has sub-atoms): two worked examples, then a 1-blank and a 2-blank completion.
const fdcPattern: AtomPattern = {
  kind: 'shape', name: 'Define and call a function', useWhen: 'the same steps repeat with different values', template: 'def <name>(<params>):\n    return <result>',
  rule: '', howItRuns: '', pitfall: 'Defining is not calling', useCases: ['Convert several temperatures the same way'],
};

function fdcProbe(id: string, group: string, k: number): StoredProbe {
  return {
    id, group, code: `def f(x):\n    return x * ${k}\nprint(f(3))`, output: printed([pyInt(3 * k)]), parSec: 5, answerSpaceG: 0.2,
    constructs: ['def', 'return'], discriminating: false, mutants: [], stats: stats(),
  };
}

function fdcAtom(): StoredAtom {
  return {
    key: 'function-def-call', lang: 'python', conceptId: 'function-def-call', tag: 'function-def-call', source: 'seed', verified: true, createdAt: T0,
    pattern: fdcPattern,
    probes: [fdcProbe('f1', 'h1', 2), fdcProbe('f2', 'h2', 4), fdcProbe('f3', 'h3', 5)],
    examples: [
      { id: 'fx1', group: 'fx:1', code: 'def greet(name):\n    return "hi " + name\nprint(greet("Ada"))', subgoals: [{ line: 1, label: 'name the steps' }, { line: 3, label: 'run them' }], output: { stdout: 'hi Ada\n', values: [] } },
      { id: 'fx2', group: 'fx:2', code: 'def area(w, h):\n    return w * h\nprint(area(2, 3))', subgoals: [{ line: 2, label: 'send the result back' }], output: printed([pyInt(6)]) },
    ],
    completions: [
      { id: 'fc1', group: 'fc:1', code: 'def double(x):\n    return [[1]]', solutions: ['x * 2'], wrongFills: [], parSec: 20, stats: stats(), harness: "check(double(2) == 4, 'doubles 2')\ncheck(double(5) == 10, 'doubles 5')" },
      { id: 'fc2', group: 'fc:2', code: 'def add(a, b):\n    total = [[1]]\n    return [[2]]', solutions: ['a + b', 'total'], wrongFills: [], parSec: 30, stats: stats(), harness: "check(add(1, 2) == 3, 'adds')\ncheck(add(5, 5) == 10, 'adds 5')" },
    ],
    contrasts: [], tracebacks: [],
  };
}

/** Grades a completion run by looking for the right fills in the code (the real batch runner is not needed here). */
class FakeRunner implements Runner {
  readonly runtime: Runtime = { lang: 'python', exe: 'python', snippetArgv: [], learnerArgv: [], version: 'test' };
  runs: string[] = [];
  constructor(private readonly passes: (code: string) => boolean) {}
  async runBatch(items: BatchItem[]): Promise<BatchRecord[]> {
    return items.map((it) => {
      this.runs.push(it.code);
      const ok = this.passes(it.code);
      const rec: BatchRecord = { id: it.id, stdout: '', values: [], exitOk: ok, timedOut: false, ms: 30, constructs: [] };
      if (!ok) {
        rec.exception = 'CheckFailed';
        rec.error = 'Traceback (most recent call last):\n  File "<snippet>", line 7, in <module>\nCheckFailed: CHECK leaves xs alone';
      }
      return rec;
    });
  }
  async runLearnerCode(): Promise<never> {
    throw new Error('not used');
  }
}

const passesAll = (code: string) =>
  (code.includes('out = xs.copy()') && code.includes('out.extend(ys)')) || code.includes('return x * 2') || (code.includes('total = a + b') && code.includes('return total'));

class SpyEditor extends MemoryPadEditor {
  decoLog: PadDecoration[][] = [];
  override decorate(d: readonly PadDecoration[]): void {
    super.decorate(d);
    this.decoLog.push([...d]);
  }
}

interface SetupOptions {
  atom?: StoredAtom;
  runner?: Runner | null;
  concept?: Partial<ConceptState>;
  lesson?: (r: LessonRequest) => LessonText | undefined | Promise<LessonText | undefined>;
  lock?: InteractionLock;
}

function setup(o: SetupOptions = {}) {
  const clock = new ManualClock(T0);
  const editor = new SpyEditor();
  const ui = new ScriptedPadUi();
  const content = o.atom ?? aliasAtom();
  const l: Learner = emptyLearner();
  upsertConcepts(l, [{ id: content.conceptId, name: content.conceptId === 'alias-copy' ? 'Aliases' : 'Functions', tag: content.tag }], T0);
  Object.assign(l.concepts[content.conceptId], o.concept ?? {});
  const cache = new AtomCache('python', undefined, { debounceMs: -1, now: () => clock.now() });
  cache.put(content);
  const evs: EvidenceInput[] = [];
  const logs: PadLogCard[] = [];
  const exits: AtomResult[] = [];
  const progress: string[] = [];
  const lessonCalls: LessonRequest[] = [];
  const runner = o.runner === null ? undefined : o.runner ?? new FakeRunner(passesAll);
  const lessonFn = o.lesson;
  const pad = new AtomPad({
    editor, ui, clock, learner: () => l,
    recordEvidence: (e) => {
      evs.push(e);
      return recordEvidence(l, e, { clock: () => clock.now() });
    },
    cache: (lang) => (lang === 'python' ? cache : undefined),
    runner: () => runner,
    lesson: lessonFn ? (r) => {
      lessonCalls.push(r);
      return lessonFn(r);
    } : undefined,
    onLog: (c) => logs.push(c),
    onExit: (r) => exits.push(r),
    markProgress: (_t, why) => progress.push(why),
    lock: o.lock,
  });
  return { clock, editor, ui, l, cache, content, evs, logs, exits, progress, lessonCalls, pad, runner };
}

type Setup = ReturnType<typeof setup>;

/** Plays the learner on the in-memory pad. */
class Bot {
  private ended: Promise<'ended'> | undefined;

  constructor(readonly t: Setup) {}

  /** Fail fast (instead of hanging) when the flow ends while the bot expects a screen. */
  watch<T>(run: Promise<T>): Promise<T> {
    this.ended = run.then(() => 'ended' as const, () => 'ended' as const);
    return run;
  }

  async screen(): Promise<PadRender> {
    const r = await Promise.race([this.t.pad.whenAwaiting(), this.ended ?? new Promise<never>(() => undefined)]);
    if (r === 'ended') assert.fail(`the flow ended; the bot expected a screen:\n${this.t.editor.doc}`);
    assert.ok(r, 'the pad waits with something on screen');
    return r;
  }

  probe(): StoredProbe {
    const p = this.t.content.probes.find((x) => this.t.editor.doc.includes(x.code));
    assert.ok(p, `a known probe is on screen:\n${this.t.editor.doc}`);
    return p;
  }

  async answer(kind: 'right' | 'mutant' | { text: string }, opts: { after?: number; guess?: boolean } = {}): Promise<StoredProbe> {
    const r = await this.screen();
    assert.equal(r.await, 'answer', `an answer step is on screen:\n${this.t.editor.doc}`);
    const p = this.probe();
    this.t.editor.answer(kind === 'right' ? right(p) : kind === 'mutant' ? wrongM(p) : kind.text);
    this.t.clock.advance(opts.after ?? 9000);
    assert.ok(this.t.pad.submit(!!opts.guess), 'the submit is accepted');
    return p;
  }

  async yesNo(yes: boolean): Promise<void> {
    const r = await this.screen();
    assert.equal(r.await, 'yn');
    this.t.clock.advance(2500);
    assert.ok(this.t.pad.yesNo(yes));
  }

  async pickRight(): Promise<void> {
    const r = await this.screen();
    assert.equal(r.await, 'pick2');
    this.t.clock.advance(4000);
    assert.ok(this.t.pad.pick(r.correctPick!));
  }

  async continue(): Promise<void> {
    const r = await this.screen();
    assert.equal(r.await, 'read', `a reading step is on screen:\n${this.t.editor.doc}`);
    this.t.clock.advance(6000);
    assert.ok(this.t.pad.submit());
  }

  async fill(fills: string[]): Promise<void> {
    const r = await this.screen();
    assert.ok(r.snippet, `a completion is on screen:\n${this.t.editor.doc}`);
    this.t.editor.fill(fills);
    this.t.clock.advance(30_000);
    assert.ok(this.t.pad.submit());
  }
}

const settled = <T>(p: Promise<T>) => {
  const s = { done: false };
  p.then(() => (s.done = true), () => (s.done = true));
  return s;
};

const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- the step machine through the pad

describe('AtomPad drives the step machine', () => {
  test('tested-out on 2 groups, with every EXIT step', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    const r = await bot.screen();
    assert.equal(t.editor.isOpen, true);
    assert.equal(t.editor.contexts['deliberate.padAwait'], 'answer');
    assert.match(t.editor.doc, /^# what does this print\?/);
    assert.ok(!t.editor.doc.includes('alias'), 'the generic header never names the concept');
    assert.equal(t.editor.cursor?.line, r.answerLine);
    const first = await bot.answer('right');
    await bot.screen();
    assert.ok(t.pad.session!.shownAt - t.evs[0].at! >= PAD.hold.correct, "'ok' stays 600 ms before the next item");
    assert.ok(t.editor.decoLog.some((ds) => ds.some((d) => d.kind === 'correct' && /^ok \d+s$/.test(d.text))), "'ok 9s' was shown");
    const second = await bot.answer('right');
    assert.notEqual(first.group, second.group, 'the second probe is on another surface');
    const res = await run;
    assert.equal(res.path, 'tested-out');
    assert.equal(res.items, 2);
    assert.equal(t.evs.length, 2);
    assert.ok(t.evs.every((e) => e.correct === true && e.source === 'atom' && e.latencyValid === true));
    // EXIT: closed, previous editor restored by the editor, context reset, deck, flash, log card, progress, onExit.
    assert.equal(t.editor.isOpen, false);
    assert.equal(t.editor.closes, 1);
    assert.equal(t.editor.contexts['deliberate.padAwait'], '');
    assert.equal(t.l.patternDeck.length, 1);
    assert.equal(t.l.patternDeck[0].name, 'Aliases share one object');
    assert.equal(t.l.patternDeck[0].rule, 'Assignment never copies a list.');
    assert.equal(t.ui.flashes.length, 1);
    assert.match(t.ui.flashes[0], /^Aliases: Unknown -> Learning \(\d+s\)$/);
    assert.equal(res.stateBefore, 'Unknown');
    assert.equal(res.stateAfter, 'Learning');
    assert.equal(t.logs.length, 1);
    assert.equal(t.logs[0].kind, 'atom');
    assert.equal(t.logs[0].title, 'Aliases: Unknown -> Learning');
    assert.deepEqual(t.progress, ['atom finished']);
    assert.deepEqual(t.exits, [res]);
    assert.equal(t.pad.busy, false);
    assert.ok(t.cache.seenIds('alias-copy').includes(first.id), 'shown items are marked seen');
  });

  test('belief y -> contrast pick -> reveal -> re-probe -> fixed (suppressed)', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    await bot.answer('mutant');
    const r = await bot.screen();
    assert.equal(r.await, 'yn');
    assert.ok(t.editor.doc.includes(`Did you think: ${BELIEF}?`), t.editor.doc);
    assert.ok(t.editor.decorations.some((d) => d.kind === 'wrong' && d.text.startsWith('actual: ')));
    await bot.yesNo(true);
    await bot.pickRight();
    const reveal = await bot.screen();
    assert.equal(reveal.await, 'read');
    assert.ok(t.editor.decorations.some((d) => d.kind === 'removed' && d.text.includes('second name')), 'the refutation sits on the diff line');
    assert.ok(t.editor.decorations.some((d) => d.kind === 'trace'), 'state trace after-text');
    await bot.continue();
    await bot.answer('right');
    const res = await run;
    assert.equal(res.path, 'fixed');
    assert.equal(res.misconceptionId, M);
    assert.equal(res.misconceptionStatus, 'suppressed');
    assert.equal(t.l.concepts['alias-copy'].misconceptions[M].status, 'suppressed');
    const named = t.evs.find((e) => e.misconceptionId === M);
    assert.equal(named?.beliefConfirmed, true);
    assert.equal(named?.misconceptionOdds, 6);
    assert.ok(t.evs.some((e) => e.suppresses === M));
    const m = t.cache.get('alias-copy')!.probes.flatMap((p) => p.mutants).find((x) => x.matches === 1);
    assert.equal(m?.confirmations, 1, 'the cache counted the match and the y');
  });

  test('belief n -> a slip: half weight, no misconception, one more probe', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    await bot.answer('mutant');
    await bot.yesNo(false);
    await bot.answer('right');
    await bot.answer('right');
    const res = await run;
    assert.equal(res.path, 'tested-out');
    const slip = t.evs[0];
    assert.equal(slip.correct, false);
    assert.equal(slip.beliefConfirmed, false);
    assert.equal(slip.weight, 0.5);
    assert.equal(Object.keys(t.l.concepts['alias-copy'].misconceptions).length, 0, 'an n never updates the misconception');
    assert.equal(t.cache.get('alias-copy')!.probes.flatMap((p) => p.mutants).find((x) => x.matches === 1)?.rejections, 1);
  });

  test('re-probe fails -> the lesson is requested -> second sibling fails -> escalate with the lesson above a completion', async () => {
    let land!: (l: LessonText | undefined) => void;
    const lesson = new Promise<LessonText | undefined>((r) => (land = r));
    const t = setup({ lesson: () => lesson });
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    await bot.answer('mutant');
    await bot.yesNo(true);
    await bot.pickRight();
    await bot.continue();
    assert.equal(t.lessonCalls.length, 0, 'no lesson before the re-probe fails');
    await bot.answer('mutant');
    await bot.screen();
    assert.equal(t.lessonCalls.length, 1, 'the lesson is requested the moment the re-probe fails');
    assert.equal(t.lessonCalls[0].key, `lesson:alias-copy:${M}`);
    assert.ok(t.lessonCalls[0].items.length >= 2, 'the wrong answers go to the lesson prompt');
    await bot.answer('mutant');
    const pending = await bot.screen();
    assert.equal(pending.await, 'read');
    assert.match(t.editor.doc, /preparing a short lesson\.\.\. \(~10 s\)/);
    land({ title: 'One list, two names', explanation: 'b = a copies the arrow, not the list.', example: 'a = [1]\nb = a\nb.append(2)\nprint(a)  # [1, 2]', rule: 'Assignment shares; copy() copies.' });
    await tick();
    const r = await bot.screen();
    assert.ok(r.snippet, 'a fresh completion under the lesson');
    assert.match(t.editor.doc, /# One list, two names/);
    assert.match(t.editor.doc, /# Rule: Assignment shares; copy\(\) copies\./);
    await bot.fill(['xs.copy()']);
    const res = await run;
    assert.equal(res.path, 'escalated');
    const done = t.evs.filter((e) => e.kind === 'completion');
    assert.equal(done.length, 1);
    assert.equal(done[0].production, true);
    assert.ok(t.l.concepts['alias-copy'].nextReview > 0, 'a same-day review is scheduled');
  });

  test('unknown -> learned on a large tag: two worked examples, a 1-blank and a 2-blank completion, a final predict', async () => {
    const t = setup({ atom: fdcAtom() });
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content, { placementDontKnow: true }));
    const ex1 = await bot.screen();
    assert.equal(ex1.await, 'read');
    assert.match(t.editor.doc, /^# Pattern: Define and call a function - the same steps repeat/);
    assert.ok(t.editor.decorations.some((d) => d.kind === 'subgoal' && d.text === '<- name the steps'));
    await bot.continue();
    await bot.screen();
    assert.match(t.editor.doc, /def area\(w, h\)/, 'a second example on another surface');
    await bot.continue();
    const c1 = await bot.screen();
    assert.deepEqual(c1.snippet?.filter((p) => 'placeholder' in p).length, 1);
    await bot.fill(['x * 2']);
    const c2 = await bot.screen();
    assert.equal(c2.snippet?.filter((p) => 'placeholder' in p).length, 2, 'the 2-blank completion');
    await bot.fill(['a + b', 'total']);
    await bot.answer('right');
    const res = await run;
    assert.equal(res.path, 'learned');
    assert.equal(t.evs.filter((e) => e.kind === 'completion' && e.production).length, 2);
    assert.ok(t.evs.some((e) => e.learnT === 0.3), 'a passing completion after a worked example boosts learning');
  });

  test('format-only: a note, no evidence, then the next item', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    const p = await bot.answer({ text: '(1, 2, 3)' });
    assert.equal(p.id, 'p1');
    await bot.screen();
    assert.equal(t.evs.length, 0, 'format-only records nothing');
    assert.ok(t.editor.decoLog.some((ds) => ds.some((d) => d.kind === 'format' && d.text.startsWith('right idea; Python writes it as'))));
    assert.notEqual(bot.probe().id, 'p1', 'the next item is on screen');
    // Format-only on PROBE moves on to PROBE2, whose right answer tests out.
    await bot.answer('right');
    const res = await run;
    assert.equal(res.path, 'tested-out');
    assert.equal(t.evs.length, 1);
  });

  test('caps: 150 s of active time ends the atom without input', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    await bot.screen();
    t.clock.advance(151_000);
    const res = await run;
    assert.equal(res.path, 'partial');
    assert.equal(res.items, 0);
    assert.equal(t.editor.isOpen, false);
  });

  test('caps: the clock pauses in ESCALATE, which has its own 150 s', async () => {
    const lesson = new Promise<LessonText | undefined>(() => undefined); // never lands
    const t = setup({ lesson: () => lesson });
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    const s = settled(run);
    await bot.answer('mutant');
    await bot.yesNo(true);
    await bot.pickRight();
    await bot.continue();
    await bot.answer('mutant');
    await bot.answer('mutant');
    await bot.screen();
    assert.match(t.editor.doc, /preparing a short lesson/);
    const before = t.clock.now() - T0;
    t.clock.advance(150_000 - before + 20_000); // well past 150 s since the start
    await tick();
    assert.equal(s.done, false, 'the 150 s atom cap is paused while ESCALATE waits');
    t.clock.advance(40_000);
    const res = await run;
    assert.equal(res.path, 'escalated');
  });

  test('double Esc within 600 ms leaves at once and keeps the evidence; slower presses do not', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    await bot.answer('right');
    await bot.screen();
    t.pad.escape();
    await bot.screen();
    t.clock.advance(700);
    t.pad.escape();
    await bot.screen();
    assert.equal(t.pad.busy, true, 'two presses 700 ms apart do not leave');
    t.clock.advance(300);
    t.pad.escape();
    const res = await run;
    assert.equal(res.path, 'aborted');
    assert.equal(res.items, 1);
    assert.equal(t.evs.length, 1, 'the evidence so far is kept');
    assert.equal(t.editor.isOpen, false);
  });

  test('an assisted insert (12+ non-whitespace characters at once) discards the answer', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    await bot.screen();
    const p = bot.probe();
    t.editor.paste(right(p) + ' # pasted');
    t.clock.advance(9000);
    assert.ok(t.pad.submit());
    await bot.screen();
    assert.equal(t.evs.length, 0, 'the assisted answer is not counted');
    assert.ok(t.editor.decorations.some((d) => d.text === 'looked auto-inserted: not counted'));
    assert.equal(bot.probe().id, p.id, 'the same item stays');
    assert.ok(!t.editor.doc.includes('# pasted'), 'the inserted answer is removed, so it cannot simply be resubmitted');
    assert.match(t.editor.doc, /# -> $/m, 'an empty answer line again');
    await bot.answer('right');
    await bot.answer('right');
    const res = await run;
    assert.equal(res.path, 'tested-out');
    assert.equal(t.evs.length, 2);
  });
});

// ---------------------------------------------------------------- the pad's own duties

describe('AtomPad surface duties', () => {
  test('latency is invalid when window focus was lost, or past 60 s', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    await bot.screen();
    t.editor.setWindowFocus(false);
    t.clock.advance(3000);
    t.editor.setWindowFocus(true);
    await bot.answer('right');
    await bot.answer('right', { after: 61_000 });
    await run;
    assert.equal(t.evs[0].latencyValid, false, 'focus lost');
    assert.equal(t.evs[1].latencyValid, false, 'over 60 s');
    assert.equal(t.evs[1].latencyMs, 61_000);
  });

  test('closing the tab counts as Esc: the atom ends and the evidence is kept', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    await bot.answer('right');
    await bot.screen();
    t.editor.closeTab();
    const res = await run;
    assert.equal(res.path, 'aborted');
    assert.equal(t.evs.length, 1);
    assert.equal(t.exits.length, 1);
  });

  test('Leave practice and the InteractionLock abort end the atom; the caller releases the lock', async () => {
    const lock = new InteractionLock(() => Date.now());
    const t = setup({ lock });
    const bot = new Bot(t);
    const release = t.pad.acquire('atom');
    assert.ok(release && lock.held);
    const run = bot.watch(t.pad.run(t.content));
    await bot.screen();
    const rec = lock.abortActive();
    assert.equal(rec?.reason, 'esc');
    const res = await run;
    release!();
    assert.equal(res.path, 'aborted');
    assert.equal(lock.held, false);

    const t2 = setup();
    const run2 = t2.pad.run(t2.content);
    await new Bot(t2).screen();
    t2.pad.leave();
    assert.equal((await run2).path, 'aborted');
  });

  test('without a runner no completion is shown (the unknown path goes example -> final predict)', async () => {
    const t = setup({ runner: null });
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content, { placementDontKnow: true }));
    await bot.continue();
    await bot.answer('right');
    const res = await run;
    assert.equal(res.path, 'learned');
    assert.ok(!t.editor.history.some((h) => h.includes('___')), 'no completion snippet');
  });

  test('unverified content: no mutant matching (no belief check) and evidence marked unverified', async () => {
    const t = setup({ atom: aliasAtom({ verified: false }) });
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    await bot.answer('mutant');
    const r = await bot.screen();
    assert.notEqual(r.await, 'yn', 'no belief check without verified mutants');
    assert.equal(t.evs[0].unverified, true);
    assert.equal(t.evs[0].misconceptionId, undefined);
    t.pad.escape();
    await bot.screen();
    t.pad.escape();
    assert.equal((await run).path, 'aborted');
  });

  test('keyUse counts submit keys, ? and multi-line answers (the legend fades)', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    await bot.screen();
    assert.ok(t.editor.doc.includes('Ctrl+Enter submit'), 'the key legend shows at first');
    await bot.answer({ text: '?' });
    await bot.continue(); // '?' goes to UNKNOWN: the worked example
    t.pad.leave();
    await run;
    assert.equal(t.l.keyUse['ctrl+enter'], 1);
    assert.equal(t.l.keyUse['?'], 1);
  });

  test('an undo past the render puts the item back', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    const r = await bot.screen();
    t.editor.undoTo('# something from the previous step\nx = 1');
    await tick();
    assert.equal(t.editor.doc, r.text);
    t.pad.leave();
    await run;
  });

  test('keepOpen leaves the pad open for the next flow, which reuses it', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content, { keepOpen: true }));
    await bot.answer('right');
    await bot.answer('right');
    await run;
    assert.equal(t.editor.isOpen, true);
    assert.equal(t.editor.closes, 0);
    const run2 = bot.watch(t.pad.run(t.content));
    await bot.screen();
    assert.equal(t.editor.opens, 1, 'the open pad is reused');
    t.pad.leave();
    await run2;
    assert.equal(t.editor.closes, 1);
  });

  test('Esc Esc on an idle pad left open closes it', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content, { keepOpen: true }));
    await bot.answer('right');
    await bot.answer('right');
    await run;
    assert.equal(t.editor.isOpen, true);
    t.pad.escape();
    t.clock.advance(800);
    t.pad.escape();
    await tick();
    assert.equal(t.editor.isOpen, true, 'presses 800 ms apart keep it');
    t.clock.advance(200);
    t.pad.escape();
    await tick();
    assert.equal(t.editor.isOpen, false);
    assert.equal(t.pad.session, undefined);
  });

  test('y/n, picks and submits are only taken when the pad waits for them', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    await bot.screen();
    assert.equal(t.pad.yesNo(true), false, 'no y/n on an answer step');
    assert.equal(t.pad.pick(1), false, 'no pick on an answer step');
    await bot.answer('mutant');
    await bot.screen();
    assert.equal(t.pad.pick(3), false);
    assert.equal(t.pad.submit(), false, 'Ctrl+Enter does nothing on a y/n step');
    t.pad.leave();
    await run;
  });

  test('a busy pad refuses a second flow', async () => {
    const t = setup();
    const bot = new Bot(t);
    const run = bot.watch(t.pad.run(t.content));
    await bot.screen();
    await assert.rejects(t.pad.run(t.content), /is running/);
    t.pad.leave();
    await run;
  });
});

// ---------------------------------------------------------------- pure helpers

describe('pad helpers', () => {
  test('assisted inserts: 12+ non-whitespace characters in one change event', () => {
    assert.equal(isAssistedInsert(['abcdefghijk']), false);
    assert.equal(isAssistedInsert(['abcdefghijkl']), true);
    assert.equal(isAssistedInsert(['a b c d e f g h i j k']), false, 'whitespace does not count');
    assert.equal(isAssistedInsert(['abcdef', 'ghijkl']), true, 'one event with several changes (multi-cursor)');
    assert.equal(isAssistedInsert(['\n    ']), false);
  });

  test('lastAnswerLine finds the last # -> or // -> line', () => {
    assert.equal(lastAnswerLine('# what\nx\n# -> 1\n# -> 2\n', '#'), 3);
    assert.equal(lastAnswerLine('// a\n  //-> x', '//'), 1);
    assert.equal(lastAnswerLine('# none', '#'), undefined);
  });

  test('upsertPatternCard keeps seen times and addedAt, unions use cases, prefers fresh text', () => {
    const deck = [] as Learner['patternDeck'];
    upsertPatternCard(deck, { conceptId: 'c', tag: 'alias-copy', pattern: { ...aliasPattern, useCases: ['a', 'b'] } }, 10);
    deck[0].useCaseSeenAt = { a: 5 };
    upsertPatternCard(deck, { conceptId: 'c', tag: 'alias-copy', pattern: { ...aliasPattern, pitfall: '', useCases: ['b', 'c'] }, lastRatio: 0.8 }, 20);
    assert.equal(deck.length, 1);
    assert.deepEqual(deck[0].useCases, ['a', 'b', 'c']);
    assert.deepEqual(deck[0].useCaseSeenAt, { a: 5 });
    assert.equal(deck[0].addedAt, 10);
    assert.equal(deck[0].pitfall, aliasPattern.pitfall, 'an empty field never wipes a filled one');
    assert.equal(deck[0].lastRatio, 0.8);
  });

  test('atomFlash and pad identifiers', () => {
    assert.equal(atomFlash('Slicing', 'Unknown', 'Learning', 41_400), 'Slicing: Unknown -> Learning (41s)');
    assert.equal(padPath('python'), '/atom.dlbpy');
    assert.equal(padLanguageId('typescript'), 'deliberate-pad-typescript');
    assert.equal(padLangOf('/atom.dlbjs'), 'javascript');
    assert.equal(padLangOf('/x.py'), undefined);
  });

  test('LatencyClock: starts on focus, invalid after a focus loss or past 60 s', () => {
    let now = 0;
    const c = new LatencyClock(() => now, false);
    now = 2000;
    c.focus(true);
    now = 7000;
    assert.deepEqual(c.read(), { ms: 5000, valid: true });
    c.focus(false);
    c.focus(true);
    assert.equal(c.read().valid, false);
    c.restart(true);
    now += 61_000;
    assert.equal(c.read().valid, false);
  });
});
