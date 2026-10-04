// A minimal test runner for the e2e suite (runs inside the VS Code extension host). Tests run in
// declaration order and share state; each has a timeout. Results, captured console errors and
// unhandled rejections are written to DELIBERATE_E2E_DIR/results-<phase>.json for test/e2e/runE2E.ts.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TestResult {
  name: string;
  ok: boolean;
  skipped?: string;
  ms: number;
  error?: string;
  notes: string[];
}

interface TestCase {
  name: string;
  fn: (t: TestContext) => Promise<void>;
  timeoutMs: number;
}

export interface TestContext {
  /** A line for the report (what was observed, not a failure). */
  note(text: string): void;
  /** End the test as skipped (with the reason in the report). */
  skip(reason: string): never;
}

class Skip extends Error {}

const tests: TestCase[] = [];

export function test(name: string, fn: (t: TestContext) => Promise<void>, timeoutMs = 60_000): void {
  tests.push({ name, fn, timeoutMs });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until cond() returns a truthy value; throws `what` on timeout. */
export async function waitFor<T>(cond: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, timeoutMs = 10_000, everyMs = 50): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await sleep(everyMs);
  }
}

export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let h: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<T>((_, rej) => {
    h = setTimeout(() => rej(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(h));
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

export function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed: ${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ------------------------------------------------------------------ host-level error capture

export interface Captured {
  consoleErrors: string[];
  rejections: string[];
  uncaught: string[];
}

export const captured: Captured = { consoleErrors: [], rejections: [], uncaught: [] };

function text(x: unknown): string {
  if (x instanceof Error) return `${x.name}: ${x.message}\n${x.stack ?? ''}`;
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

let installed = false;

/** Record console.error / console.warn calls and unhandled rejections in this extension host. */
export function installCapture(): void {
  if (installed) return;
  installed = true;
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    captured.consoleErrors.push(args.map(text).join(' '));
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    captured.consoleErrors.push(`[warn] ${args.map(text).join(' ')}`);
    origWarn(...args);
  };
  process.on('unhandledRejection', (r) => captured.rejections.push(text(r)));
  process.on('uncaughtException', (e) => captured.uncaught.push(text(e)));
}

// ------------------------------------------------------------------ running

export async function runAll(phase: string, extra: () => Record<string, unknown> = () => ({})): Promise<void> {
  const results: TestResult[] = [];
  const started = Date.now();
  for (const tc of tests) {
    const notes: string[] = [];
    const ctx: TestContext = {
      note: (s) => {
        notes.push(s);
        console.log(`    · ${s}`);
      },
      skip: (reason) => {
        throw new Skip(reason);
      },
    };
    const t0 = Date.now();
    console.log(`[e2e:${phase}] ${tc.name}`);
    try {
      await within(tc.fn(ctx), tc.timeoutMs, `test '${tc.name}'`);
      results.push({ name: tc.name, ok: true, ms: Date.now() - t0, notes });
      console.log(`  ok (${Date.now() - t0} ms)`);
    } catch (err) {
      if (err instanceof Skip) {
        results.push({ name: tc.name, ok: true, skipped: err.message, ms: Date.now() - t0, notes });
        console.log(`  skipped: ${err.message}`);
        continue;
      }
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      results.push({ name: tc.name, ok: false, ms: Date.now() - t0, error: msg, notes });
      console.log(`  FAILED: ${msg}`);
    }
  }
  const dir = process.env.DELIBERATE_E2E_DIR;
  const out = { phase, ms: Date.now() - started, results, captured, ...extra() };
  if (dir) fs.writeFileSync(path.join(dir, `results-${phase}.json`), JSON.stringify(out, null, 2));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error(`${failed.length} e2e test(s) failed: ${failed.map((f) => f.name).join('; ')}`);
}
