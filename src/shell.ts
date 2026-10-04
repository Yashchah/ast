// Pure decision logic for the extension shell (src/extension.ts): local-execution consent, the
// inline-AI offer, the 'no runtime' flash, the evidence environment's coverage lookup, background
// job settings and the Pace extras the sidebar shows. No vscode import, so test/shell.test.ts runs it
// under node; extension.ts only wires these to the VS Code API.

import type { AtomResult, Lang, StoredAtom } from './contracts';
import { misconceptionsFor, findMisconception, tagInfo } from './atoms/tags';
import type { ConceptState, Project, Task } from './types';

const LANGS: readonly Lang[] = ['python', 'javascript', 'typescript'];

// =====================================================================================
// Local execution consent (spec V1-2 CONSENT)
// =====================================================================================

/** deliberate.localExecution (scope machine, so a workspace .vscode/settings.json cannot switch execution on). */
export type LocalExecutionSetting = 'ask' | 'snippets' | 'all' | 'off';
/** What the learner decided (or the setting forces). */
export type ConsentChoice = 'snippets' | 'all' | 'off';

/** globalState key of the modal's answer. */
export const CONSENT_KEY = 'deliberate.localExecution.choice';

export const CONSENT_MESSAGE =
  'Deliberate grades practice instantly by running short snippets in a temp folder (3 s limit, no file, process or network modules) and, if you allow it, by calling your own functions with test inputs from a temp folder.';

export const CONSENT_BUTTONS = {
  all: 'Snippets and my code',
  snippets: 'Snippets only',
  notNow: 'Not now',
} as const;

/** The 'Choose what practice may run' picker (deliberate.chooseExecution). */
export const CONSENT_PICKS: readonly { label: string; detail: string; choice: ConsentChoice }[] = [
  {
    label: CONSENT_BUTTONS.all,
    detail: 'Practice snippets, plus your own functions with test inputs (behaviour specs, predict-your-function, what-ifs). Always from a temp folder.',
    choice: 'all',
  },
  {
    label: CONSENT_BUTTONS.snippets,
    detail: 'Only the short practice snippets. Your tasks are reviewed by the model instead of by specs.',
    choice: 'snippets',
  },
  {
    label: 'Run nothing',
    detail: 'Practice uses unverified answer keys; no specs or own-code checks.',
    choice: 'off',
  },
];

export function normalizeSetting(v: unknown): LocalExecutionSetting {
  return v === 'snippets' || v === 'all' || v === 'off' ? v : 'ask';
}

export function normalizeChoice(v: unknown): ConsentChoice | undefined {
  return v === 'snippets' || v === 'all' || v === 'off' ? v : undefined;
}

/**
 * The consent in force: an explicit setting wins; 'ask' uses the modal's saved answer; 'Not now'
 * (or a dismissed modal) counts as off for the rest of the session, so the learner is not nagged.
 * 'ask' means nobody has decided yet: ask on the next learner action that needs execution.
 */
export function resolveConsent(setting: LocalExecutionSetting, saved: ConsentChoice | undefined, declinedThisSession: boolean): ConsentChoice | 'ask' {
  if (setting !== 'ask') return setting;
  if (saved) return saved;
  return declinedThisSession ? 'off' : 'ask';
}

export interface ExecutionState {
  consent: ConsentChoice | 'ask';
  trusted: boolean;
  /** Model and seed snippets may run (pad, placement, sprints, seed instantiation, pack verification). */
  snippets: boolean;
  /** The learner's own code may run (spec ladders, own-code predictions, what-ifs). */
  learnerCode: boolean;
}

/** Execution also requires a trusted workspace (spec V1-2). */
export function executionState(
  setting: LocalExecutionSetting,
  saved: ConsentChoice | undefined,
  declinedThisSession: boolean,
  trusted: boolean,
): ExecutionState {
  const consent = resolveConsent(setting, saved, declinedThisSession);
  return {
    consent,
    trusted,
    snippets: trusted && (consent === 'snippets' || consent === 'all'),
    learnerCode: trusted && consent === 'all',
  };
}

/** Ask now? Only when undecided, in a trusted workspace, and there is something to run. */
export function shouldAskConsent(s: ExecutionState, hasRuntime: boolean): boolean {
  return s.consent === 'ask' && s.trusted && hasRuntime;
}

/** The modal's button: a choice to save, or undefined for 'Not now' / a dismissed modal. */
export function choiceFromButton(label: string | undefined): ConsentChoice | undefined {
  if (label === CONSENT_BUTTONS.all) return 'all';
  if (label === CONSENT_BUTTONS.snippets) return 'snippets';
  return undefined;
}

/** Did the change matter to anything that runs code? */
export function executionChanged(a: ExecutionState | undefined, b: ExecutionState): { snippets: boolean; learnerCode: boolean } {
  return { snippets: a?.snippets !== b.snippets, learnerCode: a?.learnerCode !== b.learnerCode };
}

/** One line for the sidebar ('Local execution: ...'). */
export function executionSummary(s: ExecutionState, runtimes: Partial<Record<Lang, string>>): string {
  const found = LANGS.filter((l) => runtimes[l]).map((l) => `${label(l)} ${runtimes[l]}`);
  const rt = found.length ? found.join(' · ') : 'no Python or Node found';
  if (!s.trusted) return `Local execution is off in an untrusted workspace (${rt}).`;
  switch (s.consent) {
    case 'all':
      return `Local execution: snippets and your code (${rt}).`;
    case 'snippets':
      return `Local execution: snippets only (${rt}).`;
    case 'off':
      return `Local execution is off: practice uses unverified answer keys (${rt}).`;
    default:
      return `Local execution: not decided yet; you will be asked before anything runs (${rt}).`;
  }
}

function label(l: Lang): string {
  return l === 'python' ? 'Python' : l === 'javascript' ? 'Node' : 'TypeScript';
}

// =====================================================================================
// No runtime (spec V1-2 NO RUNTIME)
// =====================================================================================

export const NO_PYTHON_FLASH = 'No Python found: practice runs unverified (set deliberate.pythonPath)';
export const NO_NODE_FLASH = 'No Node.js found: practice runs unverified';
export const NO_RUNTIME_FLASH_MS = 8000;

/** The one status flash for a project language without a detected runtime (undefined: nothing to say). */
export function noRuntimeFlash(lang: Lang | undefined, found: Partial<Record<Lang, unknown>>): string | undefined {
  if (!lang || found[lang]) return undefined;
  return lang === 'python' ? NO_PYTHON_FLASH : NO_NODE_FLASH;
}

// =====================================================================================
// Inline AI offer (spec V1-3 INLINE AI OFFER)
// =====================================================================================

export const INLINE_AI_EXTENSIONS: readonly string[] = [
  'GitHub.copilot',
  'GitHub.copilot-chat',
  'Codeium.codeium',
  'TabNine.tabnine-vscode',
  'supermaven.supermaven',
];

export const INLINE_AI_MESSAGE = 'Turn off inline AI suggestions in this workspace while you do tasks? Your practice evidence stays accurate.';
export const INLINE_AI_BUTTONS = { off: 'Turn off here', keep: 'Keep' } as const;

/** workspaceState keys. */
export const INLINE_AI_OFFERED_KEY = 'deliberate.inlineAiOffered';
/** We set editor.inlineSuggest.enabled = false here (so a reset restores it). */
export const INLINE_AI_DISABLED_KEY = 'deliberate.inlineAiDisabled';

export interface InlineAiInput {
  /** Inline-completion extensions that are active right now. */
  active: readonly string[];
  /** Already offered in this workspace. */
  offered: boolean;
  /** editor.inlineSuggest.enabled as it resolves for this workspace. */
  inlineSuggestEnabled: boolean;
  /** A task is under way (the offer is about doing tasks). */
  building: boolean;
}

/** Offer once per workspace, while building, when a known inline AI is active and suggestions are on. */
export function inlineAiOfferDue(i: InlineAiInput): boolean {
  return !i.offered && i.building && i.inlineSuggestEnabled && i.active.length > 0;
}

// =====================================================================================
// Background jobs (spec V1-1 settings)
// =====================================================================================

export const JOB_DEFAULTS = { concurrency: 2, minConcurrency: 1, maxConcurrency: 3, callsPerHour: 20, minCallsPerHour: 6 } as const;

/** deliberate.backgroundConcurrency (1-3, default 2) and deliberate.backgroundCallsPerHour (>= 6, default 20). */
export function jobSettings(get: (key: string) => unknown): { concurrency: number; callsPerHour: number } {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const concurrency = Math.round(num(get('backgroundConcurrency'), JOB_DEFAULTS.concurrency));
  const calls = Math.round(num(get('backgroundCallsPerHour'), JOB_DEFAULTS.callsPerHour));
  return {
    concurrency: Math.min(JOB_DEFAULTS.maxConcurrency, Math.max(JOB_DEFAULTS.minConcurrency, concurrency)),
    callsPerHour: Math.max(JOB_DEFAULTS.minCallsPerHour, calls),
  };
}

// =====================================================================================
// Evidence environment: misconception coverage (spec V1-3 step 7)
// =====================================================================================

/** Taxonomy misconceptions need at least this prior to be required coverage. */
export const COVERAGE_PRIOR = 0.2;

/**
 * Required coverage for a concept: the tag's taxonomy misconceptions (this language, prior >= .2)
 * for which the bank holds a verified item carrying an unambiguous mutant. An unverified atom (no
 * runtime, model claims only) requires nothing, since mutant matching is off there.
 */
export function requiredCoverage(tag: string | undefined, lang: Lang | undefined, atom: StoredAtom | undefined, minPrior = COVERAGE_PRIOR): string[] {
  if (!tag || !lang || !atom || !atom.verified) return [];
  const wanted = misconceptionsFor(tag, lang).filter((m) => m.prior >= minPrior).map((m) => m.id);
  if (!wanted.length) return [];
  const carried = new Set<string>();
  for (const p of atom.probes) for (const m of p.mutants) if (!m.ambiguous) carried.add(m.misconceptionId);
  return wanted.filter((id) => carried.has(id));
}

/** Belief text and prior of a taxonomy misconception for the concept's tag. */
export function taxonomyEntry(misconceptionId: string, c: Pick<ConceptState, 'tag'>): { belief: string; prior: number } | undefined {
  const m = c.tag ? findMisconception(c.tag, misconceptionId) : undefined;
  return m ? { belief: m.belief, prior: m.prior } : undefined;
}

/**
 * Memoised coverage lookups (recordEvidence calls coverage for the concept and its ancestors on every
 * record; AtomCache.get deep-copies an atom). Entries live `ttlMs`; invalidate() after stocking.
 */
export class CoverageIndex {
  private readonly memo = new Map<string, { at: number; ids: string[] }>();

  constructor(
    private readonly deps: {
      /** The project's runnable language (preferred), else undefined. */
      lang: () => Lang | undefined;
      /** The cached atom for a key in a language. */
      atom: (lang: Lang, key: string) => StoredAtom | undefined;
      has: (lang: Lang, key: string) => boolean;
      now?: () => number;
      ttlMs?: number;
    },
  ) {}

  /** CoverageFn for Store.setEvidenceEnv. */
  readonly coverage = (c: ConceptState): string[] => {
    const tag = c.tag;
    if (!tag || tag === 'other' || !tagInfo(tag)) return [];
    const lang = this.langFor(c);
    if (!lang) return [];
    const key = this.deps.has(lang, c.id) ? c.id : tag;
    const memoKey = `${lang}|${key}|${tag}`;
    const now = this.deps.now?.() ?? Date.now();
    const hit = this.memo.get(memoKey);
    if (hit && now - hit.at < (this.deps.ttlMs ?? 30_000)) return hit.ids;
    const ids = requiredCoverage(tag, lang, this.deps.atom(lang, key));
    this.memo.set(memoKey, { at: now, ids });
    return ids;
  };

  readonly taxonomy = (misconceptionId: string, c: ConceptState) => taxonomyEntry(misconceptionId, c);

  invalidate(): void {
    this.memo.clear();
  }

  /** The project language when the tag exists there, else the first language whose bank has the concept. */
  private langFor(c: ConceptState): Lang | undefined {
    const tag = c.tag!;
    const langs = tagInfo(tag)?.langs ?? [];
    const pref = this.deps.lang();
    if (pref && langs.includes(pref)) return pref;
    return LANGS.find((l) => langs.includes(l) && (this.deps.has(l, c.id) || this.deps.has(l, tag)));
  }
}

// =====================================================================================
// Pace extras (spec successMetrics; the coach's PaceData covers milestones, solo tasks and bits)
// =====================================================================================

/** workspaceState key: when the learner first typed in task 1 of a project. */
export const FIRST_KEYSTROKE_KEY = 'deliberate.pace.firstKeystroke';

export interface FirstKeystroke {
  projectCreatedAt: number;
  at: number;
}

/** Tasks in roadmap order. */
function ordered(p: Project): Task[] {
  return p.milestones.flatMap((m) => m.taskIds).map((id) => p.tasks[id]).filter((t): t is Task => !!t);
}

/** Record the first edit of a project file now? Task 1 is current and being built, and nothing is stored for this project. */
export function firstKeystrokeDue(p: Project | undefined, stored: FirstKeystroke | undefined): boolean {
  if (!p || stored?.projectCreatedAt === p.createdAt) return false;
  const first = ordered(p)[0];
  if (!first || p.currentTaskId !== first.id || first.status !== 'active') return false;
  return first.phase === 'building' || (first.phase === 'learning' && (first.resumePhase ?? 'building') === 'building');
}

export type BlockKind = 'known' | 'misconception' | 'unknown';

/** Concept block kind of a finished atom (aborted ones are not blocks). */
export function blockKind(r: Pick<AtomResult, 'path' | 'misconceptionId'>): BlockKind | undefined {
  switch (r.path) {
    case 'aborted':
      return undefined;
    case 'tested-out':
      return r.misconceptionId ? 'misconception' : 'known';
    case 'confirmed':
    case 'fixed':
    case 'escalated':
      return 'misconception';
    default:
      return r.misconceptionId ? 'misconception' : 'unknown';
  }
}

export function median(xs: readonly number[]): number | undefined {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export interface PaceExtras {
  /** Start to first keystroke in task 1, seconds (target: 240 or less). */
  firstKeystrokeSec?: number;
  /** Median concept block time per kind, seconds (targets: known 30, misconception 70, unknown 120). */
  blocks: Record<BlockKind, { medianSec?: number; count: number }>;
  /** Median learner-visible model wait per finished task, seconds (target: 5 or less). */
  waitPerTaskSec?: number;
  /** Solo tasks: median active minutes and the unaided solve rate. */
  solo: { count: number; unaided: number; rate?: number; medianMin?: number };
}

const round1 = (x: number | undefined) => (x === undefined ? undefined : Math.round(x * 10) / 10);

/** Unaided solve: no rung 2+ hint, no reveal, pasted + assisted characters under 120. */
export function unaided(t: Task): boolean {
  return !t.revealed && !(t.hints ?? []).some((h) => h.rung >= 2) && (t.pastedChars ?? 0) + (t.assistedChars ?? 0) < 120;
}

export function paceExtras(p: Project | undefined, first?: FirstKeystroke): PaceExtras {
  const blocks: PaceExtras['blocks'] = { known: { count: 0 }, misconception: { count: 0 }, unknown: { count: 0 } };
  const out: PaceExtras = { blocks, solo: { count: 0, unaided: 0 } };
  if (!p) return out;
  if (first && first.projectCreatedAt === p.createdAt && first.at >= p.createdAt) out.firstKeystrokeSec = Math.round((first.at - p.createdAt) / 1000);
  const tasks = Object.values(p.tasks ?? {});
  const ms: Record<BlockKind, number[]> = { known: [], misconception: [], unknown: [] };
  for (const t of tasks) {
    for (const r of t.atomRuns ?? []) {
      const k = blockKind(r);
      if (k && Number.isFinite(r.ms) && r.ms > 0) ms[k].push(r.ms / 1000);
    }
  }
  for (const k of Object.keys(ms) as BlockKind[]) {
    blocks[k] = { count: ms[k].length, ...(ms[k].length ? { medianSec: round1(median(ms[k])) } : {}) };
  }
  const done = tasks.filter((t) => t.status === 'done');
  const waits = done.map((t) => (t.waitMs ?? 0) / 1000);
  if (waits.length) out.waitPerTaskSec = round1(median(waits));
  const solo = done.filter((t) => t.solo);
  if (solo.length) {
    const n = solo.filter(unaided).length;
    out.solo = { count: solo.length, unaided: n, rate: n / solo.length, medianMin: round1(median(solo.map((t) => t.activeMs / 60000))) };
  }
  return out;
}

// =====================================================================================
// Spec greens -> the 'spec-green' pause (spec V1-4 rule 3)
// =====================================================================================

/** Spec ids that pass in this run and did not pass before. */
export function newlyGreen(before: ReadonlySet<string>, results: Record<string, { pass?: boolean } | undefined>): string[] {
  return Object.entries(results).filter(([id, r]) => r?.pass && !before.has(id)).map(([id]) => id);
}

/** Ids passing in a result map. */
export function passing(results: Record<string, { pass?: boolean } | undefined> | undefined): Set<string> {
  return new Set(Object.entries(results ?? {}).filter(([, r]) => r?.pass).map(([id]) => id));
}

// =====================================================================================
// Runtime discovery bookkeeping
// =====================================================================================

/** Runtime versions by language for the sidebar line. */
export function runtimeVersions(rts: Partial<Record<Lang, { version: string } | undefined>>): Partial<Record<Lang, string>> {
  const out: Partial<Record<Lang, string>> = {};
  for (const l of LANGS) {
    const v = rts[l]?.version;
    if (v) out[l] = v;
  }
  return out;
}

/** Which languages to stock now: the project's runnable language, else every language with a runtime (or all, unverified). */
export function stockLanguages(projectLang: Lang | undefined, found: Partial<Record<Lang, unknown>>): Lang[] {
  if (projectLang) return [projectLang];
  const withRuntime = LANGS.filter((l) => found[l]);
  return withRuntime.length ? withRuntime : [...LANGS];
}
