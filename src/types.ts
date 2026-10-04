// Shared data model for Deliberate.

import type {
  AtomResult, ConceptEvidenceFields, FadeLevel, HintPrefetch, Lang, LearnerEvidenceFields, OwnProbe, TaskGateState, TaskInterface,
  TaskSpecState, WhatIf,
} from './contracts';

export type Phase =
  | 'placement'    // project-level: the placement blitz runs before task 1 (status / tempo only, never a task phase)
  | 'gate'         // the task gate QuickPicks are open (pattern pick, plan pick)
  | 'explain'      // only the free-text own-plan path ('I'd do it differently'); graded in the background
  | 'learning'     // an atom is open in the pad (an overlay: resumePhase says where to go back)
  | 'building'     // learner is coding; specs run on save; the monitor watches for stuck signals
  | 'explain-back' // fallback without a runtime: one free-text question, graded in the background
  | 'done';

export interface Concept {
  id: string;            // kebab-case slug, stable across projects
  name: string;
  description: string;
  prerequisites: string[];
}

export interface ConceptState extends Concept, ConceptEvidenceFields {
  mastery: number;       // P(known), written only by recordEvidence (src/learner.ts)
  attempts: number;      // solved tasks touching this concept
  hintsUsed: number;
  lessonsSeen: number;
  lastPracticed: number; // epoch ms of the last direct (non-propagated) evidence, 0 if never
  nextReview: number;    // epoch ms, spaced-repetition due date (0 = not scheduled)
  intervalDays: number;
  solveTimesMin: number[]; // minutes per solved task touching this concept (for speed trend)
  /** Last full-weight wrong answer of its own: propagation never raises it within 7 days. */
  lastWrongAt?: number;
}

export interface Mistake {
  id: string;
  at: number;
  conceptIds: string[];
  pattern: string;       // short name for the mistake pattern, e.g. "off-by-one in loop bound"
  detail: string;
  taskId: string;
  count: number;         // how many times this pattern has been seen
  /** Stable taxonomy id; entries with the same id merge across calls. */
  misconceptionId?: string;
}

export interface Hint {
  rung: number;          // 0 (local, persistent error) and 1..5 on the hint ladder
  at: number;
  diagnosis: string;
  html: string;
  /** Concepts the hint diagnosed (gotIt() records rung evidence on them). */
  conceptIds?: string[];
  /** Served from the speculative prefetch, from an on-demand call, or locally (rung 0). */
  source?: 'prefetch' | 'on-demand' | 'local';
}

/** TaskPrep status of a task (gate pack + spec ladder, spec V1-8 / V1-11). */
export interface TaskPrepState {
  state: 'pending' | 'done' | 'failed';
  at: number;
  /** Why the ladder is missing or not applicable (logged; Check my work reviews instead). */
  reason?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  conceptIds: string[];
  estimatedMinutes: number;
  kind: 'roadmap' | 'followup' | 'drill';
  parentId?: string;
  followUpDepth: number;
  status: 'todo' | 'active' | 'done' | 'skipped';
  phase: Phase;
  startedAt?: number;
  completedAt?: number;
  activeMs: number;
  stuckMs: number;
  /** The learner's own free-text plan ('I'd do it differently'), graded in the background. */
  explanation?: string;
  explainAttempts: number;
  hints: Hint[];
  revealed: boolean;
  /** Phase to return to after an atom opened mid-task. */
  resumePhase?: Phase;
  /** Question asked in the explain-back fallback (no runtime) or after a conflict flag. */
  explainBackQuestion?: string;
  /** URIs of files edited during this task (kept across window reloads). */
  files?: string[];
  /** Outcome of the previous "Check my work", so a re-check verifies those issues against the new code. */
  lastReview?: { at: number; summary: string; issues: string[] };
  /** Hint rung already offered proactively (so we offer each rung once). */
  offeredRung: number;
  feed: Card[];

  // ---- v0.2 fast loop (spec V1-7, V1-8, V1-10, V1-11, V1-12)
  // Optional in the stored shape (profiles from v0.1 and hand-built tasks lack them); the coach fills
  // defaults when it loads a project (normTask), so its own code sees them all set.
  /** File and 1-3 signatures, fixed by the plan before the learner types. */
  interface?: TaskInterface;
  /** Scaffolding level, stored at task start from P('decomposition'); 'solo' for the last task of a milestone. */
  fade?: FadeLevel;
  /** Last task of its milestone: no gate, no spec titles, no JIT offers, hints capped at rung 2, no Reveal. */
  solo?: boolean;
  /** Gate pack from TaskPrep, and the learner's result. */
  gate?: TaskGateState;
  /** Behaviour spec ladder from TaskPrep (verified locally; the reference is never stored). */
  spec?: TaskSpecState;
  prep?: TaskPrepState;
  /** Speculative hint ladder (rungs 1-3) with its staleness keys. */
  hintPrefetch?: HintPrefetch;
  /** Own-code predictions asked in this task. */
  ownProbes?: OwnProbe[];
  /** What-if mutants answered at the end of the task. */
  whatIfs?: WhatIf[];
  /** Conflict flag: specs went green fast but 2+ own predictions were wrong. */
  notUnderstood?: boolean;
  /** Atoms run during this task. */
  atomRuns?: AtomResult[];
  /** Net-new characters pasted from the clipboard into task files (spec V1-3 passive sources). */
  pastedChars?: number;
  /** Net-new characters inserted by something other than the learner's typing or the clipboard. */
  assistedChars?: number;
  /** Functions that received assisted inserts: their spec evidence drops to weight .3. */
  assistedFunctions?: string[];
  /** Gate-deferred gaps: JIT offers on the spec that needs them. */
  gateDeferred?: string[];
  /** JIT offers the learner skipped (known-gap shortcut: stuck threshold x.6). */
  jitSkipped?: string[];
  /** Rung-0 errors already served (once per error). */
  rung0Keys?: string[];
  /** When every behaviour passed (hidden specs too) or Check my work said the criteria are met. */
  criteriaMetAt?: number;
  /** Learner-visible model wait in this task, ms (Pace metrics). */
  waitMs?: number;
  /** Hint rungs 1-3 served from the prefetch vs on demand (target: 70% prefetched). */
  hintServe?: { prefetched: number; onDemand: number };
}

export interface Milestone {
  title: string;
  /** One-sentence goal (PlanOutline). */
  goal?: string;
  taskIds: string[];
}

/** Placement blitz state (spec V1-7). */
export interface ProjectPlacement {
  /** Concept ids placement asked about. */
  asked: string[];
  startedAt: number;
  done: boolean;
  /** The 'tick what you have used' picker was answered. */
  selfRated: boolean;
  /** PlanOutline has not landed yet. */
  planPending: boolean;
  /** Why the last PlanOutline attempt failed ('Roadmap failed: <reason>' with Retry). */
  planError?: string;
  /** The typing calibration ran. */
  calibrated: boolean;
  /** Concepts answered '?' in placement (the atom ROUTE goes to UNKNOWN). */
  dontKnow?: string[];
  /** Placement summary card text. */
  summary?: string;
  finishedAt?: number;
}

/** One prefetched value (escalation lessons, model probe inputs, ...). Project.prefetch is an LRU of 50. */
export interface PrefetchEntry {
  at: number;
  taskId?: string;
  contentHash?: string;
  value: unknown;
}

export interface Project {
  goal: string;
  background?: string;
  title: string;
  summary: string;
  /** Language label, fixed at Start ('python', 'javascript', 'typescript', 'go', ...). */
  language: string;
  /** The language when it has local execution (seeds, pad, specs). */
  lang?: Lang;
  createdAt: number;
  conceptIds: string[];
  milestones: Milestone[];
  tasks: Record<string, Task>;
  currentTaskId?: string;
  placement: ProjectPlacement;
  prefetch: Record<string, PrefetchEntry>;
  /** Bumped on every startTask, newProject and resetProfile (generation tokens). */
  taskSwitch: number;
  /** Tasks with a flawed plan pick (3 lower 'decomposition'). */
  flawedTasks?: number;
  /** Project-level feed (onboarding, placement, roadmap) shown when no task is active. */
  feed: Card[];
}

export interface Learner extends LearnerEvidenceFields {
  concepts: Record<string, ConceptState>;
  mistakes: Mistake[];
  totals: { tasksDone: number; hintsUsed: number; reveals: number; activeMinutes: number };
  /** Delayed production audits passed / failed (Progress header). */
  audits: { passed: number; failed: number };
  /** Set when the profile is erased, so another window's flush adopts the reset. */
  resetAt?: number;
}

export interface CardAction {
  label: string;
  command: string;
  arg?: string;
  primary?: boolean;
}

export interface Card {
  id: string;
  at: number;
  /** 'log': one compact line-card per placement, gate, atom, sprint, review and hint. */
  kind: 'task' | 'feedback' | 'lesson' | 'hint' | 'question' | 'answer' | 'review' | 'info' | 'you' | 'error' | 'log';
  title: string;
  html: string;
  actions?: CardAction[];
  /** Inline answer box on the card itself. */
  input?: { command: string; placeholder: string };
}

export interface StuckSignals {
  minutesSinceProgress: number;
  thresholdMinutes: number;
  persistentError?: string;
  persistentErrorMinutes: number;
  repeatedTerminalFailures: number;
  lastTerminalError?: string;
  churn: number;          // 0..1 share of recent edits that were deletions
  idleWithErrorsMinutes: number;
  score: number;          // 0..1+, >= 1 means stuck
  reasons: string[];
}
