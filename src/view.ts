import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Coach } from './coach';

/** Messages the webview (media/main.js) sends. */
type FromWebview =
  | { type: 'ready' }
  | { type: 'startProject'; goal: string; background: string }
  | { type: 'submit'; text: string }
  | { type: 'ask'; text: string }
  | { type: 'tab'; tab: string }
  | { type: 'command'; command: string; arg?: string; cardId?: string };

/** What the extension shell adds around the coach. */
export interface ViewHooks {
  /**
   * Before a learner action that may run code (practice, placement, specs): local-execution consent
   * on first need. Resolves when the action may go ahead (whatever was chosen).
   */
  prepare?(action: string): Promise<void>;
  /** Extra state for the webview (Pace extras, the local-execution line), merged in as `shell`. */
  extras?(): Record<string, unknown>;
}

/**
 * Card and composer commands that may run code: they go through ViewHooks.prepare first. (Which
 * buttons wait while a foreground call runs is decided in media/main.js: Ask, Reveal, Teach and
 * spec-less Check my work.)
 */
export const CODE_COMMANDS: ReadonlySet<string> = new Set([
  'teach', 'noIdea', 'jitAtom', 'sprint', 'warmup', 'practiceWhileWaiting', 'placement', 'checkWork', 'startTask',
]);

/** Commands the webview routes to VS Code commands (confirmations and pickers live there). */
const VSCODE_COMMANDS: Record<string, string> = {
  newProject: 'deliberate.newProject',
  chooseExecution: 'deliberate.chooseExecution',
  showLog: 'deliberate.showLog',
  open: 'deliberate.open',
};

/**
 * The sidebar: a compact log of what happened (one card per placement, gate, atom, sprint, review and
 * hint), the task card with its interface and spec ladder, the composer for Ask and the optional own
 * plan, the Roadmap and the Progress tab. Learning happens in the editor, not here.
 */
export class CoachViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'deliberate.coach';
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private postTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingFocus: string | undefined;
  private ready = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly coach: Coach,
    private readonly hooks: ViewHooks = {},
  ) {
    this.disposables.push(
      coach.onChange(() => this.refresh()),
      coach.onStatus(() => void this.post({ type: 'status', status: coach.statusInfo() })),
    );
  }

  dispose(): void {
    if (this.postTimer) clearTimeout(this.postTimer);
    this.postTimer = undefined;
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m), undefined, this.disposables);
    view.onDidChangeVisibility(() => view.visible && this.refresh(), undefined, this.disposables);
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
      }
    }, undefined, this.disposables);
  }

  reveal(): void {
    if (this.view) this.view.show(true);
    else void vscode.commands.executeCommand(`${CoachViewProvider.viewId}.focus`);
  }

  /** Reveal the sidebar and focus the composer (e.g. 'explain' after "I'd do it differently"). */
  focusComposer(mode: string): void {
    if (this.view) this.view.show(false);
    else void vscode.commands.executeCommand(`${CoachViewProvider.viewId}.focus`);
    if (this.view && this.ready) void this.post({ type: 'focusComposer', mode });
    else this.pendingFocus = mode;
  }

  /** Re-render soon (bursts of coach changes are coalesced into one post). */
  refresh(): void {
    if (this.postTimer) return;
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      this.postState();
    }, 25);
  }

  private post(msg: unknown): Thenable<boolean> | undefined {
    return this.view?.webview.postMessage(msg);
  }

  private postState(): void {
    if (!this.view) return;
    let state: unknown;
    try {
      state = { ...this.coach.viewModel(), shell: this.hooks.extras?.() ?? {} };
    } catch (err) {
      console.error('[deliberate] view model failed', err);
      return;
    }
    void this.post({ type: 'state', state });
  }

  private async onMessage(m: FromWebview): Promise<void> {
    const c = this.coach;
    try {
      switch (m.type) {
        case 'ready':
          this.ready = true;
          this.postState();
          if (this.pendingFocus !== undefined) {
            const mode = this.pendingFocus;
            this.pendingFocus = undefined;
            void this.post({ type: 'focusComposer', mode });
          }
          return;
        case 'startProject': {
          const goal = String(m.goal ?? '').trim();
          if (!goal) return;
          await this.hooks.prepare?.('startProject');
          return await c.startProject(goal, String(m.background ?? '').trim());
        }
        case 'submit':
          return await c.submit(String(m.text ?? '').trim());
        case 'ask': {
          const q = String(m.text ?? '').trim();
          if (q) await c.askCoach(q);
          return;
        }
        case 'tab':
          if (m.tab === 'progress') await c.refreshPace();
          return;
        case 'command':
          return await this.runCommand(String(m.command ?? ''), typeof m.arg === 'string' && m.arg ? m.arg : undefined);
      }
    } catch (err) {
      console.error('[deliberate] webview message failed', err);
      void vscode.window.showErrorMessage(`Deliberate: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runCommand(command: string, arg?: string): Promise<void> {
    const c = this.coach;
    const vs = VSCODE_COMMANDS[command];
    if (vs) {
      await vscode.commands.executeCommand(vs);
      return;
    }
    if (CODE_COMMANDS.has(command)) await this.hooks.prepare?.(command);
    switch (command) {
      case 'hint': return c.hint();
      case 'gotIt': return c.gotIt();
      case 'imFine': return c.imFine();
      case 'reveal': return c.reveal();
      case 'noIdea': return c.noIdea();
      case 'teach': return c.teach(arg);
      case 'jitAtom': return c.jitAtom(arg);
      case 'checkWork': return c.checkWork();
      case 'startTask':
        if (arg) await c.startTask(arg);
        return;
      case 'sprint': return c.sprint();
      case 'warmup': return c.warmup();
      case 'practiceWhileWaiting': return c.practiceWhileWaiting();
      case 'placement': return c.placement();
      case 'gate': return c.openGate();
      case 'retryPlan': return c.retryPlan();
      case 'skipExplainBack': return c.skipExplainBack();
      case 'buildNow': return c.buildNow();
      default:
        console.warn(`[deliberate] unknown webview command '${command}'`);
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>Deliberate</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
