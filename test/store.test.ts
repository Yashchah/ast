import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceRecord } from '../src/evidence';
import { emptyLearner, EvidenceInput, recordEvidence, recordMistake, upsertConcepts } from '../src/learner';
import { EvidenceFs, evidenceFile, Memento, Store } from '../src/store';
import { Learner } from '../src/types';

const LEARNER_KEY = 'deliberate.learner.v1';
const T0 = Date.UTC(2026, 0, 31, 23, 0, 0);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** globalState shared by every window, stored as JSON like the real storage. */
class SharedMemento implements Memento {
  data = new Map<string, string>();
  get<T>(key: string): T | undefined {
    const v = this.data.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, JSON.stringify(value));
  }
}

class MemFs implements EvidenceFs {
  files = new Map<string, string>();
  async append(name: string, text: string): Promise<void> {
    this.files.set(name, (this.files.get(name) ?? '') + text);
  }
  async read(name: string): Promise<string | undefined> {
    return this.files.get(name);
  }
  async clear(): Promise<void> {
    for (const k of [...this.files.keys()]) if (k.startsWith('evidence-')) this.files.delete(k);
  }
}

function twoWindows(seed?: (l: Learner) => void) {
  const globalState = new SharedMemento();
  const fs = new MemFs();
  const l = emptyLearner();
  upsertConcepts(l, [{ id: 'loops', name: 'Loops' }, { id: 'lists', name: 'Lists' }], 1);
  seed?.(l);
  void globalState.update(LEARNER_KEY, l);
  const open = (windowId: string) => new Store({ globalState, workspaceState: new SharedMemento() }, { fs, windowId });
  return { globalState, fs, a: open('A'), b: open('B') };
}

const stored = (m: SharedMemento) => m.get<Learner>(LEARNER_KEY)!;
const predict = (conceptId: string, over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  conceptId, kind: 'predict', source: 'atom', correct: true, g: 0.06, at: T0, ...over,
});

test('two windows writing different concepts both survive a flush, in either order', async () => {
  for (const order of ['ab', 'ba']) {
    const { globalState, fs, a, b } = twoWindows();
    recordEvidence(a.learner, predict('loops', { siblingGroup: 'names' }));
    recordEvidence(b.learner, predict('lists', { correct: false }));
    const [first, second] = order === 'ab' ? [a, b] : [b, a];
    await first.flush();
    await second.flush();

    const s = stored(globalState);
    assert.equal(r3(s.concepts.loops.mastery), 0.734, `${order}: A's concept survives`);
    assert.equal(r3(s.concepts.lists.mastery), 0.113, `${order}: B's concept survives`);
    assert.deepEqual(s.calibration.sure, [1, 2], 'counters add both windows');
    assert.equal(s.gradedCount, 2);

    // The window that flushed first picks the other's work up on its next flush, losing nothing.
    await first.flush();
    for (const w of [a, b]) {
      assert.equal(r3(w.learner.concepts.loops.mastery), 0.734);
      assert.equal(r3(w.learner.concepts.lists.mastery), 0.113);
    }
    assert.deepEqual(stored(globalState).calibration.sure, [1, 2], 'a re-flush does not double count');

    const lines = (fs.files.get(evidenceFile(T0)) ?? '').trim().split('\n').map((x) => JSON.parse(x) as EvidenceRecord);
    assert.deepEqual(lines.map((e) => e.window).sort(), ['A', 'B']);
  }
});

test('a flush keeps the identity of the learner and its concepts, so references held across an await stay live', async () => {
  const { globalState, a, b } = twoWindows();
  const learnerRef = a.learner;
  const loopsRef = a.learner.concepts.loops;
  recordEvidence(a.learner, predict('loops', { correct: false, misconceptionId: 'm', misconceptionOdds: 3, siblingGroup: 'x' }));
  const misRef = loopsRef.misconceptions.m;
  recordEvidence(b.learner, predict('loops'));
  await b.flush();
  await a.flush(); // conflict on loops: rebuilt from B's version plus A's evidence
  assert.equal(a.learner, learnerRef);
  assert.equal(a.learner.concepts.loops, loopsRef);
  assert.equal(a.learner.concepts.loops.misconceptions.m, misRef);
  assert.equal(a.learner.concepts.loops.groupsCorrect.length, 0, 'B answered without a sibling group');
  assert.ok(loopsRef.tested && misRef.p > 0.15);
  loopsRef.lessonsSeen += 1; // a write through the old reference after the flush
  await a.flush();
  assert.equal(stored(globalState).concepts.loops.lessonsSeen, 1);
});

test('two windows changing the same concept: the later flush replays its own evidence on top', async () => {
  const { globalState, a, b } = twoWindows();
  recordEvidence(a.learner, predict('loops', { siblingGroup: 'names' }));
  recordEvidence(b.learner, predict('loops', { correct: false, siblingGroup: 'story', at: T0 + 1000 }));
  await a.flush();
  await b.flush();

  // Reference: one window seeing both answers in order.
  const ref = emptyLearner();
  upsertConcepts(ref, [{ id: 'loops', name: 'Loops' }]);
  recordEvidence(ref, predict('loops', { siblingGroup: 'names' }));
  recordEvidence(ref, predict('loops', { correct: false, siblingGroup: 'story', at: T0 + 1000 }));

  const s = stored(globalState);
  assert.equal(r3(s.concepts.loops.mastery), r3(ref.concepts.loops.mastery));
  assert.deepEqual(s.concepts.loops.groupsCorrect, ['names']);
  assert.equal(s.concepts.loops.lastWrongAt, T0 + 1000);
  assert.deepEqual(s.calibration.sure, [1, 2]);

  await a.flush();
  assert.equal(r3(a.learner.concepts.loops.mastery), r3(ref.concepts.loops.mastery));
});

test('propagation from one window reaches a concept the other window changed', async () => {
  const { globalState, a, b } = twoWindows((l) => {
    upsertConcepts(l, [{ id: 'nested', name: 'Nested', prerequisites: ['loops'] }], 1);
  });
  recordEvidence(a.learner, predict('loops', { correct: null })); // A changes loops directly ('?')
  recordEvidence(b.learner, predict('nested'));
  await a.flush();
  await b.flush();
  const s = stored(globalState);
  assert.equal(s.concepts.loops.tested, true, "A's direct evidence on loops survives");
  assert.deepEqual(s.concepts.loops.supportFrom, ['nested'], "B's support lands on A's version of loops");
  assert.ok(s.concepts.loops.mastery >= 0.75);
});

test('mistakes keyed by misconception id merge their counts across windows', async () => {
  const { globalState, a, b } = twoWindows();
  const m = { pattern: 'slice end included', detail: 'd', conceptIds: ['lists'], taskId: 't', misconceptionId: 'slice-end-inclusive' };
  recordMistake(a.learner, m);
  recordMistake(b.learner, { ...m, conceptIds: ['loops'] });
  recordMistake(b.learner, m);
  await a.flush();
  await b.flush();
  const s = stored(globalState);
  assert.equal(s.mistakes.length, 1);
  assert.equal(s.mistakes[0].count, 3);
  assert.deepEqual([...s.mistakes[0].conceptIds].sort(), ['lists', 'loops']);
});

test('the log is append-only JSONL per month; readEvidence skips torn lines', async () => {
  const { fs, a } = twoWindows();
  recordEvidence(a.learner, predict('loops'));
  recordEvidence(a.learner, predict('lists', { at: T0 + 2 * 3600_000 })); // next UTC month
  await a.flushLog();
  assert.deepEqual([...fs.files.keys()].sort(), ['evidence-2026-01.jsonl', 'evidence-2026-02.jsonl']);
  await fs.append('evidence-2026-01.jsonl', '{"id":"torn","at":');
  const evs = await a.readEvidence(T0 - 1, T0 + 3 * 3600_000);
  assert.deepEqual(evs.map((e) => e.conceptId), ['loops', 'lists']);
  assert.ok(evs.every((e) => e.window === 'A' && typeof e.bits === 'number'));
});

test('erasing the profile in one window is adopted by the other and deletes the log', async () => {
  const { globalState, fs, a, b } = twoWindows();
  recordEvidence(a.learner, predict('loops'));
  recordEvidence(b.learner, predict('lists'));
  await a.flushLog();
  await a.resetLearner();
  assert.equal(fs.files.size, 0);
  await b.flush();
  assert.deepEqual(Object.keys(b.learner.concepts), []);
  assert.deepEqual(Object.keys(stored(globalState).concepts), []);
  // B keeps working on the fresh profile.
  upsertConcepts(b.learner, [{ id: 'loops', name: 'Loops' }]);
  recordEvidence(b.learner, predict('loops'));
  await b.flush();
  await a.flush();
  assert.equal(r3(a.learner.concepts.loops.mastery), 0.734);
});

test('a v0.1 profile in globalState is migrated on load', () => {
  const globalState = new SharedMemento();
  void globalState.update(LEARNER_KEY, {
    concepts: {
      loops: { id: 'loops', name: 'Loops', description: '', prerequisites: [], mastery: 0.66, attempts: 3, hintsUsed: 0, lessonsSeen: 0, lastPracticed: 5, nextReview: 0, intervalDays: 0, solveTimesMin: [] },
    },
    mistakes: [],
    totals: { tasksDone: 3, hintsUsed: 0, reveals: 0, activeMinutes: 40 },
  });
  const s = new Store({ globalState, workspaceState: new SharedMemento() }, { fs: new MemFs(), windowId: 'A' });
  assert.equal(s.learner.concepts.loops.mastery, 0.66);
  assert.equal(s.learner.concepts.loops.tested, true);
  assert.deepEqual(s.learner.concepts.loops.misconceptions, {});
  assert.equal(s.learner.cps, 2.5);
});
