import { z } from 'zod';

// Structured-output schemas for every coach call. Fields are all required
// (empty string / empty array when not applicable) to keep the JSON schemas
// simple for constrained decoding.

export const ConceptSchema = z.object({
  id: z.string().describe('kebab-case slug, e.g. "async-await" or "array-indexing"'),
  name: z.string(),
  description: z.string().describe('one sentence'),
  prerequisites: z.array(z.string()).describe('ids of concepts that must be understood first'),
  tag: z.string().describe('closest canonical tag from the list in the prompt, or other'),
});
export type ConceptOut = z.infer<typeof ConceptSchema>;

export const GradeSchema = z.object({
  correct: z.boolean(),
  score: z.number().describe('0 to 1'),
  feedback: z.string().describe('markdown, 1-4 sentences, specific to the answer'),
  misconception: z.string().describe('the underlying misconception if any, else empty string'),
});
export type Grade = z.infer<typeof GradeSchema>;

export const ExplanationReviewSchema = z.object({
  verdict: z.enum(['ready', 'gaps', 'lost']),
  feedback: z.string().describe('markdown'),
  gaps: z.array(z.object({ conceptId: z.string(), issue: z.string() })),
  probingQuestion: z.string().describe('one question that would make them think further, or empty string'),
});
export type ExplanationReview = z.infer<typeof ExplanationReviewSchema>;

export const HintSchema = z.object({
  diagnosis: z.string().describe('private one-line diagnosis of why they are stuck'),
  stuckType: z.enum(['concept-gap', 'slip', 'approach', 'environment', 'not-stuck']),
  conceptIds: z.array(z.string()),
  hint: z.string().describe('markdown hint at exactly the requested rung'),
  mistakePattern: z.string().describe('short reusable name of the mistake pattern, or empty string'),
});
export type HintResult = z.infer<typeof HintSchema>;

export const WorkReviewSchema = z.object({
  meetsCriteria: z.boolean(),
  summary: z.string().describe('markdown'),
  issues: z.array(
    z.object({
      severity: z.enum(['blocker', 'important', 'polish']),
      prompt: z.string().describe('a Socratic question or pointer, never the corrected code'),
    }),
  ),
  mistakePatterns: z.array(z.object({ pattern: z.string(), detail: z.string(), conceptIds: z.array(z.string()) })),
  explainBackQuestion: z.string().describe('one question asking them to explain a key decision in their solution'),
});
export type WorkReview = z.infer<typeof WorkReviewSchema>;

export const AnswerSchema = z.object({
  answer: z.string().describe('markdown'),
  conceptIds: z.array(z.string()),
});

export const RevealSchema = z.object({
  explanation: z.string().describe('markdown walkthrough of the reasoning'),
  code: z.string().describe('markdown fenced code for the stuck piece only'),
  rebuildChallenge: z.string().describe('a closely related mini-task they must do from memory without looking'),
});

// =====================================================================================
// v0.2 "fast loop" schemas (docs/redesign-spec.md V1-5, V1-7, V1-8, V1-10, V1-11, V1-12)
// =====================================================================================

// ---------------------------------------------------------------- V1-5 atom packs

const MutantSchema = z.object({
  misconceptionId: z.string().describe('kebab-case; reuse a given taxonomy id when one fits'),
  belief: z.string().describe('the wrong belief in plain learner words, <= 12 words'),
  refutation: z.string().describe('<= 25 words, concrete, about this code; no output values'),
  code: z.string().describe('the probe code with ONE line changed so it prints what this belief predicts for the original'),
  prints: z.string().describe('exact output of this mutant code'),
});

const ProbeSchema = z.object({
  id: z.string(),
  siblingGroup: z.string(),
  code: z.string().describe('<= 8 lines, prints 1-4 lines'),
  answer: z.string().describe('exact output, lines joined with a newline'),
  parSec: z.number().describe('thinking seconds, 3-8'),
  mutants: z.array(MutantSchema).describe('1-3'),
});

const AtomSchema = z.object({
  conceptId: z.string(),
  tag: z.string(),
  pattern: z.object({
    kind: z.enum(['shape', 'semantics']),
    name: z.string(),
    useWhen: z.string(),
    template: z.string().describe('empty for semantics'),
    rule: z.string().describe('<= 12 words for semantics, else empty'),
    howItRuns: z.string().describe('<= 20 words for semantics, else empty'),
    pitfall: z.string(),
    useCases: z.array(z.string()).describe('6-8'),
  }),
  probes: z.array(ProbeSchema).describe('4, one per sibling group'),
  example: z.object({
    code: z.string(),
    subgoals: z.array(z.object({ line: z.number(), label: z.string() })),
  }),
  completion: z.object({
    code: z.string().describe('pattern inside a function; blanks written [[1]], [[2]]'),
    solutions: z.array(z.string()),
    wrongFills: z.array(z.object({ blank: z.number(), fill: z.string(), misconceptionId: z.string() })),
    harness: z.string().describe('check(...) calls with >= 2 different inputs'),
    parSec: z.number(),
  }),
  contrast: z.object({
    wrong: z.string(),
    right: z.string(),
    misconceptionId: z.string(),
    rule: z.string(),
  }),
});

export const AtomPackSchema = z.object({ atoms: z.array(AtomSchema) });
export type AtomPack = z.infer<typeof AtomPackSchema>;
export type PackAtom = z.infer<typeof AtomSchema>;
export type PackProbe = z.infer<typeof ProbeSchema>;
export type PackMutant = z.infer<typeof MutantSchema>;

export const MisconceptionGuessSchema = z.object({
  knownId: z.string(),
  newId: z.string(),
  belief: z.string(),
  refutation: z.string(),
  mutantCode: z.string(),
  slip: z.boolean(),
});
export type MisconceptionGuess = z.infer<typeof MisconceptionGuessSchema>;

export const EscalationLessonSchema = z.object({
  title: z.string(),
  explanation: z.string().describe('markdown, <= 120 words'),
  example: z.string().describe('fenced code, not their project'),
  rule: z.string().describe('<= 12 words'),
});
export type EscalationLesson = z.infer<typeof EscalationLessonSchema>;

// ---------------------------------------------------------------- V1-7 roadmap

export const TaskOutSchema = z.object({
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  conceptIds: z.array(z.string()).describe('1-3'),
  estimatedMinutes: z.number(),
  interface: z.object({
    file: z.string().describe('workspace-relative'),
    functions: z
      .array(z.object({ name: z.string(), signature: z.string(), purpose: z.string().describe('<= 12 words, behaviour only') }))
      .describe('1-3'),
  }),
});
export type TaskOut = z.infer<typeof TaskOutSchema>;

/**
 * A follow-up task (spec V1-9 f). Since v0.2 it carries an interface like a roadmap task, so its
 * own TaskPrep can write a spec ladder for it.
 */
export const FollowUpSchema = TaskOutSchema.extend({
  why: z.string().describe('one sentence on what skill this sharpens'),
});
export type FollowUp = z.infer<typeof FollowUpSchema>;

export const PlanOutlineSchema = z.object({
  summary: z.string(),
  milestones: z.array(z.object({ title: z.string(), goal: z.string() })).describe('3-6'),
  concepts: z.array(ConceptSchema).describe('8-25, with tag'),
  milestone1Tasks: z.array(TaskOutSchema).describe('3-6'),
});
export type PlanOutline = z.infer<typeof PlanOutlineSchema>;

export const TaskBatchSchema = z.object({ tasks: z.array(TaskOutSchema).describe('3-6') });
export type TaskBatch = z.infer<typeof TaskBatchSchema>;

// ---------------------------------------------------------------- V1-11 spec ladder (inside TaskPrep)

export const SpecItemSchema = z.object({
  id: z.string(),
  title: z.string().describe('<= 8 words, one behaviour'),
  conceptId: z.string(),
  call: z.string().describe('one call to an interface function with literal arguments only'),
  expected: z.string().describe('exact expected result as a literal; empty if expectError'),
  expectError: z.string().describe('exception class name or empty'),
  parSec: z.number(),
  failureSignatures: z.array(
    z.object({
      match: z.enum(['equals', 'error']),
      value: z.string(),
      misconceptionId: z.string(),
      nudge: z.string().describe('<= 20 words, a question, no code'),
    }),
  ),
});
export type SpecItemOut = z.infer<typeof SpecItemSchema>;

export const SpecLadderPartSchema = z.object({
  applicable: z.boolean(),
  reason: z.string().describe('why not applicable, else empty'),
  specs: z.array(SpecItemSchema).describe('3-6, simplest first'),
  hidden: z.array(SpecItemSchema).describe('2'),
  reference: z.string().describe('private complete implementation of the interface functions, used only for verification'),
});
export type SpecLadderPart = z.infer<typeof SpecLadderPartSchema>;

// ---------------------------------------------------------------- V1-8 task gate + TaskPrep

export const GatePartSchema = z.object({
  patterns: z
    .array(
      z.object({
        name: z.string().describe('canonical pattern name when one is given, else <= 4 words'),
        conceptId: z.string(),
        required: z.boolean(),
        competesWith: z.string().describe('for lures: the required conceptId it competes with; else empty'),
        useWhen: z.string().describe('<= 12 words'),
        whyNot: z.string().describe('<= 12 words for lures, else empty'),
      }),
    )
    .describe('exactly 5'),
  plans: z
    .array(
      z.object({
        text: z.string().describe('<= 10 words, no code'),
        workable: z.boolean(),
        flawConceptId: z.string(),
        misconceptionId: z.string(),
        whyFlawed: z.string().describe('<= 20 words, phrased as a question; empty for the workable plan'),
      }),
    )
    .describe('exactly 3, similar length'),
});
export type GatePart = z.infer<typeof GatePartSchema>;

export const TaskPrepSchema = z.object({
  tasks: z.array(z.object({ taskTitle: z.string(), gate: GatePartSchema, specs: SpecLadderPartSchema })),
});
export type TaskPrep = z.infer<typeof TaskPrepSchema>;

// ---------------------------------------------------------------- V1-10 hint ladder

export const HintLadderSchema = z.object({
  diagnosis: z.string(),
  stuckType: z.enum(['concept-gap', 'slip', 'approach', 'environment', 'not-stuck']),
  conceptIds: z.array(z.string()),
  misconceptionId: z.string(),
  mistakePattern: z.string(),
  anchor: z.object({
    file: z.string().describe('workspace-relative path'),
    line: z.number().describe('1-based'),
    lineText: z.string().describe('exact text of that line'),
  }),
  rungs: z.array(z.object({ rung: z.number(), text: z.string() })).describe('exactly 3: rungs 1, 2, 3'),
});
export type HintLadder = z.infer<typeof HintLadderSchema>;

// ---------------------------------------------------------------- V1-12 own-code probes

export const OwnCodeProbeSchema = z.object({
  probes: z
    .array(
      z.object({
        file: z.string(),
        functionName: z.string(),
        callExpr: z.string().describe('one call with literal arguments only'),
        conceptId: z.string(),
        edgeCase: z.string().describe('<= 10 words'),
        misconceptionIfWrong: z.string(),
      }),
    )
    .describe('at most 3'),
});
export type OwnCodeProbes = z.infer<typeof OwnCodeProbeSchema>;
