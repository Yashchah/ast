// Task gate UI (spec V1-8): step A pattern pick (QuickPick, canSelectMany) and step B plan pick
// (1 of 3 plans, fade 'full' only), graded locally from the prefetched key with gateCore.ts.
// 'I'd do it differently' (a title-bar button on both steps) and Esc are neutral: no evidence for
// that step. GateUi returns grades and evidence; the coach records them, routes the gaps
// (gateRouting / routeGaps) and flashes. The QuickPick sits behind a small PickPort so the flow is
// tested under node; VscodePickPort is the thin vscode implementation.

import * as vscode from 'vscode';
import type { FadeLevel, GatePattern, GatePlan, TaskGateState } from './contracts';
import type { EvidenceInput } from './learner';
import type { Learner } from './types';
import {
  GATE, fadeLevel, gateSteps, gateWords, gradePatternPick, gradePlanPick, patternTitle, routeGaps, shuffled,
  type GateRouting, type PatternGrade, type PlanGrade,
} from './gateCore';
import { systemClock, type Clock } from './jobs';

export const OWN_PLAN_TOOLTIP = "I'd do it differently";
export const PATTERN_PLACEHOLDER = 'Space toggles · Enter submits';
export const PLAN_PLACEHOLDER = 'Enter picks';
/** Cache miss: start building at once with this one-line card (never block). */
export const CACHE_MISS_CARD = 'Plan it in your head: which patterns, in what order?';
/** Step A feedback flash when there is no step B. */
export const PATTERN_FLASH_MS = 3000;

// =====================================================================================
// Ports
// =====================================================================================

export interface PickItem {
  label: string;
}

export type PickOutcome = { kind: 'accept'; selected: number[] } | { kind: 'own-plan' } | { kind: 'esc' };

export interface PickRequest {
  title: string;
  placeholder?: string;
  items: PickItem[];
  canSelectMany: boolean;
  buttonTooltip: string;
}

export interface PickPort {
  pick(req: PickRequest, signal?: AbortSignal): Promise<PickOutcome>;
}

/** InteractionLock's acquire (src/lock.ts): the gate is a modal flow. */
export interface GateLockPort {
  acquire(kind: 'gate', onAbort?: (reason: 'esc') => void): (() => void) | undefined;
}

// =====================================================================================
// Pure parts
// =====================================================================================

export interface GateTaskLike {
  id: string;
  title: string;
  /** 1-based task number for the title ('Task 2 · Word counter: ...'). */
  number?: number;
}

export type GatePrep = Pick<TaskGateState, 'patterns' | 'plans'>;

export interface GateNote {
  name: string;
  text: string;
  kind: 'missed' | 'lure' | 'workable';
}

export interface GateResult {
  /**
   * done: answered (step B may have been skipped with Esc); own-plan: 'I'd do it differently';
   * skipped: Esc on step A; no-pack: cache miss (show `card`, go build); not-needed: fade minimal
   * or solo; busy: another modal flow holds the lock (enqueue the gate action instead).
   */
  kind: 'done' | 'own-plan' | 'skipped' | 'no-pack' | 'not-needed' | 'busy';
  /** The step the learner left on (own-plan, skipped). */
  step?: 'A' | 'B';
  fade: FadeLevel;
  /** Step B was part of this gate. */
  stepB: boolean;
  pattern?: PatternGrade;
  plan?: PlanGrade;
  /** Plans in the order shown (plan.picked indexes this; pass it to routeGaps). */
  plansShown?: GatePlan[];
  /** Records for recordEvidence, in order. Empty for skipped, no-pack, not-needed, busy. */
  evidence: EvidenceInput[];
  /** Task.gate.result (planPicked indexes prep.plans, -1 when no plan was picked). */
  record?: NonNullable<TaskGateState['result']>;
  /** Step A feedback to flash for 3 s when there was no step B. */
  flash?: string;
  /** The 'Go build' flash: with whyFlawed (a question) after a flawed plan pick. */
  goBuild: string;
  /** Sidebar log card: missed patterns' useWhen, lures' whyNot, the workable plan after a flawed pick. */
  notes: GateNote[];
  /** Required pattern names: the task's pending pattern list in the tempo tooltip. */
  required: string[];
  /** The one-line card for a cache miss. */
  card?: string;
  /** Tasks with a flawed plan pick, this one included (persist it for the 3-task rule). */
  flawedTasks?: number;
  /** 2 flawed picks in one task: show guideApproach() as a background-generated card. */
  guideApproach: boolean;
  ms: number;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** A pack the gate can show: 3-7 patterns with unique non-empty names, at least one required, within the reading budget. */
export function gatePackProblem(prep: GatePrep | undefined): string | undefined {
  if (!prep || !Array.isArray(prep.patterns)) return 'no gate pack';
  const ps = prep.patterns;
  if (ps.length < 3 || ps.length > 7) return `expected 5 patterns, got ${ps.length}`;
  if (ps.some((p) => !p?.name?.trim())) return 'a pattern has no name';
  if (new Set(ps.map((p) => norm(p.name))).size !== ps.length) return 'duplicate pattern names';
  if (!ps.some((p) => p.required)) return 'no required pattern';
  if (gateWords(ps) > GATE.maxWords) return 'pattern names exceed the reading budget';
  return undefined;
}

/** 'Task 2 · Word counter: which patterns will you need?' */
export function stepATitle(task: GateTaskLike): string {
  const head = task.number !== undefined ? `Task ${task.number} · ${task.title.trim()}` : task.title.trim();
  return `${head}: which patterns will you need?`;
}

/** '1 Split words, count each in a dict' (numbered labels, no detail lines). */
export function planLabels(plans: readonly GatePlan[]): PickItem[] {
  return plans.map((p, i) => ({ label: `${i + 1} ${p.text.trim()}` }));
}

/** Step B runs: fade full, 3 plans with one workable within ±20% length, and the 50-word budget holds. */
export function stepBRuns(fade: FadeLevel, prep: GatePrep): boolean {
  return gateSteps(fade, prep.plans ?? []).stepB && gateWords(prep.patterns, prep.plans) <= GATE.maxWords;
}

/** Gate routing input for routeGaps: which gaps open an atom now, which become JIT offers. */
export function gateRouting(result: GateResult, prep: GatePrep, learner: Learner, taskConceptIds: readonly string[], now: number): GateRouting {
  return routeGaps({
    learner, taskConceptIds, now,
    patterns: prep.patterns,
    patternGrade: result.pattern,
    plans: result.plansShown,
    planGrade: result.plan,
  });
}

// =====================================================================================
// GateUi
// =====================================================================================

export interface GateRunOptions {
  /** Task.fade; default from decompositionP. */
  fade?: FadeLevel;
  /** P('decomposition'), used when fade is not given. */
  decompositionP?: number;
  /** Earlier tasks with a flawed plan pick (the 3-task rule). */
  priorFlawedTasks?: number;
  /** Shuffle source (tests pass a seeded one). */
  rng?: () => number;
  signal?: AbortSignal;
}

export interface GateUiDeps {
  pick?: PickPort;
  lock?: GateLockPort;
  clock?: Clock;
}

export class GateUi {
  private readonly pick: PickPort;
  private readonly clock: Clock;

  constructor(private readonly deps: GateUiDeps = {}) {
    this.pick = deps.pick ?? new VscodePickPort();
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Run the gate for a task. Call it only when gateDecision() says the gate runs; a minimal or solo
   * fade still returns 'not-needed' and records nothing.
   */
  async run(task: GateTaskLike, prep: GatePrep | undefined, opts: GateRunOptions = {}): Promise<GateResult> {
    const fade = opts.fade ?? fadeLevel(opts.decompositionP ?? Number.NaN);
    const required = (prep?.patterns ?? []).filter((p) => p?.required && p.name?.trim()).map((p) => p.name.trim());
    const base: GateResult = { kind: 'done', fade, stepB: false, evidence: [], notes: [], required, goBuild: 'Go build', guideApproach: false, ms: 0 };
    if (fade === 'minimal' || fade === 'solo') return { ...base, kind: 'not-needed' };
    const problem = gatePackProblem(prep);
    if (problem || !prep) return { ...base, kind: 'no-pack', card: CACHE_MISS_CARD };

    const ac = new AbortController();
    const outer = opts.signal;
    if (outer?.aborted) return { ...base, kind: 'skipped', step: 'A' };
    const onOuter = () => ac.abort();
    outer?.addEventListener('abort', onOuter, { once: true });
    let release: (() => void) | undefined;
    if (this.deps.lock) {
      release = this.deps.lock.acquire('gate', () => ac.abort());
      if (!release) {
        outer?.removeEventListener('abort', onOuter);
        return { ...base, kind: 'busy' };
      }
    }
    try {
      return await this.steps(task, prep, opts, base, ac.signal);
    } finally {
      outer?.removeEventListener('abort', onOuter);
      release?.();
    }
  }

  private async steps(task: GateTaskLike, prep: GatePrep, opts: GateRunOptions, base: GateResult, signal: AbortSignal): Promise<GateResult> {
    const rng = opts.rng ?? Math.random;
    const stepB = stepBRuns(base.fade, prep);
    const out: GateResult = { ...base, stepB };
    const t0 = this.clock.now();

    // Step A: pattern pick.
    const patterns = shuffled(prep.patterns, rng);
    const a = await this.pick.pick({
      title: stepATitle(task), placeholder: PATTERN_PLACEHOLDER, items: patterns.map((p) => ({ label: p.name.trim() })),
      canSelectMany: true, buttonTooltip: OWN_PLAN_TOOLTIP,
    }, signal);
    if (a.kind === 'esc') return { ...out, kind: 'skipped', step: 'A', ms: this.clock.now() - t0 };
    if (a.kind === 'own-plan') return { ...out, kind: 'own-plan', step: 'A', ms: this.clock.now() - t0 };
    const selected = [...new Set(a.selected)].map((i) => patterns[i]?.name).filter((n): n is string => !!n);
    const pg = gradePatternPick(prep.patterns, selected, this.clock.now(), task.id);
    out.pattern = pg;
    out.evidence.push(...pg.evidence);
    out.notes.push(...pg.notes);
    const record: NonNullable<TaskGateState['result']> = { selected: pg.selected, missed: pg.missed, lures: pg.lures, planPicked: -1, ms: 0 };
    out.record = record;

    if (!stepB) {
      out.flash = patternTitle(pg, false);
      record.ms = out.ms = this.clock.now() - t0;
      return out;
    }

    // Step B: plan pick, with step A's feedback in its title.
    const plans = shuffled(prep.plans, rng);
    out.plansShown = plans;
    const b = await this.pick.pick({
      title: patternTitle(pg, true), placeholder: PLAN_PLACEHOLDER, items: planLabels(plans), canSelectMany: false, buttonTooltip: OWN_PLAN_TOOLTIP,
    }, signal);
    record.ms = out.ms = this.clock.now() - t0;
    if (b.kind === 'own-plan') return { ...out, kind: 'own-plan', step: 'B' };
    const idx = b.kind === 'accept' ? b.selected[0] : undefined;
    if (idx === undefined || !plans[idx]) return out; // Esc (or nothing picked) on step B: neutral, step A stands
    const plg = gradePlanPick(plans, idx, { at: this.clock.now(), taskId: task.id, priorFlawedTasks: opts.priorFlawedTasks ?? 0, flawedPicksThisTask: 0 });
    out.plan = plg;
    out.evidence.push(...plg.evidence);
    out.flawedTasks = plg.flawedTasks;
    out.guideApproach = plg.guideApproach;
    record.planPicked = prep.plans.indexOf(plans[idx]);
    if (!plg.workable) {
      if (plg.whyFlawed) out.goBuild = `Go build · ${plg.whyFlawed}`;
      if (plg.workablePlan) out.notes.push({ name: 'A plan that works', text: plg.workablePlan, kind: 'workable' });
    }
    return out;
  }
}

/**
 * QuickPick for the gate: ignoreFocusOut, the 'I'd do it differently' button (ThemeIcon 'edit'),
 * canSelectMany for step A. Hiding it (Esc) is 'esc'; an abort closes it the same way.
 */
export class VscodePickPort implements PickPort {
  pick(req: PickRequest, signal?: AbortSignal): Promise<PickOutcome> {
    return new Promise<PickOutcome>((resolve) => {
      if (signal?.aborted) return resolve({ kind: 'esc' });
      type Item = vscode.QuickPickItem & { index: number };
      const qp = vscode.window.createQuickPick<Item>();
      const button: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('edit'), tooltip: req.buttonTooltip };
      qp.title = req.title;
      if (req.placeholder) qp.placeholder = req.placeholder;
      qp.canSelectMany = req.canSelectMany;
      qp.ignoreFocusOut = true;
      qp.matchOnDescription = false;
      qp.items = req.items.map((it, index) => ({ label: it.label, index }));
      qp.buttons = [button];
      let done = false;
      const subs: vscode.Disposable[] = [];
      const finish = (o: PickOutcome) => {
        if (done) return;
        done = true;
        for (const s of subs) s.dispose();
        resolve(o);
        qp.hide();
        qp.dispose();
      };
      subs.push(
        qp.onDidTriggerButton((b) => {
          if (b === button) finish({ kind: 'own-plan' });
        }),
        qp.onDidAccept(() => {
          const chosen = req.canSelectMany ? qp.selectedItems : qp.selectedItems.length ? qp.selectedItems : qp.activeItems;
          finish({ kind: 'accept', selected: chosen.map((i) => i.index) });
        }),
        qp.onDidHide(() => finish({ kind: 'esc' })),
      );
      signal?.addEventListener('abort', () => finish({ kind: 'esc' }), { once: true });
      qp.show();
    });
  }
}
