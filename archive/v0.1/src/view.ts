import * as vscode from 'vscode';
import { Coach } from './coach';

type FromWebview =
  | { type: 'ready' }
  | { type: 'startProject'; goal: string; background: string }
  | { type: 'submit'; text: string }
  | { type: 'ask'; text: string }
  | { type: 'command'; command: string; arg?: string; cardId?: string }
  | { type: 'cardInput'; command: string; cardId: string; text: string };

export class CoachViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'deliberate.coach';
  private view: vscode.WebviewView | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly coach: Coach,
  ) {
    this.disposables.push(
      coach.onChange(() => this.postState()),
      coach.onStatus(() => this.view?.webview.postMessage({ type: 'status', status: coach.statusInfo() })),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m), undefined, this.disposables);
    view.onDidChangeVisibility(() => view.visible && this.postState(), undefined, this.disposables);
  }

  reveal(): void {
    if (this.view) this.view.show(true);
    else void vscode.commands.executeCommand(`${CoachViewProvider.viewId}.focus`);
  }

  private postState(): void {
    void this.view?.webview.postMessage({ type: 'state', state: this.coach.viewModel() });
  }

  private async onMessage(m: FromWebview): Promise<void> {
    const c = this.coach;
    switch (m.type) {
      case 'ready':
        this.postState();
        return;
      case 'startProject':
        return c.startProject(m.goal.trim(), m.background.trim());
      case 'submit':
        return c.submit(m.text.trim());
      case 'ask':
        return c.askCoach(m.text.trim());
      case 'cardInput':
        if (m.command === 'answerRecall') return c.answerRecall(m.text.trim(), m.cardId);
        return;
      case 'command':
        return this.runCommand(m.command, m.arg, m.cardId);
    }
  }

  private async runCommand(command: string, arg?: string, cardId?: string): Promise<void> {
    const c = this.coach;
    switch (command) {
      case 'hint': return c.hint();
      case 'teach': return c.teach(arg);
      case 'checkWork': return c.checkWork();
      case 'gotIt': return c.gotIt();
      case 'imFine': return c.imFine();
      case 'reveal': return c.reveal();
      case 'noIdea': return c.noIdea();
      case 'skipExplain': return c.skipExplain();
      case 'diagnosticSkip': return c.answerDiagnostic(null);
      case 'startTask': if (arg) c.startTask(arg); return;
      case 'speedDrill': return c.speedDrill();
      case 'skipRecall': return c.skipRecall(cardId);
      case 'newProject': await vscode.commands.executeCommand('deliberate.newProject'); return;
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
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
