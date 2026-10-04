// Evidence model (spec V1-3): one capped Bayesian update per graded observation, with
// production-gated mastery, a misconception lifecycle, latency/par, graph propagation,
// audits and scheduling. Pure: no vscode, no I/O. src/learner.ts is its only caller that
// writes, so ConceptState.mastery (= P(known)) has a single writer.

import { ConceptChip, Evidence, ItemKind, MisconceptionState, MisconceptionStatus } from './contracts';
import { ConceptState, Learner } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const PARAMS = {
  /** Base [guess, slip] by item kind. Predict-like kinds take g from the answer space (Evidence.g). */
  gs: {
    predict: [0.06, 0.1],
    'own-predict': [0.06, 0.1],
    'what-if': [0.06, 0.1],
    completion: [0.1, 0.1],
    traceback: [0.1, 0.1],
    spec: [0.15, 0.1],
    'which-pattern': [0.25, 0.1],
    'pattern-pick': [0.3, 0.1],
    'plan-pick': [0.33, 0.1],
    'contrast-pick': [0.5, 0.1],
    task: [0.3, 0.1],
    'llm-grade': [0.2, 0.2],
    passive: [0.3, 0.3],
  } as Record<ItemKind, readonly [number, number]>,
  /** No single update moves the odds by more than this. */
  maxRatio: 6,
  learnT: { feedback: 0.05, boost: 0.3 },
  /** Ceiling on P until the evidence caps hold (and after a guess-flagged correct). */
  cap: 0.8,
  masteredP: 0.85,
  capGroups: 2,
  /** Taxonomy misconceptions with at least this prior must be covered before mastery. */
  coveragePrior: 0.2,
  halfWeight: 0.5,
  unverified: { slip: 0.2, guessUp: 0.1 },
  calibration: { minAnswers: 30, minAccuracy: 0.7, gBump: 0.05 },
  misconception: {
    prior: 0.15,
    activeP: 0.6,
    /** Candidates at or above this p block mastery and route atoms to a belief check. */
    blockP: 0.3,
    groups: 2,
    odds: { confirmed: 6, unconfirmed: 2, passive: 1.5, suppress: 0.25, avoided: 1 / 3 },
    firstHitMs: 10 * MINUTE,
    secondHitMs: DAY,
  },
  latency: {
    maxMs: 60_000,
    readSecPerLine: 1.5,
    cps: 2.5,
    implicitGuess: 0.3,
    speedFactor: [0.7, 2] as const,
    ratioWindow: 20,
    fluencyWindow: 10,
  },
  fragile: { slow: 2, fast: 1.2, minItems: 15, clearAfterMs: HOUR },
  propagation: { maxHops: 3, inferredP: 0.9, singleP: 0.75, lowP: 0.3, childCap: 0.35, deepCap: 0.25, recentMs: 7 * DAY },
  audit: { afterMs: DAY, missP: 0.6 },
  /** Review ladders in days. */
  schedule: { tenMin: 10 / 1440, misconception: [10 / 1440, 0.25, 1], fragile: [10 / 1440, 1], fail: 0.25, guessMs: 10 * MINUTE, solidMin: 1, solidMax: 60, solidGrowth: 2.2 },
} as const;

/**
 * Evidence plus two per-item overrides the shared contract has no field for. Both are kept in
 * the log so the parameters can be refitted later.
 */
export interface EvidenceRecord extends Evidence {
  /** Slip override, e.g. .2 for a task solved after rung 1-2 hints. */
  s?: number;
  /** The item's content was never run locally: slip .2 and guess +.1. */
  unverified?: boolean;
  /** Belief text of the matched mutant (<= 12 words), used when the taxonomy has none. */
  belief?: string;
}

/** Misconception ids (prior >= .2, verified items in the bank) a concept's correct items must have carried. */
export type CoverageFn = (c: ConceptState) => string[];
/** Taxonomy lookup for a misconception's belief text and prior. */
export type TaxonomyFn = (misconceptionId: string, c: ConceptState) => { belief: string; prior: number } | undefined;

export interface ApplyContext {
  /** The whole learner: enables graph propagation and learner-level stats. */
  learner?: Learner;
  coverage?: CoverageFn;
  taxonomy?: TaxonomyFn;
  /** Wall-clock time of this write, for lastAt (merge key). Defaults to ev.at. */
  now?: number;
  /** Propagate over the prerequisite graph (default true when learner is given). */
  propagate?: boolean;
  /** Update calibration, gradedCount, speedFactor and audit counters (default true when learner is given). */
  stats?: boolean;
}

export type Outcome = 'misconception' | 'fragile' | 'guess' | 'solid' | 'fail';

export interface ApplyResult {
  /** format-only verdict or zero weight: nothing changed. */
  discarded: boolean;
  weight: number;
  bits: number;
  guess: boolean;
  implicitGuess: boolean;
  latencyValid: boolean;
  before: number;
  after: number;
  outcome?: Outcome;
  /** Other concepts changed by propagation. */
  propagated: string[];
  mastered: boolean;
  /** Became mastered with this update (an audit is now scheduled). */
  masteredNow: boolean;
  /** A delayed audit was missed: mastery revoked. */
  revoked: boolean;
  fragile?: 'set' | 'cleared';
  misconception?: { id: string; status: MisconceptionStatus; created: boolean; relapse: boolean };
  suppressed?: string;
  cleared: string[];
}

// ---------------------------------------------------------------- small maths

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Median, NaN for an empty list. */
export function median(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Multiply the odds p/(1-p) by k. */
export function scaleOdds(p: number, k: number): number {
  const q = clamp(p, 1e-6, 1 - 1e-6);
  const o = (q / (1 - q)) * k;
  return o / (1 + o);
}

/**
 * Likelihood caps: a correct answer uses g_eff = max(g, (1-s)/6) and a wrong one
 * s_eff = max(s, (1-g)/6), so neither can move the odds more than 6x.
 */
export function effGS(g: number, s: number): { g: number; s: number } {
  return { g: Math.max(g, (1 - s) / PARAMS.maxRatio), s: Math.max(s, (1 - g) / PARAMS.maxRatio) };
}

/** Plain BKT posterior. */
export function bkt(p: number, correct: boolean, g: number, s: number): number {
  return correct ? (p * (1 - s)) / (p * (1 - s) + (1 - p) * g) : (p * s) / (p * s + (1 - p) * (1 - g));
}

/** BKT posterior with the likelihood caps applied. */
export function posterior(p: number, correct: boolean, g: number, s: number): number {
  const e = effGS(g, s);
  return correct ? bkt(p, true, e.g, s) : bkt(p, false, g, e.s);
}

/** KL(posterior || prior) of Bernoulli(P), in bits. */
export function bits(prior: number, post: number): number {
  const p = clamp(post, 1e-9, 1 - 1e-9);
  const q = clamp(prior, 1e-9, 1 - 1e-9);
  return Math.max(0, p * Math.log2(p / q) + (1 - p) * Math.log2((1 - p) / (1 - q)));
}

// ---------------------------------------------------------------- item classes

/** Kinds whose guess rate comes from the answer space. */
const ANSWER_SPACE = new Set<ItemKind>(['predict', 'own-predict', 'what-if']);
/** Items the learner answers in the pad, a sprint or an input box: graded items with a latency. */
export const ITEM_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  'predict', 'completion', 'traceback', 'own-predict', 'what-if', 'which-pattern', 'contrast-pick',
]);
/** Their latency is active coding time, not render-to-submit, so the 60 s discard does not apply. */
const ACTIVE_TIME = new Set<ItemKind>(['spec', 'task']);

/** Passive evidence (failure signatures) can raise a misconception's p but never activates it. */
export function isPassive(ev: Evidence): boolean {
  return ev.kind === 'passive' || ev.source === 'passive' || ev.kind === 'spec';
}

/** Non-guess accuracy under 70% over 30+ answers: the learner guesses without flagging. */
export function guessesUnflagged(l: Pick<Learner, 'calibration'>): boolean {
  const [right, total] = l.calibration.sure;
  const c = PARAMS.calibration;
  return total >= c.minAnswers && right / total < c.minAccuracy;
}

/** Base guess/slip for an item (step 1), before the likelihood caps. */
export function baseGS(ev: EvidenceRecord, bumpG = false): { g: number; s: number } {
  const [g0, s0] = PARAMS.gs[ev.kind] ?? PARAMS.gs.passive;
  let g = typeof ev.g === 'number' && Number.isFinite(ev.g) ? ev.g : g0;
  let s = typeof ev.s === 'number' && Number.isFinite(ev.s) ? ev.s : s0;
  if (bumpG && ANSWER_SPACE.has(ev.kind)) g += PARAMS.calibration.gBump;
  if (ev.unverified) {
    g += PARAMS.unverified.guessUp;
    s = Math.max(s, PARAMS.unverified.slip);
  }
  return { g: clamp(g, 0.001, 0.95), s: clamp(s, 0.001, 0.95) };
}

/** Latency is usable only when the window kept focus and (for pad items) it is under 60 s. */
export function latencyUsable(ev: Evidence): boolean {
  const ms = ev.latencyMs;
  if (!ev.latencyValid || typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return false;
  return ACTIVE_TIME.has(ev.kind) || ms <= PARAMS.latency.maxMs;
}

// ---------------------------------------------------------------- par

export interface ParItem {
  kind?: ItemKind;
  /** Lines of code the learner has to read. */
  codeLines: number;
  /** Characters of the expected answer (or fill). */
  answerChars: number;
  /** Thinking seconds from the item (3-8 probes, 20-40 completions). */
  parSec: number;
}

/** Thinking-time clamp: 3-8 s for probes; completions carry 20-40 s; specs and tasks are not clamped. */
function thinkRange(kind?: ItemKind): [number, number] {
  if (kind === 'completion') return [20, 40];
  if (kind === 'spec' || kind === 'task') return [1, 3600];
  return [3, 8];
}

function parMs(item: ParItem, cps: number, factor: number): number {
  const [lo, hi] = thinkRange(item.kind);
  const read = Math.max(0, item.codeLines) * PARAMS.latency.readSecPerLine;
  const type = Math.max(0, item.answerChars) / (cps > 0 ? cps : PARAMS.latency.cps);
  const think = clamp(Number.isFinite(item.parSec) ? item.parSec : lo, lo, hi) * factor;
  return Math.round((read + type + think) * 1000);
}

/** par_self in ms: read + type at the learner's cps + think x speedFactor. For Fragile, implicit guesses, outliers. */
export function parSelf(item: ParItem, l: { cps: number; speedFactor: number }): number {
  const [lo, hi] = PARAMS.latency.speedFactor;
  return parMs(item, l.cps, clamp(Number.isFinite(l.speedFactor) ? l.speedFactor : 1, lo, hi));
}

/** par_abs in ms: the same with speedFactor 1. For Fluent and the Pace metrics. */
export function parAbs(item: ParItem, l: { cps: number }): number {
  return parMs(item, l.cps, 1);
}

// ---------------------------------------------------------------- concept predicates

/** Push x unless present; true when it was added. */
export function addUnique(xs: string[], x: string): boolean {
  if (xs.includes(x)) return false;
  xs.push(x);
  return true;
}

/** Bump lastAt (the multi-window merge key) so it strictly increases. */
export function touch(c: ConceptState, now: number): void {
  c.lastAt = Math.max(now, (c.lastAt ?? 0) + 1);
}

export interface Caps {
  groups: boolean;
  production: boolean;
  coverage: boolean;
  /** Required misconceptions no correct item has carried yet. */
  missing: string[];
  ok: boolean;
}

/** Step 7: P stays <= .8 until 2 sibling groups, a production item and coverage all hold. */
export function caps(c: ConceptState, required: string[] = []): Caps {
  const groups = c.groupsCorrect.length >= PARAMS.capGroups;
  const production = c.production;
  const missing = required.filter((id) => !c.coveredMisconceptions.includes(id));
  return { groups, production, coverage: !missing.length, missing, ok: groups && production && !missing.length };
}

/** An active or suppressed misconception, or a candidate with p >= .3. */
export function blockingMisconceptions(c: ConceptState): string[] {
  return Object.entries(c.misconceptions)
    .filter(([, m]) => m.status === 'active' || m.status === 'suppressed' || (m.status === 'candidate' && m.p >= PARAMS.misconception.blockP))
    .map(([id]) => id);
}

/** Step 13. */
export function isMastered(c: ConceptState, required: string[] = []): boolean {
  if (!(c.mastery >= PARAMS.masteredP)) return false;
  if (c.fragile || blockingMisconceptions(c).length) return false;
  return c.inferred || caps(c, required).ok;
}

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Median latency/par_abs of the last 3 correct answers, spread over 2+ calendar days, at most 1.0. */
export function isFluent(c: ConceptState, required: string[] = []): boolean {
  if (!isMastered(c, required)) return false;
  const last = c.fluency.slice(-3);
  if (last.length < 3 || new Set(last.map((f) => dayKey(f.at))).size < 2) return false;
  return median(last.map((f) => f.ratio)) <= 1;
}

/** Step 12: the state chip, in priority order. The 'inferred' flag is c.inferred. */
export function chip(c: ConceptState, required: string[] = []): ConceptChip {
  const ms = Object.values(c.misconceptions);
  if (ms.some((m) => m.status === 'active')) return 'Misconception';
  if (ms.some((m) => m.status === 'suppressed')) return 'Fixing';
  if (c.mastery < 0.5) return 'Unknown';
  if (c.fragile) return 'Fragile';
  if (!isMastered(c, required)) return 'Learning';
  return isFluent(c, required) ? 'Fluent' : 'Solid';
}

// ---------------------------------------------------------------- misconceptions

export interface AnswerFlags {
  correct: boolean;
  guess: boolean;
  dontKnow: boolean;
}

export interface MisconceptionUpdate {
  matched?: { id: string; status: MisconceptionStatus; created: boolean; relapse: boolean };
  suppressed?: string;
  cleared: string[];
}

/** Step 8: candidate -> active -> suppressed -> cleared, with relapses. */
export function updateMisconception(c: ConceptState, ev: EvidenceRecord, f: AnswerFlags, taxonomy?: TaxonomyFn): MisconceptionUpdate {
  const P = PARAMS.misconception;
  const at = ev.at;
  const out: MisconceptionUpdate = { cleared: [] };

  // A wrong answer that names a belief. '?' and an 'n' to the belief check never update it.
  const id = ev.misconceptionId;
  if (id && ev.correct === false && !f.dontKnow && ev.beliefConfirmed !== false) {
    const passive = isPassive(ev);
    let m: MisconceptionState | undefined = c.misconceptions[id];
    const created = !m;
    const info = taxonomy?.(id, c);
    const belief = info?.belief || ev.belief || '';
    if (!m) {
      m = { p: info?.prior ?? P.prior, belief, status: 'candidate', groups: [], delayedHits: 0, relapses: 0, lastAt: at };
      c.misconceptions[id] = m;
    } else if (!m.belief) m.belief = belief;
    const odds = ev.misconceptionOdds ?? (ev.beliefConfirmed ? P.odds.confirmed : passive ? P.odds.passive : P.odds.unconfirmed);
    m.p = scaleOdds(m.p, clamp(odds, 1, PARAMS.maxRatio));
    if (!passive && ev.siblingGroup) addUnique(m.groups, ev.siblingGroup);
    let relapse = false;
    if (!passive && (m.status === 'suppressed' || m.status === 'cleared')) {
      m.status = 'active';
      m.relapses += 1;
      m.delayedHits = 0;
      m.refutedAt = undefined;
      relapse = true;
    } else if (!passive && m.status === 'candidate' && m.p > P.activeP && m.groups.length >= P.groups) {
      m.status = 'active';
    }
    m.lastAt = at;
    m.nextCheckAt = at + P.firstHitMs;
    out.matched = { id, status: m.status, created, relapse };
  }

  // A delayed check that was missed without naming the belief: look again later.
  if (ev.delayedCheckFor && ev.correct !== true && ev.delayedCheckFor !== id) {
    const m = c.misconceptions[ev.delayedCheckFor];
    if (m && m.status === 'suppressed') m.nextCheckAt = at + PARAMS.schedule.fail * DAY;
  }

  if (!f.correct || f.guess) return out;

  // Correct re-probe right after a refutation: suppressed, not cleared.
  if (ev.suppresses) {
    const m = c.misconceptions[ev.suppresses];
    if (m && m.status !== 'cleared' && m.status !== 'suppressed') {
      m.status = 'suppressed';
      m.p = scaleOdds(m.p, P.odds.suppress);
      m.refutedAt = at;
      m.delayedHits = 0;
      m.nextCheckAt = at + P.firstHitMs;
      m.lastAt = at;
      out.suppressed = ev.suppresses;
    }
  }

  const carried = ev.avoidedMisconceptionIds ?? [];
  for (const [mid, m] of Object.entries(c.misconceptions)) {
    if (mid === out.suppressed) continue;
    // Delayed hits: 10+ min after the refutation in an interleaved sprint, then 1+ day after it.
    if (m.status === 'suppressed') {
      const isCheck = ev.delayedCheckFor === mid || (ev.source === 'sprint' && carried.includes(mid));
      if (!isCheck) continue;
      const since = at - (m.refutedAt ?? 0);
      if (since < (m.delayedHits === 0 ? P.firstHitMs : P.secondHitMs)) continue;
      m.delayedHits += 1;
      m.lastAt = at;
      if (m.delayedHits >= 2) {
        m.status = 'cleared';
        m.nextCheckAt = undefined;
        out.cleared.push(mid);
      } else {
        m.nextCheckAt = (m.refutedAt ?? at) + P.secondHitMs;
      }
    } else if (m.status === 'candidate' && carried.includes(mid)) {
      // Avoiding the mutant is evidence against an unconfirmed belief (mirror of an unconfirmed match).
      m.p = scaleOdds(m.p, P.odds.avoided);
      m.lastAt = at;
    }
  }
  return out;
}

// ---------------------------------------------------------------- graph propagation

/** Canonical id for an id or alias, or undefined. Ids are expected to be slugs already. */
export function resolveId(concepts: Record<string, ConceptState>, id: string): string | undefined {
  if (concepts[id]) return id;
  for (const c of Object.values(concepts)) if (c.aliases?.includes(id)) return c.id;
  return undefined;
}

interface Graph {
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
}

function buildGraph(concepts: Record<string, ConceptState>): Graph {
  const alias = new Map<string, string>();
  for (const c of Object.values(concepts)) for (const a of c.aliases ?? []) if (!concepts[a]) alias.set(a, c.id);
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const c of Object.values(concepts)) {
    const ps = new Set<string>();
    for (const raw of c.prerequisites ?? []) {
      const p = concepts[raw] ? raw : alias.get(raw);
      if (p && p !== c.id) ps.add(p);
    }
    parents.set(c.id, [...ps]);
    for (const p of ps) children.set(p, [...(children.get(p) ?? []), c.id]);
  }
  return { parents, children };
}

/** Breadth-first walk up to maxHops; the visited set drops back-edges, so cycles are safe. */
function walk(adj: Map<string, string[]>, start: string, maxHops: number): string[] {
  const seen = new Set([start]);
  const out: string[] = [];
  let frontier = [start];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adj.get(id) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return out;
}

export interface PropagationSignal {
  /** Correct non-guess answer on the source: support its ancestors. */
  up: boolean;
  /** Full-weight committed wrong answer on the source: cap its descendants (when P < .3). */
  down: boolean;
}

/**
 * Step 11. Every operation is a max/min/set-add, so re-running it (multi-window replay) is safe.
 * Returns the ids of concepts it changed.
 */
export function propagate(learner: Learner, src: ConceptState, signal: PropagationSignal, at: number, now = at, coverage?: CoverageFn): string[] {
  const P = PARAMS.propagation;
  const concepts = learner.concepts;
  const g = buildGraph(concepts);
  const changed: string[] = [];

  if (signal.up) {
    for (const id of walk(g.parents, src.id, P.maxHops)) {
      const a = concepts[id];
      let touched = addUnique(a.supportFrom, src.id);
      // A concept that just failed on its own is never raised by its descendants.
      const ownWrong = a.lastWrongAt !== undefined && at - a.lastWrongAt < P.recentMs;
      if (!ownWrong) {
        const supporters = a.supportFrom.map((s) => concepts[resolveId(concepts, s) ?? '']).filter((s): s is ConceptState => !!s?.tested);
        let target = 0;
        if (supporters.length >= 2 && supporters.some((s) => s.production)) {
          target = P.inferredP;
          if (!a.inferred) {
            a.inferred = true;
            touched = true;
          }
        } else if (supporters.length >= 1) target = P.singleP;
        if (a.mastery < target) {
          a.mastery = target;
          touched = true;
        }
      }
      if (touched) {
        touch(a, now);
        syncMastered(a, at, coverage?.(a));
        changed.push(id);
      }
    }
  }

  if (signal.down && src.mastery < P.lowP) {
    const deep = (src.wrongGroups ?? []).length >= 2;
    const cap = src.mastery + (deep ? P.deepCap : P.childCap);
    for (const id of walk(g.children, src.id, deep ? P.maxHops : 1)) {
      const d = concepts[id];
      // Concepts with their own evidence in the last 7 days are never lowered.
      if (d.lastPracticed > 0 && at - d.lastPracticed < P.recentMs) continue;
      if (d.mastery > cap) {
        d.mastery = cap;
        touch(d, now);
        syncMastered(d, at, coverage?.(d));
        changed.push(id);
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------- audits

/** Keep masteredAt/auditDueAt in step with isMastered. Returns true when it became mastered now. */
export function syncMastered(c: ConceptState, at: number, required: string[] = []): boolean {
  const m = isMastered(c, required);
  if (m && c.masteredAt === undefined) {
    c.masteredAt = at;
    c.auditDueAt = at + PARAMS.audit.afterMs;
    return true;
  }
  if (!m && c.masteredAt !== undefined) {
    c.masteredAt = undefined;
    c.auditDueAt = undefined;
  }
  return false;
}

/** Step 14: mastered concepts whose delayed production audit is due, inferred ones first, else random. */
export function auditDue(concepts: Record<string, ConceptState> | ConceptState[], now: number, rng: () => number = Math.random): ConceptState[] {
  const list = (Array.isArray(concepts) ? concepts : Object.values(concepts)).filter(
    (c) => c.masteredAt !== undefined && c.auditDueAt !== undefined && c.auditDueAt <= now,
  );
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list.sort((a, b) => Number(b.inferred) - Number(a.inferred));
}

/** A missed audit: P <= .6, mastery revoked; production must be earned again. */
function revoke(c: ConceptState): void {
  c.mastery = Math.min(c.mastery, PARAMS.audit.missP);
  c.masteredAt = undefined;
  c.auditDueAt = undefined;
  c.production = false;
  c.inferred = false;
}

// ---------------------------------------------------------------- scheduling

function setReview(c: ConceptState, days: number, now: number): void {
  c.intervalDays = days;
  c.nextReview = now + days * DAY;
}

/**
 * Step 15. Ladders (misconception 10 min -> .25 day -> 1 day; fragile 10 min -> 1 day) advance
 * only when the previous review came due; more evidence before then keeps the scheduled check.
 * A fresh failure (restart) goes back to the first rung. Solid intervals grow x2.2 per due review.
 */
export function scheduleOutcome(c: ConceptState, outcome: Outcome, now: number, restart = false): void {
  const S = PARAMS.schedule;
  const due = c.nextReview === 0 || now >= c.nextReview;
  switch (outcome) {
    case 'misconception':
    case 'fragile': {
      const rungs: readonly number[] = S[outcome];
      const i = rungs.findIndex((r) => Math.abs(r - c.intervalDays) < 1e-9);
      if (restart || i < 0) setReview(c, rungs[0], now);
      else if (due) setReview(c, rungs[Math.min(i + 1, rungs.length - 1)], now);
      return;
    }
    case 'guess':
      // One interleaved item later this session.
      if (c.nextReview === 0 || c.nextReview > now + S.guessMs) c.nextReview = now + S.guessMs;
      return;
    case 'solid':
      if (c.intervalDays < S.solidMin) setReview(c, S.solidMin, now);
      else if (due) setReview(c, Math.min(S.solidMax, c.intervalDays * S.solidGrowth), now);
      return;
    case 'fail':
      setReview(c, S.fail, now);
      return;
  }
}

function outcomeOf(c: ConceptState, correct: boolean, guess: boolean): Outcome {
  if (Object.values(c.misconceptions).some((m) => m.status === 'active' || m.status === 'suppressed')) return 'misconception';
  if (c.fragile) return 'fragile';
  if (!correct) return 'fail';
  return guess ? 'guess' : 'solid';
}

// ---------------------------------------------------------------- the update

/** Steps 3-4: effective weight after the confidence rules. */
function effectiveWeight(ev: EvidenceRecord, f: AnswerFlags): number {
  let w = clamp(Number.isFinite(ev.weight) ? ev.weight : 1, 0, 1);
  const half = PARAMS.halfWeight;
  if (f.dontKnow) w = Math.min(w, half);
  else if (!f.correct && (f.guess || ev.beliefConfirmed === false)) w = Math.min(w, half);
  if (ev.kind === 'llm-grade') w = Math.min(w, half);
  return w;
}

/** A completion pass, or a spec green at full weight (within 3 saves, function not assisted). */
function earnsProduction(ev: Evidence, w: number): boolean {
  return !!ev.production && (ev.kind === 'completion' || (ev.kind === 'spec' && w >= 1));
}

/**
 * Apply one observation to concept c (steps 1-17). Mutates c (and, with ctx.learner, its
 * neighbours and the learner's stats). Never writes ev: the caller copies weight, bits,
 * implicitGuess and latencyValid from the result into the logged record.
 */
export function applyEvidence(c: ConceptState, ev: EvidenceRecord, ctx: ApplyContext = {}): ApplyResult {
  const at = ev.at;
  const now = ctx.now ?? at;
  const L = ctx.learner;
  const stats = !!L && ctx.stats !== false;
  const required = ctx.coverage?.(c) ?? [];
  const before = c.mastery;

  const lat = latencyUsable(ev);
  const dontKnow = ev.correct === null || ev.verdict === 'dont-know';
  const correct = ev.correct === true && !dontKnow;
  const implicit =
    !!ev.implicitGuess ||
    (lat && ITEM_KINDS.has(ev.kind) && (ev.parSelfMs ?? 0) > 0 && ev.latencyMs! < PARAMS.latency.implicitGuess * ev.parSelfMs!);
  const guess = !dontKnow && (ev.guessFlag || implicit);
  const f: AnswerFlags = { correct, guess, dontKnow };
  const w = effectiveWeight(ev, f);

  const result: ApplyResult = {
    discarded: false, weight: w, bits: 0, guess, implicitGuess: implicit, latencyValid: lat,
    before, after: before, propagated: [], mastered: false, masteredNow: false, revoked: false, cleared: [],
  };
  // format-only: a note, no evidence. Zero weight: an assisted answer or a discarded item.
  if (ev.verdict === 'format-only' || w <= 0) {
    result.discarded = true;
    result.weight = 0;
    result.mastered = isMastered(c, required);
    return result;
  }

  // Steps 1-6: capped likelihoods, weighted posterior, learning transition.
  const { g, s } = baseGS(ev, !!L && guessesUnflagged(L));
  const p0 = clamp(Number.isFinite(c.mastery) ? c.mastery : 0.3, 0.001, 0.999);
  let p = p0 + w * (posterior(p0, correct, g, s) - p0);
  result.bits = bits(p0, p);
  p += (1 - p) * clamp(Number.isFinite(ev.learnT) ? ev.learnT : 0, 0, PARAMS.learnT.boost);

  // Direct-evidence bookkeeping.
  c.tested = true;
  c.lastPracticed = Math.max(c.lastPracticed || 0, at);
  if (correct && !guess) {
    if (ev.siblingGroup) addUnique(c.groupsCorrect, ev.siblingGroup);
    for (const id of ev.avoidedMisconceptionIds ?? []) addUnique(c.coveredMisconceptions, id);
    if (earnsProduction(ev, w)) c.production = true;
  }
  const fullWrong = ev.correct === false && !dontKnow && !guess && w >= 1;
  if (fullWrong) c.lastWrongAt = at;

  // Step 8.
  const mis = updateMisconception(c, ev, f, ctx.taxonomy);
  result.misconception = mis.matched;
  result.suppressed = mis.suppressed;
  result.cleared = mis.cleared;

  // Step 10: Fragile (never during the first 15 graded items).
  const gradedBefore = L?.gradedCount ?? 0;
  if (correct && !guess && lat && (ev.parSelfMs ?? 0) > 0) {
    const ms = ev.latencyMs!;
    const par = ev.parSelfMs!;
    const F = PARAMS.fragile;
    if (!c.fragile && ms > F.slow * par && gradedBefore >= F.minItems) {
      c.fragile = true;
      c.fragileSince = at;
      result.fragile = 'set';
    } else if (c.fragile && ms <= F.fast * par && at - (c.fragileSince ?? 0) >= F.clearAfterMs) {
      c.fragile = false;
      c.fragileSince = undefined;
      result.fragile = 'cleared';
    }
  }

  // Interleaving signal: right before, wrong when interleaved in a sprint.
  if (ev.source === 'sprint') {
    if (ev.correct === false && !dontKnow && c.groupsCorrect.length) c.selectionGap = true;
    else if (correct && !guess && c.selectionGap) c.selectionGap = false;
  }

  // Step 14: the delayed production audit.
  if (ev.source === 'audit' && (c.masteredAt !== undefined || c.auditDueAt !== undefined)) {
    if (correct) {
      c.auditDueAt = undefined;
      if (stats) L!.audits.passed += 1;
    } else {
      c.mastery = p;
      revoke(c);
      p = c.mastery;
      result.revoked = true;
      if (stats) {
        L!.audits.failed += 1;
        L!.falseMastery.push({ conceptId: c.id, at });
        if (L!.falseMastery.length > 50) L!.falseMastery.splice(0, L!.falseMastery.length - 50);
      }
    }
  }

  // Step 7 and the guess cap. Caps never lower P that an earlier profile already had.
  if ((correct && guess) || !(c.inferred || caps(c, required).ok)) p = Math.min(p, Math.max(before, PARAMS.cap));
  c.mastery = clamp(p, 0, 1);
  if (fullWrong && c.mastery < PARAMS.propagation.lowP) addUnique((c.wrongGroups ??= []), ev.siblingGroup ?? ev.kind);
  touch(c, now);
  result.after = c.mastery;

  // Step 11.
  if (L && ctx.propagate !== false) {
    result.propagated = propagate(L, c, { up: correct && !guess, down: fullWrong }, at, now, ctx.coverage);
  }

  // Steps 13-15.
  result.masteredNow = syncMastered(c, at, required);
  result.mastered = isMastered(c, required);
  const outcome = outcomeOf(c, correct, guess);
  result.outcome = outcome;
  const restart = (outcome === 'misconception' && !correct) || (outcome === 'fragile' && result.fragile === 'set');
  scheduleOutcome(c, outcome, at, restart);

  // Latency ratios for fluency (concept) and speedFactor (learner).
  if (correct && !guess && lat && ITEM_KINDS.has(ev.kind) && (ev.parAbsMs ?? 0) > 0) {
    const ratio = ev.latencyMs! / ev.parAbsMs!;
    c.fluency.push({ ratio, at });
    if (c.fluency.length > PARAMS.latency.fluencyWindow) c.fluency.splice(0, c.fluency.length - PARAMS.latency.fluencyWindow);
    if (stats) {
      L!.recentRatios.push(ratio);
      if (L!.recentRatios.length > PARAMS.latency.ratioWindow) L!.recentRatios.splice(0, L!.recentRatios.length - PARAMS.latency.ratioWindow);
      const [lo, hi] = PARAMS.latency.speedFactor;
      L!.speedFactor = clamp(median(L!.recentRatios), lo, hi);
    }
  }

  // Step 16: calibration and the graded-item count.
  if (stats && ITEM_KINDS.has(ev.kind)) {
    L!.gradedCount += 1;
    if (!dontKnow) {
      const bucket = guess ? L!.calibration.guess : L!.calibration.sure;
      bucket[1] += 1;
      if (correct) bucket[0] += 1;
    }
  }
  return result;
}
