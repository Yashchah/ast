import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Clock,
  DeadlineMissed,
  Gen,
  JobKind,
  JobPaused,
  JobPriority,
  JobQueue,
  JobScope,
  JobSettled,
  JobSpec,
  RollingBudget,
  describeJobs,
  genMatches,
} from '../src/jobs';

const SEC = 1000;
const MIN = 60 * SEC;

// ---------------------------------------------------------------- fakes

/** Manual clock: advance() fires due timers in time order and lets promise chains settle in between. */
class FakeClock implements Clock {
  t = 1_000_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private ids = 0;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.ids;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers.delete(h as number);
  };
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await flush();
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) {
        if (e[1].at > end) continue;
        if (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0])) next = e;
      }
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
}

/** A model call that takes `ms` of fake time; it rejects with the abort reason when aborted. */
function timed<T>(clock: FakeClock, ms: number, value: T, started?: string[], name?: string) {
  return (signal: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      if (started && name) started.push(name);
      const h = clock.setTimeout(() => resolve(value), ms);
      signal.addEventListener(
        'abort',
        () => {
          clock.clearTimeout(h);
          reject(signal.reason);
        },
        { once: true },
      );
    });
}

const GEN: Gen = { projectCreatedAt: 1, taskId: 't1', taskSwitch: 0 };

function spec<T>(key: string, run: (signal: AbortSignal) => Promise<T>, over: Partial<JobSpec<T>> = {}): JobSpec<T> {
  return { key, priority: 1, effort: 'medium', label: key, scope: 'task', gen: GEN, run, ...over };
}

function limitError(): Error {
  return Object.assign(new Error('Codex plan limit reached: You have hit your usage limit'), { kind: 'limit' });
}

/** Fill the 'other' share (16 of the default 20) with quick calls. */
async function fillOtherShare(q: JobQueue, clock: FakeClock, n = 16): Promise<void> {
  for (let i = 0; i < n; i++) void q.bg(spec(`fill${i}`, timed(clock, SEC, i), { scope: 'global' }));
  await clock.advance(n * SEC);
}

// ---------------------------------------------------------------- generation tokens

test('genMatches follows the race rule per scope', () => {
  const g: Gen = { projectCreatedAt: 1, taskId: 't1', taskSwitch: 3 };
  assert.ok(genMatches(g, { projectCreatedAt: 2, taskId: 'x', taskSwitch: 9 }, 'global'));
  assert.ok(genMatches(g, { projectCreatedAt: 1, taskId: 't2', taskSwitch: 4 }, 'project'));
  assert.ok(!genMatches(g, { projectCreatedAt: 2, taskId: 't1', taskSwitch: 3 }, 'project'));
  assert.ok(genMatches(g, { ...g }, 'task'));
  assert.ok(!genMatches(g, { ...g, taskId: 't2' }, 'task'));
  // restarting the same task still bumps taskSwitch: results from before the restart are stale
  assert.ok(!genMatches(g, { ...g, taskSwitch: 4 }, 'task'));
  assert.ok(!genMatches(g, { ...g, projectCreatedAt: 2 }, 'task'));
});

// ---------------------------------------------------------------- dedupe

test('dedupe: an identical key returns the in-flight promise and runs once', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock });
  let runs = 0;
  const run = (s: AbortSignal) => {
    runs++;
    return timed(clock, 10 * SEC, 'rungs')(s);
  };
  const applied: string[] = [];
  const a = q.bg(spec('hint:t1', run), (v) => applied.push(`a:${v}`));
  const b = q.bg(spec('hint:t1', run), (v) => applied.push(`b:${v}`));
  assert.equal(a, b);
  assert.ok(q.has('hint:t1'));
  await clock.advance(10 * SEC);
  assert.equal(await a, 'rungs');
  assert.equal(runs, 1);
  assert.deepEqual(applied, ['a:rungs', 'b:rungs']);
  assert.ok(!q.has('hint:t1'));
  // Once settled, the same key is new work again.
  const c = q.bg(spec('hint:t1', run));
  assert.notEqual(c, a);
  await clock.advance(10 * SEC);
  assert.equal(await c, 'rungs');
  assert.equal(runs, 2);
  assert.equal(q.stats().used, 2);
});

test('dedupe: a more urgent request for a queued key raises its priority', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock, concurrency: 1 });
  const order: string[] = [];
  void q.bg(spec('blocker', timed(clock, 5 * SEC, 0, order, 'blocker')));
  await clock.advance(0);
  void q.bg(spec('prep', timed(clock, SEC, 0, order, 'prep'), { priority: 1 }));
  const prefetch = q.bg(spec('hint:t1', timed(clock, SEC, 'rungs', order, 'hint'), { priority: 2, kind: 'hint' }));
  // Ctrl+Alt+H: the learner now waits on the same work.
  const onDemand = q.bg(spec('hint:t1', timed(clock, SEC, 'unused', order, 'hint-dup'), { priority: 0, kind: 'hint' }));
  assert.equal(onDemand, prefetch);
  await clock.advance(10 * SEC);
  assert.deepEqual(order, ['blocker', 'hint', 'prep']);
  assert.equal(await onDemand, 'rungs');
});

test('dedupe: the same key under a newer task generation replaces the stale job', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock });
  const settled: JobSettled[] = [];
  q.onDidSettle((e) => settled.push(e));
  const old = q.bg(spec('specs:current', timed(clock, 30 * SEC, 'old')));
  await clock.advance(SEC);
  const fresh = q.bg(spec('specs:current', timed(clock, 30 * SEC, 'new'), { gen: { ...GEN, taskId: 't2', taskSwitch: 1 } }));
  assert.notEqual(fresh, old);
  await clock.advance(30 * SEC);
  assert.equal(await old, undefined);
  assert.equal(await fresh, 'new');
  assert.deepEqual(
    settled.map((s) => [s.outcome, s.reason]),
    [['canceled', 'superseded'], ['done', undefined]],
  );
});

// ---------------------------------------------------------------- ordering and concurrency

test('ordering: priority, then earliest neededBy, then FIFO', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock, concurrency: 1 });
  const order: string[] = [];
  const job = (name: string, over: Partial<JobSpec<number>> = {}) => void q.bg(spec(name, timed(clock, SEC, 0, order, name), over));
  job('blocker');
  await clock.advance(0);
  const now = clock.now();
  job('p2', { priority: 2 });
  job('p1-plain');
  job('p1-late', { neededBy: now + 10 * MIN });
  job('p1-early', { neededBy: now + 5 * MIN });
  job('p3', { priority: 3 });
  job('p0', { priority: 0 });
  job('p1-plain-2');
  await clock.advance(20 * SEC);
  assert.deepEqual(order, ['blocker', 'p0', 'p1-early', 'p1-late', 'p1-plain', 'p1-plain-2', 'p2', 'p3']);
});

test('enqueues in the same tick are ordered together, not first-come', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock, concurrency: 1 });
  const order: string[] = [];
  void q.bg(spec('atoms', timed(clock, SEC, 0, order, 'atoms')));
  void q.bg(spec('prep', timed(clock, SEC, 0, order, 'prep'), { neededBy: clock.now() + 3 * MIN }));
  await clock.advance(5 * SEC);
  assert.deepEqual(order, ['prep', 'atoms']);
});

test('concurrency defaults to 2, is clamped to 1-3, and speculative work never takes the last slot', async () => {
  const clock = new FakeClock();
  let maxRunning = 0;
  const watch = (q: JobQueue) => q.onDidChange(() => (maxRunning = Math.max(maxRunning, q.stats().running)));

  const q = new JobQueue({ clock });
  watch(q);
  for (let i = 0; i < 3; i++) void q.bg(spec(`spec${i}`, timed(clock, 40 * SEC, i), { priority: 2, scope: 'global' }));
  await clock.advance(SEC);
  assert.equal(q.stats().running, 1, 'only one speculative job runs at concurrency 2');
  const started: string[] = [];
  const prep = q.bg(spec('prep', timed(clock, 10 * SEC, 'prep', started, 'prep')));
  await clock.advance(0);
  assert.deepEqual(started, ['prep'], 'needed-next work starts at once');
  assert.equal(q.stats().running, 2);
  await clock.advance(2 * MIN);
  assert.equal(await prep, 'prep');
  assert.equal(maxRunning, 2);

  maxRunning = 0;
  const wide = new JobQueue({ clock, concurrency: 9 });
  watch(wide);
  for (let i = 0; i < 5; i++) void wide.bg(spec(`w${i}`, timed(clock, 10 * SEC, i)));
  await clock.advance(MIN);
  assert.equal(maxRunning, 3);

  maxRunning = 0;
  const narrow = new JobQueue({ clock, concurrency: 0 });
  watch(narrow);
  for (let i = 0; i < 3; i++) void narrow.bg(spec(`n${i}`, timed(clock, 10 * SEC, i), { priority: 2, scope: 'global' }));
  await clock.advance(MIN);
  assert.equal(maxRunning, 1);
  assert.equal(narrow.stats().used, 3, 'at concurrency 1 speculative work may still use the only slot');
});

// ---------------------------------------------------------------- budget

test('RollingBudget: rolling 60-minute window, hint share, halving with a floor of 6', () => {
  let now = 0;
  const b = new RollingBudget({ now: () => now });
  assert.equal(b.limit, 20);
  assert.equal(b.share('hint'), 4);
  assert.equal(b.share('other'), 16);
  for (let i = 0; i < 16; i++) {
    b.spend('other');
    now += MIN;
  }
  assert.ok(!b.canSpend('other'));
  assert.ok(b.canSpend('hint'));
  assert.equal(b.nextFreeAt('other'), 60 * MIN, 'the first call leaves the window after 60 minutes');
  now = 60 * MIN;
  assert.ok(b.canSpend('other'));
  assert.equal(b.used('other'), 15);

  assert.ok(b.halve());
  assert.ok(!b.halve(), 'only the first limit error halves');
  assert.equal(b.limit, 10);
  assert.equal(b.share('hint'), 4);
  assert.equal(b.share('other'), 6);

  const small = new RollingBudget({ perHour: 8 });
  small.halve();
  assert.equal(small.limit, 6, 'halving never goes below 6');
  const tiny = new RollingBudget({ perHour: 4 });
  tiny.halve();
  assert.equal(tiny.limit, 4, 'halving never raises a budget already below 6');
  assert.equal(tiny.share('hint'), 2, 'the reserve never takes more than half');
  assert.equal(tiny.share('other'), 2);
});

test('budget: a full share drops speculative jobs; needed-next jobs wait for the window', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock, concurrency: 3 });
  const settled: JobSettled[] = [];
  q.onDidSettle((e) => settled.push(e));
  await fillOtherShare(q, clock);
  assert.equal(q.stats().used, 16);

  let ran = false;
  const speculative = q.bg(
    spec('owncode:t1', async () => {
      ran = true;
      return 1;
    }, { priority: 2 }),
  );
  const refill = q.bg(spec('refill:lists', timed(clock, SEC, 1), { priority: 3 }));
  assert.equal(await speculative, undefined);
  assert.equal(await refill, undefined);
  assert.equal(ran, false);
  assert.deepEqual(
    settled.slice(-2).map((s) => [s.key, s.outcome, s.reason]),
    [['owncode:t1', 'dropped', 'budget'], ['refill:lists', 'dropped', 'budget']],
  );

  const prep = q.bg(spec('prep:t2', timed(clock, 30 * SEC, 'prep')));
  await clock.advance(30 * MIN);
  assert.equal(q.stats().queued, 1, 'priority 1 waits instead of being dropped');
  await clock.advance(31 * MIN);
  assert.equal(await prep, 'prep');
});

test('budget: a speculative job dropped when its turn comes and the share filled meanwhile', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock, concurrency: 1 });
  await fillOtherShare(q, clock, 15);
  const prep = q.bg(spec('prep', timed(clock, 30 * SEC, 'prep')));
  const speculative = q.bg(spec('owncode', timed(clock, SEC, 'probe'), { priority: 2 }));
  await clock.advance(MIN);
  assert.equal(await prep, 'prep');
  assert.equal(await speculative, undefined, 'the 16th call went to the needed job');
});

test('budget: the hint reserve stays available when other jobs fill their share', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock, concurrency: 2 });
  await fillOtherShare(q, clock);
  assert.equal(await q.bg(spec('other-spec', timed(clock, SEC, 1), { priority: 2 })), undefined);

  const rungs: (string | undefined)[] = [];
  for (let i = 1; i <= 4; i++) {
    const p = q.bg(spec(`hint:t${i}`, timed(clock, 40 * SEC, `rungs${i}`), { priority: 2, kind: 'hint' }));
    await clock.advance(40 * SEC);
    rungs.push(await p);
  }
  assert.deepEqual(rungs, ['rungs1', 'rungs2', 'rungs3', 'rungs4']);
  // The reserve is also a cap: a fifth speculative hint in the hour is dropped.
  assert.equal(await q.bg(spec('hint:t5', timed(clock, 40 * SEC, 'rungs5'), { priority: 2, kind: 'hint' })), undefined);
  const s = q.stats();
  assert.equal(s.used, 20);
  assert.equal(s.hintUsed, 4);
  assert.equal(s.hintLimit, 4);
  assert.equal(describeJobs(s, clock.now()), 'running 0 · queued 0 · 20/20 this hour');
});

// ---------------------------------------------------------------- usage limit

test('usage limit: pause 15 min, drop queued speculative jobs, retry needed work, halve the budget once', async () => {
  const clock = new FakeClock();
  const logs: string[] = [];
  const q = new JobQueue({ clock, concurrency: 1, log: (l) => logs.push(l) });
  const pauses: JobPaused[] = [];
  q.onDidPause((p) => pauses.push(p));

  let attempts = 0;
  const prep = q.bg(
    spec('prep', (s) => {
      attempts++;
      return attempts === 1 ? timed(clock, 5 * SEC, 0)(s).then(() => Promise.reject(limitError())) : timed(clock, 30 * SEC, 'prep')(s);
    }),
  );
  const hint = q.bg(spec('hint:t1', timed(clock, 40 * SEC, 'rungs'), { priority: 2, kind: 'hint' }));
  const batch = q.bg(spec('batch:m2', timed(clock, 40 * SEC, 'batch'), { scope: 'project' }));
  await clock.advance(5 * SEC);
  const limitAt = clock.now();

  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].reason, 'limit');
  assert.equal(pauses[0].halved, true);
  assert.equal(pauses[0].until, limitAt + 15 * MIN);
  assert.equal(await hint, undefined, 'queued speculative job dropped');
  assert.equal(q.stats().limit, 10, 'hourly budget halved');
  assert.equal(q.stats().pausedUntil, limitAt + 15 * MIN);
  assert.ok(logs.some((l) => /usage limit/.test(l)));
  assert.match(describeJobs(q.stats(), clock.now()), /paused 15 min/);

  // New speculative work during the pause is dropped at once; needed work waits.
  assert.equal(await q.bg(spec('refill', timed(clock, SEC, 1), { priority: 3 })), undefined);
  await clock.advance(14 * MIN);
  assert.equal(q.stats().running, 0);
  assert.equal(q.stats().queued, 2);

  await clock.advance(MIN + 30 * SEC);
  assert.equal(await prep, 'prep', 'the limited priority-1 job ran again after the pause');
  assert.equal(attempts, 2);
  await clock.advance(40 * SEC);
  assert.equal(await batch, 'batch');

  // A second limit error pauses again but does not halve again.
  const again = q.bg(spec('again', () => Promise.reject(limitError()), { priority: 2 }));
  await clock.advance(0);
  assert.equal(await again, undefined);
  assert.equal(pauses.length, 2);
  assert.equal(pauses[1].halved, false);
  assert.equal(q.stats().limit, 10);
});

test('usage limit in a foreground call pauses the bg lane and still reaches the caller', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock });
  await assert.rejects(q.fg('Asking the coach', async () => Promise.reject(limitError())), /plan limit/);
  assert.ok(q.stats().pausedUntil);
  assert.equal(q.stats().limit, 10);
});

// ---------------------------------------------------------------- cancellation

test('cancel aborts a running job, resolves it undefined and frees its slot', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock, concurrency: 1 });
  let aborted = false;
  const a = q.bg(
    spec('prep:t1', (s) => {
      s.addEventListener('abort', () => (aborted = true));
      return timed(clock, 60 * SEC, 'late')(s);
    }),
  );
  const b = q.bg(spec('batch', timed(clock, 10 * SEC, 'batch'), { scope: 'project' }));
  await clock.advance(SEC);
  assert.equal(q.cancel('prep:t1'), true);
  assert.equal(aborted, true);
  assert.equal(await a, undefined);
  await clock.advance(10 * SEC);
  assert.equal(await b, 'batch', 'the next job started as soon as the slot was freed');
  assert.equal(q.cancel('missing'), false);
});

test('cancelWhere(task scope) aborts running and queued task jobs only', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock, concurrency: 1 });
  const started: string[] = [];
  const running = q.bg(spec('prep:t1', timed(clock, 60 * SEC, 'prep', started, 'prep')));
  const queued = q.bg(spec('hint:t1', timed(clock, 60 * SEC, 'rungs', started, 'hint'), { kind: 'hint' }));
  const project = q.bg(spec('batch:m2', timed(clock, 10 * SEC, 'batch', started, 'batch'), { scope: 'project' }));
  await clock.advance(SEC);
  assert.equal(q.cancelWhere((s) => s.scope === 'task'), 2);
  assert.equal(await running, undefined);
  assert.equal(await queued, undefined);
  await clock.advance(10 * SEC);
  assert.equal(await project, 'batch');
  assert.deepEqual(started, ['prep', 'batch'], 'the canceled queued job never ran');
  assert.equal(q.stats().used, 2, 'a canceled queued job spends no budget');
});

test('dispose cancels everything, including the running foreground call', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock });
  let fgAborted = false;
  const fg = q.fg('Reveal', (s) => {
    s.addEventListener('abort', () => (fgAborted = true));
    return timed(clock, MIN, 'reveal')(s);
  });
  const bg = q.bg(spec('prep', timed(clock, MIN, 'prep')));
  await clock.advance(SEC);
  q.dispose();
  assert.equal(await bg, undefined);
  await assert.rejects(fg);
  assert.ok(fgAborted);
  assert.equal(await q.bg(spec('after', timed(clock, SEC, 1))), undefined);
});

// ---------------------------------------------------------------- generations

test('a stale gen makes apply a no-op; global results always apply', async () => {
  const clock = new FakeClock();
  let gen: Gen = { ...GEN };
  const q = new JobQueue({ clock, concurrency: 3, currentGen: () => gen });
  const applied: string[] = [];
  const task = q.bg(spec('prep:t1', timed(clock, 30 * SEC, 'prep'), { scope: 'task', gen }), (v) => applied.push(`task:${v}`));
  const project = q.bg(spec('batch:m2', timed(clock, 30 * SEC, 'batch'), { scope: 'project', gen }), (v) => applied.push(`project:${v}`));
  const global = q.bg(spec('atom:slicing', timed(clock, 30 * SEC, 'pack'), { scope: 'global', gen }), (v) => applied.push(`global:${v}`));
  await clock.advance(SEC);
  gen = { ...gen, taskId: 't2', taskSwitch: 1 }; // the learner switched task while these ran
  await clock.advance(30 * SEC);
  assert.equal(await task, undefined);
  assert.equal(await project, 'batch');
  assert.equal(await global, 'pack');
  assert.deepEqual(applied.sort(), ['global:pack', 'project:batch']);

  // A new project makes project-scoped results stale too.
  const batch = q.bg(spec('batch:m3', timed(clock, 30 * SEC, 'batch3'), { scope: 'project', gen }), (v) => applied.push(`project:${v}`));
  await clock.advance(SEC);
  gen = { projectCreatedAt: 2, taskSwitch: 2 };
  await clock.advance(30 * SEC);
  assert.equal(await batch, undefined);
  assert.ok(!applied.includes('project:batch3'));
});

test('a job that is already stale when its turn comes never runs and spends nothing', async () => {
  const clock = new FakeClock();
  let gen: Gen = { ...GEN };
  const q = new JobQueue({ clock, concurrency: 1, currentGen: () => gen });
  const settled: JobSettled[] = [];
  q.onDidSettle((e) => settled.push(e));
  void q.bg(spec('long', timed(clock, 30 * SEC, 1), { scope: 'global' }));
  let ran = false;
  const stale = q.bg(
    spec('prep:t1', async () => {
      ran = true;
      return 1;
    }, { gen }),
  );
  await clock.advance(SEC);
  gen = { ...gen, taskSwitch: 1 };
  await clock.advance(30 * SEC);
  assert.equal(await stale, undefined);
  assert.equal(ran, false);
  assert.equal(q.stats().used, 1);
  assert.equal(settled.find((s) => s.key === 'prep:t1')?.outcome, 'stale');
  // Enqueued with an already-old gen: settled at once.
  assert.equal(await q.bg(spec('prep:old', timed(clock, SEC, 1), { gen: GEN })), undefined);
});

test('an unreadable current gen never applies scoped results and never throws', async () => {
  const clock = new FakeClock();
  const logs: string[] = [];
  let broken = false;
  const q = new JobQueue({
    clock,
    log: (l) => logs.push(l),
    currentGen: () => {
      if (broken) throw new Error('no project');
      return GEN;
    },
  });
  const task = q.bg(spec('prep', timed(clock, 10 * SEC, 'prep')));
  const global = q.bg(spec('atom:x', timed(clock, 10 * SEC, 'pack'), { scope: 'global' }));
  await clock.advance(SEC);
  broken = true;
  await clock.advance(10 * SEC);
  assert.equal(await task, undefined);
  assert.equal(await global, 'pack');
  assert.ok(logs.some((l) => l.includes('no project')));
});

test('an apply callback may enqueue follow-up work under the same key', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock });
  let second: Promise<string | undefined> | undefined;
  const first = q.bg(spec('refill:lists', timed(clock, SEC, 'batch1'), { scope: 'global' }), () => {
    second = q.bg(spec('refill:lists', timed(clock, SEC, 'batch2'), { scope: 'global' }));
  });
  await clock.advance(5 * SEC);
  assert.equal(await first, 'batch1');
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(await second, 'batch2');
});

// ---------------------------------------------------------------- deadlines, errors, fg lane

test('neededBy passing notifies once while the job keeps waiting for its result', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock, concurrency: 3 });
  await fillOtherShare(q, clock);
  const misses: (DeadlineMissed & { at: number })[] = [];
  q.onDeadlineMissed((e) => misses.push({ ...e, at: clock.now() }));
  const neededBy = clock.now() + 2 * MIN;
  const prep = q.bg(spec('prep:t2', timed(clock, 30 * SEC, 'specs'), { neededBy }));
  await clock.advance(5 * MIN);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].at, neededBy, 'notified exactly at neededBy');
  assert.equal(misses[0].state, 'queued');
  assert.equal(misses[0].waitingFor, 'budget');
  assert.equal(q.stats().deadlineMisses, 1);
  assert.ok(q.has('prep:t2'), 'the job keeps waiting');
  await clock.advance(60 * MIN);
  assert.equal(await prep, 'specs', 'the late result can still attach');
  assert.equal(misses.length, 1);
});

test('a running job past neededBy is reported as running', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock });
  const misses: DeadlineMissed[] = [];
  q.onDeadlineMissed((e) => misses.push(e));
  const p = q.bg(spec('prep', timed(clock, 90 * SEC, 'prep'), { neededBy: clock.now() + MIN }));
  await clock.advance(2 * MIN);
  assert.equal(await p, 'prep');
  assert.deepEqual(misses.map((m) => [m.state, m.waitingFor]), [['running', undefined]]);
});

test('an errored bg job is logged, resolves undefined and does not stop the queue', async () => {
  const clock = new FakeClock();
  const logs: string[] = [];
  const q = new JobQueue({ clock, concurrency: 1, log: (l) => logs.push(l) });
  const settled: JobSettled[] = [];
  q.onDidSettle((e) => settled.push(e));
  const bad = q.bg(spec('bad', async () => {
    throw new Error('Codex exited with code 1');
  }));
  const sync = q.bg(spec('sync-throw', (() => {
    throw new Error('boom');
  }) as () => Promise<never>));
  const good = q.bg(spec('good', timed(clock, SEC, 'ok')));
  await clock.advance(5 * SEC);
  assert.equal(await bad, undefined);
  assert.equal(await sync, undefined);
  assert.equal(await good, 'ok');
  assert.deepEqual(settled.map((s) => s.outcome), ['error', 'error', 'done']);
  assert.ok(logs.some((l) => l.includes('Codex exited with code 1')));
  assert.equal(q.stats().pausedUntil, undefined, 'ordinary errors do not pause the lane');
});

test('a throwing apply callback is logged and the job still resolves', async () => {
  const clock = new FakeClock();
  const logs: string[] = [];
  const q = new JobQueue({ clock, log: (l) => logs.push(l) });
  const p = q.bg(spec('prep', timed(clock, SEC, 'v')), () => {
    throw new Error('store full');
  });
  await clock.advance(SEC);
  assert.equal(await p, 'v');
  assert.ok(logs.some((l) => l.includes('store full')));
});

test('fg runs one call at a time with a visible label, unbudgeted', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock });
  const order: string[] = [];
  const a = q.fg('Asking the coach', timed(clock, 10 * SEC, 'answer', order, 'ask'));
  const b = q.fg('Revealing', timed(clock, 5 * SEC, 'reveal', order, 'reveal'));
  await clock.advance(SEC);
  assert.equal(q.stats().fg, 'Asking the coach');
  assert.equal(q.stats().fgQueued, 1);
  assert.deepEqual(order, ['ask']);
  await clock.advance(9 * SEC);
  assert.equal(await a, 'answer');
  assert.equal(q.stats().fg, 'Revealing');
  await clock.advance(5 * SEC);
  assert.equal(await b, 'reveal');
  assert.equal(q.stats().fg, undefined);
  assert.equal(q.stats().used, 0);
  // A failing fg call releases the lane for the next one.
  await assert.rejects(q.fg('Checking', async () => Promise.reject(new Error('nope'))), /nope/);
  const c = q.fg('Teaching', timed(clock, SEC, 'pack'));
  await clock.advance(SEC);
  assert.equal(await c, 'pack');
});

// ---------------------------------------------------------------- a simulated hour

test('a simulated hour of 4 tasks keeps priority-1 queue wait <= 30 s at default settings', async () => {
  const clock = new FakeClock();
  const q = new JobQueue({ clock });
  const t0 = clock.now();
  const settled: JobSettled[] = [];
  q.onDidSettle((e) => settled.push(e));

  // Per-task mix from latencyStrategy (medium about 30-60 s, low about 10-15 s), slightly heavier
  // than the expected 2.5 calls per task: 14 other calls plus the full 4-hint reserve.
  type Ev = { min: number; key: string; priority: JobPriority; sec: number; kind?: JobKind; neededByMin?: number; scope?: JobScope };
  const events: Ev[] = [
    { min: 0, key: 'plan-outline', priority: 0, sec: 55, scope: 'project' },
    // Plan lands: TaskPrep for tasks 1-3 (needed by the predicted end of placement) + their AtomPack.
    { min: 1, key: 'taskprep:1-3', priority: 1, sec: 50, neededByMin: 3.5, scope: 'project' },
    { min: 1, key: 'atompack:1-3', priority: 1, sec: 35, scope: 'global' },
    // Task 1 starts milestone 1: TaskBatch for milestone 2.
    { min: 4, key: 'taskbatch:m2', priority: 1, sec: 50, scope: 'project' },
    // Stuck 0.6 in task 1: hint ladder from the reserve, a refill, then a TaskPrep repair arrives
    // while both speculative jobs want slots.
    { min: 9, key: 'hint:t1', priority: 2, kind: 'hint', sec: 40 },
    { min: 9.2, key: 'refill:lists', priority: 3, sec: 12, scope: 'global' },
    { min: 9.3, key: 'taskprep-repair:1-3', priority: 1, sec: 25, scope: 'project' },
    // Task 1 criteria met (weakest P < 0.6): follow-up.
    { min: 16.5, key: 'followup:t1', priority: 1, sec: 40 },
    // Task 2, second-to-last of the trio, enters building: TaskPrep for tasks 4-6 + their AtomPack.
    { min: 17, key: 'taskprep:4-6', priority: 1, sec: 50, neededByMin: 31, scope: 'project' },
    { min: 17.1, key: 'atompack:4-6', priority: 1, sec: 35, scope: 'global' },
    // A failed re-probe in a pre-build atom: escalation lesson (low effort, needed now).
    { min: 19, key: 'lesson:t2', priority: 0, sec: 10 },
    { min: 23, key: 'hint:t2', priority: 2, kind: 'hint', sec: 40 },
    { min: 23.2, key: 'owncode:t2', priority: 2, sec: 12 },
    // Task 3.
    { min: 33, key: 'hint:t3', priority: 2, kind: 'hint', sec: 40 },
    { min: 33.1, key: 'refill:dicts', priority: 3, sec: 12, scope: 'global' },
    { min: 39, key: 'lesson:t3', priority: 0, sec: 10 },
    // Task 4 starts milestone 2: TaskBatch for milestone 3 and an AtomPack for a project concept.
    { min: 46, key: 'taskbatch:m3', priority: 1, sec: 50, scope: 'project' },
    { min: 46.2, key: 'atompack:t4', priority: 1, sec: 35, scope: 'global' },
    { min: 52, key: 'hint:t4', priority: 2, kind: 'hint', sec: 40 },
  ];
  const results: Promise<unknown>[] = [];
  for (const ev of events) {
    await clock.advance(t0 + ev.min * MIN - clock.now());
    results.push(
      q.bg(
        spec(ev.key, timed(clock, ev.sec * SEC, ev.key), {
          priority: ev.priority,
          kind: ev.kind,
          scope: ev.scope ?? 'task',
          neededBy: ev.neededByMin === undefined ? undefined : t0 + ev.neededByMin * MIN,
        }),
      ),
    );
  }
  await clock.advance(t0 + 61 * MIN - clock.now());
  const values = await Promise.all(results);

  assert.deepEqual(values, events.map((e) => e.key), 'every job ran: nothing was dropped');
  assert.equal(settled.length, events.length);
  const waits = (p: number) => settled.filter((s) => s.priority === p).map((s) => s.waitMs ?? Infinity);
  const p1 = waits(1);
  assert.equal(p1.length, 9);
  assert.ok(Math.max(...p1) <= 30 * SEC, `priority-1 waits ${p1.map((w) => w / SEC)}`);
  assert.ok(Math.max(...waits(0)) <= 30 * SEC, `priority-0 waits ${waits(0).map((w) => w / SEC)}`);
  const s = q.stats();
  assert.equal(s.deadlineMisses, 0);
  assert.ok(s.used <= 20, `${s.used} calls`);
  assert.equal(s.hintUsed, 4);
});
