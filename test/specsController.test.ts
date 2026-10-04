// SpecController (src/specs.ts): save triggers, target-only reporting, hidden specs, evidence
// weights, consent, mapping and JIT offers, driven with a fake runner, fake sinks and a fake clock.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectNode, detectPython, LocalRunner, PATH_PYTHON_CANDIDATES, type DetectedRuntime } from '../src/runner';
import type {
  Action, Annotation, AnnotationSource, BatchRecord, LearnerRunOptions, RunResult, Runner, Runtime, SpecItem, TaskSpecState,
} from '../src/contracts';
import type { AnnotationSink, GutterCommand, GutterKind } from '../src/annotations';
import type { ActionSink } from '../src/tempoBar';
import type { Clock } from '../src/jobs';
import {
  AUTO_IDLE_MS, MANUAL_DEBOUNCE_MS, SPEC_ACTION_IDS, SpecController, functionsFromText, mergeFunctionLocs, resolveMapping, signatureStuck,
  specFileName, stuckOfferLabel, testResults, tsImportCaveat, type GreenInfo, type HiddenResult, type LoadNudge, type SpecFs, type SpecTask, type SpecUpdate,
} from '../src/specs';
import { DESIGN_DIFFERS, specTimeoutMs, type HarnessInput } from '../src/specsCore';

// ------------------------------------------------------------------ fakes

class FakeClock implements Clock {
  t = 1_700_000_000_000;
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
  pending(): number {
    return this.timers.size;
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await flush();
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) {
        if (e[1].at > end) continue;
        if (!next || e[1].at < next[1].at) next = e;
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
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

class MemFs implements SpecFs {
  files = new Map<string, string>();
  dirs: string[] = [];
  async mkdir(p: string) {
    this.dirs.push(p);
  }
  async writeFile(p: string, text: string) {
    this.files.set(p, text);
  }
  async exists(p: string) {
    return this.files.has(p);
  }
}

class FakeAnnotations implements AnnotationSink {
  items: Annotation[] = [];
  gutters: { uri: string; line: number; kind: GutterKind; hover?: string; command?: GutterCommand }[] = [];
  set(a: Annotation): void {
    this.items = this.items.filter((x) => !(x.uri === a.uri && x.line === a.line && x.source === a.source));
    this.items.push(a);
  }
  clear(source: AnnotationSource, uri?: string): void {
    this.items = this.items.filter((x) => !(x.source === source && (uri === undefined || x.uri === uri)));
  }
  setGutter(uri: string, line: number, kind: GutterKind, hover?: string, command?: GutterCommand): void {
    this.gutters = this.gutters.filter((g) => !(g.uri === uri && g.line === line));
    this.gutters.push({ uri, line, kind, hover, command });
  }
  clearGutter(uri?: string, kind?: GutterKind): void {
    this.gutters = this.gutters.filter((g) => !((uri === undefined || g.uri === uri) && (kind === undefined || g.kind === kind)));
  }
}

class FakeActions implements ActionSink {
  queue = new Map<string, Omit<Action, 'id' | 'createdAt'> & { id: string }>();
  log: string[] = [];
  flashes: string[] = [];
  private n = 0;
  enqueue(a: Omit<Action, 'id' | 'createdAt'> & { id?: string }): string {
    const id = a.id ?? `a${++this.n}`;
    this.queue.set(id, { ...a, id });
    this.log.push(`+${id}:${a.label}`);
    return id;
  }
  remove(idOrKind: string): void {
    for (const [id, a] of this.queue) if (id === idOrKind || a.kind === idOrKind) this.queue.delete(id);
  }
  flash(text: string): void {
    this.flashes.push(text);
  }
}

type R = { pass: boolean; actual?: string; error?: string; exception?: string; sig?: number; status?: 'ok' | 'timeout' };

/** What the harness prints for these specs (protocol lines as harness.py writes them). */
function harnessOut(ids: string[], res: Record<string, R | undefined>, o: { importMs?: number; loadError?: Record<string, unknown> } = {}): string {
  const lines = [`@@DLB_PLAN ${JSON.stringify(ids)}`, `@@DLB_LOAD ${JSON.stringify({ importMs: o.importMs ?? 12, ...(o.loadError ? { loadError: o.loadError } : {}) })}`];
  if (!o.loadError) {
    for (const id of ids) {
      const r = res[id];
      if (!r) continue;
      lines.push(`@@DLB_START ${id}`, `@@DLB ${JSON.stringify({ id, status: 'ok', ...r })}`);
    }
  }
  lines.push('@@DLB_END {}');
  return lines.join('\n');
}

const PY_RUNTIME: Runtime = { lang: 'python', exe: 'python', snippetArgv: [], learnerArgv: [], version: '3.12.1' };

class FakeRunner implements Runner {
  calls: { script: string; args: string[]; opts: LearnerRunOptions; input: HarnessInput }[] = [];
  /** Results by spec id for the next runs (visible and hidden ids). */
  behaviour: Record<string, R> = {};
  loadError?: Record<string, unknown>;
  importMs = 12;
  hold?: Promise<void>;
  constructor(private readonly fs: MemFs, readonly runtime: Runtime = PY_RUNTIME) {}
  async runBatch(): Promise<BatchRecord[]> {
    throw new Error('not used');
  }
  async runLearnerCode(script: string, args: string[], opts: LearnerRunOptions): Promise<RunResult> {
    const input = JSON.parse(this.fs.files.get(args[1])!) as HarnessInput;
    this.calls.push({ script, args, opts, input });
    if (this.hold) await this.hold;
    const ids = input.specs.map((s) => s.id);
    return { stdout: harnessOut(ids, this.behaviour, { importMs: this.importMs, loadError: this.loadError }), stderr: '', exitCode: 0, timedOut: false, ms: 20 };
  }
}

// ------------------------------------------------------------------ fixture

const WS = path.resolve('/tmp/dlb-ws');
const SPEC_DIR = path.resolve('/tmp/dlb-storage/specs');
const HARNESS = path.resolve('/ext/media/harness');
const FILE = path.join(WS, 'wc.py');
const uriOf = (p: string) => `file:///${p.replace(/\\/g, '/').replace(/^\//, '')}`;
const URI = uriOf(FILE);

const SOURCE = [
  'def count_words(text):', //   0
  '    counts = {}', //          1
  '    return counts', //        2
  '', //                         3
  '', //                         4
  'def top_word(counts):', //    5
  '    return None', //          6
  '',
].join('\n');

function spec(id: string, call: string, expected: string, extra: Partial<SpecItem> = {}): SpecItem {
  return { id, title: `title ${id}`, conceptId: 'counting-with-dict', call, expected, expectError: '', parSec: 60, failureSignatures: [], ...extra };
}

function state(over: Partial<TaskSpecState> = {}): TaskSpecState {
  return {
    specs: [
      spec('s1', "count_words('')", '{}'),
      spec('s2', "count_words('a b')", "{'a': 1, 'b': 1}", {
        conceptId: 'string-split-join',
        failureSignatures: [{ match: 'equals', value: "{'a b': 1}", misconceptionId: 'split-no-arg', nudge: 'What does split() split on?' }],
      }),
      spec('s3', "top_word({'a': 2})", "'a'", { conceptId: 'dict-iteration' }),
    ],
    hidden: [spec('h1', "count_words('a  b')", "{'a': 1, 'b': 1}")],
    greenAt: {}, firstRedAt: {}, savesSinceRed: {}, runs: 0, verified: true, applicable: true,
    ...over,
  };
}

interface Rig {
  clock: FakeClock;
  fs: MemFs;
  runner: FakeRunner;
  ann: FakeAnnotations;
  actions: FakeActions;
  ctrl: SpecController;
  task: SpecTask;
  greens: { id: string; weight: number; info: GreenInfo }[];
  hidden: HiddenResult[];
  allGreen: number;
  loadErrors: LoadNudge[];
  updates: SpecUpdate[];
  sigs: { id: string; count: number }[];
  errors: number;
  save(reason?: 'manual' | 'auto'): void;
  run(): Promise<void>;
}

function rig(o: { task?: Partial<SpecTask>; source?: string; p?: Record<string, number>; runtime?: Runtime } = {}): Rig {
  const clock = new FakeClock();
  const fs = new MemFs();
  fs.files.set(FILE, o.source ?? SOURCE);
  const runner = new FakeRunner(fs, o.runtime);
  const ann = new FakeAnnotations();
  const actions = new FakeActions();
  const r = { greens: [], hidden: [], allGreen: 0, loadErrors: [], updates: [], sigs: [], errors: 0 } as unknown as Rig;
  const ctrl = new SpecController({
    annotations: ann, actions, harnessDir: HARNESS, specDir: SPEC_DIR, workspaceDir: () => WS, uriOf,
    readText: async (p) => fs.files.get(p), errorCount: () => r.errors, fs, clock,
    conceptInfo: (id) => (o.p && id in o.p ? { p: o.p[id], pattern: `pattern of ${id}` } : undefined),
    on: {
      onGreen: (id, weight, info) => r.greens.push({ id, weight, info }),
      onHiddenResult: (h) => r.hidden.push(h),
      onAllVisibleGreen: () => r.allGreen++,
      onLoadError: (n) => r.loadErrors.push(n),
      onUpdate: (u) => r.updates.push(u),
      onSignature: (s, _sig, info) => r.sigs.push({ id: s.id, count: info.count }),
    },
  });
  const task: SpecTask = {
    id: 'task-1', title: 'Word counter', fade: 'full', spec: state(),
    interface: { file: 'wc.py', functions: [{ name: 'count_words', signature: 'count_words(text) -> dict', purpose: '' }, { name: 'top_word', signature: 'top_word(counts) -> str', purpose: '' }] },
    ...o.task,
  };
  Object.assign(r, {
    clock, fs, runner, ann, actions, ctrl, task,
    save: (reason: 'manual' | 'auto' = 'manual') => ctrl.onSave({ uri: URI, fsPath: FILE, reason, errorCount: 0 }),
    run: async () => {
      r.save('manual');
      await clock.advance(MANUAL_DEBOUNCE_MS);
      await ctrl.idle();
    },
  });
  return r;
}

async function attached(o: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(o);
  const res = await r.ctrl.attach(r.task, 'python', r.runner, { allowRun: true });
  assert.equal(res.applicable, true, res.reason);
  return r;
}

// ------------------------------------------------------------------ triggers

describe('save triggers', () => {
  test('manual saves run once, 300 ms after the last save (debounced)', async () => {
    const r = await attached();
    r.save();
    await r.clock.advance(200);
    r.save();
    await r.clock.advance(200);
    assert.equal(r.runner.calls.length, 0, 'still inside the debounce window');
    await r.clock.advance(100);
    await r.ctrl.idle();
    assert.equal(r.runner.calls.length, 1);
  });

  test('auto-save runs only after 1.5 s without edits', async () => {
    const r = await attached();
    r.save('auto');
    await r.clock.advance(1000);
    r.ctrl.onEdit({ uri: URI, fsPath: FILE });
    await r.clock.advance(2000);
    assert.equal(r.runner.calls.length, 0, 'an edit after the auto-save cancels its run');
    r.save('auto');
    await r.clock.advance(AUTO_IDLE_MS - 1);
    assert.equal(r.runner.calls.length, 0);
    await r.clock.advance(1);
    await r.ctrl.idle();
    assert.equal(r.runner.calls.length, 1);
  });

  test('auto-save with Error diagnostics does not run (half-typed code never flickers red)', async () => {
    const r = await attached();
    r.errors = 2;
    r.save('auto');
    await r.clock.advance(AUTO_IDLE_MS + 100);
    await r.ctrl.idle();
    assert.equal(r.runner.calls.length, 0);
    r.errors = 0;
    r.save('auto');
    await r.clock.advance(AUTO_IDLE_MS);
    await r.ctrl.idle();
    assert.equal(r.runner.calls.length, 1);
  });

  test('a manual save supersedes a pending auto-save run; saves of other files are ignored', async () => {
    const r = await attached();
    r.save('auto');
    await r.clock.advance(500);
    r.save('manual');
    await r.clock.advance(AUTO_IDLE_MS + MANUAL_DEBOUNCE_MS);
    await r.ctrl.idle();
    assert.equal(r.runner.calls.length, 1);
    r.ctrl.onSave({ uri: 'file:///x/notes.md', fsPath: path.join(WS, 'notes.md'), reason: 'manual', errorCount: 0 });
    r.ctrl.onSave({ uri: 'file:///elsewhere/a.py', fsPath: path.resolve('/elsewhere/a.py'), reason: 'manual', errorCount: 0 });
    await r.clock.advance(1000);
    await r.ctrl.idle();
    assert.equal(r.runner.calls.length, 1);
  });

  test('a save during a run queues exactly one more run', async () => {
    const r = await attached();
    let open!: () => void;
    r.runner.hold = new Promise<void>((res) => (open = res));
    r.save();
    await r.clock.advance(MANUAL_DEBOUNCE_MS);
    r.save();
    await r.clock.advance(MANUAL_DEBOUNCE_MS);
    r.save();
    await r.clock.advance(MANUAL_DEBOUNCE_MS);
    assert.equal(r.runner.calls.length, 1);
    r.runner.hold = undefined;
    open();
    await r.ctrl.idle();
    assert.equal(r.runner.calls.length, 2);
  });
});

// ------------------------------------------------------------------ runs and reporting

describe('runs', () => {
  test('spec JSON goes to globalStorage/specs/<taskId>.json; the harness gets the same timeout; calls use the learner names', async () => {
    const r = await attached();
    r.runner.behaviour = { s1: { pass: true, actual: '{}' }, s2: { pass: false, actual: '{}' }, s3: { pass: false, actual: 'None' } };
    await r.run();
    const c = r.runner.calls[0];
    assert.equal(c.script, path.join(HARNESS, 'harness.py'));
    assert.equal(c.args[0], FILE);
    assert.equal(c.args[1], path.join(SPEC_DIR, specFileName('task-1')));
    assert.ok(!c.args[1].startsWith(WS), 'never inside the workspace');
    assert.deepEqual(c.opts.readDirs, [SPEC_DIR]);
    assert.equal(c.opts.workspaceDir, WS);
    assert.equal(c.opts.timeoutMs, specTimeoutMs(undefined));
    assert.equal(c.input.timeoutMs, c.opts.timeoutMs);
    assert.deepEqual(c.input.functions, ['count_words', 'top_word']);
    assert.deepEqual(c.input.specs.map((s) => s.id), ['s1', 's2', 's3']);
    assert.equal(r.task.spec!.runs, 1);
    assert.equal(r.task.spec!.importMs, 12, 'importMs stored on the first run');
  });

  test('target-only reporting: one failed gutter (the target), later reds are not-yet', async () => {
    const r = await attached();
    r.runner.behaviour = { s1: { pass: true, actual: '{}' }, s2: { pass: false, actual: '{}' }, s3: { pass: false, actual: 'None' } };
    await r.run();
    const u = r.updates.at(-1)!;
    assert.equal(u.target, 's2');
    assert.deepEqual(u.display, { s1: 'passed', s2: 'failed', s3: 'not-yet' });
    assert.deepEqual(r.ann.gutters.map((g) => [g.line, g.kind]), [[0, 'fail']], 'count_words fails (target); top_word shows nothing');
    assert.match(r.ann.gutters[0].hover!, /Spec 2/);
    assert.ok(!r.ann.gutters[0].hover!.includes("'b': 1"), 'the expected value is never in the hover');
    const progress = r.actions.queue.get(SPEC_ACTION_IDS.progress)!;
    assert.equal(progress.kind, 'spec');
    assert.match(progress.label, /1\/3 · next: title s2/);

    r.runner.behaviour = { s1: { pass: true, actual: '{}' }, s2: { pass: true, actual: "{'a': 1, 'b': 1}" }, s3: { pass: false, actual: 'None' } };
    await r.run();
    assert.deepEqual(r.ann.gutters.map((g) => [g.line, g.kind]).sort(), [[0, 'pass'], [5, 'fail']]);
    assert.deepEqual(r.updates.at(-1)!.turnedGreen, ['s2']);
  });

  test('a failure signature on the target puts its nudge on the def line, once per attempt', async () => {
    const r = await attached();
    r.runner.behaviour = { s1: { pass: true, actual: '{}' }, s2: { pass: false, actual: "{'a b': 1}", sig: 0 }, s3: { pass: false, actual: 'None' } };
    await r.run();
    const nudge = r.ann.items.find((a) => a.source === 'spec')!;
    assert.equal(nudge.line, 0);
    assert.equal(nudge.text, 'spec 2: What does split() split on?');
    assert.deepEqual(r.sigs, [{ id: 's2', count: 1 }]);
    await r.run();
    assert.equal(r.sigs.length, 1, 're-saving unchanged code is not a new attempt');
    r.fs.files.set(FILE, SOURCE + '\n   \n');
    await r.run();
    assert.equal(r.sigs.length, 1, 'whitespace-only changes are not a new attempt');
    r.fs.files.set(FILE, SOURCE.replace('counts = {}', 'counts = dict()'));
    await r.run();
    assert.deepEqual(r.sigs.at(-1), { id: 's2', count: 2 }, 'changed code with the same wrong result is a second attempt');
  });

  test('red past 2x par with the same signature on 2 attempts queues one atom offer for its concept', async () => {
    const stuck: { id: string; count: number; activeMs: number }[] = [];
    const r = await attached({ p: { 'string-split-join': 0.9 } });
    r.ctrl.on.onSignatureStuck = (s, _sig, info) => stuck.push({ id: s.id, count: info.count, activeMs: info.activeMs });
    r.runner.behaviour = { s1: { pass: true, actual: '{}' }, s2: { pass: false, actual: "{'a b': 1}", sig: 0 }, s3: { pass: false, actual: 'None' } };
    await r.run(); // s2 becomes the target (par 60 s)
    await r.clock.advance(150_000);
    await r.run();
    assert.equal(r.actions.queue.has(SPEC_ACTION_IDS.stuck), false, 'past 2x par but only one attempt');
    r.fs.files.set(FILE, SOURCE.replace('counts = {}', 'counts = dict()'));
    await r.run();
    const offer = r.actions.queue.get(SPEC_ACTION_IDS.stuck)!;
    assert.equal(offer.kind, 'atom');
    assert.equal(offer.label, '$(mortar-board) stuck? pattern of string-sp… · 60s drill', 'clipped to 40 characters');
    assert.deepEqual(offer.args, ['string-split-join', 's2']);
    assert.equal(stuck.length, 1);
    assert.equal(stuck[0].count, 2);
    assert.ok(stuck[0].activeMs > 120_000);
    r.fs.files.set(FILE, SOURCE.replace('counts = {}', 'counts = {} # again'));
    await r.run();
    assert.equal(stuck.length, 1, 'once per spec');
    r.runner.behaviour.s2 = { pass: true, actual: "{'a': 1, 'b': 1}" };
    await r.run();
    assert.equal(r.actions.queue.has(SPEC_ACTION_IDS.stuck), false, 'the offer goes when the target moves on');
  });

  test('the 2x-par rule uses active time when the coach gives it, and not before 2x par', async () => {
    const r = await attached();
    let active = 0;
    (r.ctrl as unknown as { deps: { activeMsSince?: (t: number) => number } }).deps.activeMsSince = () => active;
    r.runner.behaviour = { s1: { pass: true, actual: '{}' }, s2: { pass: false, actual: "{'a b': 1}", sig: 0 }, s3: { pass: false, actual: 'None' } };
    await r.run();
    await r.clock.advance(600_000); // a long break: wall time is far past par, active time is not
    active = 90_000;
    r.fs.files.set(FILE, SOURCE.replace('counts = {}', 'counts = dict()'));
    await r.run();
    assert.equal(r.actions.queue.has(SPEC_ACTION_IDS.stuck), false);
    active = 121_000;
    await r.run(); // same code, no new attempt, but now past 2x par: the rule holds
    assert.equal(r.actions.queue.get(SPEC_ACTION_IDS.stuck)?.kind, 'atom');
  });

  test('signatureStuck and its label', () => {
    assert.equal(signatureStuck(2, 120_001, 60), true);
    assert.equal(signatureStuck(2, 120_000, 60), false);
    assert.equal(signatureStuck(1, 999_999, 60), false);
    assert.equal(signatureStuck(2, 120_001, Number.NaN), true, 'a missing par counts as 60 s');
    assert.equal(signatureStuck(3, 20_001, 10), true);
    const label = stuckOfferLabel('A very long canonical pattern name that will not fit');
    assert.ok([...label.replace('$(mortar-board) ', '')].length <= 40, label);
    assert.match(label, /^\$\(mortar-board\) stuck\? .+… · 60s drill$/);
  });

  test('solo tasks: no signature nudges, no titles, no JIT offers', async () => {
    const r = await attached({ task: { fade: 'solo', solo: true }, p: { 'string-split-join': 0.2 } });
    r.runner.behaviour = { s1: { pass: true, actual: '{}' }, s2: { pass: false, actual: "{'a b': 1}", sig: 0 }, s3: { pass: false, actual: 'None' } };
    await r.run();
    assert.equal(r.ann.items.filter((a) => a.source === 'spec').length, 0);
    assert.equal(r.actions.queue.has(SPEC_ACTION_IDS.jit), false);
    assert.equal(r.actions.queue.get(SPEC_ACTION_IDS.progress)!.label, '$(beaker) 1 of 3 behaviours pass');
    assert.deepEqual(r.updates.at(-1)!.ladder.titles, []);
    assert.match(r.updates.at(-1)!.ladder.target!.text, /count_words\('a b'\) returns/);
  });

  test('a load error keeps the last results and points at the line', async () => {
    const r = await attached();
    r.runner.behaviour = { s1: { pass: true, actual: '{}' }, s2: { pass: false, actual: '{}' }, s3: { pass: false, actual: 'None' } };
    await r.run();
    r.runner.loadError = { kind: 'top-level', message: "top-level code runs on import: move it under if __name__ == '__main__'", line: 8 };
    await r.run();
    assert.equal(r.loadErrors.length, 1);
    assert.equal(r.loadErrors[0].line, 7, '0-based');
    assert.equal(r.loadErrors[0].uri, URI);
    assert.equal(r.task.spec!.last!.s1.pass, true, 'last results are kept');
    assert.equal(r.task.spec!.runs, 1, 'a run that loaded nothing is not counted');
    assert.equal(r.ann.items.find((a) => a.source === 'spec')!.line, 7);
  });

  test("slow imports: 'running specs...' while running, and a longer timeout", async () => {
    const r = await attached();
    r.runner.importMs = 2400;
    r.runner.behaviour = { s1: { pass: false, actual: 'None' } };
    await r.run();
    assert.equal(r.task.spec!.importMs, 2400);
    let open!: () => void;
    r.runner.hold = new Promise<void>((res) => (open = res));
    r.save();
    await r.clock.advance(MANUAL_DEBOUNCE_MS);
    assert.equal(r.actions.queue.get(SPEC_ACTION_IDS.running)?.label, '$(sync~spin) running specs...');
    open();
    await r.ctrl.idle();
    assert.equal(r.actions.queue.has(SPEC_ACTION_IDS.running), false);
    assert.equal(r.runner.calls[1].opts.timeoutMs, 5000 + 2400);
  });
});

// ------------------------------------------------------------------ evidence and the hidden flow

describe('greens and hidden specs', () => {
  const allPass = { s1: { pass: true, actual: '{}' }, s2: { pass: true, actual: "{'a': 1, 'b': 1}" }, s3: { pass: true, actual: "'a'" } };

  test('a spec fixed within 3 saves of becoming the target gets weight 1; 4+ saves give .3', async () => {
    const r = await attached();
    r.runner.behaviour = { s1: { pass: false, actual: 'None' }, s2: { pass: false, actual: 'None' }, s3: { pass: false, actual: 'None' } };
    await r.run(); // s1 becomes the target
    await r.run();
    await r.run();
    r.runner.behaviour.s1 = { pass: true, actual: '{}' };
    await r.run(); // 3 saves after it went red
    assert.deepEqual(r.greens.map((g) => [g.id, g.weight]), [['s1', 1]]);
    for (let i = 0; i < 4; i++) await r.run(); // s2 red through 4 more saves
    r.runner.behaviour.s2 = { pass: true, actual: "{'a': 1, 'b': 1}" };
    await r.run();
    assert.deepEqual(r.greens.map((g) => [g.id, g.weight]), [['s1', 1], ['s2', 0.3]]);
    assert.equal(r.greens[1].info.savesSinceRed, 5);
    assert.equal(r.greens[1].info.number, 2);
    assert.ok(r.task.spec!.greenAt.s2 !== undefined && r.task.spec!.firstRedAt.s2 !== undefined);
  });

  test('assisted functions drop the green to .3; a regression and re-green records nothing new', async () => {
    const r = await attached({ task: { assistedFunctions: ['count_words'] } });
    r.runner.behaviour = { s1: { pass: true, actual: '{}' }, s2: { pass: false, actual: '{}' }, s3: { pass: false, actual: 'None' } };
    await r.run();
    assert.deepEqual(r.greens.map((g) => [g.id, g.weight, g.info.assisted]), [['s1', 0.3, true]]);
    r.runner.behaviour.s1 = { pass: false, actual: 'None' };
    await r.run();
    assert.deepEqual(r.updates.at(-1)!.turnedRed, ['s1']);
    r.runner.behaviour.s1 = { pass: true, actual: '{}' };
    await r.run();
    assert.equal(r.greens.length, 1);
    assert.deepEqual(r.updates.at(-1)!.turnedGreen, ['s1']);
  });

  test('all visible green runs the hidden specs: a failure shows the call and the actual value, then a pass completes', async () => {
    const r = await attached();
    r.runner.behaviour = { ...allPass, h1: { pass: false, actual: "{'': 1, 'a': 1, 'b': 1}" } };
    await r.run();
    assert.equal(r.allGreen, 1);
    assert.equal(r.runner.calls.length, 2, 'visible run, then the hidden run');
    assert.deepEqual(r.runner.calls[1].input.specs.map((s) => s.id), ['h1']);
    const h = r.hidden[0];
    assert.equal(h.pass, false);
    if (!h.pass) {
      assert.equal(h.card, "Passes your checks but not count_words('a  b'): you return {'': 1, 'a': 1, 'b': 1}. What did you assume about the input?");
      assert.ok(!h.card.includes("{'a': 1, 'b': 1}."), 'never the expected value');
    }
    assert.equal(r.task.spec!.overfit, true);
    r.runner.behaviour.h1 = { pass: true, actual: "{'a': 1, 'b': 1}" };
    await r.run();
    assert.equal(r.allGreen, 1, 'fires once per transition to all-green');
    assert.deepEqual(r.hidden.map((x) => x.pass), [false, true]);
    await r.run();
    assert.equal(r.hidden.length, 2, 'hidden specs do not run again after they passed');
  });

  test('no hidden specs: all visible green is a hidden pass at once', async () => {
    const r = await attached({ task: { spec: state({ hidden: [] }) } });
    r.runner.behaviour = allPass;
    await r.run();
    assert.deepEqual(r.hidden, [{ pass: true }]);
    assert.equal(r.runner.calls.length, 1);
  });
});

// ------------------------------------------------------------------ attach: consent, mapping, JIT

describe('attach', () => {
  test('applicable=false without consent: nothing runs until allowed', async () => {
    const r = rig();
    const res = await r.ctrl.attach(r.task, 'python', r.runner, { allowRun: false });
    assert.equal(res.applicable, false);
    assert.match(res.reason!, /consent/);
    assert.equal(r.ctrl.applicable, false);
    r.save();
    await r.clock.advance(1000);
    assert.equal(r.runner.calls.length, 0);
    r.ctrl.setAllowRun(true);
    r.runner.behaviour = { s1: { pass: true, actual: '{}' } };
    await r.run();
    assert.equal(r.runner.calls.length, 1);
  });

  test('no runtime, no specs, or a model-declared non-applicable ladder: applicable=false', async () => {
    const a = rig();
    assert.equal((await a.ctrl.attach(a.task, 'python', undefined, { allowRun: true })).applicable, false);
    const b = rig({ task: { spec: state({ applicable: false, reason: 'mainly UI' }) } });
    assert.deepEqual(await b.ctrl.attach(b.task, 'python', b.runner, { allowRun: true }).then((x) => [x.applicable, x.reason]), [false, 'mainly UI']);
    const c = rig({ runtime: { ...PY_RUNTIME, lang: 'javascript' } });
    assert.equal((await c.ctrl.attach(c.task, 'typescript', c.runner, { allowRun: true })).applicable, false);
  });

  test('interface mapping by arity rewrites the calls; several candidates means the design differs', async () => {
    const mapped = 'def count(text):\n    return {}\n\ndef top_word(counts):\n    return None\n';
    const r = await attached({ source: mapped });
    assert.deepEqual(r.task.interface.mappedNames, { count_words: 'count' });
    r.runner.behaviour = { s1: { pass: true, actual: '{}' } };
    await r.run();
    assert.deepEqual(r.runner.calls[0].input.specs.map((s) => s.call), ["count('')", "count('a b')", "top_word({'a': 2})"]);
    assert.deepEqual(r.runner.calls[0].input.functions, ['count', 'top_word']);
    assert.equal(r.task.spec!.specs[0].call, "count_words('')", 'stored specs keep the interface names');

    const amb = rig({ source: 'def a(x):\n    pass\n\ndef b(y):\n    pass\n' });
    const res = await amb.ctrl.attach(amb.task, 'python', amb.runner, { allowRun: true });
    assert.equal(res.applicable, false);
    assert.equal(res.reason, DESIGN_DIFFERS);
  });

  test("a file shared with an earlier task: that task's functions are never mapped by arity", async () => {
    const src = 'def parse_args(argv):\n    return {}\n\ndef main():\n    pass\n';
    const plain = rig({ source: src });
    await plain.ctrl.attach(plain.task, 'python', plain.runner, { allowRun: true });
    assert.deepEqual(plain.task.interface.mappedNames, { count_words: 'parse_args' }, 'what goes wrong without reserved names');
    const r = rig({ source: src });
    const res = await r.ctrl.attach(r.task, 'python', r.runner, { allowRun: true, reservedNames: ['parse_args'] });
    assert.equal(res.applicable, true);
    assert.deepEqual(r.task.interface.mappedNames ?? {}, {});
    assert.deepEqual(res.pending, ['count_words', 'top_word']);
  });

  test('design differs at attach; a save that writes the planned functions brings the ladder back', async () => {
    const r = rig({ source: 'def clean(s):\n    return s\n\ndef tokens(s):\n    return s.split()\n' });
    const changes: [boolean, string | undefined][] = [];
    r.ctrl.on.onApplicableChange = (a, why) => changes.push([a, why]);
    const res = await r.ctrl.attach(r.task, 'python', r.runner, { allowRun: true });
    assert.deepEqual([res.applicable, res.reason], [false, DESIGN_DIFFERS]);
    await r.run();
    assert.equal(r.runner.calls.length, 0, 'not applicable: nothing runs');
    r.fs.files.set(FILE, `${SOURCE}\ndef clean(s):\n    return s\n`);
    await r.run();
    assert.deepEqual(changes, [[true, undefined]]);
    assert.equal(r.ctrl.applicable, true);
    assert.equal(r.runner.calls.length, 1, 'the save that fixed it also runs the specs');
  });

  test('functions not written yet are pending, not a design difference', async () => {
    const r = await attached({ source: 'def count_words(text):\n    return {}\n\ndef main():\n    pass\n' });
    assert.deepEqual(r.updates.at(-1)!.pending, ['top_word']);
    assert.deepEqual(r.task.interface.mappedNames ?? {}, {});
  });

  test('JIT offer when the target changes to a weak concept; once more on the first save touching its function', async () => {
    const r = await attached({ p: { 'counting-with-dict': 0.9, 'string-split-join': 0.3, 'dict-iteration': 0.9 } });
    r.runner.behaviour = { s1: { pass: false, actual: 'None' } };
    await r.run();
    assert.equal(r.actions.queue.has(SPEC_ACTION_IDS.jit), false, 'P .9: no offer');
    r.runner.behaviour.s1 = { pass: true, actual: '{}' };
    r.runner.behaviour.s2 = { pass: false, actual: '{}' };
    await r.run();
    const jit = r.actions.queue.get(SPEC_ACTION_IDS.jit)!;
    assert.equal(jit.kind, 'jit-atom');
    assert.deepEqual(jit.args, ['string-split-join', 's2']);
    assert.match(jit.label, /^\$\(mortar-board\) next spec: pattern of string-spl/);
    r.actions.remove(SPEC_ACTION_IDS.jit); // the learner skipped it
    await r.run(); // unchanged function: no re-offer
    assert.equal(r.actions.queue.has(SPEC_ACTION_IDS.jit), false);
    r.fs.files.set(FILE, SOURCE.replace('    counts = {}', '    counts = {}\n    words = text.split()'));
    await r.run();
    assert.equal(r.actions.queue.has(SPEC_ACTION_IDS.jit), true, 're-offered on the first save touching count_words');
    r.actions.remove(SPEC_ACTION_IDS.jit);
    r.fs.files.set(FILE, SOURCE.replace('    counts = {}', '    counts = {}\n    words = text.split(" ")'));
    await r.run();
    assert.equal(r.actions.queue.has(SPEC_ACTION_IDS.jit), false, 'only once more');
  });

  test('gate-deferred gaps get a JIT offer whatever their P', async () => {
    const r = rig({ p: { 'counting-with-dict': 0.95 } });
    await r.ctrl.attach(r.task, 'python', r.runner, { allowRun: true, deferredConcepts: ['counting-with-dict'], announce: true });
    assert.equal(r.actions.queue.get(SPEC_ACTION_IDS.ready)?.label, '$(beaker) specs ready (3)');
    r.runner.behaviour = { s1: { pass: false, actual: 'None' } };
    await r.run();
    assert.equal(r.actions.queue.has(SPEC_ACTION_IDS.ready), false, "'specs ready' goes away on the first run");
    assert.equal(r.actions.queue.get(SPEC_ACTION_IDS.jit)?.args?.[0], 'counting-with-dict');
  });

  test('detach clears every surface and drops an in-flight result', async () => {
    const r = await attached();
    r.runner.behaviour = { s1: { pass: true, actual: '{}' }, s2: { pass: false, actual: "{'a b': 1}", sig: 0 } };
    await r.run();
    assert.ok(r.ann.gutters.length && r.ann.items.length && r.actions.queue.size);
    let open!: () => void;
    r.runner.hold = new Promise<void>((res) => (open = res));
    r.save();
    await r.clock.advance(MANUAL_DEBOUNCE_MS);
    const runs = r.task.spec!.runs;
    r.ctrl.detach();
    open();
    await flush();
    assert.equal(r.task.spec!.runs, runs, 'the in-flight result is dropped');
    assert.equal(r.ann.gutters.length, 0);
    assert.equal(r.ann.items.length, 0);
    assert.equal(r.actions.queue.size, 0);
    r.save();
    await r.clock.advance(1000);
    assert.equal(r.runner.calls.length, 2, 'detached: saves do nothing');
  });
});

// ------------------------------------------------------------------ pure helpers

describe('pure helpers', () => {
  test('functionsFromText gives def lines after decorators; mergeFunctionLocs prefers symbols and adds regex-only functions', () => {
    const py = '@cache\ndef f(a, b):\n    return a\n\nx = 1\n\ndef g():\n    pass\n';
    assert.deepEqual(functionsFromText(py, 'python').map((f) => [f.name, f.startLine, f.defLine, f.arity]), [['f', 0, 1, 2], ['g', 6, 6, 0]]);
    const js = 'export function a(x) {\n  return x;\n}\n\nconst b = (p, q) => p + q;\n';
    const merged = mergeFunctionLocs([{ name: 'a', kind: 'function', startLine: 0, endLine: 2, selectionLine: 0 }, { name: 'b', kind: 'other', startLine: 4, endLine: 4, selectionLine: 4 }], js, 'javascript');
    assert.deepEqual(merged.map((f) => [f.name, f.defLine, f.arity]), [['a', 0, 1], ['b', 4, 2]]);
  });

  test('resolveMapping keeps a valid earlier mapping and reports pending and ambiguous functions', () => {
    const iface = { file: 'x.py', functions: [{ name: 'parse_args', signature: 'parse_args(argv)', purpose: '' }, { name: 'run', signature: 'run(args, out)', purpose: '' }] };
    assert.deepEqual(resolveMapping(iface, [{ name: 'parse', arity: 1 }]), { mappedNames: { parse_args: 'parse' }, pending: ['run'], ambiguous: [] });
    assert.deepEqual(resolveMapping(iface, [{ name: 'p1', arity: 1 }, { name: 'p2', arity: 1 }, { name: 'run', arity: 2 }]).ambiguous, ['parse_args']);
    assert.deepEqual(resolveMapping(iface, [{ name: 'p1', arity: 1 }, { name: 'p2', arity: 1 }], { parse_args: 'p2' }).mappedNames, { parse_args: 'p2' });
  });

  test('testResults: passed, failed for the target only (with expected and actual), skipped after it', () => {
    const specs = state().specs;
    const outcome = {
      trigger: 'learner' as const, specs, file: FILE, functions: functionsFromText(SOURCE, 'python'), ms: 1, target: 's2', display: {},
      report: { results: [], timedOut: false, finished: true },
      results: { s1: { id: 's1', pass: true, actual: '{}' }, s2: { id: 's2', pass: false, actual: '{}' }, s3: { id: 's3', pass: false, actual: 'None' } },
    };
    const out = testResults(outcome, specs);
    assert.deepEqual(out.map((p) => p.kind), ['passed', 'failed', 'skipped']);
    const f = out[1];
    assert.ok(f.kind === 'failed' && f.expected === "{'a': 1, 'b': 1}" && f.actual === '{}' && f.line === 0);
  });

  test('tsImportCaveat only on Node 22.6-22.14 with relative imports', () => {
    const rt = { lang: 'typescript' as const, version: 'v22.12.0', tsMode: 'strip' as const, permissionFlag: '--experimental-permission' };
    assert.equal(tsImportCaveat(rt, "export function f() { return 1; }"), undefined);
    assert.match(tsImportCaveat(rt, "import { g } from './g.js';\n")!, /22\.15/);
    assert.equal(tsImportCaveat({ ...rt, version: 'v22.15.0' }, "import { g } from './g.js';\n"), undefined);
    assert.equal(tsImportCaveat({ ...rt, tsMode: 'tsx' }, "import { g } from './g.js';\n"), undefined);
  });

  test('specFileName is a safe single path segment', () => {
    assert.equal(specFileName('task-1'), 'task-1.json');
    assert.ok(/^[\w-][\w.-]*\.json$/.test(specFileName('../../evil/x')));
    assert.ok(!specFileName('a/b\\c:d').includes('/'));
  });
});

// ------------------------------------------------------------------ the real harness (skipped without a runtime)

describe('SpecController with LocalRunner and the real harness', () => {
  const ROOT = path.resolve(__dirname, '..');
  let work = '';
  const rts: { python?: DetectedRuntime; javascript?: DetectedRuntime } = {};
  before(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'dlb-specctl-'));
    const pinned = process.env.DELIBERATE_PYTHON;
    const o = { cwd: work };
    [rts.python, rts.javascript] = await Promise.all([
      detectPython(pinned ? [{ bin: pinned, source: 'DELIBERATE_PYTHON' }, ...PATH_PYTHON_CANDIDATES] : PATH_PYTHON_CANDIDATES, o),
      detectNode(o),
    ]);
  });
  after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 }));

  const cases = {
    python: {
      file: 'wc.py',
      text: "from collections import Counter\n\nSEEN = Counter()\n\n\ndef count_words(text):\n    return dict(Counter(text.split(' ')))\n\n\nif __name__ == '__main__':\n    print(count_words(input()))\n",
      fixed: "from collections import Counter\n\nSEEN = Counter()\n\n\ndef count_words(text):\n    return dict(Counter(text.split()))\n",
      specs: [spec('s1', "count_words('')", '{}'), spec('s2', "count_words('a b a')", "{'a': 2, 'b': 1}"), spec('s3', "count_words('x')", "{'x': 1}")],
      hidden: [spec('h1', "count_words('a  b')", "{'a': 1, 'b': 1}")],
      fn: 'count_words(text) -> dict',
    },
    javascript: {
      file: 'wc.mjs',
      text: "export function countWords(text) {\n  const out = {};\n  for (const w of text.split(' ')) out[w] = (out[w] ?? 0) + 1;\n  return out;\n}\n",
      fixed: "export function countWords(text) {\n  const out = {};\n  for (const w of text.split(/\\s+/).filter(Boolean)) out[w] = (out[w] ?? 0) + 1;\n  return out;\n}\n",
      specs: [spec('s1', "countWords('')", '{}'), spec('s2', "countWords('a b a')", '{"a": 2, "b": 1}'), spec('s3', "countWords('x')", '{"x": 1}')],
      hidden: [spec('h1', "countWords('a  b')", '{"a": 1, "b": 1}')],
      fn: 'countWords(text)',
    },
  } as const;

  for (const lang of ['python', 'javascript'] as const) {
    test(`${lang}: a save runs the harness, reports the target, then the hidden specs`, { timeout: 60_000 }, async (t) => {
      const rt = rts[lang];
      if (!rt) return t.skip(`no ${lang} runtime`);
      const c = cases[lang];
      const ws = fs.mkdtempSync(path.join(work, `ws-${lang}-`));
      const file = path.join(ws, c.file);
      fs.writeFileSync(file, c.text);
      const runner = new LocalRunner(rt, { runnerDir: path.join(ROOT, 'media', 'runner'), runRoot: path.join(work, 'run') });
      const ann = new FakeAnnotations();
      const actions = new FakeActions();
      const greens: string[] = [];
      const hidden: HiddenResult[] = [];
      const ctrl = new SpecController({
        annotations: ann, actions, harnessDir: path.join(ROOT, 'media', 'harness'), specDir: path.join(work, 'storage', 'specs'),
        workspaceDir: () => ws, uriOf, readText: async (p) => fs.readFileSync(p, 'utf8'),
        on: { onGreen: (id) => greens.push(id), onHiddenResult: (h) => hidden.push(h) },
      });
      const task: SpecTask = {
        id: `real-${lang}`, fade: 'full', spec: state({ specs: [...c.specs], hidden: [...c.hidden] }),
        interface: { file: c.file, functions: [{ name: c.fn.split('(')[0], signature: c.fn, purpose: '' }] },
      };
      const res = await ctrl.attach(task, lang, runner, { allowRun: true });
      assert.equal(res.applicable, true, res.reason);
      const first = await ctrl.runNow();
      assert.ok(first, 'ran');
      assert.equal(first.report.loadError, undefined, JSON.stringify(first.report));
      // ''.split(' ') is [''] in both languages: s1 is the target and the only failure.
      assert.equal(first.target, 's1', JSON.stringify(first.results));
      assert.deepEqual(first.display, { s1: 'failed', s2: 'passed', s3: 'passed' });
      assert.match(first.results.s1.actual ?? '', /''|""/);
      assert.deepEqual(greens, ['s2', 's3']);
      assert.deepEqual(ann.gutters.map((g) => [g.line, g.kind]), [[lang === 'python' ? 5 : 0, 'fail']]);
      assert.ok(fs.existsSync(path.join(work, 'storage', 'specs', specFileName(task.id))), 'spec JSON in storage');
      assert.deepEqual(fs.readdirSync(ws), [c.file], 'nothing written into the workspace');
      fs.writeFileSync(file, c.fixed);
      const second = await ctrl.runNow();
      assert.equal(second?.target, undefined, JSON.stringify(second?.results));
      assert.deepEqual(greens, ['s2', 's3', 's1']);
      assert.deepEqual(hidden, [{ pass: true }], 'all visible green ran the hidden spec, which passes');
      ctrl.dispose();
    });
  }
});
