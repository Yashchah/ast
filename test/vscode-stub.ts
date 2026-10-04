// Minimal stand-in for the `vscode` module so the coach and the modules it imports can run under
// node:test (test/tsconfig.json maps 'vscode' here). Only what is touched at runtime by code paths the
// tests exercise is implemented; everything vscode-facing in the coach goes through injected ports.

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export const stubState = {
  warningAnswer: undefined as string | undefined,
  config: {} as Record<string, unknown>,
  quickPick: undefined as string | undefined,
  inputBox: undefined as string | undefined,
  focused: true,
  executed: [] as { command: string; args: unknown[] }[],
};

/** file:// and untitled: uris, enough for path handling in context.ts and the hosts. */
export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
  ) {}
  static parse(value: string): Uri {
    const m = /^([a-zA-Z][\w+.-]*):(?:\/\/)?(.*)$/.exec(value);
    if (!m || m[1].length === 1) return Uri.file(value);
    return new Uri(m[1], decodeURIComponent(m[2].startsWith('/') ? m[2] : `/${m[2]}`));
  }
  static file(fsPath: string): Uri {
    const p = fsPath.replace(/\\/g, '/');
    return new Uri('file', p.startsWith('/') ? p : `/${p}`);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, [base.path.replace(/\/+$/, ''), ...parts].join('/'));
  }
  get fsPath(): string {
    const p = this.path;
    return /^\/[a-zA-Z]:/.test(p) ? p.slice(1).replace(/\//g, '\\') : p;
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export const workspace = {
  getConfiguration: () => ({ get: <T>(key: string, def: T): T => (key in stubState.config ? (stubState.config[key] as T) : def) }),
  findFiles: async () => [],
  asRelativePath: (u: { path?: string }) => u.path ?? String(u),
  textDocuments: [] as { uri: Uri; getText(): string; languageId: string; isDirty: boolean }[],
  workspaceFolders: undefined as { uri: Uri; name: string }[] | undefined,
  fs: {
    readFile: async (): Promise<Uint8Array> => {
      throw new Error('no file system in tests');
    },
  },
};

export const window = {
  activeTextEditor: undefined,
  state: {
    get focused() {
      return stubState.focused;
    },
  },
  showWarningMessage: async () => stubState.warningAnswer,
  showInformationMessage: async () => undefined,
  showQuickPick: async () => stubState.quickPick,
  showInputBox: async () => stubState.inputBox,
  setStatusBarMessage: () => ({ dispose() {} }),
  withProgress: async <T>(_o: unknown, task: () => Promise<T>) => task(),
};

export const commands = {
  executeCommand: async (command: string, ...args: unknown[]) => {
    stubState.executed.push({ command, args });
    return undefined;
  },
};

export const languages = { getDiagnostics: () => [] };
export enum DiagnosticSeverity { Error = 0, Warning = 1 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export class CancellationTokenSource { token = {}; cancel() {} dispose() {} }
