import * as vscode from 'vscode';
import type { Lang, PauseKind } from './contracts';
import { contentHash, detectRung0, errorHash, projectFileResolver, type DiagnosticAge, type Rung0, type TerminalRunInfo } from './hints';
import { findTopLevelFunctions } from './specsCore';
import { StuckDetector } from './stuck';
import { savePause } from './tempo';

const TERMINAL_OUTPUT_LIMIT = 4000;
const SEC = 1000;
const MIN = 60 * SEC;
const TICK_MS = 5 * SEC;

// =====================================================================================
// Pure helpers (exported for test/monitorPure.test.ts)
// =====================================================================================

/** Paste: at least this many net-new non-whitespace characters equal to the clipboard. */
export const PASTE_MIN = 120;
/** Assisted insert in a project file: at least this many net-new non-whitespace characters, not the clipboard. */
export const ASSISTED_MIN = 40;
/** A paste of text deleted from a task file within this window is a move, not a paste. */
export const MOVE_WINDOW_MS = 2 * MIN;
/** A snippet the coach registered with expectInsert() is ignored for this long. */
export const COACH_INSERT_TTL_MS = 10 * SEC;
/** Clean idle that counts as a pause. */
export const IDLE_PAUSE_MS = 20 * SEC;
/** Terminal runs kept per task (rung 0 needs two of them). */
export const MAX_TERMINAL_RUNS = 20;

export function nonWsString(s: string): string {
  return s.replace(/\s+/g, '');
}

export function nonWsCount(s: string): number {
  return nonWsString(s).length;
}

export function lineBreaks(s: string): number {
  return s.match(/\r\n|\r|\n/g)?.length ?? 0;
}

/** One entry of TextDocumentChangeEvent.contentChanges, flattened (range refers to the text before this change). */
export interface RangeChange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  text: string;
}

/** String offset of a 0-based position, clamped to the text (line ends exclude '\r\n'). */
export function offsetAt(text: string, line: number, character: number): number {
  let start = 0;
  for (let l = 0; l < line; l++) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) return text.length;
    start = nl + 1;
  }
  let end = text.indexOf('\n', start);
  if (end < 0) end = text.length;
  else if (end > start && text[end - 1] === '\r') end--;
  return Math.min(start + Math.max(0, character), end);
}

/** Apply one change to a shadow copy (VS Code applies an event's changes in order). */
export function applyChange(text: string, c: RangeChange): { text: string; replaced: string } {
  const s = offsetAt(text, c.startLine, c.startCharacter);
  const e = Math.max(s, offsetAt(text, c.endLine, c.endCharacter));
  return { text: text.slice(0, s) + c.text + text.slice(e), replaced: text.slice(s, e) };
}

/**
 * Net-new non-whitespace characters: n = nonWs(inserted) - nonWs(replaced). When the replaced
 * text is unknown (no shadow yet), every replaced character is assumed non-whitespace, so n is
 * never overstated.
 */
export function netNew(inserted: string, replaced: string | undefined, rangeLength = 0): number {
  return nonWsCount(inserted) - (replaced !== undefined ? nonWsCount(replaced) : rangeLength);
}

/** Range of the inserted text in the document after the change (0-based). */
export function insertedRange(c: Pick<RangeChange, 'startLine' | 'startCharacter' | 'text'>): {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
} {
  const parts = c.text.split(/\r\n|\r|\n/);
  const last = parts[parts.length - 1];
  return {
    startLine: c.startLine,
    startCharacter: c.startCharacter,
    endLine: c.startLine + parts.length - 1,
    endCharacter: parts.length === 1 ? c.startCharacter + last.length : last.length,
  };
}

/** Texts seen recently (deleted text for move detection; coach snippets), compared without whitespace. */
export class RecentTexts {
  private items: { text: string; at: number }[] = [];
  constructor(
    private readonly ttlMs: number,
    private readonly cap = 50,
  ) {}

  add(text: string, at: number): void {
    const t = nonWsString(text);
    if (!t) return;
    this.items.push({ text: t, at });
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }

  has(text: string, now: number): boolean {
    this.prune(now);
    const t = nonWsString(text);
    return !!t && this.items.some((x) => x.text === t);
  }

  prune(now: number): void {
    this.items = this.items.filter((x) => now - x.at <= this.ttlMs && x.at <= now + this.ttlMs);
  }

  clear(): void {
    this.items = [];
  }
}

export interface InsertFacts {
  /** Net-new non-whitespace characters (netNew()). */
  n: number;
  /** The inserted text. */
  text: string;
  /** TextDocumentChangeEvent.reason was Undo or Redo. */
  undoRedo: boolean;
  /** The document was not dirty after the change (reloaded from disk, e.g. git checkout). */
  reloaded: boolean;
  /** Equal to text deleted from a task file in the last 2 minutes (cut and paste, drag and drop). */
  move: boolean;
  /** Already present in a task file before the change (copy line down, duplicating own code). */
  ownCopy: boolean;
  /** A snippet the coach inserted. */
  coachInsert: boolean;
  /** env.clipboard.readText(), or undefined when it could not be read. */
  clipboard: string | undefined;
}

/**
 * Passive source (b) of spec V1-3:
 * - paste: n >= 120, the text equals the clipboard (whitespace-insensitive, so re-indentation on
 *   paste still matches), and it is not a move;
 * - assisted: n >= 40, not the clipboard, not a coach snippet.
 * Undo/redo, reloads from disk, moves and copies of the learner's own task-file text never count.
 * With an unreadable clipboard, only an insert big enough to be a paste is reported (as a paste).
 */
export function classifyInsert(f: InsertFacts): 'paste' | 'assisted' | undefined {
  if (f.undoRedo || f.reloaded || f.move || f.ownCopy || f.coachInsert) return undefined;
  if (f.n < ASSISTED_MIN) return undefined;
  if (f.clipboard === undefined) return f.n >= PASTE_MIN ? 'paste' : undefined;
  const clip = nonWsString(f.clipboard);
  if (clip && clip === nonWsString(f.text)) return f.n >= PASTE_MIN ? 'paste' : undefined;
  return 'assisted';
}

/** Lines one change touches (whole-line deletions count once per line). */
export function changedLineCount(c: RangeChange): number {
  const breaks = lineBreaks(c.text);
  const endsWithBreak = /(\r\n|\r|\n)$/.test(c.text);
  const wholeLines = c.startCharacter === 0 && c.endCharacter === 0 && (c.endLine > c.startLine || endsWithBreak);
  if (wholeLines) {
    // Whole lines replaced by whole lines (the line after the range only moves): every removed
    // or inserted line counts once.
    const inserted = c.text === '' ? 0 : breaks + (endsWithBreak ? 0 : 1);
    return Math.max(c.endLine - c.startLine, inserted);
  }
  const touchedNew = breaks + 1;
  const removed = Math.max(0, c.endLine - c.startLine - breaks);
  return touchedNew + removed;
}

/**
 * Monotonic count of changed lines. mark() returns a snapshot, changedLinesSince(mark) the lines
 * changed since, so several consumers can keep their own marks. Typing along one line counts it
 * once; whitespace-only changes (formatters) count nothing when the replaced text is known.
 */
export class EditCounter {
  private total = 0;
  private last: { uri: string; line: number } | undefined;

  record(uri: string, c: RangeChange, replaced?: string): number {
    const endLine = c.startLine + lineBreaks(c.text);
    if (replaced !== undefined && nonWsString(replaced) === nonWsString(c.text)) {
      this.last = { uri, line: endLine };
      return 0;
    }
    let n = changedLineCount(c);
    if (n > 0 && this.last && this.last.uri === uri && this.last.line === c.startLine) n--;
    this.last = { uri, line: endLine };
    this.total += n;
    return n;
  }

  mark(): number {
    return this.total;
  }

  changedLinesSince(mark: number): number {
    return Math.max(0, this.total - mark);
  }
}

/**
 * Save reasons from onWillSaveTextDocument, consumed in onDidSaveTextDocument.
 * Reasons are TextDocumentSaveReason values: Manual = 1, AfterDelay = 2, FocusOut = 3.
 */
export class SaveReasons {
  private readonly pending = new Map<string, number>();
  private readonly last = new Map<string, number>();

  will(uri: string, reason: number): void {
    this.pending.set(uri, reason);
  }

  /** The save happened: returns (and forgets) the pending reason, remembering it as the last one. */
  did(uri: string): number | undefined {
    const r = this.pending.get(uri);
    this.pending.delete(uri);
    if (r === undefined) this.last.delete(uri);
    else this.last.set(uri, r);
    return r;
  }

  lastReason(uri: string): number | undefined {
    return this.last.get(uri);
  }
}

/** Pause kind for a finished save (only a manual save with 0 errors is a pause). */
export function savePauseFor(reason: number | undefined, errorCount: number): PauseKind | undefined {
  return reason === undefined ? undefined : savePause(reason, errorCount);
}

function failed(code: number | undefined): boolean {
  return code !== undefined && code !== 0;
}

/**
 * A terminal command succeeding after a failure is a pause: the run just before it failed (any
 * command, e.g. a fixed `python cli.py --name x` after `python cli.py` crashed), or the last run of
 * this same command failed (a `cls` or `ls` in between). Unknown exit codes are neither.
 */
export function terminalPause(
  history: readonly Pick<TerminalRunInfo, 'command' | 'exitCode'>[],
  run: Pick<TerminalRunInfo, 'command' | 'exitCode'>,
): boolean {
  if (run.exitCode !== 0 || !history.length) return false;
  if (failed(history[history.length - 1].exitCode)) return true;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].command === run.command) return failed(history[i].exitCode);
  }
  return false;
}

export interface IdleInput {
  now: number;
  /** Last edit of a code file, or the monitor's start when there was none. */
  idleSince: number;
  errorCount: number;
  focused: boolean;
  /** idleSince value an idle pause was already fired for. */
  firedFor?: number;
}

/** 20 s with no edit and no errors (window focused) is a pause, once per quiet period. */
export function idlePauseDue(i: IdleInput): boolean {
  return i.focused && i.errorCount === 0 && i.now - i.idleSince >= IDLE_PAUSE_MS && i.firedFor !== i.idleSince;
}

/** One document change event, flattened (no vscode types). */
export interface DocChange {
  /** Document uri string. */
  key: string;
  changes: readonly (RangeChange & { rangeLength: number })[];
  /** TextDocumentChangeEvent.reason was set (Undo / Redo). */
  undoRedo: boolean;
  /** The document is not dirty after the change (reloaded from disk). */
  reloaded: boolean;
  now: number;
  /** The document's full text after the change (read only when needed). */
  text: () => string;
}

/** A big insert waiting for the clipboard check. */
export interface InsertCandidate {
  n: number;
  text: string;
  ownCopy: boolean;
  move: boolean;
  coachInsert: boolean;
  range: ReturnType<typeof insertedRange>;
}

export interface DetectedInsert {
  kind: 'paste' | 'assisted';
  chars: number;
  range: ReturnType<typeof insertedRange>;
}

/**
 * Shadow copies, the changed-lines counter and the paste / assisted-insert rules of spec V1-3 (b),
 * without vscode. The Monitor feeds it every code-document change; a shadow exists for each task
 * file (setShadow) and for every document once it has been changed. Without a shadow the replaced
 * text is unknown and n is computed conservatively.
 */
export class InsertTracker {
  readonly edits = new EditCounter();
  private readonly shadows = new Map<string, string>();
  private readonly deleted = new RecentTexts(MOVE_WINDOW_MS);
  private readonly coach = new RecentTexts(COACH_INSERT_TTL_MS);

  hasShadow(key: string): boolean {
    return this.shadows.has(key);
  }

  setShadow(key: string, text: string): void {
    this.shadows.set(key, text);
  }

  dropShadow(key: string): void {
    this.shadows.delete(key);
  }

  /** Keep only the shadows `keep` accepts. */
  retainShadows(keep: (key: string) => boolean): void {
    for (const key of [...this.shadows.keys()]) if (!keep(key)) this.shadows.delete(key);
  }

  /** Text the coach is about to insert: never counted as assisted. */
  expectInsert(text: string, now: number): void {
    this.coach.add(text, now);
  }

  /** Forget recent deletions (a new task). */
  clearMoves(): void {
    this.deleted.clear();
  }

  /**
   * Apply one change event: update the shadow and the edit counter, remember deleted text (moves),
   * and return the inserts big enough to need the clipboard check.
   */
  onChange(e: DocChange): InsertCandidate[] {
    const before = this.shadows.get(e.key);
    let shadow = before;
    const applied: { c: RangeChange; replaced: string | undefined; rangeLength: number }[] = [];
    for (const c of e.changes) {
      let replaced: string | undefined;
      if (shadow !== undefined) {
        const r = applyChange(shadow, c);
        shadow = r.text;
        replaced = r.replaced;
      }
      applied.push({ c, replaced, rangeLength: c.rangeLength });
      this.edits.record(e.key, c, replaced);
    }

    // Deleted text first, so a move inside one event (drag and drop) is recognised.
    if (!e.undoRedo) for (const x of applied) if (x.replaced && nonWsCount(x.replaced) >= ASSISTED_MIN) this.deleted.add(x.replaced, e.now);

    const out: InsertCandidate[] = [];
    if (!e.undoRedo && !e.reloaded) {
      for (const x of applied) {
        const n = netNew(x.c.text, x.replaced, x.rangeLength);
        if (n < ASSISTED_MIN) continue;
        out.push({
          n,
          text: x.c.text,
          ownCopy: this.isOwnText(x.c.text, e.key, before),
          move: this.deleted.has(x.c.text, e.now),
          coachInsert: this.coach.has(x.c.text, e.now),
          range: insertedRange(x.c),
        });
      }
    }

    // The shadow after the event is the document itself: any drift in the replay heals at once,
    // and a document without a shadow gets one from its first change on.
    this.shadows.set(e.key, e.text());
    return out;
  }

  /** Classify candidates once the clipboard has been read (undefined = unreadable). */
  classify(candidates: readonly InsertCandidate[], clipboard: string | undefined): DetectedInsert[] {
    const out: DetectedInsert[] = [];
    for (const c of candidates) {
      const kind = classifyInsert({ n: c.n, text: c.text, undoRedo: false, reloaded: false, move: c.move, ownCopy: c.ownCopy, coachInsert: c.coachInsert, clipboard });
      if (kind) out.push({ kind, chars: c.n, range: c.range });
    }
    return out;
  }

  /** Is the text already in a shadowed file (the edited document as it was before this change)? */
  private isOwnText(text: string, editedKey: string, editedBefore: string | undefined): boolean {
    const t = nonWsString(text);
    if (!t) return false;
    for (const [key, s] of this.shadows) {
      const src = key === editedKey ? editedBefore : s;
      if (src !== undefined && nonWsString(src).includes(t)) return true;
    }
    return false;
  }
}

/** A DocumentSymbol (or SymbolInformation flattened to one), reduced to what overlap needs. */
export interface SymbolLike {
  name: string;
  /** vscode.SymbolKind */
  kind: number;
  range: { start: { line: number }; end: { line: number } };
  children?: readonly SymbolLike[];
}

/** vscode.SymbolKind values of callables: Method 5, Constructor 8, Function 11. */
const CALLABLE_KINDS: ReadonlySet<number> = new Set([5, 8, 11]);

/**
 * Names of the functions (and methods) whose range overlaps lines startLine..endLine (0-based,
 * inclusive), at any depth, in document order without duplicates. An insert that writes a whole
 * new function overlaps that function.
 */
export function overlappingFunctions(symbols: readonly SymbolLike[] | undefined, startLine: number, endLine: number): string[] {
  const out: string[] = [];
  const walk = (list: readonly SymbolLike[] | undefined) => {
    for (const s of list ?? []) {
      const overlaps = s.range.start.line <= endLine && s.range.end.line >= startLine;
      if (!overlaps) continue;
      if (CALLABLE_KINDS.has(s.kind) && s.name && !out.includes(s.name)) out.push(s.name);
      walk(s.children);
    }
  };
  walk(symbols);
  return out;
}

/** Task language of a document languageId, for the regex fallback (undefined = no fallback). */
export function langOfLanguageId(languageId: string): Lang | undefined {
  if (languageId === 'python') return 'python';
  if (languageId === 'javascript' || languageId === 'javascriptreact') return 'javascript';
  if (languageId === 'typescript' || languageId === 'typescriptreact') return 'typescript';
  return undefined;
}

// =====================================================================================
// Monitor
// =====================================================================================

export interface PauseEvent {
  kind: PauseKind;
  at: number;
}

export interface SaveEvent {
  uri: vscode.Uri;
  /** TextDocumentSaveReason recorded in onWillSaveTextDocument (undefined if none was seen). */
  reason: vscode.TextDocumentSaveReason | undefined;
  /** reason === Manual. Auto-saves (AfterDelay, FocusOut) and unknown reasons are false. */
  manual: boolean;
  /** Error-severity diagnostics in the saved document. */
  errorCount: number;
}

export interface InsertEvent {
  kind: 'paste' | 'assisted';
  /** Net-new non-whitespace characters. */
  chars: number;
  uri: vscode.Uri;
  /** Where the inserted text now is. */
  range: vscode.Range;
  /**
   * Functions the insert landed in (document symbols, else the top-level regex fallback), by the
   * learner's names. For 'assisted', the coach adds them to task.assistedFunctions.
   */
  functions: string[];
}

/**
 * Watches the editor, diagnostics and terminal, feeding a StuckDetector.
 * Also remembers which files changed during the current task so the coach can
 * look at what the learner actually wrote, detects pauses for the tempo bar, counts changed
 * lines, and reports pasted / assisted inserts (shadow copies of task files).
 */
export class Monitor implements vscode.Disposable {
  detector = new StuckDetector();
  readonly touchedFiles = new Set<string>();
  /** When the learner last changed any file (to flag terminal output older than the code). */
  lastEditAt = 0;
  private disposables: vscode.Disposable[] = [];
  private focused = vscode.window.state.focused;
  private readonly startedAt = Date.now();
  private readonly onTickEmitter = new vscode.EventEmitter<number>();
  /** Fires every tick with the ms of active time added. */
  readonly onTick = this.onTickEmitter.event;
  private readonly onPauseEmitter = new vscode.EventEmitter<PauseEvent>();
  /** Real pauses: manual clean save, terminal success after a failure, 20 s clean idle (and notePause()). */
  readonly onPause = this.onPauseEmitter.event;
  private readonly onSaveEmitter = new vscode.EventEmitter<SaveEvent>();
  /** Every save of a code file, with the reason from onWillSaveTextDocument. */
  readonly onSave = this.onSaveEmitter.event;
  private readonly onInsertEmitter = new vscode.EventEmitter<InsertEvent>();
  /** Pasted or assisted inserts in code files (passive evidence; never shown as a message). */
  readonly onInsert = this.onInsertEmitter.event;

  private readonly saves = new SaveReasons();
  private readonly inserts = new InsertTracker();
  private taskFiles = new Set<string>();
  private runs: TerminalRunInfo[] = [];
  private readonly errorSeen = new Map<string, DiagnosticAge>();
  private idleFiredFor: number | undefined;
  private disposed = false;

  constructor() {
    const d = this.disposables;
    d.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChange(e)),
      vscode.workspace.onDidOpenTextDocument((doc) => {
        const key = doc.uri.toString();
        if (isCode(doc.uri) && (this.taskFiles.has(key) || this.touchedFiles.has(key))) this.inserts.setShadow(key, doc.getText());
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.inserts.dropShadow(doc.uri.toString())),
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (isCode(e.document.uri)) this.saves.will(e.document.uri.toString(), e.reason);
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onDidSave(doc)),
      vscode.languages.onDidChangeDiagnostics(() => this.refreshDiagnostics()),
      vscode.window.onDidChangeWindowState((s) => {
        this.focused = s.focused;
        if (s.focused) this.detector.activity(Date.now());
      }),
      vscode.window.onDidChangeTextEditorSelection(() => this.detector.activity(Date.now())),
      vscode.window.onDidChangeActiveTextEditor(() => this.detector.activity(Date.now())),
      this.onTickEmitter,
      this.onPauseEmitter,
      this.onSaveEmitter,
      this.onInsertEmitter,
    );

    // Shell integration (VS Code 1.93+) gives us command lines, exit codes and output.
    // It only fires in terminals where shell integration is active.
    const outputs = new WeakMap<vscode.TerminalShellExecution, Promise<string>>();
    d.push(
      vscode.window.onDidStartTerminalShellExecution((e) => {
        outputs.set(e.execution, readTail(e.execution.read()));
        this.detector.activity(Date.now());
      }),
      vscode.window.onDidEndTerminalShellExecution(async (e) => {
        const output = (await outputs.get(e.execution)) ?? '';
        const now = Date.now();
        const run: TerminalRunInfo = {
          at: now,
          command: e.execution.commandLine.value.trim(),
          exitCode: e.exitCode,
          output,
          cwd: e.execution.cwd?.scheme === 'file' ? e.execution.cwd.fsPath : undefined,
        };
        const pause = terminalPause(this.runs, run);
        this.runs.push(run);
        if (this.runs.length > MAX_TERMINAL_RUNS) this.runs.splice(0, this.runs.length - MAX_TERMINAL_RUNS);
        this.detector.onTerminal(now, run.command, run.exitCode, output);
        if (pause) this.notePause('terminal-ok', now);
      }),
    );

    const timer = setInterval(() => {
      const now = Date.now();
      const added = this.detector.tick(now, this.focused);
      this.onTickEmitter.fire(added);
      this.checkIdle(now);
    }, TICK_MS);
    d.push({ dispose: () => clearInterval(timer) });
  }

  /** Start a fresh observation window for a new task. */
  startTask(): void {
    this.detector = new StuckDetector();
    this.touchedFiles.clear();
    this.runs = [];
    this.inserts.clearMoves();
    this.refreshDiagnostics();
  }

  // ---------------------------------------------------------------- task files and shadows

  /** The current task's files (uris or uri strings). Shadow copies are kept for them (and for every touched code file). */
  setTaskFiles(uris: readonly (string | vscode.Uri)[]): void {
    this.taskFiles = new Set(uris.map(uriString));
    this.inserts.retainShadows((key) => this.taskFiles.has(key) || this.touchedFiles.has(key));
    for (const doc of vscode.workspace.textDocuments) {
      const key = doc.uri.toString();
      if (this.taskFiles.has(key) && isCode(doc.uri) && !this.inserts.hasShadow(key)) this.inserts.setShadow(key, doc.getText());
    }
  }

  /** Register text the coach is about to insert itself, so it is never counted as assisted. */
  expectInsert(text: string): void {
    this.inserts.expectInsert(text, Date.now());
  }

  // ---------------------------------------------------------------- edit counter

  /** Edit-counter snapshot (pass it to changedLinesSince later). */
  mark(): number {
    return this.inserts.edits.mark();
  }

  /** Lines changed in code files since mark(). */
  changedLinesSince(mark: number): number {
    return this.inserts.edits.changedLinesSince(mark);
  }

  // ---------------------------------------------------------------- saves and pauses

  /** Reason of the last save of this document (TextDocumentSaveReason), if known. */
  lastSaveReason(uri: vscode.Uri | string): vscode.TextDocumentSaveReason | undefined {
    return this.saves.lastReason(typeof uri === 'string' ? uri : uri.toString());
  }

  /** Report a pause that happens elsewhere (the spec controller's red -> green), so all pauses flow through onPause. */
  notePause(kind: PauseKind, at = Date.now()): void {
    this.onPauseEmitter.fire({ kind, at });
  }

  // ---------------------------------------------------------------- errors and terminal

  currentErrors(): { file: string; line: number; message: string }[] {
    const out: { file: string; line: number; message: string }[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== 'file') continue;
      for (const dg of diags) {
        if (dg.severity !== vscode.DiagnosticSeverity.Error) continue;
        out.push({ file: vscode.workspace.asRelativePath(uri), line: dg.range.start.line + 1, message: dg.message });
      }
    }
    return out;
  }

  /** errorHash() of the current error set (file + message, sorted). */
  errorSetHash(): string {
    return errorHash(this.currentErrors());
  }

  /**
   * contentHash of the task files (CRLF-normalised text, open buffer or disk) plus the sorted error
   * set. Computed from the files, never from a rendered prompt. Unreadable files hash as empty.
   */
  async taskFileHash(files: readonly (string | vscode.Uri)[]): Promise<string> {
    const texts = await Promise.all(
      [...new Set(files.map(uriString))].map(async (key) => {
        const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === key);
        if (open) return { key, text: open.getText() };
        try {
          const uri = vscode.Uri.parse(key);
          if (uri.scheme !== 'file') return { key, text: '' };
          return { key, text: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) };
        } catch {
          return { key, text: '' };
        }
      }),
    );
    return contentHash(texts, this.currentErrors());
  }

  /** Error diagnostics in workspace files with the time each was first seen (rung 0). */
  errorAges(): DiagnosticAge[] {
    return [...this.errorSeen.values()].map((e) => ({ ...e }));
  }

  /** Terminal runs of this task (shell integration), oldest first. */
  terminalRuns(): readonly TerminalRunInfo[] {
    return this.runs;
  }

  /**
   * Rung 0 (spec V1-10): a persistent project error, from this task's terminal runs (the same
   * exception twice, via runner.ts parseException on the output tail) or an Error diagnostic
   * present for 1+ minute. File paths are workspace-relative, lines 1-based.
   */
  rung0(lang?: Lang, now = Date.now()): Rung0 | undefined {
    const roots = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => ({ name: f.name, fsPath: f.uri.fsPath }));
    return detectRung0({ now, lang, runs: this.runs, diagnostics: this.errorAges(), toProjectFile: projectFileResolver(roots) });
  }

  // ---------------------------------------------------------------- internals

  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    if (!isCode(e.document.uri) || e.contentChanges.length === 0) return;
    const now = Date.now();
    const key = e.document.uri.toString();
    let inserted = 0;
    let deleted = 0;
    for (const c of e.contentChanges) {
      inserted += c.text.replace(/\s/g, '').length;
      deleted += c.rangeLength;
    }
    this.touchedFiles.add(key);
    this.lastEditAt = now;
    this.detector.onEdit(now, inserted, deleted);

    const candidates = this.inserts.onChange({
      key,
      changes: e.contentChanges.map((ch) => ({
        startLine: ch.range.start.line,
        startCharacter: ch.range.start.character,
        endLine: ch.range.end.line,
        endCharacter: ch.range.end.character,
        text: ch.text,
        rangeLength: ch.rangeLength,
      })),
      undoRedo: e.reason !== undefined,
      reloaded: !e.document.isDirty,
      now,
      text: () => e.document.getText(),
    });
    if (candidates.length) void this.classify(e.document, candidates);
  }

  private async classify(doc: vscode.TextDocument, candidates: InsertCandidate[]): Promise<void> {
    let clipboard: string | undefined;
    try {
      clipboard = await vscode.env.clipboard.readText();
    } catch {
      clipboard = undefined;
    }
    const found = this.inserts.classify(candidates, clipboard);
    if (!found.length) return;
    const symbols = await documentFunctions(doc);
    for (const d of found) {
      const r = d.range;
      if (this.disposed) return;
      this.onInsertEmitter.fire({
        kind: d.kind,
        chars: d.chars,
        uri: doc.uri,
        range: new vscode.Range(r.startLine, r.startCharacter, r.endLine, r.endCharacter),
        functions: overlappingFunctions(symbols, r.startLine, r.endLine),
      });
    }
  }

  private onDidSave(doc: vscode.TextDocument): void {
    if (!isCode(doc.uri)) return;
    const reason = this.saves.did(doc.uri.toString()) as vscode.TextDocumentSaveReason | undefined;
    const errorCount = vscode.languages.getDiagnostics(doc.uri).filter((dg) => dg.severity === vscode.DiagnosticSeverity.Error).length;
    this.onSaveEmitter.fire({ uri: doc.uri, reason, manual: reason === vscode.TextDocumentSaveReason.Manual, errorCount });
    const pause = savePauseFor(reason, errorCount);
    if (pause) this.notePause(pause);
  }

  private checkIdle(now: number): void {
    const idleSince = Math.max(this.lastEditAt, this.startedAt);
    if (!this.focused || now - idleSince < IDLE_PAUSE_MS || this.idleFiredFor === idleSince) return;
    const errorCount = this.currentErrors().length;
    if (idlePauseDue({ now, idleSince, errorCount, focused: this.focused, firedFor: this.idleFiredFor })) {
      this.idleFiredFor = idleSince;
      this.notePause('idle', now);
    }
  }

  private refreshDiagnostics(): void {
    const now = Date.now();
    this.detector.onDiagnostics(
      now,
      this.currentErrors().map((e) => `${e.file}: ${e.message}`),
    );
    // First-seen times of workspace errors (moved errors keep their age; rung 0 needs 1+ min).
    const current = new Map<string, DiagnosticAge>();
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== 'file' || !inWorkspace(uri)) continue;
      const file = vscode.workspace.asRelativePath(uri);
      for (const dg of diags) {
        if (dg.severity !== vscode.DiagnosticSeverity.Error) continue;
        const k = `${uri.toString()}\u0000${dg.message}`;
        if (current.has(k)) continue;
        const prev = this.errorSeen.get(k);
        current.set(k, { file, line: dg.range.start.line + 1, message: dg.message, firstSeen: prev?.firstSeen ?? now });
      }
    }
    this.errorSeen.clear();
    for (const [k, v] of current) this.errorSeen.set(k, v);
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
  }
}

/** Symbol providers that never answer must not hold an insert event back for long. */
const SYMBOL_TIMEOUT_MS = 1500;

/** Function symbols of a document: the symbol provider, else the stage-1 top-level regex fallback. */
async function documentFunctions(doc: vscode.TextDocument): Promise<SymbolLike[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), SYMBOL_TIMEOUT_MS);
    });
    const request = Promise.resolve(
      vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>('vscode.executeDocumentSymbolProvider', doc.uri),
    ).catch(() => undefined);
    const symbols = await Promise.race([request, timeout]);
    if (symbols?.length) {
      return symbols.map((s) => ('location' in s ? { name: s.name, kind: s.kind, range: s.location.range } : (s as SymbolLike)));
    }
  } catch {
    // fall through to the regex fallback
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const lang = langOfLanguageId(doc.languageId);
  if (!lang) return [];
  try {
    return findTopLevelFunctions(doc.getText(), lang).map((f) => ({
      name: f.name,
      kind: 11,
      range: { start: { line: f.startLine }, end: { line: f.endLine } },
    }));
  } catch {
    return [];
  }
}

function uriString(u: string | vscode.Uri): string {
  return typeof u === 'string' ? u : u.toString();
}

/** Saved files and unsaved "Untitled" buffers count as the learner's code. */
export function isCode(uri: { scheme: string }): boolean {
  return uri.scheme === 'file' || uri.scheme === 'untitled';
}

function inWorkspace(uri: vscode.Uri): boolean {
  const folders = vscode.workspace.workspaceFolders;
  return !folders?.length || vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

async function readTail(stream: AsyncIterable<string>): Promise<string> {
  let buf = '';
  try {
    for await (const chunk of stream) {
      buf += chunk;
      if (buf.length > TERMINAL_OUTPUT_LIMIT * 2) buf = buf.slice(-TERMINAL_OUTPUT_LIMIT);
    }
  } catch {
    // Terminal closed mid-command; keep what we have.
  }
  // Strip ANSI escape sequences so the model sees plain text. OSC sequences (shell integration's
  // 633) end with BEL or ST (ESC \); stopping at either keeps the text after an ST-terminated one.
  // eslint-disable-next-line no-control-regex
  return buf.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').slice(-TERMINAL_OUTPUT_LIMIT);
}
