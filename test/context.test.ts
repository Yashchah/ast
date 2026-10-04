// src/context.ts: the code snapshot for prompts (never a fixed failure as current; the coach's own
// scratch under globalStorage or the OS temp dir is never treated as the learner's code).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import { gatherCodeContext, isLearnerFile, isUnder } from '../src/context';
import { StuckDetector } from '../src/stuck';

function monitor(touched: string[] = []) {
  return { detector: new StuckDetector(), touchedFiles: new Set(touched), lastEditAt: 0, currentErrors: () => [] };
}

test('code context never shows a fixed failure as current, and flags output older than the code', async () => {
  const m = monitor();
  m.detector.onTerminal(1000, 'python main.py', 1, 'NameError: foo');
  m.lastEditAt = 2000;
  let ctx = await gatherCodeContext(m);
  assert.match(ctx, /FAILED \(exit 1\)/);
  assert.match(ctx, /edited AFTER this run/);
  m.detector.onTerminal(3000, 'python main.py', 0, 'ok');
  ctx = await gatherCodeContext(m);
  assert.doesNotMatch(ctx, /NameError/);
  assert.match(ctx, /succeeded \(exit 0\)/);
});

test('files under globalStorage or the OS temp dir are never the learner code', async () => {
  const tmp = path.join(os.tmpdir(), 'dlb-run', 'b-1', 'snippet.py');
  const storage = path.join(path.parse(os.tmpdir()).root, 'Users', 'me', 'globalStorage', 'yashc.deliberate-coach');
  assert.equal(isUnder(tmp, [os.tmpdir()]), true);
  assert.equal(isUnder(path.join(storage, 'specs', 't1.json'), [storage]), true);
  assert.equal(isUnder(`${storage}-other${path.sep}x.py`, [storage]), false, 'a sibling folder with the same prefix is not inside');
  assert.equal(isLearnerFile({ scheme: 'file', fsPath: tmp }), false);
  assert.equal(isLearnerFile({ scheme: 'file', fsPath: path.join(storage, 'verify', 'a.py') }, [storage]), false);
  assert.equal(isLearnerFile({ scheme: 'file', fsPath: path.join(path.parse(os.tmpdir()).root, 'proj', 'todo.py') }, [storage]), true);
  assert.equal(isLearnerFile({ scheme: 'deliberate-pad', fsPath: '/atom.dlbpy' }), false, 'the practice pad is not project code');
  assert.equal(isLearnerFile({ scheme: 'untitled', fsPath: 'Untitled-1' }), true);
  // A touched temp file is skipped from the snapshot.
  const ctx = await gatherCodeContext(monitor([`file:///${tmp.replace(/\\/g, '/')}`]), [], { excludeDirs: [storage] });
  assert.doesNotMatch(ctx, /snippet\.py/);
});
