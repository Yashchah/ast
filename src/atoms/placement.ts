// Placement blitz selection and stop rule (spec V1-7 SELECTION, STOP RULE, FINISH; coreLoop 1).
// Pure: no vscode, no I/O. The pad shows the items, the coach records evidence (source 'placement')
// and calls record() with what happened; this module only decides what comes next and when to stop.
//
// - Item 1 is a typing calibration (copy a short literal; sets cps, not scored).
// - score(c) = importance(c) x (1 - |P(c) - .5| x 2) + leafBonus, importance = 1 + DAG descendants
//   + 2 x [needed by tasks 1-3]; ticked concepts start at their deepest ticked leaves (bonus 3).
// - Predict items come from an unseen sibling group, using constructs the learner is believed to know.
// - The last 2 items are completions on the two highest-importance concepts at P >= .7.
// - Stop: every needed concept classified (P outside [.25, .8], or 2 items); 14 items; 4 minutes;
//   Esc; or the experienced fast lane (3 correct leaf items in a row under par_self, one of them a
//   completion). With the plan still pending, up to 5 harder items follow ('roadmap almost ready').

import type { Lang, StoredCompletion, StoredProbe, VerdictKind } from '../contracts';
import { resolveId } from '../evidence';
import type { Learner } from '../types';
import { hash53 } from './rng';
import { seenWithin7Days } from './seeds';

const MIN = 60_000;

export const PLACEMENT = {
  maxItems: 14,
  maxMs: 4 * MIN,
  /** Completions close the predict phase. */
  completions: 2,
  /** The predict phase ends at this many items or this much time, leaving room for the completions. */
  predictItems: 12,
  predictMs: 3 * MIN,
  completionP: 0.7,
  leafBonus: 3,
  classify: { low: 0.25, high: 0.8, items: 2 },
  fastLane: 3,
  extraItems: 5,
  extraP: [0.6, 0.85] as const,
  extraLabel: 'roadmap almost ready',
  /** P assumed for a concept the learner model does not have yet. */
  prior: 0.3,
} as const;

// ---------------------------------------------------------------- types

export interface PlacementCandidate {
  conceptId: string;
  probes: StoredProbe[];
  completions: StoredCompletion[];
}

export interface PlacementSources {
  candidates: PlacementCandidate[];
  now: number;
  lang: Lang;
  /** Concept (id or alias) a probe construct belongs to; undefined = a basic construct. Absent: no construct filter. */
  constructConcept?: (construct: string) => string | undefined;
}

export interface PlacementDag {
  /** conceptId -> prerequisite ids (default: the learner's concept prerequisites). */
  prereqs?: Record<string, string[]>;
  /** Concepts needed by tasks 1-3 (empty while the plan is pending: every candidate counts). */
  needed?: string[];
}

export type PlacementItem =
  | { kind: 'typing'; literal: string }
  | { kind: 'predict'; conceptId: string; probe: StoredProbe; confounded?: boolean; extra?: boolean; label?: string }
  | { kind: 'completion'; conceptId: string; completion: StoredCompletion; extra?: boolean; label?: string };

export interface PlacementRecord {
  conceptId: string;
  itemId: string;
  kind: 'predict' | 'completion';
  group?: string;
  /** null = don't know. */
  correct: boolean | null;
  guess: boolean;
  verdict?: VerdictKind;
  latencyMs?: number;
  latencyValid: boolean;
  parSelfMs?: number;
  /** Correct answer within par_self (valid latency only). */
  underPar: boolean;
  misconceptionId?: string;
  /** A 'roadmap almost ready' item after the stop. */
  extra: boolean;
  at: number;
}

export type PlacementObservation =
  | { kind: 'typing'; at: number }
  | (Omit<PlacementRecord, 'underPar' | 'extra'> & { extra?: boolean });

export interface PlacementState {
  startedAt: number;
  calibrated: boolean;
  esc: boolean;
  items: PlacementRecord[];
  askedIds: string[];
}

export type StopReason = 'esc' | 'fast-lane' | 'time' | 'max-items' | 'classified' | 'no-items' | 'plan-pending';

export interface StopDecision {
  stop: boolean;
  reason?: StopReason;
  /** The base rule fired but the plan is pending: serve up to 5 harder items. */
  extraPhase?: boolean;
}

export function newPlacement(now: number, calibrated = false): PlacementState {
  return { startedAt: now, calibrated, esc: false, items: [], askedIds: [] };
}

// ---------------------------------------------------------------- graph

interface Graph {
  ids: string[];
  children: Map<string, string[]>;
  needed: Set<string>;
}

function graph(learner: Learner, sources: PlacementSources, dag: PlacementDag): Graph {
  const resolve = (id: string) => resolveId(learner.concepts, id) ?? id;
  const ids = new Set<string>([...Object.keys(learner.concepts), ...sources.candidates.map((c) => resolve(c.conceptId))]);
  for (const id of Object.keys(dag.prereqs ?? {})) ids.add(resolve(id));
  const children = new Map<string, string[]>();
  for (const id of ids) {
    const prereqs = dag.prereqs?.[id] ?? learner.concepts[id]?.prerequisites ?? [];
    for (const raw of prereqs) {
      const p = resolve(raw);
      if (p === id) continue;
      children.set(p, [...(children.get(p) ?? []), id]);
    }
  }
  return { ids: [...ids], children, needed: new Set((dag.needed ?? []).map(resolve)) };
}

/** Transitive dependents (cycle-safe). */
function descendantsOf(g: Graph, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    for (const c of g.children.get(stack.pop()!) ?? []) {
      if (c === id || seen.has(c)) continue;
      seen.add(c);
      stack.push(c);
    }
  }
  return seen;
}

const pOf = (learner: Learner, id: string) => learner.concepts[id]?.mastery ?? PLACEMENT.prior;
const ticked = (learner: Learner, id: string) => learner.concepts[id]?.selfRating === 'used';

/** 1 + number of DAG descendants + 2 x [needed by tasks 1-3]. */
export function importance(learner: Learner, sources: PlacementSources, dag: PlacementDag, id: string): number {
  const g = graph(learner, sources, dag);
  return importanceIn(g, id);
}

function importanceIn(g: Graph, id: string): number {
  return 1 + descendantsOf(g, id).size + (g.needed.has(id) ? 2 : 0);
}

/** A leaf: nothing builds on it, or it is ticked and nothing ticked builds on it. */
function isLeaf(g: Graph, learner: Learner, id: string): boolean {
  const ds = descendantsOf(g, id);
  if (!ds.size) return true;
  return ticked(learner, id) && ![...ds].some((d) => ticked(learner, d));
}

/** The selection score. leafBonus 3 for a ticked concept with no ticked descendant, not yet asked. */
export function placementScore(
  learner: Learner, sources: PlacementSources, dag: PlacementDag, state: PlacementState, id: string,
): number {
  return scoreIn(graph(learner, sources, dag), learner, state, id);
}

function scoreIn(g: Graph, learner: Learner, state: PlacementState, id: string): number {
  const p = pOf(learner, id);
  const asked = state.items.some((r) => r.conceptId === id);
  const ds = descendantsOf(g, id);
  const deepestTicked = ticked(learner, id) && ![...ds].some((d) => ticked(learner, d));
  return importanceIn(g, id) * (1 - Math.abs(p - 0.5) * 2) + (deepestTicked && !asked ? PLACEMENT.leafBonus : 0);
}

// ---------------------------------------------------------------- items

function candidatesById(learner: Learner, sources: PlacementSources): Map<string, PlacementCandidate> {
  const out = new Map<string, PlacementCandidate>();
  for (const c of sources.candidates) {
    const id = resolveId(learner.concepts, c.conceptId) ?? c.conceptId;
    const prev = out.get(id);
    out.set(id, prev ? { conceptId: id, probes: [...prev.probes, ...c.probes], completions: [...prev.completions, ...c.completions] } : { ...c, conceptId: id });
  }
  return out;
}

function placementItems(state: PlacementState): PlacementRecord[] {
  return state.items.filter((r) => !r.extra);
}

function itemsOn(state: PlacementState, id: string): number {
  return placementItems(state).filter((r) => r.conceptId === id).length;
}

function classified(state: PlacementState, learner: Learner, id: string): boolean {
  const p = pOf(learner, id);
  const C = PLACEMENT.classify;
  return p < C.low || p > C.high || itemsOn(state, id) >= C.items;
}

/** Unseen-group probes for a concept, construct-filtered (fallback: fewest unknown constructs, confounded). */
function probeFor(
  cand: PlacementCandidate, state: PlacementState, learner: Learner, sources: PlacementSources, prefer?: (p: StoredProbe) => number,
): { probe: StoredProbe; confounded: boolean } | undefined {
  const usedGroups = new Set(state.items.filter((r) => r.conceptId === cand.conceptId && r.group).map((r) => r.group!));
  const pool = cand.probes.filter((p) => !state.askedIds.includes(p.id) && !usedGroups.has(p.group) && !seenWithin7Days(p.stats, sources.now));
  if (!pool.length) return undefined;
  const map = sources.constructConcept;
  const unknown = (p: StoredProbe) =>
    !map ? 0 : p.constructs.filter((k) => {
      const c = map(k);
      if (!c) return false;
      const id = resolveId(learner.concepts, c) ?? c;
      return id !== cand.conceptId && pOf(learner, id) < 0.5;
    }).length;
  const order = (a: StoredProbe, b: StoredProbe) =>
    unknown(a) - unknown(b) || (prefer ? prefer(a) - prefer(b) : 0) || Number(b.discriminating) - Number(a.discriminating) || a.stats.n - b.stats.n || (a.id < b.id ? -1 : 1);
  const best = [...pool].sort(order)[0];
  return { probe: best, confounded: unknown(best) > 0 };
}

function completionFor(cand: PlacementCandidate, state: PlacementState, sources: PlacementSources): StoredCompletion | undefined {
  return cand.completions
    .filter((c) => !state.askedIds.includes(c.id) && !seenWithin7Days(c.stats, sources.now))
    .sort((a, b) => a.stats.n - b.stats.n)[0];
}

const TYPING: Record<'python' | 'js', string[]> = {
  python: ["[3, 'a', True]", "{'x': 1, 'y': 2}", "(4, 'ok', None)", "[0.5, 'b', False]"],
  js: ["[3, 'a', true]", "{ x: 1, y: 'b' }", "[null, 4, 'ok']", "[0.5, 'b', false]"],
};

/** The typing-calibration literal (stable per placement). */
export function typingLiteral(lang: Lang, seed: number): string {
  const xs = TYPING[lang === 'python' ? 'python' : 'js'];
  return xs[hash53(String(seed)) % xs.length];
}

interface View {
  g: Graph;
  cands: Map<string, PlacementCandidate>;
  /** Concepts with something to ask (probes in an unseen group). */
  probeable: string[];
  needed: string[];
}

function view(state: PlacementState, sources: PlacementSources, learner: Learner, dag: PlacementDag): View {
  const g = graph(learner, sources, dag);
  const cands = candidatesById(learner, sources);
  const hasItems = (id: string) => {
    const c = cands.get(id);
    return !!c && (c.probes.length > 0 || c.completions.length > 0);
  };
  const probeable = [...cands.keys()].filter((id) => !!probeFor(cands.get(id)!, state, learner, sources));
  // Needed concepts without any item can never be classified here: they do not hold placement open.
  const needed = (g.needed.size ? [...g.needed] : [...cands.keys()]).filter(hasItems);
  return { g, cands, probeable, needed };
}

function elapsed(state: PlacementState, now: number): number {
  return Math.max(0, now - state.startedAt);
}

/** The predict phase is over: everything needed classified, 12 items, 3 minutes, or nothing left to ask. */
function predictPhaseOver(state: PlacementState, v: View, learner: Learner, now: number): boolean {
  if (v.needed.every((id) => classified(state, learner, id))) return true;
  if (placementItems(state).length >= PLACEMENT.predictItems) return true;
  if (elapsed(state, now) >= PLACEMENT.predictMs) return true;
  return !v.probeable.some((id) => !classified(state, learner, id));
}

/** Completion targets: highest importance first, P >= .7, a completion in stock, not completion-tested yet. */
function completionTargets(state: PlacementState, v: View, learner: Learner, sources: PlacementSources, leafOnly = false): string[] {
  const done = new Set(placementItems(state).filter((r) => r.kind === 'completion').map((r) => r.conceptId));
  return [...v.cands.keys()]
    .filter((id) => !done.has(id) && pOf(learner, id) >= PLACEMENT.completionP && !!completionFor(v.cands.get(id)!, state, sources))
    .filter((id) => !leafOnly || isLeaf(v.g, learner, id))
    .sort((a, b) => importanceIn(v.g, b) - importanceIn(v.g, a) || (a < b ? -1 : 1));
}

function completionsServed(state: PlacementState): number {
  return placementItems(state).filter((r) => r.kind === 'completion').length;
}

/** Last `n` placement items, newest last. */
function lastItems(state: PlacementState, n: number): PlacementRecord[] {
  const xs = placementItems(state);
  return xs.slice(Math.max(0, xs.length - n));
}

function fastStreak(state: PlacementState, v: View, learner: Learner, n: number): PlacementRecord[] | undefined {
  const last = lastItems(state, n);
  if (last.length < n) return undefined;
  return last.every((r) => r.correct === true && !r.guess && r.underPar && isLeaf(v.g, learner, r.conceptId)) ? last : undefined;
}

// ---------------------------------------------------------------- stop rule

export interface StopOptions {
  /** PlanOutline has not landed. */
  planPending?: boolean;
}

export function shouldStop(state: PlacementState, sources: PlacementSources, learner: Learner, dag: PlacementDag, opts: StopOptions = {}): StopDecision {
  if (state.esc) return { stop: true, reason: 'esc' };
  const v = view(state, sources, learner, dag);
  const base = baseStop(state, v, learner, sources);
  if (!base) return { stop: false };
  if (opts.planPending && base !== 'no-items') {
    const extras = state.items.filter((r) => r.extra).length;
    if (extras < PLACEMENT.extraItems && extraItem(state, v, learner, sources)) return { stop: false, extraPhase: true };
    return { stop: true, reason: 'plan-pending' };
  }
  return { stop: true, reason: base };
}

function baseStop(state: PlacementState, v: View, learner: Learner, sources: PlacementSources): StopReason | undefined {
  const now = sources.now;
  const streak = fastStreak(state, v, learner, PLACEMENT.fastLane);
  if (streak && streak.some((r) => r.kind === 'completion')) return 'fast-lane';
  if (elapsed(state, now) >= PLACEMENT.maxMs) return 'time';
  if (placementItems(state).length >= PLACEMENT.maxItems) return 'max-items';
  if (!predictPhaseOver(state, v, learner, now)) return undefined;
  // The last 2 items are completions, when there are concepts to check production on.
  if (completionsServed(state) < PLACEMENT.completions && completionTargets(state, v, learner, sources).length) return undefined;
  if (v.needed.every((id) => classified(state, learner, id))) return 'classified';
  if (placementItems(state).length >= PLACEMENT.predictItems) return 'max-items';
  if (elapsed(state, now) >= PLACEMENT.predictMs) return 'time';
  return 'no-items';
}

/** 'roadmap almost ready': a harder predict item on a concept at P .6-.85. */
function extraItem(state: PlacementState, v: View, learner: Learner, sources: PlacementSources): PlacementItem | undefined {
  const [lo, hi] = PLACEMENT.extraP;
  const ids = [...v.cands.keys()]
    .filter((id) => pOf(learner, id) >= lo && pOf(learner, id) <= hi)
    .sort((a, b) => importanceIn(v.g, b) - importanceIn(v.g, a) || (a < b ? -1 : 1));
  const last = state.items[state.items.length - 1]?.conceptId;
  for (const id of [...ids.filter((x) => x !== last), ...ids.filter((x) => x === last)]) {
    // Harder: structured answers (lower guess rate), then more thinking time.
    const p = probeFor(v.cands.get(id)!, state, learner, sources, (x) => x.answerSpaceG * 100 - x.parSec);
    if (p) return { kind: 'predict', conceptId: id, probe: p.probe, confounded: p.confounded || undefined, extra: true, label: PLACEMENT.extraLabel };
  }
  return undefined;
}

// ---------------------------------------------------------------- selection

/**
 * The next placement item, or undefined when placement should stop (see shouldStop for the reason).
 * opts.planPending enables the 'roadmap almost ready' extras after the stop.
 */
export function nextItem(
  state: PlacementState, sources: PlacementSources, learner: Learner, dag: PlacementDag, opts: StopOptions = {},
): PlacementItem | undefined {
  if (state.esc) return undefined;
  if (!state.calibrated) return { kind: 'typing', literal: typingLiteral(sources.lang, state.startedAt) };
  const stop = shouldStop(state, sources, learner, dag, opts);
  if (stop.stop) return undefined;
  const v = view(state, sources, learner, dag);
  if (stop.extraPhase) return extraItem(state, v, learner, sources);

  // Experienced fast lane: two correct leaf predicts under par in a row -> a completion on a leaf.
  const two = fastStreak(state, v, learner, PLACEMENT.fastLane - 1);
  if (two && !two.some((r) => r.kind === 'completion') && completionsServed(state) < PLACEMENT.completions) {
    const id = completionTargets(state, v, learner, sources, true)[0];
    if (id) return { kind: 'completion', conceptId: id, completion: completionFor(v.cands.get(id)!, state, sources)! };
  }

  if (predictPhaseOver(state, v, learner, sources.now)) {
    const id = completionTargets(state, v, learner, sources)[0];
    return id ? { kind: 'completion', conceptId: id, completion: completionFor(v.cands.get(id)!, state, sources)! } : undefined;
  }

  const open = v.probeable.filter((id) => !classified(state, learner, id));
  const last = state.items[state.items.length - 1]?.conceptId;
  const ranked = open
    .map((id) => ({ id, score: scoreIn(v.g, learner, state, id), imp: importanceIn(v.g, id) }))
    .sort((a, b) => b.score - a.score || b.imp - a.imp || (a.id < b.id ? -1 : 1));
  // Prefer not to ask the same concept twice in a row when another is close to it.
  const pick = ranked.find((r) => r.id !== last && r.score >= ranked[0].score - 1e-9) ?? ranked[0];
  if (!pick) return undefined;
  const p = probeFor(v.cands.get(pick.id)!, state, learner, sources)!;
  return { kind: 'predict', conceptId: pick.id, probe: p.probe, confounded: p.confounded || undefined };
}

/** Record what happened with an item (the typing item sets calibrated). Returns a new state. */
export function record(state: PlacementState, obs: PlacementObservation): PlacementState {
  if (obs.kind === 'typing') return { ...state, calibrated: true };
  const underPar = obs.correct === true && obs.latencyValid && obs.latencyMs !== undefined && obs.parSelfMs !== undefined && obs.latencyMs <= obs.parSelfMs;
  const rec: PlacementRecord = { ...obs, underPar, extra: !!obs.extra };
  return { ...state, items: [...state.items, rec], askedIds: state.askedIds.includes(obs.itemId) ? state.askedIds : [...state.askedIds, obs.itemId] };
}

export function escape(state: PlacementState): PlacementState {
  return { ...state, esc: true };
}

// ---------------------------------------------------------------- summary

export interface PlacementSummary {
  items: number;
  ms: number;
  solid: string[];
  newConcepts: string[];
  misconceptions: { conceptId: string; misconceptionId: string; belief: string; seen: number }[];
  /** 'Placement: 11 items, 2m10s. Solid: loops, lists. Possible misconception: alias-copy (seen once). New: dict iteration' */
  text: string;
  /** Status flash. */
  flash: string;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** One sidebar card's text and a status flash. Names default to the learner's concept names. */
export function summary(
  state: PlacementState, learner: Learner, opts: { now: number; names?: Record<string, string>; needed?: string[]; maxNames?: number },
): PlacementSummary {
  const name = (id: string) => opts.names?.[id] ?? learner.concepts[id]?.name ?? id;
  const max = opts.maxNames ?? 5;
  const graded = placementItems(state).concat(state.items.filter((r) => r.extra));
  const tested = [...new Set(graded.map((r) => resolveId(learner.concepts, r.conceptId) ?? r.conceptId))];
  const solid = tested.filter((id) => pOf(learner, id) >= 0.7).sort((a, b) => pOf(learner, b) - pOf(learner, a));
  // Inferred-supported ancestors count as solid too (a correct leaf supports them).
  for (const c of Object.values(learner.concepts)) if (c.inferred && c.mastery >= 0.7 && !solid.includes(c.id)) solid.push(c.id);
  const needed = (opts.needed ?? []).map((id) => resolveId(learner.concepts, id) ?? id);
  const newConcepts = [...new Set([...tested, ...needed])].filter((id) => pOf(learner, id) < 0.4 && !solid.includes(id));
  const seen = new Map<string, { conceptId: string; misconceptionId: string; n: number }>();
  for (const r of graded) {
    if (!r.misconceptionId) continue;
    const key = `${r.conceptId}\u0000${r.misconceptionId}`;
    const e = seen.get(key) ?? { conceptId: r.conceptId, misconceptionId: r.misconceptionId, n: 0 };
    e.n++;
    seen.set(key, e);
  }
  const misconceptions = [...seen.values()].map((e) => ({
    conceptId: e.conceptId, misconceptionId: e.misconceptionId, seen: e.n,
    belief: learner.concepts[e.conceptId]?.misconceptions?.[e.misconceptionId]?.belief ?? '',
  }));
  const ms = Math.max(0, (graded.length ? Math.max(...graded.map((r) => r.at)) : opts.now) - state.startedAt);
  const items = graded.length;
  const list = (ids: string[]) => ids.slice(0, max).map(name).join(', ') + (ids.length > max ? ', ...' : '');
  const parts = [`Placement: ${items} item${items === 1 ? '' : 's'}, ${formatDuration(ms)}.`];
  if (solid.length) parts.push(`Solid: ${list(solid)}.`);
  if (misconceptions.length) {
    parts.push(`Possible misconception${misconceptions.length > 1 ? 's' : ''}: ${misconceptions.slice(0, max).map((m) => `${name(m.conceptId)} (seen ${times(m.seen)})`).join(', ')}.`);
  }
  if (newConcepts.length) parts.push(`New: ${list(newConcepts)}.`);
  return { items, ms, solid, newConcepts, misconceptions, text: parts.join(' ').replace(/\.$/, ''), flash: `Placement done: ${items} items, ${formatDuration(ms)}` };
}
