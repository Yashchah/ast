// Sprints in the pad (spec V1-9 (a), (g), (i)): the selection order through the real sprintSelect
// (delayed misconception check, mastery audit, due review, which-pattern, a traceback every 5th item),
// evidence sources 'sprint' / 'audit' with delayedCheckFor, which-pattern QuickPicks of 4 deck names
// without valid alternatives, traceback items graded on pad lines, selectionGap marking, the stops
// ('until' after the current item or 15 s later, budget, Esc, Leave, lock abort), and the score
// against the personal best. The pad is in memory, the clock manual, the runner fake.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AtomPattern, BatchItem, BatchRecord, PatternCard, PrintedArg, RecordedOutput, Runner, Runtime, StoredAtom, StoredCompletion, StoredMutant,
  StoredProbe, TracebackItem,
} from '../src/contracts';
import { AtomCache } from '../src/atoms/cache';
import { AtomPad, ManualClock, MemoryPadEditor, PAD, ScriptedPadUi, type PadLogCard, type PickOneOptions } from '../src/atoms/pad';
import type { PadRender } from '../src/atoms/render';
import { mulberry32 } from '../src/atoms/rng';
import { Sprint, sprintScore, type SprintOptions, type SprintResult } from '../src/atoms/sprint';
import { SPRINT } from '../src/atoms/sprintSelect';
import { Stock } from '../src/atoms/stock';
import { TAXONOMY } from '../src/atoms/tags';
import { emptyLearner, recordEvidence, upsertConcepts, type EvidenceInput } from '../src/learner';
import { InteractionLock } from '../src/lock';
import type { Learner } from '../src/types';

const T0 = Date.UTC(2026, 9, 4, 9, 0, 0);
const DAY = 24 * 3600_000;
const M = 'assignment-copies';

// ---------------------------------------------------------------- fixtures

const pyInt = (n: number): PrintedArg => ({ type: 'int', repr: String(n), val: { t: 'int', v: String(n) } });
const pyList = (ns: number[]): PrintedArg => ({ type: 'list', repr: `[${ns.join(', ')}]`, val: { t: 'list', v: ns.map((n) => ({ t: 'int', v: String(n) })) } });
const printed = (...args: PrintedArg[]): RecordedOutput => ({ stdout: args.map((a) => a.repr).join('\n') + '\n', values: args.map((a) => [a]) });
const stats = () => ({ seenAt: [] as number[], n: 0, nCorrect: 0 });

function mutant(probeId: string, misconceptionId: string, code: string, output: RecordedOutput, diffLine: number): StoredMutant {
  return {
    id: `${probeId}~${misconceptionId}`, misconceptionId, belief: 'a belief', refutation: 'Look again.', rule: 'One rule.', code, output, diffLine,
    source: 'curated', ambiguous: false, matches: 0, confirmations: 0, rejections: 0,
  };
}

function aliasProbe(i: number): StoredProbe {
  const start = [[1, 2], [4, 5], [7, 8], [3, 6], [2, 9], [5, 1]][i];
  const add = [3, 6, 9, 1, 4, 7][i];
  const code = `a = [${start.join(', ')}]\nb = a\nb.append(${add})\nprint(a)`;
  const id = `ac#${i}`;
  return {
    id, group: `ac:${i}`, code, output: printed(pyList([...start, add])), parSec: 5, answerSpaceG: 0.06, constructs: [], discriminating: true, stats: stats(),
    mutants: [mutant(id, M, code.replace('b = a', 'b = a.copy()'), printed(pyList(start)), 2)],
  };
}

function sliceProbe(i: number): StoredProbe {
  const xs = [[1, 4, 7, 9], [2, 5, 8, 3], [6, 1, 3, 8], [9, 2, 4, 6], [3, 8, 5, 1], [7, 3, 9, 2]][i];
  const code = `xs = [${xs.join(', ')}]\nprint(xs[1:3])`;
  const id = `ls#${i}`;
  return {
    id, group: `ls:${i}`, code, output: printed(pyList(xs.slice(1, 3))), parSec: 5, answerSpaceG: 0.06, constructs: [], discriminating: true, stats: stats(),
    mutants: [mutant(id, 'slice-end-included', code.replace('xs[1:3]', 'xs[1:4]'), printed(pyList(xs.slice(1, 4))), 2)],
  };
}

function sumProbe(i: number): StoredProbe {
  const xs = [[4, 5, 6], [7, 8, 9], [5, 6, 8], [6, 7, 5], [3, 9, 8], [8, 8, 9]][i];
  const code = `total = 0\nfor x in [${xs.join(', ')}]:\n    total += x\nprint(total)`;
  const id = `la#${i}`;
  return {
    id, group: `la:${i}`, code, output: printed(pyInt(xs.reduce((a, b) => a + b, 0))), parSec: 5, answerSpaceG: 0.06, constructs: [], discriminating: true,
    stats: stats(), mutants: [mutant(id, 'assign-instead-of-add', code.replace('total += x', 'total = x'), printed(pyInt(xs[2])), 3)],
  };
}

const COMPLETIONS: Record<string, { code: string; fill: string; pass: string }> = {
  'alias-copy': { code: 'def safe_add(xs, x):\n    out = [[1]]\n    out.append(x)\n    return out', fill: 'xs.copy()', pass: 'out = xs.copy()' },
  'list-slicing': { code: 'def middle(xs):\n    return [[1]]', fill: 'xs[1:-1]', pass: 'return xs[1:-1]' },
  'loop-accumulator': { code: 'def total(xs):\n    t = 0\n    for x in xs:\n        t [[1]] x\n    return t', fill: '+=', pass: 't += x' },
};

function completion(tag: string, k = 0): StoredCompletion {
  const c = COMPLETIONS[tag];
  return { id: `${tag}#c${k}`, group: `${tag}:c${k}`, code: c.code, solutions: [c.fill], wrongFills: [], parSec: 25, stats: stats(), harness: "check(True, 'a')\ncheck(True, 'b')" };
}

const TB_CODE = 'def third(xs):\n    return xs[2]\nprint(third([1, 2]))';
const TB_TRACE = [
  'Traceback (most recent call last):',
  '  File "pad", line 3, in <module>',
  '    print(third([1, 2]))',
  '  File "pad", line 2, in third',
  '    return xs[2]',
  'IndexError: list index out of range',
].join('\n');

function traceback(i: number): TracebackItem {
  return {
    id: `tb#${i}`, code: TB_CODE.replace('[1, 2]', `[${i}, ${i + 1}]`), trace: TB_TRACE.replace('[1, 2]', `[${i}, ${i + 1}]`), line: 2, exception: 'IndexError',
    meanings: ['a position past the end of a list', 'a dictionary key that is missing', 'a value of the wrong type'], correctMeaning: 0,
    siblingGroup: `tb:${i}`, conceptId: 'reading-tracebacks',
  };
}

function pattern(tag: string): AtomPattern {
  const t = TAXONOMY[tag];
  return { kind: t.kind, name: t.patternName, useWhen: 'it fits', template: '', rule: '', howItRuns: '', pitfall: '', useCases: useCases(tag) };
}

const useCases = (tag: string) => [1, 2, 3, 4, 5, 6].map((k) => `${tag} problem ${k}`);

function atom(tag: string, probes: StoredProbe[], completions: StoredCompletion[], tracebacks: TracebackItem[] = []): StoredAtom {
  return {
    key: tag, lang: 'python', conceptId: tag, tag, source: 'seed', verified: true, createdAt: T0, pattern: pattern(tag), probes, examples: [],
    completions, contrasts: [], tracebacks,
  };
}

function card(tag: string): PatternCard {
  const p = pattern(tag);
  return {
    conceptId: tag, tag, kind: p.kind, name: p.name, useWhen: p.useWhen, template: '', rule: '', pitfall: '', useCases: useCases(tag), useCaseSeenAt: {},
    addedAt: T0 - DAY,
  };
}

class FakeRunner implements Runner {
  readonly runtime: Runtime = { lang: 'python', exe: 'python', snippetArgv: [], learnerArgv: [], version: 'test' };
  async runBatch(items: BatchItem[]): Promise<BatchRecord[]> {
    return items.map((it) => {
      const ok = Object.values(COMPLETIONS).some((c) => it.code.includes(c.pass));
      const rec: BatchRecord = { id: it.id, stdout: '', values: [], exitOk: ok, timedOut: false, ms: 20, constructs: [] };
      if (!ok) {
        rec.exception = 'CheckFailed';
        rec.error = 'Traceback (most recent call last):\n  File "<snippet>", line 4, in <module>\nCheckFailed: CHECK b';
      }
      return rec;
    });
  }
  async runLearnerCode(): Promise<never> {
    throw new Error('not used');
  }
}

class TestStock extends Stock {
  poked: string[] = [];
  constructor(cache: AtomCache, runner: () => Runner | undefined) {
    super({ lang: 'python', cache, runner, readFile: async () => Promise.reject(new Error('no seed banks in this test')) });
  }
  override refillIfLow(key: string): Promise<void> | undefined {
    this.poked.push(key);
    return undefined;
  }
}

interface SetupOptions {
  runner?: Runner | null;
  lock?: InteractionLock;
  /** Learner state: alias-copy has a suppressed misconception due, list-slicing an audit due, loop-accumulator a review due. */
  due?: boolean;
  best?: number;
}

function setup(o: SetupOptions = {}) {
  const clock = new ManualClock(T0);
  const editor = new MemoryPadEditor();
  const ui = new ScriptedPadUi();
  const l: Learner = emptyLearner();
  upsertConcepts(l, ['alias-copy', 'list-slicing', 'loop-accumulator', 'for-range-bounds', 'string-split-join', 'reading-tracebacks'].map((tag) => ({
    id: tag, name: TAXONOMY[tag].patternName, tag, prerequisites: [],
  })), T0 - DAY);
  l.patternDeck.push(card('alias-copy'), card('list-slicing'), card('loop-accumulator'), card('for-range-bounds'), card('string-split-join'));
  if (o.due !== false) {
    const ac = l.concepts['alias-copy'];
    ac.misconceptions[M] = { p: 0.4, belief: 'b = a makes a separate copy of the list', status: 'suppressed', groups: ['ac:0'], refutedAt: T0 - 3600_000, delayedHits: 0, relapses: 0, lastAt: T0 - 3600_000, nextCheckAt: T0 - 1000 };
    const ls = l.concepts['list-slicing'];
    Object.assign(ls, { mastery: 0.9, tested: true, production: true, masteredAt: T0 - 2 * DAY, auditDueAt: T0 - DAY });
    l.concepts['loop-accumulator'].nextReview = T0 - 1000;
  }
  const cache = new AtomCache('python', undefined, { debounceMs: -1, now: () => clock.now() });
  cache.put(atom('alias-copy', [0, 1, 2, 3, 4, 5].map(aliasProbe), [completion('alias-copy')]));
  cache.put(atom('list-slicing', [0, 1, 2, 3, 4, 5].map(sliceProbe), [completion('list-slicing'), completion('list-slicing', 1)]));
  cache.put(atom('loop-accumulator', [0, 1, 2, 3, 4, 5].map(sumProbe), [completion('loop-accumulator')]));
  cache.put(atom('reading-tracebacks', [], [], [0, 1, 2].map(traceback)));
  const runner = o.runner === null ? undefined : o.runner ?? new FakeRunner();
  const evs: EvidenceInput[] = [];
  const logs: PadLogCard[] = [];
  const pad = new AtomPad({
    editor, ui, clock, learner: () => l, lock: o.lock,
    recordEvidence: (e) => {
      evs.push(e);
      return recordEvidence(l, e, { clock: () => clock.now() });
    },
    cache: () => cache,
    runner: () => runner,
    onLog: (c) => logs.push(c),
  });
  const stock = new TestStock(cache, () => runner);
  let best = o.best;
  const bestSets: number[] = [];
  const store = { get: () => best, set: (s: number) => void (bestSets.push(s), (best = s)) };
  const sprint = (rng = mulberry32(7)) => new Sprint({ pad, stock, best: store, rng });
  const picks: { title: string; items: string[]; correctName: string; alternatives: string[] }[] = [];
  // The which-pattern QuickPick: answer with the card that owns the use case in the title.
  ui.onPickOne = (opt: PickOneOptions) => {
    const useCase = opt.title.replace(/^Which pattern fits: /, '');
    const c = l.patternDeck.find((x) => x.useCases.includes(useCase))!;
    picks.push({ title: opt.title, items: opt.items, correctName: c.name, alternatives: TAXONOMY[c.tag].alternatives.map((a) => TAXONOMY[a]?.patternName ?? a) });
    clock.advance(4000);
    return opt.items.indexOf(c.name);
  };
  return { clock, editor, ui, l, cache, runner, evs, logs, pad, stock, sprint, picks, bestSets };
}

type Setup = ReturnType<typeof setup>;

interface Screen {
  kind: 'predict' | 'completion' | 'traceback' | 'meaning' | 'other';
  render: PadRender;
  doc: string;
  key?: string;
  probe?: StoredProbe;
  tag?: string;
  item?: TracebackItem;
}

interface Policy {
  predict?: (key: string, n: number) => 'right' | 'wrong' | 'mutant';
  predictMs?: number;
  traceback?: 'right' | 'outer';
  onScreen?: (s: Screen, k: number) => 'stop' | void;
}

function classify(t: Setup, r: PadRender): Screen {
  const doc = t.editor.doc;
  if (r.await === 'pick3' || r.await === 'pick2') return { kind: 'meaning', render: r, doc };
  if (doc.startsWith('# which line failed')) {
    const item = t.cache.get('reading-tracebacks')!.tracebacks.find((x) => doc.includes(x.code));
    return { kind: 'traceback', render: r, doc, item };
  }
  if (r.snippet) return { kind: 'completion', render: r, doc, tag: Object.keys(COMPLETIONS).find((x) => doc.includes(COMPLETIONS[x].code.split('\n')[0])) };
  for (const key of t.cache.keys()) {
    const p = t.cache.get(key)!.probes.find((x) => doc.includes(x.code));
    if (p) return { kind: 'predict', render: r, doc, key, probe: p };
  }
  return { kind: 'other', render: r, doc };
}

/** Plays the learner on the pad until the sprint ends (QuickPicks are answered by ui.onPickOne). */
async function play(t: Setup, run: Promise<unknown>, policy: Policy = {}): Promise<Screen[]> {
  const ended = run.then(() => 'ended' as const, () => 'ended' as const);
  const screens: Screen[] = [];
  for (let k = 0; k < 40; k++) {
    const r = await Promise.race([t.pad.whenAwaiting(), ended]);
    if (r === 'ended') return screens;
    assert.ok(r);
    const s = classify(t, r);
    screens.push(s);
    if (policy.onScreen?.(s, k) === 'stop') return screens;
    switch (s.kind) {
      case 'predict': {
        const n = screens.filter((x) => x.kind === 'predict').length;
        const move = policy.predict?.(s.key!, n) ?? 'right';
        t.editor.answer(move === 'right' ? s.probe!.output.stdout.trim() : move === 'mutant' ? s.probe!.mutants[0].output.stdout.trim() : 'zzz');
        t.clock.advance(policy.predictMs ?? 9000);
        assert.ok(t.pad.submit());
        break;
      }
      case 'completion':
        t.editor.fill([COMPLETIONS[s.tag!].fill]);
        t.clock.advance(20_000);
        assert.ok(t.pad.submit());
        break;
      case 'traceback': {
        const item = s.item!;
        const offset = s.render.lineOffset ?? 0;
        const line = policy.traceback === 'outer' ? 3 : item.line;
        t.editor.answer(`line ${line + offset}, ${item.exception}`);
        t.clock.advance(8000);
        assert.ok(t.pad.submit());
        break;
      }
      case 'meaning':
        t.clock.advance(3000);
        assert.ok(t.pad.pick(s.render.correctPick!));
        break;
      default:
        assert.fail(`unexpected screen:\n${s.doc}`);
    }
  }
  assert.fail('the sprint did not end');
}

const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------- tests

describe('Sprint.run', () => {
  test('selection order: delayed check, audit, due review, which-pattern, a traceback 5th; sources and counters', async () => {
    const t = setup();
    const p = t.sprint().run({ reason: 'wait', maxItems: 6 });
    const screens = await play(t, p);
    const res = await p;

    const kinds = screens.filter((s) => s.kind !== 'meaning').map((s) => s.kind);
    assert.deepEqual(kinds, ['predict', 'completion', 'predict', 'traceback'], 'pad items (which-pattern items are QuickPicks)');
    assert.equal(t.picks.length, 2, 'two which-pattern items');
    const order = t.evs.map((e) => `${e.kind}:${e.conceptId}`);
    assert.deepEqual(order, [
      'predict:alias-copy', 'completion:list-slicing', 'predict:loop-accumulator', `which-pattern:${order[3].split(':')[1]}`,
      'traceback:reading-tracebacks', `which-pattern:${order[5].split(':')[1]}`,
    ]);

    const [dc, audit, due] = t.evs;
    assert.equal(dc.source, 'sprint');
    assert.equal(dc.delayedCheckFor, M);
    assert.ok(dc.avoidedMisconceptionIds?.includes(M), 'the carried mutant counts as coverage');
    assert.ok(screens[0].probe!.mutants.some((m) => m.misconceptionId === M), 'the delayed check carries the mutant');
    assert.equal(audit.source, 'audit');
    assert.equal(audit.production, true);
    assert.equal(due.source, 'sprint');
    assert.equal(due.delayedCheckFor, undefined);
    assert.ok(t.evs.filter((e) => e.kind === 'which-pattern').every((e) => e.source === 'sprint' && e.correct === true));
    const tb = t.evs.find((e) => e.kind === 'traceback')!;
    assert.equal(tb.correct, true);
    assert.equal(tb.siblingGroup, screens[3].item!.siblingGroup);

    // Never two consecutive items on the same concept.
    for (let i = 1; i < t.evs.length; i++) assert.notEqual(t.evs[i].conceptId, t.evs[i - 1].conceptId, `items ${i - 1} and ${i}`);
    // Generic headers in the pad.
    for (const s of screens.filter((x) => x.kind === 'predict')) {
      assert.equal(s.doc.split('\n')[0], '# what does this print?');
      assert.ok(!s.doc.includes(TAXONOMY[s.key!].patternName));
    }

    assert.equal(res.items, 6);
    assert.equal(res.correct, 6);
    assert.equal(res.auditsRun, 1);
    assert.equal(res.delayedChecks, 1);
    assert.equal(res.stopReason, 'max-items');
    assert.equal(t.editor.isOpen, false);
    assert.equal(t.logs.length, 1);
    assert.equal(t.logs[0].kind, 'sprint');
    assert.match(t.ui.flashes[t.ui.flashes.length - 1], /^Sprint: 6\/6 right/);
    assert.equal(t.pad.busy, false);
  });

  test('which-pattern: 4 deck names, the right one included, no valid alternative as a distractor, the use case marked seen', async () => {
    const t = setup({ due: false });
    const p = t.sprint(mulberry32(3)).run({ reason: 'wait', maxItems: 4 });
    await play(t, p);
    await p;
    assert.ok(t.picks.length >= 3);
    for (const pick of t.picks) {
      assert.equal(pick.items.length, SPRINT.whichPatternOptions);
      assert.equal(new Set(pick.items).size, 4);
      assert.ok(pick.items.includes(pick.correctName));
      for (const alt of pick.alternatives) assert.ok(!pick.items.includes(alt), `${alt} is a valid alternative, never a distractor`);
      const useCase = pick.title.replace(/^Which pattern fits: /, '');
      const c = t.l.patternDeck.find((x) => x.useCases.includes(useCase))!;
      assert.ok(c.useCaseSeenAt[useCase] > 0, 'the use case is not asked again within 7 days');
    }
    const used = t.picks.map((x) => x.title);
    assert.equal(new Set(used).size, used.length, 'no repeat inside a sprint');
  });

  test('traceback: answering the outer frame names the frame-order misconception; the pad shows renumbered pad lines', async () => {
    const t = setup({ due: false });
    // Four which-pattern items, then the traceback (every 5th item).
    const p = t.sprint().run({ reason: 'wait', maxItems: 5 });
    const screens = await play(t, p, { traceback: 'outer' });
    await p;
    const s = screens.find((x) => x.kind === 'traceback')!;
    assert.ok(s, 'a traceback item ran');
    const offset = s.render.lineOffset!;
    assert.ok(s.doc.includes(`File "pad", line ${2 + offset}, in third`), 'trace lines are pad lines');
    assert.ok(screens.some((x) => x.kind === 'meaning'), 'then the 1/2/3 meaning pick');
    const e = t.evs.find((x) => x.kind === 'traceback')!;
    assert.equal(e.correct, false);
    assert.equal(e.misconceptionId, 'first-frame-is-failure');
    assert.ok(t.editor.history.some((h) => h.includes('What does IndexError mean?')));
  });

  test("selectionGap: right in an atom, wrong in a sprint; the next sprint asks which-pattern for it, a right pick clears it", async () => {
    const t = setup();
    t.pad.atomPassed.add('loop-accumulator');
    const p = t.sprint().run({ reason: 'wait', maxItems: 3 });
    await play(t, p, { predict: (key) => (key === 'loop-accumulator' ? 'wrong' : 'right') });
    await p;
    assert.equal(t.l.concepts['loop-accumulator'].selectionGap, true);
    assert.ok(!t.l.concepts['alias-copy'].selectionGap, 'right answers set nothing');

    // Still due: the next sprint serves it as a which-pattern item first.
    t.clock.advance(60_000);
    t.l.concepts['loop-accumulator'].nextReview = t.clock.now() - 1;
    const before = t.picks.length;
    const p2 = t.sprint(mulberry32(11)).run({ reason: 'wait', maxItems: 1 });
    await play(t, p2);
    await p2;
    assert.equal(t.picks.length, before + 1);
    assert.equal(t.picks[before].correctName, TAXONOMY['loop-accumulator'].patternName);
    assert.ok(!t.l.concepts['loop-accumulator'].selectionGap, 'a right selection item clears the gap');
  });

  test("'until' settling ends the sprint after the current item", async () => {
    const t = setup();
    let land!: () => void;
    const until = new Promise<void>((r) => (land = r));
    const p = t.sprint().run({ reason: 'wait', until, maxItems: 6 });
    const screens = await play(t, p, {
      onScreen: (s, k) => {
        if (k === 1) land();
      },
    });
    const res = await p;
    assert.equal(res.stopReason, 'until');
    assert.equal(res.items, 2, 'the open item could still be answered');
    assert.equal(screens.length, 2);
  });

  test("an item still open 15 s after 'until' settled is abandoned", async () => {
    const t = setup();
    let land!: () => void;
    const until = new Promise<void>((r) => (land = r));
    const p = t.sprint().run({ reason: 'wait', until, maxItems: 6 });
    await play(t, p, { onScreen: (_s, k) => (k === 1 ? 'stop' : undefined) });
    land();
    await tick();
    t.clock.advance(14_000);
    await tick();
    assert.equal(t.pad.busy, true, 'still within the 15 s grace');
    t.clock.advance(1500);
    const res = await p;
    assert.equal(res.stopReason, 'until');
    assert.equal(res.items, 1);
  });

  test("an 'until' that already settled shows nothing", async () => {
    const t = setup();
    const res = await t.sprint().run({ reason: 'wait', until: Promise.resolve() });
    assert.equal(res.items, 0);
    assert.equal(res.stopReason, 'until');
    assert.equal(t.editor.opens, 0);
    assert.equal(t.logs.length, 0);
  });

  test('the budget ends the sprint after the current item', async () => {
    const t = setup();
    const p = t.sprint().run({ reason: 'wait', budgetMs: 20_000, maxItems: 10 });
    await play(t, p, { predictMs: 9000 });
    const res = await p;
    assert.equal(res.stopReason, 'budget');
    assert.ok(res.items >= 2 && res.items <= 3, `items ${res.items}`);
    assert.ok(res.ms >= 20_000);
  });

  test('double Esc and Leave practice end as esc; the InteractionLock abort ends silently', async () => {
    const t = setup();
    const p = t.sprint().run({ reason: 'wait' });
    await play(t, p, { onScreen: (_s, k) => (k === 1 ? 'stop' : undefined) });
    t.pad.escape();
    t.clock.advance(200);
    t.pad.escape();
    const r1 = await p;
    assert.equal(r1.stopReason, 'esc');
    assert.equal(r1.items, 1);
    assert.equal(t.logs.length, 1);

    const t2 = setup();
    const p2 = t2.sprint().run({ reason: 'wait' });
    await play(t2, p2, { onScreen: () => 'stop' });
    t2.pad.leave();
    assert.equal((await p2).stopReason, 'esc');

    const lock = new InteractionLock(() => Date.now());
    const t3 = setup({ lock });
    const release = t3.pad.acquire('sprint')!;
    const p3 = t3.sprint().run({ reason: 'wait' });
    await play(t3, p3, { onScreen: (_s, k) => (k === 1 ? 'stop' : undefined) });
    lock.abortActive();
    const r3 = await p3;
    release();
    assert.equal(r3.stopReason, 'aborted');
    assert.equal(r3.items, 1, 'the answered item is kept');
    assert.equal(t3.logs.length, 0);
    assert.deepEqual(t3.ui.flashes.filter((f) => f.startsWith('Sprint')), []);
    assert.equal(t3.editor.isOpen, false);
  });

  test('Esc on a which-pattern QuickPick ends the sprint', async () => {
    const t = setup({ due: false });
    t.ui.onPickOne = () => undefined;
    const res = await t.sprint().run({ reason: 'wait' });
    assert.equal(res.stopReason, 'esc');
    assert.equal(res.items, 0);
  });

  test('the 3-minute sprint scores correct items per par minute against the personal best', async () => {
    const t = setup({ best: 2 });
    const p = t.sprint().run({ reason: 'sprint', budgetMs: 180_000, maxItems: 6 });
    await play(t, p);
    const res = await p;
    assert.equal(res.items, 6);
    assert.equal(res.best, 2);
    assert.ok(res.score > 2);
    assert.equal(res.newBest, true);
    assert.deepEqual(t.bestSets, [res.score]);
    assert.ok(t.ui.flashes.some((f) => /\/min \(new best\)$/.test(f)));

    // Score: correct items per minute of par-normalised time (10 s per item at par).
    assert.equal(sprintScore([{ correct: true, elapsedMs: 10_000, parAbsMs: 10_000 }, { correct: true, elapsedMs: 10_000, parAbsMs: 10_000 }]), 6);
    assert.equal(sprintScore([{ correct: true, elapsedMs: 20_000, parAbsMs: 10_000 }, { correct: false, elapsedMs: 10_000, parAbsMs: 10_000 }]), 2);
    assert.equal(sprintScore([{ correct: true, elapsedMs: 600_000, parAbsMs: 10_000 }]), 1.5, 'one item counts 4 par units at most');
    assert.equal(sprintScore([]), 0);

    const t2 = setup({ best: 99 });
    const p2 = t2.sprint().run({ reason: 'sprint', maxItems: 3 });
    await play(t2, p2);
    const r2 = await p2;
    assert.equal(r2.newBest, false);
    assert.deepEqual(t2.bestSets, []);
  });

  test('without a runner: no completions or audits', async () => {
    const t = setup({ runner: null });
    const p = t.sprint().run({ reason: 'wait', maxItems: 6 });
    const screens = await play(t, p);
    const res = await p;
    assert.ok(screens.every((s) => s.kind !== 'completion'));
    assert.equal(res.auditsRun, 0);
    assert.ok(t.evs.every((e) => e.source !== 'audit'));
  });

  test('available() counts what a sprint could serve without showing anything; items are marked seen and refills poked', async () => {
    const t = setup();
    assert.equal(t.sprint().available(2), 2);
    assert.equal(t.editor.opens, 0);
    const empty = setup({ due: false });
    empty.l.patternDeck.length = 0;
    for (const k of empty.cache.keys()) for (const it of empty.cache.get(k)!.tracebacks) empty.cache.markSeen(k, it.id, T0);
    assert.equal(empty.sprint().available(2), 0, 'nothing due, no deck, no traceback');

    const p = t.sprint().run({ reason: 'wait', maxItems: 3 });
    const screens = await play(t, p);
    await p;
    const shown = screens.filter((s) => s.probe).map((s) => ({ key: s.key!, id: s.probe!.id }));
    for (const s of shown) assert.ok(t.cache.seenIds(s.key).includes(s.id));
    assert.ok(t.stock.poked.includes('alias-copy'), 'the stock may top a key up after an item');
  });

  test('a sprint runs once, and not while another flow holds the pad', async () => {
    const t = setup();
    const s = t.sprint();
    const p = s.run({ reason: 'wait' });
    await play(t, p, { onScreen: () => 'stop' });
    await assert.rejects(t.sprint().run({ reason: 'wait' }), /is running/);
    t.pad.leave();
    await p;
    await assert.rejects(s.run({ reason: 'wait' }), /runs once/);
  });

  test('keepOpen leaves the pad open for the atom the wait was for', async () => {
    const t = setup();
    let land!: () => void;
    const until = new Promise<void>((r) => (land = r));
    const opts: SprintOptions = { reason: 'wait', until, keepOpen: true };
    const p = t.sprint().run(opts);
    await play(t, p, { onScreen: (_s, k) => void (k === 0 && land()) });
    const res: SprintResult = await p;
    assert.equal(res.stopReason, 'until');
    assert.equal(t.editor.isOpen, true);
    assert.equal(t.editor.closes, 0);
    assert.ok(PAD.idleMs > SPRINT.untilGraceMs);
  });
});
