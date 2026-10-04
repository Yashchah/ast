// End-to-end run of the extension in a real VS Code window (npm run test:e2e; not part of npm test).
//
// - Uses the INSTALLED VS Code (VSCODE_E2E_EXECUTABLE, default: the per-user install on Windows); it
//   never downloads one.
// - A fresh profile per run: --user-data-dir and --extensions-dir under DELIBERATE_E2E_BASE (default
//   <os tmp>/deliberate-e2e), so the real profile is untouched. User settings are written there first:
//   deliberate.localExecution 'all', proactive hints off, deliberate.codexPath -> a fake codex that
//   records each call and fails (no model is ever called), the Python interpreter, no AI features.
// - A fixture workspace folder (todo.py, calc.py) in the same run folder.
// - Builds the extension (node esbuild.mjs) and bundles test/e2e/suite into the run folder.
// - Phase 'main' runs the suite; phase 'restart' reopens the same profile and folder after the
//   shutdown (deactivate with the pad open). Between and after the phases it looks for processes the
//   extension left running, then scans the VS Code logs for extension errors.
//
// Exit code 0 when every phase passed, nothing was left running and no extension error was logged.

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import * as esbuild from 'esbuild';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(__dirname, '..', '..');
const DEFAULT_CODE = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')
  : '';
const codeExe = process.env.VSCODE_E2E_EXECUTABLE || DEFAULT_CODE;
const DEFAULT_PYTHON = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Python', 'pythoncore-3.14-64', 'python.exe') : '';
const python = process.env.DELIBERATE_E2E_PYTHON ?? (fs.existsSync(DEFAULT_PYTHON) ? DEFAULT_PYTHON : '');
/** A phase that runs longer than this is killed (the window would otherwise stay open). */
const PHASE_LIMIT_MS = Number(process.env.DELIBERATE_E2E_PHASE_LIMIT_MS ?? 8 * 60_000);

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const base = path.resolve(process.env.DELIBERATE_E2E_BASE ?? path.join(os.tmpdir(), 'deliberate-e2e'));
const runDir = path.join(base, `run-${stamp}`);
const userData = path.join(runDir, 'user-data');
const extDir = path.join(runDir, 'extensions');
const workspace = path.join(runDir, 'workspace');
const suiteOut = path.join(runDir, 'suite', 'index.js');

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.replace(/\r\n/g, '\n'));
}

function prepare(): void {
  if (!codeExe || !fs.existsSync(codeExe)) {
    throw new Error(`VS Code not found at '${codeExe}'. Set VSCODE_E2E_EXECUTABLE to Code.exe (this run never downloads VS Code).`);
  }
  fs.mkdirSync(extDir, { recursive: true });

  const fakeCodex = path.join(runDir, process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex.sh');
  if (process.platform === 'win32') {
    write(fakeCodex, [
      '@echo off',
      '>>"%~dp0codex-calls.log" echo %DATE% %TIME% %*',
      '>&2 echo fake codex: model calls are disabled in the Deliberate e2e run',
      'exit /b 1',
      '',
    ].join('\r\n'));
  } else {
    write(fakeCodex, '#!/bin/sh\necho "$(date) $*" >> "$(dirname "$0")/codex-calls.log"\necho "fake codex: model calls are disabled" >&2\nexit 1\n');
    fs.chmodSync(fakeCodex, 0o755);
  }

  const settings: Record<string, unknown> = {
    'deliberate.localExecution': 'all',
    'deliberate.proactiveHints': 'off',
    'deliberate.provider': 'codex',
    'deliberate.codexPath': fakeCodex,
    'deliberate.padColumn': 'beside',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'chat.disableAIFeatures': true,
    'security.workspace.trust.enabled': false,
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
    'git.enabled': false,
    'files.autoSave': 'off',
    'window.restoreFullscreen': false,
  };
  if (python) settings['deliberate.pythonPath'] = python;
  write(path.join(userData, 'User', 'settings.json'), JSON.stringify(settings, null, 2));

  write(path.join(workspace, 'todo.py'), [
    '"""A tiny command-line todo list (fixture for the Deliberate e2e suite)."""',
    '',
    'todos = []',
    '',
    '',
    'def add_todo(title):',
    '    todos.append({"title": title, "done": False})',
    '    return len(todos)',
    '',
    '',
    'def list_todos():',
    '    for i, t in enumerate(todos, 1):',
    '        mark = "x" if t["done"] else " "',
    '        print(f"{i}. [{mark}] {t[\'title\']}")',
    '',
  ].join('\n'));
  write(path.join(workspace, 'calc.py'), 'def add(a, b):\n    return a - b\n');
}

async function build(): Promise<void> {
  const r = spawnSync(process.execPath, ['esbuild.mjs'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`node esbuild.mjs failed (exit ${r.status})`);
  await esbuild.build({
    entryPoints: [path.join(root, 'test', 'e2e', 'suite', 'index.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: suiteOut,
    external: ['vscode'],
    sourcemap: 'inline',
    logLevel: 'warning',
  });
}

/** VS Code started from a VS Code terminal (or an extension host) would inherit these and misbehave. */
function cleanEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('VSCODE_') || k === 'ELECTRON_NO_ATTACH_CONSOLE') delete process.env[k];
  }
}

function powershell(command: string): string {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
  } catch (err) {
    return `(powershell failed: ${(err as Error).message})`;
  }
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Processes still running whose command line names the run folder or the extension's media scripts. */
function leftovers(): string[] {
  if (process.platform !== 'win32') return [];
  const media = path.join(root, 'media');
  const out = powershell(
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.Contains(${psQuote(runDir)}) -or $_.CommandLine.Contains(${psQuote(media)})) } | ForEach-Object { "$($_.ProcessId)\`t$($_.Name)\`t$($_.CommandLine)" }`,
  );
  return out.split(/\r?\n/).filter((l) => l.trim() && !/powershell\.exe/i.test(l));
}

function killWindow(): void {
  if (process.platform !== 'win32') return;
  powershell(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${psQuote(userData)}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
}

interface PhaseOutcome {
  phase: string;
  exit: string;
  ms: number;
  results?: {
    results: { name: string; ok: boolean; skipped?: string; ms: number; error?: string; notes: string[] }[];
    captured: { consoleErrors: string[]; rejections: string[]; uncaught: string[] };
    log?: string[];
  };
  leftovers: string[];
}

async function phase(name: 'main' | 'restart'): Promise<PhaseOutcome> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let exit = 'ok';
  let output = '';
  const tee = (to: NodeJS.WriteStream) => {
    const s = new PassThrough();
    s.on('data', (d: Buffer) => {
      output = (output + d.toString()).slice(-20_000);
      to.write(d);
    });
    return s;
  };
  console.log(`\n=== phase '${name}' ===`);
  try {
    await Promise.race([
      runTests({
        stdout: tee(process.stdout),
        stderr: tee(process.stderr),
        vscodeExecutablePath: codeExe,
        extensionDevelopmentPath: root,
        extensionTestsPath: suiteOut,
        launchArgs: [
          workspace,
          `--user-data-dir=${userData}`,
          `--extensions-dir=${extDir}`,
          '--disable-extensions',
          '--disable-gpu',
          '--skip-add-to-recently-opened',
          '--disable-telemetry',
        ],
        extensionTestsEnv: { DELIBERATE_E2E_DIR: runDir, DELIBERATE_E2E_PHASE: name },
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`phase '${name}' exceeded ${PHASE_LIMIT_MS} ms: window killed`)), PHASE_LIMIT_MS);
      }),
    ]);
  } catch (err) {
    exit = (err as Error).message;
    if (/exceeded/.test(exit)) killWindow();
  } finally {
    clearTimeout(timer);
  }
  // Give child processes a moment to wind down before looking for leftovers.
  await new Promise((r) => setTimeout(r, 2000));
  const file = path.join(runDir, `results-${name}.json`);
  const results = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
  return { phase: name, exit, ms: Date.now() - t0, results, leftovers: leftovers() };
}

/** '[error]' lines in the VS Code logs that come from (or mention) this extension. */
function logErrors(): string[] {
  const logs = path.join(userData, 'logs');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^(exthost|renderer|main|sharedprocess)\.log$/.test(e.name) || /Deliberate/.test(e.name)) {
        const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
        lines.forEach((l, i) => {
          const near = lines.slice(i, i + 6).join('\n');
          if (/\[error\]/.test(l) && /deliberate|yashc|\\ast\\|\/ast\//i.test(near)) found.push(`${path.relative(logs, p)}:${i + 1}: ${near}`);
        });
      }
    }
  };
  walk(logs);
  return found;
}

async function main(): Promise<void> {
  cleanEnv();
  prepare();
  console.log(`run folder: ${runDir}`);
  console.log(`VS Code:    ${codeExe}`);
  console.log(`python:     ${python || '(discovery)'}`);
  await build();

  const outcomes: PhaseOutcome[] = [];
  outcomes.push(await phase('main'));
  outcomes.push(await phase('restart'));
  const errors = logErrors();

  let failed = false;
  console.log('\n=== summary ===');
  for (const o of outcomes) {
    console.log(`\nphase '${o.phase}': ${o.exit} (${Math.round(o.ms / 1000)} s)`);
    if (o.exit !== 'ok') failed = true;
    if (!o.results) {
      console.log('  no results file: the suite did not finish');
      failed = true;
    }
    for (const r of o.results?.results ?? []) {
      console.log(`  ${r.ok ? (r.skipped ? 'SKIP' : 'ok  ') : 'FAIL'} ${r.name} (${r.ms} ms)${r.skipped ? `: ${r.skipped}` : ''}`);
      for (const n of r.notes) console.log(`         · ${n}`);
      if (r.error) console.log(`         ${r.error.split('\n').slice(0, 6).join('\n         ')}`);
    }
    const cap = o.results?.captured;
    const ours = (xs: string[] = []) => xs.filter((x) => /deliberate|\\ast\\|\/ast\//i.test(x));
    for (const x of ours(cap?.rejections)) {
      console.log(`  unhandled rejection: ${x.split('\n').slice(0, 4).join(' / ')}`);
      failed = true;
    }
    for (const x of ours(cap?.uncaught)) {
      console.log(`  uncaught exception: ${x.split('\n').slice(0, 4).join(' / ')}`);
      failed = true;
    }
    for (const x of ours(cap?.consoleErrors)) console.log(`  console: ${x.split('\n').slice(0, 3).join(' / ')}`);
    for (const l of o.leftovers) {
      console.log(`  LEFT RUNNING after the window closed: ${l}`);
      failed = true;
    }
  }
  for (const e of errors) {
    console.log(`\nVS Code log error:\n${e}`);
    failed = true;
  }
  const calls = path.join(runDir, 'codex-calls.log');
  console.log(`\nfake codex calls: ${fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split(/\r?\n/).filter(Boolean).length : 0}`);
  console.log(`results and logs: ${runDir}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
