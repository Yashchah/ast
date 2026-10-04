import { spawn, type ChildProcess, type StdioOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { RunResult } from './contracts';

/**
 * Child-process plumbing shared by the local runner and the Codex client.
 *
 * Timeouts and aborts kill the whole process tree, not just the direct child:
 * on win32 a .cmd shim runs under cmd.exe and a harness may start helpers, and a plain
 * child.kill() would leave those running. win32 uses `taskkill /T /F`; POSIX spawns the
 * child as a process-group leader and kills the group.
 */

export interface SpawnOptions {
  cwd?: string;
  /** Complete environment for the child. Default: inherit process.env. */
  env?: NodeJS.ProcessEnv;
  /** Text written to stdin (then closed). Undefined = stdin 'ignore'. */
  stdin?: string;
  /** Kill the tree after this many ms and resolve with timedOut. 0 / undefined = no limit. */
  timeoutMs?: number;
  /** Abort kills the tree and rejects with the signal's reason (an AbortError by default). */
  signal?: AbortSignal;
  /** Characters kept: the head of stdout and the tail of stderr. Default 1,000,000. */
  maxOut?: number;
  /** win32 only: run through cmd.exe, needed for .cmd shims (npm installs). Ignored elsewhere. */
  shell?: boolean;
  /** Streamed stdout text (decoded, before capping), e.g. to watch protocol lines. */
  onStdout?: (chunk: string) => void;
}

export interface ProcResult extends RunResult {
  /** stdout or stderr went over maxOut and was cut. */
  truncated: boolean;
  /** POSIX signal that ended the process, if any. */
  signal: NodeJS.Signals | null;
}

const isWin = process.platform === 'win32';
/** After 'exit', how long to wait for stdio to drain. A surviving grandchild can hold the pipes open forever. */
const DRAIN_MS = 250;

export function spawnCapped(bin: string, args: string[], o: SpawnOptions = {}): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(abortReason(o.signal));
    const t0 = performance.now();
    const max = o.maxOut ?? 1_000_000;
    const stdio: StdioOptions = [o.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'];
    let child: ChildProcess;
    try {
      child =
        o.shell && isWin
          ? spawn([bin, ...args].map(quoteCmdArg).join(' '), { cwd: o.cwd, env: o.env, stdio, shell: true, windowsHide: true })
          : // detached on POSIX makes the child a process-group leader, so killTree can kill the group.
            spawn(bin, args, { cwd: o.cwd, env: o.env, stdio, windowsHide: true, detached: !isWin });
    } catch (e) {
      return reject(e);
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let killing: Promise<void> | undefined;
    let exit: { code: number | null; sig: NodeJS.Signals | null } | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let done = false;

    child.stdout!.setEncoding('utf8'); // decoder keeps multi-byte characters split across chunks intact
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      o.onStdout?.(d);
      if (stdout.length >= max) return void (truncated = true);
      stdout += d;
      if (stdout.length > max) {
        stdout = stdout.slice(0, max);
        truncated = true;
      }
    });
    child.stderr!.on('data', (d: string) => {
      stderr += d;
      if (stderr.length > max) {
        stderr = stderr.slice(-max);
        truncated = true;
      }
    });
    if (child.stdin) {
      child.stdin.on('error', () => undefined); // the process may exit before reading stdin
      child.stdin.end(o.stdin);
    }

    const kill = () => (killing ??= child.pid ? killTree(child.pid) : Promise.resolve());
    const timer = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          void kill();
        }, o.timeoutMs)
      : undefined;
    const onAbort = () => {
      aborted = true;
      void kill();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = async (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      o.signal?.removeEventListener('abort', onAbort);
      child.stdout!.destroy();
      child.stderr!.destroy();
      // Resolve only once taskkill has returned, so callers never see a half-dead tree.
      if (killing) await killing;
      if (aborted) return reject(abortReason(o.signal!));
      if (err) return reject(err);
      resolve({
        stdout,
        stderr,
        exitCode: exit?.code ?? null,
        timedOut,
        ms: Math.round(performance.now() - t0),
        truncated,
        signal: exit?.sig ?? null,
      });
    };
    child.on('error', (e) => void finish(e));
    child.on('exit', (code, sig) => {
      exit = { code, sig };
      drainTimer = setTimeout(() => void finish(), DRAIN_MS);
    });
    child.on('close', (code, sig) => {
      exit ??= { code, sig };
      void finish();
    });
  });
}

/** Kill a process and all of its descendants. Never throws; resolves when the kill command has run. */
export function killTree(pid: number): Promise<void> {
  if (isWin) {
    return new Promise((resolve) => {
      const sysTaskkill = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      const exe = fs.existsSync(sysTaskkill) ? sysTaskkill : 'taskkill';
      const k = spawn(exe, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
        resolve();
      });
      k.on('exit', () => resolve());
    });
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  return Promise.resolve();
}

/** Quote one argument for a cmd.exe command line. */
export function quoteCmdArg(a: string): string {
  return /[\s&|<>^"()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

function abortReason(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  if (r instanceof Error) return r;
  const e = new Error(typeof r === 'string' ? r : 'The operation was aborted');
  e.name = 'AbortError';
  return e;
}
