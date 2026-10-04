import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Annotation, AnnotationSource } from '../src/contracts';
import { AFTER_TEXT_MAX, AnnotationModel, LineChange, routeText, toAfterText } from '../src/annotationModel';

const URI = 'file:///proj/cli.py';

function ann(source: AnnotationSource, text: string, over: Partial<Annotation> = {}): Annotation {
  return { uri: URI, line: 13, source, text, hover: '', ...over };
}

/** A tiny document to drive onDidChange like VS Code does. */
class Doc {
  constructor(public lines: string[]) {}
  apply(c: LineChange): void {
    const before = this.lines.slice(0, c.startLine);
    const after = this.lines.slice(c.endLine + 1);
    const head = this.lines[c.startLine].slice(0, c.startCharacter);
    const tail = this.lines[c.endLine].slice(c.endCharacter);
    this.lines = [...before, ...(head + c.text + tail).split('\n'), ...after];
  }
  edit(model: AnnotationModel, ...changes: LineChange[]): Annotation[] {
    for (const c of changes) this.apply(c);
    return model.onDidChange(URI, changes, (l) => this.lines[l]);
  }
}

function change(startLine: number, startCharacter: number, endLine: number, endCharacter: number, text: string): LineChange {
  return { startLine, startCharacter, endLine, endCharacter, text };
}

test('one after-text per line, chosen by priority hint > spec > own-predict > what-if', () => {
  const m = new AnnotationModel();
  assert.equal(m.set(ann('what-if', 'what if: range(len(xs) - 1)'), 'x'), 'after');
  assert.equal(m.set(ann('own-predict', 'ok 9s'), 'x'), 'after');
  assert.equal(m.routeOf(URI, 13, 'what-if'), 'folded');
  assert.equal(m.set(ann('spec', 'What does split return for ""?'), 'x'), 'after');
  assert.equal(m.set(ann('hint', 'Hint 1: what is in row[1]?'), 'x'), 'after');
  let [view] = m.render(URI);
  assert.equal(view.owner, 'hint');
  assert.equal(view.afterText, 'Hint 1: what is in row[1]?');
  assert.deepEqual(view.sources, ['hint', 'spec', 'own-predict', 'what-if']);
  // A lower source arriving later never takes the line.
  assert.equal(m.set(ann('spec', 'Which call fails first?'), 'x'), 'folded');

  m.clear({ source: 'hint' });
  [view] = m.render(URI);
  assert.equal(view.owner, 'spec');
  assert.equal(view.afterText, 'Which call fails first?', 'setting a source again replaces its text on that line');
  assert.deepEqual(view.sources, ['spec', 'own-predict', 'what-if']);
  // Other lines are independent.
  m.set(ann('what-if', 'what if: x <= 0', { line: 20 }), 'y');
  assert.deepEqual(m.render(URI).map((v) => [v.line, v.owner]), [[13, 'spec'], [20, 'what-if']]);
});

test('lower-priority texts fold into the hover, in priority order, after the owner hover', () => {
  const m = new AnnotationModel();
  m.set(ann('what-if', 'what if: x < 0', { hover: '[Predict](command:deliberate.whatIf)' }), 'x');
  m.set(ann('own-predict', 'actual [1] · you said [1, 2]'), 'x');
  m.set(ann('hint', 'Hint 1: which index is last?', { hover: '[Next hint](command:deliberate.hint)' }), 'x');
  const [view] = m.render(URI);
  const sections = view.hover.split('\n\n---\n\n');
  assert.equal(sections[0], '[Next hint](command:deliberate.hint)', 'owner hover first, raw markdown');
  assert.match(sections[1], /^\*\*Your prediction:\*\* actual \\\[1\\\] · you said \\\[1, 2\\\]$/, 'folded text is escaped');
  assert.match(sections[2], /^\*\*What if:\*\* what if: x \\< 0\n\n\[Predict\]\(command:deliberate\.whatIf\)$/);
  assert.equal(sections.length, 3);
});

test('the 52-character cap routes long hint text to a comment thread, never a truncated line', () => {
  const m = new AnnotationModel();
  const fits = 'x'.repeat(AFTER_TEXT_MAX);
  const long = 'What value does count have after the loop ends, and why?';
  assert.ok(long.length > AFTER_TEXT_MAX);
  assert.equal(routeText('hint', fits), 'after');
  assert.equal(routeText('hint', long), 'thread');
  assert.equal(routeText('hint', 'line one?\nline two?'), 'thread', 'multi-line text cannot be after-text');

  assert.equal(m.set(ann('hint', long), 'x'), 'thread');
  m.set(ann('spec', 'Spec 2 fails'), 'x');
  const [view] = m.render(URI);
  assert.equal(view.owner, 'hint');
  assert.equal(view.afterText, undefined, 'no competing after-text on a line with a thread');
  assert.equal(view.thread, long);
  assert.match(view.hover, /Spec:\*\* Spec 2 fails/);
});

test('long text from other sources is clipped to 52 with the full text kept in the hover', () => {
  const m = new AnnotationModel();
  const text = "actual ['a', '', 'b'] · you said ['a', 'b'] · run 2 of 3 inputs";
  assert.equal(routeText('own-predict', text), 'after');
  m.set(ann('own-predict', text), 'x');
  const [view] = m.render(URI);
  assert.equal(view.thread, undefined);
  assert.ok([...view.afterText!].length <= AFTER_TEXT_MAX);
  assert.ok(view.afterText!.endsWith('…'));
  assert.ok(view.hover.includes("you said \\['a', 'b'\\] · run 2 of 3 inputs"));
  assert.equal(toAfterText('ok 9s'), 'ok 9s');
  assert.equal(toAfterText('a\n  b'), 'a b');
});

test('an annotation clears when its anchored line text changes', () => {
  const doc = new Doc(['def total(xs):', '    s = 0', '    for x in xs:', '        s += x', '    return s']);
  const m = new AnnotationModel();
  m.set(ann('hint', 'Hint 1: what is s after one pass?', { line: 3 }), doc.lines[3]);
  m.set(ann('spec', 'total([]) -> 0', { line: 0 }), doc.lines[0]);
  // Typing on another line leaves both alone.
  assert.deepEqual(doc.edit(m, change(4, 12, 4, 12, ' + 0')), []);
  // Editing the anchored line clears its annotation only.
  const removed = doc.edit(m, change(3, 10, 3, 12, '='));
  assert.deepEqual(removed.map((a) => a.source), ['hint']);
  assert.deepEqual(m.render(URI).map((v) => v.owner), ['spec']);
});

test('anchors follow lines inserted or deleted above them', () => {
  const doc = new Doc(['import sys', '', 'def main():', '    args = sys.argv', '    print(args[1])']);
  const m = new AnnotationModel();
  m.set(ann('hint', 'Hint 1: what is argv[0]?', { line: 4 }), doc.lines[4]);
  // Two lines inserted at the top.
  assert.deepEqual(doc.edit(m, change(0, 0, 0, 0, 'import os\nimport re\n')), []);
  assert.equal(m.render(URI)[0].line, 6);
  // A new line typed at the very start of the anchored line pushes it down without changing it.
  assert.deepEqual(doc.edit(m, change(6, 0, 6, 0, '    n = 1\n')), []);
  assert.equal(m.render(URI)[0].line, 7);
  assert.equal(doc.lines[7], '    print(args[1])');
  // Deleting a line above moves it back up.
  assert.deepEqual(doc.edit(m, change(1, 0, 2, 0, '')), []);
  assert.equal(m.render(URI)[0].line, 6);
  // Several changes in one event are applied in order, as VS Code does.
  assert.deepEqual(doc.edit(m, change(5, 0, 5, 0, '# a\n'), change(0, 0, 0, 0, '# b\n')), []);
  assert.equal(m.render(URI)[0].line, 8);
  assert.equal(doc.lines[8], '    print(args[1])');
  // Joining the anchored line onto the previous one changes its text: cleared.
  const removed = doc.edit(m, change(7, doc.lines[7].length, 8, 0, ''));
  assert.equal(removed.length, 1);
  assert.equal(m.render(URI).length, 0);
});

test('typing at the start of the anchored line clears it; trailing whitespace does not', () => {
  const doc = new Doc(['x = 1', 'print(x)']);
  const m = new AnnotationModel();
  m.set(ann('own-predict', 'ok 9s', { line: 1 }), doc.lines[1]);
  assert.deepEqual(doc.edit(m, change(1, 8, 1, 8, '  ')), [], 'trailing spaces are not a change');
  assert.equal(doc.edit(m, change(1, 0, 1, 0, 'y')).length, 1);
});

test('deleting the anchored line clears it', () => {
  const doc = new Doc(['a', 'b', 'c']);
  const m = new AnnotationModel();
  m.set(ann('what-if', 'what if: b', { line: 2 }), doc.lines[2]);
  const removed = doc.edit(m, change(1, 1, 2, 1, ''));
  assert.equal(removed.length, 1);
});

test('clear filters by source, uri and line and returns what it removed', () => {
  const m = new AnnotationModel();
  m.set(ann('hint', 'h'), 'x');
  m.set(ann('spec', 's', { line: 2 }), 'y');
  m.set(ann('spec', 's2', { uri: 'file:///proj/b.py' }), 'z');
  assert.deepEqual(m.clear({ source: 'spec', uri: URI }).map((a) => a.text), ['s']);
  assert.deepEqual(m.uris().sort(), ['file:///proj/b.py', URI]);
  assert.deepEqual(m.clear({ line: 13, uri: URI }).map((a) => a.text), ['h']);
  assert.equal(m.render(URI).length, 0);
  assert.equal(m.clear().length, 1);
  assert.equal(m.all().length, 0);
});
