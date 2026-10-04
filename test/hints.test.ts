import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import type { Annotation, AnnotationSource, HintPrefetch } from '../src/contracts';
import type { AnnotationSink, GutterKind } from '../src/annotations';
import type { HintLadder } from '../src/schemas';
import { AnnotationModel } from '../src/annotationModel';
import { Emitter } from '../src/jobs';
import {
  HINT_LINKS,
  HintDisplay,
  HintPrefetcher,
  MAX_UNUSED_PREFETCHES,
  contentHash,
  detectRung0,
  drillText,
  errorHash,
  hintAnnotationText,
  hintLadderPrompt,
  hintRoute,
  ladderRungs,
  prefetchKey,
  prefetchedRung,
  projectFileResolver,
  resolveAnchor,
  rung0Text,
  rungValid,
  splitHintLabel,
  staleReason,
  traceFrames,
  type HintHost,
  type TerminalRunInfo,
} from '../src/hints';

const SEC = 1000;
const MIN = 60 * SEC;
const T0 = 1_700_000_000_000;

const FILE_TEXT = ['import sys', '', 'def parse_args(argv):', '    out = {}', '    for i in range(len(argv)):', '        out[argv[i]] = argv[i + 1]', '    return out', ''];

function ladder(over: Partial<HintLadder> = {}): HintLadder {
  return {
    diagnosis: 'reads past the end of argv',
    stuckType: 'concept-gap',
    conceptIds: ['for-range-bounds'],
    misconceptionId: 'range-end-inclusive',
    mistakePattern: 'off-by-one',
    anchor: { file: 'cli.py', line: 6, lineText: '        out[argv[i]] = argv[i + 1]' },
    rungs: [
      { rung: 1, text: 'What is i on the last pass?' },
      { rung: 2, text: 'This is a loop bound: which index does your range stop at?' },
      { rung: 3, text: '1. Count how many flags there are\n2. Step by two\n3. Stop before the last value' },
    ],
    ...over,
  };
}

function prefetch(pf = new HintPrefetcher(), over: Partial<HintLadder> = {}, mark = 0): HintPrefetch {
  const p = pf.accept(ladder(over), { taskId: 't1', contentHash: 'c1', errorHash: errorHash([]), now: T0, mark });
  assert.ok(p);
  return p;
}

// ---------------------------------------------------------------- key and content hash

test('the prefetch key is the task only: cursor moves and minute ticks never change it or re-fire', () => {
  assert.equal(prefetchKey('t1'), 'hint:t1');
  const files = [{ key: 'file:///p/cli.py', text: FILE_TEXT.join('\n') }];
  const h1 = contentHash(files, []);
  // The prompt embeds <<CURSOR>> and the time; the content hash does not see either.
  const base = { projectBrief: 'P', taskBrief: 'T', learnerProfile: 'L', stuckReasons: ['5 min without visible progress'], speculative: true };
  const p1 = hintLadderPrompt({ ...base, codeSnapshot: '(taken at 10:01)\ndef parse_args(argv):<<CURSOR>>' });
  const p2 = hintLadderPrompt({ ...base, codeSnapshot: '(taken at 10:02)\ndef parse_args(<<CURSOR>>argv):' });
  assert.notEqual(p1, p2);
  assert.equal(contentHash(files, []), h1);

  const pf = new HintPrefetcher();
  assert.equal(pf.tryFire('t1', h1), true);
  pf.settled('t1');
  assert.equal(pf.tryFire('t1', contentHash(files, [])), false, 'identical state is not re-fired');
  assert.equal(pf.tryFire('t1', contentHash([{ ...files[0], text: files[0].text + '\nprint(1)' }], [])), true);
});

test('contentHash normalises CRLF, ignores file and error order, and sees text and error changes', () => {
  const a = { key: 'file:///p/a.py', text: 'x = 1\ny = 2\n' };
  const b = { key: 'file:///p/b.py', text: 'z = 3\n' };
  const crlf = { ...a, text: 'x = 1\r\ny = 2\r\n' };
  const errs = [{ file: 'a.py', message: 'undefined name y' }, { file: 'b.py', message: 'bad indent' }];
  assert.equal(contentHash([a, b], errs), contentHash([b, crlf], [...errs].reverse()));
  assert.notEqual(contentHash([a, b], errs), contentHash([a, b], errs.slice(1)));
  assert.notEqual(contentHash([a, b], errs), contentHash([{ ...a, text: 'x = 1\ny = 3\n' }, b], errs));
  // The error set ignores whitespace differences and duplicates.
  assert.equal(errorHash(['a.py: undefined  name y', 'a.py: undefined name y']), errorHash(['a.py: undefined name y']));
});

// ---------------------------------------------------------------- staleness

test('staleness: anchor text gone, 20+ changed lines, error set changed, task changed', () => {
  const p = prefetch();
  const lines = [...FILE_TEXT];
  const ok = { taskId: 't1', errorHash: errorHash([]), anchorLines: lines, linesChanged: 3 };
  assert.equal(staleReason(p, ok), undefined);
  // Lines inserted above the anchor: still found (nearest match), still valid.
  assert.equal(staleReason(p, { ...ok, anchorLines: ['# header', '', ...lines] }), undefined);
  assert.equal(staleReason(p, { ...ok, anchorLines: lines.map((l) => (l.includes('argv[i + 1]') ? '        out[argv[i]] = True' : l)) }), 'anchor-gone');
  assert.equal(staleReason(p, { ...ok, anchorLines: undefined }), 'anchor-gone');
  assert.equal(staleReason(p, { ...ok, linesChanged: 19 }), undefined);
  assert.equal(staleReason(p, { ...ok, linesChanged: 20 }), 'lines-changed');
  assert.equal(staleReason(p, { ...ok, errorHash: errorHash(['cli.py: IndexError']) }), 'errors-changed');
  assert.equal(staleReason(p, { ...ok, taskId: 't2' }), 'task-changed');
  assert.equal(staleReason(p, { ...ok, taskId: undefined }), 'task-changed');
});

test('check() measures changed lines from the mark taken when the prefetch landed', () => {
  const pf = new HintPrefetcher();
  const p = prefetch(pf, {}, 100);
  const base = { taskId: 't1', errorHash: errorHash([]), anchorLines: FILE_TEXT };
  assert.equal(pf.check(p, { ...base, changedLinesSince: (m) => 112 - m }), undefined);
  assert.equal(pf.check(p, { ...base, changedLinesSince: (m) => 120 - m }), 'lines-changed');
  // Without the counter the lines rule is skipped; the other rules still apply.
  assert.equal(pf.check(p, base), undefined);
});

// ---------------------------------------------------------------- gates and caps

test('gates: score >= .6, building, not off, no valid prefetch, budget left', () => {
  const pf = new HintPrefetcher();
  const g = { taskId: 't1', score: 0.6, mode: 'offer', hasValidPrefetch: false, phase: 'building' };
  assert.equal(pf.wants(g), true);
  assert.equal(pf.whyNot({ ...g, score: 0.59 }), 'score below threshold');
  assert.equal(pf.whyNot({ ...g, mode: 'off' }), 'proactive hints off');
  assert.equal(pf.whyNot({ ...g, phase: 'explain' }), 'not building');
  assert.equal(pf.whyNot({ ...g, hasValidPrefetch: true }), 'valid prefetch exists');
  assert.equal(pf.whyNot({ ...g, hintBudgetLeft: 0 }), 'hint reserve used up');
  assert.equal(pf.whyNot({ ...g, taskId: undefined }), 'no task');
  assert.equal(pf.wants({ ...g, mode: 'auto', hintBudgetLeft: 2 }), true);
});

test('one hint job in flight per task', () => {
  const pf = new HintPrefetcher();
  const g = { taskId: 't1', score: 0.8, mode: 'offer', hasValidPrefetch: false };
  assert.equal(pf.wants({ ...g, inFlight: true }), false, 'an on-demand job with the same key counts');
  assert.equal(pf.tryFire('t1', 'h1'), true);
  assert.equal(pf.inFlight('t1'), true);
  assert.equal(pf.wants(g), false);
  assert.equal(pf.tryFire('t1', 'h2'), false);
  assert.equal(pf.tryFire('t2', 'h1'), true, 'other tasks are independent');
  pf.settled('t1');
  assert.equal(pf.wants(g), true);
  assert.equal(pf.tryFire('t1', 'h2'), true);
});

test('accept() stores the state the model saw: hash, error hash and edit mark from tryFire()', () => {
  const pf = new HintPrefetcher();
  const eh = errorHash(['cli.py: undefined name x']);
  assert.equal(pf.tryFire('t1', 'hash-at-fire', { mark: 40, errorHash: eh }), true);
  const p = pf.accept(ladder(), { taskId: 't1', now: T0 + 9 * SEC });
  pf.settled('t1');
  assert.ok(p);
  assert.equal(p.contentHash, 'hash-at-fire');
  assert.equal(p.errorHash, eh);
  assert.equal(p.at, T0 + 9 * SEC);
  assert.equal(pf.markOf('t1'), 40);
  const base = { taskId: 't1', errorHash: eh, anchorLines: FILE_TEXT };
  assert.equal(pf.check(p, { ...base, changedLinesSince: (m) => 59 - m }), undefined, '19 lines since the job fired');
  assert.equal(pf.check(p, { ...base, changedLinesSince: (m) => 60 - m }), 'lines-changed');
});

test('stop after 2 unused prefetches in a task; used ones do not count', () => {
  const pf = new HintPrefetcher();
  const g = { taskId: 't1', score: 0.9, mode: 'offer', hasValidPrefetch: false };
  const used = prefetch(pf);
  pf.markUsed(used);
  pf.discard(used);
  assert.equal(pf.unusedCount('t1'), 0);
  for (let i = 0; i < MAX_UNUSED_PREFETCHES; i++) {
    assert.equal(pf.wants(g), true);
    pf.discard(prefetch(pf));
  }
  assert.equal(pf.unusedCount('t1'), 2);
  assert.equal(pf.whyNot(g), 'unused cap reached');
  assert.equal(pf.tryFire('t1', 'fresh-hash'), false);
  // A replaced, never-used prefetch also counts.
  const pf2 = new HintPrefetcher();
  prefetch(pf2);
  prefetch(pf2);
  assert.equal(pf2.unusedCount('t1'), 1);
  pf2.reset('t1');
  assert.equal(pf2.unusedCount('t1'), 0);
});

// ---------------------------------------------------------------- validation and serving

test("rungs 1 and 2 must end with '?' and contain no code fence; failing rungs are dropped", () => {
  const rungs = ladderRungs(
    ladder({
      rungs: [
        { rung: 1, text: 'Look at the loop bound.' },
        { rung: 2, text: 'Range stops early:\n```py\nrange(3)\n```\nwhat does it give?' },
        { rung: 3, text: '1. Step by two\n2. Stop before the end' },
      ],
    }),
  );
  assert.deepEqual(rungs, ['', '', '1. Step by two\n2. Stop before the end']);
  assert.equal(rungValid(1, 'What is i on the last pass?'), true);
  assert.equal(rungValid(1, 'What does "argv[i + 1]" hold when i is last?"'), true, 'closing quote after ?');
  assert.equal(rungValid(2, 'Which line? Look there.'), false);
  assert.equal(rungValid(1, 'Run pip install requests', 'environment'), true, 'environment rung 1 carries the direct fix');
  assert.equal(rungValid(3, '   '), false);
  // Labels the model adds are stripped; unnumbered rungs map by position.
  assert.deepEqual(
    ladderRungs(ladder({ rungs: [{ rung: 0, text: 'Hint 1: Which value is i at the end?' }, { rung: 0, text: 'Concept: slicing - where does it stop?' }] })),
    ['Which value is i at the end?', 'slicing - where does it stop?', ''],
  );
  // No rung survives: nothing to store.
  const pf = new HintPrefetcher();
  assert.equal(pf.accept(ladder({ rungs: [{ rung: 1, text: 'no question' }] }), { taskId: 't1', contentHash: 'c', errorHash: 'e', now: T0 }), undefined);
});

test('serving from the prefetch needs no model call; dropped rungs are served on demand', () => {
  const p = prefetch(new HintPrefetcher(), { rungs: [{ rung: 1, text: 'What is i on the last pass?' }, { rung: 2, text: 'no question mark' }, { rung: 3, text: 'Steps' }] });
  assert.equal(p.key, 'hint:t1');
  assert.equal(p.anchor.line, 6);
  assert.equal(prefetchedRung(p, 1), 'What is i on the last pass?');
  assert.equal(prefetchedRung(p, 2), undefined, 'dropped: on-demand call');
  assert.equal(prefetchedRung(p, 3), 'Steps');
  assert.equal(prefetchedRung(p, 4), undefined, 'rungs 4-5 always use HintSchema');
  assert.equal(prefetchedRung(undefined, 1), undefined);
});

// ---------------------------------------------------------------- anchors

test('anchor re-resolution: nearest line with the same text, whitespace-insensitive', () => {
  const lines = ['x = 1', 'return out', 'y = 2', 'z = 3', 'w = 4', '  return   out', 'q'];
  assert.equal(resolveAnchor(lines, { line: 6, lineText: 'return out' }), 5);
  assert.equal(resolveAnchor(lines, { line: 3, lineText: 'return out' }), 1);
  assert.equal(resolveAnchor(lines, { line: 4, lineText: 'return out' }), 1, 'ties go to the earlier line');
  assert.equal(resolveAnchor(lines, { line: 2, lineText: 'return result' }), undefined);
  assert.equal(resolveAnchor(lines, { line: 3, lineText: '' }), 2, 'no text: the line number');
  assert.equal(resolveAnchor(lines, { line: 30, lineText: '' }), undefined);
  // A model that dropped a trailing comment still finds a long line.
  assert.equal(resolveAnchor(['for i in range(len(argv)):  # each flag'], { line: 9, lineText: 'for i in range(len(argv)):' }), 0);
});

// ---------------------------------------------------------------- rung 0

const ROOT = 'C:\\proj\\';
function toProjectFile(p: string): string | undefined {
  const norm = p.replace(/\//g, '\\');
  if (!norm.toLowerCase().startsWith(ROOT.toLowerCase()) || /site-packages|node_modules/i.test(norm)) return undefined;
  return norm.slice(ROOT.length).replace(/\\/g, '/');
}

const PY_TRACE = [
  '$ python cli.py --name',
  'Traceback (most recent call last):',
  '  File "C:\\proj\\cli.py", line 12, in <module>',
  '    main()',
  '  File "C:\\proj\\cli.py", line 9, in main',
  '    args = parse_args(sys.argv[1:])',
  '  File "C:\\proj\\cli.py", line 6, in parse_args',
  '    out[argv[i]] = argv[i + 1]',
  '                   ~~~~^^^^^^^',
  'IndexError: list index out of range',
].join('\n');

function run(at: number, output: string, exitCode: number | undefined = 1, command = 'python cli.py --name'): TerminalRunInfo {
  return { at, command, exitCode, output };
}

test('rung 0 on a persistent exception: the same exception in 2 terminal runs, on the traced project line', () => {
  const once = detectRung0({ now: T0, lang: 'python', runs: [run(T0, PY_TRACE)], toProjectFile });
  assert.equal(once, undefined, 'one run is not persistent');
  const r = detectRung0({ now: T0 + MIN, lang: 'python', runs: [run(T0, PY_TRACE), run(T0 + 30 * SEC, 'ok', 0, 'ls'), run(T0 + MIN, PY_TRACE)], toProjectFile });
  assert.ok(r);
  assert.equal(r.source, 'terminal');
  assert.equal(r.exception, 'IndexError');
  assert.equal(r.file, 'cli.py');
  assert.equal(r.line, 6, 'innermost project frame');
  assert.equal(r.text, 'Which line does the trace point at, and what does IndexError mean?');
  assert.equal(r.text, rung0Text('IndexError'));
  // Fixed since: the same command later succeeded.
  assert.equal(detectRung0({ now: T0, lang: 'python', runs: [run(T0, PY_TRACE), run(T0 + 1, PY_TRACE), run(T0 + 2, 'done', 0)], toProjectFile }), undefined);
  // A different exception last: not persistent.
  const keyErr = PY_TRACE.replace('IndexError: list index out of range', "KeyError: 'x'");
  assert.equal(detectRung0({ now: T0, lang: 'python', runs: [run(T0, PY_TRACE), run(T0 + 1, keyErr)], toProjectFile }), undefined);
});

test('rung 0 skips library frames, reads Node traces (file URLs, SyntaxError header) and persistent diagnostics', () => {
  const lib = [
    'Traceback (most recent call last):',
    '  File "C:\\proj\\app.py", line 3, in <module>',
    '    requests.get(url)',
    '  File "C:\\Python314\\Lib\\site-packages\\requests\\api.py", line 73, in get',
    '    return request("get", url)',
    'requests.exceptions.MissingSchema: Invalid URL',
  ].join('\n');
  const r = detectRung0({ now: T0, lang: 'python', runs: [run(T0, lib), run(T0 + 1, lib)], toProjectFile });
  assert.equal(r?.file, 'app.py');
  assert.equal(r?.line, 3);
  assert.equal(r?.exception, 'MissingSchema');

  const node = [
    'file:///C:/proj/src/cli.mjs:14',
    '  return argv[i + 1].trim();',
    '                     ^',
    '',
    "TypeError: Cannot read properties of undefined (reading 'trim')",
    '    at parseArgs (file:///C:/proj/src/cli.mjs:14:22)',
    '    at main (file:///C:/proj/src/cli.mjs:20:3)',
    '    at node:internal/modules/run_main:123:5',
    '',
    'Node.js v24.11.1',
  ].join('\n');
  assert.deepEqual(traceFrames(node, 'javascript').slice(0, 2), [
    { path: 'C:/proj/src/cli.mjs', line: 14 },
    { path: 'C:/proj/src/cli.mjs', line: 20 },
  ]);
  const n = detectRung0({ now: T0, lang: 'javascript', runs: [run(T0, node, 1, 'node src/cli.mjs'), run(T0 + 1, node, 1, 'node src/cli.mjs')], toProjectFile });
  assert.equal(n?.exception, 'TypeError');
  assert.equal(n?.file, 'src/cli.mjs');
  assert.equal(n?.line, 14);

  const syntax = ['C:\\proj\\cli.js:3', '  foo(', '     ^', '', 'SyntaxError: missing ) after argument list', '    at wrapSafe (node:internal/modules/cjs/loader:1469:18)', '    at Module._compile (node:internal/modules/cjs/loader:1491:20)'].join('\n');
  const s = detectRung0({ now: T0, runs: [run(T0, syntax, 1, 'node cli.js'), run(T0 + 1, syntax, 1, 'node cli.js')], toProjectFile });
  assert.equal(s?.exception, 'SyntaxError');
  assert.equal(s?.file, 'cli.js');
  assert.equal(s?.line, 3);

  const diag = { file: 'cli.py', line: 4, message: '"outt" is not defined', firstSeen: T0 };
  assert.equal(detectRung0({ now: T0 + 59 * SEC, runs: [], diagnostics: [diag], toProjectFile }), undefined);
  const d = detectRung0({ now: T0 + MIN, runs: [], diagnostics: [diag], toProjectFile });
  assert.equal(d?.source, 'diagnostics');
  assert.equal(d?.line, 4);
  assert.match(d!.text, /"outt" is not defined/);
  assert.match(d!.text, /\?$/);
});

test('projectFileResolver: workspace-relative project files only (Windows and POSIX paths)', () => {
  const win = projectFileResolver([{ name: 'proj', fsPath: 'C:\\proj' }], path.win32);
  assert.equal(win('C:\\proj\\src\\cli.py'), 'src/cli.py');
  assert.equal(win('c:\\PROJ\\cli.py'), 'cli.py', 'drive and folder case do not matter on Windows');
  assert.equal(win('file:///C:/proj/src/cli.mjs'), 'src/cli.mjs');
  assert.equal(win('cli.py', 'C:\\proj\\src'), 'src/cli.py', 'relative to the terminal cwd');
  assert.equal(win('cli.py'), 'cli.py', 'relative without a cwd: the first folder');
  assert.equal(win('C:\\proj\\.venv\\Lib\\site-packages\\requests\\api.py'), undefined);
  assert.equal(win('C:\\proj\\node_modules\\lib\\index.js'), undefined);
  assert.equal(win('C:\\Python314\\Lib\\json\\decoder.py'), undefined, 'outside the workspace');
  assert.equal(win('node:internal/modules/run_main'), undefined);
  assert.equal(win('<frozen runpy>'), undefined);
  assert.equal(win(''), undefined);

  const multi = projectFileResolver(
    [
      { name: 'api', fsPath: '/home/u/api' },
      { name: 'web', fsPath: '/home/u/web' },
    ],
    path.posix,
  );
  assert.equal(multi('/home/u/web/src/app.js'), 'web/src/app.js', 'multi-root paths carry the folder name');
  assert.equal(multi('/home/u/other/x.js'), undefined);
  assert.equal(multi('internal/process/task_queues.js'), undefined);

  // End to end with detectRung0.
  const r = detectRung0({ now: T0, lang: 'python', runs: [run(T0, PY_TRACE), run(T0 + 1, PY_TRACE)], toProjectFile: win });
  assert.equal(r?.file, 'cli.py');
  assert.equal(r?.line, 6);
});

// ---------------------------------------------------------------- display

class FakeHost implements HintHost {
  readonly model = new AnnotationModel();
  readonly routes: { text: string; route: string }[] = [];
  readonly cleared: string[] = [];
  readonly revealed: number[] = [];
  readonly threads: { label: string; markdown: string; disposed: boolean }[] = [];
  readonly removed = new Emitter<Annotation[]>();
  readonly onDidRemove = this.removed.event;
  constructor(public lines: string[]) {}
  readonly sink: AnnotationSink = {
    set: (a) => {
      this.routes.push({ text: a.text, route: this.model.set(a, this.lines[a.line]) });
    },
    clear: (source: AnnotationSource, uri?: string) => {
      this.cleared.push(source);
      this.model.clear({ source, uri });
    },
    setGutter: (_u: string, _l: number, _k: GutterKind) => undefined,
    clearGutter: () => undefined,
  };
  async readLines(file: string) {
    return file === 'cli.py' ? { uri: 'file:///proj/cli.py', file, lines: this.lines } : undefined;
  }
  reveal(_uri: string, line: number) {
    this.revealed.push(line);
  }
  openThread(_uri: string, _line: number, label: string, markdown: string) {
    const t = { label, markdown, disposed: false };
    this.threads.push(t);
    return { dispose: () => void (t.disposed = true) };
  }
}

test('short rungs are after-text "Hint N: ..."; long text routes to a comment thread', async () => {
  const host = new FakeHost([...FILE_TEXT]);
  const display = new HintDisplay(host);
  const anchor = { file: 'cli.py', line: 6, lineText: '        out[argv[i]] = argv[i + 1]' };
  const short = await display.show({ rung: 1, text: 'What is i on the last pass?', anchor });
  assert.ok(short);
  assert.equal(short.route, 'after');
  assert.equal(short.line, 5);
  assert.equal(short.text, 'Hint 1: What is i on the last pass?');
  assert.deepEqual(host.revealed, [5]);
  const [view] = host.model.render('file:///proj/cli.py');
  assert.equal(view.afterText, 'Hint 1: What is i on the last pass?');
  assert.match(view.hover, /command:deliberate\.gotIt/);

  const long = await display.show({ rung: 2, text: 'This is a loop bound problem: which index does range(len(argv)) stop at, and what is i + 1 then?', anchor });
  assert.equal(long?.route, 'thread');
  assert.deepEqual(host.cleared, ['hint'], 'the previous hint is cleared first');
  const [v2] = host.model.render('file:///proj/cli.py');
  assert.equal(v2.afterText, undefined);
  assert.match(v2.thread!, /^Hint 2: This is a loop bound/);
  assert.deepEqual(splitHintLabel(v2.thread!).label, 'Hint 2');
  assert.equal(hintRoute(1, 'x'.repeat(44)), 'after');
  assert.equal(hintRoute(1, 'x'.repeat(45)), 'thread', "'Hint 1: ' plus 45 characters is over 52");
  assert.equal(hintAnnotationText(0, 'Which line?'), 'Hint: Which line?');
});

test('rung 2 with a drill: after-text names the pattern and the thread shows the rung text; anchors and clearing', async () => {
  const host = new FakeHost(['# moved', ...FILE_TEXT]);
  const display = new HintDisplay(host);
  const anchor = { file: 'cli.py', line: 6, lineText: 'out[argv[i]] = argv[i + 1]' };
  const shown = await display.show({ rung: 2, text: 'A loop bound decides the last i: which one is it here?', anchor, drill: { patternName: 'loop bounds' }, platform: 'win32' });
  assert.equal(shown?.line, 6, 're-resolved one line down');
  assert.equal(shown?.text, `Hint 2: ${drillText('loop bounds', 'Alt+N')}`);
  assert.equal(shown?.route, 'after');
  assert.equal(host.threads.length, 1);
  assert.equal(host.threads[0].label, 'Hint 2');
  assert.match(host.threads[0].markdown, /which one is it here\?/);
  assert.equal(drillText('loop bounds', 'Ctrl+Alt+N'), 'this is loop bounds. 60 s drill: Ctrl+Alt+N');

  const events: string[] = [];
  display.onDidClear((e) => events.push(e.reason));
  // The anchored line changed: the sink removed the annotation; the display lets go of it and the thread.
  host.removed.fire([{ uri: 'file:///proj/cli.py', line: 6, source: 'hint', text: shown!.text, hover: '' }]);
  assert.equal(display.current, undefined);
  assert.equal(host.threads[0].disposed, true);
  assert.deepEqual(events, ['anchor-changed']);

  await display.show({ rung: 1, text: 'What is i on the last pass?', anchor });
  display.clear('got-it');
  assert.deepEqual(events, ['anchor-changed', 'got-it']);
  assert.equal(host.model.all().length, 0);

  // Anchor text gone: no display (the hint stays a sidebar card).
  assert.equal(await display.show({ rung: 1, text: 'Why?', anchor: { file: 'cli.py', line: 2, lineText: 'nothing like this' } }), undefined);
  assert.equal(await display.show({ rung: 1, text: 'Why?', anchor: { file: 'other.py', line: 2 } }), undefined);
  assert.equal(HINT_LINKS, '[Next hint](command:deliberate.hint) · [Got it](command:deliberate.gotIt)');
});

// ---------------------------------------------------------------- prompt

test('HINTLADDER prompt: speculative wording, the pre-hint own-prediction sentence, rung rules', () => {
  const base = {
    projectBrief: 'Project: cli',
    taskBrief: 'Current task: parse flags',
    learnerProfile: '- for-range-bounds: P 0.40',
    stuckReasons: ['6 min without visible progress'],
    codeSnapshot: 'def parse_args(argv): ...',
  };
  const spec = hintLadderPrompt({ ...base, speculative: true });
  assert.match(spec, /They have not asked yet; prepare help in advance\./);
  assert.match(spec, /Stuck signals: 6 min without visible progress/);
  assert.match(spec, /rung 1 \(Nudge\).*Must end with a question mark/);
  assert.match(spec, /lineText/);
  assert.doesNotMatch(spec, /Before this they predicted/);
  assert.doesNotMatch(spec, /\n\n\n/);
  const asked = hintLadderPrompt({
    ...base,
    speculative: false,
    stuckReasons: [],
    ownProbe: { call: "parse_args(['-v'])", predicted: "{'-v': True}", actual: 'IndexError', match: false },
    previousHints: ['Hint: Which line does the trace point at?'],
  });
  assert.match(asked, /They asked for a hint\./);
  assert.match(asked, /Stuck signals: learner asked for a hint/);
  assert.match(asked, /\nBefore this they predicted parse_args\(\['-v'\]\) returns \{'-v': True\}; it actually returns IndexError\. Start from this mismatch\./);
  assert.match(asked, /Hints already given/);
  const matched = hintLadderPrompt({ ...base, speculative: true, ownProbe: { call: 'f(1)', predicted: '2', actual: '2', match: true } });
  assert.match(matched, /matches the code, so look for the problem elsewhere\./);
  // Known taxonomy ids for the task's tags (a live ladder left misconceptionId empty without them).
  assert.doesNotMatch(spec, /Taxonomy ids for this task/);
  const withIds = hintLadderPrompt({ ...base, speculative: false, misconceptions: [{ id: 'assign-one-each-time', belief: 'counts[w] = 1 adds one each time' }] });
  assert.match(withIds, /\nTaxonomy ids for this task \(misconceptionId: the one their code shows, else empty\): assign-one-each-time \(counts\[w\] = 1 adds one each time\)$/);
});
