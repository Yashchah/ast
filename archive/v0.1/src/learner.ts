import { Concept, ConceptState, Learner, Mistake, Task } from './types';

export const MASTERY_TARGET = 0.8;
const DAY = 24 * 60 * 60 * 1000;

export function emptyLearner(): Learner {
  return {
    concepts: {},
    mistakes: [],
    totals: { tasksDone: 0, hintsUsed: 0, reveals: 0, activeMinutes: 0 },
  };
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'concept';
}

/** Add concepts the learner has not seen yet; keep existing mastery for known ones. */
export function upsertConcepts(learner: Learner, concepts: Concept[]): void {
  for (const c of concepts) {
    const id = slug(c.id || c.name);
    const existing = learner.concepts[id];
    if (existing) {
      existing.name = existing.name || c.name;
      existing.description = existing.description || c.description;
      continue;
    }
    learner.concepts[id] = {
      id,
      name: c.name,
      description: c.description,
      prerequisites: c.prerequisites.map(slug),
      mastery: 0.3, // unknown until the diagnostic or real work says otherwise
      attempts: 0,
      hintsUsed: 0,
      lessonsSeen: 0,
      lastPracticed: 0,
      nextReview: 0,
      intervalDays: 0,
      solveTimesMin: [],
    };
  }
}

export function concept(learner: Learner, id: string): ConceptState | undefined {
  return learner.concepts[slug(id)];
}

/** Move mastery toward a target with a learning rate; keeps updates bounded and smooth. */
export function nudge(learner: Learner, ids: string[], delta: number): void {
  for (const id of ids) {
    const c = concept(learner, id);
    if (!c) continue;
    c.mastery = clamp01(c.mastery + delta * (delta > 0 ? 1 - c.mastery : c.mastery) * 1.6);
    c.lastPracticed = Date.now();
  }
}

export function setMastery(learner: Learner, id: string, value: number): void {
  const c = concept(learner, id);
  if (c) c.mastery = clamp01(value);
}

/**
 * Record a solved task. Unaided fast solves raise mastery most; hints and reveals
 * raise it less (or lower it). Also schedules spaced review.
 */
export function recordSolve(learner: Learner, task: Task): void {
  const minutes = task.activeMs / 60000;
  const maxRung = task.hints.reduce((m, h) => Math.max(m, h.rung), 0);
  const speedRatio = task.estimatedMinutes > 0 ? minutes / task.estimatedMinutes : 1;
  let delta: number;
  if (task.revealed) delta = -0.15;
  else if (maxRung === 0) delta = speedRatio <= 1.5 ? 0.35 : 0.25;
  else delta = Math.max(0.02, 0.2 - maxRung * 0.04);

  nudge(learner, task.conceptIds, delta);
  for (const id of task.conceptIds) {
    const c = concept(learner, id);
    if (!c) continue;
    c.attempts += 1;
    c.hintsUsed += task.hints.length;
    c.solveTimesMin.push(Math.round(minutes * 10) / 10);
    if (c.solveTimesMin.length > 20) c.solveTimesMin.shift();
    schedule(c, maxRung === 0 && !task.revealed);
  }
  learner.totals.tasksDone += 1;
  learner.totals.hintsUsed += task.hints.length;
  learner.totals.activeMinutes += Math.round(minutes);
  if (task.revealed) learner.totals.reveals += 1;
}

/** SM-2-lite: success doubles interval (min 1 day), failure resets to same-day review. */
export function schedule(c: ConceptState, success: boolean): void {
  if (success) c.intervalDays = c.intervalDays <= 0 ? 1 : Math.min(60, c.intervalDays * 2.2);
  else c.intervalDays = 0.25;
  c.nextReview = Date.now() + c.intervalDays * DAY;
}

export function dueForReview(learner: Learner, limit = 3): ConceptState[] {
  const now = Date.now();
  return Object.values(learner.concepts)
    .filter((c) => c.nextReview > 0 && c.nextReview <= now)
    .sort((a, b) => a.nextReview - b.nextReview)
    .slice(0, limit);
}

/**
 * How long the learner may struggle before the coach steps in.
 * Weak concepts get help sooner (struggle without the concept is wasted time);
 * strong concepts get more rope (productive struggle builds speed).
 */
export function stuckThreshold(learner: Learner, task: Task, baseMinutes: number): number {
  const ms = task.conceptIds.map((id) => concept(learner, id)?.mastery ?? 0.3);
  const avg = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0.3;
  const factor = 0.6 + avg * 0.9; // 0.6x .. 1.5x
  // Each hint already given shortens the wait before the next rung.
  const rungFactor = Math.pow(0.75, task.hints.length);
  return Math.max(2, baseMinutes * factor * rungFactor);
}

export function weakest(learner: Learner, ids: string[]): ConceptState | undefined {
  return ids
    .map((id) => concept(learner, id))
    .filter((c): c is ConceptState => !!c)
    .sort((a, b) => a.mastery - b.mastery)[0];
}

export function allMastered(learner: Learner, ids: string[]): boolean {
  return ids.every((id) => (concept(learner, id)?.mastery ?? 0) >= MASTERY_TARGET);
}

export function recordMistake(
  learner: Learner,
  m: { pattern: string; detail: string; conceptIds: string[]; taskId: string },
): Mistake {
  const key = slug(m.pattern);
  const existing = learner.mistakes.find((x) => slug(x.pattern) === key);
  if (existing) {
    existing.count += 1;
    existing.at = Date.now();
    existing.detail = m.detail;
    existing.taskId = m.taskId;
    return existing;
  }
  const mistake: Mistake = {
    id: `${key}-${Date.now().toString(36)}`,
    at: Date.now(),
    count: 1,
    ...m,
    conceptIds: m.conceptIds.map(slug),
  };
  learner.mistakes.push(mistake);
  if (learner.mistakes.length > 200) learner.mistakes.shift();
  return mistake;
}

/** Compact learner summary for prompts: only concepts relevant to the current context. */
export function snapshot(learner: Learner, ids?: string[]): string {
  const list = (ids ? ids.map((id) => concept(learner, id)).filter(Boolean) : Object.values(learner.concepts)) as ConceptState[];
  const lines = list.map(
    (c) =>
      `- ${c.id} (${c.name}): mastery ${c.mastery.toFixed(2)}, attempts ${c.attempts}, hints ${c.hintsUsed}` +
      (c.solveTimesMin.length ? `, recent solve minutes ${c.solveTimesMin.slice(-3).join('/')}` : ''),
  );
  const mistakes = learner.mistakes
    .filter((m) => !ids || m.conceptIds.some((id) => ids.includes(id)))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((m) => `- "${m.pattern}" x${m.count}: ${m.detail}`);
  return [
    'Concept mastery:',
    lines.join('\n') || '- (none tracked yet)',
    'Recurring mistakes:',
    mistakes.join('\n') || '- (none yet)',
  ].join('\n');
}
