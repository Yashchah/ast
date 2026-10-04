import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InteractionLock, LockReleased } from '../src/lock';

function setup() {
  let now = 1_000;
  const lock = new InteractionLock(() => now);
  const released: LockReleased[] = [];
  lock.onDidRelease((e) => released.push(e));
  return { lock, released, tick: (ms: number) => (now += ms) };
}

test('a second acquire is refused while the lock is held', () => {
  const { lock, released, tick } = setup();
  const release = lock.acquire('atom');
  assert.ok(release);
  assert.equal(lock.active, 'atom');
  assert.ok(lock.held);
  assert.equal(lock.acquire('gate'), undefined);
  assert.equal(lock.acquire('atom'), undefined);
  tick(2500);
  release();
  assert.equal(lock.active, undefined);
  assert.deepEqual(released, [{ kind: 'atom', reason: 'done', ms: 2500 }]);
  assert.ok(lock.acquire('gate'), 'free again after release');
});

test('release is idempotent and a stale release never frees a later holder', () => {
  const { lock, released } = setup();
  const first = lock.acquire('own-predict')!;
  first();
  first();
  assert.equal(released.length, 1);
  const second = lock.acquire('what-if');
  assert.ok(second);
  first(); // the old flow's late cleanup
  assert.equal(lock.active, 'what-if');
  assert.equal(released.length, 1);
});

test('abortActive calls the abort callback, releases the lock and reports Esc', () => {
  const { lock, released, tick } = setup();
  const calls: string[] = [];
  const release = lock.acquire('sprint', (reason) => calls.push(reason))!;
  tick(4000);
  const r = lock.abortActive();
  assert.deepEqual(r, { kind: 'sprint', reason: 'esc', ms: 4000 });
  assert.deepEqual(calls, ['esc']);
  assert.equal(lock.active, undefined);
  assert.deepEqual(released, [{ kind: 'sprint', reason: 'esc', ms: 4000 }]);
  release(); // the flow's own finally block afterwards is harmless
  assert.equal(released.length, 1);
  assert.ok(lock.acquire('gate'));
});

test('abortActive with nothing active does nothing', () => {
  const { lock, released } = setup();
  assert.equal(lock.abortActive(), undefined);
  assert.equal(released.length, 0);
});

test('an abort callback that releases synchronously is still reported once, as Esc', () => {
  const { lock, released } = setup();
  let release: (() => void) | undefined;
  release = lock.acquire('placement', () => release?.());
  const r = lock.abortActive();
  assert.equal(r?.reason, 'esc');
  assert.deepEqual(released.map((e) => e.reason), ['esc']);
  assert.equal(lock.active, undefined);
});

test('the aborted flow closes before a release listener can open the next one', () => {
  const { lock } = setup();
  const order: string[] = [];
  lock.acquire('atom', () => order.push('atom closed'));
  lock.onDidRelease(() => {
    if (lock.acquire('gate')) order.push('gate opened');
  });
  lock.abortActive();
  assert.deepEqual(order, ['atom closed', 'gate opened']);
  assert.equal(lock.active, 'gate');
});

test('a throwing abort callback still releases the lock', () => {
  const { lock, released } = setup();
  const original = console.error;
  console.error = () => undefined;
  try {
    lock.acquire('skeleton', () => {
      throw new Error('tab already closed');
    });
    assert.equal(lock.abortActive()?.reason, 'esc');
  } finally {
    console.error = original;
  }
  assert.equal(lock.active, undefined);
  assert.equal(released.length, 1);
});
