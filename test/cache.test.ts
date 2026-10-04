import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredAtom, StoredCompletion, StoredContrast, StoredExample, StoredMutant, StoredProbe } from '../src/contracts';
import {
  AtomCache, ITEM_CAP, LOW_STOCK, isRetired, mergeAtoms, precision, type AtomCacheData, type AtomCachePersistence,
} from '../src/atoms/cache';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function mut(id: string, misconceptionId: string, over: Partial<StoredMutant> = {}): StoredMutant {
  return {
    id, misconceptionId, belief: 'b', refutation: 'r', rule: 'x', code: 'print(2)', output: { stdout: '2\n', values: [] },
    diffLine: 1, source: 'model', ambiguous: false, matches: 0, confirmations: 0, rejections: 0, ...over,
  };
}

function probe(id: string, group: string, over: Partial<StoredProbe> = {}): StoredProbe {
  return {
    id, group, code: `print('${id}')`, output: { stdout: `${id}\n`, values: [] }, parSec: 5, answerSpaceG: 0.06, constructs: [],
    discriminating: true, mutants: [mut(`${id}~slice-end-included`, 'slice-end-included')], stats: { seenAt: [], n: 0, nCorrect: 0 }, ...over,
  };
}

const example = (id: string, group = `x:${id}`): StoredExample => ({ id, group, code: 'print(1)', subgoals: [], output: { stdout: '1\n', values: [] } });
const completion = (id: string): StoredCompletion => ({ id, group: `c:${id}`, code: 'def f(): return [[1]]', solutions: ['1'], wrongFills: [], harness: '', parSec: 30, stats: { seenAt: [], n: 0, nCorrect: 0 } });
const contrast = (id: string): StoredContrast => ({ id, wrong: 'a', right: 'b', wrongOutput: { stdout: 'a', values: [] }, rightOutput: { stdout: 'b', values: [] }, misconceptionId: 'm', rule: 'r' });

function atomOf(probes: StoredProbe[], over: Partial<StoredAtom> = {}): StoredAtom {
  return {
    key: 'list-slicing', lang: 'python', conceptId: 'list-slicing', tag: 'list-slicing', source: 'model', verified: true, createdAt: T0,
    pattern: { kind: 'shape', name: 'Slice a sequence', useWhen: 'u', template: 't', rule: '', howItRuns: '', pitfall: 'p', useCases: ['a', 'b'] },
    probes, examples: [], completions: [], contrasts: [], tracebacks: [], ...over,
  };
}

function setup(io?: AtomCachePersistence) {
  const clock = { now: T0 };
  const cache = new AtomCache('python', io, { now: () => clock.now, debounceMs: -1 });
  return { cache, clock };
}

/** A shared fake file for two simulated windows. */
function fakeFile() {
  const file: { data?: AtomCacheData; saves: number } = { saves: 0 };
  const io: AtomCachePersistence = {
    load: async () => (file.data ? structuredClone(file.data) : undefined),
    save: async (d) => {
      file.data = structuredClone(d);
      file.saves++;
    },
  };
  return { file, io };
}

describe('AtomCache basics', () => {
  test('put and get round-trip; get returns a copy', () => {
    const { cache } = setup();
    cache.put(atomOf([probe('a', 'g1')]));
    const a = cache.get('list-slicing')!;
    assert.equal(a.probes.length, 1);
    a.probes[0].stats.n = 99;
    a.probes.pop();
    assert.equal(cache.get('list-slicing')!.probes[0].stats.n, 0);
    assert.deepEqual(cache.keys(), ['list-slicing']);
    assert.equal(cache.get('nope'), undefined);
    assert.throws(() => cache.put(atomOf([], { lang: 'javascript' })), /is javascript/);
  });

  test('a second put merges by item id: new items are added, known ones keep their stats', () => {
    const { cache, clock } = setup();
    cache.put(atomOf([probe('a', 'g1'), probe('b', 'g2')]));
    cache.markSeen('list-slicing', 'a');
    cache.recordItemStat('list-slicing', 'a', true, 4000);
    clock.now += 1000;
    cache.put(atomOf([probe('a', 'g1'), probe('c', 'g3')], { createdAt: T0 + 1000, pattern: { ...atomOf([]).pattern, name: 'New name', useCases: ['c', 'a'] } }));
    const a = cache.get('list-slicing')!;
    assert.deepEqual(a.probes.map((p) => p.id), ['a', 'b', 'c']);
    assert.deepEqual(a.probes[0].stats, { seenAt: [T0], n: 1, nCorrect: 1, medianMs: 4000 });
    assert.equal(a.pattern.name, 'New name');
    assert.deepEqual(a.pattern.useCases, ['c', 'a', 'b']);
  });

  test('a verified atom replaces an unverified one, never the other way round', () => {
    const { cache } = setup();
    cache.put(atomOf([probe('u', 'g1')], { verified: false }));
    cache.put(atomOf([probe('v', 'g1')]));
    assert.deepEqual(cache.get('list-slicing')!.probes.map((p) => p.id), ['v']);
    cache.put(atomOf([probe('w', 'g2')], { verified: false, createdAt: T0 + 5 }));
    assert.deepEqual(cache.get('list-slicing')!.probes.map((p) => p.id), ['v']);
    assert.equal(cache.get('list-slicing')!.verified, true);
  });
});

describe('unseenProbes', () => {
  test('never repeats an item within 7 days; it is back after 7 days', () => {
    const { cache, clock } = setup();
    cache.put(atomOf([probe('a', 'g1'), probe('b', 'g2')]));
    assert.ok(cache.markSeen('list-slicing', 'a'));
    assert.equal(cache.markSeen('list-slicing', 'zzz'), false);
    assert.deepEqual(cache.unseenProbes('list-slicing', 5).map((p) => p.id), ['b']);
    clock.now = T0 + 7 * DAY - 1;
    assert.deepEqual(cache.unseenProbes('list-slicing', 5).map((p) => p.id), ['b']);
    clock.now = T0 + 7 * DAY;
    assert.deepEqual(cache.unseenProbes('list-slicing', 5).map((p) => p.id).sort(), ['a', 'b']);
  });

  test('excludes groups, and spreads over groups before repeating one', () => {
    const { cache } = setup();
    cache.put(atomOf([probe('a1', 'g1'), probe('a2', 'g1'), probe('b1', 'g2'), probe('c1', 'g3')]));
    assert.deepEqual(cache.unseenProbes('list-slicing', 3).map((p) => p.group), ['g1', 'g2', 'g3']);
    assert.deepEqual(cache.unseenProbes('list-slicing', 4).map((p) => p.id), ['a1', 'b1', 'c1', 'a2']);
    assert.deepEqual(cache.unseenProbes('list-slicing', 5, ['g1', 'g3']).map((p) => p.id), ['b1']);
    assert.deepEqual(cache.unseenProbes('list-slicing', 0), []);
    assert.deepEqual(cache.unseenProbes('missing', 3), []);
  });

  test('prefers probes carrying the misconception, then known constructs, then discriminating ones', () => {
    const { cache } = setup();
    cache.put(atomOf([
      probe('plain', 'g1', { constructs: ['slice'] }),
      probe('carrier', 'g2', { constructs: ['slice', 'lambda'], mutants: [mut('carrier~m', 'index-starts-at-one')] }),
      probe('ambig', 'g3', { mutants: [mut('ambig~m', 'index-starts-at-one', { ambiguous: true })] }),
      probe('weak', 'g4', { discriminating: false, mutants: [], constructs: ['slice'] }),
    ]));
    assert.deepEqual(cache.unseenProbes('list-slicing', 1, [], 'index-starts-at-one').map((p) => p.id), ['carrier']);
    // allowedConstructs: 'carrier' uses lambda, which the learner does not know -> last.
    assert.deepEqual(cache.unseenProbes('list-slicing', 4, [], undefined, ['slice']).map((p) => p.id), ['plain', 'ambig', 'weak', 'carrier']);
    // The misconception outranks constructs; an ambiguous mutant does not count as carrying it.
    assert.deepEqual(cache.unseenProbes('list-slicing', 2, [], 'index-starts-at-one', ['slice']).map((p) => p.id), ['carrier', 'plain']);
  });

  test('least-shown probes come first', () => {
    const { cache, clock } = setup();
    cache.put(atomOf([probe('a', 'g1'), probe('b', 'g2')]));
    cache.markSeen('list-slicing', 'a', T0 - 10 * DAY);
    cache.recordItemStat('list-slicing', 'a', true);
    clock.now = T0;
    assert.deepEqual(cache.unseenProbes('list-slicing', 2).map((p) => p.id), ['b', 'a']);
  });
});

describe('stats and mutants', () => {
  test('recordItemStat counts answers and keeps the median latency', () => {
    const { cache } = setup();
    cache.put(atomOf([probe('a', 'g1')], { completions: [completion('c')] }));
    for (const [ok, ms] of [[true, 3000], [false, 9000], [true, 5000]] as const) cache.recordItemStat('list-slicing', 'a', ok, ms);
    assert.deepEqual(cache.get('list-slicing')!.probes[0].stats, { seenAt: [], n: 3, nCorrect: 2, medianMs: 5000 });
    cache.recordItemStat('list-slicing', 'c', false);
    assert.deepEqual(cache.get('list-slicing')!.completions[0].stats, { seenAt: [], n: 1, nCorrect: 0 });
    assert.equal(cache.recordItemStat('list-slicing', 'nope', true), false);
  });

  test('a mutant below .3 precision after 5 asks is retired and hidden', () => {
    const { cache } = setup();
    const id = 'a~slice-end-included';
    cache.put(atomOf([probe('a', 'g1', { mutants: [mut(id, 'slice-end-included'), mut('a~other', 'other')] }), probe('b', 'g2')]));
    assert.deepEqual(cache.recordMutantResponse('list-slicing', id, 'match'), { retired: false, precision: undefined });
    cache.recordMutantResponse('list-slicing', id, 'yes');
    for (let i = 0; i < 3; i++) assert.equal(cache.recordMutantResponse('list-slicing', id, 'no')!.retired, false, 'fewer than 5 asks never retires');
    const last = cache.recordMutantResponse('list-slicing', id, 'no')!;
    assert.deepEqual(last, { retired: true, precision: 0.2 });
    const p = cache.get('list-slicing')!.probes[0];
    assert.deepEqual(p.mutants.map((m) => m.id), ['a~other']);
    assert.equal(p.discriminating, true);
    assert.deepEqual(cache.unseenProbes('list-slicing', 1, [], 'slice-end-included').map((x) => x.id), ['b']);
    assert.equal(cache.recordMutantResponse('list-slicing', 'nope', 'yes'), undefined);
    // The counters are kept (toJSON), so a merge cannot resurrect it.
    const raw = cache.toJSON().atoms['list-slicing'].probes[0].mutants[0];
    assert.deepEqual([raw.matches, raw.confirmations, raw.rejections], [1, 1, 4]);
  });

  test('precision and isRetired thresholds', () => {
    assert.equal(precision({ confirmations: 0, rejections: 0 }), undefined);
    assert.equal(isRetired({ confirmations: 1, rejections: 3 }), false);
    assert.equal(isRetired({ confirmations: 2, rejections: 3 }), false);
    assert.equal(isRetired({ confirmations: 1, rejections: 4 }), true);
    assert.equal(isRetired({ confirmations: 0, rejections: 5 }), true);
  });

  test('a probe whose only mutant is retired is no longer discriminating', () => {
    const { cache } = setup();
    cache.put(atomOf([probe('a', 'g1')]));
    for (let i = 0; i < 5; i++) cache.recordMutantResponse('list-slicing', 'a~slice-end-included', 'no');
    const p = cache.get('list-slicing')!.probes[0];
    assert.deepEqual(p.mutants, []);
    assert.equal(p.discriminating, false);
  });
});

describe('stock', () => {
  test('counts unseen items by kind; low stock is fewer than 3 unseen probes', () => {
    const { cache } = setup();
    cache.put(atomOf([probe('a', 'g1'), probe('b', 'g1'), probe('c', 'g2')], {
      examples: [example('x1'), example('x2')], completions: [completion('c1')], contrasts: [contrast('k1')],
      tracebacks: [{ id: 't1', code: 'x', trace: 't', line: 1, exception: 'E', meanings: [], correctMeaning: 0, siblingGroup: 'tb', conceptId: 'c' }],
    }));
    assert.deepEqual(cache.stock('list-slicing'), { probes: 3, groups: 2, examples: 2, completions: 1, contrasts: 1, tracebacks: 1, items: 5 });
    assert.equal(cache.lowStock('list-slicing'), false);
    cache.markSeen('list-slicing', 'a');
    cache.markSeen('list-slicing', 'x1');
    cache.markSeen('list-slicing', 't1');
    assert.deepEqual(cache.stock('list-slicing'), { probes: 2, groups: 2, examples: 1, completions: 1, contrasts: 1, tracebacks: 0, items: 3 });
    assert.equal(cache.lowStock('list-slicing'), true);
    assert.equal(LOW_STOCK, 3);
    assert.deepEqual(cache.unseen('list-slicing', 'examples').map((e) => e.id), ['x2']);
    assert.deepEqual(cache.stock('missing').items, 0);
  });
});

describe('LRU cap', () => {
  test('keeps at most 60 items per key, evicting the least recently used', () => {
    const { cache, clock } = setup();
    const probes = Array.from({ length: 50 }, (_, i) => probe(`p${i}`, `g${i % 5}`));
    cache.put(atomOf(probes, { examples: [example('x0')], completions: [completion('c0')] }));
    clock.now += 1000;
    cache.markSeen('list-slicing', 'p0'); // p0 is now the most recently used
    clock.now += 1000;
    cache.put(atomOf(Array.from({ length: 15 }, (_, i) => probe(`q${i}`, 'gq'))));
    const a = cache.get('list-slicing')!;
    const n = a.probes.length + a.examples.length + a.completions.length;
    assert.equal(n, ITEM_CAP);
    const ids = a.probes.map((p) => p.id);
    assert.ok(ids.includes('p0'), 'recently shown item kept');
    assert.ok(ids.includes('q14'), 'newest items kept');
    assert.ok(!ids.includes('p1') && !ids.includes('p5'), 'oldest unused items evicted');
    assert.equal(a.examples.length, 1, 'the last example is never evicted');
    assert.equal(a.completions.length, 1, 'the last completion is never evicted');
  });

  test('an evicted item shown in the last 7 days still counts as seen', () => {
    const { cache, clock } = setup();
    cache.put(atomOf(Array.from({ length: ITEM_CAP }, (_, i) => probe(`p${i}`, 'g'))));
    cache.markSeen('list-slicing', 'p0', T0 - DAY); // seen yesterday, but the LRU clock says it is old
    clock.now += 1000;
    cache.put(atomOf([probe('new', 'g2')]));
    assert.ok(!cache.get('list-slicing')!.probes.some((p) => p.id === 'p0'));
    assert.ok(cache.seenIds('list-slicing').includes('p0'));
    // Put back (e.g. the same seed instance drawn again): still not offered within the 7 days.
    cache.put(atomOf([probe('p0', 'g3')]));
    assert.ok(!cache.unseenProbes('list-slicing', 100).some((p) => p.id === 'p0'));
    clock.now = T0 + 7 * DAY;
    assert.ok(cache.unseenProbes('list-slicing', 100).some((p) => p.id === 'p0'));
  });
});

describe('merge and persistence', () => {
  test('merge by item id: both windows keep their items; counters never double count', () => {
    const a = setup().cache;
    const b = setup().cache;
    a.put(atomOf([probe('x', 'g1'), probe('y', 'g2')]));
    b.put(atomOf([probe('x', 'g1'), probe('z', 'g3')]));
    a.recordItemStat('list-slicing', 'x', true);
    a.markSeen('list-slicing', 'x', T0 + 5);
    b.recordItemStat('list-slicing', 'x', false);
    b.recordItemStat('list-slicing', 'x', false);
    b.markSeen('list-slicing', 'x', T0 + 9);
    b.recordMutantResponse('list-slicing', 'x~slice-end-included', 'yes');
    a.merge(b);
    const m = a.get('list-slicing')!;
    assert.deepEqual(m.probes.map((p) => p.id), ['x', 'y', 'z']);
    assert.deepEqual(m.probes[0].stats.seenAt, [T0 + 5, T0 + 9]);
    assert.equal(m.probes[0].stats.n, 2);
    assert.equal(m.probes[0].stats.nCorrect, 1);
    assert.equal(m.probes[0].mutants[0].confirmations, 1);
    // Merging the same data again changes nothing.
    a.merge(b.toJSON());
    assert.deepEqual(a.get('list-slicing'), m);
  });

  test('mergeAtoms keeps the newer pattern and unions use cases', () => {
    const old = atomOf([probe('a', 'g')]);
    const neu = atomOf([], { createdAt: T0 + 1, pattern: { ...old.pattern, useWhen: 'new', useCases: ['z', 'a'] } });
    const m = mergeAtoms(old, neu);
    assert.equal(m.pattern.useWhen, 'new');
    assert.deepEqual(m.pattern.useCases, ['z', 'a', 'b']);
    assert.deepEqual(m.probes.map((p) => p.id), ['a']);
  });

  test('flush re-reads the file and merges, so two windows both survive', async () => {
    const { file, io } = fakeFile();
    const w1 = setup(io).cache;
    const w2 = setup(io).cache;
    await w1.load();
    await w2.load();
    w1.put(atomOf([probe('one', 'g1')]));
    w2.put(atomOf([probe('two', 'g2')], { key: 'dict-iteration', conceptId: 'dict-iteration', tag: 'dict-iteration' }));
    await w1.flush();
    await w2.flush();
    assert.deepEqual(Object.keys(file.data!.atoms).sort(), ['dict-iteration', 'list-slicing']);
    // w2 now also sees w1's atom; a fresh window loads both.
    assert.ok(w2.get('list-slicing'));
    const w3 = setup(io).cache;
    await w3.load();
    assert.deepEqual(w3.keys().sort(), ['dict-iteration', 'list-slicing']);
    // Nothing changed: no write.
    const saves = file.saves;
    await w3.flush();
    assert.equal(file.saves, saves);
  });

  test('writes are debounced', async () => {
    const { file, io } = fakeFile();
    const cache = new AtomCache('python', io, { now: () => T0, debounceMs: 5 });
    cache.put(atomOf([probe('a', 'g1')]));
    cache.markSeen('list-slicing', 'a');
    assert.equal(file.saves, 0);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(file.saves, 1);
    assert.deepEqual(file.data!.atoms['list-slicing'].probes[0].stats.seenAt, [T0]);
    await cache.dispose();
    assert.equal(file.saves, 1);
  });

  test('a failed write is reported and retried on the next flush', async () => {
    const { file, io } = fakeFile();
    let fail = true;
    const errors: unknown[] = [];
    const cache = new AtomCache('python', { load: io.load, save: async (d) => (fail ? Promise.reject(new Error('disk full')) : io.save(d)) }, { debounceMs: 1, onError: (e) => errors.push(e) });
    cache.put(atomOf([probe('a', 'g1')]));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(errors.length, 1);
    fail = false;
    await cache.flush();
    assert.ok(file.data?.atoms['list-slicing']);
  });

  test('load ignores other languages and versions and repairs malformed atoms', async () => {
    const good = atomOf([probe('a', 'g1')]);
    const broken = { ...atomOf([]), probes: [{ id: 'b', group: 'g', code: 'x', output: { stdout: '', values: [] }, mutants: [{ id: 'b~m', misconceptionId: 'm' }] }], examples: undefined } as unknown as StoredAtom;
    const data = { version: 1, lang: 'python', atoms: { 'list-slicing': good, broken, js: { ...good, lang: 'javascript' } }, meta: {} } as AtomCacheData;
    let { cache } = setup({ load: async () => data, save: async () => {} });
    await cache.load();
    assert.deepEqual(cache.keys().sort(), ['broken', 'list-slicing']);
    const b = cache.get('broken')!;
    assert.equal(b.key, 'broken');
    assert.deepEqual(b.examples, []);
    assert.deepEqual(b.probes[0].stats, { seenAt: [], n: 0, nCorrect: 0 });
    assert.equal(b.probes[0].mutants[0].rejections, 0);
    ({ cache } = setup({ load: async () => ({ ...data, lang: 'javascript' }) as AtomCacheData, save: async () => {} }));
    await cache.load();
    assert.deepEqual(cache.keys(), []);
    ({ cache } = setup({ load: async () => ({ ...data, version: 2 }) as unknown as AtomCacheData, save: async () => {} }));
    await cache.load();
    assert.deepEqual(cache.keys(), []);
  });
});
