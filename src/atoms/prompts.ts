// Model prompts for atom content (spec V1-5 prompts): ATOMPACK, MINI ATOM, PROBES-ONLY, REPAIR,
// MISCONCEPTION GUESS and ESCALATION LESSON. The text is the spec's, word for word; the template
// variables are parameters. Pure module: no vscode import.

import type { Lang, Runtime } from '../contracts';
import type { AtomPack } from '../schemas';
import { PY_ALLOWED_IMPORTS } from '../runner';
import { misconceptionsFor, OTHER_TAG, tagInfo } from './tags';
import type { RepairItem } from './verify';

/** Effort per prompt, as the spec schedules them. */
export const PROMPT_EFFORT = {
  atomPack: 'medium',
  miniAtom: 'low',
  probesOnly: 'low',
  repair: 'low',
  misconceptionGuess: 'low',
  escalationLesson: 'low',
} as const;

/** Most stderr a repair prompt quotes per failure. */
export const REPAIR_STDERR_CHARS = 300;

// ---------------------------------------------------------------- inputs

export interface AtomPackConcept {
  id: string;
  /** Canonical tag, or 'other'. */
  tag: string;
  kind: 'shape' | 'semantics';
  /** Canonical pattern name from the taxonomy; a short name for 'other' concepts. */
  patternName: string;
  description: string;
}

export interface AtomPackPromptInput {
  /** What runs the code, e.g. 'Python 3.14.0' (see runtimeLabel). */
  runtime: string;
  lang: Lang | string;
  concepts: AtomPackConcept[];
  /** Known misconceptions of these tags (see taxonomyFor). */
  taxonomy: { tag: string; id: string; belief: string }[];
  /** Constructs the learner already knows. */
  allowedConstructs: readonly string[];
  allowedImports: readonly string[];
  /** Learner snapshot for these concept ids. */
  snapshot: string;
  projectSummary: string;
  taskTitles: readonly string[];
  /** Any concept's tag is type-sensitive (see anyTypeSensitive). */
  typeSensitive: boolean;
  /** Go / Java / Rust: probes are written as the body of main. */
  compiled?: boolean;
}

export interface MisconceptionGuessInput {
  lang: Lang | string;
  code: string;
  actual: string;
  answer: string;
  known: { id: string; belief: string }[];
}

export interface EscalationLessonInput {
  projectBrief: string;
  concept: { id: string; name: string; description: string };
  belief: string;
  misconceptionId: string;
  /** The graded items that showed the belief. */
  items: { code: string; answer: string; actual: string }[];
}

// ---------------------------------------------------------------- input helpers

/** 'Python 3.14.0', 'Node v24.11.1', 'Node v24.11.1 (TypeScript, strip mode)'. */
export function runtimeLabel(rt: Pick<Runtime, 'lang' | 'version' | 'tsMode'>): string {
  if (rt.lang === 'python') return `Python ${rt.version.replace(/^python\s*/i, '')}`;
  const node = `Node ${rt.version.startsWith('v') ? rt.version : `v${rt.version}`}`;
  return rt.lang === 'typescript' ? `${node} (TypeScript, ${rt.tsMode ?? 'strip'} mode)` : node;
}

/** A concept line for the ATOMPACK prompt: kind and canonical name come from the taxonomy. */
export function packConcept(id: string, tag: string, description: string, name = ''): AtomPackConcept {
  const info = tag !== OTHER_TAG ? tagInfo(tag) : undefined;
  return {
    id,
    tag: info ? tag : OTHER_TAG,
    kind: info?.kind ?? 'shape',
    patternName: info?.patternName ?? (name || id),
    description,
  };
}

/** The taxonomy misconceptions of these tags in this language. */
export function taxonomyFor(tags: readonly string[], lang: Lang): { tag: string; id: string; belief: string }[] {
  return [...new Set(tags)].flatMap((tag) => misconceptionsFor(tag, lang).map((m) => ({ tag, id: m.id, belief: m.belief })));
}

export function anyTypeSensitive(tags: readonly string[]): boolean {
  return tags.some((t) => !!tagInfo(t)?.typeSensitive);
}

/** Extra imports the tags allow (on top of the runner's base allowlist). */
export function tagImports(tags: readonly string[]): string[] {
  return [...new Set(tags.flatMap((t) => tagInfo(t)?.allowedImports ?? []))];
}

/**
 * AtomPackPromptInput.allowedImports: the runner's base Python allowlist plus the tags' extras (and,
 * for 'other' concepts, what LocalRunner.findPythonModules found). JS/TS snippets may not import.
 */
export function allowedImportsFor(lang: Lang | string, tags: readonly string[], found: readonly string[] = []): string[] {
  if (lang !== 'python') return [];
  return [...new Set([...PY_ALLOWED_IMPORTS.filter((m) => m !== '__future__'), ...tagImports(tags), ...found])];
}

const listOr = (xs: readonly string[], sep: string, none = 'none') => (xs.length ? xs.join(sep) : none);

// ---------------------------------------------------------------- ATOMPACK and its variants

/** ATOMPACK (medium effort, background; only for tags without seeds and for project concepts). */
export function atomPackPrompt(p: AtomPackPromptInput): string {
  const list = p.concepts.map((c) => `\n- ${c.id}, ${c.tag}, ${c.kind}, ${c.patternName}, ${c.description}`).join('');
  const taxonomy = listOr(p.taxonomy.map((m) => `${m.tag}: ${m.id} (${m.belief})`), '; ');
  const typeLine = p.typeSensitive ? ' Print with repr() / type(x).__name__ (Python) or JSON.stringify / typeof (JS) so the type is visible.' : '';
  const langLine =
    (p.lang === 'typescript' ? 'Use only erasable TypeScript syntax: no enum, namespace or parameter properties.' : '') +
    (p.compiled ? 'Write each probe, example and contrast as the body of main only, listing imports at the top.' : '');
  return [
    `You write practice items for a coding coach. The coach grades the learner by RUNNING your code with ${p.runtime}, so it must be exact and deterministic.`,
    `Language: ${p.lang}. Concepts (id, tag, kind, canonical pattern name, description): ${list}.`,
    `Known misconception ids for these tags (reuse when one fits): ${taxonomy}.`,
    `The learner already knows these constructs; probes may use ONLY these plus the concept itself: ${listOr(p.allowedConstructs, ', ', '(none)')}.`,
    `Allowed imports: ${listOr(p.allowedImports, ', ')}. No input(), files, network, randomness, clock, or dependence on set ordering.`,
    `Learner profile: ${p.snapshot}`,
    `Project domain for variety: ${p.projectSummary}. Never write code that solves or mirrors these tasks: ${listOr(p.taskTitles, '; ')}.`,
    'For EACH concept write one atom:',
    '- pattern: kind shape or semantics as given. name: the canonical pattern name exactly. useWhen <= 12 words. For shape: template <= 3 lines using <holes>. For semantics: rule <= 12 words and howItRuns <= 20 words, template empty. pitfall <= 12 words. useCases: 6-8 different one-line problems (<= 12 words) where this pattern or rule decides the answer.',
    `- probes: exactly 4 predict-the-output items, each in its own siblingGroup (a group is a surface: names, data, story; groups must look unrelated). Each is <= 8 lines and prints 1-4 lines, and its output hinges on the concept, so someone missing it predicts wrong. Prefer outputs that are lists, strings or several lines over a single small number.${typeLine} answer: the exact output. parSec: thinking seconds for a competent learner (3-8).`,
    '- mutants: for each probe, 1-3 copies with exactly ONE line changed, so that running the copy prints what a learner holding one specific wrong belief would predict for the ORIGINAL code (for example, belief slice end is included: change xs[1:3] to xs[1:4]). Each must print something different from the original and from the other mutants by more than one character: a one-character difference (3 vs 1) reads as a typo and can never name the belief, so pick data where the belief changes the output visibly. prints: the exact output of the mutant. belief: <= 12 words in plain learner words. refutation: <= 25 words, concrete, about this code, without quoting any output values.',
    '- example: 5-8 lines applying the pattern on a new surface and printing its result; subgoals: a label of <= 6 words for each meaningful line (1-based).',
    '- completion: 6-10 lines on another new surface; the pattern code sits inside a function; 1-2 blanks written [[1]], [[2]] exactly where the pattern lives; solutions: the exact text for each blank; wrongFills: 1-2 plausible wrong fills with misconceptionId; harness: lines appended after the code that call the function with at least 2 different inputs using check(condition, message) (check is predefined; do not use assert, require or process), print nothing, and pass only with correct fills.',
    '- contrast: two snippets of <= 4 lines that each print their result, identical except for the one feature that matters, so the two print different outputs; with misconceptionId and a rule of <= 12 words.',
    ...(langLine ? [langLine] : []),
    'Write for a beginner who reads at most 60 words per atom. Gloss any jargon in 3 words.',
  ].join('\n');
}

/** MINI ATOM (foreground, low effort): pattern, 2 probes and the completion. */
export function miniAtomPrompt(p: AtomPackPromptInput): string {
  return `${atomPackPrompt(p)}\nWrite the pattern, 2 probes (in 2 sibling groups, with mutants) and the completion only; set the example and contrast fields to empty strings and empty arrays.`;
}

/** PROBES-ONLY SEED VARIANT (languages without seeds, at placement, low effort). */
export function probesOnlyPrompt(p: AtomPackPromptInput): string {
  return `${atomPackPrompt(p)}\nWrite the pattern and the probes (with mutants) only; set example, completion and contrast to empty strings and empty arrays.`;
}

// ---------------------------------------------------------------- REPAIR

/** One failure line: conceptId, item id, what failed, stderr tail <= 300 chars. */
export function repairLine(f: RepairItem): string {
  const err = f.stderr.trim();
  const tail = err.length > REPAIR_STDERR_CHARS ? err.slice(-REPAIR_STDERR_CHARS) : err;
  return `- ${f.conceptId}, ${f.itemId}: ${f.what}${tail ? `\n  stderr: ${tail.replace(/\s*\n\s*/g, ' | ')}` : ''}`;
}

/**
 * REPAIR (low effort). The call is stateless, so the previous pack is appended as JSON: the model
 * cannot return 'the same atoms' without seeing them.
 */
export function repairPrompt(runtime: string, failures: readonly RepairItem[], previous?: AtomPack): string {
  const text =
    `These items from your last pack failed when run locally with ${runtime}:\n${failures.map(repairLine).join('\n')}\n` +
    'Return the same atoms with ONLY these items corrected. If your answer was wrong, rewrite the probe, its mutants and its refutation from scratch rather than adjusting the answer. Keep items that passed unchanged.';
  return previous ? `${text}\nYour last pack:\n${JSON.stringify(previous)}` : text;
}

// ---------------------------------------------------------------- MISCONCEPTION GUESS

const fence = (lang: string, code: string) => `\n\`\`\`${lang}\n${code.replace(/\s+$/, '')}\n\`\`\`\n`;

/** MISCONCEPTION GUESS (low effort, opt-in via deliberate.nameNewMisconceptions). */
export function misconceptionGuessPrompt(p: MisconceptionGuessInput): string {
  const known = listOr(p.known.map((m) => `${m.id}: ${m.belief}`), '; ');
  return (
    `A learner predicted the output of this ${p.lang} code:${fence(String(p.lang), p.code)}Actual output: ${p.actual}. Their answer: ${p.answer}. ` +
    `Known misconceptions for this concept: ${known}. If one known misconception explains their answer, return it as knownId. ` +
    'Otherwise propose newId (kebab-case), belief (the wrong belief in plain learner words, <= 12 words), refutation (<= 25 words, no output values) and mutantCode: the code with one line changed so that running it prints exactly their answer under that belief (empty string if impossible). ' +
    'Set slip true if the answer looks like a typo or careless slip rather than a belief.'
  );
}

// ---------------------------------------------------------------- ESCALATION LESSON

/** ESCALATION LESSON (low effort, fired when a re-probe fails). */
export function escalationLessonPrompt(p: EscalationLessonInput): string {
  const brief = p.projectBrief.trim();
  const items = p.items
    .map((it, i) => `\nItem ${i + 1}:${fence('', it.code)}Their answer: ${it.answer}\nActual output: ${it.actual}`)
    .join('');
  return (
    `${brief}${/[.!?]$/.test(brief) ? '' : '.'} Concept: ${p.concept.id} - ${p.concept.name}: ${p.concept.description}. ` +
    `The learner confirmed holding this wrong belief: ${p.belief} (misconception ${p.misconceptionId}). Evidence: ${items || 'none'}\n` +
    'Write a lesson of at most 120 words that dislodges exactly this belief: (1) one sentence on why the belief seems reasonable, (2) the one fact that breaks it, shown with a 3-line example that is not their project code, with its real output, (3) a one-line rule they can apply. title: the fact in <= 6 words. Talk to the learner in plain words and never mention the misconception id. No check question, no headings, no general overview of the topic.'
  );
}
