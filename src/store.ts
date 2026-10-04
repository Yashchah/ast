import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyEvidence, EvidenceRecord, propagate, resolveId } from './evidence';
import { bindEvidenceEnv, emptyLearner, EvidenceEnv, migrateLearner, slug } from './learner';
import { ConceptState, Learner, Mistake, Project } from './types';

const LEARNER_KEY = 'deliberate.learner.v1';
const PROJECT_KEY = 'deliberate.project.v1';
const LOG_FILE = /^evidence-\d{4}-\d{2}\.jsonl$/;

/** The part of vscode.Memento the store uses. */
export interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** File access for the evidence log in global storage; injected in tests. */
export interface EvidenceFs {
  /** Append text to a file, creating it (and its folder) if needed. */
  append(name: string, text: string): Promise<void>;
  /** The whole file, or undefined when it does not exist. */
  read(name: string): Promise<string | undefined>;
  /** Delete every evidence log file (Erase Learner Profile). */
  clear(): Promise<void>;
}

export interface StoreContext {
  globalState: Memento;
  workspaceState: Memento;
  globalStorageUri?: vscode.Uri;
}

export interface StoreDeps {
  fs?: EvidenceFs;
  windowId?: string;
  clock?: () => number;
}

/** Log file for an evidence time: evidence-YYYY-MM.jsonl (UTC month). */
export function evidenceFile(at: number): string {
  return `evidence-${new Date(Number.isFinite(at) ? at : Date.now()).toISOString().slice(0, 7)}.jsonl`;
}

/**
 * Learner profile lives in globalState so knowledge carries across projects; the project
 * (goal, roadmap, task feed) lives in workspaceState.
 * The evidence log (globalStorageUri/evidence-YYYY-MM.jsonl, append-only) is the source of
 * truth; globalState keeps compact ConceptState summaries. Before each write the store merges
 * what other windows wrote since its last sync, per concept by lastAt, so two windows never
 * erase each other's progress.
 */
export class Store {
  learner: Learner;
  project: Project | undefined;
  readonly windowId: string;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly fs: EvidenceFs | undefined;
  private readonly clock: () => number;
  /** The learner as last synced with globalState. */
  private base: Learner;
  /** Evidence recorded in this window since the last sync, replayed on concepts both windows changed. */
  private pending: EvidenceRecord[] = [];
  private queue: { file: string; line: string }[] = [];
  private draining: Promise<void> | undefined;
  private env: EvidenceEnv = {};

  constructor(private readonly ctx: StoreContext, deps: StoreDeps = {}) {
    this.clock = deps.clock ?? Date.now;
    this.windowId = deps.windowId ?? `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.fs = deps.fs ?? (ctx.globalStorageUri ? storageFs(ctx.globalStorageUri) : undefined);
    this.learner = migrateLearner(ctx.globalState.get<unknown>(LEARNER_KEY));
    this.base = clone(this.learner);
    this.project = ctx.workspaceState.get<Project>(PROJECT_KEY);
    this.bind();
  }

  /** Coverage and taxonomy lookups for recordEvidence (kept across a profile reset). */
  setEvidenceEnv(env: Pick<EvidenceEnv, 'coverage' | 'taxonomy'>): void {
    this.env = { ...this.env, ...env };
    this.bind();
  }

  private bind(): void {
    bindEvidenceEnv(this.learner, { ...this.env, log: (ev) => this.logEvidence(ev), window: this.windowId, clock: this.clock });
  }

  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 300);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.flushLog(); // the log first: it is the source of truth
    this.syncLearner();
    await this.ctx.globalState.update(LEARNER_KEY, clone(this.learner));
    await this.ctx.workspaceState.update(PROJECT_KEY, this.project);
  }

  async resetProject(): Promise<void> {
    this.project = undefined;
    await this.flush();
  }

  /** Erase the profile and its evidence log. Other windows adopt the reset on their next flush. */
  async resetLearner(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.queue = [];
    while (this.draining) await this.draining;
    const fresh = emptyLearner();
    fresh.resetAt = this.clock();
    replaceInPlace(this.learner, fresh);
    this.pending = [];
    this.base = clone(this.learner);
    try {
      await this.fs?.clear();
    } catch (err) {
      console.error('Deliberate: could not delete the evidence log', err);
    }
    await this.ctx.globalState.update(LEARNER_KEY, clone(this.learner));
    await this.ctx.workspaceState.update(PROJECT_KEY, this.project);
  }

  /** Every logged observation with at in [since, until], oldest file first. Malformed lines are skipped. */
  async readEvidence(since: number, until = this.clock()): Promise<EvidenceRecord[]> {
    if (!this.fs) return [];
    await this.flushLog();
    const out: EvidenceRecord[] = [];
    for (const file of monthFiles(since, until)) {
      const text = await this.fs.read(file);
      for (const line of text?.split('\n') ?? []) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as EvidenceRecord;
          if (typeof ev.at === 'number' && ev.at >= since && ev.at <= until) out.push(ev);
        } catch {
          // A torn line from a crash mid-append: skip it.
        }
      }
    }
    return out;
  }

  /** Wait until every queued evidence line is on disk. */
  async flushLog(): Promise<void> {
    while (this.queue.length || this.draining) await (this.draining ?? this.drain());
  }

  private logEvidence(ev: EvidenceRecord): void {
    this.pending.push(ev);
    this.queue.push({ file: evidenceFile(ev.at), line: JSON.stringify(ev) + '\n' });
    void this.drain();
    this.save();
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0);
        if (!this.fs) continue;
        const byFile = new Map<string, string>();
        for (const { file, line } of batch) byFile.set(file, (byFile.get(file) ?? '') + line);
        for (const [file, text] of byFile) {
          try {
            await this.fs.append(file, text);
          } catch (err) {
            // Best effort: the summary in globalState still carries the update.
            console.error('Deliberate: could not append to the evidence log', err);
          }
        }
      }
    })().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  /** Merge what other windows wrote since our last sync, then make the result the new base. */
  private syncLearner(): void {
    const stored = this.ctx.globalState.get<unknown>(LEARNER_KEY);
    if (stored) {
      const merged = mergeLearner(this.base, this.learner, migrateLearner(stored), this.pending, this.env);
      adopt(this.learner, merged);
    }
    this.pending = [];
    this.learner.logCheckpoint = this.clock();
    this.base = clone(this.learner);
  }
}

// ---------------------------------------------------------------- merge

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Replace an object's contents but keep its identity (the coach and the evidence binding hold it). */
function replaceInPlace<T extends object>(target: T, src: T): void {
  const t = target as Record<string, unknown>;
  for (const k of Object.keys(t)) if (!(k in src)) delete t[k];
  Object.assign(t, src);
}

/** Keyed records updated in place, so references held across an await stay live. */
function adoptRecord<T extends object>(target: Record<string, T>, src: Record<string, T>, each?: (t: T, s: T) => void): void {
  for (const id of Object.keys(target)) if (!(id in src)) delete target[id];
  for (const [id, v] of Object.entries(src)) {
    if (target[id]) (each ?? replaceInPlace)(target[id], v);
    else target[id] = v;
  }
}

/** Take the merged learner while keeping the identity of the learner, its concepts and their misconceptions. */
function adopt(target: Learner, src: Learner): void {
  const concepts = target.concepts;
  adoptRecord(concepts, src.concepts, (t, s) => {
    const misconceptions = t.misconceptions;
    adoptRecord(misconceptions, s.misconceptions);
    replaceInPlace(t, { ...s, misconceptions });
  });
  replaceInPlace(target, { ...src, concepts });
}

/** Counters: their value plus what this window added since the base. */
const add = (theirs = 0, mine = 0, base = 0): number => theirs + (mine - base);

/** Keyed lists: entries this window changed since the base win; everything else follows theirs. */
function mergeBy<T>(base: T[], mine: T[], theirs: T[], key: (x: T) => string): T[] {
  const b = new Map(base.map((x) => [key(x), x]));
  const out = new Map(theirs.map((x) => [key(x), clone(x)]));
  for (const m of mine) {
    const k = key(m);
    if (!b.has(k) || !same(b.get(k), m)) out.set(k, clone(m));
  }
  return [...out.values()];
}

function mistakeKey(m: Mistake): string {
  return m.misconceptionId ?? slug(m.pattern);
}

function mergeMistakes(base: Mistake[], mine: Mistake[], theirs: Mistake[]): Mistake[] {
  const b = new Map(base.map((x) => [mistakeKey(x), x]));
  const out = new Map(theirs.map((x) => [mistakeKey(x), clone(x)]));
  for (const m of mine) {
    const k = mistakeKey(m);
    const old = b.get(k);
    if (old && same(old, m)) continue;
    const t = out.get(k);
    if (!t) {
      out.set(k, clone(m));
      continue;
    }
    const merged = clone(m.at >= t.at ? m : t);
    merged.count = add(t.count, m.count, old?.count ?? 0);
    merged.conceptIds = [...new Set([...t.conceptIds, ...m.conceptIds])];
    out.set(k, merged);
  }
  return [...out.values()].sort((x, y) => x.at - y.at).slice(-200);
}

/** Keep descriptive fields this window added to a concept that both windows changed. */
function mergeConceptFields(t: ConceptState, m: ConceptState): void {
  t.name ||= m.name;
  t.description ||= m.description;
  t.tag ??= m.tag;
  t.kind ??= m.kind;
  t.aliases = [...new Set([...t.aliases, ...m.aliases])];
  t.prerequisites = [...new Set([...t.prerequisites, ...m.prerequisites])];
}

/**
 * Three-way merge of the learner: base (last sync), mine (this window), theirs (globalState now).
 * Per concept, by lastAt: a concept only one side changed takes that side; a concept both
 * changed takes theirs and replays this window's unsynced evidence on it. Propagation from
 * every replayed record is re-run too (it is max/min/set-add, so re-running is safe).
 * Counters add this window's increments to theirs.
 */
export function mergeLearner(
  base: Learner,
  mine: Learner,
  theirs: Learner,
  pending: EvidenceRecord[],
  env: Pick<EvidenceEnv, 'coverage' | 'taxonomy'> = {},
): Learner {
  // Another window erased the profile after our last sync: the erase wins.
  if ((theirs.resetAt ?? 0) > (base.resetAt ?? 0)) return clone(theirs);

  const out = clone(theirs);
  const conflicted = new Set<string>();
  for (const [id, m] of Object.entries(mine.concepts)) {
    const b = base.concepts[id];
    const t = theirs.concepts[id];
    const baseAt = b ? b.lastAt : -Infinity;
    const theirsChanged = !!t && t.lastAt > baseAt;
    if (!theirsChanged) out.concepts[id] = clone(m);
    else if (m.lastAt > baseAt) {
      conflicted.add(id);
      mergeConceptFields(out.concepts[id], m);
    }
  }

  for (const ev of pending) {
    const id = resolveId(out.concepts, ev.conceptId);
    if (!id) continue;
    const c = out.concepts[id];
    if (conflicted.has(id)) {
      applyEvidence(c, ev, { learner: out, stats: false, coverage: env.coverage, taxonomy: env.taxonomy });
    } else {
      const committed = ev.verdict !== 'format-only' && ev.verdict !== 'dont-know' && !ev.guessFlag && !ev.implicitGuess;
      const up = committed && ev.correct === true && ev.weight > 0;
      const down = committed && ev.correct === false && ev.weight >= 1;
      if (up || down) propagate(out, c, { up, down }, ev.at, ev.at, env.coverage);
    }
  }

  out.totals = {
    tasksDone: add(theirs.totals.tasksDone, mine.totals.tasksDone, base.totals.tasksDone),
    hintsUsed: add(theirs.totals.hintsUsed, mine.totals.hintsUsed, base.totals.hintsUsed),
    reveals: add(theirs.totals.reveals, mine.totals.reveals, base.totals.reveals),
    activeMinutes: add(theirs.totals.activeMinutes, mine.totals.activeMinutes, base.totals.activeMinutes),
  };
  out.audits = {
    passed: add(theirs.audits.passed, mine.audits.passed, base.audits.passed),
    failed: add(theirs.audits.failed, mine.audits.failed, base.audits.failed),
  };
  const pairAdd = (k: 'sure' | 'guess'): [number, number] => [
    add(theirs.calibration[k][0], mine.calibration[k][0], base.calibration[k][0]),
    add(theirs.calibration[k][1], mine.calibration[k][1], base.calibration[k][1]),
  ];
  out.calibration = { sure: pairAdd('sure'), guess: pairAdd('guess') };
  out.gradedCount = add(theirs.gradedCount, mine.gradedCount, base.gradedCount);
  out.keyUse = {};
  for (const k of new Set([...Object.keys(theirs.keyUse), ...Object.keys(mine.keyUse)])) {
    out.keyUse[k] = add(theirs.keyUse[k], mine.keyUse[k], base.keyUse[k]);
  }
  // Latest-writer fields: ours when this window changed them.
  if (!same(mine.cps, base.cps)) out.cps = mine.cps;
  if (!same(mine.recentRatios, base.recentRatios) || !same(mine.speedFactor, base.speedFactor)) {
    out.recentRatios = [...mine.recentRatios];
    out.speedFactor = mine.speedFactor;
  }
  out.patternDeck = mergeBy(base.patternDeck, mine.patternDeck, theirs.patternDeck, (p) => p.conceptId);
  out.mistakes = mergeMistakes(base.mistakes, mine.mistakes, theirs.mistakes);
  out.falseMastery = mergeBy(base.falseMastery, mine.falseMastery, theirs.falseMastery, (f) => `${f.conceptId}@${f.at}`)
    .sort((x, y) => x.at - y.at)
    .slice(-50);
  out.logCheckpoint = Math.max(theirs.logCheckpoint, mine.logCheckpoint);
  return out;
}

// ---------------------------------------------------------------- files

/** Log files covering [since, until], by UTC month. */
function monthFiles(since: number, until: number): string[] {
  const files: string[] = [];
  const d = new Date(Math.max(0, since));
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const end = new Date(Math.max(since, until));
  while (y < end.getUTCFullYear() || (y === end.getUTCFullYear() && m <= end.getUTCMonth())) {
    files.push(evidenceFile(Date.UTC(y, m, 1)));
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return files;
}

/** The real log in globalStorageUri. Local storage appends; remote/virtual storage reads and rewrites. */
function storageFs(dir: vscode.Uri): EvidenceFs {
  const uri = (name: string) => vscode.Uri.joinPath(dir, name);
  const read = async (name: string): Promise<string | undefined> => {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri(name)));
    } catch {
      return undefined;
    }
  };
  return {
    read,
    async append(name, text) {
      if (dir.scheme === 'file') {
        await mkdir(dir.fsPath, { recursive: true });
        await appendFile(path.join(dir.fsPath, name), text, 'utf8');
        return;
      }
      const prev = (await read(name)) ?? '';
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(uri(name), new TextEncoder().encode(prev + text));
    },
    async clear() {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(dir);
      } catch {
        return;
      }
      for (const [name] of entries) {
        if (!LOG_FILE.test(name)) continue;
        try {
          await vscode.workspace.fs.delete(uri(name));
        } catch {
          // Already gone (another window erased it).
        }
      }
    },
  };
}
