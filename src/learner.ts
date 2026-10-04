import { ConceptChip, MisconceptionState, PatternCard } from './contracts';
import {
  addUnique, applyEvidence, ApplyResult, chip, clamp, CoverageFn, EvidenceRecord, isMastered, Outcome, PARAMS, resolveId,
  scheduleOutcome, TaxonomyFn, touch,
} from './evidence';
import { Concept, ConceptState, Learner, Mistake, Task } from './types';

/** @deprecated Mastery is isMastered() now (P >= .85 plus production, groups and coverage). */
export const MASTERY_TARGET = 0.8;
/** Pseudo-concept for planning skill: rung 3+ hints, flawed plan picks and solo tasks feed it. */
export const DECOMPOSITION = 'decomposition';
/** P(known) of a concept nothing has been observed about. */
export const PRIOR = 0.3;

export function emptyLearner(): Learner {
  return {
    concepts: {},
    mistakes: [],
    totals: { tasksDone: 0, hintsUsed: 0, reveals: 0, activeMinutes: 0 },
    audits: { passed: 0, failed: 0 },
    calibration: { sure: [0, 0], guess: [0, 0] },
    speedFactor: 1,
    cps: PARAMS.latency.cps,
    keyUse: {},
    patternDeck: [],
    gradedCount: 0,
    recentRatios: [],
    logCheckpoint: 0,
    falseMastery: [],
  };
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'concept';
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------- migration

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : []);
const pair = (v: unknown): [number, number] => (Array.isArray(v) ? [num(v[0], 0), num(v[1], 0)] : [0, 0]);

function migrateMisconceptions(v: unknown): Record<string, MisconceptionState> {
  const out: Record<string, MisconceptionState> = {};
  for (const [id, raw] of Object.entries(obj(v))) {
    const m = obj(raw);
    const status = m.status === 'active' || m.status === 'suppressed' || m.status === 'cleared' ? m.status : 'candidate';
    out[id] = {
      ...m,
      p: clamp01(num(m.p, PARAMS.misconception.prior)),
      belief: str(m.belief, ''),
      status,
      groups: strs(m.groups),
      refutedAt: optNum(m.refutedAt),
      delayedHits: num(m.delayedHits, 0),
      relapses: num(m.relapses, 0),
      lastAt: num(m.lastAt, 0),
      nextCheckAt: optNum(m.nextCheckAt),
    };
  }
  return out;
}

/**
 * Bring a stored concept up to the evidence model. The old mastery is kept as the P prior;
 * new fields get defaults, with tested = attempts > 0. Unknown fields are preserved.
 */
export function migrateConcept(id: string, raw: unknown): ConceptState {
  const r = obj(raw);
  const attempts = num(r.attempts, 0);
  const lastPracticed = num(r.lastPracticed, 0);
  const kind = r.kind === 'shape' || r.kind === 'semantics' ? r.kind : undefined;
  const selfRating = r.selfRating === 'used' || r.selfRating === 'not-used' ? r.selfRating : undefined;
  const fluency = Array.isArray(r.fluency)
    ? r.fluency.map(obj).filter((f) => typeof f.ratio === 'number' && typeof f.at === 'number').map((f) => ({ ratio: f.ratio as number, at: f.at as number }))
    : [];
  return {
    ...r,
    id,
    name: str(r.name, id),
    description: str(r.description, ''),
    prerequisites: strs(r.prerequisites),
    mastery: clamp01(num(r.mastery, PRIOR)),
    attempts,
    hintsUsed: num(r.hintsUsed, 0),
    lessonsSeen: num(r.lessonsSeen, 0),
    lastPracticed,
    nextReview: num(r.nextReview, 0),
    intervalDays: num(r.intervalDays, 0),
    solveTimesMin: nums(r.solveTimesMin),
    tag: typeof r.tag === 'string' && r.tag ? r.tag : undefined,
    kind,
    aliases: strs(r.aliases),
    tested: typeof r.tested === 'boolean' ? r.tested : attempts > 0,
    inferred: r.inferred === true,
    supportFrom: strs(r.supportFrom),
    groupsCorrect: strs(r.groupsCorrect),
    production: r.production === true,
    coveredMisconceptions: strs(r.coveredMisconceptions),
    fragile: r.fragile === true,
    fragileSince: optNum(r.fragileSince),
    masteredAt: optNum(r.masteredAt),
    auditDueAt: optNum(r.auditDueAt),
    probeable: r.probeable !== false,
    misconceptions: migrateMisconceptions(r.misconceptions),
    fluency,
    selfRating,
    selectionGap: r.selectionGap === true ? true : undefined,
    lastAt: num(r.lastAt, lastPracticed),
    wrongGroups: strs(r.wrongGroups),
    lastWrongAt: optNum(r.lastWrongAt),
  };
}

/** Load any stored profile (v0.1 or later) as a current Learner. Idempotent. */
export function migrateLearner(raw: unknown): Learner {
  const r = obj(raw);
  const concepts: Record<string, ConceptState> = {};
  for (const [id, c] of Object.entries(obj(r.concepts))) if (c && typeof c === 'object') concepts[id] = migrateConcept(id, c);
  const totals = obj(r.totals);
  const audits = obj(r.audits);
  const cal = obj(r.calibration);
  const keyUse: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(r.keyUse))) if (typeof v === 'number' && Number.isFinite(v)) keyUse[k] = v;
  const mistakes = (Array.isArray(r.mistakes) ? r.mistakes : [])
    .map(obj)
    .filter((m) => typeof m.pattern === 'string')
    .map((m) => ({
      ...m,
      id: str(m.id, slug(m.pattern as string)),
      conceptIds: strs(m.conceptIds),
      count: num(m.count, 1),
      at: num(m.at, 0),
      detail: str(m.detail, ''),
      taskId: str(m.taskId, ''),
    }) as Mistake);
  const falseMastery = (Array.isArray(r.falseMastery) ? r.falseMastery : [])
    .map(obj)
    .filter((f) => typeof f.conceptId === 'string' && typeof f.at === 'number')
    .map((f) => ({ conceptId: f.conceptId as string, at: f.at as number }));
  const [lo, hi] = PARAMS.latency.speedFactor;
  return {
    ...r,
    concepts,
    mistakes,
    totals: {
      tasksDone: num(totals.tasksDone, 0),
      hintsUsed: num(totals.hintsUsed, 0),
      reveals: num(totals.reveals, 0),
      activeMinutes: num(totals.activeMinutes, 0),
    },
    audits: { passed: num(audits.passed, 0), failed: num(audits.failed, 0) },
    calibration: { sure: pair(cal.sure), guess: pair(cal.guess) },
    speedFactor: clamp(num(r.speedFactor, 1), lo, hi),
    cps: num(r.cps, 0) > 0 ? (r.cps as number) : PARAMS.latency.cps,
    keyUse,
    patternDeck: Array.isArray(r.patternDeck) ? (r.patternDeck.filter((p) => p && typeof p === 'object') as PatternCard[]) : [],
    gradedCount: num(r.gradedCount, 0),
    recentRatios: nums(r.recentRatios),
    logCheckpoint: num(r.logCheckpoint, 0),
    falseMastery,
    resetAt: optNum(r.resetAt),
  };
}

// ---------------------------------------------------------------- environment

export interface EvidenceEnv {
  /** Append-only log sink (the Store). Gets every recorded observation, format-only ones included. */
  log?: (ev: EvidenceRecord) => void;
  /** Window id written into each record (multi-window merge). */
  window?: string;
  /** Required misconception coverage per concept (taxonomy x verified bank). Default: none. */
  coverage?: CoverageFn;
  /** Belief text and prior for a misconception id. */
  taxonomy?: TaxonomyFn;
  clock?: () => number;
}

// Bound per learner object, so two Stores (two simulated windows) never share a sink.
const envs = new WeakMap<Learner, EvidenceEnv>();

/** Attach (merge) the log sink, window id and content lookups used by recordEvidence for this learner. */
export function bindEvidenceEnv(learner: Learner, env: EvidenceEnv): void {
  envs.set(learner, { ...envs.get(learner), ...env });
}

export function evidenceEnv(learner: Learner): EvidenceEnv {
  return envs.get(learner) ?? {};
}

function required(learner: Learner, c: ConceptState): string[] {
  return evidenceEnv(learner).coverage?.(c) ?? [];
}

// ---------------------------------------------------------------- concepts

export type ConceptInput = Pick<Concept, 'id' | 'name'> &
  Partial<Pick<Concept, 'description' | 'prerequisites'>> & { tag?: string; kind?: 'shape' | 'semantics'; aliases?: string[] };

function newConcept(id: string, c: ConceptInput, prerequisites: string[], tag: string | undefined, now: number): ConceptState {
  return {
    id,
    name: c.name || id,
    description: c.description ?? '',
    prerequisites,
    mastery: PRIOR, // unknown until placement or real work says otherwise
    attempts: 0,
    hintsUsed: 0,
    lessonsSeen: 0,
    lastPracticed: 0,
    nextReview: 0,
    intervalDays: 0,
    solveTimesMin: [],
    tag,
    kind: c.kind,
    aliases: (c.aliases ?? []).map(slug).filter((a) => a !== id),
    tested: false,
    inferred: false,
    supportFrom: [],
    groupsCorrect: [],
    production: false,
    coveredMisconceptions: [],
    fragile: false,
    probeable: true,
    misconceptions: {},
    fluency: [],
    lastAt: now,
    wrongGroups: [],
  };
}

/** Canonical tag of an input concept; 'other' and empty tags never merge. */
function tagOf(c: { tag?: string }): string | undefined {
  const t = c.tag ? slug(c.tag) : '';
  return t && t !== 'other' ? t : undefined;
}

/** The concept that owns a tag: the seed concept (keyed by the tag itself), else the first tagged one. */
function tagOwner(learner: Learner, tag: string): ConceptState | undefined {
  return learner.concepts[tag] ?? Object.values(learner.concepts).find((c) => c.tag === tag);
}

/**
 * Add concepts the learner has not seen yet; existing ones keep their state (and gain a
 * missing tag/kind). A plan concept with the same tag as an existing seed concept is merged
 * into it: the seed id stays canonical and the plan id becomes an alias. Several plan
 * concepts for one tag stay separate, each with the seed concept as a prerequisite.
 */
export function upsertConcepts(learner: Learner, concepts: ConceptInput[], now = Date.now()): void {
  const perTag = new Map<string, number>();
  for (const c of concepts) {
    const t = tagOf(c);
    if (t) perTag.set(t, (perTag.get(t) ?? 0) + 1);
  }
  for (const c of concepts) {
    const id = slug(c.id || c.name);
    const tag = tagOf(c);
    const prereqs = [...new Set((c.prerequisites ?? []).map(slug))].filter((p) => p !== id);
    const existing = concept(learner, id);
    if (existing) {
      const was = JSON.stringify(existing);
      existing.name ||= c.name;
      existing.description ||= c.description ?? '';
      existing.tag ??= tag;
      existing.kind ??= c.kind;
      for (const a of (c.aliases ?? []).map(slug)) if (a !== existing.id) addUnique(existing.aliases, a);
      if (JSON.stringify(existing) !== was) touch(existing, now);
      continue;
    }
    const owner = tag && id !== tag ? tagOwner(learner, tag) : undefined;
    if (owner && perTag.get(tag!) === 1) {
      addUnique(owner.aliases, id);
      for (const p of prereqs) if (p !== owner.id && !owner.aliases.includes(p)) addUnique(owner.prerequisites, p);
      if (!owner.kind && c.kind) owner.kind = c.kind;
      touch(owner, now);
      continue;
    }
    if (owner) prereqs.push(owner.id);
    learner.concepts[id] = newConcept(id, c, prereqs, tag, now);
    // A seed concept arriving after plan concepts with its tag: they build on it.
    if (tag && id === tag) {
      for (const other of Object.values(learner.concepts)) {
        if (other.id !== id && other.tag === tag && addUnique(other.prerequisites, id)) touch(other, now);
      }
    }
  }
}

/** Look a concept up by id, slug or alias. */
export function concept(learner: Learner, id: string): ConceptState | undefined {
  const key = resolveId(learner.concepts, slug(id));
  return key ? learner.concepts[key] : undefined;
}

function ensureConcept(learner: Learner, id: string, now: number): ConceptState | undefined {
  const c = concept(learner, id);
  if (c || slug(id) !== DECOMPOSITION) return c;
  upsertConcepts(learner, [{ id: DECOMPOSITION, name: 'Decomposition', description: 'Breaking a task into steps and patterns' }], now);
  return learner.concepts[DECOMPOSITION];
}

/** Placement prior from the 'tick what you have used' picker. Never overrides tested concepts. */
export function setPrior(learner: Learner, id: string, p: number, selfRating?: 'used' | 'not-used'): void {
  const c = concept(learner, id);
  if (!c || c.tested) return;
  c.mastery = clamp01(p);
  if (selfRating) c.selfRating = selfRating;
  touch(c, Date.now());
}

/** Typing calibration item (copy a short literal): sets characters per second for par. */
export function recordTypingCalibration(learner: Learner, chars: number, ms: number): number {
  if (chars > 0 && ms > 0) learner.cps = clamp(chars / (ms / 1000), 0.5, 15);
  return learner.cps;
}

// ---------------------------------------------------------------- the single writer

/** What callers pass: the four facts that matter, the rest defaulted. */
export type EvidenceInput = Pick<EvidenceRecord, 'conceptId' | 'kind' | 'correct' | 'source'> &
  Partial<Omit<EvidenceRecord, 'conceptId' | 'kind' | 'correct' | 'source'>>;

export interface Recorded {
  evidence: EvidenceRecord;
  result: ApplyResult;
  concept: ConceptState;
}

/**
 * The single writer of ConceptState.mastery (= P(known)). Applies one observation (capped
 * BKT update, misconceptions, latency, propagation, audit, scheduling, calibration), fills
 * weight/bits/window into the record and appends it to the bound log. Returns undefined for
 * an unknown concept ('decomposition' is created on demand).
 * Defaults: weight 1, learnT .05 (the item showed feedback), guessFlag false, latencyValid false.
 */
export function recordEvidence(learner: Learner, input: EvidenceInput, opts: EvidenceEnv = {}): Recorded | undefined {
  const env = { ...evidenceEnv(learner), ...opts };
  const now = env.clock?.() ?? Date.now();
  const c = ensureConcept(learner, input.conceptId, now);
  if (!c) return undefined;
  const ev: EvidenceRecord = {
    ...input,
    id: input.id ?? newId('ev'),
    at: input.at ?? now,
    conceptId: c.id,
    guessFlag: input.guessFlag ?? false,
    latencyValid: input.latencyValid ?? false,
    weight: input.weight ?? 1,
    learnT: input.learnT ?? PARAMS.learnT.feedback,
    bits: 0,
    window: input.window ?? env.window ?? 'local',
  };
  const result = applyEvidence(c, ev, { learner, coverage: env.coverage, taxonomy: env.taxonomy, now });
  ev.weight = result.weight;
  ev.bits = Math.round(result.bits * 1e4) / 1e4;
  ev.latencyValid = result.latencyValid;
  if (result.implicitGuess) ev.implicitGuess = true;
  try {
    env.log?.(ev);
  } catch (err) {
    console.error('Deliberate: evidence log failed', err);
  }
  return { evidence: ev, result, concept: c };
}

/** @deprecated Use recordEvidence. A signed delta becomes llm-grade evidence (weight .5). */
export function nudge(learner: Learner, ids: string[], delta: number): void {
  if (!delta || !Number.isFinite(delta)) return;
  for (const id of ids) {
    recordEvidence(learner, { conceptId: id, kind: 'llm-grade', source: 'llm', correct: delta > 0, weight: PARAMS.halfWeight });
  }
}

/** @deprecated Migration and legacy flows only: writes P directly, bypassing the evidence model. */
export function setMastery(learner: Learner, id: string, value: number): void {
  const c = concept(learner, id);
  if (!c) return;
  c.mastery = clamp01(value);
  touch(c, Date.now());
}

/**
 * Record a solved task as 'task' evidence: correct when no hint past rung 2, no reveal and
 * under 120 pasted + assisted characters (slip .2 after rung 1-2). Solo tasks also count on
 * 'decomposition'. Scheduling follows from the evidence.
 */
export function recordSolve(learner: Learner, task: Task, opts: { solo?: boolean } = {}): void {
  const minutes = task.activeMs / 60000;
  const maxRung = task.hints.reduce((m, h) => Math.max(m, h.rung), 0);
  const assisted = (task.pastedChars ?? 0) + (task.assistedChars ?? 0);
  const correct = maxRung <= 2 && !task.revealed && assisted < 120;
  const s = maxRung >= 1 && maxRung <= 2 ? 0.2 : undefined;
  const seen = new Set<string>();
  for (const id of task.conceptIds) {
    const c = concept(learner, id);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    recordEvidence(learner, { conceptId: c.id, kind: 'task', source: 'task', correct, s, taskId: task.id });
    c.attempts += 1;
    c.hintsUsed += task.hints.length;
    c.solveTimesMin.push(Math.round(minutes * 10) / 10);
    if (c.solveTimesMin.length > 20) c.solveTimesMin.shift();
  }
  const solo = opts.solo ?? (task as { fade?: string }).fade === 'solo';
  if (solo) recordEvidence(learner, { conceptId: DECOMPOSITION, kind: 'task', source: 'task', correct, s, taskId: task.id });
  learner.totals.tasksDone += 1;
  learner.totals.hintsUsed += task.hints.length;
  learner.totals.activeMinutes += Math.round(minutes);
  if (task.revealed) learner.totals.reveals += 1;
}

/**
 * gotIt() after a hint, by the rung that unblocked the learner: rung 1 wrong at .3, rung 2
 * wrong at .5 on the diagnosed concepts, rung 3 wrong at .5 on 'decomposition', rungs 4-5
 * both at .5, a reveal wrong at weight 1.
 */
export function recordHintEvidence(learner: Learner, taskId: string, rung: number | 'reveal', diagnosedConceptIds: string[]): void {
  const on = (ids: string[], weight: number) => {
    for (const id of ids) recordEvidence(learner, { conceptId: id, kind: 'task', source: 'hint', correct: false, weight, taskId });
  };
  if (rung === 'reveal') return on(diagnosedConceptIds, 1);
  if (rung <= 1) return on(diagnosedConceptIds, 0.3);
  if (rung === 2 || rung >= 4) on(diagnosedConceptIds, 0.5);
  if (rung >= 3) on([DECOMPOSITION], 0.5);
}

/** Scheduling by outcome (true = solid, false = fail, as before). recordEvidence already does this. */
export function schedule(c: ConceptState, outcome: boolean | Outcome, now = Date.now()): void {
  scheduleOutcome(c, typeof outcome === 'boolean' ? (outcome ? 'solid' : 'fail') : outcome, now);
  touch(c, now);
}

export function dueForReview(learner: Learner, limit = 3, now = Date.now()): ConceptState[] {
  return Object.values(learner.concepts)
    .filter((c) => c.nextReview > 0 && c.nextReview <= now)
    .sort((a, b) => a.nextReview - b.nextReview)
    .slice(0, limit);
}

/**
 * How long the learner may struggle before the coach steps in.
 * Weak concepts get help sooner (struggle without the concept is wasted time);
 * strong concepts get more rope (productive struggle builds speed); Fluent ones the most (1.5x).
 */
export function stuckThreshold(learner: Learner, task: Task, baseMinutes: number): number {
  const ms = task.conceptIds.map((id) => {
    const c = concept(learner, id);
    return !c ? PRIOR : conceptChip(learner, c) === 'Fluent' ? 1 : c.mastery;
  });
  const avg = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : PRIOR;
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

/** isMastered for a concept of this learner, with the bound coverage requirement. */
export function conceptMastered(learner: Learner, c: ConceptState): boolean {
  return isMastered(c, required(learner, c));
}

/** State chip for a concept of this learner, with the bound coverage requirement. */
export function conceptChip(learner: Learner, c: ConceptState): ConceptChip {
  return chip(c, required(learner, c));
}

export function allMastered(learner: Learner, ids: string[]): boolean {
  return ids.every((id) => {
    const c = concept(learner, id);
    return !!c && conceptMastered(learner, c);
  });
}

/**
 * Journal a mistake. Entries are keyed by the stable misconception id when one is given,
 * otherwise by slug(pattern), so repeats merge and count up.
 */
export function recordMistake(
  learner: Learner,
  m: { pattern: string; detail: string; conceptIds: string[]; taskId: string; misconceptionId?: string },
): Mistake {
  const key = slug(m.pattern);
  const now = Date.now();
  const conceptIds = m.conceptIds.map((id) => concept(learner, id)?.id ?? slug(id));
  const existing = learner.mistakes.find((x) =>
    m.misconceptionId ? x.misconceptionId === m.misconceptionId : slug(x.pattern) === key,
  );
  if (existing) {
    existing.count += 1;
    existing.at = now;
    existing.detail = m.detail;
    existing.taskId = m.taskId;
    for (const id of conceptIds) addUnique(existing.conceptIds, id);
    return existing;
  }
  const mistake: Mistake = {
    id: m.misconceptionId ?? `${key}-${now.toString(36)}`,
    at: now,
    count: 1,
    pattern: m.pattern,
    detail: m.detail,
    taskId: m.taskId,
    conceptIds,
  };
  if (m.misconceptionId) mistake.misconceptionId = m.misconceptionId;
  learner.mistakes.push(mistake);
  if (learner.mistakes.length > 200) learner.mistakes.shift();
  return mistake;
}

const STATUS_WORDS: Record<string, string> = { active: 'active', suppressed: 'recently corrected', candidate: 'candidate' };

/**
 * One prompt line per concept, e.g.
 * '- list-slicing (List slicing): P 0.62 [Learning, tested, 1 group]; misconception slice-end-inclusive p .71 active: thinks the slice end is included'
 */
export function conceptLine(c: ConceptState, requiredIds: string[] = []): string {
  const flags: string[] = [chip(c, requiredIds), c.tested ? 'tested' : c.inferred ? 'inferred' : 'untested'];
  if (c.tested && c.inferred) flags.push('inferred');
  const n = c.groupsCorrect.length;
  flags.push(`${n} group${n === 1 ? '' : 's'}`);
  let line = `- ${c.id} (${c.name}): P ${c.mastery.toFixed(2)} [${flags.join(', ')}]`;
  const shown = Object.entries(c.misconceptions)
    .filter(([, m]) => m.status === 'active' || m.status === 'suppressed' || (m.status === 'candidate' && m.p >= PARAMS.misconception.blockP))
    .sort(([, a], [, b]) => Number(b.status === 'active') - Number(a.status === 'active') || b.p - a.p);
  for (const [id, m] of shown) {
    line += `; misconception ${id} p ${m.p.toFixed(2).replace(/^0(?=\.)/, '')} ${STATUS_WORDS[m.status]}${m.belief ? `: ${m.belief}` : ''}`;
  }
  return line;
}

/** Compact learner summary for prompts: only concepts relevant to the current context. */
export function snapshot(learner: Learner, ids?: string[]): string {
  const list = ids
    ? [...new Set(ids.map((id) => concept(learner, id)).filter((c): c is ConceptState => !!c))]
    : Object.values(learner.concepts);
  const wanted = new Set(list.map((c) => c.id));
  const lines = list.map((c) => conceptLine(c, required(learner, c)));
  const mistakes = learner.mistakes
    .filter((m) => !ids || m.conceptIds.some((id) => wanted.has(concept(learner, id)?.id ?? id)))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map((m) => `- "${m.pattern}" x${m.count}: ${m.detail}`);
  return [
    'Concept mastery (P(known) [state, tested or inferred, sibling groups answered right]):',
    lines.join('\n') || '- (none tracked yet)',
    'Recurring mistakes:',
    mistakes.join('\n') || '- (none yet)',
  ].join('\n');
}
