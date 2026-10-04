import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Action } from '../src/contracts';
import type { JobStats } from '../src/jobs';
import { PUSH_BACK_MS, status } from '../src/tempo';
import {
  OPEN_GUARD_MS,
  POP_HIGHLIGHT_MS,
  TempoController,
  actionLinks,
  actionText,
  withActionLinks,
  type TempoRender,
  type TempoState,
  type TempoView,
} from '../src/tempoBar';

const SEC = 1000;
const MIN = 60 * SEC;
const T = 50_000_000;

class FakeView implements TempoView {
  renders: TempoRender[] = [];
  flashes: { text: string; ms: number }[] = [];
  ctx: Record<string, boolean> = {};
  executed: { command: string; args: readonly unknown[] }[] = [];
  /** Pending command promises (resolved by finish()). */
  private waiting: (() => void)[] = [];
  holdCommands = false;
  render(r: TempoRender): void {
    this.renders.push(r);
  }
  flash(text: string, ms: number): void {
    this.flashes.push({ text, ms });
  }
  setContext(key: string, value: boolean): void {
    this.ctx[key] = value;
  }
  execute(command: string, args: readonly unknown[]): Promise<unknown> {
    this.executed.push({ command, args });
    if (!this.holdCommands) return Promise.resolve();
    return new Promise((resolve) => this.waiting.push(() => resolve(undefined)));
  }
  finish(): void {
    for (const w of this.waiting.splice(0)) w();
  }
  get last(): TempoRender {
    return this.renders[this.renders.length - 1];
  }
}

interface Harness {
  ctl: TempoController;
  view: FakeView;
  st: TempoState;
  clock: { now: number };
  lock: { held: boolean };
  focus: { on: boolean };
  timers: { fn: () => void; ms: number }[];
  stats: JobStats;
  timersOn: { show: boolean };
}

function harness(over: Partial<TempoState> = {}): Harness {
  const clock = { now: T };
  const lock = { held: false };
  const focus = { on: true };
  const timersOn = { show: true };
  const timers: { fn: () => void; ms: number }[] = [];
  const view = new FakeView();
  const st: TempoState = { phase: 'building', stuckScore: 0, lastEditAt: T - 10 * SEC, activeMsToday: 30 * MIN, sprintMsToday: 0, ...over };
  const stats: JobStats = { fgQueued: 0, running: 2, queued: 1, runningLabels: [], used: 7, limit: 20, hintUsed: 0, hintLimit: 4, halved: false, deadlineMisses: 0 };
  const ctl = new TempoController({
    state: () => st,
    view,
    now: () => clock.now,
    jobs: { stats: () => stats },
    lockHeld: () => lock.held,
    showTimers: () => timersOn.show,
    focused: () => focus.on,
    platform: 'win32',
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
  });
  return { ctl, view, st, clock, lock, focus, timers, stats, timersOn };
}

function act(over: Partial<Action> & Pick<Action, 'kind'>): Omit<Action, 'id' | 'createdAt'> {
  return { label: `${over.kind} label`, priority: 1, blocking: false, command: `deliberate.${over.kind}`, ...over };
}

const flush = () => new Promise((r) => setImmediate(r));

test('blocking actions the learner started open at once when the lock is free', async () => {
  const h = harness();
  h.ctl.enqueue(act({ kind: 'atom', blocking: true, priority: 0, command: 'deliberate.runAtom', args: ['list-slicing'] }));
  assert.deepEqual(h.view.executed, [{ command: 'deliberate.runAtom', args: ['list-slicing'] }]);
  assert.equal(h.ctl.queue.length, 0, 'opened actions leave the queue');
  assert.equal(h.view.flashes.length, 0, 'an open is not a pop');
  await flush();
});

test('while the lock is held a blocking action waits at the head; the release opens it', () => {
  const h = harness();
  h.lock.held = true;
  h.ctl.enqueue(act({ kind: 'gate', blocking: true, label: '$(checklist) plan the next task' }));
  assert.equal(h.view.executed.length, 0);
  assert.equal(h.view.last.text, '$(checklist) plan the next task');
  assert.equal(h.view.ctx['deliberate.hasAction'], true);
  h.lock.held = false;
  h.ctl.lockReleased();
  assert.equal(h.view.executed[0]?.command, 'deliberate.gate');
  assert.equal(h.ctl.queue.length, 0);
});

test('an offer pops only at a real pause: warning background plus a flash, 30 s apart, never mid-typing', () => {
  const h = harness();
  const label = status.hintReady('src/cli.py', 14);
  h.ctl.enqueue(act({ kind: 'hint-ready', label, command: 'deliberate.hint' }));
  assert.equal(h.view.last.text, '$(lightbulb) hint ready · cli.py:14');
  assert.equal(h.view.last.warning, false, 'no pause yet: shown without a pop');
  assert.equal(h.view.flashes.length, 0);

  // Typing burst: a manual save 2 s after the last edit is not a moment to pop.
  h.st.lastEditAt = h.clock.now - 2 * SEC;
  h.ctl.notePause('manual-save');
  assert.equal(h.view.flashes.length, 0);

  h.clock.now += 9 * SEC;
  h.ctl.notePause('manual-save');
  assert.equal(h.view.flashes.length, 1);
  assert.equal(h.view.flashes[0].text, label);
  assert.equal(h.view.last.warning, true);

  // A second offer right after: the 30 s spacing holds it back.
  h.ctl.enqueue(act({ kind: 'review-ready', label: 'review ready', priority: 0 }));
  h.clock.now += 5 * SEC;
  h.ctl.notePause('terminal-ok');
  assert.equal(h.view.flashes.length, 1);
  assert.equal(h.view.last.text, '$(comment-discussion) review ready', 'the higher priority shows in the text');

  // The warning background ends when its timer fires.
  assert.equal(h.timers.length, 1);
  assert.ok(h.timers[0].ms >= POP_HIGHLIGHT_MS);
  h.clock.now += POP_HIGHLIGHT_MS;
  h.timers[0].fn();
  assert.equal(h.view.last.warning, false);
});

test('nothing pops while the lock is held, nor while the window is unfocused', () => {
  const h = harness();
  h.ctl.enqueue(act({ kind: 'hint-ready' }));
  h.lock.held = true;
  h.ctl.notePause('idle');
  assert.equal(h.view.flashes.length, 0);
  h.lock.held = false;
  h.focus.on = false;
  h.ctl.notePause('idle');
  assert.equal(h.view.flashes.length, 0, 'unfocused: the pop is not spent');
  h.focus.on = true;
  h.clock.now += SEC;
  h.ctl.evaluate();
  assert.equal(h.view.flashes.length, 1, 'still inside the pause window once focus returns');
});

test('deliberate.next runs the current action, or opens the sidebar with nothing queued', async () => {
  const h = harness();
  await h.ctl.runNext();
  assert.deepEqual(h.view.executed, [{ command: 'deliberate.open', args: [] }]);
  const id = h.ctl.enqueue(act({ kind: 'own-predict', label: status.predictOwn('parse_args'), command: 'deliberate.predictOwn', args: ['cli.py', 'parse_args'] }));
  // own-predict shows only once allowed to pop: give it a pause.
  h.ctl.notePause('manual-save');
  assert.equal(h.ctl.shown?.id, id);
  await h.ctl.runNext();
  assert.deepEqual(h.view.executed[1], { command: 'deliberate.predictOwn', args: ['cli.py', 'parse_args'] });
  assert.equal(h.ctl.queue.length, 0);
  assert.equal(h.view.ctx['deliberate.hasAction'], false);
  // A status-only action without a command is just dismissed.
  h.ctl.enqueue(act({ kind: 'info', label: 'note', command: '' }));
  await h.ctl.runNext();
  assert.equal(h.view.executed.length, 2);
  assert.equal(h.ctl.queue.length, 0);
});

test('enqueue replaces the same action in place; remove takes an id or a kind', () => {
  const h = harness();
  const a = h.ctl.enqueue(act({ kind: 'specs-ready', label: status.specsReady(4), command: '' }));
  const b = h.ctl.enqueue(act({ kind: 'specs-ready', label: status.specsReady(5), command: '' }));
  assert.equal(a, b);
  assert.equal(h.ctl.queue.length, 1);
  assert.equal(h.view.last.text, '$(beaker) specs ready (5)');
  const c = h.ctl.enqueue({ ...act({ kind: 'jit-atom', label: status.jitOffer('dict counting'), command: 'deliberate.runAtom' }), id: 'jit:dict' });
  assert.equal(c, 'jit:dict');
  h.ctl.enqueue({ ...act({ kind: 'jit-atom', label: 'changed', command: 'deliberate.runAtom' }), id: 'jit:dict' });
  assert.equal(h.ctl.queue.length, 2);
  h.ctl.remove('jit:dict');
  assert.deepEqual(h.ctl.queue.map((x) => x.kind), ['specs-ready']);
  h.ctl.enqueue(act({ kind: 'what-if', args: [1] }));
  h.ctl.enqueue(act({ kind: 'what-if', args: [2] }));
  h.ctl.remove('what-if');
  assert.deepEqual(h.ctl.queue.map((x) => x.kind), ['specs-ready']);
});

test('Skip or Esc pushes the kind back 5 minutes; expired actions leave the queue', () => {
  const h = harness();
  h.ctl.enqueue(act({ kind: 'warmup', label: status.warmup(4) }));
  assert.equal(h.view.last.text, '$(zap) 4 due · 60s warm-up');
  h.ctl.skip('warmup');
  assert.notEqual(h.ctl.shown?.kind, 'warmup');
  h.clock.now += PUSH_BACK_MS + 1;
  h.ctl.evaluate();
  assert.equal(h.ctl.shown?.kind, 'warmup', 'back after 5 minutes');
  // A skipped blocking action is dropped.
  h.lock.held = true;
  h.ctl.enqueue(act({ kind: 'atom', blocking: true, priority: 0 }));
  h.ctl.skip('atom');
  assert.equal(h.ctl.queue.some((x) => x.kind === 'atom'), false);
  h.ctl.enqueue(act({ kind: 'info', label: 'soon gone', command: '', expiresAt: h.clock.now + SEC }));
  h.clock.now += 2 * SEC;
  h.ctl.evaluate();
  assert.equal(h.ctl.queue.some((x) => x.kind === 'info'), false);
});

test('sprints are only offered while building; a second blocking action waits for the first flow', () => {
  const h = harness();
  h.ctl.enqueue(act({ kind: 'sprint', blocking: true, label: '$(zap) 60s sprint while you wait' }));
  assert.equal(h.view.executed.length, 0, 'no auto-open while building');
  h.view.holdCommands = true;
  h.ctl.enqueue(act({ kind: 'atom', blocking: true, priority: 0, command: 'deliberate.runAtom' }));
  h.ctl.enqueue(act({ kind: 'gate', blocking: true, priority: 0, command: 'deliberate.gate' }));
  assert.deepEqual(h.view.executed.map((e) => e.command), ['deliberate.runAtom'], 'the guard holds the gate until the atom takes the lock');
  h.lock.held = true; // the atom flow took the lock
  h.clock.now += OPEN_GUARD_MS + 1;
  h.ctl.evaluate();
  assert.equal(h.view.executed.length, 1);
  h.lock.held = false;
  h.ctl.lockReleased();
  assert.deepEqual(h.view.executed.map((e) => e.command), ['deliberate.runAtom', 'deliberate.gate']);
});

test('status and tooltip: task timer, busy job, idle text, jobs line, calibration, streak behind showTimers', () => {
  const h = harness({ task: { title: 'Parse the flags', activeMin: 12.6, estimateMin: 30 }, stuckScore: 0.42, progressReason: 'spec 2 green', calibration: 0.88, streak: 3 });
  h.ctl.evaluate();
  assert.equal(h.view.last.text, '$(mortar-board) 12/30m · Parse the flags');
  const tip = h.view.last.tooltip;
  assert.match(tip, /\*\*Parse the flags\*\* · 12\/30 min/);
  assert.match(tip, /Stuck meter 42% · last progress: spec 2 green/);
  assert.match(tip, /Background: running 2 · queued 1 · 7\/20 this hour/);
  assert.match(tip, /Calibration 88%/);
  assert.match(tip, /Streak: 3 correct under par/);
  assert.match(tip, /click this item instead/);
  h.timersOn.show = false;
  h.ctl.refresh();
  assert.equal(h.view.last.text, '$(mortar-board) Parse the flags');
  assert.doesNotMatch(h.view.last.tooltip, /Streak/);
  h.st.idleText = status.specProgress(3, 5, 'flag takes value');
  h.ctl.refresh();
  assert.equal(h.view.last.text, '$(beaker) 3/5 · next: flag takes value');
  h.stats.fg = 'Reviewing your work';
  h.ctl.refresh();
  assert.equal(h.view.last.text, '$(sync~spin) Reviewing your work');
  assert.equal(h.view.ctx['deliberate.building'], true);
  h.st.phase = 'explain';
  h.ctl.evaluate();
  assert.equal(h.view.ctx['deliberate.building'], false);
  const none = harness({ phase: 'idle' });
  none.ctl.evaluate();
  assert.equal(none.view.last.text, '$(mortar-board) Deliberate');
});

test('Not now skips the shown action (neutral, reported once) and the tooltip links run or skip it', () => {
  const h = harness();
  const skipped: string[] = [];
  h.ctl.onDidSkip((a) => skipped.push(a.id));
  assert.equal(h.ctl.skipCurrent(), undefined, 'nothing shown: nothing skipped');
  assert.doesNotMatch(h.view.last.tooltip, /command:deliberate\.skipAction/, 'no links without an action');
  const id = h.ctl.enqueue({ ...act({ kind: 'jit-atom', label: status.jitOffer('dict counting'), command: 'deliberate.runAtom' }), id: 'jit:dict' });
  const tip = h.view.last.tooltip.split('\n\n');
  const next = tip.findIndex((p) => p.startsWith('Next: '));
  assert.ok(next >= 0);
  assert.equal(tip[next + 1], '[Do it (Alt+N)](command:deliberate.next) · [Not now](command:deliberate.skipAction)');
  assert.equal(h.ctl.skipCurrent()?.id, id);
  assert.deepEqual(skipped, ['jit:dict']);
  const shownId = () => h.ctl.shown?.id;
  assert.equal(shownId(), undefined, 'pushed back for 5 minutes');
  assert.equal(h.view.ctx['deliberate.hasAction'], false);
  h.clock.now += PUSH_BACK_MS + 1;
  h.ctl.evaluate();
  assert.equal(shownId(), id, 'a non-blocking offer comes back after the push-back');
  assert.match(withActionLinks('a\n\nb'), /^\[Do it/, 'without a Next paragraph the links go first');
  assert.equal(actionLinks('darwin'), '[Do it (Ctrl+Alt+N)](command:deliberate.next) · [Not now](command:deliberate.skipAction)');
});

test('action text keeps its icon and fits 40 characters', () => {
  assert.equal(actionText({ kind: 'hint-ready', label: 'hint ready' }), '$(lightbulb) hint ready');
  assert.equal(actionText({ kind: 'info', label: '$(check) slicing: fragile -> solid' }), '$(check) slicing: fragile -> solid');
  const long = actionText({ kind: 'sprint', label: 'a sprint label that is far too long to fit in forty characters' });
  assert.ok([...long.replace(/^\$\([^)]+\) /, '')].length <= 40);
});
