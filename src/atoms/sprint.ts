// Sprints (spec V1-9 (a) SPRINT ENGINE, (g) the 3-minute sprint command, (i) traceback items).
// Selection and the stop conditions are src/atoms/sprintSelect.ts (pure); this module runs them:
// - predict, completion, contrast and traceback items in the pad under generic headers, which-pattern
//   items in a QuickPick of 4 deck names (the use case is the question; distractors never come from
//   valid alternatives);
// - evidence source 'sprint' ('audit' for mastery audits), with delayedCheckFor on delayed
//   misconception checks and avoidedMisconceptionIds on every correct item that carried mutants;
//   a mutant match is an unconfirmed candidate (no belief check inside a sprint);
// - selectionGap: a concept answered right in an atom but wrong here gets which-pattern and contrast
//   items next time (cleared by a right selection item);
// - stops when 'until' settles (after the current item, at most 15 s more), when the budget or
//   maxItems is spent, on double Esc (or Esc on a QuickPick), Leave practice, or when nothing is left;
// - score: correct items per par-normalised minute, against the personal best (3-minute sprints).
// The concept is named only in the result card. No vscode import.

import type { Lang, PatternCard } from '../contracts';
import { touch } from '../evidence';
import { concept } from '../learner';
import type { ConceptState, Learner } from '../types';
import type { AtomCache } from './cache';
import {
  askCompletion, askContrast, askPredict, askTraceback, completionEvidence, completionFeedback, ensureConcept, isStopped, itemPar,
  learnerSpeed, PAD, predictEvidence, predictFeedback, tracebackEvidence, tracebackFeedback, type AtomPad, type Disposable,
  type FlowStop, type ItemContext, type PadSession,
} from './pad';
import { formatDuration } from './placement';
import {
  newSprint, nextSprintItem, recordSprintPick, SPRINT, sprintItemId, sprintShouldStop, type SprintContext, type SprintPick,
  type SprintState, type SprintStock,
} from './sprintSelect';
import { TRACEBACK_TAG, type KeyStock } from './stock';
import { TAXONOMY } from './tags';

/** One 'standard' item takes this long at par: score = correct items per minute of such items. */
export const SPRINT_SCORE_REF_MS = 10_000;
/** One item counts at most this many par units (a distraction never ruins the whole score). */
const MAX_PAR_UNITS = 4;

export type SprintReasonKind = 'wait' | 'warmup' | 'sprint' | 'due';

export interface SprintOptions {
  /** Default 90 s (the 3-minute sprint command passes 180 000). */
  budgetMs?: number;
  /** The job the sprint fills the wait for: the sprint ends after the current item once it settles. */
  until?: Promise<unknown>;
  /** Default 6. */
  maxItems?: number;
  reason: SprintReasonKind;
  /** Leave the pad open afterwards (the atom the wait was for starts at once). */
  keepOpen?: boolean;
}

export type SprintStop = 'esc' | 'until' | 'budget' | 'max-items' | 'empty' | 'aborted' | 'idle';

export interface SprintResult {
  items: number;
  correct: number;
  ms: number;
  auditsRun: number;
  delayedChecks: number;
  /** Correct items per par-normalised minute (SPRINT_SCORE_REF_MS per item at par). */
  score: number;
  /** The personal best before this sprint (3-minute sprints only). */
  best?: number;
  newBest: boolean;
  stopReason: SprintStop;
  /** Concepts practised, in order. */
  conceptIds: string[];
}

/** What sprints need from src/atoms/stock.ts (a Stock satisfies it). */
export interface SprintStockSource {
  readonly lang: Lang;
  readonly cache: AtomCache;
  stockFor(key: string): KeyStock | undefined;
  deck(learner: Learner): PatternCard[];
  refillIfLow?(key: string): unknown;
}

export interface SprintDeps {
  pad: AtomPad;
  stock: SprintStockSource;
  /** Personal best of the 3-minute sprint (e.g. globalState). */
  best?: { get(): number | undefined; set(score: number): void };
  /** Was the concept answered right in an atom (selectionGap)? Default: an atom passed this session, or a right group. */
  answeredInAtom?: (conceptId: string) => boolean;
  rng?: () => number;
}

interface ItemSource {
  key: string;
  tag: string;
  verified: boolean;
}

interface ItemOutcome {
  /** Graded (counts as an item). */
  graded: boolean;
  correct: boolean | null;
  elapsedMs: number;
  parAbsMs: number;
  stop?: SprintStop;
}

const UNTIL = Symbol('until');

/** Correct items per par-normalised minute. */
export function sprintScore(items: readonly { correct: boolean | null; elapsedMs: number; parAbsMs: number }[]): number {
  const units = items.reduce((u, it) => u + Math.min(MAX_PAR_UNITS, Math.max(0, it.elapsedMs) / Math.max(1, it.parAbsMs)), 0);
  if (units <= 0) return 0;
  const correct = items.filter((i) => i.correct === true).length;
  return Math.round((correct / ((units * SPRINT_SCORE_REF_MS) / 60_000)) * 10) / 10;
}

export class Sprint {
  /** Leave practice / tab closed ('esc'), or the InteractionLock's abort ('aborted'). */
  private stopRequest: 'esc' | 'aborted' | undefined;
  private untilSettledAt: number | undefined;
  private readonly onSettle = new Set<() => void>();
  private readonly sources = new Map<string, ItemSource>();
  private pickAbort: AbortController | undefined;
  private started = false;

  constructor(private readonly deps: SprintDeps) {}

  private get pad(): AtomPad {
    return this.deps.pad;
  }

  /** How many items a sprint could serve right now (up to max), without showing anything. */
  available(max = 2): number {
    const learner = this.pad.learner();
    const now = this.pad.now();
    const ctx = this.selection(learner, now);
    let st = newSprint(now);
    let n = 0;
    while (n < max) {
      const p = nextSprintItem(st, ctx);
      if (!p) break;
      st = recordSprintPick(st, p, now);
      n++;
    }
    return n;
  }

  async run(opts: SprintOptions): Promise<SprintResult> {
    if (this.started) throw new Error('Sprint.run: a Sprint runs once');
    this.started = true;
    const pad = this.pad;
    const budgetMs = opts.budgetMs ?? SPRINT.budgetMs;
    const maxItems = opts.maxItems ?? SPRINT.maxItems;
    const start = pad.now();
    const end = pad.beginFlow(opts.reason === 'warmup' ? 'warmup' : 'sprint', (reason) => {
      if (reason === 'external') this.stopRequest = 'aborted';
      else this.stopRequest ??= 'esc';
      this.pickAbort?.abort();
    });
    const settle = () => {
      if (this.untilSettledAt !== undefined) return;
      this.untilSettledAt = pad.now();
      for (const f of [...this.onSettle]) f();
      if (pad.session?.waiting) pad.session.post({ type: 'event', at: pad.now(), event: UNTIL });
    };
    opts.until?.then(settle, settle);
    this.deps.stock.refillIfLow?.(TRACEBACK_TAG);

    let st: SprintState = newSprint(start);
    const done: { correct: boolean | null; elapsedMs: number; parAbsMs: number }[] = [];
    const practised: { conceptId: string; correct: boolean | null }[] = [];
    let auditsRun = 0;
    let delayedChecks = 0;
    let stopReason: SprintStop = 'empty';
    try {
      // A job that had already landed settles within these ticks: then no item is shown at all.
      if (opts.until) for (let i = 0; i < 3; i++) await Promise.resolve();
      for (;;) {
        if (this.stopRequest) {
          stopReason = this.stopRequest;
          break;
        }
        const now = pad.now();
        const stop = sprintShouldStop(st, { now, budgetMs, maxItems, untilSettledAt: this.untilSettledAt, itemOpen: false });
        if (stop.stop) {
          stopReason = stop.reason ?? 'budget';
          break;
        }
        const learner = pad.learner();
        const p = nextSprintItem(st, this.selection(learner, now));
        if (!p) {
          stopReason = 'empty';
          this.refillLow();
          break;
        }
        st = recordSprintPick(st, p, now);
        const out = await this.runItem(p, learner);
        if (out.graded) {
          done.push({ correct: out.correct, elapsedMs: out.elapsedMs, parAbsMs: out.parAbsMs });
          practised.push({ conceptId: p.conceptId, correct: out.correct });
          if (p.kind === 'completion' && p.audit) auditsRun++;
          if (p.kind === 'predict' && p.delayedCheckFor) delayedChecks++;
        }
        if (out.stop) {
          stopReason = this.stopRequest ?? out.stop;
          break;
        }
      }
      return await this.finish(opts, start, done, practised, auditsRun, delayedChecks, stopReason);
    } catch (err) {
      await pad.closeSession().catch(() => undefined);
      throw err;
    } finally {
      this.onSettle.clear();
      end();
    }
  }

  // ------------------------------------------------------------ selection

  private selection(learner: Learner, now: number): SprintContext {
    const ctx: SprintContext = {
      now, lang: this.deps.stock.lang, learner, stock: this.stockMap(), guessFlagged: [...this.pad.guessFlagged],
      deck: this.deps.stock.deck(learner),
    };
    if (this.deps.rng) ctx.rng = this.deps.rng;
    return ctx;
  }

  /** Unseen items of every cache key (unverified atoms without mutants; no completions without a runner). */
  private stockMap(): Record<string, SprintStock> {
    const out: Record<string, SprintStock> = {};
    const canRun = !!this.pad.runnerFor(this.deps.stock.lang);
    for (const key of this.deps.stock.cache.keys()) {
      const st = this.deps.stock.stockFor(key);
      if (!st) continue;
      const src: ItemSource = { key, tag: st.tag, verified: st.verified };
      for (const it of [...st.probes, ...st.completions, ...st.contrasts, ...st.tracebacks]) this.sources.set(it.id, src);
      out[key] = { probes: st.probes, completions: canRun ? st.completions : [], contrasts: st.contrasts, tracebacks: st.tracebacks };
    }
    return out;
  }

  private refillLow(): void {
    const refill = this.deps.stock.refillIfLow;
    if (!refill) return;
    for (const key of this.deps.stock.cache.keys()) if (this.deps.stock.cache.lowStock(key)) refill.call(this.deps.stock, key);
  }

  // ------------------------------------------------------------ items

  private deadline(session: PadSession): () => number {
    return () => Math.min(session.shownAt + PAD.idleMs, this.untilSettledAt !== undefined ? this.untilSettledAt + SPRINT.untilGraceMs : Infinity);
  }

  private context(session: PadSession, learner: Learner): ItemContext {
    // When the awaited job lands, the open item may still be answered for 15 s: the deadline moves.
    return { lang: this.deps.stock.lang, keyUse: learner.keyUse, speed: learnerSpeed(learner), deadline: this.deadline(session) };
  }

  /** Why an item stopped, in sprint terms. */
  private stopOf(stop: FlowStop): SprintStop {
    if (this.stopRequest) return this.stopRequest;
    if (stop === 'abort') return 'aborted';
    if (stop === 'esc') return 'esc';
    if (this.untilSettledAt !== undefined && this.pad.now() >= this.untilSettledAt + SPRINT.untilGraceMs) return 'until';
    return 'idle';
  }

  /** An item went on screen: mark it seen (the 7-day rule) and let the stock top the key up. */
  private shown(key: string, itemId: string): void {
    this.deps.stock.cache.markSeen(key, itemId, this.pad.now());
    this.deps.stock.refillIfLow?.(key);
  }

  private async session(): Promise<PadSession> {
    return this.pad.openSession(this.deps.stock.lang);
  }

  private runItem(p: SprintPick, learner: Learner): Promise<ItemOutcome> {
    switch (p.kind) {
      case 'predict':
        return this.predict(p, learner);
      case 'completion':
        return this.completion(p, learner);
      case 'contrast':
        return this.contrast(p, learner);
      case 'traceback':
        return this.traceback(p, learner);
      case 'which-pattern':
        return this.whichPattern(p, learner);
    }
  }

  private conceptOf(learner: Learner, id: string): ConceptState | undefined {
    return concept(learner, id);
  }

  /** A guess-flagged concept got its one interleaved item; a new guess-flagged right answer adds one. */
  private trackGuess(conceptId: string, correct: boolean | null, guess: boolean): void {
    this.pad.guessFlagged.delete(conceptId);
    if (correct === true && guess) this.pad.guessFlagged.add(conceptId);
  }

  /** Right in an atom, wrong when interleaved: a selection gap (which-pattern and contrast items next). */
  private markSelectionGap(learner: Learner, conceptId: string, correct: boolean | null): void {
    if (correct !== false) return;
    const c = this.conceptOf(learner, conceptId);
    if (!c || c.selectionGap) return;
    const inAtom = this.deps.answeredInAtom ? this.deps.answeredInAtom(c.id) : this.pad.atomPassed.has(c.id) || (c.tested && c.groupsCorrect.length > 0);
    if (!inAtom) return;
    c.selectionGap = true;
    touch(c, this.pad.now());
  }

  private clearSelectionGap(learner: Learner, conceptId: string): void {
    const c = this.conceptOf(learner, conceptId);
    if (!c?.selectionGap) return;
    c.selectionGap = undefined;
    touch(c, this.pad.now());
  }

  private async predict(p: Extract<SprintPick, { kind: 'predict' }>, learner: Learner): Promise<ItemOutcome> {
    const session = await this.session();
    const src = this.sources.get(p.probe.id);
    const cache = this.deps.stock.cache;
    if (src) this.shown(src.key, p.probe.id);
    const o = await askPredict(session, p.probe, { ...this.context(session, learner), typeSensitive: !!TAXONOMY[src?.tag ?? '']?.typeSensitive });
    if (isStopped(o)) return { graded: false, correct: null, elapsedMs: 0, parAbsMs: 1, stop: this.stopOf(o.stop) };
    const g = o.grade;
    const ev = predictEvidence(p.probe, o, { conceptId: p.conceptId, source: 'sprint', delayedCheckFor: p.delayedCheckFor, unverified: src ? !src.verified : false });
    if (ev) this.pad.deps.recordEvidence(ev);
    if (src && g.verdict !== 'format-only') cache.recordItemStat(src.key, p.probe.id, g.correct === true, o.latencyMs);
    if (src && g.mutant) cache.recordMutantResponse(src.key, g.mutant.id, 'match');
    session.feedback(predictFeedback(o));
    const correct = g.verdict === 'format-only' ? null : g.correct ?? null;
    this.trackGuess(p.conceptId, correct, o.guess);
    this.markSelectionGap(learner, p.conceptId, correct);
    return { graded: g.verdict !== 'format-only', correct, elapsedMs: o.latencyMs, parAbsMs: o.par.abs };
  }

  private async completion(p: Extract<SprintPick, { kind: 'completion' }>, learner: Learner): Promise<ItemOutcome> {
    const runner = this.pad.runnerFor(this.deps.stock.lang);
    if (!runner) return { graded: false, correct: null, elapsedMs: 0, parAbsMs: 1 };
    const session = await this.session();
    const src = this.sources.get(p.completion.id);
    const cache = this.deps.stock.cache;
    if (src) this.shown(src.key, p.completion.id);
    const o = await askCompletion(session, p.completion, runner, { ...this.context(session, learner), allowImports: TAXONOMY[src?.tag ?? '']?.allowedImports });
    if (isStopped(o)) return { graded: false, correct: null, elapsedMs: 0, parAbsMs: 1, stop: this.stopOf(o.stop) };
    if ('error' in o) return { graded: false, correct: null, elapsedMs: 0, parAbsMs: 1 };
    this.pad.deps.recordEvidence(completionEvidence(p.completion, o, { conceptId: p.conceptId, source: p.audit ? 'audit' : 'sprint', unverified: src ? !src.verified : false }));
    if (src) cache.recordItemStat(src.key, p.completion.id, o.grade.pass, o.latencyMs);
    completionFeedback(session, o);
    this.trackGuess(p.conceptId, o.grade.pass, o.guess);
    this.markSelectionGap(learner, p.conceptId, o.grade.pass);
    return { graded: true, correct: o.grade.pass, elapsedMs: o.latencyMs, parAbsMs: o.par.abs };
  }

  private async contrast(p: Extract<SprintPick, { kind: 'contrast' }>, learner: Learner): Promise<ItemOutcome> {
    const session = await this.session();
    const src = this.sources.get(p.contrast.id);
    if (src) this.shown(src.key, p.contrast.id);
    const o = await askContrast(session, p.contrast, this.context(session, learner));
    if (isStopped(o)) return { graded: false, correct: null, elapsedMs: 0, parAbsMs: 1, stop: this.stopOf(o.stop) };
    this.pad.deps.recordEvidence({
      conceptId: p.conceptId, kind: 'contrast-pick', source: 'sprint', at: o.at, itemId: p.contrast.id, correct: o.correct,
      verdict: o.correct ? 'correct' : 'wrong', guessFlag: false, latencyMs: o.latencyMs, latencyValid: o.latencyValid,
      parSelfMs: o.par.self, parAbsMs: o.par.abs,
    });
    session.feedback(o.correct ? { kind: 'correct', ms: o.latencyMs } : { kind: 'note', text: `it was ${o.right}` });
    if (o.correct) this.clearSelectionGap(learner, p.conceptId);
    this.trackGuess(p.conceptId, o.correct, false);
    return { graded: true, correct: o.correct, elapsedMs: o.latencyMs, parAbsMs: o.par.abs };
  }

  private async traceback(p: Extract<SprintPick, { kind: 'traceback' }>, learner: Learner): Promise<ItemOutcome> {
    const session = await this.session();
    const src = this.sources.get(p.item.id);
    if (src) this.shown(src.key, p.item.id);
    const tag = TRACEBACK_TAG;
    const c = this.conceptOf(learner, p.conceptId) ?? ensureConcept(learner, p.item.conceptId || tag, tag, TAXONOMY[tag]?.patternName ?? tag, this.pad.now());
    const o = await askTraceback(session, p.item, this.context(session, learner));
    if (isStopped(o)) return { graded: false, correct: null, elapsedMs: 0, parAbsMs: 1, stop: this.stopOf(o.stop) };
    this.pad.deps.recordEvidence(tracebackEvidence(p.item, o, { conceptId: c.id, source: 'sprint' }));
    session.feedback(tracebackFeedback(p.item, o));
    const correct = o.dontKnow ? null : o.grade.correct;
    return { graded: true, correct, elapsedMs: o.latencyMs, parAbsMs: o.par.abs };
  }

  /** A QuickPick: the use case is the question, 4 deck names the options. */
  private async whichPattern(p: Extract<SprintPick, { kind: 'which-pattern' }>, learner: Learner): Promise<ItemOutcome> {
    const pad = this.pad;
    const lat = pad.latencyClock();
    const ac = new AbortController();
    this.pickAbort = ac;
    const timers: Disposable[] = [];
    let why: SprintStop | undefined;
    const stopAfter = (ms: number, reason: SprintStop) => timers.push(pad.clock.timer(Math.max(0, ms), () => {
      why ??= reason;
      ac.abort();
    }));
    stopAfter(PAD.idleMs, 'idle');
    const armUntil = () => stopAfter(this.untilSettledAt! + SPRINT.untilGraceMs - pad.now(), 'until');
    if (this.untilSettledAt !== undefined) armUntil();
    else this.onSettle.add(armUntil);
    let choice: number | undefined;
    try {
      choice = await pad.deps.ui.pickOne({
        title: `Which pattern fits: ${p.useCase}`, placeholder: 'Pick the pattern (Esc ends the sprint)', items: p.options, signal: ac.signal,
      });
    } finally {
      this.onSettle.delete(armUntil);
      for (const t of timers) t.dispose();
      this.pickAbort = undefined;
      lat.done();
    }
    const at = pad.now();
    const latency = lat.read();
    const par = itemPar('which-pattern', [p.useCase, ...p.options].join('\n'), 1, 5, learnerSpeed(learner));
    if (choice === undefined || choice < 0 || choice >= p.options.length) {
      return { graded: false, correct: null, elapsedMs: 0, parAbsMs: 1, stop: this.stopRequest ?? why ?? 'esc' };
    }
    const correct = choice === p.correct;
    pad.deps.recordEvidence({
      conceptId: p.conceptId, kind: 'which-pattern', source: 'sprint', at, itemId: sprintItemId(p), correct, verdict: correct ? 'correct' : 'wrong',
      guessFlag: false, latencyMs: latency.ms, latencyValid: latency.valid, parSelfMs: par.self, parAbsMs: par.abs,
    });
    const card = (learner.patternDeck ?? []).find((c) => c.conceptId === p.card.conceptId);
    if (card) card.useCaseSeenAt = { ...(card.useCaseSeenAt ?? {}), [p.useCase]: at };
    pad.deps.ui.flash(correct ? `ok · ${p.card.name}` : `it was: ${p.card.name}`, correct ? PAD.hold.correct : PAD.hold.other);
    if (correct) this.clearSelectionGap(learner, p.conceptId);
    this.trackGuess(p.conceptId, correct, false);
    return { graded: true, correct, elapsedMs: latency.ms, parAbsMs: par.abs };
  }

  // ------------------------------------------------------------ finish

  private async finish(
    opts: SprintOptions, start: number, done: { correct: boolean | null; elapsedMs: number; parAbsMs: number }[],
    practised: { conceptId: string; correct: boolean | null }[], auditsRun: number, delayedChecks: number, stopReason: SprintStop,
  ): Promise<SprintResult> {
    const pad = this.pad;
    const aborted = stopReason === 'aborted';
    if (!opts.keepOpen || aborted) await pad.closeSession();
    else await pad.session?.hold();
    const now = pad.now();
    const items = done.length;
    const correct = done.filter((d) => d.correct === true).length;
    const score = sprintScore(done);
    const result: SprintResult = {
      items, correct, ms: Math.max(0, now - start), auditsRun, delayedChecks, score, newBest: false, stopReason,
      conceptIds: [...new Set(practised.map((x) => x.conceptId))],
    };
    if (opts.reason === 'sprint' && this.deps.best) {
      const best = this.deps.best.get();
      if (best !== undefined) result.best = best;
      if (!aborted && items >= 3 && score > (best ?? 0)) {
        result.newBest = true;
        this.deps.best.set(score);
      }
    }
    // An abort (task switch, new project) ends silently: the flow that aborted it takes over.
    if (items > 0 && !aborted) {
      const learner = pad.learner();
      const name = (id: string) => concept(learner, id)?.name ?? id;
      const missed = [...new Set(practised.filter((x) => x.correct !== true).map((x) => x.conceptId))];
      const ok = result.conceptIds.filter((id) => !missed.includes(id));
      const lines = [`${correct}/${items} right · ${formatDuration(result.ms)} · ${score}/min${result.newBest ? ' (new best)' : result.best !== undefined ? ` (best ${result.best})` : ''}`];
      if (ok.length) lines.push(`Held: ${ok.map(name).join(', ')}`);
      if (missed.length) lines.push(`Missed: ${missed.map(name).join(', ')}`);
      if (auditsRun || delayedChecks) lines.push(`${auditsRun} audit${auditsRun === 1 ? '' : 's'}, ${delayedChecks} delayed check${delayedChecks === 1 ? '' : 's'}`);
      pad.deps.ui.flash(`Sprint: ${correct}/${items} right${opts.reason === 'sprint' ? ` · ${score}/min${result.newBest ? ' (new best)' : ''}` : ''}`, PAD.flashMs);
      pad.deps.onLog?.({ kind: 'sprint', at: now, title: 'Sprint', lines, conceptIds: result.conceptIds, data: result });
    }
    return result;
  }
}
