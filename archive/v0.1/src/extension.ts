import * as vscode from 'vscode';
import { Coach } from './coach';
import { codexLoginCommand, resetCodexBin, resolveCodexBin } from './codex';
import { Llm, SECRET_KEY } from './llm';
import { Monitor } from './monitor';
import { Store } from './store';
import { CoachViewProvider } from './view';

let activeStore: Store | undefined;

export function activate(ctx: vscode.ExtensionContext): void {
  const store = new Store(ctx);
  activeStore = store;
  const llm = new Llm(ctx.secrets);
  const monitor = new Monitor();
  const coach = new Coach(store, llm, monitor);
  const view = new CoachViewProvider(ctx.extensionUri, coach);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'deliberate.open';
  const renderStatus = () => {
    const s = coach.statusInfo();
    if (!s.taskTitle) {
      status.text = '$(mortar-board) Deliberate';
      status.tooltip = 'Open the Deliberate coach';
    } else {
      const stuck = s.stuck && s.stuck.score >= 1 ? ' $(warning)' : '';
      status.text = `$(mortar-board) ${Math.floor(s.activeMin)}/${s.estimate}m · ${s.phase}${s.hints ? ` · ${s.hints} hint${s.hints > 1 ? 's' : ''}` : ''}${stuck}`;
      status.tooltip = `${s.taskTitle}${s.stuck ? `\nStuck meter ${(Math.min(1, s.stuck.score) * 100).toFixed(0)}%${s.stuck.reasons.length ? ` — ${s.stuck.reasons.join(', ')}` : ''}` : ''}`;
    }
    status.show();
  };
  renderStatus();

  ctx.subscriptions.push(
    monitor,
    coach,
    view,
    status,
    coach.onStatus(renderStatus),
    coach.onChange(renderStatus),
    vscode.window.registerWebviewViewProvider(CoachViewProvider.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('deliberate.open', () => view.reveal()),
    vscode.commands.registerCommand('deliberate.hint', () => coach.hint()),
    vscode.commands.registerCommand('deliberate.checkWork', () => coach.checkWork()),
    vscode.commands.registerCommand('deliberate.teach', () => coach.teach()),
    vscode.commands.registerCommand('deliberate.ask', async () => {
      const q = await vscode.window.showInputBox({ prompt: 'Ask the coach', placeHolder: 'e.g. why does my loop never stop?' });
      if (q?.trim()) {
        view.reveal();
        await coach.askCoach(q.trim());
      }
    }),
    vscode.commands.registerCommand('deliberate.explainSelection', async () => {
      const ed = vscode.window.activeTextEditor;
      const text = ed?.document.getText(ed.selection);
      if (!ed || !text?.trim()) {
        void vscode.window.showInformationMessage('Select some code first.');
        return;
      }
      view.reveal();
      await coach.askCoach(
        `Help me understand this code from ${vscode.workspace.asRelativePath(ed.document.uri)} — ask me what I think it does first if I seem to be guessing:\n\`\`\`\n${text}\n\`\`\``,
      );
    }),
    vscode.commands.registerCommand('deliberate.speedDrill', () => coach.speedDrill()),
    vscode.commands.registerCommand('deliberate.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Anthropic API key (stored in VS Code SecretStorage)',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-ant-...',
      });
      if (key === undefined) return;
      if (key.trim()) await ctx.secrets.store(SECRET_KEY, key.trim());
      else await ctx.secrets.delete(SECRET_KEY);
      void vscode.window.showInformationMessage(key.trim() ? 'Deliberate: API key saved.' : 'Deliberate: API key removed.');
    }),
    vscode.commands.registerCommand('deliberate.codexLogin', async () => {
      resetCodexBin();
      try {
        const bin = await resolveCodexBin(vscode.workspace.getConfiguration('deliberate').get<string>('codexPath', ''));
        const term = vscode.window.createTerminal({ name: 'Codex sign-in' });
        term.show();
        term.sendText(codexLoginCommand(bin));
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('deliberate.codexPath')) resetCodexBin();
    }),
    vscode.commands.registerCommand('deliberate.newProject', async () => {
      if (store.project) {
        const ok = await vscode.window.showWarningMessage(
          `Abandon "${store.project.title}" and start a new goal in this workspace? Your learner profile (concept mastery, mistakes) is kept.`,
          { modal: true },
          'Start new goal',
        );
        if (ok !== 'Start new goal') return;
      }
      await store.resetProject();
      view.reveal();
      coach.refresh();
    }),
    vscode.commands.registerCommand('deliberate.resetProfile', async () => {
      const ok = await vscode.window.showWarningMessage(
        'Erase your learner profile (all concept mastery, mistake journal and stats across every project)? This cannot be undone.',
        { modal: true },
        'Erase profile',
      );
      if (ok !== 'Erase profile') return;
      await store.resetLearner();
      coach.refresh();
    }),
  );

  // Spaced review: offer one due recall question shortly after the session starts.
  setTimeout(() => void coach.maybeRecall(), 20_000);
}

export function deactivate(): Thenable<void> | undefined {
  // Flush any debounced write so the last few seconds of progress are kept.
  return activeStore?.flush();
}
