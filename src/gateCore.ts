// Task gate rules and local grading (spec V1-8). Pure: no vscode import; src/gate.ts owns the
// QuickPicks and calls these.
// - Fade level from P('decomposition'): full < .5 <= partial < .8 <= minimal; solo for the last task
//   of a milestone.
// - The gate runs only when the task brings in a new unmastered concept, is not solo, and fade is
//   not minimal. Step B (plan pick) only at 'full', and only when the plans pass the length check.
// - Pattern pick: required+selected correct, required+missed wrong, lure selected wrong at weight .3
//   on the concept it competes with, with NO misconception.
// - Plan pick: workable correct (on 'decomposition'); flawed wrong on flawConceptId with its
//   misconception at odds x2. Flawed picks in 3 tasks also lower 'decomposition'.
// - Routing: up to 2 atoms / 120 s before building; other gaps become JIT offers.

import type { FadeLevel, GatePattern, GatePlan } from './contracts';
import { PARAMS } from './evidence';
import { concept, conceptChip, DECOMPOSITION, type EvidenceInput, PRIOR } from './learner';
import { routeAtom } from './atoms/stepMachine';
import type { Learner, Milestone } from './types';

export const GATE = {
  fade: { partial: 0.5, minimal: 0.8 },
  /** Lure picks: weight .3, never a misconception. */
  lureWeight: 0.3,
  /** Each plan within +-20% of the mean length (characters). */
  planTolerance: 0.2,
  flawedPlanOdds: 2,
  /** Flawed plan picks in this many tasks lower 'decomposition'. */
  flawedTasksForDecomposition: 3,
  /** Flawed picks in one task that bring in guideApproach(). */
  flawedPicksForGuide: 2,
  atomCap: 2,
  atomBudgetSec: 120,
  missedPatternP: 0.5,
  /** Estimated atom seconds by route (spec coreLoop 3: 20-30 / 40-70 / 70-120). */
  atomSec: { known: 25, misconception: 55, unknown: 95 },
  maxWords: 50,
} as const;

// ---------------------------------------------------------------- fade and run rules

/** full (P < .5), partial (.5 <= P < .8), minimal (P >= .8); solo overrides. */
export function fadeLevel(decompositionP: number, solo = false): FadeLevel {
  if (solo) return 'solo';
  const p = Number.isFinite(decompositionP) ? decompositionP : PRIOR;
  if (p < GATE.fade.partial) return 'full';
  if (p < GATE.fade.minimal) return 'partial';
  return 'minimal';
}

/** The task's fade from the learner's 'decomposition' P (prior .3 before any evidence). */
export function taskFade(learner: Learner, solo = false): FadeLevel {
  return fadeLevel(concept(learner, DECOMPOSITION)?.mastery ?? PRIOR, solo);
}

/** The last task of each milestone is solo. */
export function isSoloTask(milestones: readonly Milestone[], taskId: string): boolean {
  return milestones.some((m) => m.taskIds.length > 0 && m.taskIds[m.taskIds.length - 1] === taskId);
}

export interface GateTask {
  conceptIds: string[];
  solo?: boolean;
  fade: FadeLevel;
}

export interface GateDecision {
  run: boolean;
  reason: 'solo' | 'minimal' | 'no-new-concept' | 'new-concept';
  /** Concepts new to this task and not mastered (the ones that justify the gate). */
  newConcepts: string[];
}

/**
 * The gate runs (otherwise it costs 0 s) when the task brings in a concept no earlier task used that
 * is not mastered, the task is not solo, and fade is not minimal. Ids resolve through aliases.
 */
export function gateDecision(task: GateTask, earlierTasks: readonly { conceptIds: string[] }[], learner: Learner): GateDecision {
  if (task.solo || task.fade === 'solo') return { run: false, reason: 'solo', newConcepts: [] };
  if (task.fade === 'minimal') return { run: false, reason: 'minimal', newConcepts: [] };
  const key = (id: string) => concept(learner, id)?.id ?? id;
  const before = new Set(earlierTasks.flatMap((t) => t.conceptIds.map(key)));
  const fresh = [...new Set(task.conceptIds.map(key))].filter((id) => !before.has(id));
  const newConcepts = fresh.filter((id) => {
    const c = concept(learner, id);
    return !c || !isMasteredFor(learner, id);
  });
  return newConcepts.length ? { run: true, reason: 'new-concept', newConcepts } : { run: false, reason: 'no-new-concept', newConcepts: [] };
}

function isMasteredFor(learner: Learner, id: string): boolean {
  const c = concept(learner, id);
  if (!c) return false;
  const chip = conceptChip(learner, c);
  return chip === 'Solid' || chip === 'Fluent';
}

export function gateRuns(task: GateTask, earlierTasks: readonly { conceptIds: string[] }[], learner: Learner): boolean {
  return gateDecision(task, earlierTasks, learner).run;
}

/** Each plan's length within +-20% of the mean, in characters (else the workable one is often the longest). */
export function planLengthsOk(plans: readonly Pick<GatePlan, 'text'>[]): boolean {
  if (!plans.length) return false;
  const lens = plans.map((p) => p.text.trim().length);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  if (mean <= 0) return false;
  return lens.every((l) => Math.abs(l - mean) <= GATE.planTolerance * mean + 1e-9);
}

/** Step A runs whenever the gate does; step B only at 'full', with 3 plans (1 workable) of similar length. */
export function gateSteps(fade: FadeLevel, plans: readonly GatePlan[]): { stepA: boolean; stepB: boolean } {
  const stepB = fade === 'full' && plans.length === 3 && plans.filter((p) => p.workable).length === 1 && planLengthsOk(plans);
  return { stepA: fade === 'full' || fade === 'partial', stepB };
}

// Fisher-Yates with an injectable rng: the coach shuffles plans (and pattern items) before showing them.
export { shuffled } from './atoms/rng';

/** Words the gate shows (names and plans; titles excluded): at most 50. */
export function gateWords(patterns: readonly Pick<GatePattern, 'name'>[], plans: readonly Pick<GatePlan, 'text'>[] = []): number {
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  return patterns.reduce((n, p) => n + words(p.name), 0) + plans.reduce((n, p) => n + words(p.text), 0);
}

// ---------------------------------------------------------------- step A: pattern pick

export interface PatternGrade {
  /** Names the learner selected. */
  selected: string[];
  /** Required names not selected. */
  missed: string[];
  /** Lure names selected. */
  lures: string[];
  requiredTotal: number;
  requiredHit: number;
  evidence: EvidenceInput[];
  /** For the sidebar card: missed items' useWhen, lures' whyNot. */
  notes: { name: string; text: string; kind: 'missed' | 'lure' }[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Grade step A. Names match exactly, else case- and space-insensitively. A lure with no known
 * competing concept records nothing.
 */
export function gradePatternPick(patterns: readonly GatePattern[], selectedNames: readonly string[], at: number, taskId?: string): PatternGrade {
  const picked = new Set(selectedNames.map(norm));
  const isSelected = (p: GatePattern) => picked.has(norm(p.name));
  const evidence: EvidenceInput[] = [];
  const notes: PatternGrade['notes'] = [];
  const out: PatternGrade = { selected: [], missed: [], lures: [], requiredTotal: 0, requiredHit: 0, evidence, notes };
  const base = (conceptId: string, correct: boolean): EvidenceInput => {
    const e: EvidenceInput = { conceptId, kind: 'pattern-pick', source: 'gate', correct, at, guessFlag: false, latencyValid: false };
    if (taskId) e.taskId = taskId;
    return e;
  };
  for (const p of patterns) {
    const sel = isSelected(p);
    if (sel) out.selected.push(p.name);
    if (p.required) {
      out.requiredTotal++;
      if (sel) {
        out.requiredHit++;
        evidence.push(base(p.conceptId, true));
      } else {
        out.missed.push(p.name);
        evidence.push(base(p.conceptId, false));
        if (p.useWhen.trim()) notes.push({ name: p.name, text: p.useWhen.trim(), kind: 'missed' });
      }
    } else if (sel) {
      out.lures.push(p.name);
      if (p.whyNot.trim()) notes.push({ name: p.name, text: p.whyNot.trim(), kind: 'lure' });
      const target = p.competesWith.trim();
      // Wrong at weight .3 on the required concept it competes with, and never a misconception:
      // valid alternatives exist and an unverified model key must not plant a named belief.
      if (target) evidence.push({ ...base(target, false), weight: GATE.lureWeight });
    }
  }
  return out;
}

/** '2/3 patterns · missed: Count with dict' (+ ' · Which plan works?' when step B follows). */
export function patternTitle(g: Pick<PatternGrade, 'requiredHit' | 'requiredTotal' | 'missed'>, withStepB: boolean): string {
  const parts = [`${g.requiredHit}/${g.requiredTotal} patterns`];
  if (g.missed.length) parts.push(`missed: ${g.missed.join(', ')}`);
  if (withStepB) parts.push('Which plan works?');
  return parts.join(' · ');
}

// ---------------------------------------------------------------- step B: plan pick

export interface PlanGrade {
  workable: boolean;
  /** 0-based index of the picked plan (in the order shown). */
  picked: number;
  evidence: EvidenceInput[];
  /** Flash text after a flawed pick (a question). */
  whyFlawed?: string;
  /** The workable plan, for the sidebar card. */
  workablePlan?: string;
  /** 2 flawed picks in this task: show guideApproach() as a background card. */
  guideApproach: boolean;
  /** Tasks with a flawed pick, this one included (persist it for the 3-task rule). */
  flawedTasks: number;
}

export interface PlanPickContext {
  at: number;
  taskId?: string;
  /** Earlier tasks that had a flawed plan pick. */
  priorFlawedTasks?: number;
  /** Flawed picks already made in this task (before this one). */
  flawedPicksThisTask?: number;
}

/**
 * Grade step B. A workable pick is correct plan-pick evidence on 'decomposition' (planning skill).
 * A flawed pick is wrong on flawConceptId with its misconception at odds x2; when it makes 3 tasks
 * with flawed picks, it also counts against 'decomposition'.
 */
export function gradePlanPick(plans: readonly GatePlan[], picked: number, ctx: PlanPickContext): PlanGrade {
  const plan = plans[picked];
  const workablePlan = plans.find((p) => p.workable)?.text;
  const base = (conceptId: string, correct: boolean): EvidenceInput => {
    const e: EvidenceInput = { conceptId, kind: 'plan-pick', source: 'gate', correct, at: ctx.at, guessFlag: false, latencyValid: false };
    if (ctx.taskId) e.taskId = ctx.taskId;
    return e;
  };
  const prior = ctx.priorFlawedTasks ?? 0;
  if (!plan) return { workable: false, picked, evidence: [], guideApproach: false, flawedTasks: prior, workablePlan };
  if (plan.workable) {
    return { workable: true, picked, evidence: [base(DECOMPOSITION, true)], guideApproach: false, flawedTasks: prior, workablePlan };
  }
  const evidence: EvidenceInput[] = [];
  if (plan.flawConceptId.trim()) {
    const e = base(plan.flawConceptId.trim(), false);
    if (plan.misconceptionId.trim()) {
      e.misconceptionId = plan.misconceptionId.trim();
      e.misconceptionOdds = GATE.flawedPlanOdds;
    }
    evidence.push(e);
  }
  const flawedTasks = prior + ((ctx.flawedPicksThisTask ?? 0) > 0 ? 0 : 1);
  if (flawedTasks >= GATE.flawedTasksForDecomposition) evidence.push(base(DECOMPOSITION, false));
  const out: PlanGrade = {
    workable: false, picked, evidence, workablePlan, flawedTasks,
    guideApproach: (ctx.flawedPicksThisTask ?? 0) + 1 >= GATE.flawedPicksForGuide,
  };
  if (plan.whyFlawed.trim()) out.whyFlawed = plan.whyFlawed.trim();
  return out;
}

// ---------------------------------------------------------------- routing

export type GapReason = 'missed-pattern' | 'flawed-plan' | 'misconception';

export interface RoutedGap {
  conceptId: string;
  reasons: GapReason[];
  /** Estimated atom seconds (known 25, misconception 55, unknown 95). */
  costSec: number;
}

export interface GateRouting {
  /** Atoms to open before building, in order (at most 2, within 120 s). */
  atoms: RoutedGap[];
  /** The rest: just-in-time offers on the spec that needs them. */
  jit: RoutedGap[];
}

/** Estimated atom cost from its ROUTE. */
export function atomCostSec(learner: Learner, conceptId: string, now: number): number {
  const c = concept(learner, conceptId);
  if (!c) return GATE.atomSec.unknown;
  const r = routeAtom(c, { now });
  return r.to === 'unknown' ? GATE.atomSec.unknown : r.to === 'probe' ? GATE.atomSec.known : GATE.atomSec.misconception;
}

export interface RoutingInput {
  learner: Learner;
  taskConceptIds: readonly string[];
  patterns?: readonly GatePattern[];
  patternGrade?: Pick<PatternGrade, 'missed'>;
  plans?: readonly GatePlan[];
  planGrade?: Pick<PlanGrade, 'workable' | 'picked'>;
  now: number;
}

/**
 * Which gaps open an atom now: a missed required pattern whose concept has P < .5, the concept
 * behind a flawed plan pick, any task concept with a candidate misconception at p >= .3. Solid and
 * Fluent concepts never get atoms. Misconceptions first, then flawed plans, then missed patterns
 * (lowest P first); atoms are admitted while there are fewer than 2 and the estimate stays within
 * 120 s. Everything else becomes a JIT offer.
 */
export function routeGaps(input: RoutingInput): GateRouting {
  const { learner } = input;
  const gaps = new Map<string, RoutedGap & { order: number; p: number }>();
  const add = (rawId: string, reason: GapReason, order: number) => {
    const c = concept(learner, rawId);
    const id = c?.id ?? rawId;
    if (c) {
      const chip = conceptChip(learner, c);
      if (chip === 'Solid' || chip === 'Fluent') return;
    }
    const g = gaps.get(id);
    if (g) {
      if (!g.reasons.includes(reason)) g.reasons.push(reason);
      g.order = Math.min(g.order, order);
      return;
    }
    gaps.set(id, { conceptId: id, reasons: [reason], costSec: atomCostSec(learner, id, input.now), order, p: c?.mastery ?? PRIOR });
  };

  for (const id of input.taskConceptIds) {
    const c = concept(learner, id);
    if (!c) continue;
    const candidate = Object.values(c.misconceptions ?? {}).some((m) => m.status === 'candidate' && m.p >= PARAMS.misconception.blockP);
    if (candidate) add(c.id, 'misconception', 0);
  }
  if (input.planGrade && !input.planGrade.workable) {
    const plan = input.plans?.[input.planGrade.picked];
    if (plan?.flawConceptId.trim()) add(plan.flawConceptId.trim(), 'flawed-plan', 1);
  }
  if (input.patternGrade) {
    const missed = new Set(input.patternGrade.missed.map(norm));
    for (const p of input.patterns ?? []) {
      if (!p.required || !missed.has(norm(p.name))) continue;
      const c = concept(learner, p.conceptId);
      if ((c?.mastery ?? PRIOR) < GATE.missedPatternP) add(p.conceptId, 'missed-pattern', 2);
    }
  }

  const ordered = [...gaps.values()].sort((a, b) => a.order - b.order || a.p - b.p || (a.conceptId < b.conceptId ? -1 : 1));
  const atoms: RoutedGap[] = [];
  const jit: RoutedGap[] = [];
  let total = 0;
  for (const { order: _o, p: _p, ...g } of ordered) {
    if (atoms.length < GATE.atomCap && total + g.costSec <= GATE.atomBudgetSec) {
      atoms.push(g);
      total += g.costSec;
    } else jit.push(g);
  }
  return { atoms, jit };
}
