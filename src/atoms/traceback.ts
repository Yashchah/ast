// Traceback items (spec V1-9 (i), tag 'reading-tracebacks'). Pure: no vscode import.
// - Parses the batch runner's error text (Python traceback / Node stack), keeps only the snippet's
//   frames and rebuilds the trace against the code the pad shows, with the file called "pad".
// - Line numbers in a stored TracebackItem are 1-based CODE lines; render.ts shifts them to pad
//   lines (renumberTrace) because the pad puts a header above the code.
// - Exception meaning table with near-miss distractors for the 1/2/3 meaning pick.
// - Multi-frame traces (through a helper function) are preferred: beginners pick the outermost frame.

import type { BatchRecord, Lang, StoredProbe, TracebackItem } from '../contracts';
import { hash53, Rng } from './rng';
import type { TracebackBuilder, TracebackParts } from './seeds';

export type TraceLang = 'python' | 'javascript';

export const traceLang = (lang: Lang | string): TraceLang => (lang === 'python' ? 'python' : 'javascript');

export interface MeaningEntry {
  /** What the exception means, in learner words. Never contains an exception name. */
  meaning: string;
  /** Exceptions a beginner confuses it with, most plausible first (distractor sources). */
  confusions: string[];
}

/**
 * The spec's exceptions (Python: IndexError, KeyError, TypeError, NameError, AttributeError,
 * ValueError, ZeroDivisionError, RecursionError; JS: TypeError, ReferenceError, RangeError,
 * SyntaxError) plus UnboundLocalError, the scope error beginners meet most.
 */
export const EXCEPTION_TABLE: Record<TraceLang, Record<string, MeaningEntry>> = {
  python: {
    IndexError: { meaning: 'A list or string position past its end was used', confusions: ['KeyError', 'ValueError', 'TypeError'] },
    KeyError: { meaning: 'A dictionary was asked for a key it does not have', confusions: ['IndexError', 'AttributeError', 'NameError'] },
    TypeError: { meaning: 'An operation got a value of the wrong type', confusions: ['ValueError', 'AttributeError', 'NameError'] },
    NameError: { meaning: 'A name was used that was never defined', confusions: ['AttributeError', 'KeyError', 'TypeError'] },
    AttributeError: { meaning: 'The value has no attribute or method with that name', confusions: ['NameError', 'TypeError', 'KeyError'] },
    ValueError: { meaning: 'The type was right but the value was unusable', confusions: ['TypeError', 'IndexError', 'KeyError'] },
    ZeroDivisionError: { meaning: 'A number was divided by zero', confusions: ['ValueError', 'TypeError', 'IndexError'] },
    RecursionError: { meaning: 'A function kept calling itself without stopping', confusions: ['IndexError', 'ValueError', 'ZeroDivisionError'] },
    UnboundLocalError: { meaning: 'A local name was read before it got a value', confusions: ['NameError', 'AttributeError', 'KeyError'] },
  },
  javascript: {
    TypeError: { meaning: 'A value was used in a way its type does not allow', confusions: ['ReferenceError', 'RangeError', 'SyntaxError'] },
    ReferenceError: { meaning: 'A variable was used that does not exist (yet)', confusions: ['TypeError', 'SyntaxError', 'RangeError'] },
    RangeError: { meaning: 'A number was outside its allowed range, or the stack overflowed', confusions: ['TypeError', 'ReferenceError', 'SyntaxError'] },
    SyntaxError: { meaning: 'Text could not be parsed, for example bad JSON', confusions: ['TypeError', 'ReferenceError', 'RangeError'] },
  },
};

export function meaningOf(exception: string, lang: Lang | string): string | undefined {
  return EXCEPTION_TABLE[traceLang(lang)][exception]?.meaning;
}

/**
 * The right meaning plus 2 distractor meanings (drawn from the exception's confusions), shuffled.
 * correctMeaning is a 0-based index. Undefined for an exception the table does not cover.
 */
export function meaningChoices(exception: string, lang: Lang | string, rng?: Rng): { meanings: string[]; correctMeaning: number } | undefined {
  const table = EXCEPTION_TABLE[traceLang(lang)];
  const entry = table[exception];
  if (!entry) return undefined;
  const pool = entry.confusions.filter((e) => e !== exception && table[e]);
  // Fall back to the rest of the table if a confusion list is ever too short.
  for (const e of Object.keys(table)) if (e !== exception && !pool.includes(e)) pool.push(e);
  const picked = rng ? rng.sample(pool.slice(0, 3), 2) : pool.slice(0, 2);
  const options = [entry.meaning, ...picked.map((e) => table[e].meaning)];
  const meanings = rng ? rng.shuffle(options) : options;
  return { meanings, correctMeaning: meanings.indexOf(entry.meaning) };
}

// ---------------------------------------------------------------- parsing

export interface TraceFrame {
  fn: string;
  /** 1-based line in the snippet. */
  line: number;
  col?: number;
  /** Python: '[Previous line repeated N more times]' that followed this frame. */
  repeated?: string;
}

export interface ParsedTrace {
  lang: TraceLang;
  exception: string;
  /** 'IndexError: list index out of range' (module prefix removed). */
  message: string;
  /** Snippet frames only, outermost first for Python, innermost first for JS (as each prints them). */
  frames: TraceFrame[];
}

const PY_FRAME = /^\s*File "([^"]*)", line (\d+), in (.+?)\s*$/;
const PY_REPEAT = /^\s*\[Previous line repeated \d+ more times?\]\s*$/;
const JS_FRAME = /^\s*at (?:async )?(?:(.*?) \()?((?:[A-Za-z]:)?[^():]+?):(\d+):(\d+)\)?\s*$/;
const JS_INTERNAL = /^(?:node:|internal\/)|<anonymous>|(?:batch|prelude|harness|probe)\.mjs$|deliberate-check\.js$/;
const MAX_MESSAGE = 120;

const lastComponent = (name: string) => name.slice(name.lastIndexOf('.') + 1);

function clipMessage(m: string): string {
  const one = m.replace(/\s+/g, ' ').trim();
  return one.length <= MAX_MESSAGE ? one : one.slice(0, MAX_MESSAGE - 1).trimEnd() + '…';
}

/**
 * Parse the error text of a raising run. `exception` (BatchRecord.exception) pins the message
 * line; without it the last exception-looking line wins. Undefined when no snippet frame exists.
 */
export function parseTrace(error: string, lang: Lang | string, exception?: string): ParsedTrace | undefined {
  const tl = traceLang(lang);
  const lines = (error ?? '').replace(/\r\n?/g, '\n').split('\n');
  return tl === 'python' ? parsePython(lines, exception) : parseNode(lines, exception);
}

function parsePython(lines: string[], exception?: string): ParsedTrace | undefined {
  const raw: (TraceFrame & { file: string })[] = [];
  for (const l of lines) {
    const m = PY_FRAME.exec(l);
    if (m) raw.push({ file: m[1], line: Number(m[2]), fn: m[3] });
    else if (PY_REPEAT.test(l) && raw.length) raw[raw.length - 1].repeated = l.trim();
  }
  if (!raw.length) return undefined;
  // The snippet is the file of the LAST <module> frame (a runner that exec()s it shows its own
  // <module> frame first); a truncated head leaves only inner frames.
  const top = raw.map((f) => f.fn).lastIndexOf('<module>');
  const file = raw[top >= 0 ? top : raw.length - 1].file;
  const frames = raw.slice(Math.max(top, 0)).filter((f) => f.file === file).map(({ file: _f, ...f }) => f);
  // The exception line: unindented, after the frames, starting with the class name.
  let message = '';
  let name = exception ?? '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim() || /^\s/.test(l)) continue;
    const m = /^([A-Za-z_][\w.]*)(?::\s?(.*))?$/.exec(l);
    if (!m) continue;
    const cls = lastComponent(m[1]);
    if (exception && cls !== exception) continue;
    if (cls === 'Traceback') continue;
    name ||= cls;
    message = m[2] !== undefined && m[2] !== '' ? `${cls}: ${m[2]}` : cls;
    break;
  }
  if (!name) return undefined;
  return { lang: 'python', exception: name, message: clipMessage(message || name), frames };
}

function parseNode(lines: string[], exception?: string): ParsedTrace | undefined {
  const raw: (TraceFrame & { file: string })[] = [];
  for (const l of lines) {
    const m = JS_FRAME.exec(l);
    if (m) raw.push({ fn: (m[1] ?? '').trim(), file: m[2], line: Number(m[3]), col: Number(m[4]) });
  }
  const own = raw.filter((f) => !JS_INTERNAL.test(f.file));
  if (!own.length) return undefined;
  const file = own[0].file;
  const frames = own.filter((f) => f.file === file).map(({ file: _f, ...f }) => f);
  let message = '';
  let name = exception ?? '';
  for (const l of lines) {
    const m = /^(?:Uncaught\s+)?([A-Za-z_$][\w$]*)(?: \[\w+\])?(?::\s?(.*))?$/.exec(l);
    if (!m) continue;
    if (exception ? m[1] !== exception : !/(?:Error|Exception)$/.test(m[1])) continue;
    name ||= m[1];
    message = m[2] !== undefined && m[2] !== '' ? `${m[1]}: ${m[2]}` : m[1];
    break;
  }
  if (!name) return undefined;
  return { lang: 'javascript', exception: name, message: clipMessage(message || name), frames };
}

/** Where it failed: the innermost frame (Python prints it last, Node first). */
export function failingFrame(t: ParsedTrace): TraceFrame {
  return t.lang === 'python' ? t.frames[t.frames.length - 1] : t.frames[0];
}

/** The outermost frame: where beginners wrongly look first. */
export function outermostFrame(t: ParsedTrace): TraceFrame {
  return t.lang === 'python' ? t.frames[0] : t.frames[t.frames.length - 1];
}

/**
 * The trace as the pad shows it: snippet frames only, file "pad", line numbers shifted by
 * lineOffset (0 = code lines), each Python frame followed by its own source line from `code`.
 */
export function formatTrace(t: ParsedTrace, code: string, lineOffset = 0): string {
  const src = code.replace(/\r\n?/g, '\n').split('\n');
  if (t.lang === 'python') {
    const out = ['Traceback (most recent call last):'];
    for (const f of t.frames) {
      out.push(`  File "pad", line ${f.line + lineOffset}, in ${f.fn}`);
      const s = (src[f.line - 1] ?? '').trim();
      if (s) out.push(`    ${s}`);
      if (f.repeated) out.push(`  ${f.repeated}`);
    }
    out.push(t.message);
    return out.join('\n');
  }
  return [
    t.message,
    ...t.frames.map((f) => {
      const at = `pad:${f.line + lineOffset}:${f.col ?? 1}`;
      return f.fn ? `    at ${f.fn} (${at})` : `    at ${at}`;
    }),
  ].join('\n');
}

/** Shift every line number in a formatted trace by `offset` (code lines -> pad lines). */
export function renumberTrace(trace: string, offset: number): string {
  if (!offset) return trace;
  return trace
    .replace(/^(\s*File "pad", line )(\d+)/gm, (_m, head: string, n: string) => head + (Number(n) + offset))
    .replace(/\bpad:(\d+):(\d+)/g, (_m, n: string, c: string) => `pad:${Number(n) + offset}:${c}`);
}

/** Re-read a formatted item trace (TracebackItem.trace) back into frames. */
export function parseItemTrace(trace: string): ParsedTrace | undefined {
  const python = /^Traceback \(most recent call last\):/m.test(trace) || /^\s*File "pad", line \d+/m.test(trace);
  return parseTrace(trace, python ? 'python' : 'javascript');
}

/** Number of frames in a stored item's trace. */
export function frameCount(item: Pick<TracebackItem, 'trace'>): number {
  return parseItemTrace(item.trace)?.frames.length ?? 0;
}

/** Stable order with multi-frame traces (through a helper function) first. */
export function preferMultiFrame<T extends Pick<TracebackItem, 'trace'>>(items: readonly T[]): T[] {
  return items
    .map((item, i) => ({ item, i, multi: frameCount(item) >= 2 }))
    .sort((a, b) => Number(b.multi) - Number(a.multi) || a.i - b.i)
    .map((x) => x.item);
}

// ---------------------------------------------------------------- building items

/**
 * Seeds' TracebackBuilder: the trace trimmed to snippet frames, the 1-based failing code line,
 * and the meaning pick. Undefined for runs that did not raise, raised something outside the
 * meaning table, or whose frames point outside the code.
 */
export const buildTracebackParts: TracebackBuilder = (code, record, lang, rng) => {
  if (record.exitOk || record.timedOut || record.denied || !record.exception) return undefined;
  const t = parseTrace(record.error ?? '', lang, record.exception);
  if (!t || !t.frames.length) return undefined;
  const lines = code.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (t.frames.some((f) => f.line < 1 || f.line > lines.length)) return undefined;
  const choices = meaningChoices(t.exception, lang, rng);
  if (!choices) return undefined;
  const parts: TracebackParts = { trace: formatTrace(t, code), line: failingFrame(t).line, exception: t.exception, ...choices };
  return parts;
};

export interface TracebackSource {
  id: string;
  code: string;
  record: BatchRecord;
  lang: Lang;
  siblingGroup: string;
  /** Concept the item counts for (default 'reading-tracebacks'). */
  conceptId?: string;
  /** RNG for the distractor draw and order (default: seeded from the id, so it is stable). */
  rng?: Rng;
}

/** A TracebackItem from one raising run, or undefined when the run is unusable. */
export function buildTracebackItem(s: TracebackSource): TracebackItem | undefined {
  const parts = buildTracebackParts(s.code, s.record, s.lang, s.rng ?? new Rng(hash53(s.id) % 4294967296));
  if (!parts) return undefined;
  return { id: s.id, code: s.code, ...parts, siblingGroup: s.siblingGroup, conceptId: s.conceptId ?? 'reading-tracebacks' };
}

/**
 * Raising mutants (and intentionally raising probes) whose exception the meaning table covers:
 * run their code in one batch, then pass each record to buildTracebackItem. Mutant items join the
 * probe's sibling group.
 */
export function raisingCandidates(probes: readonly StoredProbe[], lang: Lang): { id: string; code: string; siblingGroup: string }[] {
  const table = EXCEPTION_TABLE[traceLang(lang)];
  const out: { id: string; code: string; siblingGroup: string }[] = [];
  for (const p of probes) {
    if (p.raises && p.output.exception && table[p.output.exception]) out.push({ id: `${p.id}~tb`, code: p.code, siblingGroup: p.group });
    for (const m of p.mutants) {
      if (m.output.exception && table[m.output.exception]) out.push({ id: `${m.id}~tb`, code: m.code, siblingGroup: p.group });
    }
  }
  return out;
}
