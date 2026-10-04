import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTED_MIN,
  EditCounter,
  InsertTracker,
  IDLE_PAUSE_MS,
  MOVE_WINDOW_MS,
  PASTE_MIN,
  RecentTexts,
  SaveReasons,
  applyChange,
  changedLineCount,
  classifyInsert,
  idlePauseDue,
  insertedRange,
  langOfLanguageId,
  netNew,
  overlappingFunctions,
  nonWsCount,
  offsetAt,
  savePauseFor,
  terminalPause,
  type DocChange,
  type InsertFacts,
  type RangeChange,
  type SymbolLike,
} from '../src/monitor';

const SEC = 1000;
const MIN = 60 * SEC;
const T0 = 1_700_000_000_000;

const MANUAL = 1;
const AFTER_DELAY = 2;
const FOCUS_OUT = 3;

function ch(startLine: number, startCharacter: number, endLine: number, endCharacter: number, text: string): RangeChange {
  return { startLine, startCharacter, endLine, endCharacter, text };
}

/** A block of code with `n` non-whitespace characters. */
function code(n: number): string {
  const words: string[] = [];
  let left = n;
  while (left > 0) {
    const w = Math.min(left, 9);
    words.push('x'.repeat(w));
    left -= w;
  }
  return words.map((w, i) => (i % 4 === 3 ? `${w}\n    ` : `${w} `)).join('');
}

function facts(over: Partial<InsertFacts>): InsertFacts {
  return { n: 0, text: '', undoRedo: false, reloaded: false, move: false, ownCopy: false, coachInsert: false, clipboard: '', ...over };
}

// ---------------------------------------------------------------- net-new characters

test('net-new non-whitespace characters: inserted minus replaced', () => {
  assert.equal(nonWsCount('  def f(x):\n\treturn x\n'), 15);
  assert.equal(netNew('return total', 'return 0'), 11 - 7);
  assert.equal(netNew('    ', 'abc'), -3, 'deleting code is negative');
  assert.equal(netNew('x = 1', undefined, 0), 3, 'pure insert without a shadow is exact');
  assert.equal(netNew('abcdef', undefined, 4), 2, 'unknown replaced text counts as all non-whitespace');
});

test('shadow copies: offsets (CRLF too) and sequential application of an event', () => {
  const lf = 'ab\ncde\nf';
  assert.equal(offsetAt(lf, 1, 1), 4);
  assert.equal(offsetAt(lf, 1, 99), 6, 'clamped to the line end');
  assert.equal(offsetAt(lf, 9, 0), lf.length);
  const crlf = 'ab\r\ncde\r\nf';
  assert.equal(offsetAt(crlf, 1, 3), 7, 'the line end excludes \\r');
  assert.equal(offsetAt(crlf, 2, 0), 9);

  let r = applyChange(crlf, ch(1, 0, 1, 3, 'xyz'));
  assert.deepEqual(r, { text: 'ab\r\nxyz\r\nf', replaced: 'cde' });
  // Multi-cursor: VS Code reports the changes so that applying them in order is correct.
  let text = 'a1\na2\na3';
  for (const c of [ch(2, 2, 2, 2, '!'), ch(0, 2, 0, 2, '!')]) text = applyChange(text, c).text;
  assert.equal(text, 'a1!\na2\na3!');
  r = applyChange('one\ntwo\nthree\n', ch(0, 0, 2, 0, ''));
  assert.deepEqual(r, { text: 'three\n', replaced: 'one\ntwo\n' });
});

test('inserted range in the new document', () => {
  assert.deepEqual(insertedRange(ch(3, 4, 3, 9, 'abc')), { startLine: 3, startCharacter: 4, endLine: 3, endCharacter: 7 });
  assert.deepEqual(insertedRange(ch(3, 4, 3, 4, 'def f():\r\n    pass\r\n')), { startLine: 3, startCharacter: 4, endLine: 5, endCharacter: 0 });
  assert.deepEqual(insertedRange(ch(0, 0, 0, 0, 'a\nbc')), { startLine: 0, startCharacter: 0, endLine: 1, endCharacter: 2 });
});

// ---------------------------------------------------------------- paste and assisted

test('paste: 120+ net-new characters equal to the clipboard (re-indentation still matches)', () => {
  const block = code(PASTE_MIN);
  assert.equal(nonWsCount(block), 120);
  assert.equal(classifyInsert(facts({ n: 120, text: block, clipboard: block })), 'paste');
  const reindented = block.replace(/\n {4}/g, '\n        ');
  assert.equal(classifyInsert(facts({ n: 120, text: reindented, clipboard: block })), 'paste');
  assert.equal(classifyInsert(facts({ n: 119, text: block, clipboard: block })), undefined, 'a small paste is nothing');
  assert.equal(classifyInsert(facts({ n: 80, text: code(80), clipboard: code(80) })), undefined, 'clipboard text below 120 is never assisted');
});

test('assisted: 40+ net-new characters that are not the clipboard', () => {
  const block = code(ASSISTED_MIN);
  assert.equal(classifyInsert(facts({ n: 40, text: block, clipboard: 'something else' })), 'assisted');
  assert.equal(classifyInsert(facts({ n: 39, text: block, clipboard: 'something else' })), undefined, 'IntelliSense accepts and auto-imports stay below 40');
  assert.equal(classifyInsert(facts({ n: 200, text: code(200), clipboard: '' })), 'assisted', 'an empty clipboard is not a match');
  assert.equal(classifyInsert(facts({ n: 40, text: block, clipboard: 'x', coachInsert: true })), undefined, 'a snippet the coach inserted');
});

test('never counted: undo/redo, reloads from disk, moves, copies of own task-file text', () => {
  const block = code(150);
  const base = facts({ n: 150, text: block, clipboard: block });
  assert.equal(classifyInsert(base), 'paste');
  assert.equal(classifyInsert({ ...base, undoRedo: true }), undefined);
  assert.equal(classifyInsert({ ...base, reloaded: true }), undefined);
  assert.equal(classifyInsert({ ...base, move: true }), undefined);
  assert.equal(classifyInsert({ ...base, ownCopy: true }), undefined);
  assert.equal(classifyInsert({ ...base, clipboard: 'other', ownCopy: true }), undefined, 'copy line down is not assisted');
});

test('unreadable clipboard: only paste-sized inserts are reported, as pastes', () => {
  assert.equal(classifyInsert(facts({ n: 130, text: code(130), clipboard: undefined })), 'paste');
  assert.equal(classifyInsert(facts({ n: 60, text: code(60), clipboard: undefined })), undefined);
});

test('move detection: text deleted in the last 2 minutes, whitespace-insensitive', () => {
  const r = new RecentTexts(MOVE_WINDOW_MS);
  const fn = 'def total(xs):\n    s = 0\n    for x in xs:\n        s += x\n    return s\n';
  r.add(fn, T0);
  assert.equal(r.has(fn.replace(/\n {4}/g, '\n\t'), T0 + MIN), true);
  assert.equal(r.has(fn + 'print(1)', T0 + MIN), false);
  assert.equal(r.has(fn, T0 + MOVE_WINDOW_MS + 1), false, 'expired after 2 minutes');
  r.add('   \n', T0);
  assert.equal(r.has('', T0), false, 'blank text never matches');
});

// ---------------------------------------------------------------- edit counter

test('edit counter: typing along a line counts it once; new lines, pastes and deletions count their lines', () => {
  const ec = new EditCounter();
  const m = ec.mark();
  const U = 'file:///p/cli.py';
  for (let c = 0; c < 20; c++) ec.record(U, ch(4, c, 4, c, 'x'));
  assert.equal(ec.changedLinesSince(m), 1, '20 keystrokes on one line');
  // Enter then type on the new line: one more line.
  ec.record(U, ch(4, 20, 4, 20, '\n    '));
  for (let c = 4; c < 10; c++) ec.record(U, ch(5, c, 5, c, 'y'));
  assert.equal(ec.changedLinesSince(m), 2);
  // Writing a 10-line function line by line counts about 10.
  const m2 = ec.mark();
  for (let l = 6; l < 16; l++) {
    ec.record(U, ch(l - 1, 10, l - 1, 10, '\n    '));
    for (let c = 4; c < 8; c++) ec.record(U, ch(l, c, l, c, 'z'));
  }
  assert.equal(ec.changedLinesSince(m2), 10);
  // A 30-line paste elsewhere.
  const m3 = ec.mark();
  ec.record(U, ch(40, 0, 40, 0, 'a = 1\n'.repeat(30)));
  assert.equal(ec.changedLinesSince(m3), 30);
  // Deleting 5 whole lines at once, then one line.
  const m4 = ec.mark();
  ec.record(U, ch(50, 0, 55, 0, ''));
  assert.equal(ec.changedLinesSince(m4), 5);
  ec.record(U, ch(60, 0, 61, 0, ''));
  assert.equal(ec.changedLinesSince(m4), 6);
  // A formatter re-indenting known text changes nothing that matters.
  const m5 = ec.mark();
  ec.record(U, ch(70, 0, 72, 0, '  a = 1\n  b = 2\n'), '    a = 1\n    b = 2\n');
  assert.equal(ec.changedLinesSince(m5), 0);
  // Marks are independent snapshots.
  assert.equal(ec.changedLinesSince(m), ec.mark() - m);
  assert.equal(ec.changedLinesSince(ec.mark() + 5), 0);
});

test('changedLineCount per change', () => {
  assert.equal(changedLineCount(ch(3, 2, 3, 5, 'ab')), 1);
  assert.equal(changedLineCount(ch(3, 2, 3, 2, 'a\nb\nc')), 3);
  assert.equal(changedLineCount(ch(3, 0, 6, 0, '')), 3);
  assert.equal(changedLineCount(ch(3, 0, 5, 0, 'x\ny\nz\n')), 3);
  assert.equal(changedLineCount(ch(3, 4, 5, 2, '')), 3, 'a partial multi-line deletion touches the merged line and removes two');
});

// ---------------------------------------------------------------- pauses

test('save reasons are recorded on will-save and consumed on did-save; only a manual clean save is a pause', () => {
  const s = new SaveReasons();
  const U = 'file:///p/cli.py';
  s.will(U, MANUAL);
  const r = s.did(U);
  assert.equal(r, MANUAL);
  assert.equal(s.lastReason(U), MANUAL);
  assert.equal(s.did(U), undefined, 'consumed');
  assert.equal(s.lastReason(U), undefined, 'a save with no recorded reason clears the last one');
  assert.equal(savePauseFor(MANUAL, 0), 'manual-save');
  assert.equal(savePauseFor(MANUAL, 2), undefined, 'errors: not a clean save');
  assert.equal(savePauseFor(AFTER_DELAY, 0), undefined, 'auto-save after delay is never a pause');
  assert.equal(savePauseFor(FOCUS_OUT, 0), undefined, 'auto-save on focus out is never a pause');
  assert.equal(savePauseFor(undefined, 0), undefined);
  // Interleaved documents keep their own reasons.
  s.will('a', AFTER_DELAY);
  s.will('b', MANUAL);
  assert.equal(s.did('b'), MANUAL);
  assert.equal(s.did('a'), AFTER_DELAY);
});

test('terminal success after a failure is a pause', () => {
  const fail = { command: 'python cli.py', exitCode: 1 };
  const ok = (command: string) => ({ command, exitCode: 0 });
  assert.equal(terminalPause([fail], ok('python cli.py')), true);
  assert.equal(terminalPause([fail], ok('python cli.py --name x')), true, 'the run right after a failure, other arguments');
  assert.equal(terminalPause([fail, ok('ls')], ok('python cli.py')), true, 'the same command failed last time, a ls in between');
  assert.equal(terminalPause([], ok('python cli.py')), false);
  assert.equal(terminalPause([ok('python cli.py')], ok('python cli.py')), false);
  assert.equal(terminalPause([fail, ok('python cli.py')], ok('python cli.py')), false, 'already succeeding: no new pause');
  assert.equal(terminalPause([fail, ok('ls')], ok('git status')), false, 'nothing failed since the last success');
  assert.equal(terminalPause([fail], { command: 'python cli.py', exitCode: 2 }), false);
  assert.equal(terminalPause([{ command: 'python cli.py', exitCode: undefined }], ok('python cli.py')), false, 'unknown exit code');
});

test('20 s of clean idle is a pause, once per quiet period, only with focus and no errors', () => {
  const base = { now: T0 + IDLE_PAUSE_MS, idleSince: T0, errorCount: 0, focused: true };
  assert.equal(idlePauseDue(base), true);
  assert.equal(idlePauseDue({ ...base, now: T0 + IDLE_PAUSE_MS - 1 }), false);
  assert.equal(idlePauseDue({ ...base, errorCount: 1 }), false);
  assert.equal(idlePauseDue({ ...base, focused: false }), false);
  assert.equal(idlePauseDue({ ...base, firedFor: T0 }), false, 'already fired for this quiet period');
  assert.equal(idlePauseDue({ ...base, idleSince: T0 + 1, now: T0 + 1 + IDLE_PAUSE_MS, firedFor: T0 }), true, 'a new edit starts a new period');
});

// ---------------------------------------------------------------- enclosing functions

test('functions an insert landed in: overlapping callables at any depth, by document symbol range', () => {
  const sym = (name: string, kind: number, start: number, end: number, children: SymbolLike[] = []): SymbolLike => ({
    name,
    kind,
    range: { start: { line: start }, end: { line: end } },
    children,
  });
  const symbols = [
    sym('VERSION', 12, 0, 0),
    sym('parse_args', 11, 2, 9, [sym('flag', 11, 4, 6), sym('out', 12, 3, 3)]),
    sym('Cli', 4, 11, 30, [sym('__init__', 8, 12, 14), sym('run', 5, 16, 30)]),
    sym('main', 11, 32, 40),
  ];
  assert.deepEqual(overlappingFunctions(symbols, 7, 7), ['parse_args'], 'inside a body');
  assert.deepEqual(overlappingFunctions(symbols, 5, 5), ['parse_args', 'flag'], 'nested: both received the code');
  assert.deepEqual(overlappingFunctions(symbols, 13, 20), ['__init__', 'run'], 'methods; the class itself is not a function');
  assert.deepEqual(overlappingFunctions(symbols, 32, 40), ['main'], 'a whole new function overlaps itself');
  assert.deepEqual(overlappingFunctions(symbols, 0, 1), [], 'module level');
  assert.deepEqual(overlappingFunctions(undefined, 0, 99), []);
  assert.deepEqual(overlappingFunctions([sym('f', 11, 0, 3), sym('f', 11, 5, 8)], 0, 8), ['f'], 'no duplicates');
  assert.equal(langOfLanguageId('python'), 'python');
  assert.equal(langOfLanguageId('typescriptreact'), 'typescript');
  assert.equal(langOfLanguageId('javascriptreact'), 'javascript');
  assert.equal(langOfLanguageId('markdown'), undefined);
});

// ---------------------------------------------------------------- InsertTracker end to end

/** A document that applies changes like VS Code and reports them like the Monitor does. */
class SimDoc {
  constructor(
    public text: string,
    readonly key = 'file:///p/cli.py',
  ) {}
  change(changes: RangeChange[], over: Partial<DocChange> = {}, now = T0): DocChange {
    const withLen = changes.map((c) => {
      const r = applyChange(this.text, c);
      const out = { ...c, rangeLength: r.replaced.length };
      this.text = r.text;
      return out;
    });
    const text = this.text;
    return { key: this.key, changes: withLen, undoRedo: false, reloaded: false, now, text: () => text, ...over };
  }
}

const FN = ['def word_counts(text):', '    counts = {}', '    for word in text.split():', '        counts[word] = counts.get(word, 0) + 1', '    return counts', ''].join('\n');

test('tracker: a paste of the clipboard and an assisted insert, with their ranges', () => {
  const doc = new SimDoc(['import sys', '', ''].join('\n'));
  const tr = new InsertTracker();
  tr.setShadow(doc.key, doc.text);
  const block = FN + FN.replace('word_counts', 'line_counts');
  assert.ok(nonWsCount(block) >= PASTE_MIN);
  const cands = tr.onChange(doc.change([ch(2, 0, 2, 0, block)]));
  assert.equal(cands.length, 1);
  const pasted = tr.classify(cands, block);
  assert.deepEqual(pasted, [{ kind: 'paste', chars: nonWsCount(block), range: { startLine: 2, startCharacter: 0, endLine: 12, endCharacter: 0 } }]);
  // The same size of text not on the clipboard (an AI accept, a code action) is assisted.
  const other = FN.replace(/word/g, 'item');
  const c2 = tr.onChange(doc.change([ch(12, 0, 12, 0, other)]));
  assert.deepEqual(tr.classify(c2, 'unrelated').map((x) => x.kind), ['assisted']);
});

test('tracker: typing, undo, reloads and coach snippets are never counted', () => {
  const doc = new SimDoc('');
  const tr = new InsertTracker();
  tr.setShadow(doc.key, doc.text);
  for (const [i, c] of [...'counts = {}'].entries()) assert.deepEqual(tr.onChange(doc.change([ch(0, i, 0, i, c)])), []);
  assert.deepEqual(tr.onChange(doc.change([ch(0, 11, 0, 11, '\n' + FN)], { undoRedo: true })), []);
  assert.deepEqual(tr.onChange(doc.change([ch(0, 0, 0, 0, FN)], { reloaded: true })), []);
  const snippet = FN.replace(/word/g, 'token');
  tr.expectInsert(snippet, T0);
  assert.deepEqual(tr.classify(tr.onChange(doc.change([ch(0, 0, 0, 0, snippet)])), 'x'), []);
});

test('tracker: cut and paste (a move), drag and drop, and copy-line-down of own code are not pastes', () => {
  const doc = new SimDoc(['# top', FN + '# bottom', ''].join('\n'));
  const tr = new InsertTracker();
  tr.setShadow(doc.key, doc.text);
  // Cut the function (lines 1-5), then paste it below '# bottom'.
  assert.deepEqual(tr.onChange(doc.change([ch(1, 0, 6, 0, '')])), []);
  const moved = tr.onChange(doc.change([ch(2, 0, 2, 0, FN)], {}, T0 + 30 * SEC));
  assert.equal(moved.length, 1);
  assert.equal(moved[0].move, true);
  assert.deepEqual(tr.classify(moved, FN), [], 'a move is not a paste');
  // Drag and drop: the delete and the insert arrive in one event.
  const dnd = new SimDoc(['# a', FN + '# b', ''].join('\n'), 'file:///p/dnd.py');
  tr.setShadow(dnd.key, dnd.text);
  const c = tr.onChange(dnd.change([ch(7, 0, 7, 0, FN), ch(1, 0, 6, 0, '')]));
  assert.deepEqual(tr.classify(c, 'clipboard'), []);
  // Copy line down duplicates text already in the file.
  const dup = new SimDoc(FN, 'file:///p/dup.py');
  tr.setShadow(dup.key, dup.text);
  const d = tr.onChange(dup.change([ch(5, 0, 5, 0, FN)]));
  assert.equal(d[0]?.ownCopy, true);
  assert.deepEqual(tr.classify(d, 'clipboard'), []);
});

test('tracker: replacing a selection counts only the net-new characters; without a shadow n is conservative', () => {
  const doc = new SimDoc(FN);
  const tr = new InsertTracker();
  tr.setShadow(doc.key, doc.text);
  const body = '        counts[word] = counts.get(word, 0) + 1';
  const longer = '        counts[word.lower().strip(".,!?")] = counts.get(word.lower().strip(".,!?"), 0) + 1';
  const n = nonWsCount(longer) - nonWsCount(body);
  assert.ok(n >= ASSISTED_MIN, 'the replacement adds enough to be a candidate');
  const c = tr.onChange(doc.change([ch(3, 0, 3, body.length, longer)]));
  assert.equal(c[0].n, n);
  assert.equal(c[0].ownCopy, false);
  // A document seen for the first time: replaced text unknown, every replaced character counts as code.
  const fresh = new SimDoc('x'.repeat(30), 'file:///p/new.py');
  const tr2 = new InsertTracker();
  const c2 = tr2.onChange(fresh.change([ch(0, 0, 0, 30, 'y'.repeat(75))]));
  assert.equal(c2[0].n, 75 - 30);
  assert.equal(tr2.hasShadow(fresh.key), true, 'the first change starts a shadow');
  assert.ok(tr.edits.mark() >= 1, 'the edit counter sees every change');
});

