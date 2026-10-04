// Atom cache (spec V1-5 CACHE): one StoredAtom per key (canonical tag, sub-tag, or the concept id
// for 'other'), per language, shared by seeds and model packs, so a concept learned in one project
// costs nothing in the next. Per item: seenAt, n, nCorrect, medianMs. Per mutant: matches,
// confirmations, rejections; a mutant whose precision is below .3 after 5 asks is retired. No
// exact item is offered again within 7 days, and each key keeps at most 60 items (LRU).
// Pure module: persistence (globalStorageUri/atoms/<lang>.json) is injected as load/save.

import type {
  ItemStats, Lang, StoredAtom, StoredCompletion, StoredContrast, StoredExample, StoredMutant, StoredProbe, TracebackItem,
} from '../contracts';
import { median } from '../evidence';
import { seenWithin7Days } from './seeds';

/** Items kept per key (all kinds together). */
export const ITEM_CAP = 60;
/** Fewer unseen probes than this is low stock (refill locally for seeded tags, else a priority-3 job). */
export const LOW_STOCK = 3;
export const RETIRE_ASKS = 5;
export const RETIRE_PRECISION = 0.3;
/** Show times kept per item (the 7-day rule only needs the recent ones). */
const SEEN_KEEP = 20;
/** Latencies kept per item for medianMs. */
const MS_KEEP = 15;
/** Never evicted below these counts by the LRU cap, so an atom stays runnable. */
const MIN_KEEP: Record<ItemKind, number> = { probes: 4, examples: 1, completions: 1, contrasts: 1, tracebacks: 1 };
const DEFAULT_DEBOUNCE_MS = 2000;

export type ItemKind = 'probes' | 'examples' | 'completions' | 'contrasts' | 'tracebacks';
const KINDS: readonly ItemKind[] = ['probes', 'examples', 'completions', 'contrasts', 'tracebacks'];
type AnyItem = StoredProbe | StoredExample | StoredCompletion | StoredContrast | TracebackItem;

/** Per-item bookkeeping beyond the contract types. Survives eviction for 7 days (no-repeat rule). */
export interface ItemMeta {
  /** Last put or show: the LRU clock. */
  usedAt: number;
  /** Show times of items without ItemStats (examples, contrasts, tracebacks) and of evicted items. */
  seenAt?: number[];
  /** Recent latencies, the medianMs source. */
  ms?: number[];
}

/** The file format of globalStorageUri/atoms/<lang>.json. */
export interface AtomCacheData {
  version: 1;
  lang: Lang;
  atoms: Record<string, StoredAtom>;
  /** key -> item id -> meta. */
  meta: Record<string, Record<string, ItemMeta>>;
}

export interface AtomCachePersistence {
  /** The file's current content (undefined when there is none). Called before every write. */
  load: () => Promise<AtomCacheData | undefined>;
  save: (data: AtomCacheData) => Promise<void>;
}

export interface AtomCacheOptions {
  now?: () => number;
  /** Write debounce (default 2000 ms). Negative: never write on its own; call flush(). */
  debounceMs?: number;
  /** Debounced write failures (the caller logs them to 'Deliberate: content'). */
  onError?: (e: unknown) => void;
}

export interface StockInfo {
  /** Unseen (not shown in the last 7 days) items by kind. */
  probes: number;
  /** Distinct sibling groups among the unseen probes. */
  groups: number;
  examples: number;
  completions: number;
  contrasts: number;
  tracebacks: number;
  /** Gradable unseen items: probes + completions + tracebacks. */
  items: number;
}

/** A belief check outcome: the wrong answer matched the mutant, then the learner said y or n. */
export type MutantResponse = 'match' | 'yes' | 'no';

// ---------------------------------------------------------------- pure helpers

export function precision(m: Pick<StoredMutant, 'confirmations' | 'rejections'>): number | undefined {
  const asks = m.confirmations + m.rejections;
  return asks ? m.confirmations / asks : undefined;
}

/** Precision below .3 after 5 or more asks: the belief label is wrong for this output. */
export function isRetired(m: Pick<StoredMutant, 'confirmations' | 'rejections'>): boolean {
  const asks = m.confirmations + m.rejections;
  return asks >= RETIRE_ASKS && m.confirmations / asks < RETIRE_PRECISION;
}

const groupOf = (it: AnyItem): string => ('group' in it ? it.group : 'siblingGroup' in it ? it.siblingGroup : '');
const statsOf = (it: AnyItem): ItemStats | undefined => ('stats' in it ? it.stats : undefined);
const recent = (seenAt: readonly number[] | undefined, now: number) => !!seenAt && seenWithin7Days({ seenAt }, now);

function unionTimes(a: readonly number[] | undefined, b: readonly number[] | undefined, keep = SEEN_KEEP): number[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])].filter((t) => Number.isFinite(t)).sort((x, y) => x - y).slice(-keep);
}

/**
 * Two windows' stats for one item. Counters take the max (a concurrent increment can be lost, but
 * nothing is ever double counted); show times are unioned.
 */
function mergeStats(a: ItemStats, b: ItemStats): ItemStats {
  const n = Math.max(a.n, b.n);
  const out: ItemStats = { seenAt: unionTimes(a.seenAt, b.seenAt), n, nCorrect: Math.min(n, Math.max(a.nCorrect, b.nCorrect)) };
  const med = a.n >= b.n ? a.medianMs ?? b.medianMs : b.medianMs ?? a.medianMs;
  if (med !== undefined) out.medianMs = med;
  return out;
}

function mergeMutants(a: StoredMutant[], b: StoredMutant[]): StoredMutant[] {
  const byId = new Map(a.map((m) => [m.id, m]));
  const out = a.slice();
  for (const m of b) {
    const old = byId.get(m.id);
    if (!old) {
      out.push(m);
      continue;
    }
    out[out.indexOf(old)] = {
      ...m,
      ambiguous: old.ambiguous || m.ambiguous,
      matches: Math.max(old.matches, m.matches),
      confirmations: Math.max(old.confirmations, m.confirmations),
      rejections: Math.max(old.rejections, m.rejections),
    };
  }
  return out;
}

/** Union by item id; for an id on both sides the incoming copy wins, with stats and mutant counters merged. */
function mergeItems<T extends AnyItem>(a: T[], b: T[]): T[] {
  const index = new Map(a.map((it, i) => [it.id, i]));
  const out = a.slice();
  for (const it of b) {
    const i = index.get(it.id);
    if (i === undefined) {
      index.set(it.id, out.length);
      out.push(it);
      continue;
    }
    const old = out[i];
    const merged = { ...it } as T;
    const sa = statsOf(old);
    const sb = statsOf(it);
    if (sa && sb) (merged as { stats: ItemStats }).stats = mergeStats(sa, sb);
    if ('mutants' in old && 'mutants' in merged) (merged as StoredProbe).mutants = mergeMutants(old.mutants, (merged as StoredProbe).mutants);
    out[i] = merged;
  }
  return out;
}

/** Merge two versions of one key's atom. A verified atom replaces an unverified one. */
export function mergeAtoms(base: StoredAtom, incoming: StoredAtom): StoredAtom {
  if (base.verified !== incoming.verified) return base.verified ? base : incoming;
  const newer = incoming.createdAt >= base.createdAt ? incoming : base;
  const older = newer === incoming ? base : incoming;
  const useCases = [...new Set([...newer.pattern.useCases, ...older.pattern.useCases])];
  return {
    ...newer,
    pattern: { ...newer.pattern, useCases },
    probes: mergeItems(base.probes, incoming.probes),
    examples: mergeItems(base.examples, incoming.examples),
    completions: mergeItems(base.completions, incoming.completions),
    contrasts: mergeItems(base.contrasts, incoming.contrasts),
    tracebacks: mergeItems(base.tracebacks, incoming.tracebacks),
  };
}

function mergeMeta(a: ItemMeta | undefined, b: ItemMeta): ItemMeta {
  if (!a) return { ...b };
  const out: ItemMeta = { usedAt: Math.max(a.usedAt, b.usedAt) };
  const seenAt = unionTimes(a.seenAt, b.seenAt);
  if (seenAt.length) out.seenAt = seenAt;
  const ms = (b.ms?.length ?? 0) > (a.ms?.length ?? 0) ? b.ms : a.ms;
  if (ms?.length) out.ms = ms.slice(-MS_KEEP);
  return out;
}

const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
const fixStats = (s: ItemStats | undefined): ItemStats => ({
  seenAt: arr<number>(s?.seenAt).filter((t) => Number.isFinite(t)),
  n: Number(s?.n) || 0,
  nCorrect: Number(s?.nCorrect) || 0,
  ...(typeof s?.medianMs === 'number' ? { medianMs: s.medianMs } : {}),
});

/** Make loaded JSON safe to use (missing arrays, stats, counters); drops what cannot be repaired. */
function normalizeAtom(raw: StoredAtom, key: string, lang: Lang): StoredAtom | undefined {
  if (!raw || typeof raw !== 'object' || raw.lang !== lang || !raw.pattern) return undefined;
  return {
    ...raw,
    key,
    pattern: { ...raw.pattern, useCases: arr<string>(raw.pattern.useCases) },
    probes: arr<StoredProbe>(raw.probes).filter((p) => p?.id).map((p) => ({
      ...p,
      constructs: arr<string>(p.constructs),
      stats: fixStats(p.stats),
      mutants: arr<StoredMutant>(p.mutants).filter((m) => m?.id).map((m) => ({
        ...m, matches: Number(m.matches) || 0, confirmations: Number(m.confirmations) || 0, rejections: Number(m.rejections) || 0,
      })),
    })),
    examples: arr<StoredExample>(raw.examples).filter((x) => x?.id),
    completions: arr<StoredCompletion>(raw.completions).filter((c) => c?.id).map((c) => ({ ...c, stats: fixStats(c.stats) })),
    contrasts: arr<StoredContrast>(raw.contrasts).filter((c) => c?.id),
    tracebacks: arr<TracebackItem>(raw.tracebacks).filter((t) => t?.id),
  };
}

// ---------------------------------------------------------------- AtomCache

export class AtomCache {
  private atoms: Record<string, StoredAtom> = {};
  private meta: Record<string, Record<string, ItemMeta>> = {};
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly onError?: (e: unknown) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly lang: Lang,
    private readonly io?: AtomCachePersistence,
    opts: AtomCacheOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onError = opts.onError;
  }

  /** Read the file (at activation). Merges, so nothing put before loading is lost. */
  async load(): Promise<void> {
    const disk = await this.io?.load();
    if (disk) this.mergeData(disk);
  }

  keys(): string[] {
    return Object.keys(this.atoms);
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.atoms, key);
  }

  /** A copy of the key's atom with retired mutants left out (discriminating recomputed). */
  get(key: string): StoredAtom | undefined {
    const a = this.has(key) ? this.atoms[key] : undefined;
    return a ? viewAtom(a) : undefined;
  }

  /** Add an atom (seed instances or a verified pack): merged into the key's atom by item id. */
  put(atom: StoredAtom): void {
    if (atom.lang !== this.lang) throw new Error(`AtomCache(${this.lang}).put: atom ${atom.key} is ${atom.lang}`);
    const key = atom.key;
    const copy = structuredClone(atom);
    this.atoms[key] = this.has(key) ? mergeAtoms(this.atoms[key], copy) : copy;
    const now = this.now();
    const m = (this.meta[key] ??= {});
    for (const it of allItems(copy)) m[it.id] = { ...m[it.id], usedAt: now };
    this.cap(key);
    this.touch();
  }

  /**
   * Up to n probes not shown in the last 7 days and not in excludeGroups, at most one per sibling
   * group first. Order: probes carrying an unambiguous mutant of preferMisconception, then fewest
   * constructs outside allowedConstructs (the caller records a probe with any at weight .5), then
   * discriminating ones, then the least shown. Retired mutants are left out.
   */
  unseenProbes(
    key: string,
    n: number,
    excludeGroups: readonly string[] = [],
    preferMisconception?: string,
    allowedConstructs?: readonly string[],
  ): StoredProbe[] {
    const atom = this.get(key);
    if (!atom || n <= 0) return [];
    const now = this.now();
    const allowed = allowedConstructs ? new Set(allowedConstructs) : undefined;
    const excluded = new Set(excludeGroups);
    const cands = atom.probes
      .map((p, i) => ({
        p, i,
        carries: !!preferMisconception && p.mutants.some((m) => m.misconceptionId === preferMisconception && !m.ambiguous),
        unknown: allowed ? p.constructs.filter((c) => !allowed.has(c)).length : 0,
        last: Math.max(0, ...p.stats.seenAt),
      }))
      .filter(({ p }) => !excluded.has(p.group) && !this.seenRecently(key, p, now));
    cands.sort((a, b) =>
      Number(b.carries) - Number(a.carries) || a.unknown - b.unknown || Number(b.p.discriminating) - Number(a.p.discriminating)
      || a.p.stats.n - b.p.stats.n || a.last - b.last || a.i - b.i);
    return spreadGroups(cands.map((c) => c.p), n, (p) => p.group);
  }

  /** Up to n unseen items of another kind (completions for audits, tracebacks, examples, contrasts). */
  unseen<K extends ItemKind>(key: string, kind: K, n = Infinity, excludeGroups: readonly string[] = []): StoredAtom[K] {
    const atom = this.get(key);
    if (!atom) return [] as unknown as StoredAtom[K];
    const now = this.now();
    const excluded = new Set(excludeGroups);
    const items = (atom[kind] as AnyItem[])
      .map((it, i) => ({ it, i, n: statsOf(it)?.n ?? 0 }))
      .filter(({ it }) => !excluded.has(groupOf(it)) && !this.seenRecently(key, it, now))
      .sort((a, b) => a.n - b.n || a.i - b.i)
      .map(({ it }) => it);
    return spreadGroups(items, n, groupOf) as StoredAtom[K];
  }

  /** Ids shown in the last 7 days, evicted ones included (the Instantiator's exclude list). */
  seenIds(key: string): string[] {
    const now = this.now();
    const ids = new Set<string>();
    const atom = this.atoms[key];
    if (atom) for (const it of allItems(atom)) if (recent(statsOf(it)?.seenAt, now)) ids.add(it.id);
    for (const [id, m] of Object.entries(this.meta[key] ?? {})) if (recent(m.seenAt, now)) ids.add(id);
    return [...ids];
  }

  /** The item was shown now (or at `at`). Returns false for an unknown item. */
  markSeen(key: string, itemId: string, at = this.now()): boolean {
    const it = this.find(key, itemId);
    if (!it) return false;
    const m = (this.meta[key] ??= {});
    const stats = statsOf(it);
    if (stats) stats.seenAt = unionTimes(stats.seenAt, [at]);
    else m[itemId] = { ...m[itemId], seenAt: unionTimes(m[itemId]?.seenAt, [at]) } as ItemMeta;
    m[itemId] = { ...m[itemId], usedAt: Math.max(m[itemId]?.usedAt ?? 0, at) };
    this.touch();
    return true;
  }

  /** A graded answer on the item: n, nCorrect and medianMs. Does not mark it seen (markSeen does). */
  recordItemStat(key: string, itemId: string, correct: boolean, ms?: number): boolean {
    const it = this.find(key, itemId);
    if (!it) return false;
    const stats = statsOf(it);
    const m = (this.meta[key] ??= {});
    m[itemId] = { ...m[itemId], usedAt: Math.max(m[itemId]?.usedAt ?? 0, this.now()) };
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) m[itemId].ms = [...(m[itemId].ms ?? []), ms].slice(-MS_KEEP);
    if (stats) {
      stats.n++;
      if (correct) stats.nCorrect++;
      const med = median(m[itemId].ms ?? []);
      if (!Number.isNaN(med)) stats.medianMs = med;
    }
    this.touch();
    return true;
  }

  /**
   * Count a belief-check outcome on a mutant: 'match' (a wrong answer equalled its output), then
   * 'yes' (confirmation) or 'no' (rejection). Returns whether the mutant is now retired, or
   * undefined for an unknown mutant.
   */
  recordMutantResponse(key: string, mutantId: string, response: MutantResponse): { retired: boolean; precision?: number } | undefined {
    const atom = this.atoms[key];
    const m = atom?.probes.flatMap((p) => p.mutants).find((x) => x.id === mutantId);
    if (!m) return undefined;
    if (response === 'match') m.matches++;
    else if (response === 'yes') m.confirmations++;
    else m.rejections++;
    this.touch();
    return { retired: isRetired(m), precision: precision(m) };
  }

  /** Unseen items for the low-stock rule and sprint planning. */
  stock(key: string): StockInfo {
    const probes = this.unseenProbes(key, Infinity);
    const count = (kind: ItemKind) => (this.unseen(key, kind) as AnyItem[]).length;
    const completions = count('completions');
    const tracebacks = count('tracebacks');
    return {
      probes: probes.length,
      groups: new Set(probes.map((p) => p.group)).size,
      examples: count('examples'),
      completions,
      contrasts: count('contrasts'),
      tracebacks,
      items: probes.length + completions + tracebacks,
    };
  }

  /** Fewer than 3 unseen probes. */
  lowStock(key: string): boolean {
    return this.stock(key).probes < LOW_STOCK;
  }

  /** Merge another window's cache (or file content) by item id. */
  merge(other: AtomCache | AtomCacheData): void {
    this.mergeData(other instanceof AtomCache ? other.toJSON() : other);
    this.touch();
  }

  toJSON(): AtomCacheData {
    return structuredClone({ version: 1, lang: this.lang, atoms: this.atoms, meta: this.meta });
  }

  /** Write now: re-read the file, merge it by item id, then save (another window may have written). */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const run = this.chain.then(() => this.write());
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Flush pending changes and stop the debounce timer. */
  async dispose(): Promise<void> {
    await this.flush();
  }

  // ------------------------------------------------------------ internals

  private async write(): Promise<void> {
    if (!this.io || !this.dirty) return;
    this.dirty = false;
    try {
      const disk = await this.io.load();
      if (disk) this.mergeData(disk);
      await this.io.save(this.toJSON());
    } catch (e) {
      this.dirty = true;
      throw e;
    }
  }

  private touch(): void {
    this.dirty = true;
    if (!this.io || this.debounceMs < 0) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush().catch((e) => this.onError?.(e));
    }, this.debounceMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private mergeData(data: AtomCacheData): void {
    if (!data || typeof data !== 'object' || data.version !== 1 || data.lang !== this.lang) return;
    for (const [key, raw] of Object.entries(data.atoms ?? {})) {
      const atom = normalizeAtom(raw, key, this.lang);
      if (!atom) continue;
      this.atoms[key] = this.has(key) ? mergeAtoms(this.atoms[key], atom) : atom;
    }
    for (const [key, items] of Object.entries(data.meta ?? {})) {
      const m = (this.meta[key] ??= {});
      for (const [id, meta] of Object.entries(items ?? {})) {
        if (meta && Number.isFinite(meta.usedAt)) m[id] = mergeMeta(m[id], meta);
      }
    }
    for (const key of Object.keys(this.atoms)) this.cap(key);
  }

  private find(key: string, itemId: string): AnyItem | undefined {
    const atom = this.atoms[key];
    return atom ? allItems(atom).find((it) => it.id === itemId) : undefined;
  }

  private seenRecently(key: string, it: AnyItem, now: number): boolean {
    return recent(statsOf(it)?.seenAt, now) || recent(this.meta[key]?.[it.id]?.seenAt, now);
  }

  /**
   * LRU cap: at most 60 items per key; the least recently put or shown go first, never below a
   * runnable minimum per kind. Meta of evicted items is kept while they were shown in the last
   * 7 days, so the no-repeat rule still holds if the same item comes back.
   */
  private cap(key: string): void {
    const atom = this.atoms[key];
    const meta = (this.meta[key] ??= {});
    const now = this.now();
    const total = allItems(atom).length;
    if (total > ITEM_CAP) {
      const usedAt = (it: AnyItem) => meta[it.id]?.usedAt ?? Math.max(atom.createdAt, ...(statsOf(it)?.seenAt ?? []));
      const order = KINDS.flatMap((kind) => (atom[kind] as AnyItem[]).map((it, i) => ({ kind, it, i, at: usedAt(it) })))
        .sort((a, b) => a.at - b.at || a.i - b.i);
      const left: Record<ItemKind, number> = Object.fromEntries(KINDS.map((k) => [k, (atom[k] as AnyItem[]).length])) as Record<ItemKind, number>;
      const evict = new Set<string>();
      let n = total;
      for (const { kind, it } of order) {
        if (n <= ITEM_CAP) break;
        if (left[kind] <= MIN_KEEP[kind]) continue;
        evict.add(it.id);
        left[kind]--;
        n--;
        // Keep its show times in meta for the 7-day rule.
        const seen = statsOf(it)?.seenAt;
        if (seen?.length) meta[it.id] = { ...meta[it.id], usedAt: usedAt(it), seenAt: unionTimes(meta[it.id]?.seenAt, seen) };
      }
      for (const kind of KINDS) (atom as unknown as Record<ItemKind, AnyItem[]>)[kind] = (atom[kind] as AnyItem[]).filter((it) => !evict.has(it.id));
    }
    // Forget meta of items that are gone and were not shown in the last 7 days.
    const live = new Set(allItems(atom).map((it) => it.id));
    for (const [id, m] of Object.entries(meta)) if (!live.has(id) && !recent(m.seenAt, now)) delete meta[id];
  }
}

function allItems(atom: StoredAtom): AnyItem[] {
  return KINDS.flatMap((k) => (atom[k] ?? []) as AnyItem[]);
}

/** One per group first (in the given order), then the rest. */
function spreadGroups<T>(items: T[], n: number, group: (t: T) => string): T[] {
  const out: T[] = [];
  const used = new Set<string>();
  for (const it of items) {
    if (out.length >= n) return out;
    const g = group(it);
    if (used.has(g)) continue;
    used.add(g);
    out.push(it);
  }
  for (const it of items) {
    if (out.length >= n) break;
    if (!out.includes(it)) out.push(it);
  }
  return out;
}

/** A defensive copy without retired mutants. */
function viewAtom(a: StoredAtom): StoredAtom {
  const v = structuredClone(a);
  for (const p of v.probes) {
    if (!p.mutants.some(isRetired)) continue;
    p.mutants = p.mutants.filter((m) => !isRetired(m));
    p.discriminating = p.discriminating && p.mutants.some((m) => !m.ambiguous);
  }
  return v;
}
