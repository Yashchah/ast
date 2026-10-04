// Phase 'restart' of the e2e suite: the same profile and folder after phase 'main' shut down with a
// sprint open in the pad. Checks what deactivate and the next activation leave: no pad tabs (their
// in-memory files are gone), clean context keys, the project and learner persisted, and the pad
// working again.

import * as vscode from 'vscode';
import { assert, assertEq, sleep, test, waitFor, within } from './harness';
import { activateExtension, escEsc, hooks, logProblems, nextRender, openFixture, padKeys, padTabs } from './util';

const EXPECTED = [/codex|Codex/, /Roadmap failed/, /roadmap/i];

export function registerRestart(): void {
  test('activates again after the shutdown', async (t) => {
    const api = await activateExtension();
    await within(api.ready, 60_000, 'activation start-up (api.ready)');
    t.note(hooks().log.find((l) => l.startsWith('runtimes:')) ?? 'no runtimes line');
  });

  test('no pad tab survives the reload and the pad context keys are off', async (t) => {
    // closeLeftoverPadTabs runs at activation; restored tabs may appear a moment later.
    await sleep(1500);
    const tabs = padTabs();
    t.note(`pad tabs after reload: ${tabs.map((x) => (x.input as vscode.TabInputText).uri.toString()).join(', ') || 'none'}`);
    await waitFor(() => padTabs().length === 0, 'leftover pad tabs to close', 10_000);
    const k = padKeys();
    assert(k['deliberate.atomFocused'] !== true, 'deliberate.atomFocused is not set');
    assert(k['deliberate.padOpen'] !== true, 'deliberate.padOpen is not set');
  });

  test('the project and the learner profile persisted across the restart', async (t) => {
    const h = hooks();
    const p = h.store.project;
    assert(p, 'the project is restored from workspaceState');
    assertEq(p.lang, 'python', 'project language');
    assert(p.placement.done, 'placement stays done');
    const n = Object.keys(h.store.learner.concepts).length;
    t.note(`learner concepts: ${n}, deck cards: ${h.store.learner.patternDeck.length}`);
    assert(n > 0, 'learner concepts restored from globalState');
    const task = p.tasks['task-e2e-spec'];
    t.note(`e2e spec task: ${task ? `${task.status}/${task.phase}, criteriaMetAt ${task.criteriaMetAt ? 'set' : 'unset'}` : 'missing'}`);
  });

  test('the pad works again after the reload (a sprint item, then Esc Esc)', async (t) => {
    const h = hooks();
    await openFixture('todo.py');
    const flow = Promise.resolve(vscode.commands.executeCommand('deliberate.sprint'));
    const r = await nextRender(undefined, 'a sprint item', 20_000);
    t.note(`first item awaits '${r.await}'`);
    assertEq(padTabs().length, 1, 'one pad tab');
    await escEsc();
    await within(flow, 10_000, 'the sprint after Esc Esc');
    assertEq(padTabs().length, 0, 'the pad closed');
    assertEq(padKeys()['deliberate.padOpen'], false, 'padOpen off');
    assertEq(logProblems(0, EXPECTED), [], 'no unexpected failures logged since activation');
    void h;
  }, 60_000);
}
