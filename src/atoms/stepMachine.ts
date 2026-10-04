// The atom STEP MACHINE (spec conceptAtom STEP MACHINE, V1-6) as a pure reducer:
//   stepAtom(state, event) -> { state, effects }
// It never touches the editor, the cache, the learner or the runner. Effects say what the pad must do:
// pick an item from the cache ('pick', answered with an 'item' event), show a view (render.ts),
// decorate feedback, write an Evidence record (recordEvidence), count mutant matches/answers, run a
// completion ('run-completion', answered with 'completion-graded'), request the escalation lesson,
// schedule a review, and finally exit with an AtomResult. No vscode import.
//
// Flow: ROUTE -> PROBE -> PROBE2 -> tested-out; a mutant match -> BELIEF-CHECK(M) -> y: REFUTE
// (CONTRAST-PICK, REVEAL, RE-PROBE, SECOND SIBLING) -> fixed | ESCALATE; n: slip -> one more PROBE;
// no match or '?' -> UNKNOWN (example(s), completion(s), final predict) -> learned | partial.
// CAPS: 7 graded items or 150 s; the clock pauses in ESCALATE, which has its own 150 s.
// Double-Esc (two presses within 600 ms) exits at any point and keeps the evidence.

import type {
  AtomPath, AtomPattern, AtomResult, EvidenceSource, ItemKind, Lang, StoredAtom, StoredCompletion, StoredContrast, StoredExample,
  StoredMutant, StoredProbe,
} from '../contracts';
import { chip, parAbs, parSelf, PARAMS } from '../evidence';
import type { EvidenceInput } from '../learner';
import type { MutantResponse } from './cache';
import type { ConceptState } from '../types';
import { answerText, commentToken, gradePredict, type CompletionGrade } from './grade';
import type { Feedback, LessonText, PadView } from './render';
import { hash53 } from './rng';
import { seenWithin7Days } from './seeds';
import { findMisconception, tagInfo, TAXONOMY } from './tags';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const ATOM_CAPS = {
  /** Graded items per atom (ESCALATE excluded: it has its own time limit). */
  items: 7,
  /** Active time per atom; the clock pauses during ESCALATE. */
  ms: 150_000,
  /** ESCALATE's own limit. */
  escalateMs: 150_000,
  /** Two Esc presses within this window abort. */
  doubleEscMs: 600,
} as const;

/** 'partial' -> review in 10 min; 'escalated' -> a same-day review. */
export const REVIEW_MS = { partial: 10 * MIN, escalated: 60 * MIN } as const;

const RECENT_MS = 7 * DAY;
const UNKNOWN_P = 0.15;
const REFUTE_STEPS: readonly AtomStep[] = ['contrast-pick', 'reveal', 'reprobe', 'second-sibling'];

// ---------------------------------------------------------------- types

export type AtomStep =
  | 'probe' | 'probe2' | 'belief-check' | 'contrast-pick' | 'reveal' | 'reprobe' | 'second-sibling'
  | 'example' | 'example2' | 'completion' | 'completion2' | 'final-predict' | 'escalate' | 'done';

/** What an item is picked for (the pad maps it onto AtomCache.unseenProbes and friends). */
export type ItemRole =
  | 'probe' | 'probe2' | 'reprobe' | 'second-sibling' | 'final-predict' | 'reveal'
  | 'example' | 'example2' | 'completion' | 'completion2' | 'contrast' | 'escalate';

export interface PickRequest {
  role: ItemRole;
  kind: 'probe' | 'example' | 'completion' | 'contrast';
  conceptKey: string;
  /** Sibling groups already used in this atom: the item must come from another one. */
  excludeGroups: string[];
  /** Items already shown in this atom. */
  excludeIds: string[];
  /** Prefer items carrying this misconception's mutant (contrast: the contrast for it). */
  misconceptionId?: string;
  /** Only items carrying it (contrast, the reveal probe). */
  requireMisconception?: boolean;
  /** Completion blanks wanted (1, or 2 for the second completion of a large tag). */
  blanks?: 1 | 2;
}

export type PickedItem =
  | { kind: 'probe'; probe: StoredProbe; /** Uses constructs the learner has not mastered: weight .5. */ confounded?: boolean }
  | { kind: 'example'; example: StoredExample }
  | { kind: 'completion'; completion: StoredCompletion }
  | { kind: 'contrast'; contrast: StoredContrast };

/** One graded (or discarded) submission (spec AtomRunState.graded, plus correct/scored). */
export interface GradedEntry {
  itemId: string;
  kind: ItemKind;
  shownAt: number;
  answer: string;
  verdict: string;
  guess: boolean;
  implicitGuess: boolean;
  assisted: boolean;
  latencyMs?: number;
  latencyValid: boolean;
  misconceptionId?: string;
  beliefConfirmed?: boolean;
  correct?: boolean | null;
  /** Evidence was (or will be, after the belief check) written: counts toward the 7-item cap. */
  scored: boolean;
}

interface Focus {
  id: string;
  belief: string;
  confirmed: boolean;
  /** The probe whose mutant matched, and that mutant (REVEAL shows them). */
  probe?: StoredProbe;
  mutant?: StoredMutant;
}

interface PendingBelief {
  evidence: EvidenceInput;
  entry: number;
  mutant: StoredMutant;
}

interface SubmitInfo {
  at: number;
  guess: boolean;
  latencyMs?: number;
  latencyValid: boolean;
  text: string;
}

export interface AtomRunState {
  // ---- spec fields
  conceptKey: string;
  step: AtomStep;
  startedAt: number;
  /** Time the clock was paused (ESCALATE). */
  pausedMs: number;
  groupsUsed: string[];
  graded: GradedEntry[];
  /** Completion retries used on the current completion (one allowed). */
  retries: number;
  // ---- run context
  conceptId: string;
  tag: string;
  lang: Lang;
  typeSensitive: boolean;
  large: boolean;
  pattern: AtomPattern;
  source: EvidenceSource;
  speed: { cps: number; speedFactor: number };
  recentCorrectGroups: string[];
  stateBefore: string;
  // ---- progress
  phase: 'pick' | 'show' | 'grading' | 'wait-lesson' | 'reveal-fill' | 'done';
  request?: PickRequest;
  item?: PickedItem;
  shownAt?: number;
  itemIds: string[];
  focus?: Focus;
  pending?: PendingBelief;
  /** An 'n' to a belief check: the next miss goes to UNKNOWN. */
  slipped: boolean;
  exampleShown: boolean;
  contrast?: StoredContrast;
  rightFirst?: boolean;
  lesson?: LessonText;
  lessonState: 'none' | 'requested' | 'ready' | 'failed';
  escalateStartedAt?: number;
  lastEscAt?: number;
  submit?: SubmitInfo;
  /** Wrong items of this atom (the escalation lesson prompt quotes them). */
  wrongItems: { code: string; answer: string; actual: string }[];
  result?: AtomResult;
}

export type AtomEvent =
  /** Answer to a 'pick' effect (item undefined: nothing suitable in stock). */
  | { type: 'item'; at: number; item?: PickedItem }
  /** Ctrl+Enter / Ctrl+Shift+Enter: the whole pad document text. */
  | { type: 'submit'; at: number; text: string; guess?: boolean; latencyMs?: number; latencyValid?: boolean; assisted?: boolean }
  /** Answer to 'run-completion'. */
  | { type: 'completion-graded'; at: number; grade: CompletionGrade }
  | { type: 'yn'; at: number; yes: boolean }
  | { type: 'pick'; at: number; choice: number; latencyMs?: number; latencyValid?: boolean; guess?: boolean }
  /** Ctrl+Enter on a reading step. */
  | { type: 'continue'; at: number }
  /** The escalation lesson landed (undefined: the job failed). */
  | { type: 'lesson'; at: number; lesson?: LessonText }
  | { type: 'esc'; at: number }
  /** 'Leave practice', or the learner closed the tab. */
  | { type: 'abort'; at: number }
  /** Timer: lets the 150 s caps fire without input (schedule it at atomDeadline()). */
  | { type: 'tick'; at: number };

export type FeedbackTarget = 'answer' | { line: number };

export type AtomEffect =
  | { type: 'pick'; request: PickRequest }
  | { type: 'render'; view: PadView }
  | { type: 'feedback'; feedback: Feedback; target: FeedbackTarget }
  | { type: 'evidence'; evidence: EvidenceInput }
  /** AtomCache.markSeen. */
  | { type: 'seen'; itemId: string; at: number }
  /** AtomCache.recordItemStat. */
  | { type: 'item-stat'; itemId: string; correct: boolean; ms?: number }
  /** AtomCache.recordMutantResponse(key, mutantId, response): a strict match, then the learner's y ('yes') / n ('no'). */
  | { type: 'mutant'; mutantId: string; response: MutantResponse }
  /** Run gradeCompletion(text, completion) and dispatch 'completion-graded'. */
  | { type: 'run-completion'; completion: StoredCompletion; text: string }
  /** Enqueue the escalation lesson job (low effort, priority 0) under project.prefetch[key]. */
  | {
      type: 'request-lesson'; key: string; conceptId: string; misconceptionId: string; belief: string;
      items: { code: string; answer: string; actual: string }[];
    }
  | { type: 'review'; conceptId: string; inMs: number }
  /** The atom is over. stateAfter is '' here: the pad fills it from the learner after the evidence. */
  | { type: 'exit'; result: AtomResult };

export interface StepOutput {
  state: AtomRunState;
  effects: AtomEffect[];
}

// ---------------------------------------------------------------- ROUTE

export type Route =
  | { to: 'belief-check' | 'refute'; misconceptionId: string; belief: string }
  | { to: 'unknown' }
  | { to: 'probe' };

export interface RouteOptions {
  now: number;
  tag?: string;
  /** Placement got a don't-know on this concept. */
  placementDontKnow?: boolean;
  /** Misconceptions the learner confirmed with 'y' before (from the evidence log). */
  confirmedMisconceptions?: readonly string[];
}

const STATUS_RANK: Record<string, number> = { active: 0, suppressed: 1, candidate: 2 };

/**
 * ROUTE: (1) an active misconception, a suppressed one whose check is due, or a candidate with
 * p >= .3 -> BELIEF-CHECK(M), or REFUTE(M) when M is already confirmed (said 'y' before, or active
 * or suppressed); (2) UNKNOWN when P < .15 with full-weight wrong evidence, after a placement
 * don't-know, or self-rated 'not used' with no correct evidence; (3) PROBE.
 */
export function routeAtom(c: ConceptState, o: RouteOptions): Route {
  const due = Object.entries(c.misconceptions ?? {})
    .filter(([, m]) =>
      m.status === 'active' ||
      (m.status === 'suppressed' && (m.nextCheckAt ?? 0) <= o.now) ||
      (m.status === 'candidate' && m.p >= PARAMS.misconception.blockP))
    .sort(([, a], [, b]) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.p - a.p);
  if (due.length) {
    const [id, m] = due[0];
    const confirmed = !!o.confirmedMisconceptions?.includes(id) || m.status === 'active' || m.status === 'suppressed';
    const belief = m.belief || findMisconception(o.tag ?? c.tag ?? '', id)?.belief || id;
    return { to: confirmed ? 'refute' : 'belief-check', misconceptionId: id, belief };
  }
  if (c.mastery < UNKNOWN_P && c.lastWrongAt !== undefined) return { to: 'unknown' };
  if (o.placementDontKnow) return { to: 'unknown' };
  if (c.selfRating === 'not-used' && !c.groupsCorrect.length) return { to: 'unknown' };
  return { to: 'probe' };
}

/**
 * Sibling groups with a correct non-guess answer in the last 7 days. ConceptState keeps no
 * per-group times, so this is exact only when the caller passes groups from the evidence log;
 * this approximation uses groupsCorrect when the concept was practised within 7 days.
 */
export function recentCorrectGroups(c: ConceptState, now: number): string[] {
  return c.lastPracticed > 0 && now - c.lastPracticed < RECENT_MS ? [...c.groupsCorrect] : [];
}

/** Large topics (split into sub-atoms): 2 worked examples and a second, 2-blank completion. */
export function isLargeTag(tag: string): boolean {
  if (tagInfo(tag)?.parent) return true;
  return Object.values(TAXONOMY).some((e) => e.parent === tag);
}

// ---------------------------------------------------------------- start

export interface AtomStart {
  conceptId: string;
  /** Cache key (canonical tag or sub-tag, or the concept id for 'other'). */
  conceptKey: string;
  tag: string;
  lang: Lang;
  pattern: AtomPattern;
  concept: ConceptState;
  at: number;
  typeSensitive?: boolean;
  large?: boolean;
  /** Chip before the atom (default chip(concept), without coverage requirements). */
  stateBefore?: string;
  /** Learner.cps and speedFactor, for par and implicit guesses. */
  speed?: { cps: number; speedFactor: number };
  /** Groups answered correctly (non-guess) in the last 7 days: PROBE's tested-out shortcut. */
  recentCorrectGroups?: string[];
  placementDontKnow?: boolean;
  confirmedMisconceptions?: string[];
  /** Evidence source (default 'atom'). */
  source?: EvidenceSource;
}

export function startAtom(input: AtomStart): StepOutput {
  const info = tagInfo(input.tag);
  const state: AtomRunState = {
    conceptKey: input.conceptKey,
    step: 'probe',
    startedAt: input.at,
    pausedMs: 0,
    groupsUsed: [],
    graded: [],
    retries: 0,
    conceptId: input.conceptId,
    tag: input.tag,
    lang: input.lang,
    typeSensitive: input.typeSensitive ?? info?.typeSensitive ?? false,
    large: input.large ?? isLargeTag(input.tag),
    pattern: input.pattern,
    source: input.source ?? 'atom',
    speed: input.speed ?? { cps: PARAMS.latency.cps, speedFactor: 1 },
    recentCorrectGroups: input.recentCorrectGroups ?? recentCorrectGroups(input.concept, input.at),
    stateBefore: input.stateBefore ?? chip(input.concept),
    phase: 'pick',
    itemIds: [],
    slipped: false,
    exampleShown: false,
    lessonState: 'none',
    wrongItems: [],
  };
  const run = new Run(state, input.at);
  const route = routeAtom(input.concept, {
    now: input.at, tag: input.tag, placementDontKnow: input.placementDontKnow, confirmedMisconceptions: input.confirmedMisconceptions,
  });
  switch (route.to) {
    case 'belief-check':
      run.s.focus = { id: route.misconceptionId, belief: route.belief, confirmed: false };
      run.s.step = 'belief-check';
      run.s.phase = 'show';
      run.s.shownAt = input.at;
      run.render({ kind: 'belief-check', belief: route.belief });
      break;
    case 'refute':
      run.s.focus = { id: route.misconceptionId, belief: route.belief, confirmed: true };
      run.enterRefute();
      break;
    case 'unknown':
      run.enterUnknown();
      break;
    case 'probe':
      run.enterProbe('probe');
      break;
  }
  return run.out();
}

// ---------------------------------------------------------------- the reducer

export function stepAtom(state: AtomRunState, ev: AtomEvent): StepOutput {
  if (state.phase === 'done') return { state, effects: [] };
  const run = new Run(copyState(state), ev.at);
  run.dispatch(ev);
  return run.out();
}

/** When to dispatch a 'tick' so the time caps fire without input (undefined once exited). */
export function atomDeadline(state: AtomRunState): number | undefined {
  if (state.phase === 'done') return undefined;
  if (state.escalateStartedAt !== undefined) return state.escalateStartedAt + ATOM_CAPS.escalateMs;
  return state.startedAt + state.pausedMs + ATOM_CAPS.ms;
}

/** Active (unpaused) time so far. */
export function activeMs(state: AtomRunState, now: number): number {
  const paused = state.pausedMs + (state.escalateStartedAt !== undefined ? Math.max(0, now - state.escalateStartedAt) : 0);
  return Math.max(0, now - state.startedAt - paused);
}

function copyState(s: AtomRunState): AtomRunState {
  return { ...s, groupsUsed: [...s.groupsUsed], graded: [...s.graded], itemIds: [...s.itemIds], wrongItems: [...s.wrongItems] };
}

const lineCount = (code: string) => code.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n').length;

class Run {
  readonly fx: AtomEffect[] = [];

  constructor(readonly s: AtomRunState, readonly at: number) {}

  out(): StepOutput {
    return { state: this.s, effects: this.fx };
  }

  // ------------------------------------------------------------ plumbing

  render(view: PadView): void {
    this.fx.push({ type: 'render', view });
  }

  feedback(feedback: Feedback, target: FeedbackTarget = 'answer'): void {
    this.fx.push({ type: 'feedback', feedback, target });
  }

  evidence(e: EvidenceInput): void {
    this.fx.push({ type: 'evidence', evidence: e });
  }

  pick(role: ItemRole, kind: PickRequest['kind'], extra: Partial<PickRequest> = {}): void {
    const request: PickRequest = {
      role, kind, conceptKey: this.s.conceptKey, excludeGroups: [...this.s.groupsUsed], excludeIds: [...this.s.itemIds], ...extra,
    };
    this.s.request = request;
    this.s.item = undefined;
    this.s.phase = 'pick';
    this.fx.push({ type: 'pick', request });
  }

  /** Put an item on screen. */
  show(item: PickedItem, view: PadView): void {
    this.s.item = item;
    this.s.phase = 'show';
    this.s.shownAt = this.at;
    const id = itemId(item);
    if (!this.s.itemIds.includes(id)) this.s.itemIds.push(id);
    const group = itemGroup(item);
    if (group && !this.s.groupsUsed.includes(group)) this.s.groupsUsed.push(group);
    this.fx.push({ type: 'seen', itemId: id, at: this.at });
    this.render(view);
  }

  scoredCount(): number {
    return this.s.graded.filter((g) => g.scored).length;
  }

  // ------------------------------------------------------------ dispatch

  dispatch(ev: AtomEvent): void {
    const s = this.s;
    switch (ev.type) {
      case 'esc':
        if (s.lastEscAt !== undefined && ev.at - s.lastEscAt <= ATOM_CAPS.doubleEscMs) return this.exit('aborted');
        s.lastEscAt = ev.at;
        return;
      case 'abort':
        return this.exit('aborted');
      case 'tick':
        return this.checkCaps(false);
      case 'lesson':
        this.onLesson(ev.lesson);
        break;
      case 'item':
        if (s.phase !== 'pick') return;
        this.onItem(ev.item);
        break;
      case 'submit':
        this.onSubmit(ev);
        break;
      case 'completion-graded':
        if (s.phase !== 'grading') return;
        this.onCompletionGraded(ev.grade);
        break;
      case 'yn':
        if (s.step !== 'belief-check' || s.phase !== 'show') return;
        this.onBelief(ev.yes);
        break;
      case 'pick':
        if (s.step !== 'contrast-pick' || s.phase !== 'show') return;
        this.onContrastPick(ev);
        break;
      case 'continue':
        this.onContinue();
        break;
    }
    if (this.s.phase !== 'done') this.checkCaps(true);
  }

  // ------------------------------------------------------------ caps and exits

  /** 7 graded items or 150 s active time (ESCALATE: its own 150 s). After input, drop pending picks/renders. */
  checkCaps(afterInput: boolean): void {
    const s = this.s;
    if (s.phase === 'done') return;
    // A submitted completion is being run (< 1 s): its grade arrives next and re-checks the caps.
    if (!afterInput && s.phase === 'grading') return;
    if (s.step === 'escalate') {
      if (s.escalateStartedAt !== undefined && this.at - s.escalateStartedAt >= ATOM_CAPS.escalateMs) this.capExit(afterInput, 'escalated');
      return;
    }
    if (this.scoredCount() >= ATOM_CAPS.items || activeMs(s, this.at) >= ATOM_CAPS.ms) {
      const path: AtomPath = s.focus?.confirmed && REFUTE_STEPS.includes(s.step) ? 'confirmed' : 'partial';
      this.capExit(afterInput, path);
    }
  }

  private capExit(afterInput: boolean, path: AtomPath): void {
    if (afterInput) {
      // The next item was already asked for: the cap wins, nothing more is shown.
      for (let i = this.fx.length - 1; i >= 0; i--) {
        const t = this.fx[i].type;
        if (t === 'pick' || t === 'render' || t === 'run-completion') this.fx.splice(i, 1);
      }
    }
    this.exit(path);
  }

  exit(path: AtomPath): void {
    const s = this.s;
    if (s.phase === 'done') return;
    this.flushPending();
    if (s.escalateStartedAt !== undefined) {
      s.pausedMs += Math.max(0, this.at - s.escalateStartedAt);
      s.escalateStartedAt = undefined;
    }
    const result: AtomResult = {
      conceptId: s.conceptId,
      path,
      items: this.scoredCount(),
      ms: Math.max(0, this.at - s.startedAt),
      stateBefore: s.stateBefore,
      stateAfter: '',
    };
    if (s.focus) {
      result.misconceptionId = s.focus.id;
      result.misconceptionStatus = path === 'fixed' ? 'suppressed' : s.focus.confirmed ? 'confirmed' : 'candidate';
    }
    if (path === 'partial') this.fx.push({ type: 'review', conceptId: s.conceptId, inMs: REVIEW_MS.partial });
    if (path === 'escalated') this.fx.push({ type: 'review', conceptId: s.conceptId, inMs: REVIEW_MS.escalated });
    s.result = result;
    s.phase = 'done';
    s.step = 'done';
    s.request = undefined;
    this.fx.push({ type: 'exit', result });
  }

  /** A wrong answer still waiting for its belief check is recorded as an unconfirmed match. */
  private flushPending(): void {
    const p = this.s.pending;
    if (!p) return;
    this.s.pending = undefined;
    this.evidence({ ...p.evidence, misconceptionId: p.mutant.misconceptionId, misconceptionOdds: unconfirmedOdds(p.mutant), belief: p.mutant.belief });
  }

  /** No more items for the current path: exit on the strength of the last graded item. */
  private exitOnLast(passPath: AtomPath): void {
    const last = [...this.s.graded].reverse().find((g) => g.scored);
    this.exit(last && last.correct === true && !last.guess ? passPath : 'partial');
  }

  // ------------------------------------------------------------ entering steps

  enterProbe(step: 'probe' | 'probe2'): void {
    this.s.step = step;
    this.pick(step, 'probe');
  }

  enterRefute(): void {
    this.s.step = 'contrast-pick';
    this.pick('contrast', 'contrast', { misconceptionId: this.s.focus!.id, requireMisconception: true });
  }

  enterReveal(): void {
    const s = this.s;
    s.step = 'reveal';
    if (s.focus?.probe || !s.focus) return this.showReveal();
    this.pick('reveal', 'probe', { misconceptionId: s.focus.id, requireMisconception: true });
  }

  private showReveal(): void {
    const s = this.s;
    const f = s.focus;
    const rule = f?.mutant?.rule || s.contrast?.rule || '';
    if (!f?.probe && !s.contrast) return this.enterReprobe();
    s.phase = 'show';
    s.shownAt = this.at;
    this.render({ kind: 'reveal', rule, contrast: s.contrast, rightFirst: s.rightFirst, probe: f?.probe, mutant: f?.mutant });
  }

  enterReprobe(): void {
    this.s.step = 'reprobe';
    this.pick('reprobe', 'probe', { misconceptionId: this.s.focus?.id });
  }

  enterSecondSibling(): void {
    this.s.step = 'second-sibling';
    this.pick('second-sibling', 'probe', { misconceptionId: this.s.focus?.id });
  }

  enterEscalate(): void {
    const s = this.s;
    s.step = 'escalate';
    s.retries = 0;
    s.escalateStartedAt = this.at;
    this.requestLesson();
    this.pick('escalate', 'completion', { blanks: 1 });
  }

  enterUnknown(): void {
    this.s.step = 'example';
    this.pick('example', 'example');
  }

  enterCompletion(blanks: 1 | 2): void {
    this.s.step = blanks === 1 ? 'completion' : 'completion2';
    this.s.retries = 0;
    this.pick(this.s.step, 'completion', { blanks });
  }

  enterFinal(): void {
    this.s.step = 'final-predict';
    this.pick('final-predict', 'probe');
  }

  private requestLesson(): void {
    const s = this.s;
    if (!s.focus || s.lessonState !== 'none') return;
    s.lessonState = 'requested';
    this.fx.push({
      type: 'request-lesson', key: `lesson:${s.conceptId}:${s.focus.id}`, conceptId: s.conceptId, misconceptionId: s.focus.id,
      belief: s.focus.belief, items: s.wrongItems.slice(-3),
    });
  }

  // ------------------------------------------------------------ events

  private onItem(item: PickedItem | undefined): void {
    const s = this.s;
    const role = s.request?.role;
    s.request = undefined;
    // A picked item of the wrong kind is treated as nothing in stock.
    const want = <K extends PickedItem['kind']>(k: K) => (item?.kind === k ? (item as Extract<PickedItem, { kind: K }>) : undefined);
    switch (role) {
      case 'probe':
      case 'probe2':
      case 'reprobe':
      case 'second-sibling':
      case 'final-predict': {
        const p = want('probe');
        if (p) return this.show(p, { kind: 'probe', probe: p.probe });
        return this.noProbe(role);
      }
      case 'reveal': {
        const p = want('probe');
        if (p && s.focus) {
          s.focus = { ...s.focus, probe: p.probe, mutant: carrying(p.probe, s.focus.id) };
          s.itemIds.push(p.probe.id);
          if (!s.groupsUsed.includes(p.probe.group)) s.groupsUsed.push(p.probe.group);
          this.fx.push({ type: 'seen', itemId: p.probe.id, at: this.at });
        }
        return this.showReveal();
      }
      case 'contrast': {
        const c = want('contrast');
        if (!c) return this.enterReveal();
        s.contrast = c.contrast;
        s.rightFirst = hash53(c.contrast.id) % 2 === 0;
        return this.show(c, { kind: 'contrast-pick', contrast: c.contrast, rightFirst: s.rightFirst });
      }
      case 'example':
      case 'example2': {
        const e = want('example');
        if (!e) return this.enterCompletion(1);
        s.exampleShown = true;
        return this.show(e, { kind: 'example', example: e.example, pattern: s.pattern });
      }
      case 'completion':
      case 'completion2': {
        const c = want('completion');
        if (!c) return role === 'completion' && s.large ? this.enterCompletion(2) : this.enterFinal();
        return this.show(c, { kind: 'completion', completion: c.completion });
      }
      case 'escalate': {
        const c = want('completion');
        s.item = c;
        if (c) {
          s.itemIds.push(c.completion.id);
          this.fx.push({ type: 'seen', itemId: c.completion.id, at: this.at });
        }
        return this.showEscalate();
      }
    }
  }

  private noProbe(role: ItemRole): void {
    switch (role) {
      case 'probe':
        // Nothing to test with: teach instead.
        return this.enterUnknown();
      case 'probe2':
        return this.exit('partial');
      case 'reprobe':
        // The refutation was shown but cannot be checked now.
        return this.exit('confirmed');
      case 'second-sibling':
        return this.enterEscalate();
      default:
        return this.exitOnLast('learned');
    }
  }

  private showEscalate(): void {
    const s = this.s;
    const completion = s.item?.kind === 'completion' ? s.item.completion : undefined;
    if (s.lessonState === 'requested') {
      s.phase = 'wait-lesson';
      this.render({ kind: 'escalate', pending: true });
      return;
    }
    s.phase = 'show';
    s.shownAt = this.at;
    // A failed lesson job still leaves the fresh completion.
    this.render({ kind: 'escalate', lesson: s.lesson, completion });
  }

  private onLesson(lesson: LessonText | undefined): void {
    const s = this.s;
    s.lesson = lesson;
    s.lessonState = lesson ? 'ready' : 'failed';
    if (s.step === 'escalate' && s.phase === 'wait-lesson') this.showEscalate();
  }

  private onContinue(): void {
    const s = this.s;
    if (s.phase === 'reveal-fill') return this.afterCompletion();
    if (s.phase !== 'show') return;
    switch (s.step) {
      case 'reveal':
        return this.enterReprobe();
      case 'example':
        if (s.large) {
          s.step = 'example2';
          return this.pick('example2', 'example');
        }
        return this.enterCompletion(1);
      case 'example2':
        return this.enterCompletion(1);
      case 'escalate':
        // The lesson without a completion item: reading it ends the atom.
        if (s.item?.kind !== 'completion') return this.exit('escalated');
        return;
    }
  }

  private onSubmit(ev: Extract<AtomEvent, { type: 'submit' }>): void {
    const s = this.s;
    // Ctrl+Enter on a reading step continues.
    if (s.phase === 'reveal-fill' || (s.phase === 'show' && (s.step === 'reveal' || s.step === 'example' || s.step === 'example2'))) {
      return this.onContinue();
    }
    if (s.phase !== 'show' || !s.item) {
      if (s.step === 'escalate' && s.phase === 'show') this.onContinue();
      return;
    }
    const info: SubmitInfo = {
      at: ev.at, guess: !!ev.guess, latencyValid: !!ev.latencyValid, text: ev.text,
      latencyMs: ev.latencyMs ?? (s.shownAt !== undefined ? ev.at - s.shownAt : undefined),
    };
    if (s.item.kind === 'probe') return this.onPredict(s.item, info, !!ev.assisted);
    if (s.item.kind === 'completion') {
      if (ev.assisted) return this.discardAssisted('completion', s.item.completion.id, info);
      s.submit = info;
      s.phase = 'grading';
      this.fx.push({ type: 'run-completion', completion: s.item.completion, text: ev.text });
    }
  }

  /** An insert the learner did not type (12+ non-whitespace characters at once): not counted. */
  private discardAssisted(kind: ItemKind, id: string, info: SubmitInfo): void {
    const s = this.s;
    s.graded.push({
      itemId: id, kind, shownAt: s.shownAt ?? info.at, answer: info.text, verdict: 'assisted', guess: info.guess, implicitGuess: false,
      assisted: true, latencyMs: info.latencyMs, latencyValid: false, scored: false,
    });
    this.feedback({ kind: 'assisted' });
    // Same item, fresh latency clock.
    s.shownAt = info.at;
  }

  private parOf(item: { code: string; parSec: number }, kind: ItemKind, answerChars: number): { self: number; abs: number } {
    const p = { kind, codeLines: lineCount(item.code), answerChars, parSec: item.parSec };
    return { self: parSelf(p, this.s.speed), abs: parAbs(p, this.s.speed) };
  }

  private onPredict(item: Extract<PickedItem, { kind: 'probe' }>, info: SubmitInfo, assisted: boolean): void {
    const s = this.s;
    const probe = item.probe;
    const role = s.request?.role ?? stepRole(s.step);
    if (assisted) return this.discardAssisted('predict', probe.id, info);
    const tok = commentToken(s.lang);
    const answer = answerText(info.text, tok);
    const g = gradePredict(answer, probe, s.lang, s.typeSensitive);
    if (g.empty) {
      this.feedback({ kind: 'empty' });
      return;
    }
    const par = this.parOf(probe, 'predict', g.actual.length);
    const dontKnow = g.verdict === 'dont-know';
    // Implicit guess: under .3 x par_self, or a copied 5+ character literal. A strict mutant match is
    // explained by its belief (the alias belief predicts the list as written), so it is no guess.
    const fast = info.latencyValid && info.latencyMs !== undefined && info.latencyMs < PARAMS.latency.implicitGuess * par.self;
    const implicit = !dontKnow && (fast || (g.copiedLiteral && !g.mutant));
    const guess = !dontKnow && (info.guess || implicit);
    const entry: GradedEntry = {
      itemId: probe.id, kind: 'predict', shownAt: s.shownAt ?? info.at, answer, verdict: g.verdict, guess, implicitGuess: implicit,
      assisted: false, latencyMs: info.latencyMs, latencyValid: info.latencyValid, correct: g.correct, scored: g.verdict !== 'format-only',
    };
    if (g.misconceptionId) entry.misconceptionId = g.misconceptionId;
    s.graded.push(entry);
    const ev: EvidenceInput = {
      conceptId: s.conceptId, kind: 'predict', source: s.source, at: info.at, itemId: probe.id, siblingGroup: probe.group,
      correct: g.correct ?? null, verdict: g.verdict, guessFlag: info.guess, latencyValid: info.latencyValid, parSelfMs: par.self,
      parAbsMs: par.abs, g: probe.answerSpaceG, weight: item.confounded ? PARAMS.halfWeight : 1, learnT: PARAMS.learnT.feedback,
    };
    if (info.latencyMs !== undefined) ev.latencyMs = info.latencyMs;
    if (implicit) ev.implicitGuess = true;
    if (g.mutant) this.fx.push({ type: 'mutant', mutantId: g.mutant.id, response: 'match' });

    // ---- format-only: a note, no evidence, the next item
    if (g.verdict === 'format-only') {
      this.feedback({ kind: 'format', note: g.note ?? `right idea; written as ${g.actual}` });
      if (role === 'probe') return this.enterProbe('probe2');
      return this.pick(role, 'probe', { misconceptionId: s.request?.misconceptionId ?? (role === 'reprobe' || role === 'second-sibling' ? s.focus?.id : undefined) });
    }

    // ---- correct
    if (g.correct === true) {
      ev.avoidedMisconceptionIds = g.avoidedMisconceptionIds;
      this.fx.push({ type: 'item-stat', itemId: probe.id, correct: true, ms: info.latencyMs });
      this.feedback({ kind: 'correct', ms: info.latencyMs, guess });
      switch (role) {
        case 'probe':
          this.evidence(ev);
          if (!guess && s.recentCorrectGroups.some((gr) => gr !== probe.group)) return this.exit('tested-out');
          return this.enterProbe('probe2');
        case 'probe2':
          this.evidence(ev);
          // A flagged guess adds no steps now: P stays capped and a later interleaved item checks it.
          return this.exit(guess ? 'partial' : 'tested-out');
        case 'reprobe':
        case 'second-sibling':
          if (!guess && s.focus) {
            ev.suppresses = s.focus.id;
            ev.learnT = PARAMS.learnT.boost;
          }
          this.evidence(ev);
          return this.exit(guess ? 'confirmed' : 'fixed');
        default:
          this.evidence(ev);
          return this.exit(guess ? 'partial' : 'learned');
      }
    }

    // ---- wrong or don't know
    this.fx.push({ type: 'item-stat', itemId: probe.id, correct: false, ms: info.latencyMs });
    s.wrongItems.push({ code: probe.code, answer: answer || '?', actual: g.actual });
    const mutant = g.mutant;
    if ((role === 'probe' || role === 'probe2') && mutant && !s.slipped) {
      // BELIEF-CHECK(M): the evidence waits for y / n.
      s.pending = { evidence: ev, entry: s.graded.length - 1, mutant };
      s.focus = { id: mutant.misconceptionId, belief: mutant.belief, confirmed: false, probe, mutant };
      s.step = 'belief-check';
      s.phase = 'show';
      s.shownAt = info.at;
      this.render({ kind: 'belief-check', belief: mutant.belief, probe, answer, actual: g.actual });
      return;
    }
    if (mutant) Object.assign(ev, { misconceptionId: mutant.misconceptionId, misconceptionOdds: unconfirmedOdds(mutant), belief: mutant.belief });
    this.evidence(ev);
    this.feedback({ kind: 'wrong', actual: g.actual });
    switch (role) {
      case 'probe':
      case 'probe2':
        return this.enterUnknown();
      case 'reprobe':
        // The lesson is requested now; the second sibling item covers the call.
        this.requestLesson();
        return this.enterSecondSibling();
      case 'second-sibling':
        return this.enterEscalate();
      default:
        return this.exit('partial');
    }
  }

  private onBelief(yes: boolean): void {
    const s = this.s;
    const f = s.focus!;
    const p = s.pending;
    s.pending = undefined;
    if (p) {
      const entry = s.graded[p.entry];
      if (entry) s.graded[p.entry] = { ...entry, beliefConfirmed: yes, misconceptionId: p.mutant.misconceptionId };
      this.fx.push({ type: 'mutant', mutantId: p.mutant.id, response: yes ? 'yes' : 'no' });
      if (yes) {
        this.evidence({
          ...p.evidence, misconceptionId: p.mutant.misconceptionId, beliefConfirmed: true,
          misconceptionOdds: PARAMS.misconception.odds.confirmed, belief: p.mutant.belief,
        });
        s.focus = { ...f, confirmed: true };
        return this.enterRefute();
      }
      // n: a slip. Half-weight wrong evidence, no misconception update, one more PROBE.
      this.evidence({ ...p.evidence, misconceptionId: p.mutant.misconceptionId, beliefConfirmed: false, weight: Math.min(p.evidence.weight ?? 1, PARAMS.halfWeight) });
      s.slipped = true;
      s.focus = undefined;
      return this.enterProbe('probe');
    }
    // Belief check at ROUTE (a stored candidate, no answer on screen).
    if (yes) {
      this.evidence({
        conceptId: s.conceptId, kind: 'predict', source: s.source, at: this.at, correct: false, guessFlag: false, latencyValid: false,
        misconceptionId: f.id, beliefConfirmed: true, misconceptionOdds: PARAMS.misconception.odds.confirmed, belief: f.belief,
        weight: PARAMS.halfWeight, learnT: 0,
      });
      s.focus = { ...f, confirmed: true };
      return this.enterRefute();
    }
    s.focus = undefined;
    return this.enterProbe('probe');
  }

  private onContrastPick(ev: Extract<AtomEvent, { type: 'pick' }>): void {
    const s = this.s;
    const c = s.contrast!;
    const right = s.rightFirst ? 1 : 2;
    const correct = ev.choice === right;
    const latencyMs = ev.latencyMs ?? (s.shownAt !== undefined ? ev.at - s.shownAt : undefined);
    const code = `${c.wrong}\n${c.right}`;
    const par = this.parOf({ code, parSec: 5 }, 'contrast-pick', 1);
    s.graded.push({
      itemId: c.id, kind: 'contrast-pick', shownAt: s.shownAt ?? ev.at, answer: String(ev.choice), verdict: correct ? 'correct' : 'wrong',
      guess: !!ev.guess, implicitGuess: false, assisted: false, latencyMs, latencyValid: !!ev.latencyValid, correct, scored: true,
    });
    const e: EvidenceInput = {
      conceptId: s.conceptId, kind: 'contrast-pick', source: s.source, at: ev.at, itemId: c.id, correct, verdict: correct ? 'correct' : 'wrong',
      guessFlag: !!ev.guess, latencyValid: !!ev.latencyValid, parSelfMs: par.self, parAbsMs: par.abs,
      // A confirmed refutation followed by a correct contrast pick: learning transition .3.
      learnT: correct && s.focus?.confirmed ? PARAMS.learnT.boost : PARAMS.learnT.feedback,
    };
    if (latencyMs !== undefined) e.latencyMs = latencyMs;
    this.evidence(e);
    this.feedback(correct ? { kind: 'correct', ms: latencyMs } : { kind: 'note', text: `it was ${right}` });
    this.enterReveal();
  }

  private onCompletionGraded(grade: CompletionGrade): void {
    const s = this.s;
    const item = s.item;
    const info = s.submit;
    if (item?.kind !== 'completion' || !info) return;
    const c = item.completion;
    s.submit = undefined;
    if (grade.empty) {
      s.phase = 'show';
      this.feedback({ kind: 'empty', message: 'fill every blank (Tab moves between them)' });
      return;
    }
    const answerChars = c.solutions.join('').length;
    const par = this.parOf(c, 'completion', answerChars);
    const implicit = info.latencyValid && info.latencyMs !== undefined && info.latencyMs < PARAMS.latency.implicitGuess * par.self;
    const guess = info.guess || implicit;
    const retry = s.retries > 0;
    s.graded.push({
      itemId: c.id, kind: 'completion', shownAt: s.shownAt ?? info.at, answer: (grade.fills ?? []).join(' | '), verdict: grade.pass ? 'correct' : 'wrong',
      guess, implicitGuess: implicit, assisted: false, latencyMs: info.latencyMs, latencyValid: info.latencyValid, correct: grade.pass,
      misconceptionId: grade.misconceptionId, scored: true,
    });
    const e: EvidenceInput = {
      conceptId: s.conceptId, kind: 'completion', source: s.source, at: info.at, itemId: c.id, siblingGroup: c.group, correct: grade.pass,
      verdict: grade.pass ? 'correct' : 'wrong', guessFlag: info.guess, latencyValid: info.latencyValid, parSelfMs: par.self, parAbsMs: par.abs,
      learnT: PARAMS.learnT.feedback,
    };
    if (info.latencyMs !== undefined) e.latencyMs = info.latencyMs;
    if (implicit) e.implicitGuess = true;
    this.fx.push({ type: 'item-stat', itemId: c.id, correct: grade.pass, ms: info.latencyMs });
    if (grade.pass) {
      e.production = true;
      // After a worked example or the escalation lesson, a passing completion is a big learning step.
      if ((s.step === 'escalate' && s.lessonState === 'ready') || (s.exampleShown && (s.step === 'completion' || s.step === 'completion2'))) {
        e.learnT = PARAMS.learnT.boost;
      }
      this.evidence(e);
      this.feedback({ kind: 'correct', ms: info.latencyMs, guess }, blankTarget(grade, 1));
      return this.afterCompletion();
    }
    if (grade.misconceptionId) Object.assign(e, { misconceptionId: grade.misconceptionId, misconceptionOdds: 3 });
    // The retry is the same item and the same idea: it counts at half weight.
    if (retry) e.weight = PARAMS.halfWeight;
    this.evidence(e);
    const blank = grade.wrongFillBlank ?? 1;
    const target: FeedbackTarget = grade.crashLine !== undefined && !grade.checkFailed ? { line: grade.crashLine } : blankTarget(grade, blank);
    this.feedback({ kind: 'check', message: grade.message ?? 'not yet', blank }, target);
    if (!retry) {
      s.retries = 1;
      s.phase = 'show';
      s.shownAt = this.at;
      return;
    }
    // Second failure: reveal the fill (scratch code, not the project), then go on.
    s.phase = 'reveal-fill';
    this.render({ kind: 'completion-reveal', completion: c });
  }

  private afterCompletion(): void {
    const s = this.s;
    switch (s.step) {
      case 'completion':
        return s.large ? this.enterCompletion(2) : this.enterFinal();
      case 'completion2':
        return this.enterFinal();
      case 'escalate':
        return this.exit('escalated');
    }
  }
}

function blankTarget(grade: CompletionGrade, blank: number): FeedbackTarget {
  const line = grade.blankLines[blank - 1];
  return line !== undefined && line >= 0 ? { line } : 'answer';
}

function stepRole(step: AtomStep): ItemRole {
  switch (step) {
    case 'probe':
    case 'probe2':
    case 'reprobe':
    case 'second-sibling':
    case 'final-predict':
    case 'example':
    case 'example2':
    case 'completion':
    case 'completion2':
    case 'escalate':
      return step;
    default:
      return 'probe';
  }
}

/** Curated (hand-written) mutants count x3 unconfirmed, model ones x2. */
function unconfirmedOdds(m: Pick<StoredMutant, 'source'>): number {
  return m.source === 'curated' ? 3 : PARAMS.misconception.odds.unconfirmed;
}

function carrying(p: StoredProbe, misconceptionId: string): StoredMutant | undefined {
  return p.mutants.find((m) => m.misconceptionId === misconceptionId && !m.ambiguous);
}

export function itemId(item: PickedItem): string {
  switch (item.kind) {
    case 'probe':
      return item.probe.id;
    case 'example':
      return item.example.id;
    case 'completion':
      return item.completion.id;
    case 'contrast':
      return item.contrast.id;
  }
}

function itemGroup(item: PickedItem): string | undefined {
  switch (item.kind) {
    case 'probe':
      return item.probe.group;
    case 'example':
      return item.example.group;
    case 'completion':
      return item.completion.group;
    case 'contrast':
      return undefined;
  }
}

// ---------------------------------------------------------------- default item picker

export interface PickContext {
  now: number;
  /** Constructs the learner knows (P >= .5) plus the target's; absent = no construct filter. */
  allowedConstructs?: ReadonlySet<string>;
  /**
   * Item ids shown within 7 days (AtomCache.seenIds): examples carry no stats, so their show times
   * live only in the cache's metadata.
   */
  seen?: ReadonlySet<string>;
}

const blanksOf = (code: string) => new Set([...code.matchAll(/\[\[(\d+)\]\]/g)].map((m) => m[1])).size;

/**
 * A reference implementation of the pad's 'pick' over one StoredAtom: unseen in 7 days, not shown
 * in this atom, from another sibling group; items carrying the requested misconception first;
 * probes whose constructs are all allowed, else the one with the fewest unknown constructs
 * (confounded: recorded at weight .5); discriminating probes and less-used items first.
 */
export function chooseItem(
  atom: Pick<StoredAtom, 'probes' | 'examples' | 'completions' | 'contrasts'>,
  req: PickRequest,
  ctx: PickContext,
): PickedItem | undefined {
  const fresh = <T extends { id: string; group?: string; stats?: { seenAt: number[]; n: number } }>(xs: readonly T[]): T[] =>
    xs.filter((x) => !req.excludeIds.includes(x.id) && !(x.group && req.excludeGroups.includes(x.group))
      && !seenWithin7Days(x.stats, ctx.now) && !ctx.seen?.has(x.id));
  switch (req.kind) {
    case 'probe': {
      let pool = fresh(atom.probes);
      if (req.misconceptionId) {
        const with_ = pool.filter((p) => carrying(p, req.misconceptionId!));
        pool = with_.length || req.requireMisconception ? with_ : pool;
      }
      if (!pool.length) return undefined;
      const order = (a: StoredProbe, b: StoredProbe) =>
        Number(b.discriminating) - Number(a.discriminating) || a.stats.n - b.stats.n || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const allowed = ctx.allowedConstructs;
      if (!allowed) return { kind: 'probe', probe: [...pool].sort(order)[0] };
      const unknown = (p: StoredProbe) => p.constructs.filter((c) => !allowed.has(c)).length;
      const clean = pool.filter((p) => unknown(p) === 0);
      if (clean.length) return { kind: 'probe', probe: clean.sort(order)[0] };
      const best = [...pool].sort((a, b) => unknown(a) - unknown(b) || order(a, b))[0];
      return { kind: 'probe', probe: best, confounded: true };
    }
    case 'example': {
      const e = fresh(atom.examples)[0];
      return e ? { kind: 'example', example: e } : undefined;
    }
    case 'completion': {
      const pool = fresh(atom.completions).sort((a, b) => a.stats.n - b.stats.n);
      const want = req.blanks ?? 1;
      // A 2-blank request has no fallback (the large tag goes on to the final predict); 1 takes any.
      const c = pool.find((x) => blanksOf(x.code) === want) ?? (want === 1 ? pool[0] : undefined);
      return c ? { kind: 'completion', completion: c } : undefined;
    }
    case 'contrast': {
      const c = atom.contrasts.find((x) => !req.excludeIds.includes(x.id) && (!req.misconceptionId || x.misconceptionId === req.misconceptionId));
      return c ? { kind: 'contrast', contrast: c } : undefined;
    }
  }
}
