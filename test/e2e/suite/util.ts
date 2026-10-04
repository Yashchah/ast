// Shared helpers for the e2e suite: the extension's test hooks, the pad tab and its document, typing
// like a learner (one character per change event, through VS Code's own 'type' command), and the
// answers seed probes expect.

import * as vscode from 'vscode';
import type { DeliberateApi, DeliberateTestHooks } from '../../../src/extension';
import type { PadRender } from '../../../src/atoms/render';
import type { StoredProbe } from '../../../src/contracts';
import { assert, sleep, waitFor, within } from './harness';

export const EXT_ID = 'yashc.deliberate-coach';
export const PAD_SCHEME = 'deliberate-pad';

let api: DeliberateApi | undefined;

export async function activateExtension(): Promise<DeliberateApi> {
  if (api) return api;
  const ext = vscode.extensions.getExtension<DeliberateApi>(EXT_ID);
  assert(ext, `extension ${EXT_ID} is installed in the test host`);
  api = await ext.activate();
  return api;
}

export function hooks(): DeliberateTestHooks {
  assert(api?.test, 'the extension exposes its test hooks (ExtensionMode.Test)');
  return api.test;
}

export function padTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === PAD_SCHEME);
}

export function padEditor(): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === PAD_SCHEME);
}

export const activeIsPad = () => vscode.window.activeTextEditor?.document.uri.scheme === PAD_SCHEME;

export function padKeys(): Record<string, unknown> {
  return Object.fromEntries(hooks().padContext);
}

/** The pad is waiting for learner input with a render other than `prev`. */
export async function nextRender(prev: PadRender | undefined, what: string, timeoutMs = 15_000): Promise<PadRender> {
  return waitFor(() => {
    const s = hooks().pad.session;
    return s && !s.closed && s.waiting && s.render && s.render !== prev ? s.render : undefined;
  }, what, timeoutMs);
}

/** Type like a learner: one 'type' command (one change event) per character, into the focused pad. */
export async function typeText(text: string): Promise<void> {
  assert(activeIsPad(), `the pad is the active editor before typing (active: ${vscode.window.activeTextEditor?.document.uri.toString() ?? 'none'})`);
  for (const ch of text) await vscode.commands.executeCommand('type', { text: ch });
}

/** The text after the last '# -> ' (or '// -> ') line of the pad document. */
export function lastAnswer(doc: vscode.TextDocument, tok = '#'): string {
  const lines = doc.getText().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = new RegExp(`^\\s*${tok === '#' ? '#' : '//'}\\s*->\\s?(.*)$`).exec(lines[i]);
    if (m) return m[1];
  }
  return '';
}

/** The seed probe whose code is on the pad (any cached atom of the language). */
export function probeOnPad(lang: 'python' | 'javascript' | 'typescript', text: string): StoredProbe | undefined {
  const cache = hooks().caches[lang];
  const norm = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const body = norm(text);
  let best: StoredProbe | undefined;
  for (const key of cache.keys()) {
    const atom = cache.get(key);
    for (const p of atom?.probes ?? []) {
      const code = norm(p.code);
      if (code && body.includes(code) && (!best || code.length > norm(best.code).length)) best = p;
    }
  }
  return best;
}

/** The answer a probe's recorded output expects: stdout lines, then the exception name, joined by ' | '. */
export function answerOf(out: { stdout: string; exception?: string }): string {
  const s = (out.stdout ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const lines = s ? s.split('\n').map((l) => l.trimEnd()) : [];
  if (out.exception) lines.push(out.exception);
  return lines.join(' | ');
}

export async function escEsc(): Promise<void> {
  await vscode.commands.executeCommand('deliberate.atomEscape');
  await vscode.commands.executeCommand('deliberate.atomEscape');
}

/** Close any QuickPick / InputBox that is open (Esc). */
export async function closeQuickInput(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
}

export async function openFixture(rel: string, column = vscode.ViewColumn.One): Promise<vscode.TextEditor> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert(folder, 'a workspace folder is open');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, rel));
  return vscode.window.showTextDocument(doc, { viewColumn: column, preview: false, preserveFocus: false });
}

/** Lines the extension logged since `from` that look like failures (expected ones filtered by `allow`). */
export function logProblems(from: number, allow: RegExp[] = []): string[] {
  return hooks()
    .log.slice(from)
    .filter((l) => /\bfail(ed|ure)?\b|\berror\b|\bcannot\b|exception|unhandled/i.test(l))
    .filter((l) => !allow.some((re) => re.test(l)));
}

/** Wait for a promise, but give up quietly (returns 'pending'). */
export async function settled<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  try {
    return await within(p, ms, 'flow');
  } catch (err) {
    if (err instanceof Error && /did not settle/.test(err.message)) return 'pending';
    throw err;
  }
}

export { sleep };
