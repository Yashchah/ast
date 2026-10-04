// Minimal stand-in for the `vscode` module so the coach state machine can run under node:test.
// Only the surface the coach touches outside of Monitor is implemented.

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export const stubState = { warningAnswer: undefined as string | undefined, config: {} as Record<string, unknown> };

export const workspace = {
  getConfiguration: () => ({ get: <T>(key: string, def: T): T => (key in stubState.config ? (stubState.config[key] as T) : def) }),
  findFiles: async () => [],
  asRelativePath: (u: { path?: string }) => u.path ?? String(u),
  textDocuments: [],
};

export const window = {
  activeTextEditor: undefined,
  showWarningMessage: async () => stubState.warningAnswer,
  showInformationMessage: async () => undefined,
};

export const languages = { getDiagnostics: () => [] };
export enum DiagnosticSeverity { Error = 0, Warning = 1 }
export class CancellationTokenSource { token = {}; }
