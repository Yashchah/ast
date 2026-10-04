import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Action, ActionKind, PauseKind } from '../src/contracts';
import {
  PUSH_BACK_MS,
  STATUS_MAX,
  TempoInput,
  clip,
  decide,
  pushBack,
  savePause,
  status,
  statusText,
  tempoTooltip,
} from '../src/tempo';

const SEC = 1000;
const MIN = 60 * SEC;
const T = 50_000_000;

/** A quiet moment right after a manual clean save: everything allows a pop. */
function input(over: Partial<TempoInput> = {}): TempoInput {
  return {
    now: T,
    actions: [],
    lastEditAt: T - 10 * SEC,
    lastPopAt: T - 5 * MIN,
    lastPause: { kind: 'manual-save', at: T - 5 * SEC },
    stuckScore: 0,
    sprintMsToday: 0,
    activeMsToday: 30 * MIN,
    lockHeld: false,
    phase: 'building',
    ...over,
  };
}

function action(kind: ActionKind, over: Partial<Action> = {}): Action {
  return {
    id: `${kind}-1`,
    kind,
    label: `$(zap) ${kind}`,
    priority: 1,
    blocking: false,
    command: `deliberate.${kind}`,
    createdAt: T - MIN,
    ...over,
  };
}

/** Text width without the leading $(icon). */
function textLen(s: string): number {
  return [...s.replace(/^\$\([^)]*\) /, '')].length;
}

test('a quiet moment after a manual save pops the head action', () => {
  const d = decide(input({ actions: [action('hint-ready')] }));
  assert.equal(d.action?.kind, 'hint-ready');
  assert.equal(d.pop, true);
  assert.equal(d.open, false);
});

test('no pop during a typing burst; the action still shows', () => {
  const a = action('review-ready');
  for (const ago of [0, 2 * SEC, 5 * SEC, 7.9 * SEC]) {
    const d = decide(input({ actions: [a], lastEditAt: T - ago }));
    assert.equal(d.action, a);
    assert.equal(d.pop, false, `edit ${ago / SEC}s ago`);
  }
  assert.equal(decide(input({ actions: [a], lastEditAt: T - 8 * SEC })).pop, true);
});

test('auto-saves are not pauses', () => {
  const a = action('hint-ready');
  // The monitor never turns an auto-save into a pause...
  assert.equal(savePause(2, 0), undefined, 'AfterDelay');
  assert.equal(savePause(3, 0), undefined, 'FocusOut');
  assert.equal(savePause(1, 2), undefined, 'manual save with errors');
  assert.equal(savePause(1, 0), 'manual-save');
  // ...and decide() ignores anything that is not a qualifying pause.
  const autoSave = { kind: 'auto-save' as PauseKind, at: T - 2 * SEC };
  assert.equal(decide(input({ actions: [a], lastPause: autoSave })).pop, false);
  assert.equal(decide(input({ actions: [a], lastPause: undefined })).pop, false);
  for (const kind of ['manual-save', 'spec-green', 'terminal-ok', 'idle'] as PauseKind[]) {
    assert.equal(decide(input({ actions: [a], lastPause: { kind, at: T - 2 * SEC } })).pop, true, kind);
  }
});

test('the pause must be within the last 20 s', () => {
  const a = action('hint-ready');
  assert.equal(decide(input({ actions: [a], lastPause: { kind: 'idle', at: T - 20 * SEC } })).pop, true);
  assert.equal(decide(input({ actions: [a], lastPause: { kind: 'idle', at: T - 21 * SEC } })).pop, false);
});

test('30 s spacing between pops', () => {
  const a = action('hint-ready', { createdAt: T - 5 * SEC });
  assert.equal(decide(input({ actions: [a], lastPopAt: T - 29 * SEC })).pop, false);
  assert.equal(decide(input({ actions: [a], lastPopAt: T - 30 * SEC })).pop, true);
});

test('nothing pops while the lock is held', () => {
  const offer = action('what-if');
  const d = decide(input({ actions: [offer], lockHeld: true }));
  assert.equal(d.action, offer, 'still the status text');
  assert.equal(d.pop, false);
  assert.equal(d.open, false);
});

test('blocking actions open immediately when the lock is free, else wait at the head', () => {
  const atom = action('atom', { blocking: true, priority: 3, createdAt: T });
  const hint = action('hint-ready', { priority: 0 });
  // Even mid-typing and with no pause: the learner started it.
  const free = decide(input({ actions: [hint, atom], lastEditAt: T, lastPause: undefined }));
  assert.equal(free.action, atom);
  assert.equal(free.open, true);
  assert.equal(free.pop, false);
  const held = decide(input({ actions: [hint, atom], lockHeld: true }));
  assert.equal(held.action, atom, 'waits at the head of the queue');
  assert.equal(held.open, false);
  assert.equal(held.pop, false);
});

test('15% sprint cap stops sprint and warm-up offers', () => {
  const sprint = action('sprint');
  const warmup = action('warmup', { id: 'w' });
  const under = input({ actions: [sprint], sprintMsToday: 4.5 * MIN, activeMsToday: 30 * MIN });
  assert.equal(decide(under).action, sprint);
  const over = input({ actions: [sprint, warmup], sprintMsToday: 4.6 * MIN, activeMsToday: 30 * MIN });
  assert.equal(decide(over).action, undefined);
  // Other actions are unaffected by the cap.
  const hint = action('hint-ready', { priority: 5 });
  assert.equal(decide({ ...over, actions: [sprint, hint] }).action, hint);
  // Session start: no active time and no sprint time yet, the warm-up is offered.
  assert.equal(decide(input({ actions: [warmup], sprintMsToday: 0, activeMsToday: 0 })).action, warmup);
});

test('no sprint auto-open while building; a learner-started wait opens it otherwise', () => {
  const sprint = action('sprint', { blocking: true });
  const building = decide(input({ actions: [sprint], phase: 'building' }));
  assert.equal(building.action, sprint);
  assert.equal(building.open, false, 'only offered while building');
  assert.equal(building.pop, true, 'offered like any other action at a pause');
  const placement = decide(input({ actions: [sprint], phase: 'placement' }));
  assert.equal(placement.open, true);
  // Not right after an edit, and not over another flow.
  assert.equal(decide(input({ actions: [sprint], phase: 'placement', lastEditAt: T - 3 * SEC })).open, false);
  assert.equal(decide(input({ actions: [sprint], phase: 'placement', lockHeld: true })).open, false);
  // Warm-ups are never opened automatically.
  const warmup = action('warmup', { blocking: true });
  assert.equal(decide(input({ actions: [warmup], phase: 'idle' })).open, false);
});

test('skip pushes the kind back 5 minutes', () => {
  const a = action('own-predict', { createdAt: T - 5 * SEC });
  const pushed = pushBack({ sprint: T - SEC }, 'own-predict', T);
  assert.deepEqual(pushed, { 'own-predict': T + PUSH_BACK_MS }, 'expired entries are dropped');
  const later = (ms: number) => input({ now: T + ms, lastEditAt: T + ms - 10 * SEC, lastPause: { kind: 'idle', at: T + ms - SEC }, actions: [a], pushedBack: pushed });
  assert.equal(decide(later(4 * MIN)).action, undefined);
  assert.equal(decide(later(5 * MIN)).action, a);
  // Other kinds are unaffected.
  const hint = action('hint-ready');
  assert.equal(decide({ ...later(MIN), actions: [a, hint] }).action, hint);
  // A flow the learner starts explicitly is never held back.
  const atom = action('atom', { blocking: true });
  assert.equal(decide(input({ actions: [atom], pushedBack: pushBack(undefined, 'atom', T) })).open, true);
});

test('own-code predict: once per 3 active minutes, shown only when it may pop', () => {
  const a = action('own-predict', { createdAt: T - 10 * SEC });
  // Popped 2 active minutes ago (another offer): not shown at all yet.
  const recent = input({ actions: [a], activeMsToday: 30 * MIN, activeAtPopByKind: { 'own-predict': 28 * MIN }, lastPopByKind: { 'own-predict': T - 20 * MIN } });
  assert.equal(decide(recent).action, undefined);
  // 20 wall minutes passed but only 2 of them active: still no.
  assert.equal(decide({ ...recent, activeAtPopByKind: { 'own-predict': 28 * MIN } }).pop, false);
  const due = decide({ ...recent, activeAtPopByKind: { 'own-predict': 27 * MIN } });
  assert.equal(due.action, a);
  assert.equal(due.pop, true);
  // Without active-time data, wall-clock time is the fallback.
  assert.equal(decide(input({ actions: [a], lastPopByKind: { 'own-predict': T - 2 * MIN } })).action, undefined);
  assert.equal(decide(input({ actions: [a], lastPopByKind: { 'own-predict': T - 3 * MIN } })).pop, true);
  // Not a pause right now: not shown either.
  assert.equal(decide(input({ actions: [a], lastPause: undefined })).action, undefined);
  // Once it has popped it stays as the status text, without popping again.
  const shown = decide(input({ actions: [a], lastPause: undefined, lastPopAt: T - 5 * SEC, lastPopByKind: { 'own-predict': T - 5 * SEC } }));
  assert.equal(shown.action, a);
  assert.equal(shown.pop, false);
  // A new day: activeMsToday restarted below the stored value.
  assert.equal(decide(input({ actions: [a], activeMsToday: MIN, activeAtPopByKind: { 'own-predict': 40 * MIN } })).pop, true);
});

test('own-code predict is not offered while stuck .5-1.0, but is as the pre-hint step', () => {
  const a = action('own-predict', { createdAt: T - 10 * SEC });
  assert.equal(decide(input({ actions: [a], stuckScore: 0.49 })).pop, true);
  assert.equal(decide(input({ actions: [a], stuckScore: 0.5 })).action, undefined);
  assert.equal(decide(input({ actions: [a], stuckScore: 0.99 })).action, undefined);
  assert.equal(decide(input({ actions: [a], stuckScore: 1.0 })).pop, true);
});

test('jit-atom and other status-only kinds replace the status text without a pop', () => {
  for (const kind of ['jit-atom', 'specs-ready', 'spec', 'placement', 'info'] as ActionKind[]) {
    const a = action(kind);
    const d = decide(input({ actions: [a] }));
    assert.equal(d.action, a, kind);
    assert.equal(d.pop, false, kind);
  }
});

test('an action pops once; later pauses leave it as the status text', () => {
  const a = action('review-ready', { createdAt: T - 2 * MIN });
  const d = decide(input({ actions: [a], lastPopAt: T - MIN, lastPopByKind: { 'review-ready': T - MIN } }));
  assert.equal(d.action, a);
  assert.equal(d.pop, false);
  // A newer action of the same kind may pop.
  const b = action('review-ready', { id: 'b', createdAt: T - 30 * SEC });
  assert.equal(decide(input({ actions: [b], lastPopAt: T - MIN, lastPopByKind: { 'review-ready': T - MIN } })).pop, true);
});

test('head of the queue: blocking, then priority, then oldest; expired actions are ignored', () => {
  const old = action('review-ready', { id: 'old', priority: 2, createdAt: T - 5 * MIN });
  const urgent = action('hint-ready', { id: 'urgent', priority: 1, createdAt: T - SEC });
  const older = action('warmup', { id: 'older', priority: 1, createdAt: T - 2 * MIN });
  assert.equal(decide(input({ actions: [old, urgent, older] })).action, older);
  const expired = action('hint-ready', { id: 'gone', priority: 0, expiresAt: T });
  assert.equal(decide(input({ actions: [expired, old] })).action, old);
  assert.deepEqual(decide(input({ actions: [] })), { pop: false, open: false });
});

test('status texts stay within 40 characters plus the icon', () => {
  assert.equal(status.specProgress(3, 5, 'flag takes value'), '$(beaker) 3/5 · next: flag takes value');
  assert.equal(status.jitOffer('dict counting'), '$(mortar-board) next spec: dict counting · 60s?');
  assert.equal(status.hintReady('src/cli.py', 14), '$(lightbulb) hint ready · cli.py:14');
  assert.equal(status.hintReady('C:\\proj\\cli.py', 14), '$(lightbulb) hint ready · cli.py:14');
  assert.equal(status.warmup(4), '$(zap) 4 due · 60s warm-up');
  assert.equal(status.predictOwn('parse_args'), '$(question) predict parse_args (15s)');
  assert.equal(
    status.preparing('designing roadmap', { label: 'placement', done: 6, total: 12 }),
    '$(sync~spin) designing roadmap · placement 6/12',
  );
  assert.equal(status.runningSpecs(), '$(sync~spin) running specs...');
  assert.equal(status.stateChange('slicing', 'Fragile', 'Solid'), '$(check) slicing: fragile -> solid');
  assert.equal(status.specsReady(5), '$(beaker) specs ready (5)');
  assert.equal(status.jitOffer('split', 'empty row'), '$(mortar-board) next: empty row uses split · 60s drill?');
  // Too long for the long form: falls back to the short one.
  assert.equal(status.jitOffer('slicing', 'empty input'), '$(mortar-board) next spec: slicing · 60s?');

  const long = 'a_really_long_function_name_that_keeps_going_and_going';
  const texts = [
    status.specProgress(3, 5, 'returns an empty list when the input file has only a header'),
    status.jitOffer('accumulating counts in a dictionary keyed by word', 'counts every word in the file'),
    status.hintReady('src/deeply/nested/a_module_with_a_long_file_name.py', 1234),
    status.predictOwn(long),
    status.stateChange('list comprehensions with conditions', 'Misconception', 'Fixing'),
    statusText('info', 'x '.repeat(60)),
  ];
  for (const t of texts) assert.ok(textLen(t) <= STATUS_MAX, `${textLen(t)}: ${t}`);
  // The meaningful suffix survives clipping of the variable part.
  assert.match(status.predictOwn(long), /…\s?\(15s\)$/);
  assert.match(status.jitOffer('accumulating counts in a dictionary keyed by word'), /· 60s\?$/);
  assert.match(status.hintReady('src/deeply/nested/a_module_with_a_long_file_name.py', 1234), /:1234$/);
});

test('clip keeps short text, breaks long text near a word boundary with an ellipsis', () => {
  assert.equal(clip('short', 40), 'short');
  assert.equal(clip('line one\nline two', 40), 'line one line two');
  const c = clip('the quick brown fox jumps over the lazy dog again and again', 20);
  assert.ok([...c].length <= 20);
  assert.ok(c.endsWith('…'));
  assert.ok(!c.includes(' …'));
  assert.equal([...clip('🙂'.repeat(50), 10)].length, 10, 'counts code points, never splits a surrogate pair');
});

test('tooltip lists jobs, stuck meter and the terminal-focus note; streak only with timers on', () => {
  const md = tempoTooltip({
    taskTitle: 'Parse *args*',
    activeMin: 12.7,
    estimateMin: 15,
    stuckScore: 0.42,
    progressReason: 'spec 2 turned green',
    jobs: 'running 2 · queued 1 · 7/20 this hour',
    calibration: 0.81,
    streak: 3,
    showTimers: false,
  });
  assert.match(md, /Parse \\\*args\\\*/);
  assert.match(md, /12\/15 min/);
  assert.match(md, /Stuck meter 42%/);
  assert.match(md, /7\/20 this hour/);
  assert.match(md, /Calibration 81%/);
  assert.doesNotMatch(md, /Streak/);
  assert.match(md, /Alt\+N does not reach Deliberate while the terminal has focus: click this item instead/);
  assert.match(tempoTooltip({ streak: 3, showTimers: true }), /Streak: 3/);
});
