// The placement blitz in the pad (spec V1-7 OPTIONAL PRIOR, BLITZ, SELECTION, FEEDBACK, STOP RULE,
// FINISH; coreLoop 1). Selection and the stop rule are src/atoms/placement.ts (pure); this module
// runs them on the pad:
// - optional 'Tick what you have used before (Esc to skip)' QuickPick (canSelectMany) over the 8
//   most-depended-on seed fundamentals: ticked P .7 + 'used', unticked P .2 + 'not-used', Esc leaves .3;
// - item 1 is the typing calibration (sets cps, not scored);
// - adaptive predict items under the generic header, the last 2 completions, no teaching;
// - feedback 'ok 6s' for 600 ms, 'actual: X' / 'right idea; ...' for 1.5 s;
// - a mutant match is stored as a candidate misconception (odds x3 curated, x2 model), no belief check;
// - evidence source 'placement';
// - stops on: everything needed classified, 14 items, 4 minutes, double Esc, the experienced fast
//   lane; while the plan is pending, up to 5 harder items labelled 'roadmap almost ready' follow;
// - plan concepts join mid-run through addCandidates();
// - finish: one status flash and one compact log card; the summary is returned.
// No vscode import: the pad and the stock are injected.

import type { Lang } from '../contracts';
import { PARAMS } from '../evidence';
import { concept, recordTypingCalibration, setPrior, upsertConcepts } from '../learner';
import type { Learner } from '../types';
import type { AtomCache } from './cache';
import { answerText } from './grade';
import {
  askCompletion, askPredict, completionEvidence, completionFeedback, isStopped, learnerSpeed, PAD, predictEvidence, predictFeedback,
  type AtomPad, type FlowStop, type ItemContext, type PadSession,
} from './pad';
import {
  escape, newPlacement, nextItem, PLACEMENT, record, shouldStop, summary, type PlacementCandidate, type PlacementItem,
  type PlacementSources, type PlacementState, type PlacementSummary, type StopReason,
} from './placement';
import { PROBE_HEADER, renderView } from './render';
import type { KeyStock } from './stock';
import { constructTag, descendants, exampleFor, tagInfo, TAXONOMY } from './tags';

export const TICK_PICKER = {
  max: 8,
  title: 'Tick what you have used before (Esc to skip)',
  placeholder: 'Space ticks, Enter confirms',
  usedP: 0.7,
  unusedP: 0.2,
} as const;

/** What placement needs from src/atoms/stock.ts (a Stock satisfies it). */
export interface PlacementStock {
  readonly lang: Lang;
  readonly cache: AtomCache;
  placementTags(): string[];
  cacheKeyFor(learner: Learner, conceptId: string): string | undefined;
  stockFor(key: string): KeyStock | undefined;
  refillIfLow?(key: string): unknown;
}

export interface PlacementRunOptions {
  /** Concepts needed by tasks 1-3 (ids or aliases; empty while the plan is pending). */
  needed?: () => string[];
  /** PlanOutline has not landed: harder 'roadmap almost ready' items follow the stop. */
  planPending?: () => boolean;
  /** Show the optional 'tick what you have used' picker first (default true). */
  tickPicker?: boolean;
  /** The typing calibration was already done (skip item 1). */
  calibrated?: boolean;
  /** Prerequisite overrides by concept id (default: the learner's concept prerequisites). */
  prereqs?: Record<string, string[]>;
  /** Display names for the summary (default: the learner's concept names). */
  names?: Record<string, string>;
  /** Leave the pad open (a sprint or an atom follows at once). */
  keepOpen?: boolean;
}

export type PlacementEnd = StopReason | 'aborted' | 'idle';

export interface PlacementRunResult {
  state: PlacementState;
  summary: PlacementSummary;
  reason: PlacementEnd;
  /** The tick picker was answered (not skipped with Esc). */
  selfRated: boolean;
  /** The typing calibration ran (learner.cps set). */
  calibrated: boolean;
}

interface ItemSource {
  key: string;
  tag: string;
  verified: boolean;
}

type Step = PlacementState | { stop: 'esc' | 'aborted' | 'idle' };

/** Same characters, ignoring spaces and the quote style: the typing item measures speed only on a real copy. */
export function isFaithfulCopy(typed: string, literal: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, '').replace(/"/g, "'");
  return norm(typed) === norm(literal);
}

export class PlacementRun {
  private readonly extra = new Set<string>();
  private readonly items = new Map<string, ItemSource>();
  /** Leave practice / tab closed ('esc'), or the InteractionLock's abort ('aborted'). */
  private stopRequest: 'esc' | 'aborted' | undefined;
  private pickerAbort: AbortController | undefined;
  private started = false;

  constructor(private readonly pad: AtomPad, private readonly stock: PlacementStock) {}

  /** Plan concepts become candidates as soon as the plan lands (any point during placement). */
  addCandidates(conceptIds: readonly string[]): void {
    for (const id of conceptIds) if (id) this.extra.add(id);
  }

  /** The 8 most-depended-on placement fundamentals that have stock. */
  tickTags(learner: Learner): string[] {
    const lang = this.stock.lang;
    const order = this.stock.placementTags();
    return order
      .filter((t) => !!this.stock.cacheKeyFor(learner, t))
      .map((t, i) => ({ t, i, n: descendants(t, lang).length }))
      .sort((a, b) => b.n - a.n || a.i - b.i)
      .slice(0, TICK_PICKER.max)
      .map((x) => x.t);
  }

  async run(opts: PlacementRunOptions = {}): Promise<PlacementRunResult> {
    if (this.started) throw new Error('PlacementRun.run: a PlacementRun runs once');
    this.started = true;
    const end = this.pad.beginFlow('placement', (reason) => {
      if (reason === 'external') this.stopRequest = 'aborted';
      else this.stopRequest ??= 'esc';
      this.pickerAbort?.abort();
    });
    let session: PadSession | undefined;
    try {
      const learner = this.pad.learner();
      this.ensureSeedConcepts(learner);
      const selfRated = opts.tickPicker === false ? false : await this.tickPicker(learner);
      let s = newPlacement(this.pad.now(), !!opts.calibrated);
      let ended: PlacementEnd | undefined;
      for (;;) {
        if (this.stopRequest) {
          s = escape(s);
          ended = this.stopRequest;
          break;
        }
        const sources = this.sources(learner, this.pad.now());
        const it = nextItem(s, sources, learner, { prereqs: opts.prereqs, needed: opts.needed?.() ?? [] }, { planPending: opts.planPending?.() ?? false });
        if (!it) break;
        session = await this.pad.openSession(this.stock.lang);
        const step = await this.ask(session, it, s, learner);
        if ('stop' in step) {
          s = escape(s);
          ended = this.stopRequest ?? step.stop;
          break;
        }
        s = step;
      }
      const now = this.pad.now();
      const needed = opts.needed?.() ?? [];
      const reason: PlacementEnd = ended
        ?? shouldStop(s, this.sources(learner, now), learner, { prereqs: opts.prereqs, needed }, { planPending: opts.planPending?.() ?? false }).reason
        ?? 'no-items';
      const sum = summary(s, learner, { now, names: opts.names, needed });
      if (!opts.keepOpen || reason === 'aborted') await this.pad.closeSession();
      else await session?.hold();
      // An abort (new project, task switch, reset) ends silently: the flow that aborted it takes over.
      if (reason !== 'aborted') {
        this.pad.deps.ui.flash(sum.flash, PAD.flashMs);
        this.pad.deps.onLog?.({
          kind: 'placement', at: this.pad.now(), title: 'Placement', lines: [sum.text],
          conceptIds: [...new Set(s.items.map((r) => r.conceptId))], data: sum,
        });
      }
      return { state: s, summary: sum, reason, selfRated, calibrated: s.calibrated };
    } catch (err) {
      await this.pad.closeSession().catch(() => undefined);
      throw err;
    } finally {
      end();
    }
  }

  // ------------------------------------------------------------ setup

  /** Seed fundamentals exist in the learner model (placement evidence is never orphaned). */
  private ensureSeedConcepts(learner: Learner): void {
    const lang = this.stock.lang;
    const missing = this.stock.placementTags().filter((t) => !concept(learner, t) && tagInfo(t));
    if (!missing.length) return;
    upsertConcepts(learner, missing.map((t) => {
      const info = TAXONOMY[t];
      return { id: t, name: info.patternName, tag: t, kind: info.kind, prerequisites: info.prereqs.filter((p) => tagInfo(p)?.langs.includes(lang)) };
    }), this.pad.now());
  }

  /** The optional prior. Returns true when the learner answered it (Enter, even with nothing ticked). */
  private async tickPicker(learner: Learner): Promise<boolean> {
    const tags = this.tickTags(learner);
    if (!tags.length || this.stopRequest) return false;
    this.pickerAbort = new AbortController();
    let picked: number[] | undefined;
    try {
      picked = await this.pad.deps.ui.pickMany({
        title: TICK_PICKER.title, placeholder: TICK_PICKER.placeholder, signal: this.pickerAbort.signal,
        items: tags.map((t) => ({ label: TAXONOMY[t].patternName, detail: exampleFor(t, this.stock.lang) })),
      });
    } finally {
      this.pickerAbort = undefined;
    }
    if (!picked || this.stopRequest) return false;
    tags.forEach((t, i) => {
      const used = picked!.includes(i);
      const c = concept(learner, t);
      if (c) setPrior(learner, c.id, used ? TICK_PICKER.usedP : TICK_PICKER.unusedP, used ? 'used' : 'not-used');
    });
    return true;
  }

  /** Candidates: placement fundamentals plus added plan concepts, each with its unseen stock. */
  private sources(learner: Learner, now: number): PlacementSources {
    const lang = this.stock.lang;
    const canRun = !!this.pad.runnerFor(lang);
    const candidates: PlacementCandidate[] = [];
    const keys = new Set<string>();
    for (const id of new Set([...this.stock.placementTags(), ...this.extra])) {
      const c = concept(learner, id);
      if (!c) continue;
      const key = this.stock.cacheKeyFor(learner, c.id);
      if (!key || keys.has(key)) continue;
      const st = this.stock.stockFor(key);
      if (!st) continue;
      keys.add(key);
      const src: ItemSource = { key, tag: st.tag, verified: st.verified };
      for (const p of st.probes) this.items.set(p.id, src);
      for (const x of st.completions) this.items.set(x.id, src);
      candidates.push({ conceptId: c.id, probes: st.probes, completions: canRun && st.verified ? st.completions : [] });
    }
    return {
      candidates, now, lang,
      constructConcept: (k) => {
        const tag = constructTag(k, lang);
        return tag ? concept(learner, tag)?.id ?? tag : undefined;
      },
    };
  }

  // ------------------------------------------------------------ items

  private context(session: PadSession, learner: Learner): ItemContext {
    return { lang: this.stock.lang, keyUse: learner.keyUse, speed: learnerSpeed(learner), deadline: () => session.shownAt + PAD.idleMs };
  }

  private async ask(session: PadSession, it: PlacementItem, s: PlacementState, learner: Learner): Promise<Step> {
    switch (it.kind) {
      case 'typing':
        return this.typing(session, it.literal, s, learner);
      case 'predict':
        return this.predict(session, it, s, learner);
      case 'completion':
        return this.completion(session, it, s, learner);
    }
  }

  /** An item went on screen: mark it seen (the 7-day rule) and let the stock top the key up. */
  private shown(key: string, itemId: string): void {
    this.stock.cache.markSeen(key, itemId, this.pad.now());
    this.stock.refillIfLow?.(key);
  }

  private stopOf(stop: FlowStop): Step {
    return { stop: this.stopRequest ?? (stop === 'abort' ? 'aborted' : stop === 'timeout' ? 'idle' : 'esc') };
  }

  /**
   * Item 1: copy a short literal; sets cps (not scored, no evidence). Speed is measured only on a
   * faithful copy typed by hand with valid latency; anything else moves on without calibrating.
   */
  private async typing(session: PadSession, literal: string, s: PlacementState, learner: Learner): Promise<Step> {
    await session.show(renderView({ kind: 'typing', literal }, { lang: this.stock.lang }));
    for (;;) {
      const i = await session.answer({ deadline: () => session.shownAt + PAD.idleMs });
      if ('stop' in i) return this.stopOf(i.stop);
      if (i.type !== 'submit') continue;
      if (i.assisted) {
        session.feedback({ kind: 'assisted' });
        continue;
      }
      const typed = answerText(i.text, session.tok).trim();
      if (!typed) {
        session.feedback({ kind: 'empty', message: 'copy the line above after ->, then Ctrl+Enter' });
        continue;
      }
      if (i.latencyValid && isFaithfulCopy(typed, literal)) {
        recordTypingCalibration(learner, typed.length, i.latencyMs);
        session.feedback({ kind: 'correct', ms: i.latencyMs });
      } else {
        session.feedback({ kind: 'note', text: 'thanks: on to the questions' }, 'answer', PAD.hold.correct);
      }
      return record(s, { kind: 'typing', at: i.at });
    }
  }

  private async predict(session: PadSession, it: Extract<PlacementItem, { kind: 'predict' }>, s: PlacementState, learner: Learner): Promise<Step> {
    const src = this.items.get(it.probe.id);
    const cache = this.stock.cache;
    if (src) this.shown(src.key, it.probe.id);
    const header = it.extra ? `${PROBE_HEADER}   (${it.label ?? PLACEMENT.extraLabel})` : undefined;
    const o = await askPredict(session, it.probe, {
      ...this.context(session, learner), typeSensitive: !!tagInfo(src?.tag ?? it.conceptId)?.typeSensitive, header,
    });
    if (isStopped(o)) return this.stopOf(o.stop);
    const g = o.grade;
    const ev = predictEvidence(it.probe, o, { conceptId: it.conceptId, source: 'placement', weight: it.confounded ? PARAMS.halfWeight : 1, unverified: src ? !src.verified : false });
    if (ev) this.pad.deps.recordEvidence(ev);
    if (src && g.verdict !== 'format-only') cache.recordItemStat(src.key, it.probe.id, g.correct === true, o.latencyMs);
    if (src && g.mutant) cache.recordMutantResponse(src.key, g.mutant.id, 'match');
    if (g.correct === true && o.guess) this.pad.guessFlagged.add(it.conceptId);
    session.feedback(predictFeedback(o));
    return record(s, {
      conceptId: it.conceptId, itemId: it.probe.id, kind: 'predict', group: it.probe.group,
      correct: g.verdict === 'format-only' ? null : g.correct ?? null, guess: o.guess, verdict: g.verdict, latencyMs: o.latencyMs,
      latencyValid: o.latencyValid, parSelfMs: o.par.self, at: o.at, extra: !!it.extra,
      ...(g.mutant ? { misconceptionId: g.mutant.misconceptionId } : {}),
    });
  }

  private async completion(session: PadSession, it: Extract<PlacementItem, { kind: 'completion' }>, s: PlacementState, learner: Learner): Promise<Step> {
    const src = this.items.get(it.completion.id);
    const cache = this.stock.cache;
    const runner = this.pad.runnerFor(this.stock.lang);
    const skip = (at: number) => record(s, {
      conceptId: it.conceptId, itemId: it.completion.id, kind: 'completion', group: it.completion.group, correct: null, guess: false,
      latencyValid: false, at, extra: !!it.extra,
    });
    if (!runner) return skip(this.pad.now());
    if (src) this.shown(src.key, it.completion.id);
    const o = await askCompletion(session, it.completion, runner, {
      ...this.context(session, learner), allowImports: tagInfo(src?.tag ?? it.conceptId)?.allowedImports,
    });
    if (isStopped(o)) return this.stopOf(o.stop);
    // The runner failed: nothing to score, move on.
    if ('error' in o) return skip(this.pad.now());
    this.pad.deps.recordEvidence(completionEvidence(it.completion, o, { conceptId: it.conceptId, source: 'placement', unverified: src ? !src.verified : false }));
    if (src) cache.recordItemStat(src.key, it.completion.id, o.grade.pass, o.latencyMs);
    completionFeedback(session, o);
    return record(s, {
      conceptId: it.conceptId, itemId: it.completion.id, kind: 'completion', group: it.completion.group, correct: o.grade.pass, guess: o.guess,
      verdict: o.grade.pass ? 'correct' : 'wrong', latencyMs: o.latencyMs, latencyValid: o.latencyValid, parSelfMs: o.par.self, at: o.at,
      extra: !!it.extra, ...(o.grade.misconceptionId && !o.grade.pass ? { misconceptionId: o.grade.misconceptionId } : {}),
    });
  }
}
