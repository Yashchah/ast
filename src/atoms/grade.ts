// Atom Pad grading (spec V1-6 GRADING, conceptAtom ITEM TYPES AND GRADING). Pure except that
// gradeCompletion runs code through the injected Runner. No vscode import.
// - Predict: the answer lines of the pad ('# -> ...' / '// -> ...') go to compareOutput (type-aware,
//   with the probe's mutants for misconception matching).
// - Completion: document + newline + hidden harness through runBatch; exit 0 passes. A failure is
//   located by the 'CHECK ' marker of the failing check(), and a fill equal to a tagged wrongFill
//   names that misconception.
// - Traceback: 'line N, ExceptionName' plus the 1/2/3 meaning pick.

import type { Lang, MutantOutput, RecordedOutput, Runner, StoredCompletion, StoredMutant, StoredProbe, TracebackItem, Verdict } from '../contracts';
import { actualText, compareOutput, parseLiteralAt } from '../compare';
import { fillBlanks } from './seeds';
import { failingFrame, outermostFrame, parseItemTrace, parseTrace } from './traceback';

export type CommentToken = '#' | '//';

/** Python pads use '#'; JS, TS, Go, Java and Rust pads use '//'. */
export function commentToken(lang: Lang | string): CommentToken {
  return lang === 'python' ? '#' : '//';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function answerLineRe(token: CommentToken): RegExp {
  return new RegExp(`^\\s*${escapeRe(token)}\\s*->(.*)$`);
}

/**
 * Answer lines of a pad document: every line whose trimmed text starts with the comment token
 * followed by '->', in order. One space after '->' and trailing whitespace are dropped. With
 * split (the default) each line is also split on ' | '. Blank answer lines at either end are dropped.
 */
export function parseAnswerLines(text: string, token: CommentToken, opts: { split?: boolean } = {}): string[] {
  const re = answerLineRe(token);
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = re.exec(raw);
    if (!m) continue;
    const body = m[1].replace(/^ /, '').trimEnd();
    if (opts.split === false) lines.push(body);
    else lines.push(...body.split(' | ').map((s) => s.trimEnd()));
  }
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

/**
 * The answer as compareOutput wants it: answer lines joined with newlines but NOT split on ' | ',
 * so compareOutput can still try the unsplit form for an output that prints a literal ' | '.
 */
export function answerText(text: string, token: CommentToken): string {
  return parseAnswerLines(text, token, { split: false }).join('\n');
}

// ---------------------------------------------------------------- predict

export interface PredictGrade extends Verdict {
  /** Nothing typed: re-prompt ('type an answer, or ? for no idea'); never scored. */
  empty: boolean;
  /** Evidence.correct: true, false, or null for don't know. Undefined when no evidence is due (empty, format-only). */
  correct?: boolean | null;
  /** The matched (unambiguous) mutant, when the wrong answer names a belief. */
  mutant?: StoredMutant;
  misconceptionId?: string;
  /** The actual output on one line ('actual: X'). */
  actual: string;
  /** Misconceptions this probe's unambiguous mutants carry: coverage for a correct answer. */
  avoidedMisconceptionIds: string[];
  /** The answer copies a literal of 5+ characters from the code: an implicit guess (spec CONFIDENCE). */
  copiedLiteral: boolean;
}

/**
 * Grade a predict answer against the probe's recorded output, then its mutants (strict match, no
 * match for a bare 'error', a slip within edit distance 1, or ambiguous outputs). `answer` is the
 * answer text (answerText()) or the raw answer lines; '?' is don't-know.
 */
export function gradePredict(answer: string, probe: Pick<StoredProbe, 'code' | 'output' | 'mutants'>, lang: Lang, typeSensitive: boolean): PredictGrade {
  const actual = actualText(probe.output, lang);
  const mutants: MutantOutput[] = probe.mutants.map((m) => ({ id: m.id, output: m.output, ambiguous: m.ambiguous }));
  const avoided = [...new Set(probe.mutants.filter((m) => !m.ambiguous).map((m) => m.misconceptionId))];
  const bare = answer.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/^\s*(?:#|\/\/)\s*->\s?/, '')).join('\n');
  if (!bare.trim()) {
    return { verdict: 'dont-know', empty: true, actual, avoidedMisconceptionIds: avoided, copiedLiteral: false };
  }
  const v = compareOutput(answer, probe.output, lang, { typeSensitive, mutants });
  const out: PredictGrade = { ...v, empty: false, actual, avoidedMisconceptionIds: avoided, copiedLiteral: copiesLiteral(bare, probe.code, lang) };
  switch (v.verdict) {
    case 'correct':
      out.correct = true;
      break;
    case 'dont-know':
      out.correct = null;
      out.copiedLiteral = false;
      break;
    case 'wrong':
      out.correct = false;
      if (v.mutantId && !v.ambiguous) {
        out.mutant = probe.mutants.find((m) => m.id === v.mutantId);
        out.misconceptionId = out.mutant?.misconceptionId;
      }
      break;
    case 'format-only':
      break;
  }
  return out;
}

/** Whitespace removed outside quotes: 'a, b' and 'a,b' compare equal, "'a b'" keeps its space. */
function squashCode(s: string): string {
  let out = '';
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      out += c;
      if (c === '\\' && i + 1 < s.length) out += s[++i];
      else if (c === q) q = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') q = c;
    if (!/\s/.test(c)) out += c;
  }
  return out;
}

/**
 * Literals written in the code: string contents (and their quoted form) and bracketed literals
 * ([3, 1, 4], {'a': 1}, (1, 2)) as source text.
 */
export function codeLiterals(code: string, lang: Lang): string[] {
  const out = new Set<string>();
  const py = lang === 'python';
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (py && c === '#') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (!py && c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      for (i++; i < code.length && code[i] !== c && code[i] !== '\n'; i++) if (code[i] === '\\') i++;
      out.add(code.slice(start + 1, i));
      out.add(code.slice(start, i + 1));
      continue;
    }
    if (c === '[' || c === '{' || c === '(') {
      try {
        const { end } = parseLiteralAt(code, i, lang, 'source');
        out.add(code.slice(i, end));
      } catch {
        // not a literal (a call, a subscript, a comprehension...)
      }
    }
  }
  return [...out].filter((s) => s.length >= 5);
}

/** Does any answer line equal (whitespace aside) a literal of 5 or more characters from the code? */
export function copiesLiteral(answer: string, code: string, lang: Lang): boolean {
  const lits = new Set(codeLiterals(code, lang).map(squashCode));
  if (!lits.size) return false;
  return answer
    .split('\n')
    .flatMap((l) => l.split(' | '))
    .map((l) => l.trim())
    .some((l) => l.length >= 5 && lits.has(squashCode(l)));
}

// ---------------------------------------------------------------- completion

export interface CompletionGrade {
  /** A blank still holds ___ (or nothing): re-prompt, never scored, never run. */
  empty: boolean;
  pass: boolean;
  /** What the learner typed in each blank, when the document still matches the code around the blanks. */
  fills?: string[];
  /** 0-based document line of each blank, in blank order (where after-text goes). */
  blankLines: number[];
  /** A tagged wrongFill matched: names that misconception (odds x3). */
  misconceptionId?: string;
  wrongFillBlank?: number;
  /** 'CHECK' message of the failing check, or the exception line ('NameError: ...'). */
  message?: string;
  /** The failure came from a harness check(), not a crash in the learner's code. */
  checkFailed: boolean;
  /** 0-based document line where the learner's code crashed (not for check failures). */
  crashLine?: number;
  timedOut: boolean;
  /** The allowlist refused the code (e.g. an import): not run. */
  denied?: string;
  ms: number;
}

const BLANK = /\[\[(\d+)\]\]/g;
const PLACEHOLDER = '___';

interface FillMatch {
  fills: string[];
  lines: number[];
}

/**
 * What the learner put in each blank: the code around the blanks is matched against the document
 * with whitespace runs flexible (snippet re-indentation, a stray space). Header comment lines may
 * precede the code. Undefined when the learner changed the code outside the blanks.
 */
export function extractFills(docText: string, code: string): FillMatch | undefined {
  const doc = docText.replace(/\r\n?/g, '\n');
  const parts = code.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split(BLANK);
  // parts: [text, n, text, n, text...]
  const order: number[] = [];
  let src = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2) {
      order.push(Number(parts[i]));
      src += '([^\\n]*?)';
    } else {
      src += parts[i]
        .split(/(\s+)/)
        .map((piece) => (/^\s+$/.test(piece) ? '\\s*' : escapeRe(piece)))
        .join('');
    }
  }
  if (!order.length) return undefined;
  let m: RegExpExecArray | null;
  try {
    m = new RegExp(`${src}\\s*$`, 'd').exec(doc);
  } catch {
    return undefined;
  }
  if (!m || !m.indices) return undefined;
  const n = Math.max(...order);
  const fills = new Array<string>(n).fill('');
  const lines = new Array<number>(n).fill(-1);
  order.forEach((blank, k) => {
    const [start] = m!.indices![k + 1] ?? [0, 0];
    fills[blank - 1] = (m![k + 1] ?? '').trim();
    if (lines[blank - 1] < 0) lines[blank - 1] = doc.slice(0, start).split('\n').length - 1;
  });
  return { fills, lines };
}

/** Blanks still unfilled: empty, or still showing the ___ placeholder. */
export function unfilled(fills: readonly string[]): number[] {
  return fills.flatMap((f, i) => (!f.trim() || f.includes(PLACEHOLDER) ? [i + 1] : []));
}

/** The tagged wrongFill the learner typed, if any (whitespace outside strings ignored). */
export function matchWrongFill(
  completion: Pick<StoredCompletion, 'code' | 'solutions' | 'wrongFills'>,
  fills: readonly string[] | undefined,
  docText?: string,
): { blank: number; fill: string; misconceptionId: string } | undefined {
  for (const w of completion.wrongFills) {
    if (fills) {
      if (squashCode(fills[w.blank - 1] ?? '') === squashCode(w.fill)) return w;
      continue;
    }
    if (docText === undefined) continue;
    // The code around the blanks was edited: compare whole documents instead (comments dropped).
    const expected = completion.solutions.slice();
    expected[w.blank - 1] = w.fill;
    if (squashCode(stripCommentLines(docText)) === squashCode(stripCommentLines(fillBlanks(completion.code, expected)))) return w;
  }
  return undefined;
}

function stripCommentLines(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*(?:#|\/\/)/.test(l))
    .join('\n');
}

/**
 * The failing check's message: the text after the 'CHECK ' marker check() puts in its error
 * ('f(4) should be 9'), found in the error output rather than by line arithmetic.
 */
export function failingCheckLine(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const lines = error.replace(/\r\n?/g, '\n').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /(?:^|[\s:])CHECK (.*)$/.exec(lines[i]);
    if (m) return m[1].trim() || 'failed';
  }
  return undefined;
}

/** The exception line of an error ('NameError: name 'x' is not defined'), else its last line. */
export function exceptionLine(error: string | undefined, exception?: string, lang?: Lang): string | undefined {
  if (!error) return exception;
  const tl = lang ?? (/Traceback \(most recent call last\)|^\s*File "/m.test(error) ? 'python' : 'javascript');
  const t = parseTrace(error, tl, exception);
  if (t) return t.message;
  const last = error.replace(/\r\n?/g, '\n').trim().split('\n').pop()?.trim();
  return last || exception;
}

export interface GradeCompletionOptions {
  signal?: AbortSignal;
  itemTimeoutMs?: number;
  /** Extra Python imports for the allowlist (the tag's allowedImports), passed to LocalRunner. */
  allowImports?: string[];
}

/**
 * Run the pad document + newline + the hidden harness in the batch runner (exit 0 = pass). Unfilled
 * blanks re-prompt without running. On a failure: the CHECK message (or exception line), the crash
 * line when it is inside the document, and a tagged wrongFill's misconception.
 */
export async function gradeCompletion(
  docText: string,
  completion: StoredCompletion,
  runner: Runner,
  lang: Lang,
  opts: GradeCompletionOptions = {},
): Promise<CompletionGrade> {
  const doc = docText.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const found = extractFills(doc, completion.code);
  const blankLines = found?.lines ?? [];
  const base = { blankLines, checkFailed: false, timedOut: false, ms: 0 };
  if (found ? unfilled(found.fills).length > 0 : hasPlaceholder(doc, lang)) {
    return { ...base, empty: true, pass: false, fills: found?.fills };
  }
  const batchOpts: { signal?: AbortSignal; itemTimeoutMs?: number; allowImports?: string[] } = { itemTimeoutMs: opts.itemTimeoutMs ?? 3000 };
  if (opts.signal) batchOpts.signal = opts.signal;
  if (opts.allowImports?.length) batchOpts.allowImports = opts.allowImports;
  const [rec] = await runner.runBatch([{ id: `${completion.id}~grade`, code: `${doc}\n${completion.harness}\n` }], batchOpts);
  const out: CompletionGrade = { ...base, empty: false, pass: false, fills: found?.fills, ms: rec?.ms ?? 0 };
  if (!rec) return { ...out, message: 'not run' };
  if (rec.denied) return { ...out, denied: rec.denied, message: `not allowed here: ${rec.denied}` };
  if (rec.timedOut) return { ...out, timedOut: true, message: 'took too long (an endless loop?)', ...wrongFill(completion, found, doc) };
  if (rec.exitOk) return { ...out, pass: true };
  const check = failingCheckLine(rec.error);
  if (check !== undefined) return { ...out, checkFailed: true, message: check, ...wrongFill(completion, found, doc) };
  out.message = exceptionLine(rec.error, rec.exception, lang) ?? 'it crashed';
  const t = parseTrace(rec.error ?? '', lang, rec.exception);
  const docLines = doc.split('\n').length;
  if (t?.frames.length) {
    const line = failingFrame(t).line;
    if (line >= 1 && line <= docLines) out.crashLine = line - 1;
  }
  return { ...out, ...wrongFill(completion, found, doc) };
}

function wrongFill(c: StoredCompletion, found: FillMatch | undefined, doc: string): Pick<CompletionGrade, 'misconceptionId' | 'wrongFillBlank'> {
  const w = matchWrongFill(c, found?.fills, doc);
  return w ? { misconceptionId: w.misconceptionId, wrongFillBlank: w.blank } : {};
}

/** '___' left in the code (outside strings and comments). */
function hasPlaceholder(doc: string, lang: Lang): boolean {
  return stripCommentLines(doc)
    .split('\n')
    .some((l) => {
      const code = l.replace(lang === 'python' ? /(['"]).*?\1|#.*$/g : /(['"`]).*?\1|\/\/.*$/g, '');
      return /(^|[^\w])___($|[^\w])/.test(code);
    });
}

// ---------------------------------------------------------------- traceback

export interface TracebackAnswer {
  line?: number;
  name?: string;
  empty: boolean;
  dontKnow: boolean;
}

/**
 * 'line 6, IndexError', '6 IndexError', 'IndexError line 6', 'IndexError: list index out of range on 6'.
 * The untouched template 'line ?, ?' and an empty answer are empty; a bare '?' is don't know.
 */
export function parseTracebackAnswer(answer: string): TracebackAnswer {
  const t = answer.replace(/^\s*(?:#|\/\/)\s*->\s?/, '').replace(/\s+/g, ' ').trim();
  if (!t) return { empty: true, dontKnow: false };
  if (t === '?') return { empty: false, dontKnow: true };
  const lineM = /\bline\s*:?\s*(\d+)\b/i.exec(t) ?? /(?:^|[\s,:(])(\d+)(?=$|[\s,:)])/.exec(t);
  const words = t.match(/[A-Za-z_$][\w$.]*/g) ?? [];
  const nameWord = words.find((w) => /(?:Error|Exception|Warning|Interrupt|Exit|Iteration)$/.test(w))
    ?? words.find((w) => !/^(?:line|on|at|in|and|the|a|an|it|raises?|throws?)$/i.test(w));
  const out: TracebackAnswer = { empty: false, dontKnow: false };
  if (lineM) out.line = Number(lineM[1]);
  if (nameWord) out.name = nameWord.slice(nameWord.lastIndexOf('.') + 1);
  if (out.line === undefined && out.name === undefined) out.empty = true;
  return out;
}

export interface TracebackGrade extends TracebackAnswer {
  lineOk: boolean;
  nameOk: boolean;
  /** Undefined until the 1/2/3 meaning pick is made. */
  meaningOk?: boolean;
  /** Line and name right, and the meaning pick (when made) right. */
  correct: boolean;
  /** Answering the outermost frame names the frame-order misconception. */
  misconceptionId?: string;
}

/**
 * Grade 'line N, ExceptionName' (and the meaning pick, 1-based, when given). Pad line numbers are
 * the code lines shifted by lineOffset (the header lines above the code; render.ts reports it).
 */
export function gradeTraceback(answer: string, item: TracebackItem, opts: { lineOffset?: number; pick?: number } = {}): TracebackGrade {
  const offset = opts.lineOffset ?? 0;
  const a = parseTracebackAnswer(answer);
  const lineOk = a.line !== undefined && a.line - offset === item.line;
  const nameOk = a.name !== undefined && a.name.toLowerCase() === item.exception.toLowerCase();
  const out: TracebackGrade = { ...a, lineOk, nameOk, correct: false };
  if (opts.pick !== undefined) out.meaningOk = gradeMeaningPick(opts.pick, item);
  out.correct = lineOk && nameOk && out.meaningOk !== false;
  if (!lineOk && a.line !== undefined) {
    const t = parseItemTrace(item.trace);
    if (t && t.frames.length >= 2) {
      const outer = outermostFrame(t).line;
      if (outer !== failingFrame(t).line && a.line - offset === outer) {
        out.misconceptionId = t.lang === 'python' ? 'first-frame-is-failure' : 'last-frame-is-failure';
      }
    }
  }
  return out;
}

/** The 1/2/3 meaning pick (1-based) against the item's 0-based correctMeaning. */
export function gradeMeaningPick(pick: number, item: Pick<TracebackItem, 'correctMeaning'>): boolean {
  return Number.isInteger(pick) && pick - 1 === item.correctMeaning;
}

/** One-line output text for feedback ('actual: X'). */
export function outputLine(rec: RecordedOutput, lang: Lang): string {
  return actualText(rec, lang);
}
