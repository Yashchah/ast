import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  LocalRunner,
  PATH_PYTHON_CANDIDATES,
  detectRuntimes,
  venvCandidates,
  type DetectedRuntime,
  type DetectedRuntimes,
  type PythonCandidate,
} from './runner';

/**
 * VS Code side of runtime detection (spec V1-2): gathers Python interpreter candidates in spec
 * order and hands them to runner.ts. Results are held in memory by the caller, never persisted.
 *
 * In an untrusted workspace nothing the workspace provides is executed: its .venv, its settings
 * and its node_modules/.bin/tsx are skipped, as is the Python extension's selection (which may
 * point into the workspace). Re-run discovery from onDidGrantWorkspaceTrust.
 */

const API_TIMEOUT_MS = 5000;

interface PythonExtensionApi {
  environments?: {
    getActiveEnvironmentPath(resource?: vscode.Uri): unknown;
    resolveEnvironment(env: unknown): Promise<{ executable?: { uri?: vscode.Uri } } | undefined>;
  };
}

function withTimeout<T>(p: Thenable<T>, ms: number): Promise<T | undefined> {
  return Promise.race([Promise.resolve(p), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

/** The interpreter selected in the Python extension: its environments API, else python.interpreterPath. */
async function msPythonInterpreter(folder: vscode.WorkspaceFolder | undefined): Promise<string | undefined> {
  const ext = vscode.extensions.getExtension<PythonExtensionApi>('ms-python.python');
  if (!ext) return undefined;
  try {
    const api = ext.isActive ? ext.exports : await withTimeout(ext.activate(), API_TIMEOUT_MS);
    const envs = api?.environments;
    if (envs) {
      const env = await withTimeout(envs.resolveEnvironment(envs.getActiveEnvironmentPath(folder?.uri)), API_TIMEOUT_MS);
      const exe = env?.executable?.uri?.fsPath;
      if (exe) return exe;
    }
  } catch {
    // fall back to the command
  }
  try {
    const exe = await withTimeout(
      vscode.commands.executeCommand<string>('python.interpreterPath', { workspaceFolder: folder?.uri.fsPath }),
      API_TIMEOUT_MS,
    );
    return typeof exe === 'string' && exe.trim() ? exe : undefined;
  } catch {
    return undefined;
  }
}

/** ${workspaceFolder}, ~ and relative paths in python.defaultInterpreterPath. */
function expandPath(p: string, folder: vscode.WorkspaceFolder | undefined): string {
  let s = p.replace(/\$\{workspaceFolder\}/g, folder?.uri.fsPath ?? '').replace(/^~(?=$|[\\/])/, os.homedir());
  if (/[\\/]/.test(s) && !path.isAbsolute(s) && folder) s = path.join(folder.uri.fsPath, s);
  return s;
}

/** Python candidates, in spec order: Python extension, workspace venv, settings, PATH. */
export async function pythonCandidates(folder: vscode.WorkspaceFolder | undefined): Promise<PythonCandidate[]> {
  const trusted = vscode.workspace.isTrusted;
  const out: PythonCandidate[] = [];
  const add = (bin: string | undefined, source: string) => {
    if (bin?.trim()) out.push({ bin: bin.trim(), source });
  };
  if (trusted) add(await msPythonInterpreter(folder), 'ms-python');
  if (trusted && folder) out.push(...venvCandidates(folder.uri.fsPath));
  add(vscode.workspace.getConfiguration('deliberate').get<string>('pythonPath'), 'deliberate.pythonPath'); // machine scope
  const cfg = vscode.workspace.getConfiguration('python', folder?.uri);
  const def = trusted ? cfg.get<string>('defaultInterpreterPath') : cfg.inspect<string>('defaultInterpreterPath')?.globalValue;
  if (def && def !== 'python') add(expandPath(def, folder), 'python.defaultInterpreterPath');
  out.push(...PATH_PYTHON_CANDIDATES);
  return out;
}

export function runnerDir(extensionUri: vscode.Uri): string {
  return vscode.Uri.joinPath(extensionUri, 'media', 'runner').fsPath;
}

export function runRoot(globalStorageUri: vscode.Uri): string {
  return path.join(globalStorageUri.fsPath, 'run');
}

/** Detect Python, Node and TypeScript for the first workspace folder. */
export async function discoverRuntimes(o: {
  extensionUri: vscode.Uri;
  globalStorageUri: vscode.Uri;
  log?: (msg: string) => void;
  signal?: AbortSignal;
}): Promise<DetectedRuntimes> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const cwd = runRoot(o.globalStorageUri);
  await fs.mkdir(cwd, { recursive: true });
  return detectRuntimes({
    pythonCandidates: await pythonCandidates(folder),
    workspaceDir: vscode.workspace.isTrusted ? folder?.uri.fsPath : undefined,
    runnerDir: runnerDir(o.extensionUri),
    cwd,
    log: o.log,
    signal: o.signal,
  });
}

/** A runner for one detected runtime, with temp dirs under globalStorage/run. */
export function makeRunner(rt: DetectedRuntime, extensionUri: vscode.Uri, globalStorageUri: vscode.Uri): LocalRunner {
  return new LocalRunner(rt, { runnerDir: runnerDir(extensionUri), runRoot: runRoot(globalStorageUri) });
}
