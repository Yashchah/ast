// Stage-1 integration: the modules wired together the way the extension wires them, with the real
// interpreters behind LocalRunner (each part is skipped when its runtime is missing).
// - seed bank -> Instantiator -> AtomCache -> step machine -> render -> grade -> evidence -> learner,
//   placement on seeded fundamentals, traceback items on pad lines
// - spec ladders: buildHarnessInput -> LocalRunner.runLearnerCode(harness) -> parseHarnessOutput,
//   and verifySpecLadder through LocalRunner
// - own-code probes and what-ifs: probe.py / probe.mjs through LocalRunner -> parseProbeOutput ->
//   compareOutput / attributeWhatIf
// - model packs: verifyPack through LocalRunner -> AtomCache

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  AtomResult, Lang, RecordedOutput, SpecItem, StoredAtom, StoredCompletion, StoredProbe, TaskInterface,
} from '../src/contracts';
import { actualText, compareOutput } from '../src/compare';
import { mutateLiteral, parseCall, renameCallee, sameArgs, validateCall } from '../src/calls';
import { attributeWhatIf, whatIfCandidates } from '../src/mutants';
import { detectNode, detectPython, detectTypeScript, LocalRunner, PATH_PYTHON_CANDIDATES, type DetectedRuntime } from '../src/runner';
import { Instantiator, parseSeedBank, seedAtom, type SeedBank } from '../src/atoms/seeds';
import { tagInfo } from '../src/atoms/tags';
import { AtomCache } from '../src/atoms/cache';
import { chooseItem, startAtom, stepAtom, type AtomEvent, type AtomRunState, type StepOutput } from '../src/atoms/stepMachine';
import { renderTraceback, renderView, type LessonText, type PadRender } from '../src/atoms/render';
import { gradeCompletion, gradePredict, gradeTraceback } from '../src/atoms/grade';
import { newPlacement, nextItem, record, shouldStop, summary as placementSummary } from '../src/atoms/placement';
import { verifyPack } from '../src/atoms/verify';
import { emptyLearner, recordEvidence, recordTypingCalibration, upsertConcepts } from '../src/learner';
import {
  buildHarnessInput, parseHarnessOutput, parseProbeOutput, specTimeoutMs, verifySpecLadder, type SpecLadderDraft,
} from '../src/specsCore';
import type { AtomPack, EscalationLesson, SpecLadderPart } from '../src/schemas';
import type { Learner } from '../src/types';

// Model outputs feed module inputs directly (compile-time checks).
const _ladderFits = (x: SpecLadderPart): SpecLadderDraft => x;
const _lessonFits = (x: EscalationLesson): LessonText => x;
void _ladderFits;
void _lessonFits;

const ROOT = path.resolve(__dirname, '..');
const RUNNER_DIR = path.join(ROOT, 'media', 'runner');
const HARNESS_DIR = path.join(ROOT, 'media', 'harness');

let work = '';
const rts: Partial<Record<Lang, DetectedRuntime>> = {};

before(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'dlb-integ-'));
  const o = { cwd: work };
  const pinned = process.env.DELIBERATE_PYTHON;
  const [py, node] = await Promise.all([
    detectPython(pinned ? [{ bin: pinned, source: 'DELIBERATE_PYTHON' }, ...PATH_PYTHON_CANDIDATES] : PATH_PYTHON_CANDIDATES, o),
    detectNode(o),
  ]);
  rts.python = py;
  rts.javascript = node;
  if (node) rts.typescript = await detectTypeScript(node, ROOT, { ...o, runnerDir: RUNNER_DIR });
});
after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 }));

const runnerFor = (lang: Lang) => new LocalRunner(rts[lang]!, { runnerDir: RUNNER_DIR, runRoot: path.join(work, 'run') });

function bank(lang: Lang): SeedBank {
  const { bank: b, problems } = parseSeedBank(JSON.parse(fs.readFileSync(path.join(ROOT, 'media', 'seed', `${lang}.json`), 'utf8')), lang);
  assert.deepEqual(problems, []);
  return b;
}

// =====================================================================================================
// Atom pad: seeds -> cache -> step machine -> render -> grade -> evidence
// =====================================================================================================

type Policy = 'right' | 'mutant' | 'dont-know';

/** One simulated clock for the pads and the cache, so 'seen within 7 days' sees the pads' show times. */
const clock = { t: Date.now() };

/** Plays the pad: renders every view, answers on the rendered answer line, applies every effect. */
class Pad {
  state!: AtomRunState;
  doc = '';
  render!: PadRender;
  get now(): number {
    return clock.t;
  }
  set now(t: number) {
    clock.t = t;
  }
  result?: AtomResult;
  evidence: { correct: boolean | null; misconceptionId?: string; kind: string }[] = [];
  probes: Policy[];
  views: string[] = [];
  shown: string[] = [];

  constructor(
    readonly lang: Lang,
    readonly key: string,
    readonly cache: AtomCache,
    readonly learner: Learner,
    readonly runner: LocalRunner,
    probes: Policy[],
  ) {
    this.probes = [...probes];
  }

  async start(): Promise<void> {
    const atom = this.cache.get(this.key)!;
    await this.take(startAtom({
      conceptId: this.key, conceptKey: this.key, tag: atom.tag, lang: this.lang, pattern: atom.pattern,
      concept: this.learner.concepts[this.key], at: this.now, typeSensitive: tagInfo(atom.tag)?.typeSensitive,
    }));
    for (let guard = 0; !this.result && guard < 40; guard++) await this.respond();
    assert.ok(this.result, `the atom exits (stuck at ${this.state.step})`);
  }

  private async send(ev: AtomEvent): Promise<void> {
    await this.take(stepAtom(this.state, ev));
  }

  private async take(o: StepOutput): Promise<void> {
    this.state = o.state;
    for (const e of o.effects) {
      switch (e.type) {
        case 'pick': {
          const atom = this.cache.get(this.key)!;
          const seen = new Set(this.cache.seenIds(this.key));
          await this.send({ type: 'item', at: this.now, item: chooseItem(atom, e.request, { now: this.now, seen }) });
          break;
        }
        case 'render':
          this.render = renderView(e.view, { lang: this.lang });
          this.doc = this.render.text;
          this.views.push(e.view.kind);
          break;
        case 'evidence': {
          const r = recordEvidence(this.learner, e.evidence);
          assert.ok(r, `evidence on ${e.evidence.conceptId} was recorded`);
          this.evidence.push({ correct: e.evidence.correct, misconceptionId: e.evidence.misconceptionId, kind: e.evidence.kind });
          break;
        }
        case 'seen':
          this.shown.push(e.itemId);
          this.cache.markSeen(this.key, e.itemId, e.at);
          break;
        case 'item-stat':
          this.cache.recordItemStat(this.key, e.itemId, e.correct, e.ms);
          break;
        case 'mutant':
          assert.ok(this.cache.recordMutantResponse(this.key, e.mutantId, e.response), `mutant ${e.mutantId} is in the cache`);
          break;
        case 'run-completion': {
          const grade = await gradeCompletion(e.text, e.completion, this.runner, this.lang, { allowImports: tagInfo(this.key)?.allowedImports });
          await this.send({ type: 'completion-graded', at: this.now, grade });
          break;
        }
        case 'exit':
          this.result = e.result;
          break;
        default:
          break;
      }
    }
  }

  /** Answer whatever the pad is waiting for. */
  private async respond(): Promise<void> {
    this.now += 7000;
    const r = this.render;
    if (r.await === 'read') return this.send({ type: 'continue', at: this.now });
    if (r.await === 'yn') return this.send({ type: 'yn', at: this.now, yes: true });
    if (r.await === 'pick2' || r.await === 'pick3') return this.send({ type: 'pick', at: this.now, choice: r.correctPick!, latencyMs: 7000, latencyValid: true });
    const item = this.state.item;
    let text: string;
    let typed: number;
    if (item?.kind === 'completion' && r.snippet) {
      text = fillDoc(this.doc, item.completion);
      typed = item.completion.solutions.join('').length;
    } else {
      const answer = item?.kind === 'probe' ? answerFor(item.probe, this.probes.shift() ?? 'right', this.lang) : '?';
      text = this.answerAt(r, answer);
      typed = answer.length;
    }
    // Think, then type at about 2.5 characters per second: never an implicit (too fast) guess.
    const latencyMs = 8000 + typed * 400;
    this.now += latencyMs;
    return this.send({ type: 'submit', at: this.now, text, latencyMs, latencyValid: true });
  }

  private answerAt(r: PadRender, answer: string): string {
    const lines = this.doc.split('\n');
    const at = r.answerLine!;
    lines[at] = lines[at].slice(0, r.answerColumn ?? lines[at].length) + answer;
    return lines.join('\n');
  }
}

function answerFor(p: StoredProbe, policy: Policy, lang: Lang): string {
  if (policy === 'dont-know') return '?';
  const out: RecordedOutput = policy === 'mutant' && p.mutants.length ? p.mutants[0].output : p.output;
  return actualText(out, lang);
}

/** The completion pad with each ___ replaced by the solution of its blank. */
function fillDoc(doc: string, c: StoredCompletion): string {
  const order = [...c.code.matchAll(/\[\[(\d+)\]\]/g)].map((m) => Number(m[1]));
  let i = 0;
  return doc.replace(/___/g, () => c.solutions[(order[i++] ?? 1) - 1] ?? '');
}

async function seededCache(lang: Lang, tags: string[]): Promise<{ cache: AtomCache; atoms: Record<string, StoredAtom> }> {
  const b = bank(lang);
  const inst = new Instantiator(runnerFor(lang), 42);
  const { byTag, reports } = await inst.instantiate(b.templates.filter((t) => tags.includes(t.tag)), 4, { seed: 7 });
  for (const r of reports) assert.ok(r.valid >= 1, `${r.templateId}: ${JSON.stringify(r.rejected)} ${r.problems.join('; ')}`);
  const cache = new AtomCache(lang, undefined, { debounceMs: -1, now: () => clock.t });
  const atoms: Record<string, StoredAtom> = {};
  for (const tag of tags) {
    atoms[tag] = seedAtom(tag, lang, byTag[tag], b, Date.now());
    cache.put(atoms[tag]);
  }
  return { cache, atoms };
}

function freshLearner(tags: string[]): Learner {
  const l = emptyLearner();
  upsertConcepts(l, tags.map((t) => ({ id: t, name: t, tag: t })), Date.now());
  return l;
}

describe('atom pad on real seeds', () => {
  test('Python alias-copy: tested-out, a named belief, and the unknown path with a real completion', { timeout: 120_000 }, async (t) => {
    if (!rts.python) return t.skip('no python');
    const tag = 'alias-copy';
    const { cache } = await seededCache('python', [tag]);

    // Two right answers on different surfaces: tested out, P rises.
    let l = freshLearner([tag]);
    const p0 = l.concepts[tag].mastery;
    let pad = new Pad('python', tag, cache, l, runnerFor('python'), ['right', 'right']);
    await pad.start();
    assert.equal(pad.result!.path, 'tested-out', pad.views.join(' > '));
    assert.ok(l.concepts[tag].mastery > p0, 'P rose');
    assert.ok(pad.evidence.every((e) => e.correct === true));
    const shown = [...pad.shown];

    // The mutant's exact output names the belief; 'y' confirms it and the refutation runs.
    l = freshLearner([tag]);
    pad = new Pad('python', tag, cache, l, runnerFor('python'), ['mutant', 'right', 'right', 'right']);
    await pad.start();
    assert.ok(pad.views.includes('belief-check'), pad.views.join(' > '));
    const named = pad.evidence.find((e) => e.misconceptionId);
    assert.ok(named && named.correct === false, 'wrong evidence names the misconception');
    assert.ok(l.concepts[tag].misconceptions[named.misconceptionId!], 'the learner tracks the misconception');
    const mutants = cache.get(tag)!.probes.flatMap((p) => p.mutants);
    assert.ok(mutants.some((m) => m.matches === 1 && m.confirmations === 1), 'the cache counted the match and the y');
    assert.ok(['fixed', 'confirmed', 'partial'].includes(pad.result!.path), pad.result!.path);
    shown.push(...pad.shown);

    // '?' goes to the unknown path: example, completion (graded by the real runner), final predict.
    l = freshLearner([tag]);
    pad = new Pad('python', tag, cache, l, runnerFor('python'), ['dont-know', 'right', 'right']);
    await pad.start();
    assert.ok(pad.views.includes('example') && pad.views.includes('completion'), pad.views.join(' > '));
    const comp = pad.evidence.find((e) => e.kind === 'completion');
    assert.equal(comp?.correct, true, 'the solution fills pass the real harness');
    assert.ok(['learned', 'partial'].includes(pad.result!.path), pad.result!.path);
    shown.push(...pad.shown);
    assert.equal(new Set(shown).size, shown.length, 'no item repeats across the three atoms (7-day rule)');
  });

  for (const lang of ['javascript', 'typescript'] as const) {
    test(`${lang} loop-accumulator: the unknown path runs a real completion`, { timeout: 120_000 }, async (t) => {
      if (!rts[lang]) return t.skip(`no ${lang} runtime`);
      const tag = 'loop-accumulator';
      const { cache } = await seededCache(lang, [tag]);
      const l = freshLearner([tag]);
      const pad = new Pad(lang, tag, cache, l, runnerFor(lang), ['dont-know', 'right', 'right']);
      await pad.start();
      assert.ok(pad.views.includes('completion'), pad.views.join(' > '));
      assert.equal(pad.evidence.find((e) => e.kind === 'completion')?.correct, true, 'the solution fills pass the real harness');
      // A mutant answer names its belief through the same grader.
      const pad2 = new Pad(lang, tag, cache, freshLearner([tag]), runnerFor(lang), ['mutant', 'right', 'right', 'right']);
      await pad2.start();
      assert.ok(pad2.evidence.some((e) => e.misconceptionId), pad2.views.join(' > '));
    });
  }

  test('Python placement on seeded fundamentals: typing, predicts and a completion, then a summary', { timeout: 120_000 }, async (t) => {
    if (!rts.python) return t.skip('no python');
    const tags = ['variables-assignment', 'for-range-bounds', 'loop-accumulator', 'list-indexing', 'list-slicing', 'alias-copy'];
    const { atoms } = await seededCache('python', tags);
    const l = emptyLearner();
    upsertConcepts(l, tags.map((tag) => ({ id: tag, name: tag, tag, prerequisites: (tagInfo(tag)?.prereqs ?? []).filter((p) => tags.includes(p)) })), clock.t);
    const candidates = tags.map((tag) => ({ conceptId: tag, probes: atoms[tag].probes, completions: atoms[tag].completions }));
    let s = newPlacement(clock.t);
    const kinds: string[] = [];
    for (let i = 0; i < 30; i++) {
      const sources = { candidates, now: clock.t, lang: 'python' as const };
      const it = nextItem(s, sources, l, { needed: tags });
      if (!it) break;
      kinds.push(it.kind);
      if (it.kind === 'typing') {
        clock.t += 6000;
        recordTypingCalibration(l, it.literal.length, 4000);
        s = record(s, { kind: 'typing', at: clock.t });
        continue;
      }
      if (it.kind === 'completion') {
        const doc = renderView({ kind: 'completion', completion: it.completion }, { lang: 'python' }).text;
        const g = await gradeCompletion(fillDoc(doc, it.completion), it.completion, runnerFor('python'), 'python');
        assert.equal(g.pass, true, `${it.completion.id}: ${g.message}`);
        clock.t += 30_000;
        recordEvidence(l, { conceptId: it.conceptId, kind: 'completion', source: 'placement', correct: true, at: clock.t, itemId: it.completion.id, production: true });
        s = record(s, { conceptId: it.conceptId, itemId: it.completion.id, kind: 'completion', group: it.completion.group, correct: true, guess: false, latencyMs: 30_000, latencyValid: true, at: clock.t });
        continue;
      }
      const g = gradePredict(actualText(it.probe.output, 'python'), it.probe, 'python', !!tagInfo(it.conceptId)?.typeSensitive);
      assert.equal(g.correct, true, `${it.probe.id}: its own output is correct`);
      const latencyMs = 6000 + g.actual.length * 400;
      clock.t += latencyMs;
      recordEvidence(l, {
        conceptId: it.conceptId, kind: 'predict', source: 'placement', correct: true, at: clock.t, itemId: it.probe.id,
        siblingGroup: it.probe.group, g: it.probe.answerSpaceG, latencyMs, latencyValid: true, avoidedMisconceptionIds: g.avoidedMisconceptionIds,
      });
      s = record(s, { conceptId: it.conceptId, itemId: it.probe.id, kind: 'predict', group: it.probe.group, correct: true, guess: false, latencyMs, latencyValid: true, at: clock.t });
    }
    assert.equal(kinds[0], 'typing');
    assert.ok(kinds.filter((k) => k === 'predict').length >= 3, kinds.join(' '));
    const stop = shouldStop(s, { candidates, now: clock.t, lang: 'python' }, l, { needed: tags });
    assert.equal(stop.stop, true);
    const sum = placementSummary(s, l, { now: clock.t, needed: tags });
    assert.ok(sum.solid.length >= 1, sum.text);
    t.diagnostic(`${kinds.join(' ')} -> ${stop.reason}: ${sum.text}`);
  });

  test('Python traceback seeds render and grade on pad lines', { timeout: 60_000 }, async (t) => {
    if (!rts.python) return t.skip('no python');
    const { atoms } = await seededCache('python', ['reading-tracebacks']);
    const items = atoms['reading-tracebacks'].tracebacks;
    assert.ok(items.length >= 3);
    for (const item of items) {
      const r = renderTraceback(item, { lang: 'python' });
      const padLine = item.line + r.lineOffset!;
      const g = gradeTraceback(`line ${padLine}, ${item.exception}`, item, { lineOffset: r.lineOffset, pick: item.correctMeaning + 1 });
      assert.equal(g.correct, true, `${item.id}: line ${padLine}\n${r.text}`);
      assert.ok(r.text.includes(`line ${padLine}`), `${item.id}: the shown trace names pad line ${padLine}\n${r.text}`);
    }
  });
});

// =====================================================================================================
// Spec ladders and own-code probes through LocalRunner
// =====================================================================================================

function spec(id: string, call: string, expected: string, over: Partial<SpecItem> = {}): SpecItem {
  return { id, title: id, conceptId: 'c', call, expected, expectError: '', parSec: 20, failureSignatures: [], ...over };
}

function workspace(files: Record<string, string>): string {
  const ws = fs.mkdtempSync(path.join(work, 'ws-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), text);
  }
  return ws;
}

/** One spec run the way src/specs.ts will do it. */
async function runSpecs(lang: Lang, ws: string, file: string, specs: SpecItem[]) {
  const t = specTimeoutMs(undefined);
  const specDir = fs.mkdtempSync(path.join(work, 'specs-'));
  const specJson = path.join(specDir, 'task.json');
  fs.writeFileSync(specJson, JSON.stringify(buildHarnessInput(specs, { workspace: ws, timeoutMs: t })));
  const script = path.join(HARNESS_DIR, lang === 'python' ? 'harness.py' : 'harness.mjs');
  const r = await runnerFor(lang).runLearnerCode(script, [path.join(ws, file), specJson], { workspaceDir: ws, readDirs: [specDir], timeoutMs: t });
  return { r, rep: parseHarnessOutput(r.stdout, r.stderr, r.timedOut, { ids: specs.map((s) => s.id) }) };
}

const SOURCES: Record<Lang, { file: string; text: string }> = {
  python: {
    file: 'stats.py',
    text: "import json\n\ndef mean(xs):\n    return sum(xs) / len(xs)\n\ndef first_word(s):\n    return s.split()[0]\n\nif __name__ == '__main__':\n    print(mean([int(input())]))\n",
  },
  javascript: {
    file: 'stats.mjs',
    text: "export function mean(xs) {\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n\nexport function firstWord(s) {\n  return s.split(' ')[0];\n}\n",
  },
  typescript: {
    file: 'stats.ts',
    text: "export function mean(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n\nexport function firstWord(s: string): string {\n  return s.split(' ')[0];\n}\n",
  },
};

describe('spec runs, probes and ladders through LocalRunner', () => {
  for (const lang of ['python', 'javascript', 'typescript'] as const) {
    test(`${lang}: harness spec run (pass, fail, raise) and an own-code probe from stdin`, { timeout: 60_000 }, async (t) => {
      if (!rts[lang]) return t.skip(`no ${lang} runtime`);
      const { file, text } = SOURCES[lang];
      const ws = workspace({ [file]: text });
      const fw = lang === 'python' ? 'first_word' : 'firstWord';
      const specs = [
        spec('s1', 'mean([2, 4])', '3'),
        spec('s2', "mean([1, 2])", '2'), // wrong on purpose: 1.5
        spec('s3', `${fw}('')`, '', { expectError: lang === 'python' ? 'IndexError' : 'TypeError' }),
      ];
      const { r, rep } = await runSpecs(lang, ws, file, specs);
      assert.equal(rep.loadError, undefined, `${r.stderr}\n${r.stdout}`);
      const by = Object.fromEntries(rep.results.map((x) => [x.id, x]));
      assert.equal(by.s1?.pass, true, JSON.stringify(rep));
      assert.equal(by.s2?.pass, false);
      assert.equal(by.s2?.actual, '1.5');
      if (lang === 'python') assert.equal(by.s3?.pass, true, JSON.stringify(by.s3));

      // Own-code probe on the editor text (stdin), graded as a return value.
      const edited = text.replace('/ len(xs)', '// len(xs)').replace('/ xs.length', '/ xs.length + 1');
      const pr = await runnerFor(lang).runLearnerCode(
        path.join(HARNESS_DIR, lang === 'python' ? 'probe.py' : 'probe.mjs'),
        [path.join(ws, file), 'mean([3, 4])', '--stdin', '--workspace', ws, '--timeout-ms', '3000'],
        { workspaceDir: ws, timeoutMs: 3500, stdin: edited },
      );
      const out = parseProbeOutput(pr.stdout, pr.stderr, pr.timedOut);
      assert.equal(out.ok, true, `${pr.stderr}\n${pr.stdout}`);
      const recorded: RecordedOutput = { stdout: out.repr!, values: [[{ type: out.type!, repr: out.repr!, val: out.val! }]] };
      const expected = lang === 'python' ? '3' : '4.5';
      assert.equal(compareOutput(expected, recorded, lang, { typeSensitive: false, returnValue: true }).verdict, 'correct', JSON.stringify(out));
      if (lang === 'python') assert.equal(compareOutput('3.5', recorded, lang, { typeSensitive: false, returnValue: true }).verdict, 'wrong');
    });
  }

  test('Python and JavaScript: verifySpecLadder drops a wrong spec through LocalRunner', { timeout: 60_000 }, async (t) => {
    for (const lang of ['python', 'javascript'] as const) {
      if (!rts[lang]) {
        t.diagnostic(`no ${lang} runtime`);
        continue;
      }
      const { file, text } = SOURCES[lang];
      const ws = workspace({ [file]: lang === 'python' ? 'def mean(xs):\n    return 0\n' : 'export function mean(xs) {\n  return 0;\n}\n' });
      const iface: TaskInterface = { file, functions: [{ name: 'mean', signature: 'mean(xs)', purpose: '' }] };
      const ladder: SpecLadderDraft = {
        applicable: true, reason: '',
        specs: [spec('s1', 'mean([2, 4])', '3'), spec('s2', 'mean([1, 2, 3])', '2'), spec('s3', 'mean([1, 2])', '2')],
        hidden: [spec('h1', 'mean([5])', '5')],
        reference: text,
      };
      const res = await verifySpecLadder(ladder, iface, { runner: runnerFor(lang), workspaceDir: ws, harnessDir: HARNESS_DIR, tmpRoot: path.join(work, `verify-${lang}`) });
      assert.equal(res.verified, true, `${lang}: ${res.reason} ${JSON.stringify(res.dropped)}`);
      assert.deepEqual(res.specs.map((s) => s.id), ['s1', 's2'], `${lang}: ${JSON.stringify(res.dropped)}`);
      assert.deepEqual(res.dropped.map((d) => d.id), ['s3']);
    }
  });

  for (const lang of ['python', 'javascript'] as const) {
    test(`${lang}: a what-if mutant runs through probe and attributes the unmutated answer`, { timeout: 60_000 }, async (t) => {
      if (!rts[lang]) return t.skip(`no ${lang} runtime`);
      const file = lang === 'python' ? 'total.py' : 'total.mjs';
      const text = lang === 'python'
        ? 'def total(n):\n    s = 0\n    for i in range(1, n):\n        s += i\n    return s\n'
        : 'export function total(n) {\n  let s = 0;\n  for (let i = 1; i < n; i++) {\n    s += i;\n  }\n  return s;\n}\n';
      const ws = workspace({ [file]: text });
      const lines = text.split('\n').map((l, i) => ({ line: i + 1, text: l }));
      const [c] = whatIfCandidates(lines, lang, { weakestTag: 'for-range-bounds', max: 1 });
      assert.ok(c, 'a loop-bound what-if exists');
      const probe = async (source: string): Promise<RecordedOutput> => {
        const r = await runnerFor(lang).runLearnerCode(
          path.join(HARNESS_DIR, lang === 'python' ? 'probe.py' : 'probe.mjs'),
          [path.join(ws, file), 'total(5)', '--stdin', '--workspace', ws, '--timeout-ms', '3000'],
          { workspaceDir: ws, timeoutMs: 3500, stdin: source },
        );
        const o = parseProbeOutput(r.stdout, r.stderr, r.timedOut);
        assert.equal(o.ok, true, `${r.stderr}\n${r.stdout}`);
        return { stdout: o.repr!, values: [[{ type: o.type!, repr: o.repr!, val: o.val! }]] };
      };
      const mutatedText = lines.map((l) => (l.line === c.line ? c.mutated : l.text)).join('\n');
      const [actual, unmutated] = await Promise.all([probe(mutatedText), probe(text)]);
      assert.notEqual(actual.stdout, unmutated.stdout, `${c.op}: the what-if changes the result`);
      const right = attributeWhatIf(actual.stdout, { actual, unmutated }, lang, c.op);
      assert.equal(right.correct, true);
      const stale = attributeWhatIf(unmutated.stdout, { actual, unmutated }, lang, c.op);
      assert.equal(stale.attributable, true, 'answering the unmutated result is attributable');
      assert.equal(stale.misconceptionId, c.misconceptionId);
    });
  }

  test('spec-call mutation feeds own-code probes (calls.ts)', () => {
    const visible = ['mean([2, 4])', 'mean([1, 2, 3])'];
    for (const v of visible) assert.equal(validateCall(v, 'python', ['mean']).ok, true);
    const cands = mutateLiteral(visible[0], 'python').filter((m) => !visible.some((s) => sameArgs(parseCall(m, 'python').args, parseCall(s, 'python').args)));
    assert.ok(cands.length >= 2, JSON.stringify(cands));
    assert.equal(renameCallee(cands[0], 'average').startsWith('average('), true);
  });
});

// =====================================================================================================
// Model packs through LocalRunner
// =====================================================================================================

describe('model pack verification through LocalRunner', () => {
  test('Python: a hand-written pack verifies, runs both passes and lands in the cache', { timeout: 60_000 }, async (t) => {
    if (!rts.python) return t.skip('no python');
    const probe = (code: string, answer: string, mutantCode: string, prints: string) => ({
      id: '', code, answer, siblingGroup: 'g', parSec: 5,
      mutants: [{ misconceptionId: 'assignment-copies', belief: 'b = a makes a separate copy of the list', code: mutantCode, prints, refutation: 'The second name points at the same list.' }],
    });
    const pack = {
      atoms: [{
        conceptId: 'alias', tag: 'alias-copy',
        pattern: { kind: 'semantics', name: tagInfo('alias-copy')!.patternName, useWhen: 'two names', template: 'b = a.copy()', rule: 'Assignment never copies.', howItRuns: 'one object', pitfall: 'aliasing', useCases: ['a', 'b', 'c', 'd', 'e', 'f'] },
        probes: [
          probe('a = [1, 2]\nb = a\nb.append(30)\nprint(a)', '[1, 2, 30]', 'a = [1, 2]\nb = a.copy()\nb.append(30)\nprint(a)', '[1, 2]'),
          probe('xs = [5]\nys = xs\nys += [70]\nprint(xs)', '[5, 70]', 'xs = [5]\nys = xs.copy()\nys += [70]\nprint(xs)', '[5]'),
          probe('d = {"k": 1}\ne = d\ne["k"] = 50\nprint(d["k"])', '50', 'd = {"k": 1}\ne = d.copy()\ne["k"] = 50\nprint(d["k"])', '1'),
          probe('row = [0, 0]\ngrid = [row, row]\ngrid[0][1] = 77\nprint(grid[1])', '[0, 77]', 'row = [0, 0]\ngrid = [row.copy(), row]\ngrid[0][1] = 77\nprint(grid[1])', '[0, 0]'),
        ].map((p, i) => ({ ...p, id: `p${i + 1}`, siblingGroup: `g${i + 1}` })),
        example: { code: 'a = [1]\nb = a.copy()\nb.append(2)\nprint(a, b)', subgoals: [{ line: 2, label: 'make a real copy' }] },
        completion: {
          code: 'def extended(xs, y):\n    out = [[1]]\n    out.append(y)\n    return out', solutions: ['xs.copy()'],
          wrongFills: [{ blank: 1, fill: 'xs', misconceptionId: 'assignment-copies' }],
          harness: "a = [1]\ncheck(extended(a, 2) == [1, 2], 'returns both')\ncheck(extended([], 5) == [5], 'works when empty')\ncheck(a == [1], 'leaves xs alone')",
          parSec: 25,
        },
        contrast: { wrong: 'a = [1]\nb = a.copy()\nb.append(9)\nprint(a)', right: 'a = [1]\nb = a\nb.append(9)\nprint(a)', misconceptionId: 'assignment-copies', rule: 'b = a shares one list.' },
      }],
    } as unknown as AtomPack;
    const r = await verifyPack(pack, runnerFor('python'), 'python', { concepts: [{ id: 'alias', tag: 'alias-copy' }] });
    assert.ok(r.atom, r.log.join('\n'));
    assert.equal(r.atom.verified, true);
    assert.equal(r.atom.probes.length, 4, r.log.join('\n'));
    assert.ok(r.atom.probes.every((p) => p.discriminating && p.mutants.length === 1), 'every mutant can name its belief');
    const cache = new AtomCache('python', undefined, { debounceMs: -1 });
    cache.put(r.atom);
    assert.equal(cache.unseenProbes(r.atom.key, 5).length, 4);
  });
});
