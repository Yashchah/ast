// The extension shell's pure decisions (src/shell.ts) and the packaging contract: package.json holds
// every docs/stage2/*.package.json fragment, the v0.2 settings and scripts; .vscodeignore keeps the
// bundled runtime files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AtomResult, StoredAtom, StoredMutant, StoredProbe } from '../src/contracts';
import * as shell from '../src/shell';
import type { ConceptState, Project, Task } from '../src/types';

const root = path.resolve(__dirname, '..');
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

// =====================================================================================
// consent
// =====================================================================================

test('consent: an explicit setting wins, ask uses the saved answer, Not now is off for the session', () => {
  assert.equal(shell.resolveConsent('all', 'off', false), 'all');
  assert.equal(shell.resolveConsent('off', 'all', false), 'off');
  assert.equal(shell.resolveConsent('snippets', undefined, true), 'snippets');
  assert.equal(shell.resolveConsent('ask', 'snippets', false), 'snippets');
  assert.equal(shell.resolveConsent('ask', 'all', true), 'all');
  assert.equal(shell.resolveConsent('ask', undefined, true), 'off');
  assert.equal(shell.resolveConsent('ask', undefined, false), 'ask');
});

test('consent: execution needs a trusted workspace; snippets and learner code are separate', () => {
  assert.deepEqual(shell.executionState('all', undefined, false, false), { consent: 'all', trusted: false, snippets: false, learnerCode: false });
  assert.deepEqual(shell.executionState('all', undefined, false, true), { consent: 'all', trusted: true, snippets: true, learnerCode: true });
  assert.deepEqual(shell.executionState('ask', 'snippets', false, true), { consent: 'snippets', trusted: true, snippets: true, learnerCode: false });
  assert.deepEqual(shell.executionState('off', 'all', false, true), { consent: 'off', trusted: true, snippets: false, learnerCode: false });
  const undecided = shell.executionState('ask', undefined, false, true);
  assert.equal(undecided.snippets, false);
  assert.equal(undecided.learnerCode, false);
});

test('consent: ask only when undecided, trusted, and something can run', () => {
  const s = (setting: shell.LocalExecutionSetting, trusted = true, declined = false) => shell.executionState(setting, undefined, declined, trusted);
  assert.equal(shell.shouldAskConsent(s('ask'), true), true);
  assert.equal(shell.shouldAskConsent(s('ask'), false), false, 'no runtime: nothing to ask about');
  assert.equal(shell.shouldAskConsent(s('ask', false), true), false, 'untrusted: never ask');
  assert.equal(shell.shouldAskConsent(s('ask', true, true), true), false, 'Not now this session');
  assert.equal(shell.shouldAskConsent(s('all'), true), false);
  assert.equal(shell.shouldAskConsent(s('off'), true), false);
});

test('consent: the modal text and buttons follow the spec; Not now saves nothing', () => {
  assert.equal(
    shell.CONSENT_MESSAGE,
    'Deliberate grades practice instantly by running short snippets in a temp folder (3 s limit, no file, process or network modules) and, if you allow it, by calling your own functions with test inputs from a temp folder.',
  );
  assert.equal(shell.choiceFromButton('Snippets and my code'), 'all');
  assert.equal(shell.choiceFromButton('Snippets only'), 'snippets');
  assert.equal(shell.choiceFromButton('Not now'), undefined);
  assert.equal(shell.choiceFromButton(undefined), undefined);
  assert.deepEqual(shell.CONSENT_PICKS.map((p) => p.choice), ['all', 'snippets', 'off']);
});

test('consent: garbage in settings and globalState is treated as undecided', () => {
  assert.equal(shell.normalizeSetting('ALL'), 'ask');
  assert.equal(shell.normalizeSetting(undefined), 'ask');
  assert.equal(shell.normalizeSetting('snippets'), 'snippets');
  assert.equal(shell.normalizeChoice('yes'), undefined);
  assert.equal(shell.normalizeChoice(3), undefined);
  assert.equal(shell.normalizeChoice('off'), 'off');
});

test('consent: changes are reported per capability', () => {
  const off = shell.executionState('off', undefined, false, true);
  const snip = shell.executionState('snippets', undefined, false, true);
  const all = shell.executionState('all', undefined, false, true);
  assert.deepEqual(shell.executionChanged(off, snip), { snippets: true, learnerCode: false });
  assert.deepEqual(shell.executionChanged(snip, all), { snippets: false, learnerCode: true });
  assert.deepEqual(shell.executionChanged(all, all), { snippets: false, learnerCode: false });
  assert.deepEqual(shell.executionChanged(undefined, off), { snippets: true, learnerCode: true });
});

test('execution summary names the state and the runtimes', () => {
  const v = { python: '3.14.0', javascript: '24.11.1' };
  assert.match(shell.executionSummary(shell.executionState('all', undefined, false, true), v), /snippets and your code \(Python 3\.14\.0 · Node 24\.11\.1\)/);
  assert.match(shell.executionSummary(shell.executionState('all', undefined, false, false), v), /untrusted/);
  assert.match(shell.executionSummary(shell.executionState('ask', undefined, false, true), {}), /not decided.*no Python or Node found/);
  assert.match(shell.executionSummary(shell.executionState('off', undefined, false, true), v), /off: practice uses unverified/);
});

// =====================================================================================
// no runtime, stock languages, inline AI, job settings
// =====================================================================================

test("the 'No Python found' flash is for a Python project without Python", () => {
  assert.equal(shell.noRuntimeFlash('python', {}), 'No Python found: practice runs unverified (set deliberate.pythonPath)');
  assert.equal(shell.noRuntimeFlash('python', { python: {} }), undefined);
  assert.equal(shell.noRuntimeFlash('javascript', { python: {} }), shell.NO_NODE_FLASH);
  assert.equal(shell.noRuntimeFlash(undefined, {}), undefined);
});

test('stock: the project language only, else every language with a runtime, else all (neutral items)', () => {
  assert.deepEqual(shell.stockLanguages('typescript', { python: {} }), ['typescript']);
  assert.deepEqual(shell.stockLanguages(undefined, { javascript: {}, python: {} }), ['python', 'javascript']);
  assert.deepEqual(shell.stockLanguages(undefined, {}), ['python', 'javascript', 'typescript']);
});

test('inline AI offer: once per workspace, while building, when a known extension is active', () => {
  const base = { active: ['GitHub.copilot'], offered: false, inlineSuggestEnabled: true, building: true };
  assert.equal(shell.inlineAiOfferDue(base), true);
  assert.equal(shell.inlineAiOfferDue({ ...base, offered: true }), false);
  assert.equal(shell.inlineAiOfferDue({ ...base, building: false }), false);
  assert.equal(shell.inlineAiOfferDue({ ...base, inlineSuggestEnabled: false }), false);
  assert.equal(shell.inlineAiOfferDue({ ...base, active: [] }), false);
  assert.deepEqual([...shell.INLINE_AI_EXTENSIONS], ['GitHub.copilot', 'GitHub.copilot-chat', 'Codeium.codeium', 'TabNine.tabnine-vscode', 'supermaven.supermaven']);
  assert.equal(shell.INLINE_AI_MESSAGE, 'Turn off inline AI suggestions in this workspace while you do tasks? Your practice evidence stays accurate.');
  assert.deepEqual(shell.INLINE_AI_BUTTONS, { off: 'Turn off here', keep: 'Keep' });
});

test('job settings are clamped to the documented ranges', () => {
  const get = (o: Record<string, unknown>) => (k: string) => o[k];
  assert.deepEqual(shell.jobSettings(get({})), { concurrency: 2, callsPerHour: 20 });
  assert.deepEqual(shell.jobSettings(get({ backgroundConcurrency: 0, backgroundCallsPerHour: 2 })), { concurrency: 1, callsPerHour: 6 });
  assert.deepEqual(shell.jobSettings(get({ backgroundConcurrency: 9, backgroundCallsPerHour: 40 })), { concurrency: 3, callsPerHour: 40 });
  assert.deepEqual(shell.jobSettings(get({ backgroundConcurrency: Number.NaN, backgroundCallsPerHour: '12' })), { concurrency: 2, callsPerHour: 20 });
  assert.deepEqual(shell.jobSettings(get({ backgroundConcurrency: 2.6 })), { concurrency: 3, callsPerHour: 20 });
});

// =====================================================================================
// coverage
// =====================================================================================

function mutant(id: string, misconceptionId: string, ambiguous = false): StoredMutant {
  return {
    id, misconceptionId, belief: 'b', refutation: '', rule: '', code: 'x', output: { stdout: '1\n', values: [] }, diffLine: 1, source: 'curated',
    ambiguous, matches: 0, confirmations: 0, rejections: 0,
  };
}

function atom(over: Partial<StoredAtom> & { mutants?: StoredMutant[] } = {}): StoredAtom {
  const probe: StoredProbe = {
    id: 'p#1', group: 'g', code: 'print(1)', output: { stdout: '1\n', values: [] }, parSec: 4, answerSpaceG: 0.2, constructs: [], discriminating: true,
    mutants: over.mutants ?? [], stats: { seenAt: [], n: 0, nCorrect: 0 },
  };
  return {
    key: 'list-slicing', lang: 'python', conceptId: 'list-slicing', tag: 'list-slicing', source: 'seed', verified: true, createdAt: 1,
    pattern: { kind: 'shape', name: 'Slice a sequence', useWhen: '', template: '', rule: '', howItRuns: '', pitfall: '', useCases: [] } as StoredAtom['pattern'],
    probes: [probe], examples: [], completions: [], contrasts: [], tracebacks: [], ...over,
  };
}

test('coverage: taxonomy misconceptions with prior >= .2 that verified bank items carry', () => {
  const a = atom({ mutants: [mutant('m1', 'slice-end-included'), mutant('m2', 'slice-past-end-errors'), mutant('m3', 'index-starts-at-one', true)] });
  // index-starts-at-one (.2) is only carried by an ambiguous mutant; slice-past-end-errors has prior .15.
  assert.deepEqual(shell.requiredCoverage('list-slicing', 'python', a), ['slice-end-included']);
  assert.deepEqual(shell.requiredCoverage('list-slicing', 'python', atom({ verified: false, mutants: [mutant('m1', 'slice-end-included')] })), []);
  assert.deepEqual(shell.requiredCoverage('list-slicing', 'python', undefined), []);
  assert.deepEqual(shell.requiredCoverage(undefined, 'python', a), []);
});

test('coverage index: prefers the project language, memoises, and invalidates', () => {
  let calls = 0;
  const atoms: Record<string, StoredAtom | undefined> = { 'python|list-slicing': atom({ mutants: [mutant('m1', 'slice-end-included')] }) };
  let now = 1000;
  const idx = new shell.CoverageIndex({
    lang: () => 'python',
    atom: (l, key) => {
      calls++;
      return atoms[`${l}|${key}`];
    },
    has: (l, key) => !!atoms[`${l}|${key}`],
    now: () => now,
    ttlMs: 500,
  });
  const c = { id: 'slicing-plan-id', tag: 'list-slicing' } as ConceptState;
  assert.deepEqual(idx.coverage(c), ['slice-end-included']);
  assert.deepEqual(idx.coverage(c), ['slice-end-included']);
  assert.equal(calls, 1, 'memoised');
  now += 600;
  idx.coverage(c);
  assert.equal(calls, 2, 'expired');
  idx.invalidate();
  idx.coverage(c);
  assert.equal(calls, 3, 'invalidated');
  assert.deepEqual(idx.coverage({ id: 'x', tag: 'other' } as ConceptState), []);
  assert.deepEqual(idx.coverage({ id: 'y' } as ConceptState), []);
  assert.deepEqual(idx.taxonomy('slice-end-included', c), { belief: 'The slice includes the item at the stop index', prior: 0.4 });
  assert.equal(idx.taxonomy('no-such-id', c), undefined);
});

test('coverage index: without a project language it uses a language whose bank has the concept', () => {
  const idx = new shell.CoverageIndex({
    lang: () => undefined,
    atom: (l) => (l === 'javascript' ? atom({ lang: 'javascript', mutants: [mutant('m1', 'slice-end-included')] }) : undefined),
    has: (l, key) => l === 'javascript' && key === 'list-slicing',
  });
  assert.deepEqual(idx.coverage({ id: 'list-slicing', tag: 'list-slicing' } as ConceptState), ['slice-end-included']);
});

// =====================================================================================
// pace extras
// =====================================================================================

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, title: id, description: '', acceptanceCriteria: [], conceptIds: [], estimatedMinutes: 10, kind: 'roadmap', followUpDepth: 0, status: 'todo',
    phase: 'building', activeMs: 0, stuckMs: 0, explainAttempts: 0, hints: [], revealed: false, offeredRung: 0, feed: [], ...over,
  };
}

function project(tasks: Task[], over: Partial<Project> = {}): Project {
  return {
    goal: 'g', title: 't', summary: '', language: 'python', lang: 'python', createdAt: 1_000_000, conceptIds: [],
    milestones: [{ title: 'M1', taskIds: tasks.map((t) => t.id) }], tasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
    placement: { asked: [], startedAt: 0, done: true, selfRated: false, planPending: false, calibrated: false }, prefetch: {}, taskSwitch: 0, feed: [],
    ...over,
  };
}

const run = (path: AtomResult['path'], sec: number, misconceptionId?: string): AtomResult => ({
  conceptId: 'c', path, items: 2, ms: sec * 1000, stateBefore: 'Unknown', stateAfter: 'Learning', ...(misconceptionId ? { misconceptionId } : {}),
});

test('pace: block kinds come from the atom path', () => {
  assert.equal(shell.blockKind(run('tested-out', 1)), 'known');
  assert.equal(shell.blockKind(run('fixed', 1)), 'misconception');
  assert.equal(shell.blockKind(run('escalated', 1)), 'misconception');
  assert.equal(shell.blockKind(run('confirmed', 1)), 'misconception');
  assert.equal(shell.blockKind(run('learned', 1)), 'unknown');
  assert.equal(shell.blockKind(run('partial', 1)), 'unknown');
  assert.equal(shell.blockKind(run('partial', 1, 'slice-end-included')), 'misconception');
  assert.equal(shell.blockKind(run('aborted', 1)), undefined);
});

test('pace: first keystroke, median block times, model wait per task and solo unaided rate', () => {
  const t1 = task('t1', { status: 'done', waitMs: 2000, atomRuns: [run('tested-out', 20), run('tested-out', 40), run('fixed', 65)] });
  const t2 = task('t2', { status: 'done', waitMs: 9000, atomRuns: [run('learned', 110), run('aborted', 5)] });
  const t3 = task('t3', { status: 'done', solo: true, activeMs: 12 * 60000, waitMs: 4000 });
  const t4 = task('t4', { status: 'done', solo: true, activeMs: 20 * 60000, hints: [{ rung: 2, at: 1, diagnosis: '', html: '' }] });
  const t5 = task('t5', { status: 'active', waitMs: 100_000 });
  const p = project([t1, t2, t3, t4, t5]);
  const x = shell.paceExtras(p, { projectCreatedAt: p.createdAt, at: p.createdAt + 185_000 });
  assert.equal(x.firstKeystrokeSec, 185);
  assert.deepEqual(x.blocks.known, { count: 2, medianSec: 30 });
  assert.deepEqual(x.blocks.misconception, { count: 1, medianSec: 65 });
  assert.deepEqual(x.blocks.unknown, { count: 1, medianSec: 110 });
  assert.equal(x.waitPerTaskSec, 3, 'median over finished tasks only (0, 2, 4, 9 s)');
  assert.deepEqual(x.solo, { count: 2, unaided: 1, rate: 0.5, medianMin: 16 });
  // A first keystroke recorded for another project is ignored.
  assert.equal(shell.paceExtras(p, { projectCreatedAt: 5, at: p.createdAt + 1 }).firstKeystrokeSec, undefined);
  assert.deepEqual(shell.paceExtras(undefined), { blocks: { known: { count: 0 }, misconception: { count: 0 }, unknown: { count: 0 } }, solo: { count: 0, unaided: 0 } });
});

test('pace: unaided means no rung 2+ hint, no reveal and under 120 pasted or assisted characters', () => {
  assert.equal(shell.unaided(task('a', { hints: [{ rung: 1, at: 1, diagnosis: '', html: '' }] })), true);
  assert.equal(shell.unaided(task('b', { revealed: true })), false);
  assert.equal(shell.unaided(task('c', { pastedChars: 60, assistedChars: 60 })), false);
  assert.equal(shell.unaided(task('d', { pastedChars: 60, assistedChars: 59 })), true);
});

test('pace: the first keystroke is recorded once, in task 1 while building', () => {
  const t1 = task('t1', { status: 'active', phase: 'building' });
  const t2 = task('t2');
  const p = project([t1, t2], { currentTaskId: 't1' });
  assert.equal(shell.firstKeystrokeDue(p, undefined), true);
  assert.equal(shell.firstKeystrokeDue(p, { projectCreatedAt: p.createdAt, at: 1 }), false, 'already recorded for this project');
  assert.equal(shell.firstKeystrokeDue(p, { projectCreatedAt: 1, at: 1 }), true, 'a record from an older project does not count');
  assert.equal(shell.firstKeystrokeDue({ ...p, currentTaskId: 't2' }, undefined), false, 'not task 1');
  assert.equal(shell.firstKeystrokeDue(project([task('t1', { status: 'active', phase: 'gate' }), t2], { currentTaskId: 't1' }), undefined), false);
  assert.equal(shell.firstKeystrokeDue(project([task('t1', { status: 'active', phase: 'learning', resumePhase: 'building' }), t2], { currentTaskId: 't1' }), undefined), true);
  assert.equal(shell.firstKeystrokeDue(undefined, undefined), false);
});

test('spec greens: only specs that newly pass count as a pause', () => {
  const before = shell.passing({ s1: { pass: true }, s2: { pass: false } });
  assert.deepEqual([...before], ['s1']);
  assert.deepEqual(shell.newlyGreen(before, { s1: { pass: true }, s2: { pass: true }, s3: { pass: false } }), ['s2']);
  assert.deepEqual(shell.newlyGreen(before, { s1: { pass: true } }), []);
  assert.deepEqual([...shell.passing(undefined)], []);
});

test('runtime versions for the sidebar line', () => {
  assert.deepEqual(shell.runtimeVersions({ python: { version: '3.14.0' }, typescript: undefined }), { python: '3.14.0' });
});

test('median', () => {
  assert.equal(shell.median([]), undefined);
  assert.equal(shell.median([3, 1, 2]), 2);
  assert.equal(shell.median([4, 1, 3, 2]), 2.5);
  assert.equal(shell.median([Number.NaN, 5]), 5);
});

// =====================================================================================
// packaging
// =====================================================================================

const pkg = readJson('package.json');
const contributes = pkg.contributes;
const props: Record<string, Record<string, unknown>> = contributes.configuration.properties;

test('package.json: version, scripts and activation', () => {
  assert.equal(pkg.version, '0.2.0');
  assert.equal(pkg.scripts['verify:seeds'], 'tsx scripts/verify-seeds.ts');
  const pack: string = pkg.scripts.package;
  for (const step of ['npm run typecheck', 'npm test', 'verify:seeds -- python', 'verify:seeds -- javascript', 'verify:seeds -- typescript', 'esbuild.mjs --production', 'vsce package']) {
    assert.ok(pack.includes(step), `package runs ${step}`);
  }
  assert.ok(pack.indexOf('verify:seeds') < pack.indexOf('vsce package'));
  assert.ok(pkg.activationEvents.includes('onStartupFinished'));
  assert.ok(pkg.activationEvents.includes('onFileSystem:deliberate-pad'));
});

test('package.json: v0.2 settings with their scopes, defaults and ranges', () => {
  assert.deepEqual(props['deliberate.localExecution'].enum, ['ask', 'snippets', 'all', 'off']);
  assert.equal(props['deliberate.localExecution'].default, 'ask');
  for (const k of ['deliberate.localExecution', 'deliberate.pythonPath', 'deliberate.codexPath']) assert.equal(props[k].scope, 'machine', k);
  assert.deepEqual([props['deliberate.backgroundConcurrency'].default, props['deliberate.backgroundConcurrency'].minimum, props['deliberate.backgroundConcurrency'].maximum], [2, 1, 3]);
  assert.deepEqual([props['deliberate.backgroundCallsPerHour'].default, props['deliberate.backgroundCallsPerHour'].minimum], [20, 6]);
  assert.deepEqual(props['deliberate.planEffort'].enum, ['medium', 'high']);
  assert.equal(props['deliberate.maxFollowUps'].default, 2);
  assert.equal(props['deliberate.nameNewMisconceptions'].default, false);
  assert.equal(props['deliberate.polishReview'].default, false);
  assert.equal(props['deliberate.showTimers'].default, true);
  assert.deepEqual(props['deliberate.padColumn'].enum, ['beside', 'active']);
  assert.ok(!contributes.commands.some((c: { command: string }) => c.command === 'deliberate.speedDrill'), 'the LLM speed drill is gone');
});

test('package.json: every docs/stage2 fragment is merged', () => {
  const dir = path.join(root, 'docs', 'stage2');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.package.json'));
  assert.ok(files.length >= 4);
  const commands = new Set(contributes.commands.map((c: { command: string }) => c.command));
  const kb = (k: Record<string, unknown>) => JSON.stringify([k.command, k.key, k.mac ?? null, k.when ?? null, k.args ?? null]);
  const keybindings = new Set(contributes.keybindings.map(kb));
  const palette = new Set(contributes.menus.commandPalette.map((m: { command: string; when?: string }) => `${m.command}|${m.when}`));
  for (const f of files) {
    const frag = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const c of frag.commands ?? []) assert.ok(commands.has(c.command), `${f}: command ${c.command}`);
    for (const k of frag.keybindings ?? []) assert.ok(keybindings.has(kb(k)), `${f}: keybinding ${kb(k)}`);
    for (const m of frag.menus?.commandPalette ?? []) assert.ok(palette.has(`${m.command}|${m.when}`), `${f}: palette ${m.command}`);
    for (const [k, v] of Object.entries<Record<string, unknown>>(frag.settings ?? {})) {
      assert.ok(props[k], `${f}: setting ${k}`);
      assert.deepEqual(props[k].default, v.default, `${f}: default of ${k}`);
      if (v.enum) assert.deepEqual(props[k].enum, v.enum, `${f}: enum of ${k}`);
    }
    for (const e of frag.activationEvents ?? []) assert.ok(pkg.activationEvents.includes(e), `${f}: activation ${e}`);
    for (const l of frag.languages ?? []) assert.deepEqual(contributes.languages.find((x: { id: string }) => x.id === l.id), l, `${f}: language ${l.id}`);
    for (const g of frag.grammars ?? []) assert.deepEqual(contributes.grammars.find((x: { language: string }) => x.language === g.language), g, `${f}: grammar ${g.language}`);
    for (const [k, v] of Object.entries(frag.configurationDefaults ?? {})) assert.deepEqual(contributes.configurationDefaults[k], v, `${f}: configurationDefaults ${k}`);
  }
});

test('package.json: every file it points at exists', () => {
  for (const l of contributes.languages) assert.ok(fs.existsSync(path.join(root, l.configuration)), l.configuration);
  for (const g of contributes.grammars) assert.ok(fs.existsSync(path.join(root, g.path)), g.path);
  assert.ok(fs.existsSync(path.join(root, contributes.viewsContainers.activitybar[0].icon)));
});

test('.vscodeignore keeps the runtime files and drops sources, tests, docs, scripts and caches', () => {
  const lines = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const want of ['src/**', 'test/**', 'scripts/**', 'docs/**', '**/__pycache__/**', '*.vsix']) assert.ok(lines.includes(want), want);
  for (const keep of ['media', 'syntaxes', 'dist']) assert.ok(!lines.some((l) => l.replace(/^!/, '').startsWith(keep)), `${keep} is shipped`);
  for (const dir of ['media/seed', 'media/runner', 'media/harness', 'syntaxes']) assert.ok(fs.existsSync(path.join(root, dir)), dir);
});
