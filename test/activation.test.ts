// Activation smoke test: bundle src/extension.ts exactly as esbuild.mjs does (or load the bundle named
// by SMOKE_BUNDLE, e.g. dist/extension.js), load it with a permissive Proxy-based `vscode` module, call
// activate(), and check that every command package.json declares is registered and vice versa, that
// the webview renders, and that everything registered is released on dispose.
// Runtime discovery and seed instantiation run for real (Python/Node on PATH, when present).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module, { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// =====================================================================================
// A permissive vscode
// =====================================================================================

class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    private readonly native?: string,
  ) {}
  static file(p: string): Uri {
    const abs = path.resolve(p);
    const posix = abs.replace(/\\/g, '/');
    return new Uri('file', posix.startsWith('/') ? posix : `/${posix}`, abs);
  }
  static parse(s: string): Uri {
    const m = /^([a-zA-Z][\w+.-]*):(?:\/\/)?(.*)$/.exec(s);
    if (!m || m[1].length === 1) return Uri.file(s);
    if (m[1] === 'file') return Uri.file(decodeURIComponent(m[2]).replace(/^\/([a-zA-Z]:)/, '$1'));
    return new Uri(m[1], decodeURIComponent(m[2].startsWith('/') ? m[2] : `/${m[2]}`));
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    if (base.scheme === 'file') return Uri.file(path.join(base.fsPath, ...parts));
    return new Uri(base.scheme, [base.path.replace(/\/+$/, ''), ...parts].join('/'));
  }
  static from(c: { scheme: string; path?: string }): Uri {
    return new Uri(c.scheme, c.path ?? '/');
  }
  get fsPath(): string {
    return this.native ?? this.path;
  }
  get authority(): string {
    return '';
  }
  get query(): string {
    return '';
  }
  get fragment(): string {
    return '';
  }
  with(change: { scheme?: string; path?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.path, change.path ? undefined : this.native);
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
  toJSON(): unknown {
    return { scheme: this.scheme, path: this.path };
  }
}

class EventEmitter<T> {
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

/** Any value: callable, constructible, every property is another such value; never thenable. */
function anything(label: string): any {
  const children = new Map<PropertyKey, unknown>();
  const target = function stub() {} as unknown as object;
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return undefined;
      if (prop === 'prototype') return Reflect.get(t, prop);
      if (prop === Symbol.toPrimitive) return () => `[${label}]`;
      if (prop === Symbol.iterator) return function* empty() {};
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'toString' || prop === 'toJSON') return () => `[${label}]`;
      if (prop === 'dispose') return () => undefined;
      if (prop === 'length') return 0;
      if (!children.has(prop)) children.set(prop, anything(`${label}.${String(prop)}`));
      return children.get(prop);
    },
    apply: () => anything(`${label}()`),
    construct: () => anything(`new ${label}`),
    set: () => true,
    has: () => true,
  });
}

/** A namespace: concrete members first, anything() for the rest. */
function ns(label: string, concrete: Record<string, unknown>): any {
  const rest = anything(label);
  return new Proxy(concrete, {
    get(t, prop) {
      if (prop in t) return (t as Record<PropertyKey, unknown>)[prop];
      if (prop === 'then') return undefined;
      return rest[prop];
    },
  });
}

interface Harness {
  vscode: Record<string, unknown>;
  commands: Map<string, (...args: unknown[]) => unknown>;
  providers: Map<string, any>;
  output: string[];
  posted: unknown[];
}

function makeVscode(): Harness {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const providers = new Map<string, any>();
  const output: string[] = [];
  const posted: unknown[] = [];
  const disposable = () => ({ dispose() {} });
  const event = () => disposable();
  const config = { get: (_k: string, d?: unknown) => d, has: () => false, inspect: () => undefined, update: async () => undefined };
  const channel = (name: string) => ns(`channel:${name}`, {
    name,
    appendLine: (l: string) => output.push(`${name}: ${l}`),
    append: (l: string) => output.push(`${name}: ${l}`),
    show: () => undefined,
    clear: () => undefined,
    dispose: () => undefined,
  });

  const concrete: Record<string, unknown> = {
    Uri,
    EventEmitter,
    commands: ns('commands', {
      registerCommand(id: string, fn: (...args: unknown[]) => unknown) {
        if (commands.has(id)) throw new Error(`command '${id}' already exists`);
        commands.set(id, fn);
        return { dispose: () => commands.delete(id) };
      },
      executeCommand: async () => undefined,
      getCommands: async () => [...commands.keys()],
    }),
    workspace: ns('workspace', {
      isTrusted: true,
      workspaceFolders: undefined,
      textDocuments: [],
      getConfiguration: () => config,
      asRelativePath: (u: Uri | string) => (typeof u === 'string' ? u : u.fsPath),
      findFiles: async () => [],
      fs: ns('workspace.fs', {
        readFile: async (u: Uri) => new Uint8Array(await fs.promises.readFile(u.fsPath)),
        writeFile: async (u: Uri, data: Uint8Array) => fs.promises.writeFile(u.fsPath, data),
        createDirectory: async (u: Uri) => void (await fs.promises.mkdir(u.fsPath, { recursive: true })),
        stat: async (u: Uri) => fs.promises.stat(u.fsPath),
      }),
      onDidChangeTextDocument: event,
      onDidChangeConfiguration: event,
      onDidGrantWorkspaceTrust: event,
    }),
    window: ns('window', {
      state: { focused: true },
      activeTextEditor: undefined,
      visibleTextEditors: [],
      tabGroups: ns('tabGroups', { all: [], close: async () => true, onDidChangeTabs: event, onDidChangeTabGroups: event }),
      createOutputChannel: (name: string) => channel(name),
      registerWebviewViewProvider: (id: string, provider: unknown) => {
        providers.set(id, provider);
        return { dispose: () => providers.delete(id) };
      },
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async (m: string) => {
        output.push(`error message: ${m}`);
        return undefined;
      },
      setStatusBarMessage: () => disposable(),
    }),
    extensions: ns('extensions', { getExtension: () => undefined, all: [], onDidChange: event }),
    env: ns('env', { clipboard: { readText: async () => '', writeText: async () => undefined }, appName: 'stub', language: 'en' }),
  };

  // Every vscode.X the sources use becomes an own enumerable member (esbuild's __toESM copies those).
  const used = new Set<string>(Object.keys(concrete));
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/\bvscode\.([A-Za-z_]\w*)/g)) used.add(m[1]);
    }
  };
  walk(path.join(root, 'src'));
  for (const name of [
    'StatusBarAlignment', 'DiagnosticSeverity', 'CancellationTokenSource', 'LanguageModelChatMessage', 'comments', 'tests', 'languages', 'lm',
    'ThemeColor', 'ThemeIcon', 'MarkdownString', 'Range', 'Position', 'Selection', 'SnippetString', 'ViewColumn', 'ConfigurationTarget',
    'TextEditorRevealType', 'OverviewRulerLane', 'CommentThreadCollapsibleState', 'CommentMode', 'FileType', 'FileSystemError', 'Disposable',
    'ProgressLocation', 'QuickPickItemKind', 'InputBoxValidationSeverity', 'TextDocumentSaveReason', 'TextDocumentChangeReason', 'SymbolKind',
    'TabInputText', 'DecorationRangeBehavior', 'TestRunProfileKind', 'TestMessage', 'Location', 'LanguageModelError',
  ]) used.add(name);
  const vscode: Record<string, unknown> = {};
  for (const name of used) vscode[name] = name in concrete ? concrete[name] : anything(`vscode.${name}`);
  return { vscode, commands, providers, output, posted };
}

function memento() {
  const m = new Map<string, unknown>();
  return {
    get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
    update: async (k: string, v: unknown) => void (v === undefined ? m.delete(k) : m.set(k, v)),
    keys: () => [...m.keys()],
    setKeysForSync: () => undefined,
  };
}

function context(storage: string) {
  const subscriptions: { dispose(): unknown }[] = [];
  return {
    subscriptions,
    extensionUri: Uri.file(root),
    extensionPath: root,
    globalStorageUri: Uri.file(storage),
    storageUri: Uri.file(path.join(storage, 'workspace')),
    logUri: Uri.file(path.join(storage, 'log')),
    globalState: memento(),
    workspaceState: memento(),
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose() {} }) },
    languageModelAccessInformation: { canSendRequest: () => undefined, onDidChange: () => ({ dispose() {} }) },
    extensionMode: 3,
    asAbsolutePath: (p: string) => path.join(root, p),
    environmentVariableCollection: anything('environmentVariableCollection'),
    extension: anything('extension'),
  };
}

// =====================================================================================
// Loading the bundle
// =====================================================================================

let bundlePath: string | undefined;

async function bundle(): Promise<string> {
  if (process.env.SMOKE_BUNDLE) return path.resolve(root, process.env.SMOKE_BUNDLE);
  if (bundlePath) return bundlePath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlb-smoke-'));
  const outfile = path.join(dir, 'extension.js');
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'extension.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile,
    external: ['vscode'],
    logLevel: 'silent',
  });
  bundlePath = outfile;
  return outfile;
}

interface Ext {
  activate(ctx: unknown): { ready: Promise<void> };
  deactivate(): Promise<void>;
}

function load(file: string, vscode: Record<string, unknown>): Ext {
  const M = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const original = M._load;
  M._load = function (request: string, parent: unknown, isMain: boolean) {
    return request === 'vscode' ? vscode : original.call(this, request, parent, isMain);
  };
  try {
    const req = createRequire(file);
    delete req.cache[file];
    return req(file) as Ext;
  } finally {
    M._load = original;
  }
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} did not settle in ${ms} ms`)), ms).unref())]);
}

async function activateOnce(prepare?: (ctx: ReturnType<typeof context>) => void) {
  const h = makeVscode();
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'dlb-smoke-storage-'));
  const ctx = context(storage);
  prepare?.(ctx);
  const rejections: unknown[] = [];
  const onRejection = (r: unknown) => rejections.push(r);
  process.on('unhandledRejection', onRejection);
  const ext = load(await bundle(), h.vscode);
  const api = ext.activate(ctx);
  return {
    h, ctx, storage, ext, api, rejections,
    async shutdown() {
      await ext.deactivate();
      for (const d of ctx.subscriptions.splice(0)) d.dispose();
      process.off('unhandledRejection', onRejection);
      if (process.env.SMOKE_VERBOSE) console.log(h.output.join('\n'));
    },
  };
}

// =====================================================================================
// Tests
// =====================================================================================

test('activation registers exactly the commands package.json declares, renders the webview and releases everything', { timeout: 120_000 }, async () => {
  const run = await activateOnce();
  const { h, api } = run;
  try {
    assert.ok(api && typeof api.ready?.then === 'function', 'activate() returns { ready }');
    const declared = new Set<string>(pkg.contributes.commands.map((c: { command: string }) => c.command));
    const registered = new Set([...h.commands.keys()].filter((id) => id.startsWith('deliberate.')));
    const missing = [...declared].filter((id) => !registered.has(id));
    const undeclared = [...registered].filter((id) => !declared.has(id));
    assert.deepEqual(missing, [], 'declared but not registered');
    assert.deepEqual(undeclared, [], 'registered but not declared');
    for (const k of pkg.contributes.keybindings) assert.ok(h.commands.has(k.command), `keybinding command ${k.command}`);
    for (const m of pkg.contributes.menus.commandPalette) assert.ok(h.commands.has(m.command), `palette entry ${m.command}`);

    await within(api.ready, 90_000, 'activation start-up');
    assert.ok(h.output.some((l) => /runtimes: python/.test(l)), 'runtime discovery ran');

    // The sidebar: CSP with a nonce, and a state message once the webview says it is ready.
    const provider = h.providers.get('deliberate.coach');
    assert.ok(provider, 'webview view provider registered');
    let onMessage: ((m: unknown) => void) | undefined;
    const webview = {
      options: {},
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (u: Uri) => u,
      postMessage: async (m: unknown) => {
        h.posted.push(m);
        return true;
      },
      onDidReceiveMessage: (l: (m: unknown) => void) => {
        onMessage = l;
        return { dispose() {} };
      },
    };
    provider.resolveWebviewView({ webview, visible: true, onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), show: () => undefined });
    assert.match(webview.html, /Content-Security-Policy/);
    assert.match(webview.html, /script-src 'nonce-[A-Za-z0-9]+'/);
    assert.ok(!/unsafe-inline/.test(webview.html));
    onMessage!({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 50));
    const state = h.posted.find((m) => (m as { type?: string }).type === 'state') as { state: Record<string, any> } | undefined;
    assert.ok(state, 'state posted after ready');
    assert.equal(state.state.hasProject, false);
    assert.equal(state.state.input.mode, 'none');
    assert.match(String(state.state.shell.execution), /Local execution: not decided yet/);
    assert.ok(state.state.shell.pace, 'pace extras');

    // A few commands that need nothing: they must not throw.
    await h.commands.get('deliberate.open')!();
    await h.commands.get('deliberate.showLog')!();
    await h.commands.get('deliberate.next')!();
    assert.ok(!h.output.some((l) => /failed/.test(l) && !/runtime discovery/.test(l)), h.output.filter((l) => /failed/.test(l)).join('\n'));
  } finally {
    await run.shutdown();
  }
  assert.deepEqual([...h.commands.keys()], [], 'every command registration was disposed');
  assert.deepEqual([...h.providers.keys()], [], 'the webview provider was disposed');
  assert.deepEqual(run.rejections, [], 'no unhandled rejections');
});

test('with consent saved as all, activation instantiates seed stock and flushes the caches on deactivate', { timeout: 180_000 }, async () => {
  const run = await activateOnce((ctx) => void ctx.globalState.update('deliberate.localExecution.choice', 'all'));
  const { h, api, storage } = run;
  try {
    await within(api.ready, 150_000, 'activation start-up');
  } finally {
    await run.shutdown();
  }
  assert.deepEqual(run.rejections, []);
  const pythonFound = h.output.some((l) => /runtimes: python \d/.test(l));
  const atoms = path.join(storage, 'atoms', 'python.json');
  if (!pythonFound) {
    assert.ok(h.output.some((l) => /runtimes: python not found/.test(l)));
    return;
  }
  assert.ok(h.output.some((l) => /Local execution: snippets and your code/.test(l)), h.output.join('\n'));
  assert.ok(fs.existsSync(atoms), 'atoms/python.json written on deactivate');
  const data = JSON.parse(fs.readFileSync(atoms, 'utf8'));
  const verified = Object.values<{ verified: boolean; probes: unknown[] }>(data.atoms).filter((a) => a.verified && a.probes.length);
  assert.ok(verified.length >= 5, `verified seed atoms: ${verified.length}`);
});
