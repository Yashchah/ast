// Stock: seed banks -> Instantiator -> AtomCache at activation (one batch, 3 per placement template),
// background refills below 6 unseen, neutral unverified items without a runtime, and the read side
// (stockFor, cacheKeyFor, placementTags, deck). The Instantiator is faked except in the last test,
// which runs the real one through LocalRunner when Python is installed.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Lang, Runner, Runtime, SeedTemplate } from '../src/contracts';
import { AtomCache } from '../src/atoms/cache';
import { emptyPieces, emptyStats, type InstantiateOptions, type InstantiateResult, type SeedPieces } from '../src/atoms/seeds';
import { NEUTRAL_FILE, seedFile, Stock, STOCK } from '../src/atoms/stock';
import { PLACEMENT_FUNDAMENTALS } from '../src/atoms/tags';
import { emptyLearner, upsertConcepts } from '../src/learner';
import { detectPython, LocalRunner, PATH_PYTHON_CANDIDATES } from '../src/runner';

const ROOT = path.resolve(__dirname, '..');
const T0 = Date.UTC(2026, 9, 4, 9, 0, 0);
const readFile = (rel: string) => fs.promises.readFile(path.join(ROOT, rel), 'utf8');

const fakeRunner = (lang: Lang = 'python'): Runner => ({
  runtime: { lang, exe: lang, snippetArgv: [], learnerArgv: [], version: 'test' } as Runtime,
  runBatch: async () => [],
  runLearnerCode: async () => {
    throw new Error('not used');
  },
});

interface Call {
  templates: string[];
  n: number;
  exclude: string[];
}

/** A fake Instantiator: n valid instances per template, ids never in `exclude`. */
function fakeInstantiate(calls: Call[]) {
  let k = 0;
  return () => async (templates: readonly SeedTemplate[], n: number, opts: InstantiateOptions): Promise<InstantiateResult> => {
    const exclude = new Set(opts.exclude ?? []);
    calls.push({ templates: templates.map((t) => t.id), n, exclude: [...exclude] });
    const byTag: Record<string, SeedPieces> = {};
    for (const t of templates) {
      const pieces = (byTag[t.tag] ??= emptyPieces());
      for (let i = 0; i < n; i++) {
        let id: string;
        do id = `${t.id}#f${++k}`;
        while (exclude.has(id));
        const group = `${t.family}:${['a', 'b', 'c'][i % 3]}`;
        const out = { stdout: `${k}\n`, values: [] };
        switch (t.kind) {
          case 'probe':
            pieces.probes.push({ id, group, code: `print(${k})`, output: out, parSec: 5, answerSpaceG: 0.2, constructs: [], discriminating: false, mutants: [], stats: emptyStats() });
            break;
          case 'completion':
            pieces.completions.push({ id, group, code: 'def f():\n    return [[1]]', solutions: ['1'], wrongFills: [], harness: "check(f() == 1, 'one')\ncheck(f() != 2, 'not two')", parSec: 25, stats: emptyStats() });
            break;
          case 'example':
            pieces.examples.push({ id, group, code: 'print(1)', subgoals: [], output: out });
            break;
          case 'contrast':
            pieces.contrasts.push({ id, wrong: 'print(1)', right: 'print(2)', wrongOutput: out, rightOutput: { stdout: '2\n', values: [] }, misconceptionId: 'x', rule: 'r' });
            break;
          case 'traceback':
            pieces.tracebacks.push({ id, code: 'x', trace: 't', line: 1, exception: 'IndexError', meanings: ['a', 'b', 'c'], correctMeaning: 0, siblingGroup: group, conceptId: t.tag });
            break;
        }
      }
    }
    return {
      byTag,
      reports: templates.map((t) => ({
        templateId: t.id, tag: t.tag, kind: t.kind, requested: n, drawn: n, valid: n, rounds: 1, exhausted: false, rejected: {}, transforms: [],
        droppedWrongFills: 0, problems: [],
      })),
    };
  };
}

function setup(o: { lang?: Lang; runner?: Runner | undefined; read?: (rel: string) => Promise<string> } = {}) {
  const lang = o.lang ?? 'python';
  let now = T0;
  const cache = new AtomCache(lang, undefined, { debounceMs: -1, now: () => now });
  const calls: Call[] = [];
  const logs: string[] = [];
  const box = { runner: 'runner' in o ? o.runner : fakeRunner(lang) };
  const stock = new Stock({
    lang, readFile: o.read ?? readFile, cache, runner: () => box.runner, seed: 7, now: () => now, log: (l) => logs.push(l), instantiate: fakeInstantiate(calls),
  });
  return { stock, cache, calls, logs, box, advance: (ms: number) => (now += ms), now: () => now };
}

const bankTemplates = (lang: Lang): SeedTemplate[] => JSON.parse(fs.readFileSync(path.join(ROOT, seedFile(lang)), 'utf8')).templates;

describe('Stock at activation', () => {
  test('one batch: 3 instances of every placement-candidate template, put in the cache under the tag', async () => {
    const t = setup();
    const r = await t.stock.ensureStock();
    assert.equal(t.calls.length, 1, 'one Instantiator call for all fundamentals');
    const want = bankTemplates('python').filter((x) => PLACEMENT_FUNDAMENTALS.python.includes(x.tag)).map((x) => x.id);
    assert.deepEqual([...t.calls[0].templates].sort(), [...want].sort());
    assert.equal(t.calls[0].n, STOCK.perTemplate);
    assert.equal(r.neutral, false);
    assert.ok(r.added > 0);
    for (const tag of PLACEMENT_FUNDAMENTALS.python) {
      const atom = t.cache.get(tag);
      assert.ok(atom, `${tag} is stocked`);
      assert.equal(atom.verified, true);
      assert.equal(atom.source, 'seed');
      assert.ok(atom.probes.length >= 3, tag);
      assert.ok(atom.pattern.useCases.length >= 6, `${tag}: the bank's pattern card`);
    }
    assert.deepEqual(t.logs, [], 'the bundled banks load without problems');
  });

  test('templates that still have 3 unseen instances are not drawn again; drawn ones exclude cached ids', async () => {
    const t = setup();
    await t.stock.ensureStock(['list-slicing', 'alias-copy']);
    await t.stock.ensureStock(['list-slicing', 'alias-copy']);
    assert.equal(t.calls.length, 1, 'nothing to do the second time');
    // Show every list-slicing probe of one template: only that template is drawn again.
    const atom = t.cache.get('list-slicing')!;
    const tid = atom.probes[0].id.split('#')[0];
    for (const p of atom.probes.filter((x) => x.id.startsWith(`${tid}#`))) t.cache.markSeen('list-slicing', p.id, t.now());
    await t.stock.ensureStock(['list-slicing', 'alias-copy']);
    assert.equal(t.calls.length, 2);
    assert.deepEqual(t.calls[1].templates, [tid]);
    for (const p of atom.probes) assert.ok(t.calls[1].exclude.includes(p.id), 'cached and recently seen ids are excluded');
  });

  test('a missing seed file is logged, never thrown', async () => {
    const t = setup({ read: async (rel) => (rel === NEUTRAL_FILE ? readFile(rel) : Promise.reject(new Error('ENOENT'))) });
    const r = await t.stock.ensureStock();
    assert.equal(r.added, 0);
    assert.equal(t.calls.length, 0);
    assert.ok(t.logs.some((l) => l.includes('cannot load media/seed/python.json')));
  });
});

describe('Stock refills', () => {
  test('a seeded key below 6 unseen probes is refilled in the background, single-flight', async () => {
    const t = setup();
    await t.stock.ensureStock(['alias-copy']);
    assert.equal(t.stock.refillIfLow('alias-copy'), undefined, 'enough stock: nothing to do');
    for (const p of t.cache.get('alias-copy')!.probes) t.cache.markSeen('alias-copy', p.id, t.now());
    assert.equal(t.cache.stock('alias-copy').probes, 0);
    const a = t.stock.refillIfLow('alias-copy');
    const b = t.stock.refillIfLow('alias-copy');
    assert.ok(a);
    assert.equal(a, b, 'one refill in flight per key');
    await a;
    const refill = t.calls[t.calls.length - 1];
    const probeTemplates = bankTemplates('python').filter((x) => x.tag === 'alias-copy' && x.kind === 'probe').map((x) => x.id);
    for (const id of probeTemplates) assert.ok(refill.templates.includes(id));
    assert.ok(t.cache.stock('alias-copy').probes >= STOCK.refillBelow, 'back above 6 unseen probes');
    assert.equal(t.stock.refillIfLow('my-project-concept'), undefined, 'keys without seeds are never refilled locally');
  });

  test('tracebacks refill for reading-tracebacks; no runner means no refill', async () => {
    const t = setup();
    await t.stock.refillIfLow('reading-tracebacks');
    assert.ok(t.cache.stock('reading-tracebacks').tracebacks >= STOCK.minTracebacks);
    const t2 = setup({ runner: undefined });
    assert.equal(t2.stock.refillIfLow('alias-copy'), undefined);
  });
});

describe('Stock without a runtime: neutral items', () => {
  test('neutral pseudocode probes are stocked unverified, with mutant matching off at use', async () => {
    const t = setup({ runner: undefined });
    const r = await t.stock.ensureStock();
    assert.equal(r.neutral, true);
    assert.equal(t.calls.length, 0, 'nothing is run');
    const raw = t.cache.get('variables-assignment')!;
    assert.equal(raw.verified, false);
    assert.equal(raw.probes.length, 1);
    const p = raw.probes[0];
    assert.equal(p.output.stdout, 'before 14 14\nafter 36 14\n');
    assert.equal(p.mutants.length, 2, 'mutants are kept in storage');
    assert.equal(p.mutants[0].output.stdout, 'before 14 14\nafter 36 36\n');
    assert.equal(p.mutants[0].diffLine, 5);
    const st = t.stock.stockFor('variables-assignment')!;
    assert.equal(st.verified, false);
    assert.equal(st.probes[0].mutants.length, 0, 'but stripped when shown');
    assert.equal(st.completions.length, 0);
    assert.ok(t.stock.placementTags().includes('while-loop-termination'));
  });

  test('JavaScript without a runtime still gets all 3 neutral items as placement candidates', async () => {
    const t = setup({ lang: 'javascript', runner: undefined });
    await t.stock.ensureStock();
    const stocked = t.stock.placementTags().filter((tag) => t.stock.stockFor(tag));
    assert.deepEqual(stocked.sort(), ['loop-accumulator', 'variables-assignment', 'while-loop-termination']);
  });

  test('verified seeds replace the neutral items once a runtime appears', async () => {
    const t = setup({ runner: undefined });
    await t.stock.ensureStock();
    t.box.runner = fakeRunner();
    await t.stock.ensureStock(['variables-assignment']);
    const atom = t.cache.get('variables-assignment')!;
    assert.equal(atom.verified, true);
    assert.ok(!atom.probes.some((p) => p.id.startsWith('neutral-')), 'no neutral item left');
    assert.ok(t.stock.stockFor('variables-assignment')!.completions.length > 0);
  });
});

describe('Stock read side', () => {
  test('stockFor lists unseen items only', async () => {
    const t = setup();
    await t.stock.ensureStock(['list-slicing']);
    const st = t.stock.stockFor('list-slicing')!;
    assert.ok(st.probes.length >= 3 && st.completions.length >= 1 && st.examples.length >= 1 && st.contrasts.length >= 1);
    t.cache.markSeen('list-slicing', st.probes[0].id, t.now());
    assert.equal(t.stock.stockFor('list-slicing')!.probes.length, st.probes.length - 1);
    t.advance(8 * 24 * 3600_000);
    assert.equal(t.stock.stockFor('list-slicing')!.probes.length, st.probes.length, 'seen 8 days ago is fresh again');
    assert.equal(t.stock.stockFor('nothing-here'), undefined);
  });

  test('cacheKeyFor: seed tag owner, plan alias, separate plan concepts, model-pack ids', async () => {
    const t = setup();
    await t.stock.ensureStock(['list-slicing', 'alias-copy']);
    const l = emptyLearner();
    upsertConcepts(l, [{ id: 'list-slicing', name: 'Slicing', tag: 'list-slicing' }], T0);
    upsertConcepts(l, [{ id: 'take-first-rows', name: 'Take rows', tag: 'list-slicing' }], T0);
    assert.equal(t.stock.cacheKeyFor(l, 'list-slicing'), 'list-slicing');
    assert.equal(t.stock.cacheKeyFor(l, 'take-first-rows'), 'list-slicing', 'a plan alias of the seed concept');
    upsertConcepts(l, [{ id: 'copy-a', name: 'A', tag: 'alias-copy' }, { id: 'copy-b', name: 'B', tag: 'alias-copy' }], T0);
    assert.equal(t.stock.cacheKeyFor(l, 'copy-a'), undefined, 'separate plan concepts do not borrow the seed stock');
    assert.equal(t.stock.cacheKeyFor(l, 'alias-copy'), 'alias-copy', 'an unknown concept id that is a stocked tag');
    t.cache.put({ ...t.cache.get('list-slicing')!, key: 'parse-csv-row', conceptId: 'parse-csv-row', tag: 'other', source: 'model' });
    upsertConcepts(l, [{ id: 'parse-csv-row', name: 'Parse a row', tag: 'other' }], T0);
    assert.equal(t.stock.cacheKeyFor(l, 'parse-csv-row'), 'parse-csv-row');
    assert.equal(t.stock.cacheKeyFor(l, 'never-heard-of'), undefined);
  });

  test('deck tops up use cases from the bundled pattern without touching the card', async () => {
    const t = setup();
    await t.stock.load();
    const l = emptyLearner();
    l.patternDeck.push({
      conceptId: 'list-slicing', tag: 'list-slicing', kind: 'shape', name: 'Slice a sequence', useWhen: '', template: '', rule: '', pitfall: '',
      useCases: ['mine'], useCaseSeenAt: {}, addedAt: T0,
    });
    const deck = t.stock.deck(l);
    assert.ok(deck[0].useCases.length >= 7);
    assert.equal(deck[0].useCases[0], 'mine');
    assert.deepEqual(l.patternDeck[0].useCases, ['mine']);
    assert.ok(t.stock.pattern('list-slicing')?.name);
  });
});

// ---------------------------------------------------------------- the real Instantiator

describe('Stock with the real runner', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dlb-stock-'));
  after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 }));

  test('Python list-slicing seeds are instantiated, run and cached', { timeout: 60_000 }, async (t) => {
    const pinned = process.env.DELIBERATE_PYTHON;
    const rt = await detectPython(pinned ? [{ bin: pinned, source: 'DELIBERATE_PYTHON' }, ...PATH_PYTHON_CANDIDATES] : PATH_PYTHON_CANDIDATES, { cwd: work });
    if (!rt) return t.skip('no python');
    const runner = new LocalRunner(rt, { runnerDir: path.join(ROOT, 'media', 'runner'), runRoot: path.join(work, 'run') });
    const cache = new AtomCache('python', undefined, { debounceMs: -1 });
    const stock = new Stock({ lang: 'python', readFile, cache, runner: () => runner, seed: 11 });
    const r = await stock.ensureStock(['list-slicing']);
    assert.ok(r.added >= 4, `added ${r.added}: ${r.problems.join('; ')}`);
    const atom = cache.get('list-slicing')!;
    assert.ok(atom.probes.length >= 3);
    for (const p of atom.probes) {
      assert.ok(p.output.stdout.trim(), `${p.id} has a recorded output`);
      assert.ok(p.mutants.every((m) => m.output.stdout !== p.output.stdout || m.output.exception !== p.output.exception));
    }
    assert.ok(atom.completions.length >= 1);
  });
});
