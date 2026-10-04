// The VS Code side of the Atom Pad (spec V1-6 SURFACE, KEYS, FEEDBACK DECORATIONS, EXIT).
// - PadFileSystem: the in-memory FileSystemProvider for scheme 'deliberate-pad' (registered with
//   isCaseSensitive). The pad document is deliberate-pad:/atom.dlbpy (.dlbjs, .dlbts): no language
//   server, linter, Run button or AI completion attaches to it, because those select by language id
//   ('python', ...) and scheme 'file'. Saving writes to memory: no save prompt, no revert juggling.
// - VscodePadEditor: implements src/atoms/pad.ts PadEditor with TextEditor.edit (full range),
//   insertSnippet (SnippetString appendText / appendPlaceholder), decoration types, context keys
//   (deliberate.atomFocused while the pad is the active editor, deliberate.padAwait, and
//   deliberate.padOpen for the command palette), tab-closed detection (tabGroups.onDidChangeTabs),
//   window focus, and restoring the previous editor and selection on close.
// - VscodePadUi: QuickPicks (which-pattern, tick what you have used) and setStatusBarMessage.
// - registerPadCommands / closeLeftoverPadTabs / createPadSurface for src/extension.ts.
// All the decisions live in src/atoms/pad.ts; this file only talks to VS Code.

import * as vscode from 'vscode';
import type { Lang } from '../contracts';
import {
  PAD_SCHEME, padLanguageId, padPath, type AtomPad, type PadChange, type PadContextKey, type PadEditor, type PadUi, type PickManyOptions,
  type PickOneOptions,
} from './pad';
import type { DecorationKind, PadDecoration, SnippetPart } from './render';

export const PAD_COMMANDS = {
  submit: 'deliberate.atomSubmit',
  submitGuess: 'deliberate.atomSubmitGuess',
  yes: 'deliberate.padYes',
  no: 'deliberate.padNo',
  pick: 'deliberate.padPick',
  escape: 'deliberate.atomEscape',
  leave: 'deliberate.leavePractice',
} as const;

/** True while a pad tab is open (palette visibility of Leave practice). */
export const PAD_OPEN_CONTEXT = 'deliberate.padOpen';

const LEARNER_SAVE_MS = 250;

const isPadUri = (uri: vscode.Uri | undefined): boolean => uri?.scheme === PAD_SCHEME;

/** The last value set for each pad context key (VS Code has no API to read one back; the e2e suite reads this). */
export const padContextValues = new Map<string, unknown>();

function setContext(key: string, value: unknown): void {
  padContextValues.set(key, value);
  void vscode.commands.executeCommand('setContext', key, value);
}

// =====================================================================================================
// The in-memory file system
// =====================================================================================================

interface Entry {
  ctime: number;
  mtime: number;
  data: Uint8Array;
}

/** A flat, in-memory, case-sensitive file system: '/' plus the pad files. */
export class PadFileSystem implements vscode.FileSystemProvider {
  private readonly files = new Map<string, Entry>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  private key(uri: vscode.Uri): string {
    const p = uri.path.replace(/\/+$/, '');
    return p || '/';
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const k = this.key(uri);
    if (k === '/') return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const e = this.files.get(k);
    if (!e) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: e.ctime, mtime: e.mtime, size: e.data.byteLength };
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    if (this.key(uri) !== '/') throw vscode.FileSystemError.FileNotFound(uri);
    return [...this.files.keys()].map((p) => [p.slice(1), vscode.FileType.File]);
  }

  createDirectory(uri: vscode.Uri): void {
    if (this.key(uri) === '/') return;
    throw vscode.FileSystemError.NoPermissions('The practice pad has no folders');
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const e = this.files.get(this.key(uri));
    if (!e) throw vscode.FileSystemError.FileNotFound(uri);
    return e.data;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean }): void {
    const k = this.key(uri);
    if (k === '/') throw vscode.FileSystemError.FileIsADirectory(uri);
    if (k.lastIndexOf('/') !== 0) throw vscode.FileSystemError.FileNotFound(uri);
    const old = this.files.get(k);
    if (!old && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (old && options.create && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
    const now = Date.now();
    this.files.set(k, { ctime: old?.ctime ?? now, mtime: now, data: new Uint8Array(content) });
    this.emitter.fire([{ type: old ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  delete(uri: vscode.Uri): void {
    const k = this.key(uri);
    if (k === '/') throw vscode.FileSystemError.NoPermissions('The practice pad root cannot be deleted');
    if (!this.files.delete(k)) throw vscode.FileSystemError.FileNotFound(uri);
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): void {
    const from = this.key(oldUri);
    const to = this.key(newUri);
    const e = this.files.get(from);
    if (!e) throw vscode.FileSystemError.FileNotFound(oldUri);
    if (to === '/' || to.lastIndexOf('/') !== 0) throw vscode.FileSystemError.NoPermissions('The practice pad has no folders');
    if (this.files.has(to) && !options.overwrite) throw vscode.FileSystemError.FileExists(newUri);
    this.files.delete(from);
    this.files.set(to, { ...e, mtime: Date.now() });
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri: oldUri }, { type: vscode.FileChangeType.Created, uri: newUri }]);
  }

  /** Create an empty pad file if it does not exist (openTextDocument reads it). */
  ensure(uri: vscode.Uri): void {
    if (!this.files.has(this.key(uri))) this.writeFile(uri, new Uint8Array(), { create: true, overwrite: false });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

// =====================================================================================================
// Decorations
// =====================================================================================================

function makeDecorationTypes(): Record<DecorationKind, vscode.TextEditorDecorationType> {
  const after = (color: string, fontStyle?: string): vscode.ThemableDecorationAttachmentRenderOptions => {
    const a: vscode.ThemableDecorationAttachmentRenderOptions = { color: new vscode.ThemeColor(color), margin: '0 0 0 2em' };
    if (fontStyle) a.fontStyle = fontStyle;
    return a;
  };
  const make = (o: vscode.DecorationRenderOptions) =>
    vscode.window.createTextEditorDecorationType({ rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed, ...o });
  return {
    correct: make({ after: after('testing.iconPassed') }),
    format: make({ after: after('editorInfo.foreground') }),
    wrong: make({ after: after('testing.iconFailed') }),
    note: make({ after: after('editorCodeLens.foreground') }),
    check: make({ after: after('testing.iconFailed') }),
    removed: make({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'), after: after('editorCodeLens.foreground', 'italic') }),
    subgoal: make({ after: after('editorCodeLens.foreground', 'italic') }),
    trace: make({ after: after('editorCodeLens.foreground') }),
    'reveal-fill': make({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'), after: after('testing.iconPassed') }),
    hint: make({ after: after('editorCodeLens.foreground', 'italic') }),
  };
}

function fullRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end);
}

// =====================================================================================================
// The editor
// =====================================================================================================

export interface PadEditorConfig {
  /** 'beside' (default): ViewColumn.Beside; 'active': the active column. */
  padColumn: 'beside' | 'active';
}

function readConfig(): PadEditorConfig {
  const v = vscode.workspace.getConfiguration('deliberate').get<string>('padColumn', 'beside');
  return { padColumn: v === 'active' ? 'active' : 'beside' };
}

export class VscodePadEditor implements PadEditor, vscode.Disposable {
  private uri: vscode.Uri | undefined;
  private doc: vscode.TextDocument | undefined;
  private column: vscode.ViewColumn | undefined;
  private prev: { uri: vscode.Uri; viewColumn?: vscode.ViewColumn; selection: vscode.Selection } | undefined;
  private decos: PadDecoration[] = [];
  private readonly types: Record<DecorationKind, vscode.TextEditorDecorationType>;
  private applying = 0;
  private coachVersion = -1;
  private closing = false;
  private opened = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<PadChange>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  private readonly focusEmitter = new vscode.EventEmitter<boolean>();
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly fs: PadFileSystem, private readonly config: () => PadEditorConfig = readConfig) {
    this.types = makeDecorationTypes();
    this.subs.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocChange(e)),
      vscode.window.tabGroups.onDidChangeTabs((e) => this.onTabs(e)),
      vscode.window.onDidChangeWindowState((s) => this.focusEmitter.fire(s.focused)),
      vscode.window.onDidChangeActiveTextEditor((ed) => setContext('deliberate.atomFocused', this.opened && !!ed && this.isThis(ed.document.uri))),
      vscode.window.onDidChangeVisibleTextEditors((eds) => {
        for (const ed of eds) if (this.isThis(ed.document.uri)) this.paint(ed);
      }),
    );
  }

  get isOpen(): boolean {
    return this.opened;
  }

  get windowFocused(): boolean {
    return vscode.window.state.focused;
  }

  private isThis(uri: vscode.Uri | undefined): boolean {
    return !!uri && !!this.uri && uri.toString() === this.uri.toString();
  }

  private padTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText && this.isThis(t.input.uri));
  }

  private visibleEditor(): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => this.isThis(e.document.uri));
  }

  /** The pad's TextEditor, shown again (without taking focus) if the learner switched tabs in its group. */
  private async ensureEditor(): Promise<vscode.TextEditor | undefined> {
    if (!this.opened || !this.uri) return undefined;
    const ed = this.visibleEditor();
    if (ed) return ed;
    try {
      if (!this.doc || this.doc.isClosed) this.doc = await vscode.workspace.openTextDocument(this.uri);
      return await vscode.window.showTextDocument(this.doc, { viewColumn: this.column, preview: false, preserveFocus: true });
    } catch {
      return undefined;
    }
  }

  private async coachEdit(fn: () => Thenable<unknown>): Promise<void> {
    this.applying++;
    try {
      await fn();
    } finally {
      this.coachVersion = this.doc?.version ?? this.coachVersion;
      this.applying--;
    }
  }

  async open(lang: Lang): Promise<void> {
    const uri = vscode.Uri.from({ scheme: PAD_SCHEME, path: padPath(lang) });
    if (this.opened && this.uri && !this.isThis(uri)) await this.close();
    const active = vscode.window.activeTextEditor;
    if (!this.opened && active && !isPadUri(active.document.uri)) {
      this.prev = { uri: active.document.uri, viewColumn: active.viewColumn, selection: active.selection };
    }
    this.fs.ensure(uri);
    let doc = await vscode.workspace.openTextDocument(uri);
    const want = padLanguageId(lang);
    if (doc.languageId !== want) doc = await vscode.languages.setTextDocumentLanguage(doc, want);
    const column = this.opened && this.column !== undefined
      ? this.column
      : this.config().padColumn === 'active' ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false, preserveFocus: false });
    this.uri = uri;
    this.doc = doc;
    this.column = editor.viewColumn;
    this.opened = true;
    if (doc.eol !== vscode.EndOfLine.LF) await this.coachEdit(() => editor.edit((eb) => eb.setEndOfLine(vscode.EndOfLine.LF)));
    setContext('deliberate.atomFocused', true);
    setContext(PAD_OPEN_CONTEXT, true);
  }

  text(): string {
    return this.doc && !this.doc.isClosed ? this.doc.getText() : '';
  }

  async setText(text: string): Promise<void> {
    const ed = await this.ensureEditor();
    if (!ed) return;
    await this.coachEdit(() => ed.edit((eb) => eb.replace(fullRange(ed.document), text), { undoStopBefore: true, undoStopAfter: true }));
    await this.save();
  }

  async insertSnippet(parts: readonly SnippetPart[]): Promise<void> {
    const ed = await this.ensureEditor();
    if (!ed) return;
    const sn = new vscode.SnippetString();
    for (const p of parts) {
      if ('text' in p) sn.appendText(p.text);
      else sn.appendPlaceholder(p.value, p.placeholder);
    }
    await this.coachEdit(async () => {
      await ed.edit((eb) => eb.delete(fullRange(ed.document)), { undoStopBefore: true, undoStopAfter: false });
      await ed.insertSnippet(sn, new vscode.Position(0, 0), { undoStopBefore: false, undoStopAfter: true });
    });
    await this.save();
  }

  select(line: number, column: number, endColumn?: number): void {
    const ed = this.visibleEditor();
    if (!ed) return;
    const doc = ed.document;
    const l = Math.max(0, Math.min(line, doc.lineCount - 1));
    const len = doc.lineAt(l).text.length;
    const a = new vscode.Position(l, Math.max(0, Math.min(column, len)));
    const b = new vscode.Position(l, Math.max(0, Math.min(endColumn ?? column, len)));
    ed.selection = new vscode.Selection(a, b);
    ed.revealRange(new vscode.Range(a, b), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  decorate(decorations: readonly PadDecoration[]): void {
    this.decos = [...decorations];
    const ed = this.visibleEditor();
    if (ed) this.paint(ed);
  }

  private paint(ed: vscode.TextEditor): void {
    const doc = ed.document;
    const byKind = new Map<DecorationKind, vscode.DecorationOptions[]>();
    for (const d of this.decos) {
      if (!doc.lineCount) break;
      const line = Math.max(0, Math.min(d.line, doc.lineCount - 1));
      const o: vscode.DecorationOptions = {
        range: doc.lineAt(line).range,
        renderOptions: { after: { contentText: d.text } },
      };
      if (d.hover) o.hoverMessage = new vscode.MarkdownString().appendText(d.hover);
      byKind.set(d.kind, [...(byKind.get(d.kind) ?? []), o]);
    }
    for (const kind of Object.keys(this.types) as DecorationKind[]) ed.setDecorations(this.types[kind], byKind.get(kind) ?? []);
  }

  setContext(key: PadContextKey, value: boolean | string): void {
    setContext(key, value);
  }

  private async save(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const doc = this.doc;
    if (!doc || doc.isClosed || !doc.isDirty) return;
    try {
      await doc.save();
    } catch {
      // In-memory writes do not fail; a closed document is simply skipped.
    }
  }

  async close(): Promise<void> {
    if (!this.uri) return;
    this.closing = true;
    this.opened = false;
    try {
      await this.save();
      const tabs = this.padTabs();
      if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
    } catch {
      // A tab the learner already closed.
    } finally {
      this.closing = false;
    }
    this.decos = [];
    setContext('deliberate.atomFocused', false);
    setContext('deliberate.padAwait', '');
    setContext(PAD_OPEN_CONTEXT, false);
    const prev = this.prev;
    this.prev = undefined;
    if (prev) {
      try {
        await vscode.window.showTextDocument(prev.uri, { viewColumn: prev.viewColumn, selection: prev.selection, preserveFocus: false });
      } catch {
        // The previous file is gone: nothing to restore.
      }
    }
  }

  onDidChange(listener: (e: PadChange) => void): vscode.Disposable {
    return this.changeEmitter.event(listener);
  }

  onDidClose(listener: () => void): vscode.Disposable {
    return this.closeEmitter.event(listener);
  }

  onDidChangeWindowFocus(listener: (focused: boolean) => void): vscode.Disposable {
    return this.focusEmitter.event(listener);
  }

  private onDocChange(e: vscode.TextDocumentChangeEvent): void {
    if (!this.isThis(e.document.uri) || !e.contentChanges.length) return;
    if (this.applying > 0 || e.document.version <= this.coachVersion) return;
    this.changeEmitter.fire({ inserted: e.contentChanges.map((c) => c.text), undoRedo: e.reason !== undefined });
    // Keep the in-memory document clean, so closing the tab never asks to save.
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), LEARNER_SAVE_MS);
  }

  private onTabs(e: vscode.TabChangeEvent): void {
    if (!this.opened || this.closing || !this.uri) return;
    if (!e.closed.some((t) => t.input instanceof vscode.TabInputText && this.isThis(t.input.uri))) return;
    // Moved to another group: still open.
    if (this.padTabs().length) return;
    this.opened = false;
    this.decos = [];
    clearTimeout(this.saveTimer);
    setContext('deliberate.atomFocused', false);
    setContext('deliberate.padAwait', '');
    setContext(PAD_OPEN_CONTEXT, false);
    this.closeEmitter.fire();
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
    for (const s of this.subs) s.dispose();
    for (const t of Object.values(this.types)) t.dispose();
    this.changeEmitter.dispose();
    this.closeEmitter.dispose();
    this.focusEmitter.dispose();
  }
}

// =====================================================================================================
// QuickPicks and the status flash
// =====================================================================================================

type IndexedItem = vscode.QuickPickItem & { index: number };

export class VscodePadUi implements PadUi {
  pickOne(o: PickOneOptions): Promise<number | undefined> {
    return new Promise((resolve) => {
      if (o.signal?.aborted) return resolve(undefined);
      const qp = vscode.window.createQuickPick<IndexedItem>();
      qp.title = o.title;
      if (o.placeholder) qp.placeholder = o.placeholder;
      qp.items = o.items.map((label, index) => ({ label, index }));
      let done = false;
      const finish = (v: number | undefined) => {
        if (done) return;
        done = true;
        resolve(v);
        qp.hide();
      };
      qp.onDidAccept(() => finish(qp.selectedItems[0]?.index ?? qp.activeItems[0]?.index));
      qp.onDidHide(() => {
        finish(undefined);
        qp.dispose();
      });
      o.signal?.addEventListener('abort', () => finish(undefined), { once: true });
      qp.show();
    });
  }

  pickMany(o: PickManyOptions): Promise<number[] | undefined> {
    return new Promise((resolve) => {
      if (o.signal?.aborted) return resolve(undefined);
      const qp = vscode.window.createQuickPick<IndexedItem>();
      qp.title = o.title;
      if (o.placeholder) qp.placeholder = o.placeholder;
      qp.canSelectMany = true;
      qp.matchOnDetail = true;
      qp.items = o.items.map((it, index) => (it.detail ? { label: it.label, detail: it.detail, index } : { label: it.label, index }));
      let done = false;
      const finish = (v: number[] | undefined) => {
        if (done) return;
        done = true;
        resolve(v);
        qp.hide();
      };
      qp.onDidAccept(() => finish(qp.selectedItems.map((x) => x.index)));
      qp.onDidHide(() => {
        finish(undefined);
        qp.dispose();
      });
      o.signal?.addEventListener('abort', () => finish(undefined), { once: true });
      qp.show();
    });
  }

  flash(text: string, ms = 3000): void {
    vscode.window.setStatusBarMessage(text, ms);
  }
}

// =====================================================================================================
// Wiring helpers for src/extension.ts
// =====================================================================================================

export interface PadSurface {
  fs: PadFileSystem;
  editor: VscodePadEditor;
  ui: VscodePadUi;
  /** The provider registration, the editor and the file system: push into context.subscriptions. */
  disposables: vscode.Disposable[];
}

/** Register the 'deliberate-pad' file system and create the editor and the QuickPick surface. */
export function createPadSurface(config?: () => PadEditorConfig): PadSurface {
  const fs = new PadFileSystem();
  const editor = new VscodePadEditor(fs, config);
  const ui = new VscodePadUi();
  const reg = vscode.workspace.registerFileSystemProvider(PAD_SCHEME, fs, { isCaseSensitive: true });
  return { fs, editor, ui, disposables: [reg, editor, fs] };
}

/** The pad's commands (keybindings and when-clauses are in docs/stage2/pad.package.json). */
export function registerPadCommands(pad: AtomPad): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(PAD_COMMANDS.submit, () => pad.submit(false)),
    vscode.commands.registerCommand(PAD_COMMANDS.submitGuess, () => pad.submit(true)),
    vscode.commands.registerCommand(PAD_COMMANDS.yes, () => pad.yesNo(true)),
    vscode.commands.registerCommand(PAD_COMMANDS.no, () => pad.yesNo(false)),
    vscode.commands.registerCommand(PAD_COMMANDS.pick, (n?: unknown) => pad.pick(Number(n))),
    vscode.commands.registerCommand(PAD_COMMANDS.escape, () => pad.escape()),
    vscode.commands.registerCommand(PAD_COMMANDS.leave, () => pad.leave()),
  ];
}

/** On activation: close pad tabs left over from a reload (their in-memory files are gone). */
export async function closeLeftoverPadTabs(): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputText && isPadUri(t.input.uri));
  if (!tabs.length) return;
  try {
    await vscode.window.tabGroups.close(tabs, true);
  } catch {
    // Best effort: a tab that refuses to close is harmless.
  }
}
