import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LineChange } from '../src/annotationModel';
import { DEFAULT_TRUSTED_COMMANDS, commandLink, gutterView, planThreads, shiftLine, threadContent } from '../src/annotations';
import { HINT_LINKS } from '../src/hints';

function change(startLine: number, startCharacter: number, endLine: number, endCharacter: number, text: string): LineChange {
  return { startLine, startCharacter, endLine, endCharacter, text };
}

test('command links encode their arguments', () => {
  assert.equal(commandLink('Next hint', 'deliberate.hint'), '[Next hint](command:deliberate.hint)');
  assert.equal(
    commandLink('Start', 'deliberate.predictOwn', ['cli.py', 'parse_args']),
    `[Start](command:deliberate.predictOwn?${encodeURIComponent('["cli.py","parse_args"]')})`,
  );
  for (const c of ['deliberate.hint', 'deliberate.gotIt', 'deliberate.teach', 'deliberate.predictOwn']) assert.ok(DEFAULT_TRUSTED_COMMANDS.includes(c));
});

test('gutter: one icon per line (offer > fail > pass) with every hover and link merged', () => {
  const views = gutterView([
    { line: 4, kind: 'pass', hover: 'spec 1 passes' },
    { line: 4, kind: 'offer', hover: "Predict parse_args(['-v'])", command: { command: 'deliberate.predictOwn', args: ['cli.py'] } },
    { line: 9, kind: 'fail', hover: 'spec 2: not yet' },
  ]);
  assert.deepEqual(views.map((v) => [v.line, v.kind]), [[4, 'offer'], [9, 'fail']]);
  assert.match(views[0].hover, /^Predict parse_args\(\['-v'\]\) · \[Start\]\(command:deliberate\.predictOwn\?/);
  assert.match(views[0].hover, /---\n\nspec 1 passes$/);
  assert.deepEqual(views[0].commands, ['deliberate.predictOwn']);
  assert.equal(views[1].hover, 'spec 2: not yet');
});

test('gutter anchors follow inserted and deleted lines, and vanish with their line', () => {
  assert.equal(shiftLine(10, change(2, 0, 2, 0, 'a\nb\n')), 12, 'two lines inserted above');
  assert.equal(shiftLine(10, change(2, 0, 5, 0, '')), 7, 'three lines deleted above');
  assert.equal(shiftLine(10, change(10, 4, 10, 6, 'xy')), 10, 'the line itself edited');
  assert.equal(shiftLine(10, change(10, 0, 10, 0, 'z\n')), 11, 'a line inserted at its start pushes it down');
  assert.equal(shiftLine(10, change(12, 0, 12, 0, 'z\n')), 10, 'edits below do not move it');
  assert.equal(shiftLine(10, change(8, 3, 11, 0, '')), undefined, 'deleted');
  assert.equal(shiftLine(10, change(9, 5, 10, 2, '')), undefined, 'merged into the line above');
  assert.equal(shiftLine(10, change(9, 0, 10, 0, '')), 9, 'the line above removed: it moves up');
});

test('long hint threads: label from the text, Next hint / Got it links in the body', () => {
  const t = threadContent('Hint 2: This is the loop bound.\nWhich index does range stop at?');
  assert.equal(t.label, 'Hint 2');
  assert.equal(t.markdown, `This is the loop bound.\nWhich index does range stop at?\n\n${HINT_LINKS}`);
  assert.equal(threadContent('Hint: Which line does the trace point at, and what does KeyError mean?').label, 'Hint');
  assert.equal(threadContent('no label at all').label, 'Hint');
});

test('threads are kept, moved with their hint, created and disposed by text', () => {
  const plan = planThreads(
    [
      { id: 1, line: 5, text: 'Hint 2: a' },
      { id: 2, line: 9, text: 'Hint 3: b' },
      { id: 3, line: 20, text: 'Hint 1: gone' },
    ],
    [
      { line: 5, text: 'Hint 2: a' },
      { line: 11, text: 'Hint 3: b' },
      { line: 30, text: 'Hint 4: new' },
    ],
  );
  assert.deepEqual(plan.keep, [1]);
  assert.deepEqual(plan.move, [{ id: 2, line: 11 }]);
  assert.deepEqual(plan.create, [{ line: 30, text: 'Hint 4: new' }]);
  assert.deepEqual(plan.dispose, [3]);
  assert.deepEqual(planThreads([], []), { keep: [], move: [], create: [], dispose: [] });
});
