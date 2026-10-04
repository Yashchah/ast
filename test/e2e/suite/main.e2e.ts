// Phase 'main' of the e2e suite: a real VS Code window, the extension under development, seed
// content only. Model calls go to the fake codex runE2E.ts writes (it records the call and fails), so
// the roadmap fails and placement, atoms and sprints run on the seed bank.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PadRender } from '../../../src/atoms/render';
import type { Task } from '../../../src/types';
import { assert, assertEq, sleep, test, waitFor, within, type TestContext } from './harness';
import {
  activateExtension, activeIsPad, answerOf, closeQuickInput, EXT_ID, escEsc, hooks, lastAnswer, logProblems, nextRender, openFixture,
  padEditor, padKeys, padTabs, probeOnPad, settled, typeText,
} from './util';

/** Log lines that are expected with the fake codex (every model call fails on purpose). */
const EXPECTED = [/codex|Codex/, /Roadmap failed/, /roadmap/i];

const runDir = process.env.DELIBERATE_E2E_DIR ?? '';

/** What a driven flow saw, for the report. */
interface Driven {
  steps: string[];
  sawYn: boolean;
  sawPick: boolean;
  graded: number;
}

/**
 * Answer pad items like a learner until `graded` answers were submitted, then Esc Esc. Predict items
 * get the recorded answer (or, with `mutantFirst`, a misconception mutant's answer once, to reach the
 * belief check); y/n gets y, pick2/pick3 the right option when the render knows it, 'read' continues.
 * QuickPicks (which-pattern) get the first item.
 */
async function drive(flow: Promise<unknown>, t: TestContext, o: { graded: number; mutantFirst?: boolean; maxSteps?: number }): Promise<Driven> {
  const h = hooks();
  const d: Driven = { steps: [], sawYn: false, sawPick: false, graded: 0 };
  let prev: PadRender | undefined;
  let usedMutant = false;
  let done = false;
  void flow.finally(() => (done = true)).catch(() => undefined);
  for (let step = 0; step < (o.maxSteps ?? 14); step++) {
    if (d.graded >= o.graded) break;
    // The next render, the flow ending, or a QuickPick (the pad busy and not waiting for a while).
    let quiet = 0;
    let r: PadRender | undefined;
    for (;;) {
      if (done) break;
      const s = h.pad.session;
      if (s && !s.closed && s.waiting && s.render && s.render !== prev) {
        r = s.render;
        break;
      }
      quiet = h.pad.busy && !(s && s.waiting) ? quiet + 1 : 0;
      if (quiet > 40) {
        d.steps.push('quickpick: accept first');
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        quiet = 0;
      }
      await sleep(50);
    }
    if (done || !r) break;
    prev = r;
    const ed = padEditor();
    assert(ed, 'a pad editor is visible while the pad waits');
    const text = ed.document.getText();
    switch (r.await) {
      case 'answer': {
        const probe = probeOnPad('python', text);
        let answer = '?';
        let kind = 'unknown item: ?';
        if (/copy this exactly/.test(text) && r.codeStart !== undefined) {
          answer = text.split(/\r?\n/)[r.codeStart] ?? '?';
          kind = 'typing';
        } else if (probe) {
          const m = probe.mutants.find((x) => !x.ambiguous && answerOf(x.output) !== answerOf(probe.output));
          if (o.mutantFirst && !usedMutant && m) {
            answer = answerOf(m.output);
            usedMutant = true;
            kind = `predict (mutant ${m.misconceptionId})`;
          } else {
            answer = answerOf(probe.output);
            kind = 'predict (right answer)';
          }
        }
        if (!activeIsPad()) {
          t.note(`pad was not the active editor at '${kind}': focusing it`);
          await vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, preserveFocus: false });
        }
        await typeText(answer);
        const typed = lastAnswer(ed.document);
        if (typed.trim() !== answer.trim()) t.note(`typed '${answer}' but the answer line reads '${typed}'`);
        d.steps.push(`${kind}: '${answer}'`);
        await vscode.commands.executeCommand('deliberate.atomSubmit');
        d.graded++;
        break;
      }
      case 'yn':
        d.sawYn = true;
        d.steps.push('y/n: y');
        await vscode.commands.executeCommand('deliberate.padYes');
        break;
      case 'pick2':
      case 'pick3':
        d.sawPick = true;
        d.steps.push(`${r.await}: ${r.correctPick ?? 1}`);
        await vscode.commands.executeCommand('deliberate.padPick', r.correctPick ?? 1);
        break;
      case 'read':
        d.steps.push('read: continue');
        await vscode.commands.executeCommand('deliberate.atomSubmit');
        break;
      default:
        d.steps.push(`await '${String(r.await)}': Esc Esc`);
        await escEsc();
    }
  }
  if (!done) {
    // Leave on the next waiting render (Esc Esc only counts while the flow waits).
    await waitFor(() => done || hooks().pad.session?.waiting, 'the pad to wait before Esc Esc', 10_000);
    if (!done) {
      d.steps.push('Esc Esc');
      await escEsc();
    }
  }
  return d;
}

function assertPadClosed(where: string): void {
  assertEq(padTabs().length, 0, `${where}: no pad tab left`);
  const k = padKeys();
  assertEq(k['deliberate.atomFocused'], false, `${where}: deliberate.atomFocused`);
  assertEq(k['deliberate.padOpen'], false, `${where}: deliberate.padOpen`);
  assertEq(k['deliberate.padAwait'], '', `${where}: deliberate.padAwait`);
}

function codexCalls(): string[] {
  try {
    return fs.readFileSync(path.join(runDir, 'codex-calls.log'), 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

export function registerMain(): void {
  let logFrom = 0;
  let startProject: Promise<void> | undefined;

  test('activates, discovers runtimes and finishes start-up', async (t) => {
    const api = await activateExtension();
    assert(api.test, 'test hooks are exposed under ExtensionMode.Test');
    await within(api.ready, 60_000, 'activation start-up (api.ready)');
    const log = hooks().log;
    const rt = log.find((l) => l.startsWith('runtimes:'));
    assert(rt, `a 'runtimes:' line was logged:\n${log.join('\n')}`);
    t.note(rt);
    assert(/python \d/.test(rt), 'python was found');
    const ex = log.find((l) => /^Local execution/.test(l));
    t.note(ex ?? 'no execution summary line');
    assert(ex && /snippets and your code/.test(ex), `deliberate.localExecution 'all' allows snippets and learner code (${ex})`);
    const stock = log.filter((l) => l.startsWith('stock '));
    for (const s of stock) t.note(s);
    assert(hooks().caches.python.keys().length > 10, 'the python seed stock is in the atom cache');
    const problems = logProblems(0, EXPECTED);
    assertEq(problems, [], 'no failures logged during start-up');
    logFrom = log.length;
  });

  test('registers every command, keybinding command and palette entry package.json declares', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID)!;
    const pkg = ext.packageJSON as { contributes: { commands: { command: string }[]; keybindings: { command: string }[]; menus: { commandPalette: { command: string }[] } } };
    const all = new Set(await vscode.commands.getCommands(true));
    const declared = pkg.contributes.commands.map((c) => c.command);
    assertEq(declared.filter((c) => !all.has(c)), [], 'declared commands that are not registered');
    assertEq(pkg.contributes.keybindings.map((k) => k.command).filter((c) => !all.has(c)), [], 'keybinding commands not registered');
    assertEq(pkg.contributes.menus.commandPalette.map((k) => k.command).filter((c) => !all.has(c)), [], 'palette commands not registered');
    const extra = [...all].filter((c) => c.startsWith('deliberate.') && !declared.includes(c) && !c.startsWith('deliberate.coach'));
    assertEq(extra, [], 'registered deliberate.* commands package.json does not declare');
  });

  test('the Coach webview resolves and its script reports ready', async (t) => {
    await vscode.commands.executeCommand('deliberate.open');
    const view = hooks().view as unknown as { view?: vscode.WebviewView; ready: boolean };
    await waitFor(() => view.view, 'resolveWebviewView', 15_000);
    await waitFor(() => view.ready, "the webview's 'ready' message", 15_000);
    t.note(`webview visible: ${view.view?.visible}`);
    // Back to the editor area for the pad tests.
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
  });

  test('placement runs in the pad: tick picker, typing calibration, predict items, assisted guard, Esc Esc', async (t) => {
    const h = hooks();
    await openFixture('todo.py');
    const before = vscode.window.activeTextEditor!.document.uri.toString();
    startProject = h.coach.startProject('Build a small command-line todo list manager in Python');
    const project = await waitFor(() => h.store.project, 'the project shell', 10_000);
    assertEq(project.lang, 'python', 'the language decided from the workspace');

    // The optional 'tick what you have used' QuickPick comes first (the pad is not open yet).
    await waitFor(() => h.pad.activeFlow === 'placement', 'the placement flow', 10_000);
    await sleep(400);
    assertEq(padTabs().length, 0, 'no pad tab while the tick picker shows');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');

    // Item 1: typing calibration.
    let r = await nextRender(undefined, 'the typing item', 15_000);
    assertEq(r.await, 'answer', 'the typing item waits for an answer');
    assertEq(padTabs().length, 1, 'one pad tab');
    const ed = padEditor()!;
    assertEq(ed.document.uri.toString(), 'deliberate-pad:/atom.dlbpy', 'the pad document');
    assertEq(ed.document.languageId, 'deliberate-pad-python', 'the pad language id');
    assertEq(ed.document.eol, vscode.EndOfLine.LF, 'the pad uses LF');
    assert(activeIsPad(), 'the pad has focus');
    const k = padKeys();
    assertEq([k['deliberate.atomFocused'], k['deliberate.padOpen'], k['deliberate.padAwait']], [true, true, 'answer'], 'context keys while an answer is awaited');
    const literal = ed.document.getText().split(/\r?\n/)[r.codeStart ?? 1];
    t.note(`typing literal: ${literal}`);
    await typeText(literal);
    assertEq(lastAnswer(ed.document), literal, 'the typed literal is on the answer line');
    await vscode.commands.executeCommand('deliberate.atomSubmit');

    // Item 2: a predict item answered right.
    r = await nextRender(r, 'the first predict item', 15_000);
    let probe = probeOnPad('python', ed.document.getText());
    assert(probe, `the predict item's code is a cached seed probe:\n${ed.document.getText()}`);
    t.note(`item 2: ${probe.id} -> '${answerOf(probe.output)}'`);
    await typeText(answerOf(probe.output));
    await vscode.commands.executeCommand('deliberate.atomSubmit');

    // Item 3: a pasted answer (one 14-character insert) is discarded and the same item comes back.
    r = await nextRender(r, 'the second predict item', 15_000);
    probe = probeOnPad('python', ed.document.getText());
    assert(probe, 'the second predict item is a cached seed probe');
    const answerLine = r.answerLine!;
    await ed.edit((eb) => eb.insert(new vscode.Position(answerLine, ed.document.lineAt(answerLine).text.length), 'pasted-1234567'));
    await sleep(100);
    await vscode.commands.executeCommand('deliberate.atomSubmit');
    await waitFor(() => lastAnswer(ed.document) === '', 'the pasted answer to be cleared', 5_000);
    assert(h.pad.session?.render === r, 'the same item stays on screen after an assisted answer');
    t.note(`item 3 (${probe.id}): pasted answer discarded`);
    await typeText('?');
    await vscode.commands.executeCommand('deliberate.atomSubmit');

    // Item 4 (or the end): Esc Esc leaves placement.
    r = await nextRender(r, 'the third predict item', 15_000);
    await escEsc();
    await within(startProject, 15_000, 'startProject after Esc Esc');
    assertPadClosed('after placement');
    assertEq(vscode.window.activeTextEditor?.document.uri.toString(), before, 'the previous editor is active again');
    const p = h.store.project!;
    assert(p.placement.done, 'placement is done');
    t.note(`placement summary: ${p.placement.summary ?? '(none)'}`);
    t.note(`asked: ${p.placement.asked.join(', ')}`);
    assert(p.placement.asked.length >= 1, 'placement recorded the concepts it asked about');
    assert(p.feed.some((c) => c.title === 'Placement'), 'a Placement log card');
    // The roadmap went to the fake codex, which failed: the Retry card, no tasks.
    await waitFor(() => p.placement.planError, 'the roadmap failure from the fake codex', 15_000);
    t.note(`plan error: ${p.placement.planError}`);
    const calls = codexCalls();
    assert(calls.length >= 1, 'the roadmap call reached the fake codex (no real model call)');
    t.note(`fake codex calls so far: ${calls.length}`);
    assertEq(logProblems(logFrom, EXPECTED), [], 'no unexpected failures logged');
    logFrom = h.log.length;
  }, 120_000);

  test('an atom (deliberate.jitAtom) runs probe -> belief check (y) -> refutation in the pad', async (t) => {
    const h = hooks();
    const learner = h.store.learner;
    const cache = h.caches.python;
    // A seeded concept whose next probe carries an unambiguous misconception mutant.
    let pick: { id: string; key: string } | undefined;
    for (const key of cache.keys()) {
      const atom = cache.get(key);
      if (!atom || !learner.concepts[atom.tag]) continue;
      const seen = new Set(cache.seenIds(key));
      const fresh = atom.probes.filter((p) => !seen.has(p.id));
      if (fresh.length >= 3 && fresh.some((p) => p.discriminating && p.mutants.some((m) => !m.ambiguous)) && atom.contrasts.length) {
        pick = { id: atom.tag, key };
        break;
      }
    }
    if (!pick) return t.skip('no seeded concept with a discriminating probe and a contrast');
    t.note(`concept: ${pick.id}`);
    await openFixture('todo.py');
    const flow = Promise.resolve(vscode.commands.executeCommand('deliberate.jitAtom', pick.id));
    await nextRender(undefined, 'the atom probe', 20_000);
    assertEq(h.pad.activeFlow, 'atom', 'the atom flow runs');
    const d = await drive(flow, t, { graded: 3, mutantFirst: true });
    for (const s of d.steps) t.note(s);
    await within(flow, 20_000, 'deliberate.jitAtom');
    assertPadClosed('after the atom');
    assert(d.sawYn, 'the belief check (y/n) was reached');
    const line = h.log.find((l) => l.startsWith(`[coach] atom ${pick!.id}:`));
    t.note(line ?? 'no atom result line');
    assert(line, 'the atom result was logged');
    assertEq(logProblems(logFrom, EXPECTED), [], 'no unexpected failures logged');
    logFrom = h.log.length;
  }, 120_000);

  test('a sprint (deliberate.sprint) runs, follows focus and ends on Esc Esc', async (t) => {
    const h = hooks();
    const code = await openFixture('todo.py');
    const flow = Promise.resolve(vscode.commands.executeCommand('deliberate.sprint'));
    const r = await nextRender(undefined, 'the first sprint item', 20_000);
    assertEq(h.pad.activeFlow, 'sprint', 'the sprint flow runs');
    assert(activeIsPad(), 'the pad has focus');
    // Focus moves to the code: atomFocused goes false; back to the pad: true again.
    await vscode.window.showTextDocument(code.document, { viewColumn: code.viewColumn, preserveFocus: false });
    await waitFor(() => padKeys()['deliberate.atomFocused'] === false, 'atomFocused false while the code editor is active', 3_000);
    const pad = padEditor()!;
    await vscode.window.showTextDocument(pad.document, { viewColumn: pad.viewColumn, preserveFocus: false });
    await waitFor(() => padKeys()['deliberate.atomFocused'] === true, 'atomFocused true with the pad active again', 3_000);
    assertEq(padKeys()['deliberate.padAwait'], r.await, 'padAwait follows the render');
    const d = await drive(flow, t, { graded: 2 });
    for (const s of d.steps) t.note(s);
    await within(flow, 20_000, 'deliberate.sprint');
    assertPadClosed('after the sprint');
    assertEq(vscode.window.activeTextEditor?.document.uri.toString(), code.document.uri.toString(), 'the code editor is active again');
    const p = h.store.project!;
    const card = p.feed.filter((c) => c.title === 'Sprint').pop();
    assert(card, 'a Sprint log card');
    t.note(card.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    assertEq(logProblems(logFrom, EXPECTED), [], 'no unexpected failures logged');
    logFrom = h.log.length;
  }, 120_000);

  test("'Leave practice' and closing the pad tab both end a sprint", async (t) => {
    const h = hooks();
    await openFixture('todo.py');
    let flow = Promise.resolve(vscode.commands.executeCommand('deliberate.sprint'));
    await nextRender(undefined, 'a sprint item', 20_000);
    await vscode.commands.executeCommand('deliberate.leavePractice');
    await within(flow, 10_000, 'the sprint after Leave practice');
    assertPadClosed('after Leave practice');

    flow = Promise.resolve(vscode.commands.executeCommand('deliberate.sprint'));
    await nextRender(undefined, 'a sprint item', 20_000);
    const tabs = padTabs();
    assertEq(tabs.length, 1, 'one pad tab');
    await vscode.window.tabGroups.close(tabs, false);
    await within(flow, 10_000, 'the sprint after its tab closed');
    assertPadClosed('after closing the pad tab');
    assert(!h.pad.busy, 'no flow left running');
    t.note(`pad session after close: ${h.pad.session ? (h.pad.session.closed ? 'closed' : 'OPEN') : 'none'}`);
    assertEq(logProblems(logFrom, EXPECTED), [], 'no unexpected failures logged');
    logFrom = h.log.length;
  }, 90_000);

  test('pad commands are harmless when no pad is open', async () => {
    for (const c of ['deliberate.atomSubmit', 'deliberate.atomSubmitGuess', 'deliberate.padYes', 'deliberate.padNo', 'deliberate.atomEscape', 'deliberate.leavePractice']) {
      await vscode.commands.executeCommand(c);
    }
    await vscode.commands.executeCommand('deliberate.padPick', 1);
    assertPadClosed('after stray pad commands');
  });

  test('behaviour specs run on save through the harness (hand-written ladder via the test hooks)', async (t) => {
    const h = hooks();
    const p = h.store.project!;
    const conceptId = Object.keys(h.store.learner.concepts).find((id) => /function/.test(id)) ?? Object.keys(h.store.learner.concepts)[0];
    const id = 'task-e2e-spec';
    const spec = (sid: string, title: string, call: string, expected: string) => ({
      id: sid, title, conceptId, call, expected, expectError: '', parSec: 30,
      failureSignatures: [{ match: 'equals' as const, value: '-1', misconceptionId: 'subtracts-instead-of-adding', nudge: 'Which operator gives the total of two numbers?' }],
    });
    const task: Task = {
      id, title: 'Add two numbers', description: 'Write add(a, b) in calc.py.', acceptanceCriteria: ['add returns the sum'], conceptIds: [],
      estimatedMinutes: 5, kind: 'roadmap', followUpDepth: 0, status: 'todo', phase: 'building', activeMs: 0, stuckMs: 0, explainAttempts: 0,
      hints: [], revealed: false, offeredRung: 0, feed: [], fade: 'full', solo: false,
      interface: { file: 'calc.py', functions: [{ name: 'add', signature: 'add(a, b)', purpose: 'the sum of a and b' }] },
      gate: { patterns: [], plans: [] },
      spec: {
        specs: [spec('s1', 'adds two numbers', 'add(2, 3)', '5'), spec('s2', 'adds negative numbers', 'add(-1, -2)', '-3')],
        hidden: [spec('h1', 'adds zeros', 'add(0, 0)', '0')],
        greenAt: {}, firstRedAt: {}, savesSinceRed: {}, runs: 0, verified: true, applicable: true,
      },
    };
    p.tasks[id] = task;
    if (!p.milestones.length) p.milestones.push({ title: 'Milestone 1', taskIds: [] });
    p.milestones[0].taskIds.push(id);
    await h.coach.startTask(id);
    const live = h.store.project!.tasks[id];
    t.note(`task phase: ${live.phase}, specs applicable: ${h.specs.applicable}, reason: ${h.specs.reason ?? '-'}`);
    assertEq(h.specs.taskId, id, 'the ladder is attached to the task');
    assert(h.specs.applicable, `the ladder applies (${h.specs.reason})`);

    // First save: add(2, 3) == -1, the failure signature's value.
    const ed = await openFixture('calc.py');
    const line = ed.document.getText().split(/\r?\n/).findIndex((l) => l.includes('return a - b'));
    assert(line >= 0, 'calc.py has the buggy return line');
    const eol = ed.document.lineAt(line).text.length;
    ed.selection = new vscode.Selection(line, eol, line, eol);
    await vscode.commands.executeCommand('type', { text: ' ' });
    await ed.document.save();
    await waitFor(() => live.spec?.last?.s1, 'the first spec run', 30_000);
    t.note(`run 1: ${JSON.stringify(live.spec!.last)}`);
    assertEq(live.spec!.last!.s1.pass, false, 's1 is red');
    assertEq(live.spec!.last!.s1.actual, '-1', "s1's actual value");

    // Fix it like a learner: select the '-' and type '+'.
    const col = ed.document.lineAt(line).text.indexOf('-');
    ed.selection = new vscode.Selection(line, col, line, col + 1);
    await vscode.commands.executeCommand('type', { text: '+' });
    await ed.document.save();
    await waitFor(() => live.spec?.last?.s1?.pass && live.spec.last.s2?.pass, 'both visible specs green', 30_000);
    t.note(`run 2: ${JSON.stringify(live.spec!.last)}`);
    await waitFor(() => live.criteriaMetAt, 'the hidden spec to pass (criteria met)', 30_000);
    // What-if questions (InputBox) may follow: Esc them (neutral) until the task settles.
    for (let i = 0; i < 20 && live.status === 'active' && !live.explainBackQuestion; i++) {
      await closeQuickInput();
      await sleep(250);
    }
    t.note(`task status after green: ${live.status} (phase ${live.phase})`);
    t.note(`spec runs: ${live.spec!.runs}, greenAt: ${Object.keys(live.spec!.greenAt).join(', ')}`);
    assertEq(logProblems(logFrom, [...EXPECTED, /TaskPrep|TaskBatch|follow-?up|FollowUp|what-if|Codex/i]), [], 'no unexpected failures logged');
    logFrom = h.log.length;
  }, 150_000);

  test('no child processes of the extension host are left behind after the flows', async (t) => {
    await sleep(500);
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { "$($_.ProcessId)\`t$($_.Name)\`t$($_.CommandLine)" }`], { encoding: 'utf8', windowsHide: true });
    const kids = out.split(/\r?\n/).filter((l) => l.trim() && !/powershell\.exe/i.test(l));
    for (const k of kids) t.note(`child: ${k}`);
    const ours = kids.filter((k) => /python|batch\.(py|mjs)|harness|prelude|codex|deliberate/i.test(k));
    assertEq(ours, [], "the extension's runner, harness and codex processes have all exited");
  }, 30_000);

  test('leave a sprint open for the shutdown (the restart phase checks what deactivate left)', async (t) => {
    const h = hooks();
    fs.writeFileSync(path.join(runDir, 'exthost-pid.txt'), String(process.pid));
    await openFixture('todo.py');
    void vscode.commands.executeCommand('deliberate.sprint');
    await nextRender(undefined, 'a sprint item', 20_000);
    assertEq(padTabs().length, 1, 'the pad is open at shutdown');
    t.note(`left open: ${h.pad.activeFlow} on ${padEditor()?.document.uri.toString()}`);
    // Let the store flush its debounced save (300 ms) before the window closes.
    await sleep(800);
    await settled(h.store.flush(), 5_000);
  });
}
