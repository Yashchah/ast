// Entry point VS Code loads from --extensionTestsPath (bundled by test/e2e/runE2E.ts). The phase comes
// from DELIBERATE_E2E_PHASE: 'main' (the full run) or 'restart' (the same profile after a shutdown).

import { installCapture, runAll } from './harness';
import { registerMain } from './main.e2e';
import { registerRestart } from './restart.e2e';
import { hooks } from './util';

export async function run(): Promise<void> {
  installCapture();
  const phase = process.env.DELIBERATE_E2E_PHASE ?? 'main';
  if (phase === 'restart') registerRestart();
  else registerMain();
  await runAll(phase, () => {
    try {
      return { log: hooks().log, extHostPid: process.pid };
    } catch {
      return { extHostPid: process.pid };
    }
  });
}
