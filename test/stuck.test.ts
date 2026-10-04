import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StuckDetector } from '../src/stuck';

const MIN = 60_000;

/** Simulate `minutes` of focused activity in 5s ticks, with an edit every 30s. */
function work(d: StuckDetector, start: number, minutes: number, edit = { ins: 5, del: 5 }): number {
  let now = start;
  const end = start + minutes * MIN;
  while (now < end) {
    now += 5000;
    if ((now - start) % 30_000 === 0) d.onEdit(now, edit.ins, edit.del);
    d.tick(now, true);
  }
  return now;
}

test('not stuck early in a task', () => {
  const t0 = 1_000_000;
  const d = new StuckDetector(t0);
  const now = work(d, t0, 1);
  assert.ok(d.signals(now, 7).score < 0.5);
});

test('becomes stuck after threshold of active time without progress', () => {
  const t0 = 1_000_000;
  const d = new StuckDetector(t0);
  const now = work(d, t0, 8);
  const s = d.signals(now, 7);
  assert.ok(s.score >= 1, `score ${s.score}`);
  assert.ok(s.reasons.some((r) => r.includes('without visible progress')));
});

test('time away from the editor does not count', () => {
  const t0 = 1_000_000;
  const d = new StuckDetector(t0);
  let now = work(d, t0, 2);
  // 30 minutes unfocused
  for (let i = 0; i < 360; i++) {
    now += 5000;
    d.tick(now, false);
  }
  assert.ok(d.activeMsSinceProgress <= 2 * MIN + 5000);
  // 30 minutes focused but completely idle also stops the clock after the idle cutoff
  for (let i = 0; i < 360; i++) {
    now += 5000;
    d.tick(now, true);
  }
  assert.ok(d.activeMsSinceProgress < 8 * MIN, `${d.activeMsSinceProgress / MIN} min`);
});

test('fixing errors counts as progress and resets the clock', () => {
  const t0 = 1_000_000;
  const d = new StuckDetector(t0);
  d.onDiagnostics(t0, ['a.ts: x is not defined', 'a.ts: y is not defined']);
  let now = work(d, t0, 5);
  assert.ok(d.activeMsSinceProgress >= 4 * MIN);
  d.onDiagnostics(now, ['a.ts: y is not defined']);
  assert.equal(d.activeMsSinceProgress, 0);
  assert.match(d.progressReason, /fixed 1 error/);
  now = work(d, now, 1);
  assert.ok(d.signals(now, 7).score < 0.5);
});

test('persistent error and repeated failing runs raise the score', () => {
  const t0 = 1_000_000;
  const d = new StuckDetector(t0);
  d.onDiagnostics(t0, ['main.py:12 NameError: name "foo" is not defined']);
  let now = work(d, t0, 4);
  const before = d.signals(now, 7).score;
  for (let i = 0; i < 3; i++) d.onTerminal(now, 'python main.py', 1, 'Traceback...');
  // Same error text with a different line number is still "the same" error.
  d.onDiagnostics(now, ['main.py:14 NameError: name "foo" is not defined']);
  now = work(d, now, 0.5);
  const s = d.signals(now, 7);
  assert.ok(s.score >= before + 0.25, `${before} -> ${s.score}`);
  assert.equal(s.repeatedTerminalFailures, 3);
  assert.ok(s.persistentError?.includes('NameError'));
  assert.match(s.lastTerminalError ?? '', /python main.py/);
});

test('a previously failing command succeeding is progress', () => {
  const t0 = 1_000_000;
  const d = new StuckDetector(t0);
  let now = work(d, t0, 3);
  d.onTerminal(now, 'npm test', 1, 'fail');
  now = work(d, now, 1);
  d.onTerminal(now, 'npm test', 0, 'ok');
  assert.equal(d.activeMsSinceProgress, 0);
  assert.equal(d.signals(now, 7).repeatedTerminalFailures, 0);
});

test('write-and-delete churn is detected', () => {
  const t0 = 1_000_000;
  const d = new StuckDetector(t0);
  const now = work(d, t0, 4, { ins: 20, del: 60 });
  const s = d.signals(now, 7);
  assert.ok(s.churn > 0.6);
  assert.ok(s.reasons.includes('writing and deleting the same code'));
});

test('steady clean writing counts as progress', () => {
  const t0 = 1_000_000;
  const d = new StuckDetector(t0);
  d.onDiagnostics(t0, []);
  const now = work(d, t0, 6, { ins: 60, del: 2 });
  assert.ok(d.signals(now, 7).score < 0.6, `${d.signals(now, 7).score}`);
});

test('latest run per command: a later success replaces an earlier failure', () => {
  const d = new StuckDetector(0);
  d.onTerminal(1000, 'python main.py', 1, 'NameError: foo');
  d.onTerminal(2000, 'pytest', 1, 'boom');
  d.onTerminal(3000, 'python main.py', 0, 'ok');
  const runs = d.latestRuns();
  assert.deepEqual(runs.map((r) => [r.command, r.exitCode]), [['python main.py', 0], ['pytest', 1]]);
});
