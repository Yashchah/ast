import type { FadeLevel, TaskInterface } from './contracts';
import { Project, Task } from './types';

export const SYSTEM = `You are Deliberate, a programming coach that lives inside the learner's editor while they build a real project.

Your job is to make the learner a faster, more independent programmer. You succeed when they can solve the next problem without you, not when the current code works. So you never write their project for them. You teach the missing idea, point at where to look, ask the question that unlocks the next step, and only reveal code in the smallest piece needed to get them moving again.

How you work:
- Diagnose before you teach. Distinguish a concept gap (they do not know the idea), an approach gap (they know the pieces but not how to combine them), a slip (typo, wrong variable, missed edge case) and an environment problem (tooling, install, config). Teach only for concept and approach gaps; for slips, point at the line; for environment problems, just help directly since that is not what they are here to learn.
- Fundamentals just in time. The learner wants depth without spending hours on refreshers. Teach a fundamental only when the current task actually needs it and the evidence shows they lack it, and teach exactly as much as the task needs, tied to their code.
- Be concrete and brief. Short paragraphs, small examples, their variable names. Use markdown. No pep talk, no filler, no praise that is not specific.
- Ground every claim in what they actually wrote. Quote their line numbers when pointing at code.
- The learner profile you receive lists concept mastery (0 to 1) and recurring mistakes. Use it: go lighter on what they know, deeper on what they keep getting wrong, and name a recurring mistake when you see it again.
- Concept ids are kebab-case slugs. Reuse the ids you are given whenever one fits; invent a new id only for a genuinely new concept.

The learner profile gives each concept as P(known) with a state: Unknown, Learning, Misconception (an active wrong belief, quoted), Fixing (a belief corrected recently that may come back), Fragile (right but slow), Solid or Fluent, and whether it was tested directly or only inferred. Target active and Fixing misconceptions by name and build on what is Solid; never re-teach Solid or Fluent concepts. Misconception ids are stable kebab-case ids: reuse the ones you are given.`;

export function projectBrief(p: Project): string {
  return [
    `Project: ${p.title}`,
    `Goal (learner's words): ${p.goal}`,
    `Language: ${p.language}`,
    p.summary ? `Summary: ${p.summary}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 'Write in cli.py: parse_args(argv) -> dict; count_words(text) -> dict' (JS adds 'export'). */
export function interfaceLine(iface: TaskInterface | undefined, lang?: string): string {
  if (!iface?.file || !iface.functions?.length) return '';
  const js = lang === 'javascript' || lang === 'typescript';
  const fns = iface.functions.map((f) => `${js ? 'export ' : ''}${(f.signature || f.name).trim()}`);
  return `Write in ${iface.file}: ${fns.join('; ')}`;
}

export function taskBrief(t: Task, lang?: string): string {
  const iface = interfaceLine(t.interface, lang);
  return [
    `Current task: ${t.title}`,
    t.description,
    iface ? `Interface (fixed): ${iface}` : '',
    'Acceptance criteria:',
    ...t.acceptanceCriteria.map((c) => `- ${c}`),
    `Concepts: ${t.conceptIds.join(', ')}`,
    `Estimated: ${t.estimatedMinutes} min`,
    t.explanation ? `Learner's stated approach: ${t.explanation}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const HINT_RUNGS: Record<number, { name: string; rule: string }> = {
  1: {
    name: 'Nudge',
    rule: 'Ask one short question that directs attention to a line, value or assumption. End with a question mark. No code. Do not name the fix.',
  },
  2: {
    name: 'Concept',
    rule: 'Name the missing concept in at most 25 words and ask how it applies to a specific line of theirs. End with a question mark. No code.',
  },
  3: {
    name: 'Steps',
    rule: 'Plain-language steps for just the stuck piece, referencing their names. No real code.',
  },
  4: {
    name: 'Skeleton',
    rule: 'Give a skeleton for just the stuck piece with blanks written as ___ at the key decisions they must fill in. Explain what each blank must achieve.',
  },
  5: {
    name: 'Piece',
    rule: 'Give the exact code for only the smallest stuck piece (a few lines at most) and explain why it works line by line. Never the rest of the task. End by asking them to retype it rather than paste it.',
  },
};

export const MAX_RUNG = 5;

// =====================================================================================
// Roadmap (spec V1-7): PlanOutline and TaskBatch
// =====================================================================================

export interface PlanOutlinePromptInput {
  /** Fixed language label ('python', 'go', ...). */
  lang: string;
  /** e.g. 'Python 3.14.0', or 'no local runtime found'. */
  runtimeVersion: string;
  goal: string;
  background: string;
  snapshot: string;
  canonicalTags: readonly string[];
  /** Seed concept ids with their tags, e.g. 'list-slicing (tag list-slicing)'. */
  seedIdsWithTags: readonly string[];
  /** Files already in the workspace (extension counts or paths); '' when empty. */
  workspaceFiles?: string;
}

const isJsLang = (lang: string) => /^(javascript|typescript|js|ts)$/i.test(lang.trim());

/** The task rules PlanOutline and TaskBatch share (spec V1-7 PLANOUTLINE, from 'Put each task...'). */
function taskRules(lang: string): string[] {
  return [
    "- Put each task core logic in plain functions that take and return plain values (numbers, strings, lists, dicts). File, network, input and UI work goes in thin outer code under a main guard (if __name__ == '__main__' in Python, a guarded main() call in JS), so behaviour can be checked by fast local specs.",
    `- interface: the one workspace-relative file and 1-3 function signatures the learner writes (name and signature only${isJsLang(lang) ? '; the functions are exported' : ''}). Reuse an existing file when a task extends it.`,
    '- Tag each task with the 1-3 concept ids it exercises most.',
    '- Task descriptions say what to build and how to check it works, never how to implement it.',
  ];
}

/** PLANOUTLINE (medium effort, background; deliberate.planEffort can raise it to high). */
export function planOutlinePrompt(i: PlanOutlinePromptInput): string {
  return [
    `Design a learning roadmap for this goal. The language is fixed: ${i.lang} (${i.runtimeVersion}); do not change it.`,
    `Goal: ${i.goal}. Background: ${i.background || '(not given)'}. Learner profile: ${i.snapshot}.`,
    '- 3 to 6 milestones, each with a title and a one-sentence goal.',
    `- List every concept the project needs, including the fundamentals the tasks rely on (8-25 concepts), with prerequisites. For each concept set tag to the closest canonical tag from this list, or other: ${i.canonicalTags.join(', ')}. Reuse these concept ids exactly when the project needs the idea (they match the learner history): ${i.seedIdsWithTags.join(', ') || 'none'}.`,
    '- For milestone 1 only, write 3 to 6 tasks. Each task is 5-15 minutes of building and ends with something that runs. The first is a 5-10 minute warm-up. Each builds on the code from the previous one.',
    ...taskRules(i.lang),
    ...(i.workspaceFiles ? [`Files already in the workspace: ${i.workspaceFiles}`] : []),
  ].join('\n');
}

export interface TaskBatchPromptInput {
  lang: string;
  runtimeVersion: string;
  goal: string;
  projectSummary: string;
  /** 1-based milestone number and its title / goal. */
  milestoneNumber: number;
  milestone: string;
  /** Concept ids of the project with their tags and names (reuse them). */
  concepts: readonly string[];
  snapshot: string;
  /** 'cli.py: parse_args(argv) -> dict; count_words(text) -> dict' per file. */
  codeSoFar: string;
  fade: FadeLevel;
  /** Titles of tasks already done or planned (do not repeat them). */
  doneTitles: readonly string[];
}

/** TASKBATCH (medium effort, background): the task rules plus the milestone and scaffolding level. */
export function taskBatchPrompt(i: TaskBatchPromptInput): string {
  return [
    `Write the next tasks of a learning roadmap. The language is fixed: ${i.lang} (${i.runtimeVersion}); do not change it.`,
    `Goal: ${i.goal}. Project summary: ${i.projectSummary}.`,
    `Concepts of this project (id, tag, name; reuse these ids): ${i.concepts.join('; ') || 'none'}`,
    `Learner profile: ${i.snapshot}`,
    `Tasks already in the roadmap (do not repeat them): ${i.doneTitles.join('; ') || 'none'}`,
    '- Write 3 to 6 tasks. Each task is 5-15 minutes of building and ends with something that runs. Each builds on the code from the previous one.',
    ...taskRules(i.lang),
    `Write the tasks for milestone ${i.milestoneNumber}: ${i.milestone}. Code so far: ${i.codeSoFar || '(no files yet)'}. Scaffolding level: ${i.fade}. At partial, tasks may be 10-20 minutes; at minimal, 20-30 minutes, and descriptions name only the behaviour and the interface.`,
  ].join('\n');
}

// =====================================================================================
// TaskPrep (spec V1-8 + V1-11): gate pack and spec ladder for up to 3 tasks
// =====================================================================================

export interface TaskPrepTaskInput {
  title: string;
  description: string;
  acceptanceCriteria: readonly string[];
  conceptIds: readonly string[];
  interface: TaskInterface;
}

export interface TaskPrepPromptInput {
  lang: string;
  runtimeVersion: string;
  tasks: readonly TaskPrepTaskInput[];
  /** 'Count with dict (counting-with-dict)' per concept with a canonical pattern name. */
  patternNames: readonly string[];
  /** Known misconceptions of the tasks' tags, 'counting-with-dict: assign-one-each-time (counts[w] = 1 adds one each time)'. */
  misconceptions?: readonly string[];
  snapshot: string;
  fileList: string;
  /** Current content of each interface file that exists ('' when none). */
  contents: string;
}

function interfaceText(iface: TaskInterface, lang: string): string {
  const js = isJsLang(lang);
  const fns = (iface.functions ?? []).map((f) => `${js ? 'export ' : ''}${(f.signature || f.name).trim()}${f.purpose ? ` (${f.purpose.trim()})` : ''}`);
  return `file ${iface.file}: ${fns.join('; ') || '(no functions)'}`;
}

/** SPEC SECTION of TASKPREP (spec V1-11 prompts). The interface is given per task above it. */
export function specSection(lang: string, iface?: TaskInterface): string {
  const literal = lang === 'python' ? 'Python literal' : 'JSON value';
  return [
    '- applicable: false if the task is mainly UI, graphics, network, timing, interactive input or needs a running server; then give reason and leave the rest empty.',
    `- The interface is fixed: ${iface ? interfaceText(iface, lang) : 'the interface given with each task'}. Specs call only these functions.`,
    `- specs: 3-6 in the order a learner should build them, simplest first; title <= 8 words naming ONE behaviour; call is a single call with literal arguments only (no variables, no other code); expected is the exact result as a ${literal}, or set expectError to the exception class name; parSec = active seconds a competent learner needs after the previous spec; conceptId from the given ids.`,
    '- call, expected and every failure value are one line of source text: inside a string literal write a newline or tab as the escape \\n or \\t, never as the character itself.',
    '- failureSignatures: 1-3 per spec: wrong results a learner with a specific misconception would produce (match equals with the wrong literal, or error with the exception name), its misconceptionId (a known id when one fits), and nudge: a question of <= 20 words that points at the cause, no code.',
    '- hidden: 2 more specs with fresh inputs for the same behaviours, to catch hard-coded answers.',
    `- reference: a complete, simple, idiomatic implementation of the interface functions (plus any helpers they need), consistent with the existing files shown; used only by the coach to verify the specs and never shown to the learner.${lang === 'typescript' ? ' Use only erasable TypeScript syntax.' : ''}`,
    'Do not assert incidental details (exact error message text, dict key order, float formatting).',
  ].join('\n');
}

/** TASKPREP (medium effort, background; one call for up to 3 tasks). */
export function taskPrepPrompt(i: TaskPrepPromptInput): string {
  const tasks = i.tasks
    .map((t, k) =>
      [
        `${k + 1}. ${t.title}`,
        `   ${t.description.replace(/\s*\n\s*/g, ' ')}`,
        `   Acceptance criteria: ${t.acceptanceCriteria.join('; ') || 'none'}`,
        `   conceptIds: ${t.conceptIds.join(', ')}`,
        `   interface: ${interfaceText(t.interface, i.lang)}`,
      ].join('\n'),
    )
    .join('\n');
  return [
    'Prepare the pre-coding gate and the behaviour specs for each task below. Both are graded locally from your answer key, so be exact.',
    `Language: ${i.lang} (${i.runtimeVersion}). Tasks:\n${tasks}`,
    `Canonical pattern names (use exactly when they apply): ${i.patternNames.join('; ') || 'none'}`,
    ...(i.misconceptions?.length ? [`Known misconception ids for these concepts (reuse one whenever it fits): ${i.misconceptions.join('; ')}`] : []),
    `Learner profile: ${i.snapshot}`,
    `Files in the workspace now: ${i.fileList || '(none)'}; current content of each interface file that exists: ${i.contents || '(none yet)'}`,
    'For each task (taskTitle: the task title exactly as given):',
    'GATE',
    '- patterns: exactly 5. 2-3 are required (the task cannot be done well without them); the rest are near-miss lures a beginner might wrongly choose. For each lure give competesWith (the required conceptId it would replace) and whyNot <= 12 words saying why it does not fit THIS task. Do not list a valid alternative approach as a lure. name: the canonical name, else <= 4 words.',
    '- plans: exactly 3 plain-language plans of <= 10 words each, no code, of similar length. The 5 pattern names and the 3 plans together must total <= 50 words (the reading budget; over it the plan pick is skipped), so aim for about 8 words per plan. Exactly one is workable. Each of the other two hides one concept flaw that would actually bite; give flawConceptId, a misconceptionId (reuse a known id if one fits) and whyFlawed <= 20 words phrased as the question that exposes it. Do not make the flawed plans obviously silly or shorter.',
    'SPECS',
    specSection(i.lang),
    'Never give implementation code except in the private reference.',
  ].join('\n');
}

/**
 * Spec ladder REPAIR (low effort): the failing specs with their reasons and actual results. The call
 * is stateless, so the last ladder is appended, WITHOUT its private reference (the reference is never
 * sent to another prompt): an empty reference means 'keep the one you wrote'.
 */
export function specRepairPrompt(
  failures: readonly { id: string; reason: string; actual?: string }[],
  ladder?: { specs: unknown[]; hidden: unknown[] },
): string {
  const list = failures.map((f) => `- ${f.id}: ${f.reason}${f.actual !== undefined ? ` (actual: ${f.actual})` : ''}`).join('\n');
  const text = `These specs failed against your reference or did not fail cleanly against an empty stub:\n${list}\nReturn the ladder with only these specs fixed (or removed).`;
  if (!ladder) return text;
  return (
    `${text}\nYour last ladder (specs and hidden, ids unchanged):\n${JSON.stringify({ specs: ladder.specs, hidden: ladder.hidden })}\n` +
    'Set reference to an empty string unless the failures show your reference itself was wrong; then return a corrected complete reference.'
  );
}

// =====================================================================================
// Follow-ups (spec V1-9 f) and reviews
// =====================================================================================

export interface FollowUpPromptInput {
  projectBrief: string;
  taskBrief: string;
  howItWent: string;
  learnerProfile: string;
  upcoming: readonly string[];
  weakest: { id: string; p: number; chip: string; belief?: string };
}

/** generateFollowUp: the v0.1 prompt plus the spec V1-9 addition (the weakest concept and its belief). */
export function followUpPrompt(i: FollowUpPromptInput): string {
  const w = i.weakest;
  return [
    i.projectBrief,
    `Just completed: ${i.taskBrief}`,
    `How it went: ${i.howItWent}`,
    `Learner profile:\n${i.learnerProfile}`,
    `Upcoming roadmap tasks (do not duplicate): ${i.upcoming.join('; ') || 'none'}`,
    '',
    'Design the next follow-up task. It extends their actual project code (not a toy exercise) and makes them apply the weakest concept again in a slightly new situation.',
    '- If they struggled a lot or needed a reveal: stay close to the original idea in a new context, small scope.',
    '- If they solved it unaided but slowly: similar difficulty, aim for fluency and speed.',
    '- If they solved it fast and unaided: raise the difficulty one step.',
    'Describe what to build, not how.',
    `Weakest concept: ${w.id} (P ${w.p.toFixed(2)}, state ${w.chip})${w.belief ? ', active misconception: ' + w.belief : ''}. The follow-up must make that belief cause a visible failure if they still hold it. 5-15 minutes; core logic in plain functions with an interface (file and 1-3 signatures) so it can be checked by specs.`,
  ].join('\n');
}

/** POLISH-ONLY REVIEW (opt-in via deliberate.polishReview; added to checkWork when specs passed). */
export const POLISH_ONLY =
  'All behaviour specs pass, including hidden ones. Review only design, naming, structure and robustness the specs cannot see. meetsCriteria is true unless there is a blocker. At most 2 polish items. explainBackQuestion: empty string (the coach checks understanding with what-if questions on their code).';

export interface WorkReviewPromptInput {
  projectBrief: string;
  taskBrief: string;
  learnerProfile: string;
  code: string;
  previous?: { at: number; summary: string; issues: string[] };
  now: number;
  polishOnly?: boolean;
}

/** Check my work (no applicable spec ladder): medium effort since v0.2. */
export function workReviewPrompt(i: WorkReviewPromptInput): string {
  const prev = i.previous;
  return [
    i.projectBrief,
    i.taskBrief,
    `Learner profile:\n${i.learnerProfile}`,
    `Their code:\n${i.code}`,
    prev
      ? `This is a RE-CHECK. Your previous review (${Math.round((i.now - prev.at) / 60000)} min ago) said: ${prev.summary}\n` +
        `Issues raised then:\n${prev.issues.map((x) => `- ${x}`).join('\n') || '- none'}\n` +
        'The learner has changed the code since. Judge ONLY the current code above: for each earlier issue, check whether the current code fixed it and say so explicitly in the summary; never repeat an issue the current code no longer has. Terminal output older than the latest edit is not evidence.'
      : '',
    '',
    i.polishOnly
      ? POLISH_ONLY
      : [
          'Review their work against the acceptance criteria. meetsCriteria is true only if every criterion is satisfied and there is no blocker.',
          'For each issue, give a Socratic question or pointer to the line, never the corrected code. Mention at most 2 polish items.',
          'mistakePatterns: genuine, reusable mistake patterns present in their code (empty if none).',
          'explainBackQuestion: ask them to explain one key decision in their solution, the one most likely to reveal whether they really understand it.',
        ].join('\n'),
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

/** The free-text own plan ('I'd do it differently'), reviewed in the background. */
export function explanationReviewPrompt(i: { projectBrief: string; taskBrief: string; learnerProfile: string; attempt: number; text: string }): string {
  return [
    i.projectBrief,
    i.taskBrief,
    `Learner profile:\n${i.learnerProfile}`,
    `Attempt #${i.attempt} at explaining the approach. Their explanation:\n"""${i.text}"""`,
    '',
    'Judge whether this approach would work and whether they understand the concepts it depends on.',
    '- verdict "ready" if the approach is workable. It does not have to be complete: small issues they will discover while coding are good for learning; raise at most one as a heads-up question.',
    '- verdict "gaps" if a missing or wrong concept would block them. List each gap with its concept id.',
    '- verdict "lost" if there is no workable approach yet.',
    'Do not hand them the approach. In feedback say concretely what is right, and phrase what is missing as questions.',
  ].join('\n');
}

/** Open-ended answer grading (explain-back fallback, free text), low effort, background. */
export function gradePrompt(question: string, expected: string, answer: string, extra = ''): string {
  return [
    `Question:\n${question}`,
    expected ? `A correct answer must contain: ${expected}` : '',
    extra,
    `Learner's answer:\n"""${answer}"""`,
    '',
    'Grade it. Accept informal wording that shows the right understanding; reject answers vague enough to hide a misconception.',
    'feedback: if wrong, explain the correct idea briefly and concretely; if right, add one sentence that deepens it. misconception: the underlying wrong belief, if any.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** guideApproach(): after 2 flawed plan picks in one task, generated in the background as a card. */
export function guideApproachPrompt(i: { projectBrief: string; taskBrief: string; learnerProfile: string }): string {
  return [
    i.projectBrief,
    i.taskBrief,
    `Learner profile:\n${i.learnerProfile}`,
    'They picked flawed plans for this task twice. Walk them through how to think about it: break it into steps in plain language (no code), and for each step say why it is needed and which concept it uses.',
    'End by asking them to restate the plan in their own words so they own it. At most 150 words.',
  ].join('\n');
}

/** Rungs 4-5 (HintSchema, low effort). */
export function rungHintPrompt(i: {
  projectBrief: string;
  taskBrief: string;
  learnerProfile: string;
  stuckReasons: readonly string[];
  previousHints: readonly string[];
  codeSnapshot: string;
  rung: number;
}): string {
  const r = HINT_RUNGS[i.rung] ?? HINT_RUNGS[MAX_RUNG];
  return [
    i.projectBrief,
    i.taskBrief,
    `Learner profile:\n${i.learnerProfile}`,
    `Stuck signals: ${i.stuckReasons.join('; ') || 'learner asked for a hint'}`,
    i.previousHints.length ? `Hints already given (do not repeat; build on them):\n${i.previousHints.map((h, k) => `${k + 1}. ${h}`).join('\n')}` : '',
    `Their code right now:\n${i.codeSnapshot}`,
    '',
    `First diagnose what they are stuck on. Then give a rung ${i.rung} hint ("${r.name}"): ${r.rule}`,
    i.rung === 4
      ? 'Put the skeleton in ONE fenced code block; it opens in a practice tab, never in their files. Write each blank as ___ exactly.'
      : 'Put the code in ONE fenced code block of at most 6 lines.',
    'If it is an environment/tooling problem, just tell them how to fix it directly whatever the rung. If they are not actually stuck (the code meets the criteria), say so with stuckType "not-stuck".',
    'If it is a slip or a recurring mistake from their profile, name the pattern in mistakePattern.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Reveal (foreground): the smallest piece plus a rebuild challenge. */
export function revealPrompt(i: { projectBrief: string; taskBrief: string; hints: string; code: string }): string {
  return [
    i.projectBrief,
    i.taskBrief,
    `Hints already given: ${i.hints || 'none'}`,
    `Their code:\n${i.code}`,
    '',
    'They asked to see the solution for the piece they are stuck on. Show only the smallest piece of code that unblocks them, with a walkthrough of the reasoning.',
    'Then set a rebuild challenge: a closely related mini-task they must do from memory without looking.',
  ].join('\n');
}

/** Ask the coach (foreground). */
export function askPrompt(i: { projectBrief?: string; taskBrief?: string; learnerProfile: string; code?: string; question: string }): string {
  return [
    i.projectBrief ?? '',
    i.taskBrief ?? '',
    `Learner profile:\n${i.learnerProfile}`,
    i.code ? `Their code:\n${i.code}` : '',
    `Their question: """${i.question}"""`,
    '',
    'Answer as their coach. Conceptual questions: explain clearly with a small example. Tooling/setup questions: answer directly.',
    'If the question asks for the solution to their current task, do not hand it over: answer at the level of a concept explanation or approach hint and point them at where to look.',
    'conceptIds: concepts the question touches.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Teach for a language without practice items (no pad): a short lesson card (<= 120 words). */
export function shortLessonPrompt(i: { projectBrief: string; concept: string; learnerProfile: string }): string {
  return [
    i.projectBrief,
    `Concept to teach: ${i.concept}`,
    `Learner profile:\n${i.learnerProfile}`,
    'Write a lesson of at most 120 words: one sentence on the problem the idea solves, one small example that is not their project code with its output, and a one-line rule. End with one predict-the-output question about a 3-line snippet. conceptIds: the concept id.',
  ].join('\n');
}
