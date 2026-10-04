import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { quoteCmdArg, spawnCapped } from './proc';

/**
 * Runs coach calls through the Codex CLI (`codex exec`), so they count against the
 * learner's ChatGPT/Codex plan limits instead of needing an API key.
 *
 * Each call is a one-shot, ephemeral, read-only session in an empty temp directory
 * with `--output-schema`, so Codex returns a single JSON object and has nothing to explore.
 */

export interface CodexOptions {
  bin: string;
  model: string;
  effort: string;
  fast: boolean;
  timeoutMs: number;
}

export class CodexError extends Error {}

/**
 * Per-call timeout. It only guards against a hung CLI, and a call that times out has still used
 * plan quota while returning nothing, so it must fit the slowest normal answer. On the standard tier
 * (fast off: every background call) a medium PlanOutline of ~3.1k output tokens took 100 s and once
 * went past 180 s (~30 tokens/s); TaskPrep and two-concept AtomPacks are larger. The priority tier
 * (calls the learner waits on) is faster and keeps the shorter limits.
 */
export function codexTimeoutMs(effort: string, fast: boolean): number {
  const high = effort === 'high';
  if (fast) return high ? 300_000 : 180_000;
  return high ? 600_000 : 480_000;
}

const SUFFIX =
  'You are being called as a function, not as an agent: do not run commands, read files or use tools. ' +
  'Everything you need is above. Reply with only the JSON object matching the output schema.';

export function codexArgs(o: Omit<CodexOptions, 'bin' | 'timeoutMs'>, dir: string, schemaFile: string, outFile: string): string[] {
  return [
    'exec',
    // Ignore ~/.codex/config.toml (notify hooks, MCP servers, profiles); auth still comes from CODEX_HOME.
    '--ignore-user-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--color', 'never',
    '-C', dir,
    '-m', o.model,
    '-c', `model_reasoning_effort=${o.effort}`,
    // "Fast" in the Codex UI is the priority service tier: ~1.5x speed, more plan usage.
    ...(o.fast ? ['-c', 'service_tier=priority'] : []),
    '--output-schema', schemaFile,
    '-o', outFile,
    '-', // prompt on stdin: coach prompts exceed Windows command-line limits
  ];
}

/** Turn codex stderr into one actionable sentence. */
export function codexErrorMessage(stderr: string, exitCode: number | null): string {
  const apiErrors = [...stderr.matchAll(/ERROR:\s*(\{.*\})/g)];
  const last = apiErrors.at(-1);
  if (last) {
    try {
      const msg: string = JSON.parse(last[1])?.error?.message ?? '';
      if (/not supported when using Codex with a ChatGPT account/i.test(msg)) {
        return `${msg} Your Codex CLI may be too old for this model: update it (npm i -g @openai/codex@latest), set deliberate.codexPath to a newer codex binary, or change deliberate.codexModel.`;
      }
      if (/usage limit|rate limit/i.test(msg)) return `Codex plan limit reached: ${msg}`;
      if (msg) return `Codex error: ${msg}`;
    } catch {
      // fall through to generic handling
    }
  }
  if (/not logged in|login required|401|unauthorized/i.test(stderr)) {
    return 'Codex is not signed in. Run "Deliberate: Sign in to Codex" (or `codex login`) and try again.';
  }
  const tail = stderr
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/failed to load skill/i.test(l))
    .slice(-3)
    .join(' ');
  return `Codex exited with code ${exitCode ?? 'unknown'}${tail ? `: ${tail}` : ''}`;
}

export async function runCodex(
  o: CodexOptions,
  system: string,
  prompt: string,
  jsonSchema: object,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deliberate-'));
  try {
    const schemaFile = path.join(dir, 'schema.json');
    const outFile = path.join(dir, 'out.json');
    await fs.writeFile(schemaFile, JSON.stringify(jsonSchema));
    const input = `${system}\n\n---\n\n${prompt}\n\n---\n\n${SUFFIX}`;
    const { code, stderr } = await exec(o.bin, codexArgs(o, dir, schemaFile, outFile), input, dir, o.timeoutMs, signal);
    const out = await fs.readFile(outFile, 'utf8').catch(() => '');
    if (!out.trim()) throw new CodexError(codexErrorMessage(stderr, code));
    return out;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- binary discovery

let resolved: Promise<string> | undefined;

/**
 * Pick the newest Codex binary on the machine. The Codex desktop app ships its own,
 * often newer than a global npm install, and new models are gated on client version.
 */
export function resolveCodexBin(setting: string): Promise<string> {
  if (setting.trim()) return Promise.resolve(setting.trim());
  resolved ??= findNewestCodex().catch((e) => {
    resolved = undefined; // retry discovery next time (e.g. after the user installs it)
    throw e;
  });
  return resolved;
}

export function resetCodexBin(): void {
  resolved = undefined;
}

async function findNewestCodex(): Promise<string> {
  const candidates: string[] = [];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const base = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    for (const d of await fs.readdir(base).catch(() => [] as string[])) candidates.push(path.join(base, d, 'codex.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Codex.app/Contents/Resources/codex');
  }
  candidates.push('codex');
  const found = await Promise.all(candidates.map(async (bin) => ({ bin, version: await versionOf(bin) })));
  const best = found
    .filter((f): f is { bin: string; version: number[] } => !!f.version)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!best) {
    throw new CodexError('Codex CLI not found. Install the Codex app or run `npm i -g @openai/codex`, then sign in with `codex login`.');
  }
  return best.bin;
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

async function versionOf(bin: string): Promise<number[] | undefined> {
  try {
    const { code, stdout } = await exec(bin, ['--version'], '', undefined, 15_000);
    const m = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
    return code === 0 && m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- process plumbing

export function codexLoginCommand(bin: string): string {
  return `${quoteCmdArg(bin)} login`;
}

async function exec(
  bin: string,
  args: string[],
  stdin: string,
  cwd: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // npm installs a .cmd shim on Windows, which Node can only start through a shell.
  // spawnCapped kills the whole tree on timeout/abort, so the node process behind cmd.exe dies too.
  const shell = process.platform === 'win32' && !/\.exe$/i.test(bin);
  const r = await spawnCapped(bin, args, { cwd, stdin, timeoutMs, signal, maxOut: 50_000, shell });
  if (r.timedOut) throw new CodexError(`Codex did not answer within ${Math.round(timeoutMs / 1000)}s.`);
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}
