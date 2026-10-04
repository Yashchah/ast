// The placement blitz in the pad (spec V1-7): the optional tick picker, the typing calibration item,
// adaptive predict items under the generic header, the last 2 completions, feedback timings, candidate
// misconceptions without a belief check, the stop rules (classified, Esc, Leave, lock abort, the
// experienced fast lane), the 'roadmap almost ready' extras while the plan is pending, and plan
// concepts joining mid-run. The pad is in memory, the clock manual, the runner fake.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AtomPattern, BatchItem, BatchRecord, PrintedArg, RecordedOutput, Runner, Runtime, StoredAtom, StoredCompletion, StoredMutant, StoredProbe,
} from '../src/contracts';
import { AtomCache } from '../src/atoms/cache';
import { AtomPad, ManualClock, MemoryPadEditor, PAD, ScriptedPadUi, type PadLogCard } from '../src/atoms/pad';
import { isFaithfulCopy, PlacementRun, TICK_PICKER, type PlacementRunOptions, type PlacementRunResult } from '../src/atoms/placementRun';
import { PLACEMENT } from '../src/atoms/placement';
import type { PadRender } from '../src/atoms/render';
import { Stock } from '../src/atoms/stock';
import { TAXONOMY } from '../src/atoms/tags';
import { emptyLearner, recordEvidence, upsertConcepts, type EvidenceInput } from '../src/learner';
import { InteractionLock } from '../src/lock';
import type { Learner } from '../src/types';

const T0 = Date.UTC(2026, 9, 4, 9, 0, 0);
const TAGS = ['variables-assignment', 'list-indexing', 'list-slicing', 'for-range-bounds', 'loop-accumulator'];

// ---------------------------------------------------------------- fixtures

const pyStr = (s: string): PrintedArg => ({ type: 'str', repr: `'${s}'`, val: { t: 'str', v: s } });
const pyInt = (n: number): PrintedArg => ({ type: 'int', repr: String(n), val: { t: 'int', v: String(n) } });
const pyList = (ns: number[]): PrintedArg => ({ type: 'list', repr: `[${ns.join(', ')}]`, val: { t: 'list', v: ns.map((n) => ({ t: 'int', v: String(n) })) } });
const printed = (...args: PrintedArg[]): RecordedOutput => ({ stdout: args.map((a) => (a.type === 'str' ? (a.val as { v: string }).v : a.repr)).join('\n') + '\n', values: args.map((a) => [a]) });
const stats = () => ({ seenAt: [] as number[], n: 0, nCorrect: 0 });

function mutant(probeId: string, misconceptionId: string, code: string, output: RecordedOutput, diffLine: number): StoredMutant {
  const m = TAXONOMY[TAGS.find((t) => TAXONOMY[t].misconceptions.some((x) => x.id === misconceptionId)) ?? 'list-indexing'].misconceptions.find((x) => x.id === misconceptionId);
  return {
    id: `${probeId}~${misconceptionId}`, misconceptionId, belief: m?.belief ?? misconceptionId, refutation: 'Look at the line again.', rule: 'One rule.',
    code, output, diffLine, source: 'curated', ambiguous: false, matches: 0, confirmations: 0, rejections: 0,
  };
}

function probe(id: string, group: string, code: string, output: RecordedOutput, m: { id: string; code: string; output: RecordedOutput; line: number }): StoredProbe {
  return {
    id, group, code, output, parSec: 5, answerSpaceG: 0.06, constructs: [], discriminating: true, stats: stats(),
    mutants: [mutant(id, m.id, m.code, m.output, m.line)],
  };
}

const WORDS = [['pear', 'plum', 'fig'], ['lime', 'kiwi', 'date'], ['corn', 'bean', 'rice'], ['wolf', 'lynx', 'bear'], ['ruby', 'jade', 'onyx']];
const SLICES = [[1, 4, 7, 9], [2, 5, 8, 3], [6, 1, 3, 8], [9, 2, 4, 6], [3, 8, 5, 1]];
const RANGES = [3, 4, 5, 2, 6];
const SUMS = [[4, 5, 6], [7, 8, 9], [5, 6, 8], [6, 7, 5], [3, 9, 8]];
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const PROBES: Record<string, (i: number) => StoredProbe> = {
  'variables-assignment': (i) => {
    const [a, b] = WORDS[i];
    const code = `a = '${a}'\nb = a\na = '${b}'\nprint(b)`;
    return probe(`va#${i}`, `va:${i}`, code, printed(pyStr(a)), { id: 'assignment-links-names', code: code.replace('print(b)', 'print(a)'), output: printed(pyStr(b)), line: 4 });
  },
  'list-indexing': (i) => {
    const [a, b, c] = WORDS[i];
    const code = `xs = ['${a}', '${b}', '${c}']\nprint(xs[1])`;
    return probe(`li#${i}`, `li:${i}`, code, printed(pyStr(b)), { id: 'index-starts-at-one', code: code.replace('xs[1]', 'xs[0]'), output: printed(pyStr(a)), line: 2 });
  },
  'list-slicing': (i) => {
    const xs = SLICES[i];
    const code = `xs = [${xs.join(', ')}]\nprint(xs[1:3])`;
    return probe(`ls#${i}`, `ls:${i}`, code, printed(pyList(xs.slice(1, 3))), { id: 'slice-end-included', code: code.replace('xs[1:3]', 'xs[1:4]'), output: printed(pyList(xs.slice(1, 4))), line: 2 });
  },
  'for-range-bounds': (i) => {
    const n = RANGES[i];
    const code = `xs = []\nfor i in range(${n}):\n    xs.append(i)\nprint(xs)`;
    return probe(`fr#${i}`, `fr:${i}`, code, printed(pyList(range(n))), { id: 'range-includes-end', code: code.replace(`range(${n})`, `range(${n} + 1)`), output: printed(pyList(range(n + 1))), line: 2 });
  },
  'loop-accumulator': (i) => {
    const xs = SUMS[i];
    const code = `total = 0\nfor x in [${xs.join(', ')}]:\n    total += x\nprint(total)`;
    const sum = xs.reduce((a, b) => a + b, 0);
    return probe(`la#${i}`, `la:${i}`, code, printed(pyInt(sum)), { id: 'assign-instead-of-add', code: code.replace('total += x', 'total = x'), output: printed(pyInt(xs[2])), line: 3 });
  },
};

const COMPLETIONS: Record<string, { code: string; fill: string; pass: string }> = {
  'variables-assignment': { code: 'def swap(a, b):\n    return [[1]]', fill: 'b, a', pass: 'return b, a' },
  'list-indexing': { code: 'def second(xs):\n    return [[1]]', fill: 'xs[1]', pass: 'return xs[1]' },
  'list-slicing': { code: 'def middle(xs):\n    return [[1]]', fill: 'xs[1:-1]', pass: 'return xs[1:-1]' },
  'for-range-bounds': { code: 'def count_to(n):\n    out = []\n    for i in range([[1]]):\n        out.append(i)\n    return out', fill: 'n', pass: 'range(n)' },
  'loop-accumulator': { code: 'def total(xs):\n    t = 0\n    for x in xs:\n        t [[1]] x\n    return t', fill: '+=', pass: 't += x' },
};

function completion(tag: string): StoredCompletion {
  const c = COMPLETIONS[tag];
  return {
    id: `${tag}#c`, group: `${tag}:c`, code: c.code, solutions: [c.fill], wrongFills: [], parSec: 25, stats: stats(),
    harness: "check(True, 'one')\ncheck(True, 'two')",
  };
}

function pattern(tag: string): AtomPattern {
  const t = TAXONOMY[tag];
  return {
    kind: t.kind, name: t.patternName, useWhen: 'it fits', template: '', rule: '', howItRuns: '', pitfall: '',
    useCases: [1, 2, 3, 4, 5, 6].map((k) => `${tag} use ${k}`),
  };
}

function atom(tag: string): StoredAtom {
  return {
    key: tag, lang: 'python', conceptId: tag, tag, source: 'seed', verified: true, createdAt: T0, pattern: pattern(tag),
    probes: [0, 1, 2, 3, 4].map((i) => PROBES[tag](i)), examples: [], completions: [completion(tag)], contrasts: [], tracebacks: [],
  };
}

/** A project concept with a model pack (tag 'other'): joins as a candidate when the plan lands. */
function parseRowAtom(): StoredAtom {
  const mk = (i: number): StoredProbe => {
    const code = `row = 'a,b,${WORDS[i][0]}'\nparts = row.split(',')\nprint(parts[2])`;
    return { id: `pr#${i}`, group: `pr:${i}`, code, output: printed(pyStr(WORDS[i][0])), parSec: 5, answerSpaceG: 0.06, constructs: [], discriminating: false, mutants: [], stats: stats() };
  };
  return {
    key: 'parse-row', lang: 'python', conceptId: 'parse-row', tag: 'other', source: 'model', verified: true, createdAt: T0,
    pattern: { ...pattern('string-split-join'), name: 'Parse a row' }, probes: [0, 1, 2, 3].map(mk), examples: [], completions: [], contrasts: [], tracebacks: [],
  };
}

class FakeRunner implements Runner {
  readonly runtime: Runtime = { lang: 'python', exe: 'python', snippetArgv: [], learnerArgv: [], version: 'test' };
  runs = 0;
  async runBatch(items: BatchItem[]): Promise<BatchRecord[]> {
    return items.map((it) => {
      this.runs++;
      const ok = Object.values(COMPLETIONS).some((c) => it.code.includes(c.pass));
      const rec: BatchRecord = { id: it.id, stdout: '', values: [], exitOk: ok, timedOut: false, ms: 20, constructs: [] };
      if (!ok) {
        rec.exception = 'CheckFailed';
        rec.error = 'Traceback (most recent call last):\n  File "<snippet>", line 4, in <module>\nCheckFailed: CHECK two';
      }
      return rec;
    });
  }
  async runLearnerCode(): Promise<never> {
    throw new Error('not used');
  }
}

/** The real Stock read side over a hand-built cache; placement candidates limited to TAGS. */
class TestStock extends Stock {
  poked: string[] = [];
  constructor(cache: AtomCache, private readonly tags: string[], runner: () => Runner | undefined) {
    super({ lang: 'python', cache, runner, readFile: async () => Promise.reject(new Error('no seed banks in this test')) });
  }
  override placementTags(): string[] {
    return [...this.tags];
  }
  override refillIfLow(key: string): Promise<void> | undefined {
    this.poked.push(key);
    return undefined;
  }
}

function setup(o: { runner?: Runner | null; lock?: InteractionLock } = {}) {
  const clock = new ManualClock(T0);
  const editor = new MemoryPadEditor();
  const ui = new ScriptedPadUi();
  const l: Learner = emptyLearner();
  const cache = new AtomCache('python', undefined, { debounceMs: -1, now: () => clock.now() });
  for (const tag of TAGS) cache.put(atom(tag));
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
  const stock = new TestStock(cache, TAGS, () => runner);
  const placement = new PlacementRun(pad, stock);
  return { clock, editor, ui, l, cache, runner, evs, logs, pad, stock, placement };
}

type Setup = ReturnType<typeof setup>;

const allProbes = (t: Setup) => t.cache.keys().flatMap((k) => t.cache.get(k)!.probes.map((p) => ({ key: k, p })));

type PredictMove = 'right' | 'mutant' | 'wrong' | '?';

interface Policy {
  predict?: (key: string, p: StoredProbe, n: number) => PredictMove;
  completion?: (tag: string) => 'right' | 'wrong';
  predictMs?: number;
  completionMs?: number;
  typing?: (literal: string) => string;
  /** Called on every screen; return 'stop' to leave the bot loop (the caller then acts). */
  onScreen?: (s: Screen, k: number) => 'stop' | void;
}

interface Screen {
  kind: 'typing' | 'predict' | 'completion' | 'other';
  render: PadRender;
  doc: string;
  key?: string;
  probe?: StoredProbe;
  tag?: string;
  /** When the screen appeared (the session's shownAt). */
  at: number;
}

/** Plays the learner on whatever the pad shows until the run ends (or onScreen says stop). */
async function play(t: Setup, run: Promise<unknown>, policy: Policy = {}): Promise<Screen[]> {
  const ended = run.then(() => 'ended' as const, () => 'ended' as const);
  const screens: Screen[] = [];
  for (let k = 0; k < 80; k++) {
    const r = await Promise.race([t.pad.whenAwaiting(), ended]);
    if (r === 'ended') return screens;
    assert.ok(r, 'something is on screen');
    const doc = t.editor.doc;
    const at = t.pad.session!.shownAt;
    let s: Screen;
    if (doc.startsWith('# copy this exactly')) s = { kind: 'typing', render: r, doc, at };
    else if (r.snippet) {
      const tag = Object.keys(COMPLETIONS).find((x) => doc.includes(COMPLETIONS[x].code.split('\n')[0]));
      s = { kind: 'completion', render: r, doc, tag, at };
    } else {
      const hit = allProbes(t).find((x) => doc.includes(x.p.code));
      s = hit ? { kind: 'predict', render: r, doc, key: hit.key, probe: hit.p, at } : { kind: 'other', render: r, doc, at };
    }
    screens.push(s);
    if (policy.onScreen?.(s, k) === 'stop') return screens;
    switch (s.kind) {
      case 'typing': {
        const literal = doc.split('\n')[1];
        t.editor.answer(policy.typing ? policy.typing(literal) : literal);
        t.clock.advance(5000);
        break;
      }
      case 'completion': {
        const move = policy.completion?.(s.tag!) ?? 'right';
        t.editor.fill([move === 'right' ? COMPLETIONS[s.tag!].fill : 'None']);
        t.clock.advance(policy.completionMs ?? 15_000);
        break;
      }
      case 'predict': {
        const n = screens.filter((x) => x.kind === 'predict').length;
        const move = policy.predict?.(s.key!, s.probe!, n) ?? 'right';
        const p = s.probe!;
        const text = move === 'right' ? p.output.stdout.trim() : move === 'mutant' ? p.mutants[0].output.stdout.trim() : move === 'wrong' ? 'zzz' : '?';
        t.editor.answer(text);
        t.clock.advance(policy.predictMs ?? 5000);
        break;
      }
      default:
        assert.fail(`unexpected screen:\n${doc}`);
    }
    assert.ok(t.pad.submit(), 'the submit is taken');
  }
  assert.fail('placement did not end');
}

const run = (t: Setup, opts: PlacementRunOptions = {}) => t.placement.run({ tickPicker: false, ...opts });

// ---------------------------------------------------------------- tests

describe('PlacementRun', () => {
  test('tick picker priors, the typing item first, generic predict headers, the last 2 completions, summary and card', async () => {
    const t = setup();
    t.ui.pickManyAnswers = [[0, 1, 2, 3]];
    const p = t.placement.run({ planPending: () => false, needed: () => [] });
    // Answers slower than par_self, so the experienced fast lane stays shut.
    const screens = await play(t, p, { predictMs: 13_000 });
    const res = await p;

    // The optional prior: most-depended-on first; ticked P .7 'used', unticked P .2 'not-used'.
    assert.equal(t.ui.manyCalls.length, 1);
    const pick = t.ui.manyCalls[0];
    assert.equal(pick.title, TICK_PICKER.title);
    assert.ok(pick.items.length <= TICK_PICKER.max && pick.items.length === TAGS.length);
    assert.equal(pick.items[0].label, TAXONOMY['variables-assignment'].patternName, 'the root of the DAG first');
    assert.ok(pick.items.every((it) => it.detail && it.detail.length > 0), 'each with a one-line example');
    const unticked = TAGS.find((tag) => TAXONOMY[tag].patternName === pick.items[4].label)!;
    assert.equal(t.l.concepts[unticked].selfRating, 'not-used');
    assert.equal(t.l.concepts[unticked].mastery, TICK_PICKER.unusedP, 'unticked and never asked (already classified as new)');
    assert.ok(!screens.some((s) => s.key === unticked));
    for (const tag of TAGS.filter((x) => x !== unticked)) assert.equal(t.l.concepts[tag].selfRating, 'used', tag);
    assert.equal(res.selfRated, true);

    // Item 1: typing calibration, not scored.
    assert.equal(screens[0].kind, 'typing');
    assert.equal(res.calibrated, true);
    assert.ok(Math.abs(t.l.cps - screens[0].doc.split('\n')[1].length / 5) < 1e-9, 'cps from the copy');

    // Predicts: generic header, never the concept; evidence source 'placement'.
    const predicts = screens.filter((s) => s.kind === 'predict');
    assert.ok(predicts.length >= 4, `${res.reason}: ${screens.map((s) => s.key ?? s.tag ?? s.kind).join(', ')}`);
    for (const s of predicts) {
      assert.equal(s.doc.split('\n')[0], '# what does this print?');
      assert.ok(!TAGS.some((tag) => s.doc.includes(TAXONOMY[tag].patternName)), 'the concept is never named');
    }
    assert.ok(t.evs.length > 0 && t.evs.every((e) => e.source === 'placement'));
    assert.equal(t.evs.filter((e) => e.kind === 'predict').length, predicts.length, 'one record per predict; none for typing');

    // The last 2 items are completions on concepts at P >= .7, graded by running them.
    const graded = screens.filter((s) => s.kind !== 'typing');
    assert.deepEqual(graded.slice(-2).map((s) => s.kind), ['completion', 'completion']);
    const prod = t.evs.filter((e) => e.kind === 'completion');
    assert.equal(prod.length, 2);
    assert.ok(prod.every((e) => e.correct === true && e.production === true));
    assert.equal((t.runner as FakeRunner).runs, 2);

    // Stop, summary, flash, card, pad closed.
    assert.ok(['classified', 'max-items'].includes(res.reason), res.reason);
    assert.equal(res.summary.items, graded.length);
    assert.match(res.summary.text, /^Placement: \d+ items, /);
    assert.deepEqual(t.ui.flashes, [res.summary.flash]);
    assert.equal(t.logs.length, 1);
    assert.equal(t.logs[0].kind, 'placement');
    assert.deepEqual(t.logs[0].lines, [res.summary.text]);
    assert.equal(t.editor.isOpen, false);
    assert.equal(t.pad.busy, false);
    assert.ok(res.state.items.length <= PLACEMENT.maxItems);
    for (const s of graded) {
      const id = s.probe?.id ?? `${s.tag}#c`;
      assert.ok(t.cache.seenIds(s.key ?? s.tag!).includes(id), `${id} is marked seen`);
    }
  });

  test('feedback stays 600 ms after a right answer and 1.5 s after a wrong one', async () => {
    const t = setup();
    const p = run(t);
    const submits: { at: number; move: PredictMove }[] = [];
    const screens = await play(t, p, {
      predict: (_k, _p, n) => {
        const move = n % 2 ? 'right' : 'wrong';
        submits.push({ at: t.clock.now() + 5000, move });
        return move;
      },
      onScreen: (_s, k) => (k >= 5 ? 'stop' : undefined),
    });
    t.pad.leave();
    await p;
    const predictScreens = screens.filter((s) => s.kind === 'predict' || s.kind === 'completion');
    for (let i = 0; i + 1 < submits.length && i + 1 < predictScreens.length; i++) {
      const gap = predictScreens[i + 1].at - submits[i].at;
      assert.equal(gap, submits[i].move === 'right' ? PAD.hold.correct : PAD.hold.other, `item ${i}: ${submits[i].move}`);
    }
    assert.ok(t.editor.history.length > 0);
  });

  test('a mutant match records a candidate misconception (odds x3, curated) and never asks y/n', async () => {
    const t = setup();
    const p = run(t);
    let matched: StoredProbe | undefined;
    let tag = '';
    const screens = await play(t, p, {
      predict: (key, probe) => {
        if (!matched) {
          matched = probe;
          tag = key;
          return 'mutant';
        }
        return 'right';
      },
    });
    await p;
    assert.ok(screens.every((s) => s.render.await !== 'yn'), 'no belief check in placement');
    const e = t.evs.find((x) => x.itemId === matched!.id)!;
    assert.equal(e.correct, false);
    assert.equal(e.misconceptionId, matched!.mutants[0].misconceptionId);
    assert.equal(e.misconceptionOdds, 3);
    assert.equal(e.beliefConfirmed, undefined);
    const m = t.l.concepts[tag].misconceptions[matched!.mutants[0].misconceptionId];
    assert.ok(m, 'the learner model holds the misconception');
    assert.equal(m.status, 'candidate');
    assert.equal(t.cache.get(tag)!.probes.find((x) => x.id === matched!.id)!.mutants[0].matches, 1, 'the cache counted the match');
  });

  test('double Esc ends placement as esc and keeps the evidence; slower presses do not', async () => {
    const t = setup();
    const p = run(t);
    await play(t, p, { onScreen: (_s, k) => (k === 3 ? 'stop' : undefined) });
    t.pad.escape();
    t.clock.advance(800);
    t.pad.escape();
    await t.pad.whenAwaiting();
    assert.equal(t.pad.busy, true, '800 ms apart: still running');
    t.clock.advance(300);
    t.pad.escape();
    const res = await p;
    assert.equal(res.reason, 'esc');
    assert.equal(res.state.esc, true);
    assert.equal(t.evs.length, 2, 'the two answered predicts are kept');
    assert.equal(t.logs.length, 1, 'Esc still finishes with a card');
    assert.equal(t.editor.isOpen, false);
  });

  test('Leave practice and a closed tab end as esc; the InteractionLock abort ends silently as aborted', async () => {
    const t = setup();
    const p = run(t);
    await play(t, p, { onScreen: (_s, k) => (k === 2 ? 'stop' : undefined) });
    t.pad.leave();
    assert.equal((await p).reason, 'esc');

    const t2 = setup();
    const p2 = run(t2);
    await play(t2, p2, { onScreen: (_s, k) => (k === 1 ? 'stop' : undefined) });
    t2.editor.closeTab();
    assert.equal((await p2).reason, 'esc');

    const lock = new InteractionLock(() => Date.now());
    const t3 = setup({ lock });
    const release = t3.pad.acquire('placement')!;
    const p3 = run(t3);
    await play(t3, p3, { onScreen: (_s, k) => (k === 2 ? 'stop' : undefined) });
    assert.equal(lock.abortActive()?.reason, 'esc');
    const r3 = await p3;
    release();
    assert.equal(r3.reason, 'aborted');
    assert.equal(t3.logs.length, 0, 'no card');
    assert.deepEqual(t3.ui.flashes, [], 'no flash');
    assert.equal(t3.evs.length, 1, 'evidence so far is kept');
    assert.equal(lock.held, false);
  });

  test('Leave practice while the tick picker is open ends placement before any item', async () => {
    const t = setup();
    let resolvePick!: (v: number[] | undefined) => void;
    t.ui.pickMany = async (o) => {
      t.ui.manyCalls.push(o);
      return new Promise<number[] | undefined>((r) => {
        resolvePick = r;
        o.signal?.addEventListener('abort', () => r(undefined));
      });
    };
    const p = t.placement.run({});
    await new Promise((r) => setImmediate(r));
    assert.equal(t.ui.manyCalls.length, 1);
    t.pad.leave();
    const res = await p;
    assert.equal(res.reason, 'esc');
    assert.equal(res.selfRated, false);
    assert.equal(res.state.items.length, 0);
    assert.equal(t.editor.opens, 0, 'the pad never opened');
    resolvePick([0]);
  });

  test('Esc on the tick picker leaves priors at .3', async () => {
    const t = setup();
    t.ui.pickManyAnswers = [undefined];
    const p = t.placement.run({});
    await play(t, p, { onScreen: (s) => (s.kind === 'typing' ? 'stop' : undefined) });
    t.pad.leave();
    const res = await p;
    assert.equal(res.selfRated, false);
    for (const tag of TAGS) {
      assert.equal(t.l.concepts[tag].mastery, 0.3, tag);
      assert.equal(t.l.concepts[tag].selfRating, undefined);
    }
  });

  test('typing calibration measures speed only on a faithful copy', async () => {
    assert.equal(isFaithfulCopy("[3,'a',True]", "[3, 'a', True]"), true);
    assert.equal(isFaithfulCopy('[3, "a", True]', "[3, 'a', True]"), true);
    assert.equal(isFaithfulCopy('asdf', "[3, 'a', True]"), false);
    const t = setup();
    const before = t.l.cps;
    const p = run(t);
    await play(t, p, { typing: () => 'whatever', onScreen: (s) => (s.kind === 'predict' ? 'stop' : undefined) });
    t.pad.leave();
    const res = await p;
    assert.equal(t.l.cps, before, 'cps unchanged');
    assert.equal(res.calibrated, true, 'placement still moves on');
    assert.equal(t.evs.length, 0, 'typing is never scored');
  });

  test('plan pending: up to 5 harder items labelled roadmap almost ready, then plan-pending', async () => {
    const t = setup();
    const p = t.placement.run({ tickPicker: false, planPending: () => true });
    const screens = await play(t, p);
    const res = await p;
    assert.equal(res.reason, 'plan-pending');
    const extras = res.state.items.filter((r) => r.extra);
    assert.equal(extras.length, PLACEMENT.extraItems);
    const labelled = screens.filter((s) => s.doc.startsWith('# what does this print?   (roadmap almost ready)'));
    assert.equal(labelled.length, PLACEMENT.extraItems);
    assert.ok(labelled.every((s) => s.kind === 'predict'));
    // The extras come after the regular items (completions included).
    const firstExtra = screens.indexOf(labelled[0]);
    assert.ok(screens.slice(0, firstExtra).some((s) => s.kind === 'completion'));
    assert.ok(screens.slice(firstExtra).every((s) => s.kind === 'predict'));
  });

  test('plan concepts join as candidates mid-run (addCandidates)', async () => {
    const t = setup();
    let pending = true;
    let needed: string[] = [];
    const p = t.placement.run({ tickPicker: false, planPending: () => pending, needed: () => needed });
    let landed = false;
    const screens = await play(t, p, {
      onScreen: (s) => {
        if (s.kind === 'predict' && !landed) {
          // PlanOutline lands while the first predict is open.
          landed = true;
          upsertConcepts(t.l, [{ id: 'parse-row', name: 'Parse a row', tag: 'other', prerequisites: ['list-indexing'] }], t.clock.now());
          t.cache.put(parseRowAtom());
          t.placement.addCandidates(['parse-row']);
          pending = false;
          needed = ['parse-row', 'list-indexing'];
        }
      },
    });
    const res = await p;
    const rows = screens.filter((s) => s.key === 'parse-row');
    assert.ok(rows.length >= 1, 'a project-concept item was asked');
    assert.ok(t.evs.some((e) => e.conceptId === 'parse-row' && e.source === 'placement'));
    assert.notEqual(res.reason, 'plan-pending');
    assert.ok(res.state.items.every((r) => !r.extra), 'no extras once the plan landed');
  });

  test('the experienced fast lane: 3 correct leaf items under par, one a completion, end placement', async () => {
    const t = setup();
    t.ui.pickManyAnswers = [TAGS.map((_, i) => i)];
    const p = t.placement.run({ planPending: () => false });
    const screens = await play(t, p, { predictMs: 4000, completionMs: 12_000 });
    const res = await p;
    assert.equal(res.reason, 'fast-lane');
    const graded = screens.filter((s) => s.kind !== 'typing');
    assert.equal(graded.length, 3);
    assert.deepEqual(graded.map((s) => s.kind), ['predict', 'predict', 'completion']);
    const leaves = new Set(['list-slicing', 'loop-accumulator']);
    assert.ok(graded.every((s) => leaves.has(s.key ?? s.tag!)), 'deepest ticked leaves first');
  });

  test('without a runner there are no completion items', async () => {
    const t = setup({ runner: null });
    const p = run(t);
    const screens = await play(t, p);
    await p;
    assert.ok(screens.length > 1);
    assert.ok(screens.every((s) => s.kind !== 'completion'));
    assert.ok(t.evs.every((e) => e.kind === 'predict'));
  });

  test('a placement runs once, and not while another flow holds the pad', async () => {
    const t = setup();
    const p = run(t);
    await play(t, p, { onScreen: () => 'stop' });
    await assert.rejects(new PlacementRun(t.pad, t.stock).run({ tickPicker: false }), /is running/);
    t.pad.leave();
    await p;
    await assert.rejects(t.placement.run({ tickPicker: false }), /runs once/);
  });
});
