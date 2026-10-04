// Sprint item selection and stop conditions (spec V1-9 (a), coreLoop 7). Pure: no vscode, no I/O.
// Selection order:
//   1. delayed misconception checks: items carrying a suppressed misconception's mutant whose check is
//      due, and different-group items for active ones
//   2. due mastery audits (a completion, 1+ day after mastery, inferred-mastered concepts first)
//   3. guess-flagged and fragile concepts
//   4. dueForReview
//   5. confirmation items for inferred concepts with single support
//   6. traceback items: 1 in every 5 items (multi-frame traces first)
//   7. which-pattern items from the Pattern Deck
// Never two consecutive items on the same concept; never an exact repeat within 7 days (fresh seed
// instances are used instead). A concept with a selectionGap gets which-pattern and contrast items
// rather than more predicts.

import type { Lang, PatternCard, StoredCompletion, StoredContrast, StoredProbe, TracebackItem } from '../contracts';
import { auditDue, resolveId } from '../evidence';
import type { ConceptState, Learner } from '../types';
import { shuffled as shuffle } from './rng';
import { REPEAT_WINDOW_MS, seenWithin7Days } from './seeds';
import { tagInfo, tagsFor, TAXONOMY } from './tags';
import { frameCount } from './traceback';

export const SPRINT = {
  budgetMs: 90_000,
  maxItems: 6,
  /** After 'until' settles, the current item may run this much longer. */
  untilGraceMs: 15_000,
  tracebackEvery: 5,
  whichPatternOptions: 4,
} as const;

export interface SprintStock {
  probes?: StoredProbe[];
  completions?: StoredCompletion[];
  contrasts?: StoredContrast[];
  tracebacks?: TracebackItem[];
}

export type SprintReason = 'delayed-check' | 'audit' | 'guess' | 'fragile' | 'due' | 'confirm-inferred' | 'traceback' | 'which-pattern';

export type SprintPick =
  | { kind: 'predict'; conceptId: string; reason: SprintReason; probe: StoredProbe; /** Evidence.delayedCheckFor. */ delayedCheckFor?: string }
  | { kind: 'completion'; conceptId: string; reason: SprintReason; completion: StoredCompletion; /** Record with source 'audit'. */ audit: boolean }
  | { kind: 'contrast'; conceptId: string; reason: SprintReason; contrast: StoredContrast }
  | { kind: 'traceback'; conceptId: string; reason: 'traceback'; item: TracebackItem }
  | {
      kind: 'which-pattern'; conceptId: string; reason: SprintReason; card: PatternCard; useCase: string;
      /** 4 deck names, shuffled. */
      options: string[];
      /** 0-based index of the right name. */
      correct: number;
    };

export interface SprintContext {
  now: number;
  lang: Lang;
  learner: Learner;
  /** Items in stock by concept id (or cache key / alias; resolved through the learner's aliases). */
  stock: Record<string, SprintStock>;
  /** Concepts with a guess-flagged correct answer this session (one interleaved item each). */
  guessFlagged?: readonly string[];
  /** Pattern Deck (default learner.patternDeck). */
  deck?: readonly PatternCard[];
  rng?: () => number;
}

export interface SprintPickRecord {
  conceptId: string;
  itemId: string;
  kind: SprintPick['kind'];
  reason: SprintReason;
  at: number;
  /** The misconception a delayed check was for (each is checked at most once per sprint). */
  delayedCheckFor?: string;
}

export interface SprintState {
  startedAt: number;
  picks: SprintPickRecord[];
}

export function newSprint(now: number): SprintState {
  return { startedAt: now, picks: [] };
}

/** The id that identifies an exact item (which-pattern: card + use case). */
export function sprintItemId(p: SprintPick): string {
  switch (p.kind) {
    case 'predict':
      return p.probe.id;
    case 'completion':
      return p.completion.id;
    case 'contrast':
      return p.contrast.id;
    case 'traceback':
      return p.item.id;
    case 'which-pattern':
      return `${p.card.conceptId}::${p.useCase}`;
  }
}

export function recordSprintPick(state: SprintState, pick: SprintPick, at: number): SprintState {
  const rec: SprintPickRecord = { conceptId: pick.conceptId, itemId: sprintItemId(pick), kind: pick.kind, reason: pick.reason, at };
  if (pick.kind === 'predict' && pick.delayedCheckFor) rec.delayedCheckFor = pick.delayedCheckFor;
  return { ...state, picks: [...state.picks, rec] };
}

// ---------------------------------------------------------------- selection

interface Sel {
  ctx: SprintContext;
  state: SprintState;
  last?: string;
  used: Set<string>;
  /** Concepts already practised in this sprint: tiers 2-5 move on to others (their state just changed). */
  picked: Set<string>;
  /** Misconceptions already delayed-checked in this sprint. */
  checked: Set<string>;
  stock: Map<string, Required<SprintStock>>;
  rng: () => number;
}


function mergeStock(ctx: SprintContext): Map<string, Required<SprintStock>> {
  const out = new Map<string, Required<SprintStock>>();
  for (const [key, s] of Object.entries(ctx.stock)) {
    const id = resolveId(ctx.learner.concepts, key) ?? key;
    const cur = out.get(id) ?? { probes: [], completions: [], contrasts: [], tracebacks: [] };
    out.set(id, {
      probes: [...cur.probes, ...(s.probes ?? [])],
      completions: [...cur.completions, ...(s.completions ?? [])],
      contrasts: [...cur.contrasts, ...(s.contrasts ?? [])],
      tracebacks: [...cur.tracebacks, ...(s.tracebacks ?? [])],
    });
  }
  return out;
}

const byUse = <T extends { stats: { n: number }; id: string }>(a: T, b: T) => a.stats.n - b.stats.n || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function freshProbes(sel: Sel, id: string, filter: (p: StoredProbe) => boolean = () => true): StoredProbe[] {
  return (sel.stock.get(id)?.probes ?? []).filter((p) => !sel.used.has(p.id) && !seenWithin7Days(p.stats, sel.ctx.now) && filter(p)).sort(byUse);
}

function freshCompletions(sel: Sel, id: string): StoredCompletion[] {
  return (sel.stock.get(id)?.completions ?? []).filter((c) => !sel.used.has(c.id) && !seenWithin7Days(c.stats, sel.ctx.now)).sort(byUse);
}

function freshContrasts(sel: Sel, id: string): StoredContrast[] {
  return (sel.stock.get(id)?.contrasts ?? []).filter((c) => !sel.used.has(c.id));
}

const carries = (p: StoredProbe, mid: string) => p.mutants.some((m) => m.misconceptionId === mid && !m.ambiguous);

/** Tier 1: delayed misconception checks, most overdue first. */
function delayedChecks(sel: Sel): SprintPick | undefined {
  const due: { c: ConceptState; mid: string; at: number; active: boolean; groups: string[] }[] = [];
  for (const c of Object.values(sel.ctx.learner.concepts)) {
    for (const [mid, m] of Object.entries(c.misconceptions ?? {})) {
      const at = m.nextCheckAt ?? 0;
      if (at > sel.ctx.now || sel.checked.has(`${c.id}\u0000${mid}`)) continue;
      if (m.status === 'suppressed' || m.status === 'active') due.push({ c, mid, at, active: m.status === 'active', groups: m.groups });
    }
  }
  due.sort((a, b) => a.at - b.at || Number(a.active) - Number(b.active));
  for (const d of due) {
    if (d.c.id === sel.last) continue;
    const probe = freshProbes(sel, d.c.id, (p) => carries(p, d.mid) && (!d.active || !d.groups.includes(p.group)))[0];
    if (probe) return { kind: 'predict', conceptId: d.c.id, reason: 'delayed-check', probe, delayedCheckFor: d.mid };
  }
  return undefined;
}

/** Tier 2: due mastery audits (inferred-mastered concepts first). */
function audits(sel: Sel): SprintPick | undefined {
  for (const c of auditDue(sel.ctx.learner.concepts, sel.ctx.now, sel.rng)) {
    if (c.id === sel.last || sel.picked.has(c.id)) continue;
    const completion = freshCompletions(sel, c.id)[0];
    if (completion) return { kind: 'completion', conceptId: c.id, reason: 'audit', completion, audit: true };
  }
  return undefined;
}

/** An item for a concept: which-pattern / contrast first under a selectionGap, else a predict, else a completion. */
function itemFor(sel: Sel, c: ConceptState, reason: SprintReason): SprintPick | undefined {
  if (c.id === sel.last) return undefined;
  if (c.selectionGap) {
    const wp = whichPatternFor(sel, c.id, reason);
    if (wp) return wp;
    const contrast = freshContrasts(sel, c.id)[0];
    if (contrast) return { kind: 'contrast', conceptId: c.id, reason, contrast };
  }
  // A fresh surface: groups the learner has not answered right yet come first.
  const probes = freshProbes(sel, c.id);
  const probe = probes.find((p) => !c.groupsCorrect.includes(p.group)) ?? probes[0];
  if (probe) return { kind: 'predict', conceptId: c.id, reason, probe };
  const completion = freshCompletions(sel, c.id)[0];
  if (completion) return { kind: 'completion', conceptId: c.id, reason, completion, audit: false };
  return undefined;
}

function firstOf(sel: Sel, cs: ConceptState[], reason: SprintReason): SprintPick | undefined {
  for (const c of cs) {
    if (sel.picked.has(c.id)) continue;
    const p = itemFor(sel, c, reason);
    if (p) return p;
  }
  return undefined;
}

function concept(sel: Sel, id: string): ConceptState | undefined {
  const key = resolveId(sel.ctx.learner.concepts, id);
  return key ? sel.ctx.learner.concepts[key] : undefined;
}

/** Tier 3: guess-flagged, then fragile concepts. */
function guessAndFragile(sel: Sel): SprintPick | undefined {
  const guessed = [...new Set((sel.ctx.guessFlagged ?? []).map((id) => concept(sel, id)).filter((c): c is ConceptState => !!c))];
  const g = firstOf(sel, guessed, 'guess');
  if (g) return g;
  const fragile = Object.values(sel.ctx.learner.concepts).filter((c) => c.fragile).sort((a, b) => (a.fragileSince ?? 0) - (b.fragileSince ?? 0));
  return firstOf(sel, fragile, 'fragile');
}

/** Tier 4: concepts due for review, most overdue first. */
function dueReviews(sel: Sel): SprintPick | undefined {
  const now = sel.ctx.now;
  const due = Object.values(sel.ctx.learner.concepts).filter((c) => c.nextReview > 0 && c.nextReview <= now).sort((a, b) => a.nextReview - b.nextReview);
  return firstOf(sel, due, 'due');
}

/** Tier 5: inferred concepts supported by a single descendant (never tested themselves). */
function confirmInferred(sel: Sel): SprintPick | undefined {
  const single = Object.values(sel.ctx.learner.concepts).filter((c) => !c.tested && c.supportFrom.length === 1);
  return firstOf(sel, single, 'confirm-inferred');
}

/** Tier 6: a traceback item, multi-frame traces through a helper function first. */
function tracebackPick(sel: Sel): SprintPick | undefined {
  const all: { id: string; item: TracebackItem; multi: boolean; key: number }[] = [];
  for (const [id, s] of sel.stock) {
    if (id === sel.last) continue;
    for (const item of s.tracebacks) {
      if (sel.used.has(item.id)) continue;
      all.push({ id, item, multi: frameCount(item) >= 2, key: sel.rng() });
    }
  }
  all.sort((a, b) => Number(b.multi) - Number(a.multi) || a.key - b.key);
  const t = all[0];
  return t ? { kind: 'traceback', conceptId: t.id, reason: 'traceback', item: t.item } : undefined;
}

function seenRecently(card: PatternCard, useCase: string, now: number): boolean {
  const t = card.useCaseSeenAt?.[useCase];
  return t !== undefined && t <= now && now - t < REPEAT_WINDOW_MS;
}

function deckOf(sel: Sel): readonly PatternCard[] {
  return sel.ctx.deck ?? sel.ctx.learner.patternDeck ?? [];
}

/** Are these two tags valid alternatives of each other (never a distractor pair)? */
function alternatives(a: string, b: string): boolean {
  return a === b || !!tagInfo(a)?.alternatives.includes(b) || !!tagInfo(b)?.alternatives.includes(a);
}

/**
 * A which-pattern item: one of the card's use cases not seen in 7 days, and 4 deck names whose 3
 * distractors come from tags that are not valid alternatives of the right one (topped up from the
 * taxonomy's pattern names for the language when the deck is small).
 */
function whichPatternFor(sel: Sel, conceptId: string, reason: SprintReason, cardIn?: PatternCard): SprintPick | undefined {
  const deck = deckOf(sel);
  const card = cardIn ?? deck.find((c) => (resolveId(sel.ctx.learner.concepts, c.conceptId) ?? c.conceptId) === conceptId);
  if (!card) return undefined;
  const cases = (card.useCases ?? []).filter((u) => u.trim() && !seenRecently(card, u, sel.ctx.now) && !sel.used.has(`${card.conceptId}::${u}`));
  if (!cases.length) return undefined;
  const useCase = cases[Math.floor(sel.rng() * cases.length)];
  const names: string[] = [];
  const ok = (tag: string, name: string) => !alternatives(card.tag, tag) && name !== card.name && !names.includes(name) && name.trim();
  for (const other of shuffle(deck, sel.rng)) {
    if (names.length >= SPRINT.whichPatternOptions - 1) break;
    if (ok(other.tag, other.name)) names.push(other.name);
  }
  if (names.length < SPRINT.whichPatternOptions - 1) {
    for (const tag of shuffle(tagsFor(sel.ctx.lang), sel.rng)) {
      if (names.length >= SPRINT.whichPatternOptions - 1) break;
      const name = TAXONOMY[tag].patternName;
      if (ok(tag, name)) names.push(name);
    }
  }
  if (names.length < SPRINT.whichPatternOptions - 1) return undefined;
  const options = shuffle([card.name, ...names], sel.rng);
  return { kind: 'which-pattern', conceptId, reason, card, useCase, options, correct: options.indexOf(card.name) };
}

/** Tier 7: deck cards, selectionGap concepts first, then the least recently practised. */
function whichPattern(sel: Sel): SprintPick | undefined {
  const deck = deckOf(sel);
  const lastSeen = (c: PatternCard) => Math.max(0, ...Object.values(c.useCaseSeenAt ?? {}));
  const order = deck
    .map((card) => ({ card, id: resolveId(sel.ctx.learner.concepts, card.conceptId) ?? card.conceptId, key: sel.rng() }))
    .filter((x) => x.id !== sel.last)
    .sort((a, b) =>
      Number(!!concept(sel, b.id)?.selectionGap) - Number(!!concept(sel, a.id)?.selectionGap) ||
      Number(sel.picked.has(a.id)) - Number(sel.picked.has(b.id)) ||
      lastSeen(a.card) - lastSeen(b.card) || a.key - b.key);
  for (const x of order) {
    const p = whichPatternFor(sel, x.id, 'which-pattern', x.card);
    if (p) return p;
  }
  return undefined;
}

/**
 * The next sprint item, or undefined when nothing fits (the sprint then ends). Every 5th item is a
 * traceback item when one is in stock; otherwise tiers 1-5, then which-pattern.
 */
export function nextSprintItem(state: SprintState, ctx: SprintContext): SprintPick | undefined {
  const lastPick = state.picks[state.picks.length - 1];
  const resolve = (id: string) => resolveId(ctx.learner.concepts, id) ?? id;
  const sel: Sel = {
    ctx, state, used: new Set(state.picks.map((p) => p.itemId)), stock: mergeStock(ctx), rng: ctx.rng ?? Math.random,
    last: lastPick ? resolve(lastPick.conceptId) : undefined,
    picked: new Set(state.picks.map((p) => resolve(p.conceptId))),
    checked: new Set(state.picks.flatMap((p) => (p.delayedCheckFor ? [`${resolve(p.conceptId)}\u0000${p.delayedCheckFor}`] : []))),
  };
  if ((state.picks.length + 1) % SPRINT.tracebackEvery === 0) {
    const tb = tracebackPick(sel);
    if (tb) return tb;
  }
  return delayedChecks(sel) ?? audits(sel) ?? guessAndFragile(sel) ?? dueReviews(sel) ?? confirmInferred(sel) ?? whichPattern(sel);
}

// ---------------------------------------------------------------- stop

export interface SprintStopInput {
  now: number;
  budgetMs?: number;
  maxItems?: number;
  esc?: boolean;
  /** When the awaited job ('until') settled. */
  untilSettledAt?: number;
  /** An item is open (rendered, not yet answered). */
  itemOpen?: boolean;
}

export interface SprintStop {
  stop: boolean;
  reason?: 'esc' | 'until' | 'budget' | 'max-items';
  /** Close the open item now instead of letting it finish. */
  abandonCurrent?: boolean;
}

/**
 * Esc stops at once. 'until' settling, the budget or maxItems end the sprint after the current item;
 * an item still open 15 s after 'until' settled is abandoned.
 */
export function sprintShouldStop(state: SprintState, input: SprintStopInput): SprintStop {
  if (input.esc) return { stop: true, reason: 'esc', abandonCurrent: true };
  if (input.untilSettledAt !== undefined && input.untilSettledAt <= input.now) {
    const late = input.now - input.untilSettledAt >= SPRINT.untilGraceMs;
    if (!input.itemOpen || late) return { stop: true, reason: 'until', abandonCurrent: !!input.itemOpen };
    return { stop: false };
  }
  if (input.itemOpen) return { stop: false };
  if (input.now - state.startedAt >= (input.budgetMs ?? SPRINT.budgetMs)) return { stop: true, reason: 'budget' };
  if (state.picks.length >= (input.maxItems ?? SPRINT.maxItems)) return { stop: true, reason: 'max-items' };
  return { stop: false };
}
