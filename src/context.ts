import * as os from 'os';
import * as nodePath from 'path';
import * as vscode from 'vscode';
import { isCode, Monitor } from './monitor';

const FILE_BUDGET = 40_000;   // chars for one file before we window around the cursor
const TOTAL_BUDGET = 120_000; // chars across all files

/** What gatherCodeContext reads from the monitor (tests pass a fake). */
export type CodeContextMonitor = Pick<Monitor, 'touchedFiles' | 'currentErrors' | 'detector' | 'lastEditAt'>;

export interface CodeContextOptions {
  /**
   * Folders whose files never count as the learner's code (globalStorage: spec JSON, verify copies,
   * run temp dirs). The OS temp dir is always excluded.
   */
  excludeDirs?: readonly string[];
}

const norm = (p: string) => {
  const r = nodePath.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** Is this file under one of the folders (case-insensitive on Windows)? */
export function isUnder(fsPath: string, dirs: readonly string[]): boolean {
  const f = norm(fsPath);
  return dirs.some((d) => {
    if (!d) return false;
    const base = norm(d);
    return f === base || f.startsWith(base.endsWith(nodePath.sep) ? base : base + nodePath.sep);
  });
}

/**
 * Defensive filter for task files: anything under globalStorage or the OS temp dir is the coach's own
 * scratch (spec runs, verification copies, practice pads), never the learner's project code.
 */
export function isLearnerFile(uri: { scheme: string; fsPath: string }, excludeDirs: readonly string[] = []): boolean {
  if (!isCode(uri)) return false;
  if (uri.scheme !== 'file') return true;
  return !isUnder(uri.fsPath, [os.tmpdir(), ...excludeDirs]);
}

/**
 * Build a plain-text snapshot of what the learner is working on *right now*: the
 * active file (cursor marked), every other file edited during the task (read from
 * the open buffer if there is one, else from disk), current errors and the latest
 * run of each terminal command. Large files are windowed around the cursor and
 * the prompt says so explicitly. Files under globalStorage or the OS temp dir are skipped.
 *
 * @param taskFiles URIs edited during the current task (persisted across reloads).
 */
export async function gatherCodeContext(monitor: CodeContextMonitor, taskFiles: string[] = [], opts: CodeContextOptions = {}): Promise<string> {
  const parts: string[] = [`(Snapshot of the learner's code taken at ${new Date().toLocaleTimeString()}. This is the current version; anything said about earlier versions may be outdated.)`];
  let used = 0;
  const editor = vscode.window.activeTextEditor;
  const seen = new Set<string>();
  const exclude = opts.excludeDirs ?? [];

  if (editor && isLearnerFile(editor.document.uri, exclude)) {
    const doc = editor.document;
    seen.add(doc.uri.toString());
    const block = renderFile(path(doc.uri), doc.languageId, doc.getText(), doc.isDirty, editor.selection.active.line);
    parts.push(`## Active file (cursor marked with <<CURSOR>>)\n${block}`);
    used += block.length;
  } else {
    parts.push('(No code file is focused in the editor.)');
  }

  for (const uriStr of new Set([...taskFiles, ...monitor.touchedFiles])) {
    if (seen.has(uriStr)) continue;
    seen.add(uriStr);
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(uriStr);
    } catch {
      continue;
    }
    if (!isLearnerFile(parsed, exclude)) continue;
    const file = await readLatest(uriStr);
    if (!file) continue;
    const block = renderFile(file.path, file.languageId, file.text, file.dirty);
    if (used + block.length > TOTAL_BUDGET) {
      parts.push(`## ${file.path}\n[omitted: context budget reached]`);
      continue;
    }
    parts.push(`## Also edited this task\n${block}`);
    used += block.length;
  }

  const errors = monitor.currentErrors().slice(0, 25);
  parts.push(
    '## Current errors (live from the editor)\n' +
      (errors.length ? errors.map((e) => `- ${e.file}:${e.line} ${e.message}`).join('\n') : '- none'),
  );

  const runs = monitor.detector.latestRuns(3);
  if (runs.length) {
    const now = Date.now();
    const lines = runs.map((r) => {
      const ago = Math.max(0, Math.round((now - r.at) / 60000));
      const stale = monitor.lastEditAt > r.at ? ' — code was edited AFTER this run, so this output may not reflect the current code' : '';
      const status = r.exitCode === undefined ? 'exit unknown' : r.exitCode === 0 ? 'succeeded (exit 0)' : `FAILED (exit ${r.exitCode})`;
      const out = r.exitCode !== 0 && r.output.trim() ? `\n${r.output.trim()}` : '';
      return `$ ${r.command}\n[${status}, ${ago} min ago${stale}]${out}`;
    });
    parts.push(`## Latest run of each terminal command (newest first)\n${lines.join('\n\n')}`);
  }
  return parts.join('\n\n');
}

async function readLatest(uriStr: string): Promise<{ path: string; languageId: string; text: string; dirty: boolean } | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriStr);
  if (open) return { path: path(open.uri), languageId: open.languageId, text: open.getText(), dirty: open.isDirty };
  // Closed since it was edited: read what is on disk now.
  const uri = vscode.Uri.parse(uriStr);
  if (uri.scheme !== 'file') return undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return { path: path(uri), languageId: uri.path.split('.').pop() ?? '', text: new TextDecoder().decode(bytes), dirty: false };
  } catch {
    return undefined; // deleted
  }
}

function path(uri: vscode.Uri): string {
  return uri.scheme === 'untitled' ? `${uri.path} (unsaved new file)` : vscode.workspace.asRelativePath(uri);
}

function renderFile(path: string, languageId: string, text: string, dirty: boolean, cursorLine?: number): string {
  const lines = text.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  const notes: string[] = [];
  if (dirty) notes.push('has UNSAVED edits: this is the editor buffer, which may differ from what last ran');
  if (text.length > FILE_BUDGET) {
    const center = cursorLine ?? 0;
    const avg = Math.max(20, text.length / Math.max(1, lines.length));
    const span = Math.floor(FILE_BUDGET / avg / 2);
    start = Math.max(0, center - span);
    end = Math.min(lines.length, center + span);
    notes.push(`large file: showing lines ${start + 1}-${end} of ${lines.length}`);
  }
  const body = lines
    .slice(start, end)
    .map((l, i) => {
      const n = start + i;
      return `${String(n + 1).padStart(4)}| ${l}${n === cursorLine ? '   <<CURSOR>>' : ''}`;
    })
    .join('\n');
  return `### ${path} (${languageId})${notes.length ? ` [${notes.join('; ')}]` : ''}\n\`\`\`\n${body}\n\`\`\``;
}
