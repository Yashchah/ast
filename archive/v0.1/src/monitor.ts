import * as vscode from 'vscode';
import { StuckDetector } from './stuck';

const TERMINAL_OUTPUT_LIMIT = 4000;

/**
 * Watches the editor, diagnostics and terminal, feeding a StuckDetector.
 * Also remembers which files changed during the current task so the coach can
 * look at what the learner actually wrote.
 */
export class Monitor implements vscode.Disposable {
  detector = new StuckDetector();
  readonly touchedFiles = new Set<string>();
  /** When the learner last changed any file (to flag terminal output older than the code). */
  lastEditAt = 0;
  private disposables: vscode.Disposable[] = [];
  private focused = vscode.window.state.focused;
  private readonly onTickEmitter = new vscode.EventEmitter<number>();
  /** Fires every tick with the ms of active time added. */
  readonly onTick = this.onTickEmitter.event;

  constructor() {
    const d = this.disposables;
    d.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!isCode(e.document.uri) || e.contentChanges.length === 0) return;
        let inserted = 0;
        let deleted = 0;
        for (const c of e.contentChanges) {
          inserted += c.text.replace(/\s/g, '').length;
          deleted += c.rangeLength;
        }
        this.touchedFiles.add(e.document.uri.toString());
        this.lastEditAt = Date.now();
        this.detector.onEdit(Date.now(), inserted, deleted);
      }),
      vscode.languages.onDidChangeDiagnostics(() => this.refreshDiagnostics()),
      vscode.window.onDidChangeWindowState((s) => {
        this.focused = s.focused;
        if (s.focused) this.detector.activity(Date.now());
      }),
      vscode.window.onDidChangeTextEditorSelection(() => this.detector.activity(Date.now())),
      vscode.window.onDidChangeActiveTextEditor(() => this.detector.activity(Date.now())),
      this.onTickEmitter,
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
        this.detector.onTerminal(Date.now(), e.execution.commandLine.value.trim(), e.exitCode, output);
      }),
    );

    const timer = setInterval(() => {
      const added = this.detector.tick(Date.now(), this.focused);
      this.onTickEmitter.fire(added);
    }, 5000);
    d.push({ dispose: () => clearInterval(timer) });
  }

  /** Start a fresh observation window for a new task. */
  startTask(): void {
    this.detector = new StuckDetector();
    this.touchedFiles.clear();
    this.refreshDiagnostics();
  }

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

  private refreshDiagnostics(): void {
    this.detector.onDiagnostics(
      Date.now(),
      this.currentErrors().map((e) => `${e.file}: ${e.message}`),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

/** Saved files and unsaved "Untitled" buffers count as the learner's code. */
export function isCode(uri: { scheme: string }): boolean {
  return uri.scheme === 'file' || uri.scheme === 'untitled';
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
  // Strip ANSI escape sequences so the model sees plain text.
  // eslint-disable-next-line no-control-regex
  return buf.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '').slice(-TERMINAL_OUTPUT_LIMIT);
}
