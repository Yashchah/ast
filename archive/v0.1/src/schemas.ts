import { z } from 'zod';

// Structured-output schemas for every coach call. Fields are all required
// (empty string / empty array when not applicable) to keep the JSON schemas
// simple for constrained decoding.

export const ConceptSchema = z.object({
  id: z.string().describe('kebab-case slug, e.g. "async-await" or "array-indexing"'),
  name: z.string(),
  description: z.string().describe('one sentence'),
  prerequisites: z.array(z.string()).describe('ids of concepts that must be understood first'),
});

export const PlanSchema = z.object({
  title: z.string(),
  summary: z.string(),
  language: z.string().describe('primary programming language / stack'),
  concepts: z.array(ConceptSchema),
  milestones: z.array(
    z.object({
      title: z.string(),
      tasks: z.array(
        z.object({
          title: z.string(),
          description: z.string().describe('markdown; what to build, not how to build it'),
          acceptanceCriteria: z.array(z.string()),
          conceptIds: z.array(z.string()),
          estimatedMinutes: z.number(),
        }),
      ),
    }),
  ),
});
export type Plan = z.infer<typeof PlanSchema>;

export const DiagnosticSchema = z.object({
  questions: z.array(
    z.object({
      conceptId: z.string(),
      format: z.enum(['explain', 'predict-output', 'write-snippet', 'spot-the-bug']),
      question: z.string(),
      code: z.string().describe('code snippet shown with the question, or empty string'),
    }),
  ),
});

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

export const LessonSchema = z.object({
  title: z.string(),
  explanation: z.string().describe('markdown, <= 250 words, intuition first'),
  example: z.string().describe('markdown with one small fenced code example that is NOT the task solution'),
  keyPoints: z.array(z.string()),
  checkQuestion: z.string(),
  checkExpected: z.string().describe('what a correct answer must contain'),
});
export type Lesson = z.infer<typeof LessonSchema>;

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

export const FollowUpSchema = z.object({
  title: z.string(),
  description: z.string().describe('markdown'),
  acceptanceCriteria: z.array(z.string()),
  conceptIds: z.array(z.string()),
  estimatedMinutes: z.number(),
  why: z.string().describe('one sentence on what skill this sharpens'),
});
export type FollowUp = z.infer<typeof FollowUpSchema>;

export const AnswerSchema = z.object({
  answer: z.string().describe('markdown'),
  conceptIds: z.array(z.string()),
});

export const RevealSchema = z.object({
  explanation: z.string().describe('markdown walkthrough of the reasoning'),
  code: z.string().describe('markdown fenced code for the stuck piece only'),
  rebuildChallenge: z.string().describe('a closely related mini-task they must do from memory without looking'),
});

export const RecallSchema = z.object({
  question: z.string(),
  code: z.string(),
  expected: z.string(),
});
