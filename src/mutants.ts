// What-if mutants on the learner's own lines (spec V1-12 B). Pure: no vscode import.
// - The local operator table per language family, each operator mapped to a canonical tag and the
//   misconception it probes.
// - applyOperator(lineText, op, lang): the mutated line, or null when the operator does not apply.
//   Strings, comments (and JS regex literals) are masked first, so nothing inside them is mutated.
// - Candidate selection prefers the task's weakest concept's tag, then mistakes in the journal.
// - Attribution: a wrong answer counts toward the operator's misconception only when it equals the
//   unmutated output or the alternative operator's output; any other wrong answer is weight .5.

import type { Lang, RecordedOutput, VerdictKind } from './contracts';
import { compareOutput } from './compare';
import { TAXONOMY } from './atoms/tags';

export type LangFamily = 'python' | 'js';

export const familyOf = (lang: Lang | string): LangFamily => (lang === 'python' ? 'python' : 'js');

export type MutantOpId =
  | 'lt-to-le' | 'le-to-lt' | 'gt-to-ge' | 'ge-to-gt'
  | 'bound-plus-1' | 'bound-minus-1'
  | 'drop-return'
  | 'and-to-or' | 'or-to-and'
  | 'drop-copy'
  | 'augadd-to-assign'
  | 'drop-await'
  | 'eq-to-is';

export interface MutantOp {
  id: MutantOpId;
  /** Canonical tag the operator probes (src/atoms/tags.ts). */
  tag: string;
  /** The taxonomy misconception a wrong answer is attributed to (x3) when attributable. */
  misconceptionId: string;
  families: readonly LangFamily[];
  /** The operator whose output (computed locally) also attributes a wrong answer. */
  alternative?: MutantOpId;
  /** Short description for logs and the hover. */
  label: string;
}

const BOTH: readonly LangFamily[] = ['python', 'js'];

/** In preference order (ties in candidate selection go to the earlier operator). */
export const OPERATORS: readonly MutantOp[] = [
  { id: 'bound-plus-1', tag: 'for-range-bounds', misconceptionId: 'range-includes-end', families: BOTH, alternative: 'bound-minus-1', label: 'loop bound + 1' },
  { id: 'bound-minus-1', tag: 'for-range-bounds', misconceptionId: 'range-includes-end', families: BOTH, alternative: 'bound-plus-1', label: 'loop bound - 1' },
  { id: 'lt-to-le', tag: 'off-by-one', misconceptionId: 'le-visits-each-once', families: BOTH, label: '< becomes <=' },
  { id: 'le-to-lt', tag: 'off-by-one', misconceptionId: 'le-visits-each-once', families: BOTH, label: '<= becomes <' },
  { id: 'gt-to-ge', tag: 'off-by-one', misconceptionId: 'le-visits-each-once', families: BOTH, label: '> becomes >=' },
  { id: 'ge-to-gt', tag: 'off-by-one', misconceptionId: 'le-visits-each-once', families: BOTH, label: '>= becomes >' },
  { id: 'drop-copy', tag: 'alias-copy', misconceptionId: 'assignment-copies', families: BOTH, label: 'copy removed' },
  { id: 'augadd-to-assign', tag: 'loop-accumulator', misconceptionId: 'assign-instead-of-add', families: BOTH, label: '+= becomes =' },
  { id: 'drop-return', tag: 'function-return-vs-print', misconceptionId: 'print-is-return', families: BOTH, label: "'return' removed" },
  { id: 'and-to-or', tag: 'booleans-truthiness', misconceptionId: 'and-or-return-bool', families: BOTH, alternative: 'or-to-and', label: 'and becomes or' },
  { id: 'or-to-and', tag: 'booleans-truthiness', misconceptionId: 'and-or-return-bool', families: BOTH, alternative: 'and-to-or', label: 'or becomes and' },
  { id: 'drop-await', tag: 'await-sequencing', misconceptionId: 'async-returns-value', families: ['js'], label: "'await' removed" },
  { id: 'eq-to-is', tag: 'identity-vs-equality', misconceptionId: 'is-means-equal', families: ['python'], label: '== becomes is' },
];

const BY_ID = new Map(OPERATORS.map((o) => [o.id, o]));

export function operator(id: MutantOpId | MutantOp): MutantOp {
  return typeof id === 'string' ? BY_ID.get(id)! : id;
}

export function operatorsFor(lang: Lang | string): MutantOp[] {
  const f = familyOf(lang);
  return OPERATORS.filter((o) => o.families.includes(f));
}

export function operatorsForTag(tag: string, lang: Lang | string): MutantOp[] {
  return operatorsFor(lang).filter((o) => o.tag === tag);
}

export function tagOfOperator(id: MutantOpId): string {
  return operator(id).tag;
}

/** The tag whose taxonomy lists this misconception id (journal entries -> tags). */
export function tagOfMisconception(id: string): string | undefined {
  for (const e of Object.values(TAXONOMY)) if (e.misconceptions.some((m) => m.id === id)) return e.tag;
  return undefined;
}

// ---------------------------------------------------------------- masking

const MASK = '\u0001';

/**
 * The line with string literals, comments (and JS regex literals) replaced by a mask character,
 * same length, so every index still points into the original line.
 */
export function maskLine(line: string, lang: Lang | string): string {
  const py = familyOf(lang) === 'python';
  const out = line.split('');
  const fill = (a: number, b: number) => {
    for (let k = a; k < b && k < out.length; k++) out[k] = MASK;
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (py && c === '#') {
      fill(i, line.length);
      break;
    }
    if (!py && c === '/' && line[i + 1] === '/') {
      fill(i, line.length);
      break;
    }
    if (!py && c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      const stop = end < 0 ? line.length : end + 2;
      fill(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || (!py && c === '`')) {
      const triple = py && line.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < line.length && !line.startsWith(q, j)) j += line[j] === '\\' ? 2 : 1;
      const stop = Math.min(line.length, j + q.length);
      fill(i, stop);
      i = stop;
      continue;
    }
    if (!py && c === '/' && regexAllowed(line, i)) {
      let j = i + 1;
      let inClass = false;
      while (j < line.length) {
        const d = line[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        j++;
      }
      if (j < line.length) {
        j++;
        while (/[a-z]/i.test(line[j] ?? '')) j++;
        fill(i, j);
        i = j;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

/** A '/' starts a regex literal after an operator, an opening bracket or a keyword (heuristic). */
function regexAllowed(line: string, i: number): boolean {
  const before = line.slice(0, i).trimEnd();
  if (!before) return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(before)) return true;
  return /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(before);
}

// ---------------------------------------------------------------- editing

export interface OperatorEdit {
  /** Span of the original line that changes (for a 'line-through' decoration). */
  start: number;
  end: number;
  replacement: string;
  mutated: string;
}

interface Site {
  start: number;
  end: number;
  replacement: string;
}

/** Index of the bracket closing the one at `open` (in masked text), or -1. */
function closing(m: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < m.length; i++) {
    const c = m[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Split [a, b) of masked text at top-level separators. */
function splitTop(m: string, a: number, b: number, sep: string): [number, number][] {
  const parts: [number, number][] = [];
  let depth = 0;
  let start = a;
  for (let i = a; i < b; i++) {
    const c = m[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && m.startsWith(sep, i)) {
      parts.push([start, i]);
      start = i + sep.length;
    }
  }
  parts.push([start, b]);
  return parts;
}

type Cmp = '<' | '<=' | '>' | '>=';

/** Comparison operators in masked text (shifts, arrows, '->' and TS generics excluded). */
function comparisons(m: string, lang: Lang | string, from = 0, to = m.length): { start: number; end: number; op: Cmp }[] {
  const ts = lang === 'typescript';
  const out: { start: number; end: number; op: Cmp }[] = [];
  for (let i = from; i < to; i++) {
    const c = m[i];
    if (c === '<') {
      if (m[i + 1] === '<' || m[i - 1] === '<') continue;
      if (m[i + 1] === '=') {
        if (m[i + 2] === '>') continue;
        out.push({ start: i, end: i + 2, op: '<=' });
        i++;
        continue;
      }
      if (ts && /[\w$]$/.test(m.slice(0, i)) && /^<[\w$\s,.[\]|<>]*>/.test(m.slice(i))) continue;
      out.push({ start: i, end: i + 1, op: '<' });
    } else if (c === '>') {
      if (m[i - 1] === '-' || m[i - 1] === '=' || m[i - 1] === '>' || m[i + 1] === '>') continue;
      if (m[i + 1] === '=') {
        out.push({ start: i, end: i + 2, op: '>=' });
        i++;
        continue;
      }
      out.push({ start: i, end: i + 1, op: '>' });
    }
  }
  return out;
}

const LOW_PRECEDENCE_WORDS = /\b(?:if|else|and|or|not|lambda|in|is|instanceof|typeof)\b/;

/** Does the expression have a top-level operator binding looser than + ? */
function lowPrecedence(maskedExpr: string): boolean {
  let depth = 0;
  for (let i = 0; i < maskedExpr.length; i++) {
    const c = maskedExpr[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && /[<>=!?:,&|^]/.test(c)) return true;
  }
  const top = maskedExpr.replace(/\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}/g, '');
  return LOW_PRECEDENCE_WORDS.test(top);
}

/** expr + delta, folding 'n - 1' + 1 to 'n' and integer literals; parenthesised when needed. */
export function shiftExpr(text: string, delta: 1 | -1, lang: Lang | string = 'python'): string {
  const t = text.trim();
  if (/^-?\d+$/.test(t)) return String(BigInt(t) + BigInt(delta));
  const fold = (delta === 1 ? /^(.*?)\s*-\s*1$/ : /^(.*?)\s*\+\s*1$/).exec(t);
  if (fold && fold[1] && !lowPrecedence(maskLine(fold[1], lang)) && !/[-+*/%]\s*$/.test(fold[1])) return fold[1];
  const base = lowPrecedence(maskLine(t, lang)) ? `(${t})` : t;
  return `${base} ${delta > 0 ? '+' : '-'} 1`;
}

/** Replace span [a, b) of the line by the shifted expression, keeping surrounding whitespace. */
function shiftSite(line: string, a: number, b: number, delta: 1 | -1, lang: Lang | string): Site | undefined {
  const raw = line.slice(a, b);
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  const start = a + lead;
  const end = b - trail;
  if (end <= start) return undefined;
  return { start, end, replacement: shiftExpr(line.slice(start, end), delta, lang) };
}

function boundSites(line: string, m: string, lang: Lang | string, delta: 1 | -1): Site[] {
  const sites: Site[] = [];
  if (familyOf(lang) === 'python') {
    for (const r of m.matchAll(/(?<![\w.])range\s*\(/g)) {
      const open = r.index! + r[0].length - 1;
      const close = closing(m, open);
      if (close < 0) continue;
      const args = splitTop(m, open + 1, close, ',').filter(([a, b]) => m.slice(a, b).trim());
      if (!args.length || args.length > 3) continue;
      const [a, b] = args.length === 1 ? args[0] : args[1];
      const s = shiftSite(line, a, b, delta, lang);
      if (s) sites.push(s);
    }
    return sites;
  }
  for (const f of m.matchAll(/(?<![\w$.])for\s*\(/g)) {
    const open = f.index! + f[0].length - 1;
    const close = closing(m, open);
    if (close < 0) continue;
    const parts = splitTop(m, open + 1, close, ';');
    if (parts.length !== 3) continue;
    const [ca, cb] = parts[1];
    const cond = m.slice(ca, cb);
    if (/&&|\|\|/.test(cond)) continue;
    const cmp = comparisons(m, lang, ca, cb)[0];
    if (!cmp) continue;
    const s = shiftSite(line, cmp.end, cb, delta, lang);
    if (s) sites.push(s);
  }
  return sites;
}

const CMP_OPS: Record<string, [Cmp, string]> = {
  'lt-to-le': ['<', '<='],
  'le-to-lt': ['<=', '<'],
  'gt-to-ge': ['>', '>='],
  'ge-to-gt': ['>=', '>'],
};

/** Every place the operator applies on the line, left to right. */
function sites(line: string, op: MutantOp, lang: Lang | string): Site[] {
  const fam = familyOf(lang);
  if (!op.families.includes(fam)) return [];
  const m = maskLine(line, lang);
  const py = fam === 'python';
  switch (op.id) {
    case 'lt-to-le':
    case 'le-to-lt':
    case 'gt-to-ge':
    case 'ge-to-gt': {
      const [from, to] = CMP_OPS[op.id];
      return comparisons(m, lang).filter((c) => c.op === from).map((c) => ({ start: c.start, end: c.end, replacement: to }));
    }
    case 'bound-plus-1':
      return boundSites(line, m, lang, 1);
    case 'bound-minus-1':
      return boundSites(line, m, lang, -1);
    case 'drop-return': {
      const r = /^(\s*)return\b/.exec(m);
      if (!r) return [];
      const restStart = r[0].length;
      const rest = m.slice(restStart);
      if (!rest.trim() || /^\s*;?\s*$/.test(rest)) return [];
      // '    return x' -> '    x': the indentation stays, 'return' and its following spaces go.
      const skip = rest.length - rest.trimStart().length;
      return [{ start: r[1].length, end: restStart + skip, replacement: '' }];
    }
    case 'and-to-or':
    case 'or-to-and': {
      const [from, to] = op.id === 'and-to-or' ? (py ? ['and', 'or'] : ['&&', '||']) : py ? ['or', 'and'] : ['||', '&&'];
      const re = py ? new RegExp(`(?<![\\w.])${from}(?![\\w])`, 'g') : new RegExp(`${from.replace(/[|&]/g, '\\$&')}(?!=)`, 'g');
      return [...m.matchAll(re)].map((x) => ({ start: x.index!, end: x.index! + from.length, replacement: to }));
    }
    case 'drop-copy': {
      const found: Site[] = [];
      const add = (re: RegExp, keepGroup: boolean) => {
        for (const x of m.matchAll(re)) {
          const start = x.index!;
          const end = start + x[0].length;
          if (keepGroup) {
            // Replace the whole copy expression by the copied name.
            const g = x[1];
            const gs = start + x[0].indexOf(g);
            found.push({ start, end, replacement: line.slice(gs, gs + g.length) });
          } else found.push({ start, end, replacement: '' });
        }
      };
      if (py) {
        add(/(?<=[\w)\]])\.copy\(\s*\)/g, false);
        add(/(?<![\w.])list\(\s*([A-Za-z_][\w.]*)\s*\)/g, true);
        add(/(?<![\w.])([A-Za-z_][\w.]*)\[\s*:\s*\]/g, true);
      } else {
        add(/\[\s*\.\.\.\s*([A-Za-z_$][\w$.]*)\s*\]/g, true);
        add(/(?<![\w$.])([A-Za-z_$][\w$.]*)\.slice\(\s*0?\s*\)/g, true);
      }
      return found.sort((a, b) => a.start - b.start);
    }
    case 'augadd-to-assign':
      return [...m.matchAll(/(?<!\+)\+=(?!=)/g)].map((x) => ({ start: x.index!, end: x.index! + 2, replacement: '=' }));
    case 'drop-await':
      return [...m.matchAll(/(?<![\w$.])await\s+/g)].map((x) => ({ start: x.index!, end: x.index! + x[0].length, replacement: '' }));
    case 'eq-to-is':
      return [...m.matchAll(/(?<![=!<>])==(?!=)/g)].map((x) => {
        const i = x.index!;
        const before = line[i - 1] === ' ' ? '' : ' ';
        const after = line[i + 2] === ' ' ? '' : ' ';
        return { start: i, end: i + 2, replacement: `${before}is${after}` };
      });
  }
}

/** Number of places the operator applies on the line. */
export function operatorSites(lineText: string, op: MutantOpId | MutantOp, lang: Lang | string): number {
  return sites(lineText, operator(op), lang).length;
}

/** The edit applying the operator at its `occurrence`-th site (0 = leftmost), or null. */
export function findOperator(lineText: string, op: MutantOpId | MutantOp, lang: Lang | string, occurrence = 0): OperatorEdit | null {
  const s = sites(lineText, operator(op), lang)[occurrence];
  if (!s) return null;
  const mutated = lineText.slice(0, s.start) + s.replacement + lineText.slice(s.end);
  if (mutated === lineText) return null;
  return { ...s, mutated };
}

/** The mutated line, or null when the operator does not apply (or would change nothing). */
export function applyOperator(lineText: string, op: MutantOpId | MutantOp, lang: Lang | string, occurrence = 0): string | null {
  return findOperator(lineText, op, lang, occurrence)?.mutated ?? null;
}

/** The alternative operator's line (its output also attributes a wrong answer), or null. */
export function alternativeLine(lineText: string, op: MutantOpId | MutantOp, lang: Lang | string): string | null {
  const alt = operator(op).alternative;
  return alt ? applyOperator(lineText, alt, lang) : null;
}

// ---------------------------------------------------------------- candidate selection

export interface WhatIfLine {
  /** 0-based line in the file. */
  line: number;
  text: string;
}

export interface WhatIfCandidate extends OperatorEdit {
  line: number;
  op: MutantOpId;
  tag: string;
  misconceptionId: string;
  score: number;
}

export interface CandidatePrefs {
  /** Tag of the task's weakest concept. */
  weakestTag?: string;
  /** Mistake journal entries (Learner.mistakes): their misconceptions and tags are preferred. */
  journal?: readonly { misconceptionId?: string }[];
  /** How many to pick (default 2). */
  max?: number;
}

/**
 * Up to `max` what-if candidates on distinct lines (only lines the probe calls exercise should be
 * passed in). Score: +2 for the weakest concept's tag, +1 for a journal mistake's tag or
 * misconception. Ties: operator table order, then line order; a second pick prefers a different
 * operator.
 */
export function whatIfCandidates(lines: readonly WhatIfLine[], lang: Lang | string, prefs: CandidatePrefs = {}): WhatIfCandidate[] {
  const journalIds = new Set((prefs.journal ?? []).map((j) => j.misconceptionId).filter((x): x is string => !!x));
  const journalTags = new Set([...journalIds].map(tagOfMisconception).filter((x): x is string => !!x));
  const ops = operatorsFor(lang);
  const all: (WhatIfCandidate & { rank: number })[] = [];
  for (const l of lines) {
    if (!l.text.trim()) continue;
    ops.forEach((op, rank) => {
      const e = findOperator(l.text, op, lang);
      if (!e) return;
      const score = (prefs.weakestTag && op.tag === prefs.weakestTag ? 2 : 0) + (journalTags.has(op.tag) || journalIds.has(op.misconceptionId) ? 1 : 0);
      all.push({ ...e, line: l.line, op: op.id, tag: op.tag, misconceptionId: op.misconceptionId, score, rank });
    });
  }
  all.sort((a, b) => b.score - a.score || a.rank - b.rank || a.line - b.line);
  const max = prefs.max ?? 2;
  const out: WhatIfCandidate[] = [];
  const usedLines = new Set<number>();
  const usedOps = new Set<string>();
  while (out.length < max) {
    const free = all.filter((c) => !usedLines.has(c.line));
    if (!free.length) break;
    // The best score wins; among equal scores, an operator not used yet.
    const best = free.find((c) => c.score === free[0].score && !usedOps.has(c.op)) ?? free[0];
    usedLines.add(best.line);
    usedOps.add(best.op);
    const { rank: _rank, ...cand } = best;
    out.push(cand);
  }
  return out;
}

// ---------------------------------------------------------------- attribution

export interface WhatIfOutputs {
  /** The probe call's result with the mutation. */
  actual: RecordedOutput;
  /** Its result on the unchanged code. */
  unmutated: RecordedOutput;
  /** Its result under the alternative operator, when one exists and ran. */
  alternative?: RecordedOutput;
}

export interface WhatIfAttribution {
  verdict: VerdictKind;
  /** Evidence.correct (null = don't know). */
  correct: boolean | null;
  /** Record evidence at all (no for an empty answer or a format-only one). */
  evidence: boolean;
  /** The wrong answer equals the unmutated or the alternative output: counts toward the misconception. */
  attributable: boolean;
  matched?: 'unmutated' | 'alternative';
  /** Evidence weight: 1 for correct and attributable answers, .5 otherwise. */
  weight: number;
  misconceptionId?: string;
  /** x3 when attributable. */
  misconceptionOdds?: number;
}

/**
 * Grade a what-if answer ('With this change, total([4, 5, 6]) -> ?') as a return value. A wrong
 * answer names the operator's misconception only when it strictly equals the unmutated output
 * (the learner thinks the change does not matter) or the alternative operator's output.
 */
export function attributeWhatIf(answer: string, outputs: WhatIfOutputs, lang: Lang, op?: MutantOpId | MutantOp): WhatIfAttribution {
  const opts = { typeSensitive: false, returnValue: true };
  if (!answer.trim()) return { verdict: 'dont-know', correct: null, evidence: false, attributable: false, weight: 0 };
  const v = compareOutput(answer, outputs.actual, lang, opts).verdict;
  if (v === 'format-only') return { verdict: v, correct: null, evidence: false, attributable: false, weight: 0 };
  if (v === 'correct') return { verdict: v, correct: true, evidence: true, attributable: false, weight: 1 };
  if (v === 'dont-know') return { verdict: v, correct: null, evidence: true, attributable: false, weight: 0.5 };
  const strict = (out: RecordedOutput | undefined) => !!out && compareOutput(answer, out, lang, opts).verdict === 'correct';
  const matched = strict(outputs.unmutated) ? 'unmutated' : strict(outputs.alternative) ? 'alternative' : undefined;
  if (!matched) return { verdict: v, correct: false, evidence: true, attributable: false, weight: 0.5 };
  const out: WhatIfAttribution = { verdict: v, correct: false, evidence: true, attributable: true, matched, weight: 1, misconceptionOdds: 3 };
  if (op) out.misconceptionId = operator(op).misconceptionId;
  return out;
}
