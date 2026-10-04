// Parametric seed templates (spec V1-5 PARAMETRIC SEEDS, conceptAtom PARTS).
// The Instantiator draws instances of bundled templates with a seeded RNG, runs every instance and its
// curated misconception mutants on the learner's own runtime (one runBatch call per pass, two passes
// with different hash seeds), keeps only instances whose mutants are distinguishable, and converts them
// to StoredAtom pieces. Pure module: no vscode import; the runner is injected.
//
// =====================================================================================================
// SEED FILE FORMAT: media/seed/<lang>.json  (lang: python | javascript | typescript)
// =====================================================================================================
// {
//   "lang": "python",
//   "patterns": {                       // one card per tag the file covers (name is forced to tags.ts)
//     "list-slicing": { "kind": "shape", "name": "Slice a sequence", "useWhen": "you need part of a list",
//       "template": "<seq>[<start>:<stop>]", "rule": "", "howItRuns": "", "pitfall": "stop is excluded",
//       "useCases": ["first three scores", "drop the header row", "...6 or more, <= 12 words each"] }
//   },
//   "templates": [
//     { "id": "py-slice-basic",          // unique, stable, no '#' or '~' (instance id = id + '#' + hash)
//       "tag": "list-slicing",           // a canonical tag from src/atoms/tags.ts that covers this lang
//       "family": "slice-basic",         // surface family: sibling group = family + ':' + theme
//       "kind": "probe",                 // probe | example | completion | contrast | traceback
//       "code": "{{@xs}} = {{vals}}\nprint({{@xs}}[{{i}}:{{j}}])",
//       "slots": {                       // drawn IN ORDER: index/derive may refer to earlier slots
//         "vals": { "gen": "intList", "minLen": 5, "maxLen": 7, "min": 0, "max": 9, "distinct": true },
//         "i": { "gen": "int", "min": 1, "max": 2 },
//         "j": { "gen": "derive", "expr": "i + 2" },
//         "j1": { "gen": "derive", "expr": "j + 1" }   // mutants read like real code: [2:5], not [2:4 + 1]
//       },
//       "themes": { "scores": { "xs": "scores" }, "temps": { "xs": "temps" } },
//       "transforms": [
//         { "misconceptionId": "slice-end-included",   // must be a tags.ts id of this tag and language
//           "find": "[{{i}}:{{j}}]", "replace": "[{{i}}:{{j1}}]",
//           "belief": "The slice includes the item at the stop index",                  // <= 12 words
//           "refutation": "A slice stops just before index {{j}}, so that item is left out.", // <= 25
//           "rule": "A slice includes start and excludes stop." }                      // <= 12 words
//       ],
//       "parSec": 6 }
//   ]
// }
// Holes:
// - {{name}} is a slot, {{@name}} a theme identifier. They are filled in code, contrastCode, harness,
//   solutions, wrongFills, subgoal labels and in the transform/contrast texts (belief, refutation, rule).
//   There is no escape: a template needing literal '{{x}}' text must build it another way.
// - Slot text: int/index/derive/pick -> the value as written; word -> the bare word (add quotes in the
//   template); intList -> [3, 1, 4]; wordList -> ['fig', 'kiwi'] (valid Python and JS).
// Slots (contracts SlotSpec):
// - int {min, max, notIn?} | intList {minLen, maxLen, min, max, distinct?, sorted?}
// - index {of, offset?, negative?}: a random valid index of list slot `of`, plus offset; negative
//   rewrites it as index - len (so -1 is the last item).
// - pick {options} | word {pool} | wordList {pool, minLen, maxLen, distinct?}
//   pools: nouns, names, fruits, cities, colors, animals (WORD_POOLS below).
// - derive {expr}: integer arithmetic over earlier slots: + - * // % (floor semantics, like Python),
//   unary minus, parentheses, xs[i], len(xs), sum(xs), min(...), max(...), abs(x).
// Transforms (probe only, 1-3): applied to the TEMPLATE before filling. `find` must occur exactly once
// in code and neither find nor replace may contain a newline, else the transform is dropped (reported).
// A mutant must terminate and must not be a syntax error.
// Kinds:
// - probe: <= 8 lines, prints 1-4 lines (<= 200 chars) or raises on purpose (answer = exception name),
//   parSec 3-8, 1-3 transforms. An instance is valid only if every mutant prints something different
//   from the original (strict comparison) and from every other mutant, in both hash-seed passes, and
//   more than one edit away from the original (compareOutput treats a one-character difference as a
//   slip and never names that belief): 7 vs 8, 5 vs 55 or a removed space are one edit; shift two
//   printed values, or draw values like 100/200 next to single digits.
//   Under typeSensitive tags print repr(x) / type(x).__name__ (Python) or JSON.stringify(x) / typeof x
//   (JS), so '5' and 5 print differently. Never depend on set order or string hashing.
// - example: 5-8 lines, must run cleanly and print; "subgoals": [{ "line": 1, "label": "<= 6 words" }].
// - completion: 6-10 lines, the pattern inside a function, blanks [[1]] (and [[2]]), parSec 20-40,
//   "solutions": ["exact fill", ...], "wrongFills": [{ "blank": 1, "fill": "...", "misconceptionId": "..." }],
//   "harness": lines appended after the code; at least 2 check(f(...) == expected, 'msg') calls with
//   different inputs (check is predefined; never assert/require/process). Verified per instance: the
//   solution passes, empty blanks fail, every constant fill (each expected value written as the fill)
//   fails; a wrongFill that passes is dropped.
// - contrast: "code" holds the misconception's behaviour, "contrastCode" the correct one (<= 4 lines
//   each), "misconceptionId", "rule" (<= 12 words). Both must run and print different things.
// - traceback: <= 8 lines that raise (ideally through a helper function); tag 'reading-tracebacks'.
// =====================================================================================================

import {
  AtomPattern, BatchItem, BatchOptions, BatchRecord, ItemStats, Lang, RecordedOutput, Runner, SeedFile, SeedKind, SeedTemplate,
  SlotSpec, StoredAtom, StoredCompletion, StoredContrast, StoredExample, StoredMutant, StoredProbe, TracebackItem,
} from '../contracts';
import { answerSpaceG, mutantAttributable, valEquals } from '../compare';
import { hash53, Rng } from './rng';
import { findMisconception, OTHER_TAG, tagInfo } from './tags';
import { buildTracebackParts } from './traceback';

const DAY = 24 * 60 * 60 * 1000;
/** An exact item (template + slot values) is never shown to the same learner twice within this window. */
export const REPEAT_WINDOW_MS = 7 * DAY;
/** PYTHONHASHSEED of the two verification passes. */
export const PASS_SEEDS: readonly [number, number] = [1, 2];
const DEFAULT_ROUNDS = 3;
const DRAW_TRIES = 25;

export const WORD_POOLS = {
  nouns: ['book', 'lamp', 'chair', 'desk', 'pen', 'cup', 'door', 'key', 'map', 'box', 'coin', 'bell', 'ring', 'rope',
    'sock', 'tent', 'vase', 'kite', 'drum', 'flag'],
  names: ['Ada', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivan', 'Jo', 'Kai', 'Lena', 'Mo', 'Nia', 'Omar',
    'Pia', 'Raj', 'Sam', 'Tess', 'Uma', 'Vic', 'Wes', 'Yuki', 'Zoe'],
  fruits: ['apple', 'banana', 'cherry', 'date', 'fig', 'grape', 'kiwi', 'lemon', 'lime', 'mango', 'melon', 'olive',
    'peach', 'pear', 'plum', 'quince'],
  cities: ['Oslo', 'Lima', 'Rome', 'Paris', 'Tokyo', 'Cairo', 'Delhi', 'Quito', 'Kyiv', 'Seoul', 'Dakar', 'Perth',
    'Osaka', 'Milan', 'Porto', 'Accra', 'Hanoi', 'Bern', 'Riga', 'Doha'],
  colors: ['red', 'blue', 'green', 'amber', 'black', 'white', 'pink', 'teal', 'gold', 'gray', 'cyan', 'navy',
    'violet', 'ivory', 'coral', 'lilac'],
  animals: ['cat', 'dog', 'owl', 'fox', 'bee', 'cow', 'yak', 'eel', 'tiger', 'zebra', 'otter', 'panda', 'koala',
    'llama', 'moose', 'horse', 'sheep', 'camel', 'goose', 'whale'],
} as const satisfies Record<string, readonly string[]>;
export type WordPool = keyof typeof WORD_POOLS;

/** Seed file as bundled: the contracts SeedFile plus one pattern card per covered tag. */
export interface SeedBank extends SeedFile {
  patterns?: Record<string, AtomPattern>;
}

// =====================================================================================================
// Seeded RNG and hashing
// =====================================================================================================

export { hash53, mulberry32, Rng } from './rng';

// =====================================================================================================
// Slots, derive expressions, holes
// =====================================================================================================

export type SlotValue = number | string | number[] | string[];

/** A draw that cannot be filled (empty list for an index, division by zero...): the draw is invalid. */
export class SlotError extends Error {}

type Ast =
  | { k: 'num'; v: number }
  | { k: 'name'; name: string }
  | { k: 'neg'; e: Ast }
  | { k: 'bin'; op: string; l: Ast; r: Ast }
  | { k: 'idx'; e: Ast; i: Ast }
  | { k: 'call'; fn: string; args: Ast[] };

const DERIVE_FUNCS = new Set(['len', 'sum', 'min', 'max', 'abs']);

/** Parse a derive expression; throws SlotError on bad syntax. */
export function parseDerive(expr: string): Ast {
  const toks: string[] = [];
  const re = /\s*(\d+|[A-Za-z_]\w*|\/\/|[-+*%()[\],])/y;
  let pos = 0;
  while (pos < expr.length) {
    if (/^\s*$/.test(expr.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(expr);
    if (!m) throw new SlotError(`bad derive expression '${expr}' at '${expr.slice(pos).trim()}'`);
    toks.push(m[1]);
    pos = re.lastIndex;
  }
  let i = 0;
  const peek = () => toks[i];
  const take = (want?: string): string => {
    const t = toks[i];
    if (t === undefined || (want !== undefined && t !== want)) {
      throw new SlotError(`bad derive expression '${expr}': expected ${want ?? 'more'}, got ${t ?? 'end'}`);
    }
    i++;
    return t;
  };
  const sum = (): Ast => {
    let l = term();
    while (peek() === '+' || peek() === '-') l = { k: 'bin', op: take(), l, r: term() };
    return l;
  };
  const term = (): Ast => {
    let l = unary();
    while (peek() === '*' || peek() === '//' || peek() === '%') l = { k: 'bin', op: take(), l, r: unary() };
    return l;
  };
  const unary = (): Ast => {
    if (peek() === '-') {
      take();
      return { k: 'neg', e: unary() };
    }
    if (peek() === '+') {
      take();
      return unary();
    }
    let e = primary();
    while (peek() === '[') {
      take('[');
      const ix = sum();
      take(']');
      e = { k: 'idx', e, i: ix };
    }
    return e;
  };
  const primary = (): Ast => {
    const t = take();
    if (t === '(') {
      const e = sum();
      take(')');
      return e;
    }
    if (/^\d+$/.test(t)) return { k: 'num', v: Number(t) };
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') {
        if (!DERIVE_FUNCS.has(t)) throw new SlotError(`unknown function ${t}() in '${expr}'`);
        take('(');
        const args = [sum()];
        while (peek() === ',') {
          take(',');
          args.push(sum());
        }
        take(')');
        return { k: 'call', fn: t, args };
      }
      return { k: 'name', name: t };
    }
    throw new SlotError(`bad derive expression '${expr}': unexpected '${t}'`);
  };
  const ast = sum();
  if (i < toks.length) throw new SlotError(`bad derive expression '${expr}': unexpected '${toks[i]}'`);
  return ast;
}

function deriveNames(a: Ast, out = new Set<string>()): Set<string> {
  switch (a.k) {
    case 'name': out.add(a.name); break;
    case 'neg': deriveNames(a.e, out); break;
    case 'bin': deriveNames(a.l, out); deriveNames(a.r, out); break;
    case 'idx': deriveNames(a.e, out); deriveNames(a.i, out); break;
    case 'call': a.args.forEach((x) => deriveNames(x, out)); break;
  }
  return out;
}

function evalAst(a: Ast, values: Record<string, SlotValue>): SlotValue {
  const num = (v: SlotValue): number => {
    if (typeof v !== 'number') throw new SlotError('derive: expected a number');
    return v;
  };
  switch (a.k) {
    case 'num': return a.v;
    case 'name':
      if (!Object.prototype.hasOwnProperty.call(values, a.name)) throw new SlotError(`derive: unknown slot ${a.name}`);
      return values[a.name];
    case 'neg': return -num(evalAst(a.e, values));
    case 'bin': {
      const l = num(evalAst(a.l, values));
      const r = num(evalAst(a.r, values));
      if (a.op === '+') return l + r;
      if (a.op === '-') return l - r;
      if (a.op === '*') return l * r;
      if (r === 0) throw new SlotError('derive: division by zero');
      return a.op === '//' ? Math.floor(l / r) : l - r * Math.floor(l / r);
    }
    case 'idx': {
      const xs = evalAst(a.e, values);
      if (!Array.isArray(xs)) throw new SlotError('derive: only lists can be indexed');
      const k = num(evalAst(a.i, values));
      const j = k < 0 ? xs.length + k : k;
      if (j < 0 || j >= xs.length) throw new SlotError('derive: index out of range');
      return xs[j];
    }
    case 'call': {
      const args = a.args.map((x) => evalAst(x, values));
      const list = (): number[] => {
        const v = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        return (v as SlotValue[]).map(num);
      };
      switch (a.fn) {
        case 'len': {
          const v = args[0];
          if (args.length !== 1 || (typeof v !== 'string' && !Array.isArray(v))) throw new SlotError('derive: len() takes a list');
          return v.length;
        }
        case 'sum': return list().reduce((s, x) => s + x, 0);
        case 'abs': return Math.abs(num(args[0]));
        default: {
          const xs = list();
          if (!xs.length) throw new SlotError(`derive: ${a.fn}() of nothing`);
          return a.fn === 'min' ? Math.min(...xs) : Math.max(...xs);
        }
      }
    }
  }
}

/** Evaluate a derive expression over earlier slot values; the result must be a safe integer. */
export function evalDerive(expr: string | Ast, values: Record<string, SlotValue>): number {
  const v = evalAst(typeof expr === 'string' ? parseDerive(expr) : expr, values);
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new SlotError('derive: result is not an integer');
  return v === 0 ? 0 : v; // never -0
}

const listText = (xs: (number | string)[]): string =>
  `[${xs.map((x) => (typeof x === 'string' ? `'${x}'` : String(x))).join(', ')}]`;

function intRange(min: number, max: number): number[] {
  const out: number[] = [];
  for (let x = min; x <= max; x++) out.push(x);
  return out;
}

/** Draw one slot. Returns the value and the literal text inserted for {{name}}. */
export function drawSlot(spec: SlotSpec, rng: Rng, values: Record<string, SlotValue>, parsed?: Ast): [SlotValue, string] {
  switch (spec.gen) {
    case 'int': {
      const banned = new Set(spec.notIn ?? []);
      for (let tries = 0; tries < 64; tries++) {
        const x = rng.int(spec.min, spec.max);
        if (!banned.has(x)) return [x, String(x)];
      }
      const allowed = spec.max - spec.min <= 100_000 ? intRange(spec.min, spec.max).filter((x) => !banned.has(x)) : [];
      if (!allowed.length) throw new SlotError('int: no allowed value');
      const x = rng.pick(allowed);
      return [x, String(x)];
    }
    case 'intList': {
      const len = rng.int(spec.minLen, spec.maxLen);
      let xs: number[];
      if (spec.distinct) {
        if (spec.max - spec.min + 1 < len) throw new SlotError('intList: range too small for distinct values');
        xs = rng.sample(intRange(spec.min, spec.max), len);
      } else {
        xs = Array.from({ length: len }, () => rng.int(spec.min, spec.max));
      }
      if (spec.sorted) xs.sort((a, b) => a - b);
      return [xs, listText(xs)];
    }
    case 'index': {
      const xs = values[spec.of];
      if (!Array.isArray(xs) || !xs.length) throw new SlotError(`index: slot ${spec.of} is not a non-empty list`);
      let v = rng.int(0, xs.length - 1) + (spec.offset ?? 0);
      if (spec.negative) v -= xs.length;
      return [v, String(v)];
    }
    case 'pick': {
      if (!spec.options.length) throw new SlotError('pick: no options');
      const o = rng.pick(spec.options);
      return [o, String(o)];
    }
    case 'word': {
      const w = rng.pick(WORD_POOLS[spec.pool]);
      return [w, w];
    }
    case 'wordList': {
      const pool = WORD_POOLS[spec.pool];
      const len = rng.int(spec.minLen, spec.maxLen);
      if (spec.distinct && len > pool.length) throw new SlotError('wordList: pool too small for distinct words');
      const ws = spec.distinct ? rng.sample(pool, len) : Array.from({ length: len }, () => rng.pick(pool));
      return [ws, listText(ws)];
    }
    case 'derive': {
      const v = evalDerive(parsed ?? spec.expr, values);
      return [v, String(v)];
    }
  }
}

const HOLE = /\{\{(@?)([A-Za-z_]\w*)\}\}/g;

/** Fill {{slot}} and {{@themeVar}} holes. Unknown names throw SlotError. */
export function fillHoles(text: string, texts: Record<string, string>, vars: Record<string, string>): string {
  return text.replace(HOLE, (m, at: string, name: string) => {
    const src = at ? vars : texts;
    if (!Object.prototype.hasOwnProperty.call(src, name)) throw new SlotError(`unknown ${at ? 'theme variable' : 'slot'} ${m}`);
    return src[name];
  });
}

function holesIn(text: string | undefined): { slots: string[]; vars: string[] } {
  const slots: string[] = [];
  const vars: string[] = [];
  for (const m of (text ?? '').matchAll(HOLE)) (m[1] ? vars : slots).push(m[2]);
  return { slots, vars };
}

// =====================================================================================================
// Transforms, blanks, harness checks
// =====================================================================================================

/** Occurrences of needle in hay, overlapping ones included. */
export function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

/** Apply a transform to template text: undefined unless `find` occurs exactly once and both sides are one line. */
export function applyTransform(code: string, find: string, replace: string): string | undefined {
  if (!find || find.includes('\n') || replace.includes('\n') || countOccurrences(code, find) !== 1) return undefined;
  const i = code.indexOf(find);
  return code.slice(0, i) + replace + code.slice(i + find.length);
}

/** The single 1-based line on which a and b differ, or undefined (no difference, several, or line counts differ). */
export function singleDiffLine(a: string, b: string): number | undefined {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length !== y.length) return undefined;
  let line: number | undefined;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    if (line !== undefined) return undefined;
    line = i + 1;
  }
  return line;
}

const BLANK = /\[\[(\d+)\]\]/g;

/** Replace completion blanks [[k]] with fills[k - 1]. */
export function fillBlanks(code: string, fills: readonly string[]): string {
  return code.replace(BLANK, (m, k: string) => fills[Number(k) - 1] ?? m);
}

/** Scan source text, skipping string literals and comments; calls visit(i, depth) for every code character. */
export function scanCode(s: string, visit: (i: number, depth: number) => boolean | void): void {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === '\\') i++;
      continue;
    }
    // Python '#' comments; JS '//' comments only at line start or after ';' (Python's // divides).
    if (c === '#' || (c === '/' && s[i + 1] === '/' && /(^|\n|;)[ \t]*$/.test(s.slice(0, i)))) {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    if (visit(i, depth) === false) return;
    if (')]}'.includes(c)) depth--;
  }
}

function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let start = 0;
  scanCode(s, (i, depth) => {
    if (depth === 0 && s.startsWith(sep, i)) {
      parts.push(s.slice(start, i));
      start = i + sep.length;
    }
  });
  parts.push(s.slice(start));
  return parts;
}

const hasCall = (s: string) => /[A-Za-z_$][\w$]*\s*\(/.test(s);

/** The literal side of `call(...) == literal` (or ===), if the condition has that shape. */
function expectedOf(cond: string): string | undefined {
  let at = -1;
  let len = 0;
  scanCode(cond, (i, depth) => {
    if (depth !== 0 || cond[i] !== '=' || cond[i + 1] !== '=') return;
    if ('!<>='.includes(cond[i - 1] ?? '')) return;
    at = i;
    len = cond[i + 2] === '=' ? 3 : 2;
    return false;
  });
  if (at < 0) return undefined;
  const l = cond.slice(0, at).trim();
  const r = cond.slice(at + len).trim();
  if (!l || !r || hasCall(l) === hasCall(r)) return undefined;
  return hasCall(l) ? r : l;
}

/** The condition (first argument, raw text) of every check(...) call in a harness, in order. */
export function checkCallConditions(harness: string): string[] {
  const out: string[] = [];
  const re = /(^|[^\w.$])check\s*\(/g;
  for (let m = re.exec(harness); m; m = re.exec(harness)) {
    const open = m.index + m[0].length - 1;
    let close = -1;
    const inner = harness.slice(open);
    scanCode(inner, (i, depth) => {
      if (inner[i] === ')' && depth === 1) {
        close = open + i;
        return false;
      }
    });
    if (close < 0) break;
    out.push(splitTop(harness.slice(open + 1, close), ',')[0] ?? '');
    re.lastIndex = close + 1;
  }
  return out;
}

/** check(...) calls in a harness, and the distinct expected literals of those shaped check(f(x) == literal, msg). */
export function harnessChecks(harness: string): { calls: number; expected: string[] } {
  const conds = checkCallConditions(harness);
  const expected: string[] = [];
  for (const c of conds) {
    const e = expectedOf(c);
    if (e !== undefined && !expected.includes(e)) expected.push(e);
  }
  return { calls: conds.length, expected };
}

// =====================================================================================================
// Template validation
// =====================================================================================================

const KINDS: readonly SeedKind[] = ['probe', 'example', 'completion', 'contrast', 'traceback'];
const words = (s: string | undefined) => (s ?? '').trim().split(/\s+/).filter(Boolean).length;
const lineCount = (s: string) => s.replace(/\n+$/, '').split('\n').length;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export interface PreparedTemplate {
  t: SeedTemplate;
  /** Usable at all (structure, tag, slots, holes and kind rules are sound). */
  ok: boolean;
  /** Everything wrong with it, including dropped transforms and word-limit overruns. */
  problems: string[];
  /** Indexes into t.transforms of the transforms that apply. */
  transforms: number[];
  themeNames: string[];
  /** Parsed derive expressions by slot name. */
  derive: Record<string, Ast>;
}

/** Validate a template statically (no running). `lang` also checks the tag and misconceptions cover it. */
export function prepareTemplate(t: SeedTemplate, lang?: Lang): PreparedTemplate {
  const problems: string[] = [];
  const p: PreparedTemplate = { t, ok: false, problems, transforms: [], themeNames: [], derive: {} };
  let fatal = false;
  /** A problem that makes the template unusable. */
  const bad = (msg: string) => {
    fatal = true;
    problems.push(`${t?.id ?? '?'}: ${msg}`);
  };
  /** Reported (verify-seeds fails on it), but the template still runs. */
  const warn = (msg: string) => problems.push(`${t?.id ?? '?'}: ${msg}`);
  if (!isObj(t)) {
    problems.push('template is not an object');
    return p;
  }
  if (typeof t.id !== 'string' || !t.id || /[#~\s]/.test(t.id)) bad("id must be a non-empty string without '#', '~' or spaces");
  if (typeof t.family !== 'string' || !t.family || t.family.includes(':')) bad("family must be a non-empty string without ':'");
  if (!KINDS.includes(t.kind)) bad(`unknown kind '${String(t.kind)}'`);
  if (typeof t.code !== 'string' || !t.code.trim()) bad('code is empty');
  if (!isObj(t.slots)) bad('slots must be an object');
  if (!isObj(t.themes)) bad('themes must be an object');
  if (!Array.isArray(t.transforms)) bad('transforms must be an array');
  if (typeof t.parSec !== 'number' || !(t.parSec > 0)) bad('parSec must be a positive number');
  const info = typeof t.tag === 'string' ? tagInfo(t.tag) : undefined;
  if (!info || t.tag === OTHER_TAG) bad(`unknown or non-canonical tag '${String(t.tag)}'`);
  else if (lang && !info.langs.includes(lang)) bad(`tag ${t.tag} does not apply to ${lang}`);
  if (fatal) return p;

  // Slots, in declaration order.
  const kinds: Record<string, 'num' | 'list' | 'str'> = {};
  const minLens: Record<string, number> = {};
  for (const [name, spec] of Object.entries(t.slots)) {
    const s = spec as SlotSpec;
    const intOk = (...xs: unknown[]) => xs.every((x) => Number.isSafeInteger(x));
    if (!/^[A-Za-z_]\w*$/.test(name)) bad(`slot name '${name}' is not an identifier`);
    switch (s?.gen) {
      case 'int':
        if (!intOk(s.min, s.max) || s.min > s.max) bad(`slot ${name}: needs integers min <= max`);
        else if (s.max - s.min <= 100_000 && intRange(s.min, s.max).every((x) => (s.notIn ?? []).includes(x))) bad(`slot ${name}: notIn excludes every value`);
        kinds[name] = 'num';
        break;
      case 'intList':
        if (!intOk(s.min, s.max, s.minLen, s.maxLen) || s.min > s.max || s.minLen < 0 || s.minLen > s.maxLen) bad(`slot ${name}: bad intList bounds`);
        else if (s.distinct && s.maxLen > s.max - s.min + 1) bad(`slot ${name}: maxLen exceeds the distinct values available`);
        kinds[name] = 'list';
        minLens[name] = s.minLen;
        break;
      case 'wordList':
        if (!(s.pool in WORD_POOLS)) bad(`slot ${name}: unknown pool '${s.pool}'`);
        else if (!intOk(s.minLen, s.maxLen) || s.minLen < 0 || s.minLen > s.maxLen) bad(`slot ${name}: bad wordList bounds`);
        else if (s.distinct && s.maxLen > WORD_POOLS[s.pool].length) bad(`slot ${name}: maxLen exceeds the pool`);
        kinds[name] = 'list';
        minLens[name] = s.minLen;
        break;
      case 'index':
        if (kinds[s.of] !== 'list') bad(`slot ${name}: 'of' must name an earlier list slot`);
        else if (!(minLens[s.of] >= 1)) bad(`slot ${name}: list ${s.of} may be empty`);
        if (s.offset !== undefined && !intOk(s.offset)) bad(`slot ${name}: offset must be an integer`);
        kinds[name] = 'num';
        break;
      case 'pick':
        if (!Array.isArray(s.options) || !s.options.length) bad(`slot ${name}: pick needs options`);
        else if (s.options.some((o) => (typeof o !== 'string' && typeof o !== 'number') || String(o).includes('\n'))) bad(`slot ${name}: options must be one-line strings or numbers`);
        kinds[name] = Array.isArray(s.options) && s.options.every((o) => typeof o === 'number') ? 'num' : 'str';
        break;
      case 'word':
        if (!(s.pool in WORD_POOLS)) bad(`slot ${name}: unknown pool '${s.pool}'`);
        kinds[name] = 'str';
        break;
      case 'derive':
        try {
          const ast = parseDerive(String(s.expr));
          for (const ref of deriveNames(ast)) if (!(ref in kinds)) bad(`slot ${name}: derive uses unknown or later slot '${ref}'`);
          p.derive[name] = ast;
        } catch (e) {
          bad(`slot ${name}: ${(e as Error).message}`);
        }
        kinds[name] = 'num';
        break;
      default:
        bad(`slot ${name}: unknown generator '${String((s as { gen?: unknown })?.gen)}'`);
    }
  }

  // Themes: every theme defines every {{@var}} used anywhere.
  p.themeNames = Object.keys(t.themes);
  const texts: (string | undefined)[] = [t.code, t.contrastCode, t.harness, t.rule, ...(t.solutions ?? []),
    ...(t.wrongFills ?? []).map((w) => w?.fill), ...(t.subgoals ?? []).map((s) => s?.label)];
  for (const tr of t.transforms) texts.push(tr?.find, tr?.replace, tr?.belief, tr?.refutation, tr?.rule);
  const usedSlots = new Set<string>();
  const usedVars = new Set<string>();
  for (const x of texts) {
    if (typeof x !== 'string') continue;
    const h = holesIn(x);
    h.slots.forEach((s) => usedSlots.add(s));
    h.vars.forEach((v) => usedVars.add(v));
  }
  for (const s of usedSlots) if (!(s in kinds)) bad(`{{${s}}} is not a slot`);
  if (usedVars.size && !p.themeNames.length) bad('uses {{@...}} theme variables but has no themes');
  for (const [name, vars] of Object.entries(t.themes)) {
    if (!isObj(vars)) {
      bad(`theme ${name} must map variables to identifiers`);
      continue;
    }
    for (const v of usedVars) {
      if (typeof vars[v] !== 'string' || !vars[v] || String(vars[v]).includes('\n')) bad(`theme ${name} lacks {{@${v}}}`);
    }
  }

  // Kind rules.
  const lines = lineCount(t.code);
  const tagHas = (id: string) => {
    const m = findMisconception(t.tag, id);
    return !!m && (!lang || !m.langs || m.langs.includes(lang));
  };
  if (t.kind !== 'probe' && t.transforms.length) warn('transforms are only used by probe templates; ignored');
  if (t.kind === 'probe') {
    if (lines > 8) bad(`probe code has ${lines} lines (max 8)`);
    if (t.parSec < 3 || t.parSec > 8) warn(`probe parSec ${t.parSec} outside 3-8`);
  } else if (t.kind === 'example') {
    if (lines < 5 || lines > 8) warn(`example has ${lines} lines (5-8)`);
    if (!Array.isArray(t.subgoals) || !t.subgoals.length) bad('example needs subgoals');
    for (const s of t.subgoals ?? []) {
      if (!Number.isInteger(s?.line) || s.line < 1 || s.line > lines) bad(`subgoal line ${s?.line} outside the code`);
      if (words(s?.label) > 6) warn(`subgoal label over 6 words: '${s?.label}'`);
    }
  } else if (t.kind === 'completion') {
    const blanks = [...t.code.matchAll(BLANK)].map((m) => Number(m[1]));
    const k = Array.isArray(t.solutions) ? t.solutions.length : 0;
    if (k < 1 || k > 2) bad('completion needs 1-2 solutions');
    else if (blanks.length !== k || blanks.slice().sort().some((b, i) => b !== i + 1)) bad(`blanks must be [[1]]..[[${k}]], each exactly once`);
    if (lines < 6 || lines > 10) warn(`completion has ${lines} lines (6-10)`);
    if (!/\bdef\s|\bfunction\b|=>/.test(t.code)) bad('completion code must put the pattern inside a function');
    if (t.parSec < 20 || t.parSec > 40) warn(`completion parSec ${t.parSec} outside 20-40`);
    // Holes stand in as plain names / numbers so call shapes are visible: {{@fn}}([{{a}}]) -> fn([1]).
    const h = harnessChecks((t.harness ?? '').replace(HOLE, (_, at: string, name: string) => (at ? name : '1')));
    if (h.calls < 2) bad('harness needs at least 2 check(...) calls');
    if (!h.expected.length) bad("harness needs check(f(...) == expected, 'msg') calls (for the constant-fill test)");
    for (const w of t.wrongFills ?? []) {
      if (!Number.isInteger(w?.blank) || w.blank < 1 || w.blank > k) bad(`wrongFill blank ${w?.blank} does not exist`);
      if (typeof w?.fill !== 'string' || w.fill.includes('\n')) bad('wrongFill fill must be one line');
      if (!tagHas(w?.misconceptionId)) bad(`wrongFill misconception '${w?.misconceptionId}' is not a ${t.tag} misconception${lang ? ` for ${lang}` : ''}`);
    }
    for (const s of t.solutions ?? []) if (typeof s !== 'string' || s.includes('\n')) bad('solutions must be one-line strings');
  } else if (t.kind === 'contrast') {
    if (typeof t.contrastCode !== 'string' || !t.contrastCode.trim()) bad('contrast needs contrastCode');
    else if (lines > 4 || lineCount(t.contrastCode) > 4) bad('contrast snippets must be 4 lines or fewer');
    if (!t.misconceptionId || !tagHas(t.misconceptionId)) bad(`contrast misconception '${t.misconceptionId}' is not a ${t.tag} misconception${lang ? ` for ${lang}` : ''}`);
    if (!t.rule?.trim()) bad('contrast needs a rule');
    else if (words(t.rule) > 12) warn('contrast rule over 12 words');
  } else if (t.kind === 'traceback') {
    if (lines > 8) bad(`traceback code has ${lines} lines (max 8)`);
  }

  // Transforms (probes only): a transform that does not apply is dropped; the template stays usable.
  if (t.kind === 'probe') {
    t.transforms.forEach((tr, i) => {
      const where = `transform ${i} (${tr?.misconceptionId})`;
      if (!isObj(tr) || typeof tr.find !== 'string' || typeof tr.replace !== 'string') {
        warn(`${where}: needs find and replace strings; dropped`);
        return;
      }
      if (!tagHas(tr.misconceptionId)) {
        warn(`${where}: not a ${t.tag} misconception${lang ? ` for ${lang}` : ''}; dropped`);
        return;
      }
      if (tr.find.includes('\n') || tr.replace.includes('\n')) {
        warn(`${where}: find and replace must be on one line; dropped`);
        return;
      }
      const n = countOccurrences(t.code, tr.find);
      if (n !== 1) {
        warn(`${where}: find occurs ${n} times in the template (must be exactly once); dropped`);
        return;
      }
      if (tr.find === tr.replace) {
        warn(`${where}: replace equals find; dropped`);
        return;
      }
      if (!tr.belief?.trim() || words(tr.belief) > 12) warn(`${where}: belief must be 1-12 words`);
      if (words(tr.refutation) > 25) warn(`${where}: refutation over 25 words`);
      if (words(tr.rule) > 12) warn(`${where}: rule over 12 words`);
      p.transforms.push(i);
    });
    if (!p.transforms.length) bad('probe needs at least 1 applicable transform');
    if (p.transforms.length > 3) {
      warn('probe has more than 3 transforms; only the first 3 are used');
      p.transforms = p.transforms.slice(0, 3);
    }
  }
  p.ok = !fatal;
  return p;
}

/** Check a parsed seed file: shape, templates and pattern cards. Never throws on bad content. */
export function parseSeedBank(json: unknown, lang?: Lang): { bank: SeedBank; problems: string[] } {
  const problems: string[] = [];
  if (!isObj(json) || !Array.isArray(json.templates)) {
    return { bank: { lang: lang ?? 'python', templates: [] }, problems: ['seed file must be { lang, templates: [...] }'] };
  }
  const bank = json as unknown as SeedBank;
  if (lang && bank.lang !== lang) problems.push(`seed file is for ${bank.lang}, expected ${lang}`);
  const ids = new Set<string>();
  const effLang = bank.lang === 'neutral' ? undefined : bank.lang;
  for (const t of bank.templates) {
    if (ids.has(t?.id)) problems.push(`duplicate template id ${t.id}`);
    ids.add(t?.id);
    problems.push(...prepareTemplate(t, effLang).problems);
  }
  for (const [tag, pat] of Object.entries(bank.patterns ?? {})) {
    const info = tagInfo(tag);
    if (!info) {
      problems.push(`pattern for unknown tag ${tag}`);
      continue;
    }
    if (!isObj(pat)) {
      problems.push(`pattern ${tag} is not an object`);
      continue;
    }
    if (pat.kind !== info.kind) problems.push(`pattern ${tag}: kind must be ${info.kind}`);
    if ((pat.useCases ?? []).length < 6) problems.push(`pattern ${tag}: needs 6+ useCases`);
    if ((pat.useCases ?? []).some((u) => words(u) > 12)) problems.push(`pattern ${tag}: useCases are <= 12 words`);
    if (info.kind === 'semantics' && (words(pat.rule) > 12 || words(pat.howItRuns) > 20 || !pat.rule)) {
      problems.push(`pattern ${tag}: semantics needs rule <= 12 words and howItRuns <= 20`);
    }
    if (info.kind === 'shape' && (!pat.template?.trim() || lineCount(pat.template) > 3)) problems.push(`pattern ${tag}: shape needs a template of 1-3 lines`);
    if (words(pat.useWhen) > 12 || words(pat.pitfall) > 12) problems.push(`pattern ${tag}: useWhen and pitfall are <= 12 words`);
  }
  for (const t of bank.templates) {
    if (t?.tag && !bank.patterns?.[t.tag]) {
      problems.push(`no pattern card for tag ${t.tag}`);
      if (!bank.patterns) bank.patterns = {};
      bank.patterns[t.tag] = seedPattern(t.tag); // keep going with the minimal card
    }
  }
  return { bank, problems: [...new Set(problems)] };
}

/** The tag's pattern card, renamed to the canonical patternName (a minimal card when the bank has none). */
export function seedPattern(tag: string, bank?: SeedBank): AtomPattern {
  const info = tagInfo(tag);
  const name = info?.patternName ?? tag;
  const card = bank?.patterns?.[tag];
  if (card) return { ...card, name };
  return {
    kind: info?.kind ?? 'shape', name, useWhen: '', template: info?.kind === 'semantics' ? '' : info?.example ?? '',
    rule: '', howItRuns: '', pitfall: '', useCases: [],
  };
}

// =====================================================================================================
// Item freshness
// =====================================================================================================

/** True when the item was shown within the last 7 days (an exact item never repeats within 7 days). */
export function seenWithin7Days(stats: { readonly seenAt: readonly number[] } | undefined, now: number): boolean {
  return !!stats?.seenAt.some((t) => t <= now && now - t < REPEAT_WINDOW_MS);
}

/** Template id of an instance, mutant or batch item id. */
export function templateIdOf(itemId: string): string {
  return itemId.split('#')[0];
}

export const emptyStats = (): ItemStats => ({ seenAt: [], n: 0, nCorrect: 0 });

// =====================================================================================================
// Comparison adapter (src/compare.ts) and local item metadata
// =====================================================================================================

const normText = (s: string) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '');

/**
 * Strict comparison of two recorded outputs: could any typed answer tell them apart?
 * Same exception and either the same text or the same typed values (order-free sets and dicts).
 */
export function sameOutput(a: RecordedOutput, b: RecordedOutput): boolean {
  if ((a.exception ?? '') !== (b.exception ?? '')) return false;
  if (normText(a.stdout) === normText(b.stdout)) return true;
  // Different text can still be the same answer: {1, 2} vs {2, 1}. Only typed values can say so.
  if (!a.values.length || a.values.length !== b.values.length || outputLines(a).length !== outputLines(b).length) return false;
  return a.values.every((call, i) => call.length === b.values[i].length
    && call.every((arg, j) => valEquals(arg.val, b.values[i][j].val, { strict: true })));
}

/** Printed lines of an output (CRLF normalised, trailing newlines dropped). */
export function outputLines(out: RecordedOutput): string[] {
  const text = out.stdout.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return text ? text.split('\n') : [];
}

/** The RecordedOutput of a batch record (the exception only when the run raised). */
export function recordOutput(r: BatchRecord): RecordedOutput {
  return r.exception && !r.exitOk
    ? { stdout: r.stdout, values: r.values ?? [], exception: r.exception }
    : { stdout: r.stdout, values: r.values ?? [] };
}

/** A syntax error is never a legitimate output: the template (or a transform) is broken. */
export function isParseError(r: BatchRecord, lang: Lang): boolean {
  if (r.exitOk || !r.exception) return false;
  if (lang === 'python') return /^(SyntaxError|IndentationError|TabError)$/.test(r.exception);
  return r.exception === 'SyntaxError' && !/JSON/.test(r.error ?? '');
}

/** Ran to completion or raised a real exception (not a timeout, denial, crash or syntax error). */
export function ranOk(r: BatchRecord | undefined, lang: Lang): boolean {
  return !!r && !r.denied && !r.timedOut && (r.exitOk || (!!r.exception && !isParseError(r, lang)));
}

/** Ran to completion with exit 0 (examples, completion solutions). */
export const passes = (r: BatchRecord | undefined): boolean => !!r && !r.denied && !r.timedOut && r.exitOk;

// =====================================================================================================
// Traceback items (built by src/atoms/traceback.ts buildTracebackParts unless a hook replaces it)
// =====================================================================================================

export interface TracebackParts {
  trace: string;
  line: number;
  exception: string;
  meanings: string[];
  /** 0-based index into meanings. */
  correctMeaning: number;
}
export type TracebackBuilder = (code: string, record: BatchRecord, lang: Lang, rng: Rng) => TracebackParts | undefined;

// =====================================================================================================
// Instantiator
// =====================================================================================================

export interface SeedPieces {
  probes: StoredProbe[];
  examples: StoredExample[];
  completions: StoredCompletion[];
  contrasts: StoredContrast[];
  tracebacks: TracebackItem[];
}

export const emptyPieces = (): SeedPieces => ({ probes: [], examples: [], completions: [], contrasts: [], tracebacks: [] });

export interface TemplateReport {
  templateId: string;
  tag: string;
  kind: SeedKind;
  requested: number;
  /** Instances drawn (valid + invalid, slot errors included). */
  drawn: number;
  valid: number;
  rounds: number;
  /** Ran out of distinct slot values before reaching `requested`. */
  exhausted: boolean;
  /** Invalid draws by reason. */
  rejected: Record<string, number>;
  /**
   * One per template transform: did it apply, how often its mutant ran, printed something new, and
   * printed something an answer can name (not within one edit of the original: compareOutput's slip rule).
   */
  transforms: { misconceptionId: string; applies: boolean; ran: number; changed: number; attributable: number }[];
  /** Completion wrongFills that passed for some instance and were dropped there. */
  droppedWrongFills: number;
  problems: string[];
}

export interface InstantiateResult {
  /** Verified pieces by tag, in draw order. */
  byTag: Record<string, SeedPieces>;
  reports: TemplateReport[];
}

export interface InstantiateOptions {
  /** RNG seed for this call (default: derived from the instantiator seed and a call counter). */
  seed?: number;
  /** Instance ids never to produce (seen within 7 days, or already stocked). */
  exclude?: Iterable<string>;
  /** Draw rounds including the first (default 3): how many times invalid draws are redrawn. */
  maxRounds?: number;
  signal?: AbortSignal;
  itemTimeoutMs?: number;
}

export interface InstantiatorHooks {
  /** Strict output comparison (default sameOutput, built on compare.ts valEquals). */
  sameOutput?: (a: RecordedOutput, b: RecordedOutput) => boolean;
  buildTraceback?: TracebackBuilder;
  answerSpaceG?: (out: RecordedOutput) => number;
  /** Can an answer name this mutant (default compare.ts mutantAttributable: not a probable slip)? */
  attributable?: (mutant: RecordedOutput, out: RecordedOutput, lang: Lang) => boolean;
}

interface Instance {
  id: string;
  theme: string;
  group: string;
  texts: Record<string, string>;
  vars: Record<string, string>;
}

interface PlanItem {
  role: string;
  code: string;
  trace?: boolean;
}

interface Plan {
  s: TemplateState;
  inst: Instance;
  code: string;
  items: PlanItem[];
  /** Built in pass A, accepted after pass B. */
  piece?: () => void;
}

interface TemplateState {
  p: PreparedTemplate;
  rng: Rng;
  report: TemplateReport;
  exhausted: boolean;
}

export class Instantiator {
  private calls = 0;
  private readonly same: (a: RecordedOutput, b: RecordedOutput) => boolean;
  private readonly traceback: TracebackBuilder;
  private readonly spaceG: (out: RecordedOutput) => number;
  private readonly canName: (mutant: RecordedOutput, out: RecordedOutput, lang: Lang) => boolean;

  constructor(private readonly runner: Runner, private readonly seed = 1, hooks: InstantiatorHooks = {}) {
    this.same = hooks.sameOutput ?? sameOutput;
    this.traceback = hooks.buildTraceback ?? buildTracebackParts;
    this.spaceG = hooks.answerSpaceG ?? answerSpaceG;
    this.canName = hooks.attributable ?? mutantAttributable;
  }

  private attributable(mutant: RecordedOutput, out: RecordedOutput): boolean {
    return this.canName(mutant, out, this.lang);
  }

  get lang(): Lang {
    return this.runner.runtime.lang;
  }

  /**
   * Draw up to n valid instances of each template. All instances and their mutants of a round run in
   * ONE runBatch call, then once more with another hash seed to reject nondeterminism; invalid draws
   * are redrawn up to maxRounds - 1 times.
   */
  async instantiate(templates: readonly SeedTemplate[], n: number, opts: InstantiateOptions = {}): Promise<InstantiateResult> {
    const lang = this.lang;
    const callSeed = opts.seed ?? hash53(`${this.seed}:${this.calls++}`) % 4294967296;
    const seen = new Set(opts.exclude ?? []);
    const byTag: Record<string, SeedPieces> = {};
    const states: TemplateState[] = [];
    const reports: TemplateReport[] = [];
    const ids = new Set<string>();
    for (const t of templates) {
      const p = prepareTemplate(t, lang);
      if (ids.has(t.id)) {
        p.ok = false;
        p.problems.push(`${t.id}: duplicate template id; skipped`);
      }
      ids.add(t.id);
      const report: TemplateReport = {
        templateId: t.id, tag: t.tag, kind: t.kind, requested: n, drawn: 0, valid: 0, rounds: 0, exhausted: false,
        rejected: {}, droppedWrongFills: 0, problems: p.problems,
        transforms: (t.transforms ?? []).map((tr, i) => ({ misconceptionId: tr?.misconceptionId, applies: p.transforms.includes(i), ran: 0, changed: 0, attributable: 0 })),
      };
      reports.push(report);
      if (p.ok) states.push({ p, rng: new Rng(hash53(`${callSeed}:${t.id}`) % 4294967296), report, exhausted: false });
    }
    const maxRounds = Math.max(1, opts.maxRounds ?? DEFAULT_ROUNDS);
    for (let round = 1; round <= maxRounds; round++) {
      const plans: Plan[] = [];
      let drew = false;
      for (const s of states) {
        const need = n - s.report.valid;
        if (need <= 0 || s.exhausted) continue;
        const drawnBefore = s.report.drawn;
        for (let k = 0; k < need && !s.exhausted; k++) {
          const inst = this.draw(s, seen);
          if (!inst) continue;
          try {
            plans.push(this.plan(s, inst));
          } catch (e) {
            if (!(e instanceof SlotError)) throw e;
            this.reject(s, 'slot-error');
          }
        }
        if (s.report.drawn > drawnBefore) {
          s.report.rounds = round;
          drew = true;
        }
      }
      if (!drew) break;
      if (plans.length) await this.runRound(plans, byTag, opts);
    }
    return { byTag, reports };
  }

  private reject(s: TemplateState, reason: string): void {
    s.report.rejected[reason] = (s.report.rejected[reason] ?? 0) + 1;
  }

  /** Draw a fresh instance (an id not seen before). Slot errors count as invalid draws. */
  private draw(s: TemplateState, seen: Set<string>): Instance | undefined {
    const t = s.p.t;
    for (let tries = 0; tries < DRAW_TRIES; tries++) {
      const theme = s.p.themeNames.length ? s.rng.pick(s.p.themeNames) : 'plain';
      const values: Record<string, SlotValue> = {};
      const texts: Record<string, string> = {};
      try {
        for (const [name, spec] of Object.entries(t.slots)) {
          [values[name], texts[name]] = drawSlot(spec, s.rng, values, s.p.derive[name]);
        }
      } catch (e) {
        if (!(e instanceof SlotError)) throw e;
        s.report.drawn++;
        this.reject(s, 'slot-error');
        return undefined;
      }
      const key = [theme, ...Object.keys(texts).map((k) => `${k}=${texts[k]}`)].join('\u0000');
      const id = `${t.id}#${hash53(key).toString(36)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      s.report.drawn++;
      return { id, theme, group: `${t.family}:${theme}`, texts, vars: t.themes[theme] ?? {} };
    }
    s.exhausted = true;
    s.report.exhausted = true;
    return undefined;
  }

  /** Fill the template and list the batch items this instance needs. */
  private plan(s: TemplateState, inst: Instance): Plan {
    const t = s.p.t;
    const fill = (x: string) => fillHoles(x, inst.texts, inst.vars);
    const code = fill(t.code);
    const items: PlanItem[] = [];
    switch (t.kind) {
      case 'probe': {
        const trace = this.lang === 'python' && !!tagInfo(t.tag)?.stateTrace;
        items.push({ role: 'orig', code, trace });
        for (const i of s.p.transforms) {
          const tr = t.transforms[i];
          items.push({ role: `m${i}`, code: fill(applyTransform(t.code, tr.find, tr.replace)!) });
        }
        break;
      }
      case 'example':
      case 'traceback':
        items.push({ role: 'run', code });
        break;
      case 'contrast':
        items.push({ role: 'wrong', code }, { role: 'right', code: fill(t.contrastCode!) });
        break;
      case 'completion': {
        const sols = t.solutions!.map(fill);
        const harness = fill(t.harness ?? '');
        const run = (fills: string[]) => `${fillBlanks(code, fills)}\n${harness}\n`;
        items.push({ role: 'sol', code: run(sols) }, { role: 'empty', code: run(sols.map(() => '')) });
        (t.wrongFills ?? []).forEach((w, i) => {
          const fills = sols.slice();
          fills[w.blank - 1] = fill(w.fill);
          items.push({ role: `wf${i}`, code: run(fills) });
        });
        harnessChecks(harness).expected.slice(0, 4).forEach((e, i) => {
          sols.forEach((_, b) => {
            const fills = sols.slice();
            fills[b] = e;
            items.push({ role: `const${i}b${b}`, code: run(fills) });
          });
        });
        break;
      }
    }
    return { s, inst, code, items };
  }

  private async runRound(plans: Plan[], byTag: Record<string, SeedPieces>, opts: InstantiateOptions): Promise<void> {
    const batch = (ps: Plan[], trace: boolean): BatchItem[] => ps.flatMap((p) => p.items.map((it) => {
      const item: BatchItem = { id: `${p.inst.id}~${it.role}`, code: it.code };
      if (trace && it.trace) item.wantTrace = true;
      return item;
    }));
    // The tags' extra imports ride along for LocalRunner's allowlist (LocalBatchOptions.allowImports).
    const allowImports = [...new Set(plans.flatMap((p) => tagInfo(p.s.p.t.tag)?.allowedImports ?? []))];
    const run = async (ps: Plan[], pass: 0 | 1) => {
      const o: BatchOptions & { allowImports?: string[] } = { hashSeed: PASS_SEEDS[pass], signal: opts.signal, itemTimeoutMs: opts.itemTimeoutMs };
      if (allowImports.length) o.allowImports = allowImports;
      const recs = await this.runner.runBatch(batch(ps, pass === 0), o);
      return new Map(recs.map((r) => [r.id, r]));
    };
    const a = await run(plans, 0);
    const survivors = plans.filter((p) => {
      const reason = this.evaluate(p, a, byTag);
      if (reason) this.reject(p.s, reason);
      return !reason;
    });
    if (!survivors.length) return;
    const b = await run(survivors, 1);
    for (const p of survivors) {
      const steady = p.items.every((it) => {
        const id = `${p.inst.id}~${it.role}`;
        const x = a.get(id);
        const y = b.get(id);
        return !!x && !!y && x.exitOk === y.exitOk && x.timedOut === y.timedOut && (x.exception ?? '') === (y.exception ?? '')
          && x.stdout.replace(/\r\n/g, '\n') === y.stdout.replace(/\r\n/g, '\n');
      });
      if (!steady) {
        this.reject(p.s, 'nondeterministic');
        continue;
      }
      p.piece!();
      p.s.report.valid++;
    }
  }

  /** Judge one instance on pass A. Returns a rejection reason, or '' and sets plan.piece. */
  private evaluate(p: Plan, recs: Map<string, BatchRecord>, byTag: Record<string, SeedPieces>): string {
    const { s, inst, code } = p;
    const t = s.p.t;
    const lang = this.lang;
    const rec = (role: string) => recs.get(`${inst.id}~${role}`);
    if (p.items.some((it) => !recs.has(`${inst.id}~${it.role}`))) return 'missing-record';
    const denied = p.items.find((it) => rec(it.role)?.denied);
    if (denied) {
      const msg = `${t.id}: denied by the allowlist: ${rec(denied.role)!.denied}`;
      if (!s.report.problems.includes(msg)) s.report.problems.push(msg);
      return 'denied';
    }
    const pieces = () => (byTag[t.tag] ??= emptyPieces());
    const fill = (x: string) => fillHoles(x, inst.texts, inst.vars);

    switch (t.kind) {
      case 'probe': {
        const o = rec('orig')!;
        if (o.timedOut) return 'timeout';
        if (!ranOk(o, lang)) return 'crash';
        const out = recordOutput(o);
        const lines = outputLines(out).length + (out.exception ? 1 : 0);
        if (lines < 1 || lines > 4 || normText(out.stdout).length > 200) return 'output-size';
        const mutants: StoredMutant[] = [];
        let failed = '';
        for (const i of s.p.transforms) {
          const tr = t.transforms[i];
          const stat = s.report.transforms[i];
          const r = rec(`m${i}`)!;
          if (!ranOk(r, lang)) {
            failed ||= 'mutant-failed';
            continue;
          }
          stat.ran++;
          const mOut = recordOutput(r);
          if (this.same(mOut, out)) {
            failed ||= 'mutant-same-as-original';
            continue;
          }
          stat.changed++;
          // A mutant within one edit of the original can never name its belief (a probable slip).
          if (!this.attributable(mOut, out)) {
            failed ||= 'mutant-slip';
            continue;
          }
          stat.attributable++;
          const mCode = p.items.find((it) => it.role === `m${i}`)!.code;
          const diffLine = singleDiffLine(code, mCode);
          if (diffLine === undefined) {
            failed ||= 'diff-not-one-line';
            continue;
          }
          const base = `${inst.id}~${tr.misconceptionId}`;
          mutants.push({
            id: mutants.some((m) => m.id === base) ? `${base}-${i}` : base,
            misconceptionId: tr.misconceptionId, belief: fill(tr.belief), refutation: fill(tr.refutation), rule: fill(tr.rule),
            code: mCode, output: mOut, diffLine, source: 'curated', ambiguous: false, matches: 0, confirmations: 0, rejections: 0,
          });
        }
        if (failed) return failed;
        for (let x = 0; x < mutants.length; x++) {
          for (let y = x + 1; y < mutants.length; y++) if (this.same(mutants[x].output, mutants[y].output)) return 'mutants-equal';
        }
        const probe: StoredProbe = {
          id: inst.id, group: inst.group, code, output: out, parSec: t.parSec, answerSpaceG: this.spaceG(out),
          constructs: o.constructs ?? [], discriminating: mutants.length > 0, mutants, stats: emptyStats(),
        };
        if (o.trace?.length) probe.trace = o.trace;
        if (out.exception) probe.raises = true;
        p.piece = () => pieces().probes.push(probe);
        return '';
      }
      case 'example': {
        const r = rec('run')!;
        if (r.timedOut) return 'timeout';
        if (!passes(r)) return 'crash';
        if (!normText(r.stdout)) return 'no-output';
        const ex: StoredExample = {
          id: inst.id, group: inst.group, code, output: recordOutput(r),
          subgoals: (t.subgoals ?? []).map((g) => ({ line: g.line, label: fill(g.label) })),
        };
        p.piece = () => pieces().examples.push(ex);
        return '';
      }
      case 'completion': {
        if (!passes(rec('sol'))) return 'solution-fails';
        if (passes(rec('empty'))) return 'empty-passes';
        if (p.items.some((it) => it.role.startsWith('const') && passes(rec(it.role)))) return 'constant-passes';
        const wrongFills = (t.wrongFills ?? []).filter((_, i) => !passes(rec(`wf${i}`)));
        const dropped = (t.wrongFills ?? []).length - wrongFills.length;
        const comp: StoredCompletion = {
          id: inst.id, group: inst.group, code, solutions: t.solutions!.map(fill),
          wrongFills: wrongFills.map((w) => ({ blank: w.blank, fill: fill(w.fill), misconceptionId: w.misconceptionId })),
          harness: fill(t.harness ?? ''), parSec: t.parSec, stats: emptyStats(),
        };
        p.piece = () => {
          s.report.droppedWrongFills += dropped;
          pieces().completions.push(comp);
        };
        return '';
      }
      case 'contrast': {
        const w = rec('wrong')!;
        const r = rec('right')!;
        if (w.timedOut || r.timedOut) return 'timeout';
        if (!ranOk(w, lang) || !ranOk(r, lang)) return 'crash';
        if (this.same(recordOutput(w), recordOutput(r))) return 'contrast-same';
        const c: StoredContrast = {
          id: inst.id, wrong: code, right: p.items[1].code, wrongOutput: recordOutput(w), rightOutput: recordOutput(r),
          misconceptionId: t.misconceptionId!, rule: fill(t.rule ?? ''),
        };
        p.piece = () => pieces().contrasts.push(c);
        return '';
      }
      case 'traceback': {
        const r = rec('run')!;
        if (r.timedOut) return 'timeout';
        if (r.exitOk) return 'no-exception';
        const parts = this.traceback(code, r, lang, new Rng(hash53(inst.id) % 4294967296));
        if (!parts) return 'no-trace';
        const item: TracebackItem = { id: inst.id, code, ...parts, siblingGroup: inst.group, conceptId: t.tag };
        p.piece = () => pieces().tracebacks.push(item);
        return '';
      }
    }
  }
}

/** Assemble a seed StoredAtom for one tag (key and concept id are the tag). */
export function seedAtom(tag: string, lang: Lang, pieces: SeedPieces, bank: SeedBank | undefined, now: number): StoredAtom {
  return {
    key: tag, lang, conceptId: tag, tag, source: 'seed', verified: true, createdAt: now,
    pattern: seedPattern(tag, bank), ...pieces,
  };
}
