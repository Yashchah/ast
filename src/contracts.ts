// Shared contracts for the v0.2 "fast loop" redesign (see docs/redesign-spec.md).
// Every module builds against these types. Change them only deliberately: many files depend on them.
// Pure types only: no runtime code, no vscode import.

// =====================================================================================
// Languages and runtimes (spec V1-2)
// =====================================================================================

/** Languages with local execution in V1. Others fall back to unverified / neutral items. */
export type Lang = 'python' | 'javascript' | 'typescript';

export interface Runtime {
  lang: Lang;
  /** Absolute path of the interpreter actually spawned (python.exe / node.exe). */
  exe: string;
  /** argv placed before the script path for model/seed snippets (sandboxed profile). */
  snippetArgv: string[];
  /** argv placed before the script path for learner-code runs (spec runs, own-code probes). */
  learnerArgv: string[];
  version: string;
  /** Node permission flag in use ('--permission' | '--experimental-permission'), if any. */
  permissionFlag?: string;
  /** TypeScript execution mode, when lang === 'typescript'. */
  tsMode?: 'strip' | 'transform' | 'tsx';
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  ms: number;
  /** Exception class name parsed from stderr, if the process died with one. */
  exception?: string;
}

// =====================================================================================
// Typed values: one model for Python and JS output and answers (spec V1-2 compareOutput)
// =====================================================================================

/**
 * A printed or typed value. Python ints and floats are distinct ('int' vs 'float');
 * JS has a single 'num'. Dicts, JS plain objects and Maps are all 'dict' (entries, order-free).
 */
export type Val =
  | { t: 'int'; v: string }                                   // Python int, decimal string (bigint-safe)
  | { t: 'float'; v: number | 'nan' | 'inf' | '-inf' }        // Python float
  | { t: 'num'; v: number | 'NaN' | 'Infinity' | '-Infinity' | '-0' } // JS number
  | { t: 'bigint'; v: string }                                // JS bigint
  | { t: 'str'; v: string }
  | { t: 'bytes'; v: string }                                 // Python bytes, as latin-1 text
  | { t: 'bool'; v: boolean }
  | { t: 'none' }                                             // Python None
  | { t: 'null' }
  | { t: 'undefined' }
  | { t: 'list'; v: Val[] }                                   // Python list / JS array
  | { t: 'tuple'; v: Val[] }
  | { t: 'set'; v: Val[] }                                    // Python set / JS Set
  | { t: 'frozenset'; v: Val[] }
  | { t: 'dict'; v: [Val, Val][] }                            // Python dict / JS object / Map
  | { t: 'opaque'; type: string; repr: string };              // anything else (functions, class instances...)

/** One argument of one print()/console.log() call, captured by the batch runner. */
export interface PrintedArg {
  /** Runtime type name: Python type(x).__name__, JS typeof / constructor name. */
  type: string;
  /** Python repr(x) / JS util.inspect(x, {breakLength: Infinity}). */
  repr: string;
  val: Val;
}

/** What a snippet printed: plain text plus the typed values of every print call, in order. */
export interface RecordedOutput {
  stdout: string;
  /** One entry per print/console.log call; each entry lists that call's arguments. */
  values: PrintedArg[][];
  /** Exception class name when the snippet raised (intentionally raising probes). */
  exception?: string;
}

// =====================================================================================
// Batch runner (spec V1-2)
// =====================================================================================

export interface BatchItem {
  id: string;
  code: string;
  /** Python only: record a per-line state trace with sys.settrace. */
  wantTrace?: boolean;
}

export interface TraceLine {
  /** 1-based line in the item's code. */
  line: number;
  /** e.g. "a=[1, 2]  b is a" (<= 60 chars). */
  text: string;
}

export interface BatchRecord extends RecordedOutput {
  id: string;
  exitOk: boolean;
  timedOut: boolean;
  ms: number;
  /** Constructs used (ast walk / token table), e.g. 'for', 'slice', 'dict-literal', 'def', 'lambda'. */
  constructs: string[];
  trace?: TraceLine[];
  /** Short stderr / traceback tail (<= 1000 chars) for failed items. */
  error?: string;
  /** Set by the allowlist: the item was never run. */
  denied?: string;
}

export interface BatchOptions {
  /** PYTHONHASHSEED for this pass (verification runs two passes with different seeds). */
  hashSeed?: number;
  signal?: AbortSignal;
  /** Per-item timeout, default 3000 ms. */
  itemTimeoutMs?: number;
}

export interface LearnerRunOptions {
  /** Workspace root: readable (module path), never the cwd, never writable. */
  workspaceDir: string;
  /** Extra readable dirs (e.g. the harness folder). */
  readDirs?: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  stdin?: string;
}

/** Implemented by src/runner.ts; faked in tests. */
export interface Runner {
  readonly runtime: Runtime;
  /** Run model/seed snippets in the sandboxed snippet profile, one spawn for the batch. */
  runBatch(items: BatchItem[], opts?: BatchOptions): Promise<BatchRecord[]>;
  /** Run a bundled script (harness/probe) against learner code in the learner-code profile. */
  runLearnerCode(scriptPath: string, args: string[], opts: LearnerRunOptions): Promise<RunResult>;
}

// =====================================================================================
// Grading verdicts (spec V1-2, V1-6)
// =====================================================================================

export type VerdictKind = 'correct' | 'format-only' | 'wrong' | 'dont-know';

export interface Verdict {
  verdict: VerdictKind;
  /** Set when a wrong answer equals a mutant's output under strict comparison. */
  mutantId?: string;
  /** The matched mutant's output is ambiguous: record wrong evidence but name no belief. */
  ambiguous?: boolean;
  /** One-line note, e.g. "right idea; Python writes it as [2, 3]". */
  note?: string;
}

export interface MutantOutput {
  id: string;
  output: RecordedOutput;
  ambiguous: boolean;
}

export interface CompareOptions {
  typeSensitive: boolean;
  mutants?: MutantOutput[];
}

// =====================================================================================
// Evidence model (spec V1-3)
// =====================================================================================

export type ItemKind =
  | 'predict' | 'completion' | 'traceback' | 'own-predict' | 'what-if' | 'spec'
  | 'which-pattern' | 'pattern-pick' | 'plan-pick' | 'contrast-pick' | 'task' | 'llm-grade' | 'passive';

export type EvidenceSource =
  | 'atom' | 'placement' | 'sprint' | 'gate' | 'spec' | 'own-code' | 'hint' | 'task' | 'llm' | 'passive' | 'audit';

export interface Evidence {
  id: string;
  at: number;
  conceptId: string;
  kind: ItemKind;
  itemId?: string;
  siblingGroup?: string;
  /** null = don't know. */
  correct: boolean | null;
  verdict?: VerdictKind;
  guessFlag: boolean;
  implicitGuess?: boolean;
  latencyMs?: number;
  parSelfMs?: number;
  parAbsMs?: number;
  latencyValid: boolean;
  misconceptionId?: string;
  /** Learner answered 'y' to "Did you think ...?". */
  beliefConfirmed?: boolean;
  /** Misconceptions whose mutants this (correct) item carried: coverage. */
  avoidedMisconceptionIds?: string[];
  /** Completion pass or cleanly-earned spec green. */
  production?: boolean;
  source: EvidenceSource;
  /** Update weight in (0, 1]; P' = P + w(Pbayes - P). */
  weight: number;
  /** Learning transition applied after the update. */
  learnT: number;
  /** KL(posterior || prior), filled by recordEvidence. */
  bits: number;
  taskId?: string;
  /** Window id (multi-window merge). */
  window: string;
  /** Answer-space guess rate for predict-like items (from answerSpaceG). */
  g?: number;
  /** Misconception odds multiplier to apply (x6 confirmed, x3 unconfirmed curated, ...). */
  misconceptionOdds?: number;
  /** Set by sprint delayed checks: counts toward clearing a suppressed misconception. */
  delayedCheckFor?: string;
  /** Correct re-probe right after a refutation: suppress this misconception. */
  suppresses?: string;
}

export type MisconceptionStatus = 'candidate' | 'active' | 'suppressed' | 'cleared';

export interface MisconceptionState {
  p: number;
  belief: string;
  status: MisconceptionStatus;
  /** Sibling groups that produced a match. */
  groups: string[];
  refutedAt?: number;
  delayedHits: number;
  relapses: number;
  lastAt: number;
  /** When the next delayed check is due. */
  nextCheckAt?: number;
}

export type ConceptChip = 'Misconception' | 'Fixing' | 'Unknown' | 'Fragile' | 'Learning' | 'Solid' | 'Fluent';

/** Fields the evidence model adds to ConceptState (src/types.ts extends this). */
export interface ConceptEvidenceFields {
  tag?: string;
  kind?: 'shape' | 'semantics';
  aliases: string[];
  tested: boolean;
  inferred: boolean;
  supportFrom: string[];
  groupsCorrect: string[];
  production: boolean;
  coveredMisconceptions: string[];
  fragile: boolean;
  fragileSince?: number;
  masteredAt?: number;
  auditDueAt?: number;
  /** false when its atom pack failed verification entirely. */
  probeable: boolean;
  misconceptions: Record<string, MisconceptionState>;
  /** latency / par_abs ratios of recent correct answers, with their day stamps. */
  fluency: { ratio: number; at: number }[];
  selfRating?: 'used' | 'not-used';
  selectionGap?: boolean;
  lastAt: number;
  /** Number of full-weight wrong answers (for downward propagation). */
  wrongGroups?: string[];
}

export interface PatternCard {
  conceptId: string;
  tag: string;
  kind: 'shape' | 'semantics';
  name: string;
  useWhen: string;
  template: string;
  rule: string;
  pitfall: string;
  useCases: string[];
  useCaseSeenAt: Record<string, number>;
  lastRatio?: number;
  addedAt: number;
}

/** Fields the evidence model adds to Learner (src/types.ts extends this). */
export interface LearnerEvidenceFields {
  /** [right, total] for sure answers and for guess-flagged answers. */
  calibration: { sure: [number, number]; guess: [number, number] };
  speedFactor: number;
  /** Characters per second from the typing calibration item. */
  cps: number;
  /** How often each pad key was used (legend fades after 3 uses each). */
  keyUse: Record<string, number>;
  patternDeck: PatternCard[];
  /** Graded items so far (Fragile is never set during the first 15). */
  gradedCount: number;
  /** Ratios latency/par of recent correct items (speedFactor median source). */
  recentRatios: number[];
  logCheckpoint: number;
  /** Concept ids of mastery audits that failed (false-mastery events). */
  falseMastery: { conceptId: string; at: number }[];
}

// =====================================================================================
// Canonical tags and seed templates (spec V1-5)
// =====================================================================================

export interface TagMisconception {
  id: string;
  /** <= 12 words, learner words. */
  belief: string;
  prior: number;
}

export interface TagInfo {
  tag: string;
  /** Languages the tag applies to. */
  langs: Lang[];
  kind: 'shape' | 'semantics';
  /** Canonical pattern name (<= 5 words); prompts must use it exactly. */
  patternName: string;
  /** For sub-atoms of large topics. */
  parent?: string;
  /** Prerequisite tags (DAG edges). */
  prereqs: string[];
  /** Tags that are valid alternatives (never used as lures/distractors against this one). */
  alternatives: string[];
  typeSensitive: boolean;
  stateTrace: boolean;
  allowedImports: string[];
  misconceptions: TagMisconception[];
  /** One-line example shown in the "tick what you've used" picker. */
  example?: string;
}

/** Slot generators for parametric seeds. All draws use the instantiator's seeded RNG. */
export type SlotSpec =
  | { gen: 'int'; min: number; max: number; notIn?: number[] }
  | { gen: 'intList'; minLen: number; maxLen: number; min: number; max: number; distinct?: boolean; sorted?: boolean }
  /** A valid index into list slot `of` (0..len-1), shifted by offset, optionally negative form. */
  | { gen: 'index'; of: string; offset?: number; negative?: boolean }
  /** Pick from inline options (strings are inserted verbatim). */
  | { gen: 'pick'; options: (string | number)[] }
  /** A word from a pool; inserted WITHOUT quotes (template adds quotes). */
  | { gen: 'word'; pool: 'nouns' | 'names' | 'fruits' | 'cities' | 'colors' | 'animals' }
  | { gen: 'wordList'; pool: 'nouns' | 'names' | 'fruits' | 'cities' | 'colors' | 'animals'; minLen: number; maxLen: number; distinct?: boolean }
  /** Small integer arithmetic over earlier int slots, e.g. "a + b" or "len(xs) - 1". Evaluated by the instantiator. */
  | { gen: 'derive'; expr: string };

/**
 * Applied to the TEMPLATE text before slots are filled, so the mutant differs from the
 * original on exactly one line for every instance. `find` must occur exactly once and on one line.
 */
export interface SeedTransform {
  misconceptionId: string;
  find: string;
  replace: string;
  /** <= 12 words. */
  belief: string;
  /** <= 25 words, no output values. */
  refutation: string;
  /** <= 12 words. */
  rule: string;
}

export type SeedKind = 'probe' | 'example' | 'completion' | 'contrast' | 'traceback';

export interface SeedTemplate {
  id: string;
  tag: string;
  /** Surface family; sibling group = `${family}:${theme}`. */
  family: string;
  kind: SeedKind;
  /** Code with {{slot}} holes and {{@name}} theme identifiers. Completion blanks are [[1]], [[2]]. */
  code: string;
  slots: Record<string, SlotSpec>;
  /** theme name -> { themeVar: identifier }, e.g. { scores: { xs: 'scores', x: 'score' } }. */
  themes: Record<string, Record<string, string>>;
  transforms: SeedTransform[];
  /** Thinking seconds (3-8 probes; 20-40 completions). */
  parSec: number;
  /** example: labels per 1-based line. */
  subgoals?: { line: number; label: string }[];
  /** completion: exact text for each blank, in order. */
  solutions?: string[];
  /** completion: wrong fills tagged with misconceptions. */
  wrongFills?: { blank: number; fill: string; misconceptionId: string }[];
  /** completion: lines appended after the code; check(cond, msg) calls; may use {{slots}}. */
  harness?: string;
  /** contrast: the second snippet (code = the one holding the misconception's behaviour). */
  contrastCode?: string;
  /** contrast: <= 12 words. */
  rule?: string;
  /** contrast: misconception the wrong snippet embodies. */
  misconceptionId?: string;
}

export interface SeedFile {
  lang: Lang | 'neutral';
  templates: SeedTemplate[];
}

// =====================================================================================
// Stored atoms (spec V1-5): what the pad runs. Seeds and model packs both end up here.
// =====================================================================================

export interface StoredMutant {
  id: string;
  misconceptionId: string;
  belief: string;
  refutation: string;
  rule: string;
  code: string;
  output: RecordedOutput;
  /** 1-based line in the probe code that differs. */
  diffLine: number;
  source: 'curated' | 'model';
  ambiguous: boolean;
  matches: number;
  confirmations: number;
  rejections: number;
}

export interface ItemStats {
  seenAt: number[];
  n: number;
  nCorrect: number;
  medianMs?: number;
}

export interface StoredProbe {
  id: string;
  /** Sibling group (surface). */
  group: string;
  code: string;
  output: RecordedOutput;
  parSec: number;
  answerSpaceG: number;
  constructs: string[];
  discriminating: boolean;
  trace?: TraceLine[];
  mutants: StoredMutant[];
  stats: ItemStats;
  /** True when it raises on purpose; the answer is the exception name. */
  raises?: boolean;
}

export interface StoredExample {
  id: string;
  group: string;
  code: string;
  subgoals: { line: number; label: string }[];
  output: RecordedOutput;
}

export interface StoredCompletion {
  id: string;
  group: string;
  /** Code with [[1]], [[2]] blanks. */
  code: string;
  solutions: string[];
  wrongFills: { blank: number; fill: string; misconceptionId: string }[];
  harness: string;
  parSec: number;
  stats: ItemStats;
}

export interface StoredContrast {
  id: string;
  /** Snippet showing the misconception's behaviour vs the correct one; display order is shuffled. */
  wrong: string;
  right: string;
  wrongOutput: RecordedOutput;
  rightOutput: RecordedOutput;
  misconceptionId: string;
  rule: string;
}

export interface TracebackItem {
  id: string;
  code: string;
  /** Trace text trimmed to snippet frames, line numbers renumbered to pad lines. */
  trace: string;
  /** 1-based failing line. */
  line: number;
  exception: string;
  meanings: string[];
  correctMeaning: number;
  siblingGroup: string;
  conceptId: string;
}

export interface AtomPattern {
  kind: 'shape' | 'semantics';
  name: string;
  useWhen: string;
  template: string;
  rule: string;
  howItRuns: string;
  pitfall: string;
  useCases: string[];
}

export interface StoredAtom {
  /** Cache key: canonical tag (or sub-tag), or the concept id for tag 'other'. */
  key: string;
  lang: Lang;
  conceptId: string;
  tag: string;
  source: 'seed' | 'model';
  verified: boolean;
  createdAt: number;
  pattern: AtomPattern;
  probes: StoredProbe[];
  examples: StoredExample[];
  completions: StoredCompletion[];
  contrasts: StoredContrast[];
  tracebacks: TracebackItem[];
}

// =====================================================================================
// Atom pad results (spec V1-6)
// =====================================================================================

export type AtomPath = 'tested-out' | 'confirmed' | 'fixed' | 'learned' | 'partial' | 'escalated' | 'aborted';

export interface AtomResult {
  conceptId: string;
  path: AtomPath;
  items: number;
  ms: number;
  misconceptionId?: string;
  misconceptionStatus?: string;
  stateBefore: ConceptChip | string;
  stateAfter: ConceptChip | string;
}

// =====================================================================================
// Background jobs (spec V1-1)
// =====================================================================================

export interface Gen {
  projectCreatedAt: number;
  taskId?: string;
  taskSwitch: number;
}

export type JobScope = 'global' | 'project' | 'task';
export type JobPriority = 0 | 1 | 2 | 3;
export type JobKind = 'hint' | 'other';

export interface JobSpec<T> {
  key: string;
  priority: JobPriority;
  effort: 'low' | 'medium' | 'high';
  label: string;
  scope: JobScope;
  gen: Gen;
  /** Budget share: hint jobs draw from the hint reserve. Default 'other'. */
  kind?: JobKind;
  /** Epoch ms by which a priority-1 result is needed (degraded path after). */
  neededBy?: number;
  run: (signal: AbortSignal) => Promise<T>;
}

// =====================================================================================
// Tempo bar and annotations (spec V1-4)
// =====================================================================================

export type ActionKind =
  | 'atom' | 'jit-atom' | 'gate' | 'hint-ready' | 'own-predict' | 'what-if' | 'sprint' | 'warmup'
  | 'review-ready' | 'specs-ready' | 'spec' | 'placement' | 'info';

export interface Action {
  id: string;
  kind: ActionKind;
  /** Status text (<= 40 chars, may start with a $(codicon)). */
  label: string;
  priority: number;
  blocking: boolean;
  command: string;
  args?: unknown[];
  createdAt: number;
  expiresAt?: number;
}

export type PauseKind = 'manual-save' | 'spec-green' | 'terminal-ok' | 'idle';

export interface SchedulerInput {
  now: number;
  actions: Action[];
  lastEditAt: number;
  lastPopAt: number;
  lastPause?: { kind: PauseKind; at: number };
  stuckScore: number;
  sprintMsToday: number;
  activeMsToday: number;
  lockHeld: boolean;
  phase: string;
  /** kind -> epoch ms until which that kind is pushed back (Skip/Esc). */
  pushedBack?: Record<string, number>;
  /** Last pop time per kind (own-predict: once per 3 active minutes). */
  lastPopByKind?: Record<string, number>;
}

export interface SchedulerDecision {
  /** The action to show as the status text (head of the queue), if any. */
  action?: Action;
  /** Pop it now (warning background + flash)? */
  pop: boolean;
  /** Open it immediately (blocking actions when the lock is free). */
  open: boolean;
}

export type AnnotationSource = 'hint' | 'spec' | 'own-predict' | 'what-if';

export interface Annotation {
  uri: string;
  line: number;
  source: AnnotationSource;
  text: string;
  hover: string;
}

// =====================================================================================
// Task interface, behaviour specs, gate, own-code probes (spec V1-7, V1-8, V1-11, V1-12)
// =====================================================================================

export interface TaskInterface {
  /** Workspace-relative file. */
  file: string;
  functions: { name: string; signature: string; purpose: string }[];
  /** Interface name -> learner's function name, when they named it differently. */
  mappedNames?: Record<string, string>;
}

export interface FailureSignature {
  match: 'equals' | 'error';
  value: string;
  misconceptionId: string;
  /** <= 20 words, a question, no code. */
  nudge: string;
}

export interface SpecItem {
  id: string;
  /** <= 8 words, one behaviour. */
  title: string;
  conceptId: string;
  /** One call to an interface function with literal arguments only. */
  call: string;
  /** Expected literal (Python literal / JSON); empty when expectError is set. */
  expected: string;
  expectError: string;
  parSec: number;
  failureSignatures: FailureSignature[];
}

export interface SpecResult {
  id: string;
  pass: boolean;
  /** repr of the actual result, <= 200 chars. */
  actual?: string;
  /** Exception class + message, when the call raised. */
  error?: string;
  /** 'timeout' when this spec was running when the harness timed out; 'not-run' after it. */
  status?: 'ok' | 'timeout' | 'not-run';
}

export interface HarnessReport {
  results: SpecResult[];
  importMs?: number;
  /** Loader problem: top-level input()/argv use, unsafe JS top level, missing export, import error. */
  loadError?: { kind: 'top-level' | 'unsafe-top-level' | 'not-exported' | 'import' | 'sandbox' | 'crash'; message: string; name?: string };
  timedOut: boolean;
}

export interface TaskSpecState {
  specs: SpecItem[];
  hidden: SpecItem[];
  greenAt: Record<string, number>;
  firstRedAt: Record<string, number>;
  savesSinceRed: Record<string, number>;
  runs: number;
  importMs?: number;
  overfit?: boolean;
  verified: boolean;
  applicable: boolean;
  reason?: string;
  /** Last results by spec id (for the card and gutter). */
  last?: Record<string, SpecResult>;
}

export interface GatePattern {
  name: string;
  conceptId: string;
  required: boolean;
  competesWith: string;
  useWhen: string;
  whyNot: string;
}

export interface GatePlan {
  text: string;
  workable: boolean;
  flawConceptId: string;
  misconceptionId: string;
  whyFlawed: string;
}

export interface TaskGateState {
  patterns: GatePattern[];
  plans: GatePlan[];
  result?: { selected: string[]; missed: string[]; lures: string[]; planPicked: number; ms: number };
}

export type FadeLevel = 'full' | 'partial' | 'minimal' | 'solo';

export interface OwnProbe {
  fnName: string;
  fnHash: string;
  callExpr: string;
  source: 'spec-mutation' | 'model' | 'fallback';
  conceptId: string;
  misconceptionIfWrong: string;
  result?: { predicted: string; actual: string; correct: boolean; ms: number };
}

export interface WhatIf {
  file: string;
  line: number;
  op: string;
  tag: string;
  callExpr: string;
  /** The mutated line text. */
  mutatedLine: string;
  predicted?: string;
  actual: string;
  unmutated: string;
  alternative?: string;
  correct?: boolean;
  attributable?: boolean;
}

export interface HintPrefetch {
  key: string;
  contentHash: string;
  errorHash: string;
  at: number;
  anchor: { file: string; line: number; lineText: string };
  rungs: string[];
  diagnosis: string;
  stuckType: string;
  conceptIds: string[];
  misconceptionId: string;
  used: boolean;
}
