// Item stock for the pad (spec V1-5 PARAMETRIC SEEDS and CACHE, latencyStrategy 'low stock').
// - Loads media/seed/<lang>.json (and media/seed/neutral.json) through an injected readFile.
// - At activation, after runtime detection: ensureStock() instantiates 3 instances of every
//   placement-candidate template in ONE batch (the Instantiator runs each instance and its curated
//   mutants on the learner's own runtime, two passes) and puts them in the AtomCache.
// - In the background, with no model call: refillIfLow(key) tops a seeded concept back up when it
//   drops below 6 unseen probes (and keeps a few completions, examples, contrasts and tracebacks).
// - Without a runtime (or without consent): the 3 language-neutral pseudocode items from
//   neutral.json, stored as UNVERIFIED atoms (evidence slip .2 / guess +.1, mutant matching off).
// - stockFor(key) lists what can be shown now; deck(learner) is the which-pattern / use-case source.
// Pure module apart from the injected I/O and runner: no vscode import.

import type {
  AtomPattern, Lang, PatternCard, Runner, SeedTemplate, SeedTransform, StoredAtom, StoredCompletion, StoredContrast, StoredExample,
  StoredMutant, StoredProbe, TracebackItem,
} from '../contracts';
import { answerSpaceG } from '../compare';
import { concept } from '../learner';
import type { Learner } from '../types';
import type { AtomCache } from './cache';
import {
  applyTransform, emptyStats, Instantiator, parseSeedBank, seedAtom, seedPattern, singleDiffLine, templateIdOf, type InstantiateOptions,
  type InstantiateResult, type SeedBank, type TemplateReport,
} from './seeds';
import { PLACEMENT_FUNDAMENTALS, tagInfo } from './tags';

export const STOCK = {
  /** Instances per placement-candidate template at activation. */
  perTemplate: 3,
  /** A seeded concept below this many unseen probes is refilled in the background. */
  refillBelow: 6,
  minCompletions: 2,
  minExamples: 1,
  minContrasts: 1,
  minTracebacks: 3,
  /** Instances per template in one refill. */
  maxPerTemplate: 3,
} as const;

export const seedFile = (lang: Lang): string => `media/seed/${lang}.json`;
export const NEUTRAL_FILE = 'media/seed/neutral.json';
export const TRACEBACK_TAG = 'reading-tracebacks';

/** What a cache key can show right now (unseen in 7 days). */
export interface KeyStock {
  key: string;
  tag: string;
  verified: boolean;
  /** Mutants stripped when the atom is unverified (mutant matching is off). */
  probes: StoredProbe[];
  /** Empty without a runner (completions are graded by running them). */
  completions: StoredCompletion[];
  examples: StoredExample[];
  contrasts: StoredContrast[];
  tracebacks: TracebackItem[];
}

export interface StockReport {
  tags: string[];
  /** Templates sent to the Instantiator. */
  templates: number;
  /** Items added to the cache. */
  added: number;
  /** Neutral (unverified) items were used: no runtime. */
  neutral: boolean;
  problems: string[];
}

type InstantiateFn = (templates: readonly SeedTemplate[], n: number, opts: InstantiateOptions) => Promise<InstantiateResult>;

export interface StockDeps {
  lang: Lang;
  /** Read a bundled file relative to the extension root ('media/seed/python.json'). */
  readFile: (relPath: string) => Promise<string>;
  cache: AtomCache;
  /** The runner when local execution is available and allowed; undefined: neutral items only. */
  runner: () => Runner | undefined;
  /** Per-session instantiation seed (default Date.now() >>> 0). */
  seed?: number;
  now?: () => number;
  /** 'Deliberate: content' output channel. */
  log?: (line: string) => void;
  /** Test seam: replaces new Instantiator(runner, seed).instantiate. */
  instantiate?: (runner: Runner) => InstantiateFn;
}

/** A neutral.json template: hand-traced answers instead of runs. */
type NeutralTemplate = SeedTemplate & { answer?: string; transforms: (SeedTransform & { prints?: string })[] };

export class Stock {
  readonly lang: Lang;
  readonly cache: AtomCache;
  bank: SeedBank | undefined;
  neutral: SeedBank | undefined;
  private loading: Promise<void> | undefined;
  /** The banks were read (successfully or not). */
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly refills = new Map<string, Promise<void>>();
  private inst: { runner: Runner; fn: InstantiateFn } | undefined;
  private readonly seed: number;
  private readonly logged = new Set<string>();

  constructor(private readonly deps: StockDeps) {
    this.lang = deps.lang;
    this.cache = deps.cache;
    this.seed = deps.seed ?? Date.now() >>> 0;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(line: string): void {
    if (this.logged.has(line)) return;
    this.logged.add(line);
    this.deps.log?.(line);
  }

  /** Read and check the seed banks (once). A missing or broken file is logged, never thrown. */
  load(): Promise<void> {
    return (this.loading ??= this.loadBanks().finally(() => {
      this.loaded = true;
    }));
  }

  private async loadBanks(): Promise<void> {
    try {
      const { bank, problems } = parseSeedBank(JSON.parse(await this.deps.readFile(seedFile(this.lang))), this.lang);
      this.bank = bank;
      for (const p of problems) this.log(`seed ${this.lang}: ${p}`);
    } catch (e) {
      this.log(`seed ${this.lang}: cannot load ${seedFile(this.lang)}: ${(e as Error).message ?? e}`);
    }
    try {
      const { bank, problems } = parseSeedBank(JSON.parse(await this.deps.readFile(NEUTRAL_FILE)));
      this.neutral = bank;
      for (const p of problems) this.log(`seed neutral: ${p}`);
    } catch (e) {
      this.log(`seed neutral: cannot load ${NEUTRAL_FILE}: ${(e as Error).message ?? e}`);
    }
  }

  /** One instantiation batch at a time (activation batch and refills share the runner). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private instantiator(runner: Runner): InstantiateFn {
    if (this.inst?.runner !== runner) {
      const fn: InstantiateFn = this.deps.instantiate
        ? this.deps.instantiate(runner)
        : (() => {
            const it = new Instantiator(runner, this.seed);
            return (templates, n, opts) => it.instantiate(templates, n, opts);
          })();
      this.inst = { runner, fn };
    }
    return this.inst.fn;
  }

  /** Does the bundled bank have templates for this tag? */
  hasSeeds(tag: string): boolean {
    return !!this.bank?.templates.some((t) => t.tag === tag);
  }

  /** Placement candidates: the language's fundamentals (plus the neutral tags when there is no runtime). */
  placementTags(): string[] {
    const base = [...PLACEMENT_FUNDAMENTALS[this.lang]];
    if (this.deps.runner()) return base;
    const neutral = (this.neutral?.templates ?? []).map((t) => t.tag).filter((t) => tagInfo(t)?.langs.includes(this.lang));
    return [...new Set([...base, ...neutral])];
  }

  /**
   * At activation: 3 instances of each placement-candidate template (default: the language's
   * fundamentals) in one batch, skipping templates that still have 3 unseen instances in the cache.
   * Without a runner the neutral items are stocked instead.
   */
  async ensureStock(tags?: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<StockReport> {
    await this.load();
    const want = [...new Set(tags ?? PLACEMENT_FUNDAMENTALS[this.lang])];
    const runner = this.deps.runner();
    if (!runner) return this.ensureNeutral(want);
    return this.serial(async () => {
      const unseen = new Map(want.map((t) => [t, this.unseenByTemplate(t)]));
      const templates = (this.bank?.templates ?? []).filter((t) => want.includes(t.tag) && (unseen.get(t.tag)?.get(t.id) ?? 0) < STOCK.perTemplate);
      return this.instantiateInto(runner, templates, STOCK.perTemplate, want, opts.signal);
    });
  }

  /**
   * Background refill (no model call) for a seeded key: below 6 unseen probes, or short of
   * completions / examples / contrasts / tracebacks. Single-flight per key. Undefined when there is
   * nothing to do (decided at once when the banks are loaded), so callers can poke it after every pick.
   */
  refillIfLow(key: string): Promise<void> | undefined {
    const pending = this.refills.get(key);
    if (pending) return pending;
    if (!this.deps.runner()) return undefined;
    if (this.loaded && !this.refillPlan(key)) return undefined;
    const p = this.load()
      .then(async () => {
        const runner = this.deps.runner();
        const plan = this.refillPlan(key);
        if (runner && plan) await this.serial(() => this.instantiateInto(runner, plan.templates, plan.n, [key]));
      })
      .catch((e) => this.log(`seed ${this.lang}: refill ${key} failed: ${(e as Error).message ?? e}`))
      .finally(() => this.refills.delete(key));
    this.refills.set(key, p);
    return p;
  }

  /** The templates (and instances per template) that bring a seeded key back to its stock targets. */
  private refillPlan(key: string): { templates: SeedTemplate[]; n: number } | undefined {
    const templates = (this.bank?.templates ?? []).filter((t) => t.tag === key);
    if (!templates.length) return undefined;
    const st = this.cache.has(key) ? this.cache.stock(key) : { probes: 0, completions: 0, examples: 0, contrasts: 0, tracebacks: 0 };
    const kinds: { kind: SeedTemplate['kind']; have: number; want: number }[] = [
      { kind: 'probe', have: st.probes, want: STOCK.refillBelow },
      { kind: 'completion', have: st.completions, want: STOCK.minCompletions },
      { kind: 'example', have: st.examples, want: STOCK.minExamples },
      { kind: 'contrast', have: st.contrasts, want: STOCK.minContrasts },
      { kind: 'traceback', have: st.tracebacks, want: STOCK.minTracebacks },
    ];
    const pick: SeedTemplate[] = [];
    let n = 1;
    for (const k of kinds) {
      const ts = templates.filter((t) => t.kind === k.kind);
      if (!ts.length || k.have >= k.want) continue;
      pick.push(...ts);
      n = Math.max(n, Math.min(STOCK.maxPerTemplate, Math.ceil((k.want - k.have) / ts.length)));
    }
    return pick.length ? { templates: pick, n } : undefined;
  }

  private async instantiateInto(runner: Runner, templates: SeedTemplate[], n: number, tags: string[], signal?: AbortSignal): Promise<StockReport> {
    const report: StockReport = { tags, templates: templates.length, added: 0, neutral: false, problems: [] };
    if (!templates.length) return report;
    const touched = [...new Set(templates.map((t) => t.tag))];
    const opts: InstantiateOptions = { exclude: this.excludeFor(touched) };
    if (signal) opts.signal = signal;
    const res = await this.instantiator(runner)(templates, n, opts);
    for (const [tag, pieces] of Object.entries(res.byTag)) {
      const count = pieces.probes.length + pieces.examples.length + pieces.completions.length + pieces.contrasts.length + pieces.tracebacks.length;
      if (!count) continue;
      this.cache.put(seedAtom(tag, this.lang, pieces, this.bank, this.now()));
      report.added += count;
    }
    report.problems = this.reportProblems(res.reports);
    return report;
  }

  private reportProblems(reports: readonly TemplateReport[]): string[] {
    const out: string[] = [];
    for (const r of reports) {
      for (const p of r.problems) out.push(p);
      if (r.valid < r.requested && !r.exhausted && r.drawn > 0) {
        out.push(`${r.templateId}: ${r.valid}/${r.requested} valid (${Object.entries(r.rejected).map(([k, v]) => `${k} ${v}`).join(', ') || 'no draws'})`);
      }
    }
    for (const p of out) this.log(`seed ${this.lang}: ${p}`);
    return out;
  }

  /** Every item id already in the cache for these tags, plus ids shown in the last 7 days. */
  private excludeFor(tags: readonly string[]): string[] {
    const ids = new Set<string>();
    for (const tag of tags) {
      const a = this.cache.get(tag);
      if (a) for (const it of [...a.probes, ...a.examples, ...a.completions, ...a.contrasts, ...a.tracebacks]) ids.add(it.id);
      for (const id of this.cache.seenIds(tag)) ids.add(id);
    }
    return [...ids];
  }

  /** Unseen items per template id for one tag. */
  private unseenByTemplate(tag: string): Map<string, number> {
    const m = new Map<string, number>();
    if (!this.cache.has(tag)) return m;
    const items: { id: string }[] = [
      ...this.cache.unseenProbes(tag, Infinity),
      ...this.cache.unseen(tag, 'completions'),
      ...this.cache.unseen(tag, 'examples'),
      ...this.cache.unseen(tag, 'contrasts'),
      ...this.cache.unseen(tag, 'tracebacks'),
    ];
    for (const it of items) m.set(templateIdOf(it.id), (m.get(templateIdOf(it.id)) ?? 0) + 1);
    return m;
  }

  // ------------------------------------------------------------ neutral items (no runtime)

  /** The neutral pseudocode items for these tags, stored unverified (a verified atom always wins). */
  ensureNeutral(tags?: readonly string[]): StockReport {
    const report: StockReport = { tags: [...(tags ?? [])], templates: 0, added: 0, neutral: true, problems: [] };
    const bank = this.neutral;
    if (!bank) return report;
    const byTag = new Map<string, StoredProbe[]>();
    for (const t of bank.templates as NeutralTemplate[]) {
      // All of them, whatever was asked for: without a runtime these few items are the whole stock.
      if (t.kind !== 'probe' || !tagInfo(t.tag)?.langs.includes(this.lang)) continue;
      report.templates++;
      if (this.cache.get(t.tag)?.verified) continue;
      const probe = neutralProbe(t);
      if (!probe) {
        report.problems.push(`${t.id}: no answer`);
        continue;
      }
      byTag.set(t.tag, [...(byTag.get(t.tag) ?? []), probe]);
    }
    for (const [tag, probes] of byTag) {
      this.cache.put(neutralAtom(tag, this.lang, probes, bank, this.now()));
      report.added += probes.length;
    }
    return report;
  }

  // ------------------------------------------------------------ reading stock

  /** Unseen items of a key, ready for placement and sprints. Undefined for an unknown key. */
  stockFor(key: string): KeyStock | undefined {
    const atom = this.cache.get(key);
    if (!atom) return undefined;
    const canRun = !!this.deps.runner() && atom.verified;
    const probes = this.cache.unseenProbes(key, Infinity).map((p) => (atom.verified ? p : { ...p, mutants: [], discriminating: false }));
    return {
      key, tag: atom.tag, verified: atom.verified, probes,
      completions: canRun ? this.cache.unseen(key, 'completions') : [],
      examples: this.cache.unseen(key, 'examples'),
      contrasts: atom.verified ? this.cache.unseen(key, 'contrasts') : [],
      tracebacks: atom.verified ? this.cache.unseen(key, 'tracebacks') : [],
    };
  }

  /**
   * The cache key holding items for a learner concept: its id or an alias with an atom (model packs),
   * else its tag when it owns the tag (seeds are keyed by tag). A concept owns its tag when it is the
   * seed concept (id = tag, plan aliases merged into it) or the only concept carrying that tag; several
   * separate plan concepts on one tag are project-specific and get their own packs instead.
   * Undefined when nothing is stocked.
   */
  cacheKeyFor(learner: Learner, conceptId: string): string | undefined {
    const c = concept(learner, conceptId);
    for (const id of c ? [c.id, ...c.aliases] : [conceptId]) if (this.cache.has(id)) return id;
    const tag = c?.tag ?? (tagInfo(conceptId) ? conceptId : undefined);
    if (!tag || tag === 'other' || !this.cache.has(tag)) return undefined;
    if (!c) return tag;
    const tagged = Object.values(learner.concepts).filter((x) => x.tag === tag);
    const owner = learner.concepts[tag] ?? (tagged.length === 1 ? tagged[0] : undefined);
    return owner === c ? tag : undefined;
  }

  /** The bundled pattern card for a tag (canonical name), when a bank covers it. */
  pattern(tag: string): AtomPattern | undefined {
    if (this.bank?.patterns?.[tag]) return seedPattern(tag, this.bank);
    if (this.neutral?.patterns?.[tag]) return seedPattern(tag, this.neutral);
    return undefined;
  }

  /** Use cases for a tag from the bundled banks (the which-pattern source for seeded tags). */
  useCases(tag: string): string[] {
    return [...new Set([...(this.bank?.patterns?.[tag]?.useCases ?? []), ...(this.neutral?.patterns?.[tag]?.useCases ?? [])])];
  }

  /**
   * The Pattern Deck as which-pattern items see it: the learner's cards, each with its use cases
   * topped up from the bundled pattern of its tag (cards are not changed; seen times stay on them).
   */
  deck(learner: Learner): PatternCard[] {
    return (learner.patternDeck ?? []).map((card) => {
      const extra = this.useCases(card.tag);
      if (!extra.length) return card;
      return { ...card, useCases: [...new Set([...(card.useCases ?? []), ...extra])] };
    });
  }
}

// ---------------------------------------------------------------- neutral pieces

/**
 * A neutral template as an unverified StoredProbe: output from the hand-traced answer, each mutant's
 * output from its 'prints', code = the transform applied, diffLine from the line diff.
 */
export function neutralProbe(t: NeutralTemplate): StoredProbe | undefined {
  const answer = String(t.answer ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!answer.trim()) return undefined;
  const id = `${t.id}#n`;
  const output = { stdout: `${answer}\n`, values: [] };
  const mutants: StoredMutant[] = [];
  for (const tr of t.transforms ?? []) {
    const code = applyTransform(t.code, tr.find, tr.replace);
    const prints = typeof tr.prints === 'string' ? tr.prints.replace(/\r\n?/g, '\n').replace(/\n+$/, '') : undefined;
    if (!code || prints === undefined) continue;
    const diffLine = singleDiffLine(t.code, code);
    if (diffLine === undefined) continue;
    mutants.push({
      id: `${id}~${tr.misconceptionId}`, misconceptionId: tr.misconceptionId, belief: tr.belief, refutation: tr.refutation, rule: tr.rule,
      code, output: { stdout: `${prints}\n`, values: [] }, diffLine, source: 'curated', ambiguous: false, matches: 0, confirmations: 0,
      rejections: 0,
    });
  }
  return {
    id, group: `${t.family}:plain`, code: t.code, output, parSec: t.parSec, answerSpaceG: answerSpaceG(output), constructs: [],
    discriminating: false, mutants, stats: emptyStats(),
  };
}

export function neutralAtom(tag: string, lang: Lang, probes: StoredProbe[], bank: SeedBank | undefined, now: number): StoredAtom {
  return {
    key: tag, lang, conceptId: tag, tag, source: 'seed', verified: false, createdAt: now, pattern: seedPattern(tag, bank),
    probes, examples: [], completions: [], contrasts: [], tracebacks: [],
  };
}
