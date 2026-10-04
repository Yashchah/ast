import * as path from 'path';
import * as vscode from 'vscode';
import type { Annotation, AnnotationSource } from './contracts';
import { AnnotationModel, type LineChange, type LineView } from './annotationModel';
import { HINT_COMMANDS, HINT_LINKS, splitHintLabel, type HintHost } from './hints';
import { Emitter } from './jobs';

export type { Annotation, AnnotationSource } from './contracts';

/** Gutter icon kinds (media/gutter-<kind>.svg). */
export type GutterKind = 'pass' | 'fail' | 'offer';

/** A command a gutter icon's hover links to. */
export interface GutterCommand {
  command: string;
  args?: unknown[];
}

/**
 * One owner for project-file annotations (spec V1-4). Implemented by LineAnnotationManager.
 * Lines are 0-based.
 */
export interface AnnotationSink {
  /** Routed by annotationModel: after-text, folded into a higher owner's hover, or a comment thread. */
  set(a: Annotation): void;
  clear(source: AnnotationSource, uri?: string): void;
  setGutter(uri: string, line: number, kind: GutterKind, hover?: string, command?: GutterCommand): void;
  clearGutter(uri?: string, kind?: GutterKind): void;
}

// =====================================================================================
// Pure helpers (tested in test/lineAnnotations.test.ts)
// =====================================================================================

/** Commands a decoration hover may run (the hint links plus the offers' links). */
export const DEFAULT_TRUSTED_COMMANDS: readonly string[] = [...HINT_COMMANDS, 'deliberate.next', 'deliberate.open', 'deliberate.predictOwn'];

/** Gutter icon shown when a line has several kinds: the actionable one first. */
const GUTTER_RANK: Record<GutterKind, number> = { offer: 0, fail: 1, pass: 2 };
const GUTTER_LINK_LABEL: Record<GutterKind, string> = { offer: 'Start', fail: 'Show details', pass: 'Show details' };

/** '[label](command:id?<encoded args>)' */
export function commandLink(label: string, command: string, args?: readonly unknown[]): string {
  const q = args && args.length ? `?${encodeURIComponent(JSON.stringify(args))}` : '';
  return `[${label}](command:${command}${q})`;
}

export interface GutterEntry {
  line: number;
  kind: GutterKind;
  hover?: string;
  command?: GutterCommand;
}

/** Per line: the icon kind to draw and the merged hover (every entry's hover and link, owner first). */
export function gutterView(entries: readonly GutterEntry[]): { line: number; kind: GutterKind; hover: string; commands: string[] }[] {
  const byLine = new Map<number, GutterEntry[]>();
  for (const e of entries) byLine.set(e.line, [...(byLine.get(e.line) ?? []), e]);
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, list]) => {
      const sorted = [...list].sort((a, b) => GUTTER_RANK[a.kind] - GUTTER_RANK[b.kind]);
      const parts = sorted
        .map((e) => [e.hover?.trim(), e.command ? commandLink(GUTTER_LINK_LABEL[e.kind], e.command.command, e.command.args) : undefined].filter(Boolean).join(' · '))
        .filter(Boolean);
      return { line, kind: sorted[0].kind, hover: parts.join('\n\n---\n\n'), commands: sorted.flatMap((e) => (e.command ? [e.command.command] : [])) };
    });
}

function lineBreaks(text: string): number {
  return text.match(/\r\n|\r|\n/g)?.length ?? 0;
}

/**
 * Where an anchored line is after one change (ranges refer to the text before it): moved by the
 * change's line delta when the change ends before it, unchanged when the change starts on or
 * after it, undefined when the line was deleted or merged into an earlier one.
 */
export function shiftLine(line: number, c: LineChange): number | undefined {
  const delta = lineBreaks(c.text) - (c.endLine - c.startLine);
  if (c.endLine < line || (c.endLine === line && c.endCharacter === 0 && (c.endLine > c.startLine || c.startCharacter === 0))) {
    const moved = line + delta;
    return moved >= 0 ? moved : undefined;
  }
  if (c.startLine < line && line <= c.endLine) return undefined;
  return line;
}

/** Comment-thread title and markdown body for a long hint ('Hint 2: ...' -> label 'Hint 2'), with the Next hint / Got it links. */
export function threadContent(text: string): { label: string; markdown: string } {
  const { label, body } = splitHintLabel(text);
  return { label, markdown: `${body}\n\n${HINT_LINKS}` };
}

export interface ThreadSlot {
  id: number;
  line: number;
  text: string;
}

/**
 * Reconcile the comment threads held with the ones render() asks for. Threads are matched by text
 * (same line first), so a hint whose line moved keeps its thread (moved, not re-created).
 */
export function planThreads(
  existing: readonly ThreadSlot[],
  desired: readonly { line: number; text: string }[],
): { keep: number[]; move: { id: number; line: number }[]; create: { line: number; text: string }[]; dispose: number[] } {
  const free = new Set(existing.map((e) => e.id));
  const keep: number[] = [];
  const move: { id: number; line: number }[] = [];
  const rest: { line: number; text: string }[] = [];
  for (const d of desired) {
    const same = existing.find((e) => free.has(e.id) && e.text === d.text && e.line === d.line);
    if (same) {
      free.delete(same.id);
      keep.push(same.id);
    } else rest.push(d);
  }
  const create: { line: number; text: string }[] = [];
  for (const d of rest) {
    const moved = existing.find((e) => free.has(e.id) && e.text === d.text);
    if (moved) {
      free.delete(moved.id);
      move.push({ id: moved.id, line: d.line });
    } else create.push(d);
  }
  return { keep, move, create, dispose: [...free] };
}

// =====================================================================================
// LineAnnotationManager
// =====================================================================================

export interface LineAnnotationOptions {
  /** Commands decoration hovers may run, in addition to DEFAULT_TRUSTED_COMMANDS and each gutter's own command. */
  trustedCommands?: readonly string[];
  log?: (line: string) => void;
}

interface HeldThread {
  id: number;
  line: number;
  text: string;
  thread: vscode.CommentThread;
}

/**
 * Draws annotationModel's decisions: italic after-text (editorCodeLens.foreground), a whole-line
 * wordHighlight background plus a Right-lane overview ruler mark for hints, gutter icons for
 * offers and spec results, and a comment thread ('Deliberate hints') for hint text longer than
 * 52 characters. Annotations clear when their anchored line text changes; gutter icons follow
 * their line. Never edits a document.
 */
export class LineAnnotationManager implements AnnotationSink, HintHost, vscode.Disposable {
  private readonly model = new AnnotationModel();
  private readonly gutters = new Map<string, GutterEntry[]>();
  private readonly threads = new Map<string, HeldThread[]>();
  private readonly extraThreads = new Set<vscode.CommentThread>();
  private readonly pending = new Set<{ a: Annotation }>();
  private readonly afterType: vscode.TextEditorDecorationType;
  private readonly hintLineType: vscode.TextEditorDecorationType;
  private readonly gutterTypes: Record<GutterKind, vscode.TextEditorDecorationType>;
  private readonly controller: vscode.CommentController;
  private readonly trusted: readonly string[];
  private readonly log: (line: string) => void;
  private readonly removeEmitter = new Emitter<Annotation[]>();
  /** Annotations removed because their anchored line text changed (or the line went away). */
  readonly onDidRemove = this.removeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private threadIds = 0;
  private disposed = false;

  constructor(extensionUri: vscode.Uri, opts: LineAnnotationOptions = {}) {
    this.trusted = [...new Set([...DEFAULT_TRUSTED_COMMANDS, ...(opts.trustedCommands ?? [])])];
    this.log = opts.log ?? (() => undefined);
    this.afterType = vscode.window.createTextEditorDecorationType({
      after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 2em' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.hintLineType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    const gutter = (kind: GutterKind) =>
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', `gutter-${kind}.svg`),
        gutterIconSize: 'contain',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      });
    this.gutterTypes = { pass: gutter('pass'), fail: gutter('fail'), offer: gutter('offer') };
    this.controller = vscode.comments.createCommentController('deliberate.hints', 'Deliberate hints');

    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach((ed) => this.renderEditor(ed))),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChange(e)),
      vscode.workspace.onDidOpenTextDocument((doc) => this.revalidate(doc)),
    );
  }

  /** HintHost: this manager is its own sink. */
  get sink(): AnnotationSink {
    return this;
  }

  // ---------------------------------------------------------------- AnnotationSink

  set(a: Annotation): void {
    if (this.disposed) return;
    a = { ...a, uri: uriKey(a.uri) };
    const doc = findDoc(a.uri);
    if (doc) {
      this.setNow(a, doc);
      return;
    }
    // Not open yet: load it (without showing it) to read the anchored line's text.
    const token = { a };
    this.pending.add(token);
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(a.uri, true);
    } catch (err) {
      this.pending.delete(token);
      this.log(`annotations: bad uri ${a.uri}: ${errorText(err)}`);
      return;
    }
    vscode.workspace.openTextDocument(uri).then(
      (d) => {
        if (this.pending.delete(token) && !this.disposed) this.setNow(a, d);
      },
      (err) => {
        this.pending.delete(token);
        this.log(`annotations: cannot open ${a.uri}: ${errorText(err)}`);
      },
    );
  }

  clear(source: AnnotationSource, uri?: string): void {
    if (uri !== undefined) uri = uriKey(uri);
    for (const p of [...this.pending]) if (p.a.source === source && (uri === undefined || p.a.uri === uri)) this.pending.delete(p);
    const removed = this.model.clear({ source, uri });
    for (const u of new Set(removed.map((r) => r.uri))) {
      this.syncThreads(u);
      this.renderUri(u);
    }
  }

  setGutter(uri: string, line: number, kind: GutterKind, hover?: string, command?: GutterCommand): void {
    if (this.disposed || !Number.isInteger(line) || line < 0) return;
    uri = uriKey(uri);
    const list = (this.gutters.get(uri) ?? []).filter((g) => !(g.line === line && g.kind === kind));
    list.push({ line, kind, hover, command });
    this.gutters.set(uri, list);
    this.renderUri(uri);
  }

  clearGutter(uri?: string, kind?: GutterKind): void {
    const uris = uri === undefined ? [...this.gutters.keys()] : [uriKey(uri)];
    for (const u of uris) {
      const list = this.gutters.get(u);
      if (!list) continue;
      const left = kind === undefined ? [] : list.filter((g) => g.kind !== kind);
      if (left.length) this.gutters.set(u, left);
      else this.gutters.delete(u);
      this.renderUri(u);
    }
  }

  // ---------------------------------------------------------------- HintHost

  /** Lines of a workspace-relative path, absolute path or uri string (open buffer, else loaded without showing it). */
  async readLines(file: string): Promise<{ uri: string; file: string; lines: string[] } | undefined> {
    const uri = await resolveFile(file);
    if (!uri) return undefined;
    try {
      const doc = findDoc(uri.toString()) ?? (await vscode.workspace.openTextDocument(uri));
      const lines: string[] = [];
      for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
      return { uri: doc.uri.toString(), file: vscode.workspace.asRelativePath(doc.uri, false), lines };
    } catch (err) {
      this.log(`annotations: cannot read ${file}: ${errorText(err)}`);
      return undefined;
    }
  }

  /** Reveal a line in every visible editor showing the document, without taking focus. */
  reveal(uri: string, line: number): void {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.toString() !== uri || line >= ed.document.lineCount) continue;
      ed.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  /** A comment thread outside the model (rung 2 with a drill also shows the rung text in a thread). */
  openThread(uri: string, line: number, label: string, markdown: string): { dispose(): void } {
    const thread = this.createThread(uri, line, label, `${markdown.trim()}\n\n${HINT_LINKS}`);
    this.extraThreads.add(thread);
    return {
      dispose: () => {
        if (this.extraThreads.delete(thread)) thread.dispose();
      },
    };
  }

  // ---------------------------------------------------------------- internals

  private setNow(a: Annotation, doc: vscode.TextDocument): void {
    if (!Number.isInteger(a.line) || a.line < 0 || a.line >= doc.lineCount) {
      this.log(`annotations: line ${a.line} outside ${a.uri} (${doc.lineCount} lines); ${a.source} annotation dropped`);
      return;
    }
    const uri = doc.uri.toString();
    this.model.set({ ...a, uri }, doc.lineAt(a.line).text);
    this.syncThreads(uri);
    this.renderUri(uri);
  }

  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    const uri = e.document.uri.toString();
    const gutters = this.gutters.get(uri);
    const hasAnnotations = this.model.uris().includes(uri);
    if ((!gutters && !hasAnnotations) || e.contentChanges.length === 0) return;
    const changes: LineChange[] = e.contentChanges.map((c) => ({
      startLine: c.range.start.line,
      startCharacter: c.range.start.character,
      endLine: c.range.end.line,
      endCharacter: c.range.end.character,
      text: c.text,
    }));
    if (gutters) {
      const moved: GutterEntry[] = [];
      for (const g of gutters) {
        let line: number | undefined = g.line;
        for (const c of changes) {
          if (line === undefined) break;
          line = shiftLine(line, c);
        }
        if (line !== undefined && line < e.document.lineCount) moved.push({ ...g, line });
      }
      if (moved.length) this.gutters.set(uri, moved);
      else this.gutters.delete(uri);
    }
    let removed: Annotation[] = [];
    if (hasAnnotations) {
      const doc = e.document;
      removed = this.model.onDidChange(uri, changes, (l) => (l >= 0 && l < doc.lineCount ? doc.lineAt(l).text : undefined));
      this.syncThreads(uri);
    }
    this.renderUri(uri);
    if (removed.length) this.removeEmitter.fire(removed);
  }

  /** A document (re)opened: drop annotations whose line text changed while it was closed. */
  private revalidate(doc: vscode.TextDocument): void {
    const uri = doc.uri.toString();
    if (!this.model.uris().includes(uri)) return;
    const removed = this.model.onDidChange(uri, [], (l) => (l >= 0 && l < doc.lineCount ? doc.lineAt(l).text : undefined));
    if (!removed.length) return;
    this.syncThreads(uri);
    this.renderUri(uri);
    this.removeEmitter.fire(removed);
  }

  private syncThreads(uri: string): void {
    const desired = this.model
      .render(uri)
      .filter((v): v is LineView & { thread: string } => v.thread !== undefined)
      .map((v) => ({ line: v.line, text: v.thread }));
    const held = this.threads.get(uri) ?? [];
    if (!desired.length && !held.length) return;
    const plan = planThreads(held, desired);
    const byId = new Map(held.map((h) => [h.id, h] as const));
    const next: HeldThread[] = [];
    for (const id of plan.keep) next.push(byId.get(id)!);
    for (const m of plan.move) {
      const h = byId.get(m.id)!;
      h.line = m.line;
      h.thread.range = new vscode.Range(m.line, 0, m.line, 0);
      next.push(h);
    }
    for (const id of plan.dispose) byId.get(id)?.thread.dispose();
    for (const c of plan.create) {
      const { label, markdown } = threadContent(c.text);
      next.push({ id: ++this.threadIds, line: c.line, text: c.text, thread: this.createThread(uri, c.line, label, markdown) });
    }
    if (next.length) this.threads.set(uri, next);
    else this.threads.delete(uri);
  }

  private createThread(uri: string, line: number, label: string, markdown: string): vscode.CommentThread {
    const body = new vscode.MarkdownString(markdown);
    body.isTrusted = { enabledCommands: [...HINT_COMMANDS] };
    const comment: vscode.Comment = { body, mode: vscode.CommentMode.Preview, author: { name: 'Deliberate' } };
    const thread = this.controller.createCommentThread(vscode.Uri.parse(uri), new vscode.Range(line, 0, line, 0), [comment]);
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.label = label;
    thread.contextValue = 'deliberate.hint';
    return thread;
  }

  private markdown(text: string, extraCommands: readonly string[] = []): vscode.MarkdownString {
    const m = new vscode.MarkdownString(text);
    m.isTrusted = { enabledCommands: [...new Set([...this.trusted, ...extraCommands])] };
    m.supportThemeIcons = true;
    return m;
  }

  private renderUri(uri: string): void {
    for (const ed of vscode.window.visibleTextEditors) if (ed.document.uri.toString() === uri) this.renderEditor(ed);
  }

  private renderEditor(ed: vscode.TextEditor): void {
    if (this.disposed) return;
    const doc = ed.document;
    const uri = doc.uri.toString();
    const after: vscode.DecorationOptions[] = [];
    const hintLines: vscode.DecorationOptions[] = [];
    for (const v of this.model.render(uri)) {
      if (v.line >= doc.lineCount) continue;
      const range = doc.lineAt(v.line).range;
      const hover = v.hover.trim() ? this.markdown(v.hover) : undefined;
      const renderOptions = v.afterText ? { after: { contentText: v.afterText } } : undefined;
      if (v.owner === 'hint') {
        hintLines.push({ range, hoverMessage: hover });
        if (renderOptions) after.push({ range, renderOptions });
      } else if (renderOptions) {
        after.push({ range, hoverMessage: hover, renderOptions });
      }
    }
    ed.setDecorations(this.afterType, after);
    ed.setDecorations(this.hintLineType, hintLines);
    const byKind: Record<GutterKind, vscode.DecorationOptions[]> = { pass: [], fail: [], offer: [] };
    for (const g of gutterView(this.gutters.get(uri) ?? [])) {
      if (g.line >= doc.lineCount) continue;
      byKind[g.kind].push({ range: doc.lineAt(g.line).range, hoverMessage: g.hover ? this.markdown(g.hover, g.commands) : undefined });
    }
    for (const kind of Object.keys(byKind) as GutterKind[]) ed.setDecorations(this.gutterTypes[kind], byKind[kind]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.clear();
    for (const d of this.disposables) d.dispose();
    for (const list of this.threads.values()) for (const h of list) h.thread.dispose();
    this.threads.clear();
    for (const t of this.extraThreads) t.dispose();
    this.extraThreads.clear();
    this.afterType.dispose();
    this.hintLineType.dispose();
    for (const t of Object.values(this.gutterTypes)) t.dispose();
    this.controller.dispose();
    this.removeEmitter.dispose();
  }
}

// ---------------------------------------------------------------- vscode helpers

/** Canonical uri string (callers may pass differently encoded forms of the same uri). */
function uriKey(uri: string): string {
  try {
    return vscode.Uri.parse(uri, true).toString();
  } catch {
    return uri;
  }
}

function findDoc(uri: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  if (findDoc(uri.toString())) return true;
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Uri for a workspace-relative path ('cli.py', './src/cli.py', 'folder/src/cli.py' in multi-root), an absolute path or a uri string. */
async function resolveFile(file: string): Promise<vscode.Uri | undefined> {
  const f = file.trim();
  if (!f) return undefined;
  if (/^[a-z][a-z0-9+.-]+:/i.test(f)) {
    try {
      return vscode.Uri.parse(f, true);
    } catch {
      return undefined;
    }
  }
  if (path.isAbsolute(f)) return vscode.Uri.file(f);
  const rel = f.replace(/\\/g, '/').replace(/^\.\//, '');
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const uri = vscode.Uri.joinPath(folder.uri, rel);
    if (await exists(uri)) return uri;
  }
  // Multi-root paths from asRelativePath carry the folder name first.
  const [head, ...rest] = rel.split('/');
  const named = folders.find((fo) => fo.name === head);
  if (named && rest.length) {
    const uri = vscode.Uri.joinPath(named.uri, rest.join('/'));
    if (await exists(uri)) return uri;
  }
  // An open untitled or out-of-folder document with that path tail.
  const open = vscode.workspace.textDocuments.find((d) => d.uri.path.replace(/\\/g, '/').endsWith(`/${rel}`));
  return open?.uri;
}
