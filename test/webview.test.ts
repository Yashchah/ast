// The sidebar script (media/main.js) runs in a vm sandbox with a minimal fake DOM and is fed view
// models typed against the real Coach.viewModel() (so a shape change in the coach breaks this test at
// compile time). Checks the busy semantics, the compact log, the task card, the Roadmap and the
// Progress tab, and that inline style attributes never appear (the CSP blocks them).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import type { Coach } from '../src/coach';
import type { PaceExtras } from '../src/shell';

type ViewModel = ReturnType<Coach['viewModel']>;
type State = ViewModel & { shell: { pace?: PaceExtras; execution?: string } };

/** Objects made inside the vm have another realm's prototypes: compare plain copies. */
const plain = (x: unknown): unknown => JSON.parse(JSON.stringify(x));

const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');

class FakeElement {
  hidden = false;
  textContent = '';
  value = '';
  placeholder = '';
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  readonly classList = {
    toggle: (c: string, on?: boolean) => {
      const has = this.classes.has(c);
      const want = on ?? !has;
      if (want) this.classes.add(c);
      else this.classes.delete(c);
      return want;
    },
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  private readonly classes = new Set<string>();
  private html = '';
  focused = false;
  constructor(readonly id: string) {}
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(v: string) {
    this.html = String(v);
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  addEventListener(): void {}
  querySelector(): null {
    return null;
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
  closest(sel: string): FakeElement | null {
    if (sel === 'button' && this.attrs.has('button')) return this;
    if (sel === '[data-log]' && this.attrs.has('data-log')) return this;
    return null;
  }
  focus(): void {
    this.focused = true;
  }
  scrollIntoView(): void {}
  get lastElementChild(): null {
    return null;
  }
}

function boot() {
  const elements = new Map<string, FakeElement>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id)!;
  };
  const docHandlers: Record<string, ((e: unknown) => void)[]> = {};
  const winHandlers: Record<string, ((e: unknown) => void)[]> = {};
  const sent: Record<string, unknown>[] = [];
  let saved: unknown;
  const sandbox = {
    acquireVsCodeApi: () => ({ getState: () => saved, setState: (s: unknown) => (saved = s), postMessage: (m: Record<string, unknown>) => sent.push(m) }),
    document: {
      getElementById: get,
      querySelectorAll: () => [],
      addEventListener: (k: string, h: (e: unknown) => void) => (docHandlers[k] ??= []).push(h),
    },
    window: { addEventListener: (k: string, h: (e: unknown) => void) => (winHandlers[k] ??= []).push(h) },
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(script, sandbox, { filename: 'main.js' });
  return {
    el: get,
    sent,
    state: (s: State) => winHandlers.message.forEach((h) => h({ data: { type: 'state', state: s } })),
    status: (s: ViewModel['status']) => winHandlers.message.forEach((h) => h({ data: { type: 'status', status: s } })),
    message: (data: unknown) => winHandlers.message.forEach((h) => h({ data })),
    click: (attrs: Record<string, string>) => {
      const b = new FakeElement('clicked');
      b.setAttribute('button', '1');
      for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
      docHandlers.click.forEach((h) => h({ target: b }));
    },
  };
}

const status = (over: Partial<ViewModel['status']> = {}): ViewModel['status'] => ({
  busy: undefined, background: { running: 0, queued: 0, used: 3, limit: 20, pausedUntil: undefined }, practiceWhileWaiting: false,
  taskTitle: 'Count words', phase: 'building', activeMin: 6.5, estimate: 10, hints: 1,
  stuck: { score: 0.7, minutes: 4, threshold: 7, reasons: ['same error for 3 min'], since: 'spec 1 green' },
  ...over,
});

function building(over: Partial<State> = {}): State {
  return {
    hasProject: true,
    project: {
      title: 'Word counter CLI', goal: 'A CLI that counts words', language: 'python', summary: 's', planPending: false, planError: undefined,
      placement: { done: true, running: false, summary: '11 items' },
      milestones: [
        { title: 'Basics', goal: 'Count words', preparing: false, tasks: [
          { id: 't1', title: 'Split lines', status: 'done', kind: 'roadmap', current: false, depth: 0, solo: false },
          { id: 't2', title: 'Count words', status: 'active', kind: 'roadmap', current: true, depth: 0, solo: false },
          { id: 't3', title: 'Top words', status: 'todo', kind: 'roadmap', current: false, depth: 0, solo: true },
        ] },
        { title: 'Files', goal: 'Read files', preparing: true, tasks: [] },
      ],
    },
    task: {
      id: 't2', title: 'Count words', phase: 'building', kind: 'roadmap', solo: false, fade: 'full',
      interface: 'Write in counter.py: count_words(text) -> dict',
      ladder: {
        titles: [
          { id: 's1', title: 'empty text gives {}', display: 'passed' },
          { id: 's2', title: 'counts repeated words', display: 'failed' },
          { id: 's3', title: 'ignores case', display: 'not-yet' },
        ],
        summary: '1 of 3 behaviours pass', passed: 1, total: 3, next: 'counts repeated words', target: undefined,
      },
      specsApplicable: true, notUnderstood: false,
    },
    feed: [
      { id: 'c1', at: Date.now(), kind: 'task', title: 'Task 2: Count words', html: '<p>Build it</p>' },
      { id: 'c2', at: Date.now(), kind: 'log', title: 'Atom', html: '<p>Slice a sequence: Unknown -> Learning (41s)</p>' },
      { id: 'c3', at: Date.now(), kind: 'error', title: 'Roadmap failed', html: '<p>x</p>', actions: [{ label: 'Retry', command: 'retryPlan', primary: true }] },
    ],
    input: { mode: 'building', placeholder: 'Ask', submitLabel: 'Ask', extras: [{ label: "I'm stuck", command: 'hint' }, { label: 'Teach me', command: 'teach' }, { label: 'Run my specs', command: 'checkWork' }] },
    status: status(),
    progress: {
      concepts: [
        { id: 'list-slicing', name: 'Slice a sequence', mastery: 0.42, chip: 'Misconception', inferred: false, tested: true, attempts: 1, hints: 0, mastered: false, avgMin: null, trend: null, due: false, fragile: false,
          misconceptions: [{ id: 'slice-end-included', belief: 'The slice includes the item at the stop index', status: 'active', p: 0.7 }] },
        { id: 'loops', name: 'Loop with an accumulator', mastery: 0.9, chip: 'Solid', inferred: true, tested: false, attempts: 0, hints: 0, mastered: true, avgMin: 6, trend: -0.3, due: true, fragile: false, misconceptions: [] },
      ],
      mistakes: [],
      totals: { tasksDone: 1, hintsUsed: 1, reveals: 0, activeMinutes: 14 },
      deck: [
        { conceptId: 'list-slicing', name: 'Slice a sequence', kind: 'shape', useWhen: 'you need part of a list', template: 'xs[<start>:<stop>]', rule: '', pitfall: 'stop is excluded' },
        { conceptId: 'alias-copy', name: 'Copy before changing', kind: 'semantics', useWhen: 'two names, one list', template: '', rule: 'Assignment shares the list', pitfall: '' },
      ],
      calibration: { sure: [8, 10], guess: [1, 3], text: 'flagged guesses right 33% / sure answers right 80%' },
      audits: { passed: 2, failed: 1, falseMastery: 1 },
      pace: {
        milestones: [{ title: 'Basics', tasksDone: 1, activeMin: 14, waitSec: 3 }], solo: [{ title: 'Top words', activeMin: 12, unaided: true }],
        bitsPerTask: 1.4, prefetchedHints: 0.75, placement: { items: 11, summary: 's' }, conflictFlags: 0, overfitFlags: 1, deadlineMisses: 0,
      },
    },
    shell: {
      pace: { firstKeystrokeSec: 200, blocks: { known: { count: 2, medianSec: 25 }, misconception: { count: 1, medianSec: 80 }, unknown: { count: 0 } }, waitPerTaskSec: 3, solo: { count: 1, unaided: 1, rate: 1, medianMin: 12 } },
      execution: 'Local execution: snippets and your code (Python 3.14.0).',
    },
    ...over,
  };
}

test('webview: the onboarding copy shows until a project exists, then the form resets', () => {
  const w = boot();
  assert.deepEqual(plain(w.sent[0]), { type: 'ready' });
  const s = building({ hasProject: false, project: undefined, task: undefined, feed: [], input: { mode: 'none', placeholder: '', submitLabel: '', extras: [] } });
  w.state(s);
  const ob = w.el('onboarding').innerHTML;
  assert.match(ob, /I plan your roadmap \(~1-2 min\) while you answer ~10 quick predict-the-output checks in the editor\. No essays\./);
  assert.match(ob, /Quick checks, 1-minute fixes/);
  assert.match(ob, /Specs turn green as you build/);
  assert.doesNotMatch(ob, /Explain first|3-minute lesson|~5 minutes/);
  assert.equal(w.el('main').hidden, true);
  w.state(building());
  assert.equal(w.el('main').hidden, false);
  assert.equal(w.el('onboarding').innerHTML, '', 'the form is reset once a project exists');
});

test('webview: the task card shows the interface and the spec ladder; the feed is a compact log', () => {
  const w = boot();
  w.state(building());
  const st = w.el('status').innerHTML;
  assert.match(st, /Write in counter\.py: count_words\(text\) -&gt; dict/);
  assert.match(st, /spec-passed[\s\S]*empty text gives \{\}/);
  assert.match(st, /spec-failed[\s\S]*counts repeated words/);
  assert.match(st, /data-w="33/);
  const feed = w.el('feed').innerHTML;
  assert.match(feed, /<article class="log" data-log="c2"/);
  assert.match(feed, /<article class="card kind-task">/);
  assert.match(feed, /data-command="retryPlan"/);
  for (const id of ['status', 'feed', 'tab-roadmap', 'tab-progress', 'composer-buttons']) assert.doesNotMatch(w.el(id).innerHTML, /style=/, `${id}: no inline styles (CSP)`);
  assert.equal(w.el('mode-label').textContent, 'Building: ask anything');
});

test('webview: busy disables only foreground actions and shows background work and the practice button', () => {
  const w = boot();
  w.state(building({ status: status({ busy: 'Thinking', background: { running: 1, queued: 2, used: 5, limit: 20, pausedUntil: undefined }, practiceWhileWaiting: true }) }));
  assert.equal(w.el('busy').hidden, false);
  assert.equal(w.el('busy-label').textContent, 'Thinking…');
  assert.match(w.el('bg-label').textContent, /3 preparing in background/);
  assert.equal(w.el('pww').hidden, false);
  const buttons = w.el('composer-buttons').innerHTML;
  assert.match(buttons, /data-submit="1" data-fg="1"/, 'Ask waits for the foreground call');
  assert.match(buttons, /data-command="teach"[^>]*data-fg="1"/, 'Teach may need a foreground mini atom');
  assert.doesNotMatch(buttons, /data-command="hint"[^>]*data-fg/, 'hints are never blocked');
  assert.doesNotMatch(buttons, /data-command="checkWork"[^>]*data-fg/, 'running specs is local');
  // A click on a foreground action while busy sends nothing; a local one goes through.
  w.sent.length = 0;
  w.click({ 'data-command': 'reveal' });
  w.click({ 'data-command': 'hint' });
  assert.deepEqual(plain(w.sent), [{ type: 'command', command: 'hint' }]);
  // Without specs, Check my work is a foreground review.
  const noSpecs = building();
  noSpecs.task = { ...noSpecs.task!, specsApplicable: false };
  noSpecs.input = { ...noSpecs.input, extras: [{ label: 'Check my work', command: 'checkWork' }] };
  w.state({ ...noSpecs, status: status({ busy: 'Reviewing' }) });
  assert.match(w.el('composer-buttons').innerHTML, /data-command="checkWork"[^>]*data-fg="1"/);
  // Background work alone: no foreground label, but the count shows.
  w.status(status({ background: { running: 0, queued: 1, used: 5, limit: 20, pausedUntil: undefined } }));
  assert.equal(w.el('busy-label').textContent, '');
  assert.match(w.el('bg-label').textContent, /^1 preparing in background$/);
  w.status(status());
  assert.equal(w.el('busy').hidden, true);
});

test('webview: mode labels (input.label wins), roadmap, and the Progress tab', () => {
  const w = boot();
  w.state(building({ input: { mode: 'atom', placeholder: 'Ask', submitLabel: 'Ask', extras: [] } }));
  assert.equal(w.el('mode-label').textContent, 'Practice open in the editor');
  w.state(building({ input: { mode: 'gate', placeholder: 'p', submitLabel: 'Submit plan', extras: [] } }));
  assert.equal(w.el('mode-label').textContent, 'Answer in the popup (or explain your own plan)');
  assert.match(w.el('composer-buttons').innerHTML, /data-ask="1"/, 'Ask instead in the plan modes');
  w.state(building({ input: { mode: 'atom', placeholder: 'Ask', submitLabel: 'Ask', extras: [], label: 'Practice is open in the editor (Esc Esc to leave)' } }));
  assert.equal(w.el('mode-label').textContent, 'Practice is open in the editor (Esc Esc to leave)');

  const road = w.el('tab-roadmap').innerHTML;
  assert.match(road, /Sprint \(3 min\)/);
  assert.doesNotMatch(road, /Speed drill/);
  assert.match(road, /pill solo/);
  assert.match(road, /preparing tasks/);

  const prog = w.el('tab-progress').innerHTML;
  assert.match(prog, /chip chip-misconception/);
  assert.match(prog, /chip chip-solid/);
  assert.match(prog, /inferred/);
  assert.match(prog, /The slice includes the item at the stop index/);
  assert.match(prog, /Pattern Deck/);
  assert.match(prog, /xs\[&lt;start&gt;:&lt;stop&gt;\]/);
  assert.match(prog, /Assignment shares the list/);
  assert.match(prog, /flagged guesses right 33% \/ sure answers right 80%/);
  assert.match(prog, /Mastery audits: 2 passed, 1 failed \(1 revoked\)/);
  assert.match(prog, /Start to first keystroke[\s\S]*3 min 20 s/);
  assert.match(prog, /Concept block, known[\s\S]*25 s/);
  assert.match(prog, /Concept block, misconception[\s\S]*warm-text">80 s/, 'over the 70 s target');
  assert.match(prog, /Model wait per task[\s\S]*3 s/);
  assert.match(prog, /Solo tasks[\s\S]*1 done[\s\S]*100% unaided/);
  assert.match(prog, /Hints ready before you asked[\s\S]*75%/);
  assert.match(prog, /Local execution: snippets and your code/);
  assert.match(prog, /data-command="chooseExecution"/);
});

test('webview: plan states, focusComposer and tab switches', () => {
  const w = boot();
  const s = building({ task: undefined, status: status({ taskTitle: undefined, phase: undefined }) });
  s.project = { ...s.project!, planPending: true };
  w.state(s);
  assert.match(w.el('status').innerHTML, /Designing your roadmap/);
  s.project = { ...s.project!, planPending: true, planError: 'usage limit' };
  w.state(s);
  assert.match(w.el('status').innerHTML, /Roadmap failed: usage limit[\s\S]*data-command="retryPlan"/);
  w.sent.length = 0;
  w.click({ 'data-tab': 'progress' });
  assert.deepEqual(plain(w.sent), [{ type: 'tab', tab: 'progress' }]);
  w.message({ type: 'focusComposer', mode: 'explain' });
  assert.equal(w.el('input').focused, true);
});
