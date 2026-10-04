// Shared data model for Deliberate.

export type Phase =
  | 'explain'      // learner must describe their approach before coding
  | 'learning'     // a micro-lesson + check question is open
  | 'building'     // learner is coding; monitor is watching for stuck signals
  | 'explain-back' // learner explains why a fix / solution works
  | 'done';

export interface Concept {
  id: string;            // kebab-case slug, stable across projects
  name: string;
  description: string;
  prerequisites: string[];
}

export interface ConceptState extends Concept {
  mastery: number;       // 0..1, estimated probability learner can apply it unaided
  attempts: number;
  hintsUsed: number;
  lessonsSeen: number;
  lastPracticed: number; // epoch ms, 0 if never
  nextReview: number;    // epoch ms, spaced-repetition due date (0 = not scheduled)
  intervalDays: number;
  solveTimesMin: number[]; // minutes per solved task touching this concept (for speed trend)
}

export interface Mistake {
  id: string;
  at: number;
  conceptIds: string[];
  pattern: string;       // short name for the mistake pattern, e.g. "off-by-one in loop bound"
  detail: string;
  taskId: string;
  count: number;         // how many times this pattern has been seen
}

export interface Hint {
  rung: number;          // 1..5 on the hint ladder
  at: number;
  diagnosis: string;
  html: string;
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
  explanation?: string;
  explainAttempts: number;
  hints: Hint[];
  revealed: boolean;
  pendingCheck?: { conceptId: string; question: string; expected: string; attempts: number };
  /** Phase to return to after a lesson opened mid-task. */
  resumePhase?: Phase;
  /** Question asked in the explain-back phase. */
  explainBackQuestion?: string;
  /** URIs of files edited during this task (kept across window reloads). */
  files?: string[];
  /** Outcome of the previous "Check my work", so a re-check verifies those issues against the new code. */
  lastReview?: { at: number; summary: string; issues: string[] };
  /** Hint rung already offered proactively (so we offer each rung once). */
  offeredRung: number;
  feed: Card[];
}

export interface Milestone {
  title: string;
  taskIds: string[];
}

export interface Project {
  goal: string;
  title: string;
  summary: string;
  language: string;
  createdAt: number;
  conceptIds: string[];
  milestones: Milestone[];
  tasks: Record<string, Task>;
  currentTaskId?: string;
  diagnostic?: Diagnostic;
  /** Spaced-repetition recall question waiting for an answer. */
  pendingRecall?: { conceptId: string; question: string; code: string; expected: string };
  /** Project-level feed (onboarding, diagnostic, recall) shown when no task is active. */
  feed: Card[];
}

export interface DiagnosticQuestion {
  conceptId: string;
  question: string;
  format: 'explain' | 'predict-output' | 'write-snippet' | 'spot-the-bug';
  code: string;
  answer?: string;
  correct?: boolean;
  feedback?: string;
}

export interface Diagnostic {
  questions: DiagnosticQuestion[];
  index: number;
  done: boolean;
}

export interface Learner {
  concepts: Record<string, ConceptState>;
  mistakes: Mistake[];
  totals: { tasksDone: number; hintsUsed: number; reveals: number; activeMinutes: number };
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
  kind: 'task' | 'feedback' | 'lesson' | 'hint' | 'question' | 'answer' | 'review' | 'info' | 'you' | 'error';
  title: string;
  html: string;
  actions?: CardAction[];
  /** Inline answer box on the card itself (e.g. spaced-review questions). */
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
