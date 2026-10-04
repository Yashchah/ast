// Local verification of model AtomPacks and escalation lessons (spec V1-5 LOCAL VERIFICATION,
// ESCALATION LESSONS). Every probe, mutant, example, completion variant and contrast of a pack runs
// in ONE batch, twice (two hash seeds). Only what the code really does is stored: a probe whose
// model answer is wrong goes to the repair list and is never silently corrected, because its
// mutants and refutation were written from the same wrong mental model.
// Pure module: no vscode import; the runner is injected (null = execution off, step 11).

import type {
  AtomPattern, BatchItem, BatchRecord, Lang, RecordedOutput, Runner, StoredAtom, StoredCompletion, StoredContrast,
  StoredExample, StoredMutant, StoredProbe, TraceLine,
} from '../contracts';
import { actualText, answerSpaceG, compareOutput, mutantAttributable } from '../compare';
import { allowlistCheck } from '../runner';
import type { AtomPack, EscalationLesson, PackAtom, PackMutant, PackProbe } from '../schemas';
import { hash53 } from './rng';
import {
  checkCallConditions, emptyStats, fillBlanks, harnessChecks, isParseError, outputLines, PASS_SEEDS, passes, ranOk,
  recordOutput, sameOutput,
} from './seeds';
import { canonicalTag, OTHER_TAG, tagInfo, type TaxonomyEntry } from './tags';

// ---------------------------------------------------------------- limits (spec V1-5, conceptAtom PARTS)

const PROBE_MAX_LINES = 8;
const OUT_MIN_LINES = 1;
const OUT_MAX_LINES = 4;
const OUT_MAX_CHARS = 200;
const MAX_MUTANTS = 3;
const BELIEF_WORDS = 12;
const REFUTATION_WORDS = 25;
const RULE_WORDS = 12;
const SUBGOAL_WORDS = 6;
const CONTRAST_MAX_LINES = 4;
const MIN_USE_CASES = 6;
const TRACE_CHARS = 60;
const STDERR_CHARS = 300;
/** At most this many expected literals are tried as constant fills. */
const MAX_CONSTANT_FILLS = 4;
/** More than this share of a pack failing triggers one repair call. */
export const REPAIR_THRESHOLD = 0.4;

// ---------------------------------------------------------------- types

/** Which prompt produced the pack: decides which parts are expected (MINI ATOM, PROBES-ONLY). */
export type PackVariant = 'full' | 'mini' | 'probes-only';

export type RepairKind = 'probe' | 'example' | 'completion' | 'contrast' | 'pattern' | 'atom';

/** A failed item for the REPAIR prompt (excluded from the stored atom). */
export interface RepairItem {
  conceptId: string;
  /** The model's own id ('p2'), or 'example' | 'completion' | 'contrast' | 'pattern' | 'atom'. */
  itemId: string;
  kind: RepairKind;
  /** What failed; for a mispredicted probe: 'your answer: X; real output: Y'. */
  what: string;
  /** stderr / traceback tail (<= 300 chars), '' when none. */
  stderr: string;
}

/** A part removed for good (not worth a repair call): mutants, wrong fills, duplicates. */
export interface DroppedItem {
  conceptId: string;
  /** e.g. 'p2/m1' or 'completion/wrongFill1'. */
  itemId: string;
  kind: 'mutant' | 'wrong-fill' | 'probe' | 'subgoal' | 'contrast';
  reason: string;
}

export interface VerifyContext {
  now?: number;
  variant?: PackVariant;
  /** The concepts the pack was asked for: fixes a model that renamed a concept id or tag. */
  concepts?: { id: string; tag: string }[];
  /** Cache key (default: the canonical tag, or the concept id for 'other'). */
  keyFor?: (conceptId: string, tag: string) => string;
  /** Extra Python imports for the allowlist (find_spec hits for 'other' concepts). */
  extraImports?: readonly string[];
  signal?: AbortSignal;
  itemTimeoutMs?: number;
}

/** Verification of one atom of the pack. */
export interface VerifyResult {
  conceptId: string;
  tag: string;
  key: string;
  /** null when the atom failed acceptance (step 9). */
  atom: StoredAtom | null;
  accepted: boolean;
  repairs: RepairItem[];
  dropped: DroppedItem[];
  log: string[];
  /** Items that failed (probes, example, completion, contrast; missing ones count) and items expected. */
  failed: number;
  total: number;
}

export interface PackVerifyResult {
  /** The first atom's result (packs are usually one concept); see `results` for every atom. */
  atom: StoredAtom | null;
  repairs: RepairItem[];
  dropped: DroppedItem[];
  /** Lines for the 'Deliberate: content' output channel. */
  log: string[];
  /** More than 40% of the pack failed, or an atom missed acceptance with repairable failures. */
  needsRepair: boolean;
  failRatio: number;
  results: VerifyResult[];
}

// ---------------------------------------------------------------- small helpers (exported for tests)

/** CRLF to LF, no leading blank lines, no trailing whitespace at the end. */
export function normCode(code: string): string {
  return (code ?? '').replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}

const lineCount = (code: string) => (code ? code.split('\n').length : 0);
const words = (s: string) => (s ?? '').trim().split(/\s+/).filter(Boolean);

/** The first n words of s. */
export function cutWords(s: string, n: number): string {
  const w = words(s);
  return w.length > n ? w.slice(0, n).join(' ') : w.join(' ');
}

/** kebab-case id ('Slice End Included' -> 'slice-end-included'). */
export function slugId(s: string): string {
  return (s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The single 1-based line on which two snippets differ (trailing whitespace ignored), 0 when they
 * are the same, -1 when several lines differ or the line counts do.
 */
export function diffLine(a: string, b: string): number {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length !== y.length) return -1;
  let line = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i].trimEnd() === y[i].trimEnd()) continue;
    if (line) return -1;
    line = i + 1;
  }
  return line;
}

/** Quoted pieces of prose: 'x', "x" or `x`, ignoring apostrophes inside words (it's, learner's). */
function quotedPieces(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(['"`])(.+?)\1(?![\p{L}\p{N}])/gu)) out.push(m[2]);
  return out;
}

/**
 * Why a refutation leaks something the code does not show (step 4): a number or a quoted piece
 * that is not in the probe code, which is most likely an output value. undefined when clean.
 */
export function refutationLeak(refutation: string, code: string): string | undefined {
  const codeNums = new Set(code.match(/\d+(?:\.\d+)?/g) ?? []);
  for (const n of refutation.match(/\d+(?:\.\d+)?/g) ?? []) if (!codeNums.has(n)) return `number ${n}`;
  for (const q of quotedPieces(refutation)) if (!code.includes(q)) return `quoted '${q}'`;
  return undefined;
}

/** The first argument (the condition) of every check(...) call in a harness, whitespace-collapsed. */
export function checkConditions(harness: string): string[] {
  return checkCallConditions(harness).map((c) => c.replace(/\s+/g, ' ').trim());
}

const PY_TYPE_MARKER = /\brepr\s*\(|![rR]\s*[}:]|%r|\btype\s*\(|__name__|\bascii\s*\(/;
const JS_TYPE_MARKER = /JSON\.stringify\s*\(|\btypeof\b/;
const NUMERIC = new Set(['int', 'float', 'num', 'bigint']);

/**
 * Type-sensitive tags must print repr()/type(x).__name__ (Python) or JSON.stringify/typeof (JS) so
 * a str and a number print differently. A bare number argument, or a str argument in code that
 * never uses those, is a bare print. Heuristic: a bare str printed next to repr() calls passes.
 */
export function typeVisible(code: string, out: RecordedOutput, lang: Lang): boolean {
  const args = out.values.flat();
  if (args.some((a) => NUMERIC.has(a.val?.t ?? ''))) return false;
  if (!args.some((a) => a.val?.t === 'str')) return true;
  return (lang === 'python' ? PY_TYPE_MARKER : JS_TYPE_MARKER).test(code);
}

/** Failed for real: ran (not denied) and raised, exited non-zero or timed out. */
const fails = (r: BatchRecord | undefined) => !!r && !r.denied && (r.timedOut || !r.exitOk);

const tailOf = (s: string | undefined, n = STDERR_CHARS) => {
  const t = (s ?? '').trim();
  return t.length > n ? t.slice(-n) : t;
};
const oneLine = (s: string) => s.replace(/\r?\n/g, ' | ');
const h36 = (s: string) => hash53(s).toString(36);

// ---------------------------------------------------------------- planning

interface Job {
  id: string;
  code: string;
  trace?: boolean;
}

interface MutantWork {
  m: PackMutant;
  j: number;
  code: string;
  misconceptionId: string;
  line: number;
  job: string;
}

interface ProbeWork {
  p: PackProbe;
  label: string;
  code: string;
  id: string;
  group: string;
  job: string;
  mutants: MutantWork[];
}

interface CompletionWork {
  code: string;
  solutions: string[];
  harness: string;
  parSec: number;
  wrongFills: { blank: number; fill: string; misconceptionId: string; job: string; k: number }[];
  constants: { fill: string; job: string }[];
}

interface AtomWork {
  a: PackAtom;
  ai: number;
  conceptId: string;
  tag: string;
  key: string;
  info?: TaxonomyEntry;
  r: VerifyResult;
  jobs: Job[];
  probes: ProbeWork[];
  example?: { code: string; job: string; subgoals: { line: number; label: string }[] };
  completion?: CompletionWork;
  contrast?: { wrong: string; right: string; misconceptionId: string; rule: string; jw: string; jr: string };
  pattern: AtomPattern;
}

const EXPECTED: Record<PackVariant, { probes: number; example: boolean; completion: boolean; contrast: boolean }> = {
  full: { probes: 4, example: true, completion: true, contrast: true },
  mini: { probes: 2, example: false, completion: true, contrast: false },
  'probes-only': { probes: 4, example: false, completion: false, contrast: false },
};

/**
 * Match the model's atoms to the requested concepts: exact id, then tag, then position. Atoms for
 * concepts nobody asked for are left out (and logged).
 */
function resolveConcepts(atoms: PackAtom[], ctx: VerifyContext, log: string[]): { a: PackAtom; ai: number; id: string; tag: string; note?: string }[] {
  const want = ctx.concepts;
  if (!want?.length) return atoms.map((a, ai) => ({ a, ai, id: String(a.conceptId ?? '').trim() || `concept-${ai + 1}`, tag: canonicalTag(a.tag) }));
  const free = new Set(want.map((_, i) => i));
  const out: { a: PackAtom; ai: number; id: string; tag: string; note?: string }[] = [];
  const take = (i: number, a: PackAtom, ai: number, how?: string) => {
    free.delete(i);
    const note = how ? `model returned concept '${a.conceptId}' (${a.tag}); matched to ${want[i].id} by ${how}` : undefined;
    out.push({ a, ai, id: want[i].id, tag: canonicalTag(want[i].tag), note });
  };
  const rest: [PackAtom, number][] = [];
  atoms.forEach((a, ai) => {
    const i = [...free].find((k) => want[k].id === a.conceptId || slugId(want[k].id) === slugId(a.conceptId));
    if (i !== undefined) take(i, a, ai);
    else rest.push([a, ai]);
  });
  const rest2: [PackAtom, number][] = [];
  for (const [a, ai] of rest) {
    const tag = canonicalTag(a.tag);
    const i = tag !== OTHER_TAG ? [...free].find((k) => canonicalTag(want[k].tag) === tag) : undefined;
    if (i !== undefined) take(i, a, ai, 'tag');
    else rest2.push([a, ai]);
  }
  for (const [a, ai] of rest2) {
    const i = [...free][0];
    if (i !== undefined) take(i, a, ai, 'position');
    else log.push(`the pack has an atom for '${a.conceptId}', which was not asked for; ignored`);
  }
  return out.sort((x, y) => x.ai - y.ai);
}

function newResult(conceptId: string, tag: string, key: string): VerifyResult {
  return { conceptId, tag, key, atom: null, accepted: false, repairs: [], dropped: [], log: [], failed: 0, total: 0 };
}

function planAtom(a: PackAtom, ai: number, conceptId: string, tag: string, lang: Lang, ctx: VerifyContext, variant: PackVariant): AtomWork {
  const key = ctx.keyFor?.(conceptId, tag) ?? (tag !== OTHER_TAG ? tag : conceptId);
  const info = tag !== OTHER_TAG ? tagInfo(tag) : undefined;
  const r = newResult(conceptId, tag, key);
  const w: AtomWork = { a, ai, conceptId, tag, key, info, r, jobs: [], probes: [], pattern: buildPattern(a, info, r) };
  const allow = [...(info?.allowedImports ?? []), ...(ctx.extraImports ?? [])];
  const expect = EXPECTED[variant];
  const repair = (itemId: string, kind: RepairKind, what: string, stderr = '') => {
    r.repairs.push({ conceptId, itemId, kind, what, stderr: tailOf(stderr) });
    r.failed++;
  };
  /** Allowlist (step 1): a denied item never runs. */
  const denied = (code: string) => allowlistCheck(code, lang, allow);
  const job = (id: string, code: string, trace = false) => {
    const j: Job = { id: `${ai}/${id}`, code };
    if (trace) j.trace = true;
    w.jobs.push(j);
    return j.id;
  };

  // Probes (step 2, static part) and their mutants (step 3, static part).
  const probes = Array.isArray(a.probes) ? a.probes : [];
  r.total += Math.max(expect.probes, probes.length);
  if (probes.length < expect.probes) {
    repair('probes', 'probe', `only ${probes.length} probes were written (${expect.probes} needed, each in its own sibling group)`);
    r.failed += expect.probes - probes.length - 1;
  }
  const seenCode = new Set<string>();
  probes.forEach((p, pi) => {
    const label = String(p?.id ?? '').trim() || `p${pi + 1}`;
    const code = normCode(p?.code ?? '');
    const lines = lineCount(code);
    if (!code) return repair(label, 'probe', 'the probe has no code');
    if (lines > PROBE_MAX_LINES) return repair(label, 'probe', `the probe has ${lines} lines (8 or fewer)`);
    if (!String(p.answer ?? '').trim()) return repair(label, 'probe', 'no answer was given');
    const why = denied(code);
    if (why) return repair(label, 'probe', `denied by the allowlist: ${why}`);
    if (seenCode.has(code)) {
      r.dropped.push({ conceptId, itemId: label, kind: 'probe', reason: 'same code as an earlier probe' });
      r.total--;
      return;
    }
    seenCode.add(code);
    const id = `${key}#p${h36(code)}`;
    const group = `m:${slugId(p.siblingGroup) || slugId(label)}`;
    const pw: ProbeWork = { p, label, code, id, group, job: job(`p${pi}`, code, lang === 'python' && !!info?.stateTrace), mutants: [] };
    (Array.isArray(p.mutants) ? p.mutants : []).forEach((m, j) => {
      const drop = (reason: string) => r.dropped.push({ conceptId, itemId: `${label}/m${j + 1}`, kind: 'mutant', reason });
      const mCode = normCode(m?.code ?? '');
      const misconceptionId = slugId(m?.misconceptionId ?? '');
      if (!mCode) return drop('no code');
      if (!misconceptionId) return drop('no misconceptionId');
      if (!words(m.belief).length) return drop('no belief');
      const line = diffLine(code, mCode);
      if (line === 0) return drop('same code as the probe');
      if (line < 0) return drop('its diff from the probe spans several lines (exactly one line may change)');
      if (pw.mutants.some((x) => x.code === mCode)) return drop('same code as an earlier mutant');
      const mWhy = denied(mCode);
      if (mWhy) return drop(`denied by the allowlist: ${mWhy}`);
      pw.mutants.push({ m, j, code: mCode, misconceptionId, line, job: job(`p${pi}/m${j}`, mCode) });
    });
    w.probes.push(pw);
  });

  // Example (step 6, static part).
  const exCode = normCode(a.example?.code ?? '');
  if (exCode || expect.example) {
    r.total++;
    if (!exCode) repair('example', 'example', 'the example is missing');
    else {
      const why = denied(exCode);
      if (why) repair('example', 'example', `denied by the allowlist: ${why}`);
      else {
        const n = lineCount(exCode);
        if (n < 5 || n > 8) r.log.push(`${conceptId} example: ${n} lines (5-8 asked)`);
        const subgoals: { line: number; label: string }[] = [];
        for (const [gi, g] of (Array.isArray(a.example.subgoals) ? a.example.subgoals : []).entries()) {
          const label = cutWords(String(g?.label ?? ''), SUBGOAL_WORDS);
          if (!Number.isInteger(g?.line) || g.line < 1 || g.line > n || !label || subgoals.some((s) => s.line === g.line)) {
            r.dropped.push({ conceptId, itemId: `example/subgoal${gi + 1}`, kind: 'subgoal', reason: `line ${g?.line} is not a code line (or repeats)` });
            continue;
          }
          subgoals.push({ line: g.line, label });
        }
        subgoals.sort((x, y) => x.line - y.line);
        w.example = { code: exCode, job: job('ex', exCode), subgoals };
      }
    }
  }

  // Completion (step 7, static part).
  const c = a.completion;
  const cCode = normCode(c?.code ?? '');
  if (cCode || expect.completion) {
    r.total++;
    const problem = cCode ? completionProblem(c, cCode, lang) : 'the completion is missing';
    if (problem) repair('completion', 'completion', problem);
    else {
      const solutions = c.solutions.map((s) => s.trim());
      const harness = normCode(c.harness);
      const run = (fills: string[]) => `${fillBlanks(cCode, fills)}\n${harness}\n`;
      const why = denied(run(solutions));
      if (why) repair('completion', 'completion', `denied by the allowlist: ${why}`);
      else {
        const n = lineCount(cCode);
        if (n < 6 || n > 10) r.log.push(`${conceptId} completion: ${n} lines (6-10 asked)`);
        const cw: CompletionWork = { code: cCode, solutions, harness, parSec: clamp(c.parSec, 20, 40, 30), wrongFills: [], constants: [] };
        job('c/sol', run(solutions));
        job('c/empty', run(solutions.map(() => '')));
        (Array.isArray(c.wrongFills) ? c.wrongFills : []).forEach((wf, k) => {
          const drop = (reason: string) => r.dropped.push({ conceptId, itemId: `completion/wrongFill${k + 1}`, kind: 'wrong-fill', reason });
          const fill = String(wf?.fill ?? '').trim();
          const misconceptionId = slugId(wf?.misconceptionId ?? '');
          if (!Number.isInteger(wf?.blank) || wf.blank < 1 || wf.blank > solutions.length) return drop(`blank ${wf?.blank} does not exist`);
          if (!fill || fill.includes('\n')) return drop('the fill must be one non-empty line');
          if (!misconceptionId) return drop('no misconceptionId');
          if (fill === solutions[wf.blank - 1]) return drop('same as the solution');
          const fills = solutions.slice();
          fills[wf.blank - 1] = fill;
          cw.wrongFills.push({ blank: wf.blank, fill, misconceptionId, k, job: job(`c/wf${k}`, run(fills)) });
        });
        harnessChecks(harness).expected.filter((e) => !e.includes('\n')).slice(0, MAX_CONSTANT_FILLS).forEach((e, ei) => {
          solutions.forEach((_, b) => {
            const fills = solutions.slice();
            fills[b] = e;
            cw.constants.push({ fill: e, job: job(`c/k${ei}b${b}`, run(fills)) });
          });
        });
        w.completion = cw;
      }
    }
  }

  // Contrast (step 8, static part).
  const ct = a.contrast;
  const wrong = normCode(ct?.wrong ?? '');
  const right = normCode(ct?.right ?? '');
  if (wrong || right || expect.contrast) {
    r.total++;
    const misconceptionId = slugId(ct?.misconceptionId ?? '');
    const why = wrong && right ? denied(wrong) ?? denied(right) : undefined;
    if (!wrong || !right) repair('contrast', 'contrast', 'the contrast needs both snippets');
    else if (lineCount(wrong) > CONTRAST_MAX_LINES || lineCount(right) > CONTRAST_MAX_LINES) repair('contrast', 'contrast', 'each contrast snippet must be 4 lines or fewer');
    else if (wrong === right) repair('contrast', 'contrast', 'the two snippets are identical');
    else if (!misconceptionId) repair('contrast', 'contrast', 'the contrast needs a misconceptionId');
    else if (why) repair('contrast', 'contrast', `denied by the allowlist: ${why}`);
    else w.contrast = { wrong, right, misconceptionId, rule: cutWords(ct.rule, RULE_WORDS), jw: job('ct/w', wrong), jr: job('ct/r', right) };
  }
  return w;
}

function clamp(n: unknown, lo: number, hi: number, dflt: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/** Static completion rules (step 7): blanks, solutions, a function, a check() harness. */
function completionProblem(c: PackAtom['completion'], code: string, lang: Lang): string | undefined {
  const solutions = Array.isArray(c.solutions) ? c.solutions : [];
  const blanks = [...code.matchAll(/\[\[(\d+)\]\]/g)].map((m) => Number(m[1])).sort((x, y) => x - y);
  if (solutions.length < 1 || solutions.length > 2) return `the completion needs 1-2 blanks with solutions (got ${solutions.length} solutions)`;
  if (blanks.length !== solutions.length || blanks.some((b, i) => b !== i + 1)) return `blanks must be [[1]]${solutions.length > 1 ? ' and [[2]]' : ''}, each exactly once, one per solution`;
  if (solutions.some((s) => typeof s !== 'string' || !s.trim() || s.includes('\n'))) return 'each solution must be one non-empty line';
  const fn = lang === 'python' ? /\bdef\s+\w+\s*\(|\blambda\b/ : /\bfunction\b|=>/;
  if (!fn.test(code)) return 'the pattern must sit inside a function';
  const harness = normCode(c.harness ?? '');
  const conds = checkConditions(harness);
  if (!conds.length) return lang === 'python' ? 'the harness has no check(...) calls' : 'the harness has no check( calls (assert, require and process are not available)';
  if (new Set(conds).size < 2) return 'the harness must call the function with at least 2 different inputs through check(...)';
  if (!harnessChecks(harness).expected.length) return "the harness needs check(f(...) == expected, 'msg') calls so a constant fill can be tested";
  return undefined;
}

/** Step 10: canonical name and kind from the taxonomy; 6+ use cases. */
function buildPattern(a: PackAtom, info: TaxonomyEntry | undefined, r: VerifyResult): AtomPattern {
  const p = a.pattern ?? ({} as PackAtom['pattern']);
  const kind = info?.kind ?? (p.kind === 'semantics' ? 'semantics' : 'shape');
  const given = String(p.name ?? '').trim();
  const name = info?.patternName ?? (given || r.conceptId);
  if (info && given && given !== name) r.log.push(`${r.conceptId}: pattern name '${given}' renamed to '${name}'`);
  const seen = new Set<string>();
  const useCases = (Array.isArray(p.useCases) ? p.useCases : []).map((u) => String(u ?? '').trim()).filter((u) => {
    const k = u.toLowerCase();
    if (!u || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (useCases.length < MIN_USE_CASES) {
    r.repairs.push({ conceptId: r.conceptId, itemId: 'pattern', kind: 'pattern', what: `useCases has ${useCases.length} different items (6-8 needed)`, stderr: '' });
  }
  const card: AtomPattern = {
    kind, name,
    useWhen: String(p.useWhen ?? '').trim(),
    template: kind === 'semantics' ? '' : String(p.template ?? '').replace(/\r\n?/g, '\n').trim(),
    rule: kind === 'semantics' ? String(p.rule ?? '').trim() : '',
    howItRuns: kind === 'semantics' ? String(p.howItRuns ?? '').trim() : '',
    pitfall: String(p.pitfall ?? '').trim(),
    useCases,
  };
  // The card is shown as written (cutting would break sentences); overruns are logged for review.
  const limits: [keyof AtomPattern, number][] = [['useWhen', 12], ['rule', 12], ['howItRuns', 20], ['pitfall', 12]];
  for (const [field, max] of limits) {
    const n = words(card[field] as string).length;
    if (n > max) r.log.push(`${r.conceptId}: pattern ${field} has ${n} words (${max} or fewer)`);
  }
  const long = useCases.filter((u) => words(u).length > 12).length;
  if (long) r.log.push(`${r.conceptId}: ${long} use case(s) over 12 words`);
  return card;
}

// ---------------------------------------------------------------- running

interface Records {
  a: Map<string, BatchRecord>;
  b: Map<string, BatchRecord>;
}

async function runJobs(jobs: Job[], runner: Runner, lang: Lang, allowImports: string[], ctx: VerifyContext): Promise<Records> {
  const run = async (js: Job[], pass: 0 | 1) => {
    if (!js.length) return new Map<string, BatchRecord>();
    const items = js.map((j): BatchItem => (pass === 0 && j.trace && lang === 'python' ? { id: j.id, code: j.code, wantTrace: true } : { id: j.id, code: j.code }));
    // allowImports rides along for LocalRunner's own allowlist (LocalBatchOptions).
    const opts = { hashSeed: PASS_SEEDS[pass], signal: ctx.signal, itemTimeoutMs: ctx.itemTimeoutMs, allowImports };
    const recs = await runner.runBatch(items, opts);
    return new Map(recs.map((r) => [r.id, r]));
  };
  const a = await run(jobs, 0);
  const again = jobs.filter((j) => {
    const r = a.get(j.id);
    return !!r && !r.denied && !r.timedOut;
  });
  return { a, b: await run(again, 1) };
}

/** Same behaviour in both hash-seed passes. */
function steady(recs: Records, id: string): boolean {
  const x = recs.a.get(id);
  const y = recs.b.get(id);
  if (!x || !y) return false;
  const norm = (s: string) => s.replace(/\r\n?/g, '\n');
  return x.exitOk === y.exitOk && x.timedOut === y.timedOut && (x.exception ?? '') === (y.exception ?? '') && norm(x.stdout) === norm(y.stdout);
}

// ---------------------------------------------------------------- evaluation

function evaluate(w: AtomWork, recs: Records | undefined, lang: Lang, now: number, variant: PackVariant): VerifyResult {
  const { r, conceptId } = w;
  const verified = !!recs;
  const repair = (itemId: string, kind: RepairKind, what: string, stderr = '') => {
    r.repairs.push({ conceptId, itemId, kind, what, stderr: tailOf(stderr) });
    r.failed++;
  };
  const typeSensitive = !!w.info?.typeSensitive;

  // Probes (step 2) with mutants (step 3), refutations (step 4) and metadata (step 5).
  const probes: StoredProbe[] = [];
  for (const pw of w.probes) {
    const res = recs ? checkProbe(pw, recs, lang, typeSensitive) : { out: claimed(pw.p.answer) };
    if ('what' in res) {
      repair(pw.label, 'probe', res.what, res.stderr);
      continue;
    }
    const probe: StoredProbe = {
      id: pw.id, group: pw.group, code: pw.code, output: res.out, parSec: clamp(pw.p.parSec, 3, 8, 5),
      answerSpaceG: answerSpaceG(res.out), constructs: res.rec?.constructs ?? [], discriminating: false,
      mutants: buildMutants(w, pw, res.out, recs, lang), stats: emptyStats(),
    };
    probe.discriminating = verified && probe.mutants.some((m) => !m.ambiguous && mutantAttributable(m.output, res.out, lang));
    const trace = res.rec?.trace;
    if (trace?.length) probe.trace = trace.map((t): TraceLine => ({ line: t.line, text: t.text.length > TRACE_CHARS ? `${t.text.slice(0, TRACE_CHARS - 3)}...` : t.text }));
    if (res.out.exception) probe.raises = true;
    probes.push(probe);
  }

  // Example (step 6).
  const examples: StoredExample[] = [];
  if (w.example) {
    const ex = w.example;
    const rec = recs?.a.get(ex.job);
    if (!recs) examples.push({ id: `${w.key}#x${h36(ex.code)}`, group: `m:x${h36(ex.code)}`, code: ex.code, subgoals: ex.subgoals, output: { stdout: '', values: [] } });
    else if (rec?.denied) repair('example', 'example', `denied by the allowlist: ${rec.denied}`);
    else if (rec?.timedOut) repair('example', 'example', 'timed out (3 s): an endless loop?');
    else if (!rec || !passes(rec)) repair('example', 'example', 'the example does not run cleanly', rec?.error ?? rec?.exception);
    else if (!outputLines(recordOutput(rec)).length) repair('example', 'example', 'the example prints nothing');
    else if (!steady(recs, ex.job)) repair('example', 'example', 'its output differs between two runs (set order, hashing or randomness?)');
    else examples.push({ id: `${w.key}#x${h36(ex.code)}`, group: `m:x${h36(ex.code)}`, code: ex.code, subgoals: ex.subgoals, output: recordOutput(rec) });
  }

  // Completion (step 7).
  const completions: StoredCompletion[] = [];
  if (w.completion) {
    const c = w.completion;
    const both = (job: string, ok: (r: BatchRecord | undefined) => boolean) => ok(recs?.a.get(job)) && (recs!.b.has(job) ? ok(recs!.b.get(job)) : ok(recs?.a.get(job)));
    let problem = '';
    let stderr = '';
    if (recs) {
      const sol = recs.a.get(`${w.ai}/c/sol`);
      const constant = c.constants.find((k) => !both(k.job, fails));
      if (!both(`${w.ai}/c/sol`, passes)) {
        problem = sol?.timedOut ? 'the solution times out' : 'the solution fails its own harness';
        stderr = sol?.error ?? sol?.exception ?? '';
      } else if (!both(`${w.ai}/c/empty`, fails)) problem = 'it passes with the blanks left empty: the harness does not test the blanks';
      else if (constant) problem = `it passes with the constant fill ${constant.fill}: use at least 2 inputs with different expected results`;
    }
    if (problem) repair('completion', 'completion', problem, stderr);
    else {
      const wrongFills = c.wrongFills.filter((wf) => {
        if (!recs || both(wf.job, fails)) return true;
        r.dropped.push({ conceptId, itemId: `completion/wrongFill${wf.k + 1}`, kind: 'wrong-fill', reason: `the wrong fill '${wf.fill}' passes the harness` });
        return false;
      });
      completions.push({
        id: `${w.key}#c${h36(`${c.code}\n${c.harness}`)}`, group: `m:c${h36(c.code)}`, code: c.code, solutions: c.solutions,
        wrongFills: wrongFills.map((wf) => ({ blank: wf.blank, fill: wf.fill, misconceptionId: wf.misconceptionId })),
        harness: c.harness, parSec: c.parSec, stats: emptyStats(),
      });
    }
  }

  // Contrast (step 8).
  const contrasts: StoredContrast[] = [];
  if (w.contrast) {
    const ct = w.contrast;
    const id = `${w.key}#k${h36(`${ct.wrong}\n---\n${ct.right}`)}`;
    if (!recs) {
      r.log.push(`${conceptId} contrast: not stored without a runtime (its outputs would be model claims)`);
    } else {
      const rw = recs.a.get(ct.jw);
      const rr = recs.a.get(ct.jr);
      if (!ranOk(rw, lang) || !ranOk(rr, lang)) {
        const bad = !ranOk(rw, lang) ? rw : rr;
        repair('contrast', 'contrast', `the ${bad === rw ? 'wrong' : 'right'} snippet does not run${bad?.timedOut ? ' (timed out)' : ''}`, bad?.error ?? bad?.denied);
      } else if (!steady(recs, ct.jw) || !steady(recs, ct.jr)) repair('contrast', 'contrast', 'its output differs between two runs (set order, hashing or randomness?)');
      else if (sameOutput(recordOutput(rw!), recordOutput(rr!))) repair('contrast', 'contrast', `both snippets print the same: ${actualText(recordOutput(rw!), lang)}`);
      else contrasts.push({ id, wrong: ct.wrong, right: ct.right, wrongOutput: recordOutput(rw!), rightOutput: recordOutput(rr!), misconceptionId: ct.misconceptionId, rule: ct.rule });
    }
  }

  // Acceptance (step 9).
  const groups = new Set(probes.map((p) => p.group));
  const production = variant === 'probes-only' || examples.length > 0 || completions.length > 0;
  r.accepted = probes.length >= 2 && groups.size >= 2 && production;
  if (!r.accepted) {
    const why = probes.length < 2 || groups.size < 2
      ? `only ${probes.length} probe${probes.length === 1 ? '' : 's'} in ${groups.size} sibling group${groups.size === 1 ? '' : 's'} passed (2+ groups needed)`
      : 'neither the example nor the completion passed';
    r.repairs.push({ conceptId, itemId: 'atom', kind: 'atom', what: why, stderr: '' });
    r.log.push(`${conceptId}: atom rejected: ${why}`);
  }
  for (const f of r.repairs) r.log.push(`${conceptId} ${f.itemId}: ${f.what}${f.stderr ? ` [${oneLine(f.stderr)}]` : ''}`);
  for (const d of r.dropped) r.log.push(`${conceptId} ${d.itemId}: dropped (${d.reason})`);
  if (r.accepted) {
    r.atom = {
      key: w.key, lang, conceptId, tag: w.tag, source: 'model', verified, createdAt: now, pattern: w.pattern,
      probes, examples, completions, contrasts, tracebacks: [],
    };
    r.log.push(`${conceptId}: accepted${verified ? '' : ' unverified (no runtime)'}: ${probes.length} probes in ${groups.size} groups, ${examples.length} example, ${completions.length} completion, ${contrasts.length} contrast`);
  }
  return r;
}

/** Model-claimed output (execution off): plain text, no typed values. */
function claimed(text: string): RecordedOutput {
  const s = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return { stdout: s ? `${s}\n` : '', values: [] };
}

type ProbeCheck = { out: RecordedOutput; rec?: BatchRecord } | { what: string; stderr?: string };

/** Step 2: runs cleanly (or raises on purpose), 1-4 lines, steady, model answer correct, types visible. */
function checkProbe(pw: ProbeWork, recs: Records, lang: Lang, typeSensitive: boolean): ProbeCheck {
  const rec = recs.a.get(pw.job);
  if (!rec) return { what: 'was not run' };
  if (rec.denied) return { what: `denied by the allowlist: ${rec.denied}` };
  if (rec.timedOut) return { what: 'timed out (3 s): an endless loop?' };
  if (!ranOk(rec, lang)) return { what: isParseError(rec, lang) ? `${rec.exception}: the code does not parse` : 'crashed', stderr: rec.error };
  const out = recordOutput(rec);
  if (!steady(recs, pw.job)) return { what: 'its output differs between two runs (set order, hashing or randomness?)' };
  const verdict = compareOutput(pw.p.answer, out, lang, { typeSensitive: true }).verdict;
  if (verdict !== 'correct') {
    return { what: `your answer: ${oneLine(String(pw.p.answer).trim())}; real output: ${actualText(out, lang)}`, stderr: out.exception ? rec.error : '' };
  }
  const n = outputLines(out).length + (out.exception ? 1 : 0);
  const chars = outputLines(out).join('\n').length;
  if (n < OUT_MIN_LINES || n > OUT_MAX_LINES) return { what: `prints ${n} lines (1-4 allowed)` };
  if (chars > OUT_MAX_CHARS) return { what: `prints ${chars} characters (200 or fewer)` };
  if (typeSensitive && !typeVisible(pw.code, out, lang)) {
    return { what: `prints a bare str or number; this concept is type-sensitive, so print ${lang === 'python' ? 'repr(x) or type(x).__name__' : 'JSON.stringify(x) or typeof x'}` };
  }
  return { out, rec };
}

/** Steps 3-4: real, distinct, honestly-claimed single-line mutants with clean refutations. */
function buildMutants(w: AtomWork, pw: ProbeWork, out: RecordedOutput, recs: Records | undefined, lang: Lang): StoredMutant[] {
  const { r, conceptId } = w;
  const kept: { mw: MutantWork; output: RecordedOutput }[] = [];
  for (const mw of pw.mutants) {
    const drop = (reason: string) => r.dropped.push({ conceptId, itemId: `${pw.label}/m${mw.j + 1}`, kind: 'mutant', reason });
    if (!recs) {
      kept.push({ mw, output: claimed(mw.m.prints) });
      continue;
    }
    const rec = recs.a.get(mw.job);
    if (!rec || rec.denied) {
      drop(`denied by the allowlist: ${rec?.denied ?? 'not run'}`);
      continue;
    }
    if (rec.timedOut) {
      drop('timed out');
      continue;
    }
    if (!ranOk(rec, lang)) {
      drop(isParseError(rec, lang) ? `${rec.exception}: the code does not parse` : 'crashed');
      continue;
    }
    const mOut = recordOutput(rec);
    if (!steady(recs, mw.job)) {
      drop('its output differs between two runs');
      continue;
    }
    if (sameOutput(mOut, out)) {
      drop('it prints the same as the original');
      continue;
    }
    if (compareOutput(mw.m.prints, mOut, lang, { typeSensitive: true }).verdict !== 'correct') {
      drop(`its 'prints' claim ${oneLine(String(mw.m.prints).trim())} does not match its real output ${actualText(mOut, lang)}`);
      continue;
    }
    kept.push({ mw, output: mOut });
  }
  for (const extra of kept.splice(MAX_MUTANTS)) {
    r.dropped.push({ conceptId, itemId: `${pw.label}/m${extra.mw.j + 1}`, kind: 'mutant', reason: 'more than 3 mutants' });
  }
  const contrastRule = w.contrast ?? (w.a.contrast ? { misconceptionId: slugId(w.a.contrast.misconceptionId), rule: cutWords(w.a.contrast.rule, RULE_WORDS) } : undefined);
  const ids = new Set<string>();
  const mutants = kept.map(({ mw, output }): StoredMutant => {
    let refutation = cutWords(mw.m.refutation, REFUTATION_WORDS);
    const leak = refutation ? refutationLeak(refutation, pw.code) : undefined;
    if (leak) {
      r.log.push(`${conceptId} ${pw.label}/m${mw.j + 1}: refutation blanked (${leak} is not in the code)`);
      refutation = '';
    }
    let id = `${pw.id}~${mw.misconceptionId}`;
    for (let k = 2; ids.has(id); k++) id = `${pw.id}~${mw.misconceptionId}-${k}`;
    ids.add(id);
    const rule = contrastRule?.misconceptionId === mw.misconceptionId && contrastRule.rule
      ? contrastRule.rule
      : cutWords(w.pattern.rule || w.pattern.pitfall, RULE_WORDS);
    return {
      id, misconceptionId: mw.misconceptionId, belief: cutWords(mw.m.belief, BELIEF_WORDS), refutation, rule,
      code: mw.code, output, diffLine: mw.line, source: 'model',
      // Without a runtime the outputs are only model claims: mutant matching is disabled (step 11).
      ambiguous: !recs, matches: 0, confirmations: 0, rejections: 0,
    };
  });
  // Equal outputs cannot tell beliefs apart: every member of an equal set is ambiguous.
  if (recs) {
    for (let x = 0; x < mutants.length; x++) {
      for (let y = x + 1; y < mutants.length; y++) {
        if (sameOutput(mutants[x].output, mutants[y].output)) {
          mutants[x].ambiguous = true;
          mutants[y].ambiguous = true;
          r.log.push(`${conceptId} ${pw.label}: mutants ${mutants[x].misconceptionId} and ${mutants[y].misconceptionId} print the same; marked ambiguous`);
        }
      }
    }
  }
  return mutants;
}

// ---------------------------------------------------------------- verifyPack

/**
 * Verify a model AtomPack locally (spec V1-5 LOCAL VERIFICATION, steps 1-11): one batch of all of
 * the pack's code, two passes. `runner` null means execution is off, untrusted or missing: atoms
 * are stored with verified = false, from the model's claims, with mutant matching disabled.
 */
export async function verifyPack(pack: AtomPack, runner: Runner | null | undefined, lang: Lang, ctx: VerifyContext = {}): Promise<PackVerifyResult> {
  const now = ctx.now ?? Date.now();
  const variant = ctx.variant ?? 'full';
  const atoms = Array.isArray(pack?.atoms) ? pack.atoms : [];
  const packLog: string[] = atoms.length ? [] : ['the pack has no atoms'];
  const works = resolveConcepts(atoms, ctx, packLog).map(({ a, ai, id, tag, note }) => {
    const w = planAtom(a, ai, id, tag, lang, ctx, variant);
    if (note) w.r.log.unshift(`${id}: ${note}`);
    return w;
  });
  let recs: Records | undefined;
  if (runner) {
    const jobs = works.flatMap((w) => w.jobs);
    const allow = [...new Set([...works.flatMap((w) => w.info?.allowedImports ?? []), ...(ctx.extraImports ?? [])])];
    recs = jobs.length ? await runJobs(jobs, runner, lang, allow, ctx) : { a: new Map(), b: new Map() };
  }
  const results = works.map((w) => evaluate(w, recs, lang, now, variant));
  // Requested concepts the model skipped.
  for (const c of ctx.concepts ?? []) {
    if (results.some((r) => r.conceptId === c.id)) continue;
    const tag = canonicalTag(c.tag);
    const r = newResult(c.id, tag, ctx.keyFor?.(c.id, tag) ?? (tag !== OTHER_TAG ? tag : c.id));
    r.repairs.push({ conceptId: c.id, itemId: 'atom', kind: 'atom', what: 'no atom was written for this concept', stderr: '' });
    r.failed = r.total = 1;
    r.log.push(`${c.id}: no atom in the pack`);
    results.push(r);
  }
  const failed = results.reduce((s, r) => s + r.failed, 0);
  const total = results.reduce((s, r) => s + r.total, 0);
  const failRatio = total ? failed / total : 0;
  const repairs = results.flatMap((r) => r.repairs);
  return {
    atom: results[0]?.atom ?? null,
    repairs,
    dropped: results.flatMap((r) => r.dropped),
    log: [...packLog, ...results.flatMap((r) => r.log)],
    needsRepair: repairs.length > 0 && (failRatio > REPAIR_THRESHOLD || results.some((r) => !r.accepted)),
    failRatio,
    results,
  };
}

// ---------------------------------------------------------------- escalation lessons

export interface LessonVerifyResult {
  /** The lesson to display: stated output lines that did not match the real output are removed. */
  lesson: EscalationLesson;
  /** The example's stated output was found and matches what the code really prints. */
  outputVerified: boolean;
  /** What the example really printed (steady in both passes), when it ran. */
  output?: RecordedOutput;
  log: string[];
}

const OUTPUT_MARKER = /^(?:->|=>|→|output\s*:?|outputs\s*:?|prints?\s*:?|result\s*:?|returns?\s*:?|gives\s*:?|shows\s*:?)\s*/i;
const OUTSIDE_OUTPUT = /^\s*(?:[*_]{1,2})?(?:output|prints?|result|it prints|this prints)(?:[*_]{1,2})?\s*:(?:[*_]{1,2})?\s*(.*)$/i;
const PRINT_CALL = /\bprint\s*\(|\bconsole\.log\s*\(/;

/** Split a code line into code and its trailing comment text (strings skipped). */
function splitComment(line: string, lang: Lang): { code: string; comment?: string } {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < line.length && line[i] !== c; i++) if (line[i] === '\\') i++;
      continue;
    }
    if (lang === 'python' ? c === '#' : c === '/' && line[i + 1] === '/') {
      return { code: line.slice(0, i).trimEnd(), comment: line.slice(i + (lang === 'python' ? 1 : 2)).trim() };
    }
  }
  return { code: line };
}

const stripTicks = (s: string) => s.trim().replace(/^`+|`+$/g, '').trim();

interface StatedOutput {
  /** Stated output lines, in order. */
  lines: string[];
  /** Applies the removal to the example's line array. */
  remove: (lines: string[]) => void;
}

/**
 * The example's code block and its stated outputs: '# -> x' / '# Output: x' comment lines, a
 * trailing comment on a print line, and an 'Output: x' line or output block after the fence.
 */
function parseLessonExample(example: string, lang: Lang): { lines: string[]; code: string; inside?: StatedOutput; outside?: StatedOutput } {
  const lines = example.replace(/\r\n?/g, '\n').split('\n');
  const open = lines.findIndex((l) => /^\s*```/.test(l));
  const close = open >= 0 ? lines.findIndex((l, i) => i > open && /^\s*```\s*$/.test(l)) : -1;
  const fenced = open >= 0 && close > open;
  const codeIdx: number[] = [];
  for (let i = fenced ? open + 1 : 0; i < (fenced ? close : lines.length); i++) {
    if (!fenced && OUTSIDE_OUTPUT.test(lines[i])) continue;
    codeIdx.push(i);
  }
  // Inside the code: marker comment lines and trailing comments on print lines.
  const marks: { i: number; whole: boolean; text: string }[] = [];
  for (const i of codeIdx) {
    const { code, comment } = splitComment(lines[i], lang);
    if (comment === undefined) continue;
    const marked = OUTPUT_MARKER.test(comment);
    const text = stripTicks(comment.replace(OUTPUT_MARKER, ''));
    if (!code.trim() && marked && text) marks.push({ i, whole: true, text });
    else if (code.trim() && (marked || PRINT_CALL.test(code)) && text) marks.push({ i, whole: false, text });
  }
  const code = codeIdx
    .filter((i) => !marks.some((m) => m.i === i && m.whole))
    .map((i) => lines[i])
    .join('\n');
  const inside: StatedOutput | undefined = marks.length
    ? {
        lines: marks.map((m) => m.text),
        remove: (ls) => {
          for (const m of marks) {
            if (m.whole) ls[m.i] = '\u0000';
            else ls[m.i] = splitComment(ls[m.i], lang).code;
          }
        },
      }
    : undefined;
  // Outside the code: 'Output: x', or 'Output:' followed by a block, or a bare second block.
  let outside: StatedOutput | undefined;
  const from = fenced ? close + 1 : 0;
  for (let i = from; i < lines.length && !outside; i++) {
    if (!fenced && codeIdx.includes(i)) continue;
    const m = OUTSIDE_OUTPUT.exec(lines[i]);
    const nextBlock = (start: number) => {
      let s = start;
      while (s < lines.length && !lines[s].trim()) s++;
      if (s >= lines.length || !/^\s*```\s*(?:text|output|console|plaintext|txt|sh)?\s*$/i.test(lines[s])) return undefined;
      const e = lines.findIndex((l, k) => k > s && /^\s*```\s*$/.test(l));
      return e > s ? { s, e } : undefined;
    };
    if (m) {
      const rest = stripTicks(m[1]);
      const blk = rest ? undefined : nextBlock(i + 1);
      if (rest) outside = { lines: [rest], remove: (ls) => void (ls[i] = '\u0000') };
      else if (blk) outside = { lines: lines.slice(blk.s + 1, blk.e), remove: (ls) => { for (let k = i; k <= blk.e; k++) ls[k] = '\u0000'; } };
    } else if (fenced && i === from) {
      const blk = nextBlock(i);
      if (blk && lines.slice(close + 1, blk.s).every((l) => !l.trim())) {
        outside = { lines: lines.slice(blk.s + 1, blk.e), remove: (ls) => { for (let k = blk.s; k <= blk.e; k++) ls[k] = '\u0000'; } };
      }
    }
  }
  return { lines, code: normCode(code), inside, outside };
}

/**
 * Run an escalation lesson's example (spec V1-5 ESCALATION LESSONS). A stated output that does not
 * match the real one is removed before display and logged. An example that does not even parse is
 * removed whole (it would teach broken code). No runner: the lesson is returned unchanged.
 */
export async function verifyLesson(
  lesson: EscalationLesson,
  runner: Runner | null | undefined,
  opts: { signal?: AbortSignal; extraImports?: readonly string[]; itemTimeoutMs?: number } = {},
): Promise<LessonVerifyResult> {
  const log: string[] = [];
  if (!runner) return { lesson, outputVerified: false, log: ['lesson example not run (no runtime)'] };
  const lang = runner.runtime.lang;
  const parsed = parseLessonExample(lesson.example ?? '', lang);
  if (!parsed.code) return { lesson, outputVerified: false, log: ['lesson has no example code'] };
  const stated = [parsed.inside, parsed.outside].filter((s): s is StatedOutput => !!s);
  const rebuild = (drop: StatedOutput[]) => {
    const ls = parsed.lines.slice();
    drop.forEach((s) => s.remove(ls));
    return ls.filter((l) => l !== '\u0000').join('\n');
  };
  const why = allowlistCheck(parsed.code, lang, opts.extraImports ?? []);
  if (why) {
    log.push(`lesson example not run (denied by the allowlist: ${why}); stated output removed`);
    return { lesson: { ...lesson, example: rebuild(stated) }, outputVerified: false, log };
  }
  const job: Job = { id: 'lesson', code: parsed.code };
  const recs = await runJobs([job], runner, lang, [...(opts.extraImports ?? [])], { signal: opts.signal, itemTimeoutMs: opts.itemTimeoutMs });
  const rec = recs.a.get('lesson');
  if (rec && isParseError(rec, lang)) {
    log.push(`lesson example removed: ${rec.exception} [${oneLine(tailOf(rec.error))}]`);
    return { lesson: { ...lesson, example: '' }, outputVerified: false, log };
  }
  if (!ranOk(rec, lang) || !steady(recs, 'lesson')) {
    log.push(`lesson example did not run cleanly${rec?.timedOut ? ' (timed out)' : ''}; stated output removed`);
    return { lesson: { ...lesson, example: rebuild(stated) }, outputVerified: false, log };
  }
  const output = recordOutput(rec!);
  if (!stated.length) {
    log.push('lesson example states no output');
    return { lesson, outputVerified: false, output, log };
  }
  const wrong = stated.filter((s) => compareOutput(s.lines.join('\n'), output, lang, { typeSensitive: false }).verdict !== 'correct');
  for (const s of wrong) log.push(`lesson example output mismatch: stated ${oneLine(s.lines.join('\n'))}; real ${actualText(output, lang)}; removed`);
  return {
    lesson: wrong.length ? { ...lesson, example: rebuild(wrong) } : lesson,
    outputVerified: wrong.length < stated.length,
    output,
    log,
  };
}
