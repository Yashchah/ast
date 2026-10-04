// The Atom Pad (spec V1-6, conceptAtom; reused by V1-7 placement and V1-9 sprints): the in-memory
// practice tab beside the code where every atom, placement item and sprint item runs.
//
// This module holds the decision logic and is written against two small interfaces, so it runs
// (and is tested) under node without VS Code:
// - PadEditor: the practice document (open, replace text, insert a snippet, cursor, decorations,
//   context keys, close, learner changes, tab closed, window focus). src/atoms/padfs.ts implements
//   it with the VS Code API; MemoryPadEditor below is the in-memory implementation for tests.
// - PadUi: QuickPicks (which-pattern items, the 'tick what you have used' picker) and the status flash.
//
// Pieces:
// - PadSession: one open pad. show(render) applies a render.ts PadRender (full-text replace, or an
//   emptied document plus a snippet built from parts), feedback() adds after-text decorations and a
//   hold (600 ms ok / 1.5 s otherwise) that delays the next render, next() awaits the next input.
//   It owns latency (from render, window focused; invalid when focus was lost or > 60 s), the
//   assisted-insert guard (a non-coach change inserting >= 12 non-whitespace characters at once) and
//   double-Esc detection for flows that are not atoms.
// - AtomPad: owns the session, routes the commands (submit, submit-guess, y/n, pick 1/2/3, Esc,
//   Leave practice, tab closed) and runs atoms by driving src/atoms/stepMachine.ts, interpreting its
//   effects IN ORDER (pick, render, feedback, evidence, seen/item-stat/mutant, run-completion,
//   request-lesson, review, exit), then performs the EXIT steps.
// - Item helpers (askPredict, askCompletion, askTraceback, askContrast, evidence builders) shared by
//   src/atoms/placementRun.ts and src/atoms/sprint.ts.
// The learner always writes their own project code: the pad only ever edits its own in-memory document.

import type {
  AtomPattern, AtomResult, EvidenceSource, ItemKind, Lang, PatternCard, Runner, StoredAtom, StoredCompletion, StoredContrast,
  StoredProbe, TracebackItem,
} from '../contracts';
import { parAbs, parSelf, PARAMS, touch } from '../evidence';
import { concept, conceptChip, upsertConcepts, type EvidenceInput } from '../learner';
import type { InteractionLock, LockKind } from '../lock';
import type { ConceptState, Learner } from '../types';
import type { AtomCache } from './cache';
import {
  answerText, commentToken, gradeCompletion, gradePredict, gradeTraceback, parseTracebackAnswer, type CommentToken,
  type CompletionGrade, type PredictGrade, type TracebackGrade,
} from './grade';
import {
  feedbackDecoration, keysUsed, renderView, type Feedback, type LessonText, type PadDecoration, type PadRender, type PadView,
  type SnippetPart,
} from './render';
import { hash53 } from './rng';
import {
  atomDeadline, chooseItem, startAtom, stepAtom, type AtomEffect, type AtomEvent, type AtomRunState, type FeedbackTarget,
  type PickedItem, type PickRequest, type StepOutput,
} from './stepMachine';
import { constructTag, tagInfo } from './tags';

// =====================================================================================================
// Constants and identifiers
// =====================================================================================================

export const PAD = {
  /** Two Esc presses within this window leave (placement and sprints; atoms use the step machine's). */
  doubleEscMs: 600,
  /** A non-coach change inserting this many non-whitespace characters at once is an assisted insert. */
  assistChars: 12,
  /** Latency above this is not usable (spec CONFIDENCE). */
  maxLatencyMs: 60_000,
  /** How long feedback stays before the next render: 'ok' 600 ms, everything else 1.5 s. */
  hold: { correct: 600, other: 1500 },
  /** A placement or sprint item left untouched this long ends the flow (the lock is never held forever). */
  idleMs: 5 * 60_000,
  flashMs: 3000,
} as const;

export const PAD_SCHEME = 'deliberate-pad';
export const PAD_EXT: Record<Lang, string> = { python: '.dlbpy', javascript: '.dlbjs', typescript: '.dlbts' };

/** deliberate-pad-python / -javascript / -typescript. */
export function padLanguageId(lang: Lang): string {
  return `deliberate-pad-${lang}`;
}

/** '/atom.dlbpy' and friends: the path of the pad document in the 'deliberate-pad' file system. */
export function padPath(lang: Lang): string {
  return `/atom${PAD_EXT[lang]}`;
}

/** The pad language of a pad file path, if it is one. */
export function padLangOf(path: string): Lang | undefined {
  const ext = /\.[a-z]+$/i.exec(path)?.[0].toLowerCase();
  return (Object.keys(PAD_EXT) as Lang[]).find((l) => PAD_EXT[l] === ext);
}

// =====================================================================================================
// Interfaces the pad is written against
// =====================================================================================================

export interface Disposable {
  dispose(): void;
}

/** A learner (non-coach) change to the pad document. */
export interface PadChange {
  /** Text inserted by each content change of one change event. */
  inserted: string[];
  /** An undo or redo: never counted as an assisted insert. */
  undoRedo: boolean;
}

export type PadContextKey = 'deliberate.atomFocused' | 'deliberate.padAwait';

/** The practice document (VS Code: src/atoms/padfs.ts VscodePadEditor; tests: MemoryPadEditor). */
export interface PadEditor {
  /** Open (or reveal) the pad document for this language beside the code; remembers the previous editor. */
  open(lang: Lang): Promise<void>;
  readonly isOpen: boolean;
  /** Is the VS Code window focused (latency is valid only while it is)? */
  readonly windowFocused: boolean;
  text(): string;
  /** Replace the whole document (a coach edit: never reported through onDidChange). */
  setText(text: string): Promise<void>;
  /** Empty the document and insert a snippet built from parts at (0,0) (appendText / appendPlaceholder). */
  insertSnippet(parts: readonly SnippetPart[]): Promise<void>;
  /** Move the cursor (0-based); with endColumn, select line:column..endColumn. Reveals it. */
  select(line: number, column: number, endColumn?: number): void;
  /** Replace every pad decoration with this set. */
  decorate(decorations: readonly PadDecoration[]): void;
  setContext(key: PadContextKey, value: boolean | string): void;
  /** Save (in memory), close the tab, restore the previous editor and its selection. */
  close(): Promise<void>;
  onDidChange(listener: (e: PadChange) => void): Disposable;
  /** The learner closed the pad tab (not fired for close()). */
  onDidClose(listener: () => void): Disposable;
  onDidChangeWindowFocus(listener: (focused: boolean) => void): Disposable;
}

export interface PickOneOptions {
  title: string;
  placeholder?: string;
  items: string[];
  signal?: AbortSignal;
}

export interface PickManyOptions {
  title: string;
  placeholder?: string;
  items: { label: string; detail?: string }[];
  signal?: AbortSignal;
}

/** QuickPicks and the status flash (VS Code: src/atoms/padfs.ts VscodePadUi). */
export interface PadUi {
  /** One choice (0-based), or undefined for Esc / dismissed / aborted. */
  pickOne(o: PickOneOptions): Promise<number | undefined>;
  /** The ticked items (0-based, possibly none), or undefined for Esc / dismissed / aborted. */
  pickMany(o: PickManyOptions): Promise<number[] | undefined>;
  /** setStatusBarMessage. */
  flash(text: string, ms?: number): void;
}

export interface PadClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Call fn after ms unless disposed first. */
  timer(ms: number, fn: () => void): Disposable;
}

export const systemClock: PadClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
  timer: (ms, fn) => {
    const h = setTimeout(fn, Math.max(0, ms));
    return { dispose: () => clearTimeout(h) };
  },
};

// =====================================================================================================
// Small pure helpers
// =====================================================================================================

export function nonWhitespace(s: string): number {
  return s.replace(/\s+/g, '').length;
}

/** One change event inserting 12+ non-whitespace characters (paste, AI insert, snippet expansion). */
export function isAssistedInsert(inserted: readonly string[]): boolean {
  return inserted.reduce((n, t) => n + nonWhitespace(t), 0) >= PAD.assistChars;
}

const answerLineRe = (tok: CommentToken) => (tok === '#' ? /^\s*#\s*->/ : /^\s*\/\/\s*->/);

/** 0-based index of the last '# -> ' / '// -> ' line. */
export function lastAnswerLine(text: string, tok: CommentToken): number | undefined {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const re = answerLineRe(tok);
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return i;
  return undefined;
}

/** How long a piece of feedback stays before the next render. */
export function holdMs(fb: Feedback): number {
  switch (fb.kind) {
    case 'correct':
      return PAD.hold.correct;
    case 'empty':
    case 'assisted':
      return 0;
    default:
      return PAD.hold.other;
  }
}

/** The render's fixed text (comment and code lines; answer lines and, for snippets, code lines left out). */
function frameOf(text: string, tok: CommentToken, snippet: boolean): string {
  const re = answerLineRe(tok);
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !re.test(l) && (!snippet || l.trimStart().startsWith(tok)))
    .map((l) => l.trimEnd())
    .join('\n')
    .trimEnd();
}

const codeLineCount = (code: string) => code.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n').length;

/** par_self and par_abs (ms) of an item for this learner. */
export function itemPar(
  kind: ItemKind, code: string, answerChars: number, parSec: number, speed: { cps: number; speedFactor: number },
): { self: number; abs: number } {
  const p = { kind, codeLines: codeLineCount(code), answerChars, parSec };
  return { self: parSelf(p, speed), abs: parAbs(p, speed) };
}

export function learnerSpeed(l: Learner): { cps: number; speedFactor: number } {
  return { cps: l.cps || PARAMS.latency.cps, speedFactor: l.speedFactor || 1 };
}

/**
 * Constructs the learner is believed to know (their tag's concept has P >= .5), basics that map to
 * no tag, and the target tag's own constructs (spec V1-6 item choice).
 */
export function allowedConstructs(atom: Pick<StoredAtom, 'probes'>, learner: Learner, lang: Lang, targetTag: string): Set<string> {
  const all = new Set(atom.probes.flatMap((p) => p.constructs));
  const out = new Set<string>();
  for (const c of all) {
    const tag = constructTag(c, lang);
    if (!tag || tag === targetTag || (concept(learner, tag)?.mastery ?? 0) >= 0.5) out.add(c);
  }
  return out;
}

/** Unverified content (no runtime): mutant matching is off, so probes are shown without mutants. */
export function withoutMutants(p: StoredProbe): StoredProbe {
  return p.mutants.length ? { ...p, mutants: [], discriminating: false } : p;
}

export function formatSeconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** '<concept>: <before> -> <after> (41s)': the only place besides the log card that names the concept. */
export function atomFlash(name: string, before: string, after: string, ms: number): string {
  return `${name}: ${before} -> ${after} (${formatSeconds(ms)})`;
}

export interface PatternCardInput {
  conceptId: string;
  tag: string;
  pattern: AtomPattern;
  lastRatio?: number;
}

/**
 * Add or update the concept's card in the Pattern Deck (by conceptId): canonical name and texts from
 * the pattern, use cases unioned, seen times and addedAt kept.
 */
export function upsertPatternCard(deck: PatternCard[], input: PatternCardInput, now: number): PatternCard {
  const p = input.pattern;
  const fresh = {
    conceptId: input.conceptId, tag: input.tag, kind: p.kind, name: p.name, useWhen: p.useWhen, template: p.template, rule: p.rule,
    pitfall: p.pitfall,
  };
  const i = deck.findIndex((c) => c.conceptId === input.conceptId);
  if (i < 0) {
    const card: PatternCard = { ...fresh, useCases: [...new Set(p.useCases.filter((u) => u.trim()))], useCaseSeenAt: {}, addedAt: now };
    if (input.lastRatio !== undefined) card.lastRatio = input.lastRatio;
    deck.push(card);
    return card;
  }
  const old = deck[i];
  const card: PatternCard = {
    ...old,
    ...Object.fromEntries(Object.entries(fresh).filter(([, v]) => typeof v === 'string' && v.trim() !== '')),
    useCases: [...new Set([...(old.useCases ?? []), ...p.useCases].filter((u) => u.trim()))],
    useCaseSeenAt: old.useCaseSeenAt ?? {},
    addedAt: old.addedAt ?? now,
  } as PatternCard;
  if (input.lastRatio !== undefined) card.lastRatio = input.lastRatio;
  deck[i] = card;
  return card;
}

/** Make sure the learner model has a concept for an atom (evidence on unknown concepts is dropped). */
export function ensureConcept(learner: Learner, id: string, tag: string, name: string, now: number): ConceptState {
  const c = concept(learner, id);
  if (c) return c;
  const info = tagInfo(tag);
  upsertConcepts(learner, [{ id, name: name || id, tag, kind: info?.kind, prerequisites: [] }], now);
  return concept(learner, id)!;
}

// =====================================================================================================
// Latency
// =====================================================================================================

/** Latency from render while the window is focused; invalid once focus was lost or past 60 s. */
export class LatencyClock {
  private start: number | undefined;
  private shownAt = 0;
  private lost = false;

  constructor(private readonly now: () => number, focused: boolean) {
    this.restart(focused);
  }

  restart(focused: boolean): void {
    this.shownAt = this.now();
    this.lost = false;
    this.start = focused ? this.shownAt : undefined;
  }

  focus(focused: boolean): void {
    if (focused) {
      if (this.start === undefined) this.start = this.now();
    } else if (this.start !== undefined) this.lost = true;
  }

  read(): { ms: number; valid: boolean } {
    const ms = Math.max(0, this.now() - (this.start ?? this.shownAt));
    return { ms, valid: this.start !== undefined && !this.lost && ms <= PAD.maxLatencyMs };
  }
}

// =====================================================================================================
// PadSession: one open pad
// =====================================================================================================

export type AnswerInput =
  | { type: 'submit'; at: number; text: string; guess: boolean; latencyMs: number; latencyValid: boolean; assisted: boolean }
  /** Ctrl+Enter on a reading step. */
  | { type: 'continue'; at: number }
  | { type: 'yn'; at: number; yes: boolean }
  | { type: 'pick'; at: number; choice: number; latencyMs: number; latencyValid: boolean };

export type AbortReason = 'leave' | 'closed' | 'external';

export type PadInput =
  | AnswerInput
  /** Every Esc press (atoms pass each one to the step machine). */
  | { type: 'esc'; at: number }
  /** Leave practice, the tab closed, or the InteractionLock aborted the flow. */
  | { type: 'abort'; at: number; reason: AbortReason }
  /** The deadline given to next() passed. */
  | { type: 'timeout'; at: number }
  /** Internal events (the escalation lesson landed, 'until' settled). */
  | { type: 'event'; at: number; event: unknown };

export type FlowStop = 'esc' | 'abort' | 'timeout' | 'event';

interface SessionHost {
  readonly editor: PadEditor;
  readonly clock: PadClock;
  readonly focused: boolean;
  notifyAwaiting(s: PadSession): void;
}

export class PadSession {
  readonly tok: CommentToken;
  /** What is on screen now. */
  render?: PadRender;
  closed = false;
  private renderDecos: PadDecoration[] = [];
  private fbDecos: PadDecoration[] = [];
  /** A repaint in flight (an assisted answer being discarded); renders and input wait for it. */
  private repaint: Promise<void> | undefined;
  private queue: PadInput[] = [];
  private waiter: ((i: PadInput) => void) | undefined;
  private waitTimer: Disposable | undefined;
  private holdUntil = 0;
  private lastEscAt: number | undefined;
  private readonly latency: LatencyClock;
  private assisted = false;
  private shown = 0;

  constructor(private readonly host: SessionHost, readonly lang: Lang) {
    this.tok = commentToken(lang);
    this.latency = new LatencyClock(() => host.clock.now(), host.focused);
  }

  private now(): number {
    return this.host.clock.now();
  }

  /** Waiting for learner input right now. */
  get waiting(): boolean {
    return this.waiter !== undefined;
  }

  /** When the current render appeared. */
  get shownAt(): number {
    return this.shown;
  }

  /** Forget queued input from a previous flow (the session is being reused). */
  reset(): void {
    this.queue = [];
    this.lastEscAt = undefined;
  }

  // ------------------------------------------------------------ output

  /** Show a render (after the hold of the last feedback): text or snippet, cursor, decorations, padAwait. */
  async show(r: PadRender): Promise<void> {
    if (this.closed) return;
    await this.hold();
    await this.settleRepaint();
    if (this.closed) return;
    this.render = r;
    this.renderDecos = [...r.decorations];
    this.fbDecos = [];
    this.assisted = false;
    await this.paint(r, true);
    this.host.editor.setContext('deliberate.padAwait', r.await);
    this.shown = this.now();
    this.latency.restart(this.host.focused);
  }

  private async paint(r: PadRender, moveCursor: boolean): Promise<void> {
    const ed = this.host.editor;
    if (r.snippet) await ed.insertSnippet(r.snippet);
    else {
      await ed.setText(r.text);
      if (moveCursor && r.answerLine !== undefined) ed.select(r.answerLine, r.answerColumn ?? 0, r.answerSelectEnd);
    }
    ed.decorate(this.decorations());
  }

  private decorations(): PadDecoration[] {
    return [...this.renderDecos, ...this.fbDecos];
  }

  /** The line feedback for 'answer' goes on: the last answer line in the document. */
  answerLine(): number {
    const text = this.host.editor.text();
    return lastAnswerLine(text, this.tok) ?? this.render?.answerLine ?? Math.max(0, text.split('\n').length - 1);
  }

  /**
   * After-text feedback on a line; later renders wait for its hold (override with holdMsOverride).
   * 'assisted' also discards the inserted answer: the item is put back as rendered (empty answer
   * line, or fresh ___ blanks) before the note shows, so the pasted text cannot simply be resubmitted.
   */
  feedback(fb: Feedback, target: FeedbackTarget = 'answer', holdMsOverride?: number): void {
    if (this.closed) return;
    const r = this.render;
    if (fb.kind === 'assisted' && r) {
      this.fbDecos = [];
      this.assisted = false;
      const prev = this.repaint ?? Promise.resolve();
      this.repaint = prev
        .then(() => (this.closed ? undefined : this.paint(r, true)))
        .catch(() => undefined)
        .then(() => this.addFeedback(fb, target, 0));
      return;
    }
    this.addFeedback(fb, target, holdMsOverride);
  }

  /** Wait for a pending repaint (an assisted answer being discarded). */
  private async settleRepaint(): Promise<void> {
    while (this.repaint) {
      const p = this.repaint;
      await p;
      if (this.repaint === p) this.repaint = undefined;
    }
  }

  private addFeedback(fb: Feedback, target: FeedbackTarget, holdMsOverride?: number): void {
    if (this.closed) return;
    const line = target === 'answer' ? this.answerLine() : Math.max(0, target.line);
    const d = feedbackDecoration(fb, line);
    this.fbDecos = [...this.fbDecos.filter((x) => x.line !== line), d];
    this.host.editor.decorate(this.decorations());
    const hold = holdMsOverride ?? holdMs(fb);
    if (hold > 0) this.holdUntil = Math.max(this.holdUntil, this.now() + hold);
  }

  /** Wait until the last feedback has been visible long enough. */
  async hold(): Promise<void> {
    const ms = this.holdUntil - this.now();
    this.holdUntil = 0;
    if (ms > 0) await this.host.clock.sleep(ms);
  }

  text(): string {
    return this.host.editor.text();
  }

  // ------------------------------------------------------------ input

  /** The next input: a queued Esc/abort/event first, else wait (until the deadline, if given). */
  async next(deadline?: number): Promise<PadInput> {
    await this.settleRepaint();
    const queued = this.queue.shift();
    if (queued) return queued;
    if (this.closed) return { type: 'abort', at: this.now(), reason: 'external' };
    if (this.waiter) throw new Error('PadSession.next: already waiting');
    return new Promise<PadInput>((resolve) => {
      this.waiter = resolve;
      if (deadline !== undefined && Number.isFinite(deadline)) {
        this.waitTimer = this.host.clock.timer(Math.max(0, deadline - this.now()), () => this.deliver({ type: 'timeout', at: this.now() }));
      }
      this.host.notifyAwaiting(this);
    });
  }

  /**
   * The next answer to the item on screen. Two Esc presses within 600 ms stop, as do Leave practice
   * and closing the tab (both 'esc': the learner chose to stop), the InteractionLock's abort ('abort'),
   * the deadline and a wake event the caller accepts; single Esc presses and other events are skipped.
   */
  async answer(opts: { deadline?: () => number | undefined; wake?: (event: unknown) => boolean } = {}): Promise<AnswerInput | { stop: FlowStop }> {
    for (;;) {
      const i = await this.next(opts.deadline?.());
      switch (i.type) {
        case 'esc':
          if (this.escPressed(i.at)) return { stop: 'esc' };
          continue;
        case 'abort':
          return { stop: i.reason === 'external' ? 'abort' : 'esc' };
        case 'timeout':
          return { stop: 'timeout' };
        case 'event':
          if (opts.wake?.(i.event)) return { stop: 'event' };
          continue;
        default:
          return i;
      }
    }
  }

  /** Double-Esc detection for placement and sprints. */
  escPressed(at: number): boolean {
    const double = this.lastEscAt !== undefined && at - this.lastEscAt <= PAD.doubleEscMs;
    this.lastEscAt = double ? undefined : at;
    return double;
  }

  private deliver(i: PadInput): boolean {
    const w = this.waiter;
    if (!w) return false;
    this.waiter = undefined;
    this.waitTimer?.dispose();
    this.waitTimer = undefined;
    w(i);
    return true;
  }

  /** Queue (or deliver) an Esc, abort or internal event. These are never dropped. */
  post(i: PadInput): void {
    if (!this.deliver(i)) this.queue.push(i);
  }

  /** Ctrl+Enter / Ctrl+Shift+Enter. Dropped unless the pad is waiting for an answer (or a 'read' continue). */
  submit(guess: boolean): 'submit' | 'continue' | undefined {
    const r = this.render;
    if (!this.waiter || !r) return undefined;
    const at = this.now();
    if (r.await === 'read') {
      this.deliver({ type: 'continue', at });
      return 'continue';
    }
    if (r.await !== 'answer') return undefined;
    const lat = this.latency.read();
    const assisted = this.assisted;
    if (assisted) {
      // The answer is discarded: the same item continues with a fresh latency clock.
      this.assisted = false;
      this.latency.restart(this.host.focused);
    }
    this.deliver({ type: 'submit', at, text: this.host.editor.text(), guess, latencyMs: lat.ms, latencyValid: lat.valid && !assisted, assisted });
    return 'submit';
  }

  yesNo(yes: boolean): boolean {
    if (!this.waiter || this.render?.await !== 'yn') return false;
    return this.deliver({ type: 'yn', at: this.now(), yes });
  }

  /** 1 / 2 / 3 on a pick2 / pick3 step. */
  pick(choice: number): boolean {
    const r = this.render;
    if (!this.waiter || !r) return false;
    const max = r.await === 'pick2' ? 2 : r.await === 'pick3' ? 3 : 0;
    if (!Number.isInteger(choice) || choice < 1 || choice > max) return false;
    const lat = this.latency.read();
    return this.deliver({ type: 'pick', at: this.now(), choice, latencyMs: lat.ms, latencyValid: lat.valid });
  }

  esc(): void {
    this.post({ type: 'esc', at: this.now() });
  }

  abort(reason: AbortReason): void {
    this.post({ type: 'abort', at: this.now(), reason });
  }

  focus(focused: boolean): void {
    this.latency.focus(focused);
  }

  /** A learner change: the assisted-insert guard, and an undo past a render puts the render back. */
  onLearnerChange(change: PadChange): void {
    const r = this.render;
    if (this.closed || !r) return;
    if (change.undoRedo) {
      if (frameOf(this.host.editor.text(), this.tok, !!r.snippet) !== frameOf(r.text, this.tok, !!r.snippet)) {
        this.paint(r, true).catch(() => undefined);
      }
      return;
    }
    if (r.await === 'answer' && isAssistedInsert(change.inserted)) this.assisted = true;
  }

  /** Close the pad (after the last hold): wake a waiting flow with an abort, close the tab. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.hold();
    if (this.closed) return;
    this.closed = true;
    this.deliver({ type: 'abort', at: this.now(), reason: 'external' });
    this.queue = [];
    this.host.editor.setContext('deliberate.padAwait', '');
    await this.host.editor.close();
  }
}

// =====================================================================================================
// AtomPad
// =====================================================================================================

export interface LessonRequest {
  /** project.prefetch key: 'lesson:<concept>:<misconceptionId>'. */
  key: string;
  conceptId: string;
  misconceptionId: string;
  belief: string;
  /** The wrong answers of this atom (code, answer, actual), for the lesson prompt. */
  items: { code: string; answer: string; actual: string }[];
}

/** One compact sidebar log card (the coach turns it into a feed Card). */
export interface PadLogCard {
  kind: 'atom' | 'placement' | 'sprint';
  at: number;
  title: string;
  lines: string[];
  conceptIds: string[];
  atom?: AtomResult & { pattern: AtomPattern; name: string };
  data?: unknown;
}

export interface PadDeps {
  editor: PadEditor;
  ui: PadUi;
  clock?: PadClock;
  learner: () => Learner;
  /** recordEvidence(learner, e) (the Store binds the log sink to the learner). */
  recordEvidence: (e: EvidenceInput) => unknown;
  /** One AtomCache per language. */
  cache: (lang: Lang) => AtomCache | undefined;
  /** The runner for a language (undefined: no runtime). */
  runner: (lang: Lang) => Runner | undefined;
  /** Execution consent and workspace trust (default: allowed). Without it completions are never shown. */
  canRun?: (lang: Lang) => boolean;
  /**
   * The escalation lesson: the coach returns project.prefetch[key] at once when it is there, else
   * enqueues the EscalationLesson job (low effort, priority 0) and resolves when it lands
   * (undefined when the job fails or is dropped).
   */
  lesson?: (req: LessonRequest) => LessonText | undefined | Promise<LessonText | undefined>;
  onLog?: (card: PadLogCard) => void;
  /** Every finished atom (task.atomRuns, resumePhase, ...). */
  onExit?: (result: AtomResult) => void;
  /** detector.markProgress(now, 'atom finished') when the task is building (the callback decides). */
  markProgress?: (now: number, why: string) => void;
  /** The InteractionLock the caller acquires (pad.acquire registers the pad's abort callback). */
  lock?: InteractionLock;
  /** A probe was picked from a cached key: top it up if it is low (Stock.refillIfLow; cheap, single-flight). */
  refill?: (lang: Lang, key: string) => void;
  /** Override for the step machine's 'review' effect (default: nextReview = min(nextReview, now + inMs)). */
  scheduleReview?: (conceptId: string, inMs: number) => void;
}

export interface AtomRunOptions {
  /** Learner concept id (default atom.conceptId; aliases resolve). */
  conceptId?: string;
  placementDontKnow?: boolean;
  /** Misconceptions the learner confirmed with 'y' before (from the evidence log). */
  confirmedMisconceptions?: string[];
  /** Groups answered right (non-guess) in the last 7 days, from the evidence log if possible. */
  recentCorrectGroups?: string[];
  /** Evidence source (default 'atom'). */
  source?: EvidenceSource;
  taskId?: string;
  /** Leave the pad open afterwards (another flow follows at once). */
  keepOpen?: boolean;
}

/** What the coach depends on (tests inject a fake). */
export interface AtomRunner {
  run(atom: StoredAtom, opts?: AtomRunOptions): Promise<AtomResult>;
}

interface LessonEvent {
  kind: 'lesson';
  run: number;
  lesson?: LessonText;
}

const isLessonEvent = (e: unknown): e is LessonEvent => !!e && typeof e === 'object' && (e as LessonEvent).kind === 'lesson';

interface AtomCtx {
  id: number;
  atom: StoredAtom;
  key: string;
  lang: Lang;
  conceptId: string;
  opts: AtomRunOptions;
  session: PadSession;
  state: AtomRunState;
  result?: AtomResult;
  rendered: boolean;
  lastRatio?: number;
}

interface Flow {
  kind: LockKind;
  /** 'external' = the InteractionLock's abort; 'leave' / 'closed' = the learner chose to stop (as Esc). */
  onAbort?: (reason: AbortReason) => void;
}

let runIds = 0;

export class AtomPad implements AtomRunner {
  session: PadSession | undefined;
  /** Concepts with a guess-flagged correct answer this session (one interleaved sprint item each). */
  readonly guessFlagged = new Set<string>();
  /** Concepts whose atom ended tested-out / fixed / learned this session (sprint selectionGap). */
  readonly atomPassed = new Set<string>();
  private flow: Flow | undefined;
  private awaiters: ((r: PadRender | undefined) => void)[] = [];
  private readonly latencyClocks = new Set<LatencyClock>();
  private readonly subs: Disposable[];

  constructor(readonly deps: PadDeps) {
    this.subs = [
      deps.editor.onDidChange((c) => this.session?.onLearnerChange(c)),
      deps.editor.onDidClose(() => this.onTabClosed()),
      deps.editor.onDidChangeWindowFocus((f) => {
        this.session?.focus(f);
        for (const c of this.latencyClocks) c.focus(f);
      }),
    ];
  }

  get editor(): PadEditor {
    return this.deps.editor;
  }

  get clock(): PadClock {
    return this.deps.clock ?? systemClock;
  }

  get focused(): boolean {
    return this.deps.editor.windowFocused;
  }

  now(): number {
    return this.clock.now();
  }

  learner(): Learner {
    return this.deps.learner();
  }

  /** Is a flow (atom, placement, sprint) running? */
  get busy(): boolean {
    return this.flow !== undefined;
  }

  get activeFlow(): LockKind | undefined {
    return this.flow?.kind;
  }

  /** The runner, when there is one and execution is allowed. */
  runnerFor(lang: Lang): Runner | undefined {
    if (this.deps.canRun && !this.deps.canRun(lang)) return undefined;
    return this.deps.runner(lang);
  }

  /** lock.acquire(kind, abort-this-pad). Undefined when another modal flow holds the lock. */
  acquire(kind: LockKind): (() => void) | undefined {
    if (!this.deps.lock) return () => undefined;
    return this.deps.lock.acquire(kind, () => this.abortActive());
  }

  /**
   * Mark a flow as running; the returned function ends it. onAbort (Leave practice, the tab closed
   * outside an item, the InteractionLock's abort) closes its QuickPicks and makes it stop.
   */
  beginFlow(kind: LockKind, onAbort?: (reason: AbortReason) => void): () => void {
    if (this.flow) throw new Error(`AtomPad: '${String(this.flow.kind)}' is running; '${String(kind)}' cannot start`);
    const f: Flow = { kind, onAbort };
    this.flow = f;
    return () => {
      if (this.flow !== f) return;
      this.flow = undefined;
      // A pad left open (keepOpen) waits for nothing: y / n / 1-3 type normally again.
      if (this.session && !this.session.closed) this.editor.setContext('deliberate.padAwait', '');
    };
  }

  /** The InteractionLock's abort: end the running flow as Esc (evidence kept), or close an idle pad. */
  abortActive(): void {
    this.endActive('external');
  }

  private endActive(reason: AbortReason): void {
    const f = this.flow;
    if (f) {
      try {
        f.onAbort?.(reason);
      } finally {
        this.session?.abort(reason);
      }
      return;
    }
    if (this.session) void this.closeSession();
  }

  /** A latency clock that follows window focus (QuickPick items). Call done() when the item ends. */
  latencyClock(): { read: () => { ms: number; valid: boolean }; done: () => void } {
    const c = new LatencyClock(() => this.now(), this.focused);
    this.latencyClocks.add(c);
    return { read: () => c.read(), done: () => void this.latencyClocks.delete(c) };
  }

  // ------------------------------------------------------------ session

  /** Open the pad for a language (or reuse the one a previous flow left open). */
  async openSession(lang: Lang): Promise<PadSession> {
    const s = this.session;
    if (s && !s.closed) {
      if (s.lang === lang && this.editor.isOpen) {
        s.reset();
        return s;
      }
      await this.closeSession();
    }
    await this.editor.open(lang);
    const pad = this;
    const host: SessionHost = {
      editor: this.editor,
      clock: this.clock,
      get focused() {
        return pad.focused;
      },
      notifyAwaiting: (x) => pad.notifyAwaiting(x),
    };
    const fresh = new PadSession(host, lang);
    this.session = fresh;
    return fresh;
  }

  async closeSession(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = undefined;
    await s.close();
  }

  /** The learner closed the pad tab: Esc for the running flow (evidence kept). */
  private onTabClosed(): void {
    if (!this.session) return;
    if (this.flow) this.endActive('closed');
    else void this.closeSession();
  }

  private notifyAwaiting(s: PadSession): void {
    if (s !== this.session) return;
    const ws = this.awaiters;
    this.awaiters = [];
    for (const w of ws) w(s.render);
  }

  /** Resolves when the pad next waits for learner input (tests and headless drivers). */
  whenAwaiting(): Promise<PadRender | undefined> {
    const s = this.session;
    if (s?.waiting) return Promise.resolve(s.render);
    return new Promise((resolve) => this.awaiters.push(resolve));
  }

  // ------------------------------------------------------------ commands

  /** deliberate.atomSubmit (guess = false) / deliberate.atomSubmitGuess (guess = true). */
  submit(guess = false): boolean {
    const s = this.session;
    if (!s) return false;
    const text = s.text();
    const kind = s.submit(guess);
    if (kind === 'submit') {
      const l = this.learner();
      l.keyUse ??= {};
      for (const k of keysUsed(answerText(text, s.tok), guess)) l.keyUse[k] = (l.keyUse[k] ?? 0) + 1;
    }
    return kind !== undefined;
  }

  /** deliberate.padYes / deliberate.padNo. */
  yesNo(yes: boolean): boolean {
    return this.session?.yesNo(yes) ?? false;
  }

  /** deliberate.padPick with args 1 / 2 / 3. */
  pick(choice: number): boolean {
    return this.session?.pick(Number(choice)) ?? false;
  }

  /** deliberate.atomEscape: every press counts; two within 600 ms leave (an idle pad left open just closes). */
  escape(): void {
    const s = this.session;
    if (!s) return;
    if (this.flow) s.esc();
    else if (s.escPressed(this.now())) void this.closeSession();
  }

  /** 'Deliberate: Leave practice'. */
  leave(): void {
    this.endActive('leave');
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs.length = 0;
    this.latencyClocks.clear();
  }

  // ------------------------------------------------------------ atoms

  /** Run one atom in the pad (the caller holds the InteractionLock). */
  async run(atom: StoredAtom, opts: AtomRunOptions = {}): Promise<AtomResult> {
    const end = this.beginFlow('atom');
    let ctx: AtomCtx | undefined;
    try {
      const learner = this.learner();
      const at = this.now();
      const c = ensureConcept(learner, opts.conceptId ?? atom.conceptId, atom.tag, atom.pattern.name, at);
      const session = await this.openSession(atom.lang);
      const start = startAtom({
        conceptId: c.id, conceptKey: atom.key, tag: atom.tag, lang: atom.lang, pattern: atom.pattern, concept: c, at,
        typeSensitive: tagInfo(atom.tag)?.typeSensitive, speed: learnerSpeed(learner), recentCorrectGroups: opts.recentCorrectGroups,
        placementDontKnow: opts.placementDontKnow, confirmedMisconceptions: opts.confirmedMisconceptions, source: opts.source,
        stateBefore: conceptChip(learner, c),
      });
      ctx = { id: ++runIds, atom, key: atom.key, lang: atom.lang, conceptId: c.id, opts, session, state: start.state, rendered: false };
      await this.applyAtom(ctx, start);
      while (!ctx.result) {
        const input = await session.next(atomDeadline(ctx.state));
        const ev = this.atomEvent(ctx, input);
        if (ev) await this.applyAtom(ctx, stepAtom(ctx.state, ev));
      }
      await this.exitAtom(ctx);
      return ctx.result;
    } catch (err) {
      await this.closeSession().catch(() => undefined);
      throw err;
    } finally {
      end();
    }
  }

  private atomEvent(ctx: AtomCtx, i: PadInput): AtomEvent | undefined {
    switch (i.type) {
      case 'submit':
        return { type: 'submit', at: i.at, text: i.text, guess: i.guess, latencyMs: i.latencyMs, latencyValid: i.latencyValid, assisted: i.assisted };
      case 'continue':
        return { type: 'continue', at: i.at };
      case 'yn':
        return { type: 'yn', at: i.at, yes: i.yes };
      case 'pick':
        return { type: 'pick', at: i.at, choice: i.choice, latencyMs: i.latencyMs, latencyValid: i.latencyValid };
      case 'esc':
        return { type: 'esc', at: i.at };
      case 'abort':
        return { type: 'abort', at: i.at };
      case 'timeout':
        return { type: 'tick', at: i.at };
      case 'event':
        return isLessonEvent(i.event) && i.event.run === ctx.id ? { type: 'lesson', at: i.at, lesson: i.event.lesson } : undefined;
    }
  }

  /** Interpret the step machine's effects in order; 'pick' and 'run-completion' answer at once. */
  private async applyAtom(ctx: AtomCtx, out: StepOutput): Promise<void> {
    ctx.state = out.state;
    const cache = this.deps.cache(ctx.lang);
    for (const e of out.effects) {
      switch (e.type) {
        case 'pick': {
          const item = this.pickItem(ctx, e.request);
          await this.applyAtom(ctx, stepAtom(ctx.state, { type: 'item', at: this.now(), item }));
          break;
        }
        case 'render': {
          const r = renderView(e.view, { lang: ctx.lang, keyUse: this.learner().keyUse });
          await ctx.session.show(r);
          ctx.rendered = true;
          break;
        }
        case 'feedback':
          ctx.session.feedback(e.feedback, e.target);
          break;
        case 'evidence':
          this.atomEvidence(ctx, e.evidence);
          break;
        case 'seen':
          cache?.markSeen(ctx.key, e.itemId, e.at);
          break;
        case 'item-stat':
          cache?.recordItemStat(ctx.key, e.itemId, e.correct, e.ms);
          break;
        case 'mutant':
          cache?.recordMutantResponse(ctx.key, e.mutantId, e.response);
          break;
        case 'run-completion':
          await this.gradeAtomCompletion(ctx, e.completion, e.text);
          break;
        case 'request-lesson':
          await this.requestLesson(ctx, e);
          break;
        case 'review':
          this.scheduleReview(e.conceptId, e.inMs);
          break;
        case 'exit':
          ctx.result = { ...e.result };
          break;
      }
    }
  }

  /** The 'pick' effect: the cache's atom (else the one passed in), unseen, other groups, known constructs. */
  private pickItem(ctx: AtomCtx, req: PickRequest): PickedItem | undefined {
    const cache = this.deps.cache(ctx.lang);
    const stored = cache?.has(req.conceptKey) ? cache.get(req.conceptKey) : undefined;
    const atom = stored ?? (req.conceptKey === ctx.atom.key ? ctx.atom : undefined);
    if (!atom) return undefined;
    // Completions are graded by running them: none without a runner or consent.
    if ((req.kind === 'completion') && !this.runnerFor(ctx.lang)) return undefined;
    const now = this.now();
    const item = chooseItem(atom, req, {
      now,
      allowedConstructs: allowedConstructs(atom, this.learner(), ctx.lang, atom.tag),
      seen: new Set(cache?.seenIds(req.conceptKey) ?? []),
    });
    // Seeded keys are topped up in the background below 6 unseen (Stock decides, single-flight).
    if (req.kind === 'probe' && stored) this.deps.refill?.(ctx.lang, req.conceptKey);
    if (item?.kind === 'probe' && !atom.verified) return { ...item, probe: withoutMutants(item.probe) };
    return item;
  }

  private atomEvidence(ctx: AtomCtx, input: EvidenceInput): void {
    const e: EvidenceInput = { ...input };
    if (!ctx.atom.verified) e.unverified = true;
    if (ctx.opts.taskId) e.taskId = ctx.opts.taskId;
    this.deps.recordEvidence(e);
    if (e.correct === true) {
      if (e.guessFlag || e.implicitGuess) this.guessFlagged.add(e.conceptId);
      if (e.latencyValid && e.latencyMs && e.parAbsMs) ctx.lastRatio = Math.round((e.latencyMs / e.parAbsMs) * 100) / 100;
    }
  }

  private async gradeAtomCompletion(ctx: AtomCtx, completion: StoredCompletion, text: string): Promise<void> {
    const runner = this.runnerFor(ctx.lang);
    let grade: CompletionGrade;
    let note: string | undefined;
    ctx.session.feedback({ kind: 'note', text: 'running...' }, 'answer', 0);
    if (!runner) {
      grade = notRunGrade();
      note = 'cannot run code here (Esc Esc to leave)';
    } else {
      try {
        grade = await gradeCompletion(text, completion, runner, ctx.lang, { allowImports: tagInfo(ctx.atom.tag)?.allowedImports });
      } catch (err) {
        grade = notRunGrade();
        note = `could not run the check: ${errorText(err)}`;
      }
    }
    await this.applyAtom(ctx, stepAtom(ctx.state, { type: 'completion-graded', at: this.now(), grade }));
    if (note) ctx.session.feedback({ kind: 'note', text: note }, 'answer', 0);
  }

  private async requestLesson(ctx: AtomCtx, e: Extract<AtomEffect, { type: 'request-lesson' }>): Promise<void> {
    const req: LessonRequest = { key: e.key, conceptId: e.conceptId, misconceptionId: e.misconceptionId, belief: e.belief, items: e.items };
    let got: LessonText | undefined | Promise<LessonText | undefined>;
    try {
      got = this.deps.lesson?.(req);
    } catch {
      got = undefined;
    }
    if (got && typeof (got as Promise<unknown>).then === 'function') {
      const post = (lesson: LessonText | undefined) => {
        if (!ctx.result && this.session === ctx.session) ctx.session.post({ type: 'event', at: this.now(), event: { kind: 'lesson', run: ctx.id, lesson } satisfies LessonEvent });
      };
      (got as Promise<LessonText | undefined>).then(post, () => post(undefined));
      return;
    }
    // Already prefetched (or no lesson source): answer at once.
    await this.applyAtom(ctx, stepAtom(ctx.state, { type: 'lesson', at: this.now(), lesson: got as LessonText | undefined }));
  }

  private scheduleReview(conceptId: string, inMs: number): void {
    if (this.deps.scheduleReview) return this.deps.scheduleReview(conceptId, inMs);
    const c = concept(this.learner(), conceptId);
    if (!c) return;
    const now = this.now();
    const at = now + inMs;
    if (!(c.nextReview > 0) || c.nextReview > at) {
      c.nextReview = at;
      touch(c, now);
    }
  }

  /** EXIT: state after, close (save in memory, restore the previous editor), deck, flash, log, progress. */
  private async exitAtom(ctx: AtomCtx): Promise<void> {
    const result = ctx.result!;
    const learner = this.learner();
    const c = concept(learner, ctx.conceptId);
    result.stateAfter = c ? conceptChip(learner, c) : result.stateBefore;
    if (result.misconceptionId && c?.misconceptions[result.misconceptionId]) result.misconceptionStatus = c.misconceptions[result.misconceptionId].status;
    if (result.path === 'tested-out' || result.path === 'fixed' || result.path === 'learned') this.atomPassed.add(ctx.conceptId);
    if (!ctx.opts.keepOpen) await this.closeSession();
    else await ctx.session.hold();
    const now = this.now();
    const name = c?.name || ctx.atom.pattern.name;
    if (ctx.rendered || result.items > 0) {
      upsertPatternCard(learner.patternDeck, { conceptId: ctx.conceptId, tag: ctx.atom.tag, pattern: ctx.atom.pattern, lastRatio: ctx.lastRatio }, now);
    }
    this.deps.ui.flash(atomFlash(name, String(result.stateBefore), String(result.stateAfter), result.ms), PAD.flashMs);
    this.deps.onLog?.(atomLogCard(result, name, ctx.atom.pattern, c, now));
    this.deps.markProgress?.(now, 'atom finished');
    this.deps.onExit?.(result);
  }
}

function notRunGrade(): CompletionGrade {
  return { empty: true, pass: false, blankLines: [], checkFailed: false, timedOut: false, ms: 0 };
}

function errorText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/\s+/g, ' ').slice(0, 80);
}

const PATH_WORDS: Record<string, string> = {
  'tested-out': 'tested out', confirmed: 'belief confirmed', fixed: 'belief fixed', learned: 'learned', partial: 'partly learned',
  escalated: 'lesson given', aborted: 'left early',
};

export function atomLogCard(result: AtomResult, name: string, pattern: AtomPattern, c: ConceptState | undefined, now: number): PadLogCard {
  const lines = [`${PATH_WORDS[result.path] ?? result.path} · ${result.items} item${result.items === 1 ? '' : 's'} · ${formatSeconds(result.ms)}`];
  if (result.misconceptionId) {
    const belief = c?.misconceptions[result.misconceptionId]?.belief || result.misconceptionId;
    lines.push(`Belief: ${belief} (${result.misconceptionStatus ?? 'candidate'})`);
  }
  if (pattern.kind === 'semantics' && pattern.rule.trim()) lines.push(`Rule: ${pattern.rule.trim()}`);
  else if (pattern.useWhen.trim()) lines.push(`Pattern: ${pattern.name} - ${pattern.useWhen.trim()}`);
  if (pattern.kind === 'shape' && pattern.template.trim()) lines.push(pattern.template.trim());
  return {
    kind: 'atom', at: now, title: `${name}: ${result.stateBefore} -> ${result.stateAfter}`, lines, conceptIds: [result.conceptId],
    atom: { ...result, pattern, name },
  };
}

// =====================================================================================================
// Item helpers for placement and sprints
// =====================================================================================================

export interface ItemContext {
  lang: Lang;
  /** Learner.keyUse for the key legend. */
  keyUse?: Record<string, number>;
  speed: { cps: number; speedFactor: number };
  /** Give up waiting at this time (idle, or 'until' settled + 15 s). */
  deadline?: () => number | undefined;
  /** An internal event that ends the item (return true). */
  wake?: (event: unknown) => boolean;
}

export type Stopped = { stop: FlowStop };

export const isStopped = (x: unknown): x is Stopped => !!x && typeof x === 'object' && 'stop' in x;

export interface PredictOutcome {
  grade: PredictGrade;
  answer: string;
  at: number;
  latencyMs: number;
  latencyValid: boolean;
  /** Ctrl+Shift+Enter. */
  flagged: boolean;
  /** Too fast (< .3 x par_self) or a copied 5+ character literal. */
  implicit: boolean;
  /** Counts as a guess (flagged or implicit, never for '?'). */
  guess: boolean;
  par: { self: number; abs: number };
}

/** Show a predict item and wait for a gradable answer (empty answers re-prompt, assisted ones are discarded). */
export async function askPredict(
  session: PadSession, probe: StoredProbe, ctx: ItemContext & { typeSensitive: boolean; header?: string },
): Promise<PredictOutcome | Stopped> {
  const view: PadView = ctx.header ? { kind: 'probe', probe, header: ctx.header } : { kind: 'probe', probe };
  await session.show(renderView(view, { lang: ctx.lang, keyUse: ctx.keyUse }));
  for (;;) {
    const i = await session.answer({ deadline: ctx.deadline, wake: ctx.wake });
    if ('stop' in i) return i;
    if (i.type !== 'submit') continue;
    if (i.assisted) {
      session.feedback({ kind: 'assisted' });
      continue;
    }
    const answer = answerText(i.text, session.tok);
    const g = gradePredict(answer, probe, ctx.lang, ctx.typeSensitive);
    if (g.empty) {
      session.feedback({ kind: 'empty' });
      continue;
    }
    const par = itemPar('predict', probe.code, g.actual.length, probe.parSec, ctx.speed);
    const dontKnow = g.verdict === 'dont-know';
    const fast = i.latencyValid && i.latencyMs < PARAMS.latency.implicitGuess * par.self;
    const implicit = !dontKnow && (fast || (g.copiedLiteral && !g.mutant));
    return {
      grade: g, answer, at: i.at, latencyMs: i.latencyMs, latencyValid: i.latencyValid, flagged: i.guess, implicit,
      guess: !dontKnow && (i.guess || implicit), par,
    };
  }
}

/** 'ok 6s' / 'actual: X' / 'right idea; ...'. */
export function predictFeedback(o: PredictOutcome): Feedback {
  const g = o.grade;
  if (g.verdict === 'format-only') return { kind: 'format', note: g.note ?? `right idea; written as ${g.actual}` };
  if (g.correct === true) return { kind: 'correct', ms: o.latencyMs, guess: o.guess };
  return { kind: 'wrong', actual: g.actual };
}

export interface EvidenceBase {
  conceptId: string;
  source: EvidenceSource;
  /** .5 for a confounded probe. */
  weight?: number;
  unverified?: boolean;
  taskId?: string;
  delayedCheckFor?: string;
}

/**
 * Evidence for a predict answer (undefined for format-only, which records nothing). A mutant match
 * is an unconfirmed candidate: odds x3 for curated mutants, x2 for model ones (no belief check here).
 */
export function predictEvidence(probe: StoredProbe, o: PredictOutcome, base: EvidenceBase): EvidenceInput | undefined {
  const g = o.grade;
  if (g.verdict === 'format-only') return undefined;
  const e: EvidenceInput = {
    conceptId: base.conceptId, kind: 'predict', source: base.source, at: o.at, itemId: probe.id, siblingGroup: probe.group,
    correct: g.correct ?? null, verdict: g.verdict, guessFlag: o.flagged, latencyMs: o.latencyMs, latencyValid: o.latencyValid,
    parSelfMs: o.par.self, parAbsMs: o.par.abs, g: probe.answerSpaceG, weight: base.weight ?? 1,
  };
  if (o.implicit) e.implicitGuess = true;
  if (base.unverified) e.unverified = true;
  if (base.taskId) e.taskId = base.taskId;
  if (base.delayedCheckFor) e.delayedCheckFor = base.delayedCheckFor;
  if (g.correct === true) e.avoidedMisconceptionIds = g.avoidedMisconceptionIds;
  if (g.correct === false && g.mutant) {
    e.misconceptionId = g.mutant.misconceptionId;
    e.misconceptionOdds = g.mutant.source === 'curated' ? 3 : PARAMS.misconception.odds.unconfirmed;
    e.belief = g.mutant.belief;
  }
  return e;
}

export interface CompletionOutcome {
  grade: CompletionGrade;
  at: number;
  latencyMs: number;
  latencyValid: boolean;
  flagged: boolean;
  implicit: boolean;
  guess: boolean;
  par: { self: number; abs: number };
}

/**
 * Show a completion (snippet with ___ tab stops), wait for a filled submit and grade it by running
 * document + harness. One attempt. Returns { error } when the runner failed (nothing to score).
 */
export async function askCompletion(
  session: PadSession, completion: StoredCompletion, runner: Runner, ctx: ItemContext & { allowImports?: string[] },
): Promise<CompletionOutcome | Stopped | { error: string }> {
  await session.show(renderView({ kind: 'completion', completion }, { lang: ctx.lang, keyUse: ctx.keyUse }));
  const blankTarget = (g?: CompletionGrade, blank = 1): FeedbackTarget => {
    const line = g?.blankLines[blank - 1] ?? session.render?.blankLines?.[blank - 1];
    return line !== undefined && line >= 0 ? { line } : 'answer';
  };
  for (;;) {
    const i = await session.answer({ deadline: ctx.deadline, wake: ctx.wake });
    if ('stop' in i) return i;
    if (i.type !== 'submit') continue;
    if (i.assisted) {
      session.feedback({ kind: 'assisted' }, blankTarget());
      continue;
    }
    session.feedback({ kind: 'note', text: 'running...' }, blankTarget(), 0);
    let g: CompletionGrade;
    try {
      g = await gradeCompletion(i.text, completion, runner, ctx.lang, { allowImports: ctx.allowImports });
    } catch (err) {
      session.feedback({ kind: 'note', text: `could not run the check: ${errorText(err)}` }, 'answer', PAD.hold.other);
      return { error: errorText(err) };
    }
    if (g.empty) {
      session.feedback({ kind: 'empty', message: 'fill every blank (Tab moves between them)' }, blankTarget(g));
      continue;
    }
    const par = itemPar('completion', completion.code, completion.solutions.join('').length, completion.parSec, ctx.speed);
    const implicit = i.latencyValid && i.latencyMs < PARAMS.latency.implicitGuess * par.self;
    return { grade: g, at: i.at, latencyMs: i.latencyMs, latencyValid: i.latencyValid, flagged: i.guess, implicit, guess: i.guess || implicit, par };
  }
}

/** 'ok' on the first blank, or the failing check on the blank's line. */
export function completionFeedback(session: PadSession, o: CompletionOutcome): void {
  const g = o.grade;
  const blank = g.wrongFillBlank ?? 1;
  const line = g.crashLine !== undefined && !g.checkFailed ? g.crashLine : g.blankLines[(g.pass ? 1 : blank) - 1];
  const target: FeedbackTarget = line !== undefined && line >= 0 ? { line } : 'answer';
  session.feedback(g.pass ? { kind: 'correct', ms: o.latencyMs, guess: o.guess } : { kind: 'check', message: g.message ?? 'not yet', blank }, target);
}

export function completionEvidence(completion: StoredCompletion, o: CompletionOutcome, base: EvidenceBase): EvidenceInput {
  const g = o.grade;
  const e: EvidenceInput = {
    conceptId: base.conceptId, kind: 'completion', source: base.source, at: o.at, itemId: completion.id, siblingGroup: completion.group,
    correct: g.pass, verdict: g.pass ? 'correct' : 'wrong', guessFlag: o.flagged, latencyMs: o.latencyMs, latencyValid: o.latencyValid,
    parSelfMs: o.par.self, parAbsMs: o.par.abs, weight: base.weight ?? 1,
  };
  if (o.implicit) e.implicitGuess = true;
  if (g.pass) e.production = true;
  if (!g.pass && g.misconceptionId) {
    e.misconceptionId = g.misconceptionId;
    e.misconceptionOdds = 3;
  }
  if (base.unverified) e.unverified = true;
  if (base.taskId) e.taskId = base.taskId;
  return e;
}

export interface TracebackOutcome {
  grade: TracebackGrade;
  answer: string;
  at: number;
  latencyMs: number;
  latencyValid: boolean;
  /** '?' (no meaning pick follows). */
  dontKnow: boolean;
  par: { self: number; abs: number };
  /** The pad line number shown for the failing line (item.line + lineOffset). */
  padLine: number;
}

/** A traceback item: 'line N, ExceptionName' on the answer line, then a 1/2/3 meaning pick. */
export async function askTraceback(session: PadSession, item: TracebackItem, ctx: ItemContext): Promise<TracebackOutcome | Stopped> {
  const view = { lang: ctx.lang, keyUse: ctx.keyUse };
  const first = renderView({ kind: 'traceback', item }, view);
  await session.show(first);
  const lineOffset = first.lineOffset ?? 0;
  const padLine = item.line + lineOffset;
  const par = itemPar('traceback', item.code, `line ${padLine}, ${item.exception}`.length, 8, ctx.speed);
  for (;;) {
    const i = await session.answer({ deadline: ctx.deadline, wake: ctx.wake });
    if ('stop' in i) return i;
    if (i.type !== 'submit') continue;
    if (i.assisted) {
      session.feedback({ kind: 'assisted' });
      continue;
    }
    const answer = answerText(i.text, session.tok);
    const parsed = parseTracebackAnswer(answer);
    if (parsed.empty) {
      session.feedback({ kind: 'empty', message: 'type line N, ExceptionName (or ? for no idea)' });
      continue;
    }
    if (parsed.dontKnow) {
      const grade = gradeTraceback(answer, item, { lineOffset });
      return { grade, answer, at: i.at, latencyMs: i.latencyMs, latencyValid: i.latencyValid, dontKnow: true, par, padLine };
    }
    const firstLatency = { ms: i.latencyMs, valid: i.latencyValid };
    await session.show(renderView({ kind: 'traceback-meaning', item, answer }, view));
    for (;;) {
      const p = await session.answer({ deadline: ctx.deadline, wake: ctx.wake });
      if ('stop' in p) return p;
      if (p.type !== 'pick') continue;
      const grade = gradeTraceback(answer, item, { lineOffset, pick: p.choice });
      return {
        grade, answer, at: p.at, latencyMs: firstLatency.ms + p.latencyMs, latencyValid: firstLatency.valid && p.latencyValid,
        dontKnow: false, par, padLine,
      };
    }
  }
}

export function tracebackFeedback(item: TracebackItem, o: TracebackOutcome): Feedback {
  if (o.grade.correct) return { kind: 'correct', ms: o.latencyMs };
  const meaning = o.dontKnow ? '' : ` · meaning ${item.correctMeaning + 1}`;
  return { kind: 'wrong', actual: `line ${o.padLine}, ${item.exception}${meaning}` };
}

export function tracebackEvidence(item: TracebackItem, o: TracebackOutcome, base: EvidenceBase): EvidenceInput {
  const e: EvidenceInput = {
    conceptId: base.conceptId, kind: 'traceback', source: base.source, at: o.at, itemId: item.id, siblingGroup: item.siblingGroup,
    correct: o.dontKnow ? null : o.grade.correct, verdict: o.dontKnow ? 'dont-know' : o.grade.correct ? 'correct' : 'wrong',
    guessFlag: false, latencyMs: o.latencyMs, latencyValid: o.latencyValid, parSelfMs: o.par.self, parAbsMs: o.par.abs, weight: base.weight ?? 1,
  };
  if (!o.grade.correct && !o.dontKnow && o.grade.misconceptionId) {
    e.misconceptionId = o.grade.misconceptionId;
    e.misconceptionOdds = 3;
  }
  if (base.unverified) e.unverified = true;
  return e;
}

export interface ContrastOutcome {
  correct: boolean;
  choice: number;
  right: number;
  at: number;
  latencyMs: number;
  latencyValid: boolean;
  par: { self: number; abs: number };
}

/** '# Which one prints X?  1 / 2' answered with one key (display order fixed per contrast id). */
export async function askContrast(session: PadSession, contrast: StoredContrast, ctx: ItemContext): Promise<ContrastOutcome | Stopped> {
  const rightFirst = hash53(contrast.id) % 2 === 0;
  await session.show(renderView({ kind: 'contrast-pick', contrast, rightFirst }, { lang: ctx.lang, keyUse: ctx.keyUse }));
  const right = rightFirst ? 1 : 2;
  const par = itemPar('contrast-pick', `${contrast.wrong}\n${contrast.right}`, 1, 5, ctx.speed);
  for (;;) {
    const i = await session.answer({ deadline: ctx.deadline, wake: ctx.wake });
    if ('stop' in i) return i;
    if (i.type !== 'pick') continue;
    return { correct: i.choice === right, choice: i.choice, right, at: i.at, latencyMs: i.latencyMs, latencyValid: i.latencyValid, par };
  }
}

// =====================================================================================================
// In-memory surfaces: tests and headless drivers (the coach's flow tests can use them too)
// =====================================================================================================

class Listeners<T> {
  private ls: ((e: T) => void)[] = [];
  add(l: (e: T) => void): Disposable {
    this.ls.push(l);
    return { dispose: () => void (this.ls = this.ls.filter((x) => x !== l)) };
  }
  fire(e: T): void {
    for (const l of [...this.ls]) l(e);
  }
}

/** An in-memory PadEditor that records what the pad did and lets a test act as the learner. */
export class MemoryPadEditor implements PadEditor {
  doc = '';
  lang: Lang | undefined;
  isOpen = false;
  windowFocused = true;
  decorations: PadDecoration[] = [];
  contexts: Record<string, boolean | string> = {};
  cursor: { line: number; column: number; endColumn?: number } | undefined;
  snippet: SnippetPart[] | undefined;
  opens = 0;
  closes = 0;
  /** Every document the coach put on screen, in order. */
  history: string[] = [];
  private readonly changes = new Listeners<PadChange>();
  private readonly closed = new Listeners<void>();
  private readonly focus = new Listeners<boolean>();

  async open(lang: Lang): Promise<void> {
    if (!this.isOpen) this.opens++;
    this.lang = lang;
    this.isOpen = true;
    this.contexts['deliberate.atomFocused'] = true;
  }

  text(): string {
    return this.doc;
  }

  async setText(text: string): Promise<void> {
    this.doc = text;
    this.snippet = undefined;
    this.history.push(text);
  }

  async insertSnippet(parts: readonly SnippetPart[]): Promise<void> {
    this.snippet = [...parts];
    this.doc = parts.map((p) => ('text' in p ? p.text : p.value)).join('');
    this.history.push(this.doc);
    const first = this.doc.indexOf('___');
    if (first >= 0) {
      const before = this.doc.slice(0, first).split('\n');
      this.cursor = { line: before.length - 1, column: before[before.length - 1].length, endColumn: before[before.length - 1].length + 3 };
    }
  }

  select(line: number, column: number, endColumn?: number): void {
    this.cursor = endColumn === undefined ? { line, column } : { line, column, endColumn };
  }

  decorate(decorations: readonly PadDecoration[]): void {
    this.decorations = [...decorations];
  }

  setContext(key: PadContextKey, value: boolean | string): void {
    this.contexts[key] = value;
  }

  async close(): Promise<void> {
    if (this.isOpen) this.closes++;
    this.isOpen = false;
    this.decorations = [];
    this.contexts['deliberate.atomFocused'] = false;
  }

  onDidChange(listener: (e: PadChange) => void): Disposable {
    return this.changes.add(listener);
  }

  onDidClose(listener: () => void): Disposable {
    return this.closed.add(listener);
  }

  onDidChangeWindowFocus(listener: (focused: boolean) => void): Disposable {
    return this.focus.add(listener);
  }

  // ------------------------------------------------------------ the learner

  /** Type text at the end of a line, one character per change event (never an assisted insert). */
  typeAt(line: number, text: string): void {
    const lines = this.doc.split('\n');
    for (const ch of text) {
      lines[line] = (lines[line] ?? '') + ch;
      this.doc = lines.join('\n');
      this.changes.fire({ inserted: [ch], undoRedo: false });
    }
  }

  /** Type an answer after the last '# -> ' line; more lines become more '# -> ' lines. */
  answer(text: string): void {
    const tok = this.lang ? commentToken(this.lang) : '#';
    const line = lastAnswerLine(this.doc, tok);
    if (line === undefined) throw new Error('MemoryPadEditor.answer: no answer line');
    const lines = this.doc.split('\n');
    // Clear the template ('line ?, ?') if one is there.
    lines[line] = lines[line].replace(/(->\s?).*$/, '$1');
    this.doc = lines.join('\n');
    const [head, ...rest] = text.split('\n');
    this.typeAt(line, head);
    rest.forEach((l, k) => {
      const ls = this.doc.split('\n');
      ls.splice(line + 1 + k, 0, '');
      this.doc = ls.join('\n');
      this.typeAt(line + 1 + k, `${tok} -> ${l}`);
    });
  }

  /** Fill the ___ blanks in order, typing each fill. */
  fill(fills: readonly string[]): void {
    let k = 0;
    for (;;) {
      const i = this.doc.indexOf('___');
      if (i < 0 || k >= fills.length) break;
      this.doc = this.doc.slice(0, i) + this.doc.slice(i + 3);
      const fill = fills[k++];
      for (let j = 0; j < fill.length; j++) {
        const at = i + j;
        this.doc = this.doc.slice(0, at) + fill[j] + this.doc.slice(at);
        this.changes.fire({ inserted: [fill[j]], undoRedo: false });
      }
    }
  }

  /** Insert text in one change event at the end of the last answer line (a paste or an AI insert). */
  paste(text: string): void {
    const tok = this.lang ? commentToken(this.lang) : '#';
    const line = lastAnswerLine(this.doc, tok) ?? this.doc.split('\n').length - 1;
    const lines = this.doc.split('\n');
    lines[line] += text;
    this.doc = lines.join('\n');
    this.changes.fire({ inserted: [text], undoRedo: false });
  }

  /** Replace the document as an undo would. */
  undoTo(text: string): void {
    this.doc = text;
    this.changes.fire({ inserted: [text], undoRedo: true });
  }

  /** The learner closes the pad tab. */
  closeTab(): void {
    this.isOpen = false;
    this.closed.fire();
  }

  setWindowFocus(focused: boolean): void {
    this.windowFocused = focused;
    this.focus.fire(focused);
  }
}

/** A manual clock: sleep() advances time at once, timers fire as time is advanced. */
export class ManualClock implements PadClock {
  private timers: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;

  constructor(public t = 0) {}

  now(): number {
    return this.t;
  }

  timer(ms: number, fn: () => void): Disposable {
    const entry = { at: this.t + Math.max(0, ms), seq: ++this.seq, fn };
    this.timers.push(entry);
    return { dispose: () => void (this.timers = this.timers.filter((x) => x !== entry)) };
  }

  sleep(ms: number): Promise<void> {
    this.advance(ms);
    return Promise.resolve();
  }

  /** Move time forward, firing due timers in order. */
  advance(ms: number): void {
    const end = this.t + Math.max(0, ms);
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }

  get pending(): number {
    return this.timers.length;
  }
}

/** PadUi with scripted QuickPick answers (a function, or queues). */
export class ScriptedPadUi implements PadUi {
  flashes: string[] = [];
  oneCalls: PickOneOptions[] = [];
  manyCalls: PickManyOptions[] = [];
  pickOneAnswers: (number | undefined)[] = [];
  pickManyAnswers: (number[] | undefined)[] = [];
  onPickOne?: (o: PickOneOptions) => number | undefined | Promise<number | undefined>;

  async pickOne(o: PickOneOptions): Promise<number | undefined> {
    this.oneCalls.push(o);
    if (this.onPickOne) return this.onPickOne(o);
    return this.pickOneAnswers.shift();
  }

  async pickMany(o: PickManyOptions): Promise<number[] | undefined> {
    this.manyCalls.push(o);
    return this.pickManyAnswers.shift();
  }

  flash(text: string): void {
    this.flashes.push(text);
  }
}
