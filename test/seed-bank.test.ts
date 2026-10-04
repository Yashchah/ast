// Content checks for the bundled seed banks (media/seed/python.json and neutral.json): the Python
// placement fundamentals each get a full atom, every Python misconception of those tags is carried
// by probes in two or more sibling groups, texts stay inside the reading budget, and (when a Python
// runtime is found) sampled instances run, keep every mutant attributable and show types where the
// tag is type-sensitive. The full 20-per-template run is scripts/verify-seeds.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Lang, SeedTemplate } from '../src/contracts';
import { actualText, compareOutput } from '../src/compare';
import { detectNode, detectPython, detectTypeScript, LocalRunner, PATH_PYTHON_CANDIDATES } from '../src/runner';
import { Instantiator, parseSeedBank, prepareTemplate } from '../src/atoms/seeds';
import { PLACEMENT_FUNDAMENTALS, misconceptionsFor, tagInfo } from '../src/atoms/tags';
import { typeVisible } from '../src/atoms/verify';

const root = join(__dirname, '..');
const load = (name: string): unknown => JSON.parse(readFileSync(join(root, 'media', 'seed', name), 'utf8'));
const words = (s: string | undefined) => (s ?? '').trim().split(/\s+/).filter(Boolean).length;
const HOLE = /\{\{@?[A-Za-z_]\w*\}\}/g;

const { bank, problems } = parseSeedBank(load('python.json'), 'python');
const ofKind = (kind: SeedTemplate['kind'], tag?: string) => bank.templates.filter((t) => t.kind === kind && (!tag || t.tag === tag));
const groupsOf = (t: SeedTemplate) => Object.keys(t.themes).map((theme) => `${t.family}:${theme}`);

test('the python seed bank parses with no problems', () => {
  assert.deepEqual(problems, []);
  assert.equal(bank.lang, 'python');
  const ids = bank.templates.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'template ids are unique');
  for (const t of bank.templates) assert.ok(prepareTemplate(t, 'python').ok, t.id);
});

test('every python placement fundamental has pattern, probes, example, completion and (semantics) contrast', () => {
  for (const tag of PLACEMENT_FUNDAMENTALS.python) {
    const info = tagInfo(tag)!;
    const card = bank.patterns?.[tag];
    assert.ok(card, `${tag}: pattern card`);
    assert.equal(card.name, info.patternName, `${tag}: canonical pattern name`);
    assert.equal(card.kind, info.kind, `${tag}: card kind`);
    const probes = ofKind('probe', tag);
    const families = new Set(probes.map((t) => t.family));
    const groups = new Set(probes.flatMap(groupsOf));
    assert.ok(families.size >= 2, `${tag}: ${families.size} probe families (need 2+)`);
    assert.ok(groups.size >= 4, `${tag}: ${groups.size} sibling groups (need 4+)`);
    assert.ok(ofKind('example', tag).length >= 1, `${tag}: example`);
    const completions = ofKind('completion', tag);
    assert.ok(completions.length >= 1, `${tag}: completion`);
    for (const c of completions) assert.ok((c.wrongFills ?? []).length >= 1, `${c.id}: tagged wrong fill`);
    if (info.kind === 'semantics') assert.ok(ofKind('contrast', tag).length >= 1, `${tag}: contrast`);
  }
});

test('probe transforms carry every python misconception of each fundamental in 2+ sibling groups', () => {
  for (const tag of PLACEMENT_FUNDAMENTALS.python) {
    for (const m of misconceptionsFor(tag, 'python')) {
      const groups = new Set(ofKind('probe', tag)
        .filter((t) => t.transforms.some((tr) => tr.misconceptionId === m.id))
        .flatMap(groupsOf));
      assert.ok(groups.size >= 2, `${tag}/${m.id}: carried by ${groups.size} sibling groups`);
    }
  }
});

test('texts stay inside the reading budget and refutations name no output values', () => {
  for (const t of bank.templates) {
    const codeDigits = new Set(t.code.replace(HOLE, ' ').match(/\d+/g) ?? []);
    for (const tr of t.transforms) {
      assert.ok(words(tr.belief) >= 1 && words(tr.belief) <= 12, `${t.id}: belief '${tr.belief}'`);
      assert.ok(words(tr.refutation) >= 1 && words(tr.refutation) <= 25, `${t.id}: refutation '${tr.refutation}'`);
      assert.ok(words(tr.rule) >= 1 && words(tr.rule) <= 12, `${t.id}: rule '${tr.rule}'`);
      // Numbers in a refutation may only repeat the code (holes are filled from the code's own slots).
      for (const n of tr.refutation.replace(HOLE, ' ').match(/\d+/g) ?? []) {
        assert.ok(codeDigits.has(n), `${t.id}: refutation number ${n} is not in the code`);
      }
    }
    for (const s of t.subgoals ?? []) assert.ok(words(s.label) <= 6, `${t.id}: subgoal '${s.label}'`);
    if (t.kind === 'contrast') assert.ok(words(t.rule) <= 12, `${t.id}: contrast rule`);
    if (t.kind === 'probe') assert.ok(t.parSec >= 3 && t.parSec <= 8, `${t.id}: parSec`);
    if (t.kind === 'completion') assert.ok(t.parSec >= 20 && t.parSec <= 40, `${t.id}: parSec`);
  }
});

test('the neutral bank holds three unverified pseudocode probes with hand-traced outputs', () => {
  const raw = load('neutral.json') as { note?: string; templates: (SeedTemplate & { verified?: boolean; answer?: string })[] };
  const neutral = parseSeedBank(raw);
  assert.deepEqual(neutral.problems, []);
  assert.equal(neutral.bank.lang, 'neutral');
  assert.match(raw.note ?? '', /UNVERIFIED/);
  assert.equal(raw.templates.length, 3);
  for (const t of raw.templates) {
    assert.equal(t.kind, 'probe', t.id);
    assert.equal(t.verified, false, `${t.id}: marked unverified`);
    assert.deepEqual(t.slots, {}, `${t.id}: fixed item`);
    assert.ok(t.answer?.trim(), `${t.id}: traced answer`);
    assert.ok(t.code.split('\n').length <= 8, `${t.id}: 8 lines or fewer`);
    const p = prepareTemplate(t);
    assert.ok(p.ok, `${t.id}: ${p.problems.join('; ')}`);
    assert.equal(p.transforms.length, t.transforms.length, `${t.id}: every transform applies`);
    const prints = t.transforms.map((tr) => (tr as { prints?: string }).prints ?? '');
    for (const out of prints) assert.ok(out && out !== t.answer, `${t.id}: mutant claim differs from the answer`);
    assert.equal(new Set(prints).size, prints.length, `${t.id}: mutant claims differ from each other`);
  }
});

// ------------------------------------------------------------------------------------------------
// Runtime sample (skipped without Python)
// ------------------------------------------------------------------------------------------------

test('sampled instances run, keep every mutant attributable and show types', { timeout: 120_000 }, async (t) => {
  const pinned = process.env.DELIBERATE_PYTHON;
  const workRoot = mkdtempSync(join(tmpdir(), 'dlb-seedbank-'));
  try {
    const py = await detectPython(pinned ? [{ bin: pinned, source: 'DELIBERATE_PYTHON' }, ...PATH_PYTHON_CANDIDATES] : PATH_PYTHON_CANDIDATES, { cwd: workRoot });
    if (!py) return t.skip('no python found');
    const inst = new Instantiator(new LocalRunner(py, { runnerDir: join(root, 'media', 'runner'), runRoot: workRoot }), 11);
    const { byTag, reports } = await inst.instantiate(bank.templates, 2, { seed: 20261004 });
    for (const r of reports) assert.ok(r.valid >= 1, `${r.templateId}: no valid instance (${JSON.stringify(r.rejected)})`);
    const exceptions = new Set<string>();
    for (const [tag, pieces] of Object.entries(byTag)) {
      const typeSensitive = !!tagInfo(tag)?.typeSensitive;
      for (const p of pieces.probes) {
        assert.equal(compareOutput(actualText(p.output, 'python'), p.output, 'python', { typeSensitive }).verdict, 'correct', `${p.id}: own answer`);
        if (typeSensitive) assert.ok(typeVisible(p.code, p.output, 'python'), `${p.id}: prints a bare number or str`);
        const mutants = p.mutants.map((m) => ({ id: m.id, output: m.output, ambiguous: m.ambiguous }));
        for (const m of p.mutants) {
          // Typing exactly what the mutant prints must name that mutant: not a slip, not ambiguous.
          const v = compareOutput(actualText(m.output, 'python'), p.output, 'python', { typeSensitive, mutants });
          assert.equal(v.mutantId, m.id, `${p.id}: ${m.misconceptionId} not attributable (${actualText(p.output, 'python')} vs ${actualText(m.output, 'python')})`);
        }
      }
      for (const tb of pieces.tracebacks) exceptions.add(tb.exception);
    }
    for (const e of ['IndexError', 'KeyError', 'TypeError', 'NameError', 'AttributeError', 'ValueError', 'ZeroDivisionError']) {
      assert.ok(exceptions.has(e), `a traceback template raises ${e}`);
    }
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------
// JavaScript and TypeScript banks (media/seed/javascript.json, typescript.json)
// ------------------------------------------------------------------------------------------------

for (const lang of ['javascript', 'typescript'] as const) {
  const js = parseSeedBank(load(`${lang}.json`), lang);
  const jsOf = (kind: SeedTemplate['kind'], tag?: string) => js.bank.templates.filter((t) => t.kind === kind && (!tag || t.tag === tag));

  test(`the ${lang} seed bank parses and covers every fundamental and its misconceptions`, () => {
    assert.deepEqual(js.problems, []);
    assert.equal(js.bank.lang, lang);
    const ids = js.bank.templates.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'template ids are unique');
    for (const tag of PLACEMENT_FUNDAMENTALS[lang]) {
      assert.equal(js.bank.patterns?.[tag]?.name, tagInfo(tag)!.patternName, `${tag}: pattern card`);
      assert.ok(new Set(jsOf('probe', tag).map((t) => t.family)).size >= 2, `${tag}: 2+ probe families`);
      assert.ok(jsOf('completion', tag).length >= 1, `${tag}: completion`);
      for (const m of misconceptionsFor(tag, lang)) {
        const carried = jsOf('probe', tag).some((t) => t.transforms.some((tr) => tr.misconceptionId === m.id))
          || jsOf('completion', tag).some((t) => (t.wrongFills ?? []).some((w) => w.misconceptionId === m.id));
        assert.ok(carried, `${tag}/${m.id}: carried by a probe mutant or a completion wrong fill`);
      }
    }
  });

  test(`sampled ${lang} instances run and keep every mutant attributable`, { timeout: 120_000 }, async (t) => {
    const workRoot = mkdtempSync(join(tmpdir(), 'dlb-seedbank-'));
    try {
      const node = await detectNode({ cwd: workRoot });
      const rt = node && (lang === 'javascript' ? node : await detectTypeScript(node, root, { cwd: workRoot, runnerDir: join(root, 'media', 'runner') }));
      if (!rt) return t.skip(`no ${lang} runtime`);
      const inst = new Instantiator(new LocalRunner(rt, { runnerDir: join(root, 'media', 'runner'), runRoot: workRoot }), 11);
      const { byTag, reports } = await inst.instantiate(js.bank.templates, 1, { seed: 20261004 });
      for (const r of reports) assert.ok(r.valid >= 1, `${r.templateId}: no valid instance (${JSON.stringify(r.rejected)})`);
      for (const [tag, pieces] of Object.entries(byTag)) {
        const typeSensitive = !!tagInfo(tag)?.typeSensitive;
        for (const p of pieces.probes) {
          assert.equal(compareOutput(actualText(p.output, lang as Lang), p.output, lang, { typeSensitive }).verdict, 'correct', `${p.id}: own answer`);
          const mutants = p.mutants.map((m) => ({ id: m.id, output: m.output, ambiguous: m.ambiguous }));
          for (const m of p.mutants) {
            const v = compareOutput(actualText(m.output, lang), p.output, lang, { typeSensitive, mutants });
            assert.equal(v.mutantId, m.id, `${p.id}: ${m.misconceptionId} not attributable`);
          }
        }
      }
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
  });
}
