// Atom Pad layouts (spec V1-6 SURFACE, PROBE LAYOUT, FEEDBACK DECORATIONS; V1-7 typing calibration;
// V1-9 traceback items). Pure: builds the pad text, the answer position and the decorations for each
// step as plain data; src/atoms/pad.ts applies them with TextEditor.edit / insertSnippet /
// setDecorations. No vscode import.
//
// Lines and columns are 0-based (vscode.Position). Code inside items keeps its own 1-based lines
// (subgoals, traces, diffLine, TracebackItem.line); `codeStart` maps them: pad line = codeStart + n - 1.

import type {
  AtomPattern, Lang, RecordedOutput, StoredCompletion, StoredContrast, StoredExample, StoredMutant, StoredProbe, TracebackItem,
} from '../contracts';
import { actualText } from '../compare';
import { AFTER_TEXT_MAX } from '../annotationModel';
import { commentToken, type CommentToken } from './grade';
import { renumberTrace } from './traceback';

export type PadAwait = 'answer' | 'yn' | 'pick2' | 'pick3' | 'read';

export type DecorationKind =
  /** Feedback on an answer line: 'ok 7s' (testing.iconPassed). */
  | 'correct'
  /** 'right idea; Python writes it as [2, 3]' (editorInfo.foreground). */
  | 'format'
  /** 'actual: [2, 3]' (testing.iconFailed). */
  | 'wrong'
  /** Neutral notes: re-prompts, 'looked auto-inserted: not counted'. */
  | 'note'
  /** A failing completion check, on the blank's line. */
  | 'check'
  /** The mutant's diff line: diffEditor.removedLineBackground, refutation as after-text and hover. */
  | 'removed'
  /** Worked-example subgoal labels: italic, editorCodeLens.foreground. */
  | 'subgoal'
  /** Python state trace after-text on each probe line ('-> a=[1, 2]  b is a'). */
  | 'trace'
  /** A completion fill revealed after the second failure: highlighted line. */
  | 'reveal-fill'
  /** Key hints such as 'Ctrl+Enter to continue'. */
  | 'hint';

export interface PadDecoration {
  /** 0-based document line. */
  line: number;
  /** After-text, one line, <= 52 characters (an ellipsis marks a clip); '' for background only. */
  text: string;
  /** Full text for the hover (set when the after-text was clipped or more is worth showing). */
  hover?: string;
  kind: DecorationKind;
}

/** Completion snippet: appendText for text parts, appendPlaceholder(value, n) for blanks. */
export type SnippetPart = { text: string } | { placeholder: number; value: string };

export interface PadRender {
  /** The full document text (for snippet steps: the text after insertion, with ___ in the blanks). */
  text: string;
  /** Snippet steps (completions): empty the document, then insertSnippet these parts at (0,0). */
  snippet?: SnippetPart[];
  /** The same snippet as a TextMate snippet string ($, } and \ escaped). */
  snippetText?: string;
  await: PadAwait;
  /** 0-based line the cursor goes to (the answer line). */
  answerLine?: number;
  answerColumn?: number;
  /** When set, select answerColumn..answerSelectEnd (the first '?' of 'line ?, ?'). */
  answerSelectEnd?: number;
  decorations: PadDecoration[];
  /** 0-based pad line of the item's first code line. */
  codeStart?: number;
  /** Editor (1-based) line number = code line + lineOffset. Traceback answers are graded with it. */
  lineOffset?: number;
  /** pick2 / pick3: the right key (1-based). */
  correctPick?: number;
  /** Completion: 0-based line of each blank, in blank order. */
  blankLines?: number[];
}

export interface RenderContext {
  lang: Lang | string;
  /** Learner.keyUse: the key legend shows until each legend key was used 3 times. */
  keyUse?: Record<string, number>;
}

/** Text of an escalation lesson (src/schemas.ts EscalationLessonSchema). */
export interface LessonText {
  title: string;
  explanation: string;
  example: string;
  rule: string;
}

// ---------------------------------------------------------------- headers, keys, legend

export const PROBE_HEADER = 'what does this print?';
export const TRACEBACK_HEADER = 'which line failed, and with what error?';
export const TYPING_HEADER = 'copy this exactly, then Ctrl+Enter';
export const LESSON_PENDING = 'preparing a short lesson... (~10 s)';
export const EMPTY_REPROMPT = 'type an answer, or ? for no idea';
export const ASSISTED_NOTE = 'looked auto-inserted: not counted';
export const CONTINUE_HINT = 'Ctrl+Enter to continue';

/** Learner.keyUse keys. */
export const KEYS = { submit: 'ctrl+enter', guess: 'ctrl+shift+enter', dontKnow: '?', lines: '|' } as const;
export const LEGEND = 'Ctrl+Enter submit · Ctrl+Shift+Enter guessing · ? no idea · | between lines';
export const LEGEND_FADE_USES = 3;

export function legendNeeded(keyUse: Record<string, number> = {}): boolean {
  return Object.values(KEYS).some((k) => (keyUse[k] ?? 0) < LEGEND_FADE_USES);
}

/**
 * Legend keys a submission used, for Learner.keyUse. A multi-line answer counts as the '|' key:
 * extra '# -> ' lines are the same affordance, so the legend never lingers for learners who use them.
 */
export function keysUsed(answer: string, guess: boolean): string[] {
  const keys: string[] = [guess ? KEYS.guess : KEYS.submit];
  const t = answer.trim();
  if (t === '?') keys.push(KEYS.dontKnow);
  if (/ \| /.test(t) || t.includes('\n')) keys.push(KEYS.lines);
  return keys;
}

const asLang = (lang: Lang | string): Lang => (lang === 'python' || lang === 'typescript' ? lang : 'javascript');

// ---------------------------------------------------------------- builder

class Pad {
  readonly lines: string[] = [];
  readonly decorations: PadDecoration[] = [];

  constructor(readonly tok: CommentToken) {}

  get next(): number {
    return this.lines.length;
  }

  comment(text = ''): number {
    this.lines.push(text ? `${this.tok} ${text}` : this.tok);
    return this.lines.length - 1;
  }

  /** Append code lines; returns the 0-based line of the first one. */
  code(code: string): number {
    const start = this.lines.length;
    this.lines.push(...codeLines(code));
    return start;
  }

  /** '# -> ' plus an optional answer; the trailing space stays so the cursor sits after it. */
  answer(body = ''): number {
    this.lines.push(`${this.tok} -> ${body}`);
    return this.lines.length - 1;
  }

  /** The learner's answer, one '# -> ' line per answer line (at least one). */
  answers(answer: string | undefined): number {
    const ls = (answer ?? '').replace(/\r\n?/g, '\n').split('\n');
    let last = -1;
    for (const l of ls.length ? ls : ['']) last = this.answer(l.replace(/^\s*(?:#|\/\/)\s*->\s?/, ''));
    return last;
  }

  deco(line: number, text: string, kind: DecorationKind, hover?: string): void {
    this.decorations.push(decoration(line, text, kind, hover));
  }

  text(): string {
    return this.lines.join('\n');
  }
}

/**
 * One-line after-text of at most 52 characters (an ellipsis marks a clip). Unlike toAfterText,
 * inner spacing survives: state traces separate names with two spaces ('a=[1, 2]  b is a').
 */
export function afterText(text: string): string {
  const one = text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if ([...one].length <= AFTER_TEXT_MAX) return one;
  return [...one].slice(0, AFTER_TEXT_MAX - 1).join('').trimEnd() + '…';
}

function decoration(line: number, text: string, kind: DecorationKind, hover?: string): PadDecoration {
  const after = afterText(text);
  const d: PadDecoration = { line, text: after, kind };
  const full = hover ?? (after !== text.replace(/\s*[\r\n]+\s*/g, ' ').trim() ? text : undefined);
  if (full) d.hover = full;
  return d;
}

/** Code as pad lines: CRLF normalised, trailing blank lines dropped. */
function codeLines(code: string): string[] {
  return code.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
}

function tokenOf(ctx: RenderContext): CommentToken {
  return commentToken(ctx.lang);
}

/** 'Did you think: <belief>?' without doubled punctuation. */
function question(belief: string): string {
  return `Did you think: ${belief.trim().replace(/[.?!]+$/, '')}?   y / n`;
}

/** Output lines for '# prints:' blocks (stdout lines, then the exception name). */
function outputLines(out: RecordedOutput): string[] {
  const s = (out.stdout ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const lines = s ? s.split('\n').map((l) => l.trimEnd()) : [];
  if (out.exception) lines.push(out.exception);
  return lines;
}

// ---------------------------------------------------------------- predict steps

/** PROBE, PROBE2, RE-PROBE, SECOND SIBLING, final predict, placement and sprint items. */
export function renderProbe(probe: Pick<StoredProbe, 'code'>, ctx: RenderContext, header = PROBE_HEADER): PadRender {
  const p = new Pad(tokenOf(ctx));
  p.comment(header);
  if (legendNeeded(ctx.keyUse)) p.comment(LEGEND);
  const codeStart = p.code(probe.code);
  const answerLine = p.answer();
  return { text: p.text(), await: 'answer', answerLine, answerColumn: p.lines[answerLine].length, decorations: p.decorations, codeStart, lineOffset: codeStart };
}

/** Placement item 1: copy a short literal (sets cps; not scored). */
export function renderTyping(literal: string, ctx: RenderContext): PadRender {
  const p = new Pad(tokenOf(ctx));
  p.comment(TYPING_HEADER);
  const codeStart = p.code(literal);
  const answerLine = p.answer();
  return { text: p.text(), await: 'answer', answerLine, answerColumn: p.lines[answerLine].length, decorations: [], codeStart, lineOffset: codeStart };
}

export interface BeliefCheckView {
  belief: string;
  /** The probe just answered (absent when ROUTE starts from a stored candidate). */
  probe?: Pick<StoredProbe, 'code'>;
  /** The learner's answer text (answer lines joined with newlines). */
  answer?: string;
  /** 'actual: X' on the answer line. */
  actual?: string;
}

/** BELIEF-CHECK: 'actual: X' on the answer line, then '# Did you think: <belief>?   y / n'. */
export function renderBeliefCheck(v: BeliefCheckView, ctx: RenderContext): PadRender {
  const p = new Pad(tokenOf(ctx));
  let codeStart: number | undefined;
  if (v.probe) {
    p.comment(PROBE_HEADER);
    codeStart = p.code(v.probe.code);
    const last = p.answers(v.answer);
    if (v.actual !== undefined) p.deco(last, `actual: ${v.actual}`, 'wrong');
  }
  const q = p.comment(question(v.belief));
  const r: PadRender = { text: p.text(), await: 'yn', answerLine: q, answerColumn: p.lines[q].length, decorations: p.decorations };
  if (codeStart !== undefined) {
    r.codeStart = codeStart;
    r.lineOffset = codeStart;
  }
  return r;
}

// ---------------------------------------------------------------- refutation

/** CONTRAST-PICK: both snippets without outputs under '# Which one prints X?  1 / 2'. */
export function renderContrastPick(contrast: StoredContrast, rightFirst: boolean, ctx: RenderContext): PadRender {
  const p = new Pad(tokenOf(ctx));
  const lang = asLang(ctx.lang);
  const q = p.comment(`Which one prints ${actualText(contrast.rightOutput, lang)}?  1 / 2`);
  const [first, second] = rightFirst ? [contrast.right, contrast.wrong] : [contrast.wrong, contrast.right];
  p.comment('1');
  const codeStart = p.code(first);
  p.comment('2');
  p.code(second);
  return { text: p.text(), await: 'pick2', answerLine: q, answerColumn: p.lines[q].length, decorations: [], codeStart, correctPick: rightFirst ? 1 : 2 };
}

export interface RevealView {
  /** '# Rule: <rule>' (the mutant's rule, else the contrast's). */
  rule: string;
  contrast?: StoredContrast;
  rightFirst?: boolean;
  /** The probe whose mutant matched (or one carrying the misconception): shown with its output. */
  probe?: Pick<StoredProbe, 'code' | 'output' | 'trace'>;
  /** Its diff line gets the removed-line background and the refutation. */
  mutant?: Pick<StoredMutant, 'diffLine' | 'refutation'>;
}

/**
 * REVEAL: both contrast outputs as '# prints: ...', '# Rule: <rule>', the probe with its output, the
 * refutation on the mutant's changed line and (Python state tags) the state trace as after-text.
 */
export function renderReveal(v: RevealView, ctx: RenderContext): PadRender {
  const p = new Pad(tokenOf(ctx));
  const lang = asLang(ctx.lang);
  if (v.rule.trim()) p.comment(`Rule: ${v.rule.trim()}`);
  let codeStart: number | undefined;
  if (v.contrast) {
    const c = v.contrast;
    const pairs: [string, RecordedOutput][] = v.rightFirst
      ? [[c.right, c.rightOutput], [c.wrong, c.wrongOutput]]
      : [[c.wrong, c.wrongOutput], [c.right, c.rightOutput]];
    pairs.forEach(([code, out], i) => {
      p.comment(String(i + 1));
      const s = p.code(code);
      codeStart ??= s;
      p.comment(`prints: ${actualText(out, lang)}`);
    });
  }
  if (v.probe) {
    if (v.contrast) p.comment();
    const start = p.code(v.probe.code);
    codeStart ??= start;
    const traceByLine = new Map((v.probe.trace ?? []).map((t) => [t.line, t.text]));
    const diff = v.mutant?.diffLine;
    for (const [line, text] of traceByLine) {
      if (line === diff) continue;
      p.deco(start + line - 1, `-> ${text}`, 'trace');
    }
    if (diff !== undefined && diff >= 1) {
      const ref = v.mutant?.refutation?.trim() ?? '';
      const trace = traceByLine.get(diff);
      p.deco(start + diff - 1, ref, 'removed', [ref, trace ? `-> ${trace}` : ''].filter(Boolean).join('\n\n') || undefined);
    }
    p.comment(`prints: ${actualText(v.probe.output, lang)}`);
  }
  const last = p.next - 1;
  p.deco(Math.max(0, last), CONTINUE_HINT, 'hint');
  const r: PadRender = { text: p.text(), await: 'read', decorations: p.decorations };
  if (codeStart !== undefined) r.codeStart = codeStart;
  return r;
}

// ---------------------------------------------------------------- teaching

/** '# Pattern: <name> - <useWhen>' for shape concepts, '# Rule: <rule>' for semantics ones. */
export function patternHeader(pattern: Pick<AtomPattern, 'kind' | 'name' | 'useWhen' | 'rule'>): string {
  if (pattern.kind === 'semantics' && pattern.rule.trim()) return `Rule: ${pattern.rule.trim()}`;
  const when = pattern.useWhen.trim();
  return `Pattern: ${pattern.name}${when ? ` - ${when}` : ''}`;
}

/** UNKNOWN worked example: pattern/rule header, subgoal labels as after-text, its real output. */
export function renderExample(example: Pick<StoredExample, 'code' | 'subgoals' | 'output'>, pattern: AtomPattern, ctx: RenderContext): PadRender {
  const p = new Pad(tokenOf(ctx));
  p.comment(patternHeader(pattern));
  const codeStart = p.code(example.code);
  const n = codeLines(example.code).length;
  for (const g of example.subgoals) {
    if (g.line >= 1 && g.line <= n && g.label.trim()) p.deco(codeStart + g.line - 1, `<- ${g.label.trim()}`, 'subgoal');
  }
  const out = outputLines(example.output);
  if (out.length === 1) p.comment(`prints: ${out[0]}`);
  else if (out.length > 1) {
    p.comment('prints:');
    for (const l of out) p.comment(`  ${l}`);
  }
  p.deco(p.next - 1, CONTINUE_HINT, 'hint');
  return { text: p.text(), await: 'read', decorations: p.decorations, codeStart, lineOffset: codeStart };
}

/**
 * Re-indent code to 4 spaces per level (leading tabs expand to 4 columns; the smallest indent is
 * one level). Snippets are inserted with 4-space indentation so VS Code's snippet whitespace
 * normalisation maps every level to exactly one tab or tabSize spaces, never a mix.
 */
export function indentTo4(code: string): string {
  const lines = code.replace(/\r\n?/g, '\n').split('\n').map((l) =>
    l.replace(/^[ \t]+/, (ws) => {
      let col = 0;
      for (const c of ws) col = c === '\t' ? col + 4 - (col % 4) : col + 1;
      return ' '.repeat(col);
    }),
  );
  const lead = (l: string) => l.length - l.trimStart().length;
  const unit = Math.min(...lines.filter((l) => l.trim()).map(lead).filter((n) => n > 0));
  if (!Number.isFinite(unit) || unit === 4) return lines.join('\n');
  return lines.map((l) => (l.trim() && lead(l) ? ' '.repeat(Math.round((lead(l) * 4) / unit)) + l.trimStart() : l)).join('\n').replace(/[ \t]+$/gm, '');
}

const SNIPPET_ESCAPE = /[$}\\]/g;

export function snippetString(parts: readonly SnippetPart[]): string {
  return parts.map((x) => ('text' in x ? x.text.replace(SNIPPET_ESCAPE, '\\$&') : `\${${x.placeholder}:${x.value.replace(SNIPPET_ESCAPE, '\\$&')}}`)).join('');
}

const BLANK = /\[\[(\d+)\]\]/g;
export const PLACEHOLDER = '___';

function completionHeader(code: string): string {
  const blanks = new Set([...code.matchAll(BLANK)].map((m) => m[1])).size;
  return blanks > 1 ? 'fill the blanks (Tab moves), then Ctrl+Enter' : 'fill the blank, then Ctrl+Enter';
}

/** Lines of comment text (lesson) above a completion, as snippet text plus the line count. */
function completionParts(prefix: string[], code: string, tok: CommentToken): { parts: SnippetPart[]; text: string; blankLines: number[]; codeStart: number } {
  const header = `${tok} ${completionHeader(code)}`;
  const head = [...prefix, header];
  const body = indentTo4(code.replace(/\r\n?/g, '\n').replace(/\s+$/, ''));
  const parts: SnippetPart[] = [];
  const blankLines: number[] = [];
  let text = head.join('\n') + '\n';
  let pending = text;
  let last = 0;
  for (const m of body.matchAll(BLANK)) {
    const before = body.slice(last, m.index);
    pending += before;
    text += before;
    if (pending) parts.push({ text: pending });
    pending = '';
    const n = Number(m[1]);
    blankLines[n - 1] ??= text.split('\n').length - 1;
    parts.push({ placeholder: n, value: PLACEHOLDER });
    text += PLACEHOLDER;
    last = m.index! + m[0].length;
  }
  const rest = body.slice(last);
  pending += rest;
  text += rest;
  if (pending) parts.push({ text: pending });
  return { parts, text, blankLines: [...blankLines].map((l) => l ?? -1), codeStart: head.length };
}

/** Completion: a snippet with 4-space indentation and ___ tab stops at the blanks. */
export function renderCompletion(completion: Pick<StoredCompletion, 'code'>, ctx: RenderContext, prefixComments: string[] = []): PadRender {
  const tok = tokenOf(ctx);
  const c = completionParts(prefixComments, completion.code, tok);
  return {
    text: c.text,
    snippet: c.parts,
    snippetText: snippetString(c.parts),
    await: 'answer',
    decorations: [],
    codeStart: c.codeStart,
    lineOffset: c.codeStart,
    blankLines: c.blankLines,
    answerLine: c.blankLines[0],
  };
}

/** After the second failure: the code with the solutions filled in, the fills highlighted. */
export function renderCompletionReveal(completion: Pick<StoredCompletion, 'code' | 'solutions'>, ctx: RenderContext): PadRender {
  const p = new Pad(tokenOf(ctx));
  p.comment('a fill that works');
  const body = indentTo4(completion.code.replace(/\r\n?/g, '\n').replace(/\s+$/, ''));
  const codeStart = p.next;
  const seen = new Set<number>();
  body.split('\n').forEach((line, i) => {
    let filled = line;
    for (const m of line.matchAll(BLANK)) {
      const n = Number(m[1]);
      const fill = completion.solutions[n - 1] ?? '';
      filled = filled.replace(m[0], fill);
      if (!seen.has(n)) {
        seen.add(n);
        p.deco(codeStart + i, `<- ${fill}`, 'reveal-fill');
      }
    }
    p.lines.push(filled);
  });
  p.deco(p.next - 1, CONTINUE_HINT, 'hint');
  return { text: p.text(), await: 'read', decorations: p.decorations, codeStart, lineOffset: codeStart };
}

/** Word-wrap a paragraph to comment lines of at most `width` characters of text. */
export function wrapText(text: string, width = 72): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const words = para.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length) continue;
    let line = '';
    for (const w of words) {
      if (line && line.length + 1 + w.length > width) {
        out.push(line);
        line = w;
      } else line = line ? `${line} ${w}` : w;
    }
    if (line) out.push(line);
    out.push('');
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/** Markdown to plain comment text: no headings, emphasis markers or code fences. */
function plainMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/^```.*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1$2');
}

/** The lesson as comment lines: title, explanation, the example (indented), the rule. */
export function lessonComments(lesson: LessonText, tok: CommentToken): string[] {
  const c = (s: string) => (s ? `${tok} ${s}` : tok);
  const lines: string[] = [];
  if (lesson.title.trim()) lines.push(c(lesson.title.trim()));
  for (const l of wrapText(plainMarkdown(lesson.explanation))) lines.push(c(l));
  const example = lesson.example.replace(/\r\n?/g, '\n').split('\n').filter((l) => !/^\s*```/.test(l));
  while (example.length && !example[0].trim()) example.shift();
  while (example.length && !example[example.length - 1].trim()) example.pop();
  if (example.length) {
    lines.push(tok);
    for (const l of example) lines.push(`${tok}     ${l.trimEnd()}`.trimEnd());
  }
  if (lesson.rule.trim()) {
    lines.push(tok);
    lines.push(c(`Rule: ${lesson.rule.trim()}`));
  }
  lines.push(tok);
  return lines;
}

/**
 * ESCALATE: the lesson as a comment block above a fresh completion; '# preparing a short lesson...
 * (~10 s)' while it has not landed (pending: the pad waits; nothing is nested). Without a lesson
 * (the job failed) the completion shows on its own.
 */
export function renderEscalate(
  lesson: LessonText | undefined,
  completion: Pick<StoredCompletion, 'code'> | undefined,
  ctx: RenderContext,
  pending = false,
): PadRender {
  const tok = tokenOf(ctx);
  if (pending) return { text: `${tok} ${LESSON_PENDING}`, await: 'read', decorations: [] };
  if (!lesson && !completion) return { text: `${tok} ${CONTINUE_HINT}`, await: 'read', decorations: [] };
  const block = lesson ? lessonComments(lesson, tok) : [];
  if (!completion) {
    const lines = [...block];
    const r: PadRender = { text: lines.join('\n'), await: 'read', decorations: [] };
    r.decorations.push({ line: Math.max(0, lines.length - 1), text: CONTINUE_HINT, kind: 'hint' });
    return r;
  }
  return renderCompletion(completion, ctx, block);
}

// ---------------------------------------------------------------- tracebacks

/** Traceback item: code, the real trace (renumbered to pad lines) and '# -> line ?, ?'. */
export function renderTraceback(item: Pick<TracebackItem, 'code' | 'trace'>, ctx: RenderContext, answer?: string): PadRender {
  const p = new Pad(tokenOf(ctx));
  p.comment(TRACEBACK_HEADER);
  const codeStart = p.code(item.code);
  p.comment();
  for (const l of renumberTrace(item.trace, codeStart).split('\n')) p.comment(l.trimEnd());
  const body = answer ?? 'line ?, ?';
  const answerLine = p.answer(body);
  const r: PadRender = { text: p.text(), await: 'answer', answerLine, decorations: p.decorations, codeStart, lineOffset: codeStart };
  const q = p.lines[answerLine].indexOf('?');
  if (answer === undefined && q >= 0) {
    r.answerColumn = q;
    r.answerSelectEnd = q + 1;
  } else r.answerColumn = p.lines[answerLine].length;
  return r;
}

/** After 'line N, Name': '# What does <Name> mean?  1 / 2 / 3' with the three meanings. */
export function renderTracebackMeaning(item: Pick<TracebackItem, 'code' | 'trace' | 'exception' | 'meanings' | 'correctMeaning'>, answer: string, ctx: RenderContext): PadRender {
  const base = renderTraceback(item, ctx, answer.replace(/^\s*(?:#|\/\/)\s*->\s?/, ''));
  const tok = tokenOf(ctx);
  const lines = base.text.split('\n');
  const q = lines.length;
  lines.push(`${tok} What does ${item.exception} mean?  ${item.meanings.map((_, i) => i + 1).join(' / ')}`);
  item.meanings.forEach((m, i) => lines.push(`${tok} ${i + 1}  ${m}`));
  return {
    ...base,
    text: lines.join('\n'),
    await: item.meanings.length === 2 ? 'pick2' : 'pick3',
    answerLine: q,
    answerColumn: lines[q].length,
    answerSelectEnd: undefined,
    correctPick: item.correctMeaning + 1,
  };
}

// ---------------------------------------------------------------- feedback

export type Feedback =
  | { kind: 'correct'; ms?: number; guess?: boolean }
  | { kind: 'wrong'; actual: string }
  | { kind: 'format'; note: string }
  | { kind: 'assisted' }
  | { kind: 'empty'; message?: string }
  | { kind: 'check'; message: string; blank?: number }
  | { kind: 'note'; text: string };

/** The decoration for one piece of feedback on a given (0-based) line. */
export function feedbackDecoration(fb: Feedback, line: number): PadDecoration {
  const d = (text: string, kind: DecorationKind): PadDecoration => decoration(line, text, kind);
  switch (fb.kind) {
    case 'correct': {
      const s = fb.ms !== undefined && Number.isFinite(fb.ms) ? ` ${Math.max(1, Math.round(fb.ms / 1000))}s` : '';
      return d(`ok${s}${fb.guess ? ' (flagged as a guess)' : ''}`, 'correct');
    }
    case 'wrong':
      return d(`actual: ${fb.actual}`, 'wrong');
    case 'format':
      return d(fb.note, 'format');
    case 'assisted':
      return d(ASSISTED_NOTE, 'note');
    case 'empty':
      return d(fb.message ?? EMPTY_REPROMPT, 'note');
    case 'check':
      return d(fb.message, 'check');
    case 'note':
      return d(fb.text, 'note');
  }
}

// ---------------------------------------------------------------- views (what the step machine asks for)

export type PadView =
  | { kind: 'probe'; probe: Pick<StoredProbe, 'code'>; header?: string }
  | ({ kind: 'belief-check' } & BeliefCheckView)
  | { kind: 'contrast-pick'; contrast: StoredContrast; rightFirst: boolean }
  | ({ kind: 'reveal' } & RevealView)
  | { kind: 'example'; example: Pick<StoredExample, 'code' | 'subgoals' | 'output'>; pattern: AtomPattern }
  | { kind: 'completion'; completion: Pick<StoredCompletion, 'code'> }
  | { kind: 'completion-reveal'; completion: Pick<StoredCompletion, 'code' | 'solutions'> }
  | { kind: 'escalate'; lesson?: LessonText; completion?: Pick<StoredCompletion, 'code'>; /** The lesson has not landed yet. */ pending?: boolean }
  | { kind: 'traceback'; item: Pick<TracebackItem, 'code' | 'trace'> }
  | { kind: 'traceback-meaning'; item: Pick<TracebackItem, 'code' | 'trace' | 'exception' | 'meanings' | 'correctMeaning'>; answer: string }
  | { kind: 'typing'; literal: string };

export function renderView(view: PadView, ctx: RenderContext): PadRender {
  switch (view.kind) {
    case 'probe':
      return renderProbe(view.probe, ctx, view.header);
    case 'belief-check':
      return renderBeliefCheck(view, ctx);
    case 'contrast-pick':
      return renderContrastPick(view.contrast, view.rightFirst, ctx);
    case 'reveal':
      return renderReveal(view, ctx);
    case 'example':
      return renderExample(view.example, view.pattern, ctx);
    case 'completion':
      return renderCompletion(view.completion, ctx);
    case 'completion-reveal':
      return renderCompletionReveal(view.completion, ctx);
    case 'escalate':
      return renderEscalate(view.lesson, view.completion, ctx, view.pending);
    case 'traceback':
      return renderTraceback(view.item, ctx);
    case 'traceback-meaning':
      return renderTracebackMeaning(view.item, view.answer, ctx);
    case 'typing':
      return renderTyping(view.literal, ctx);
  }
}
