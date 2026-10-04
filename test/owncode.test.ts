// Own-code probes (src/owncode.ts): probe-input selection, PredictFlow and WhatIfFlow with a fake
// runner (it plays probe.py), fake sinks and scripted InputBox answers.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectNode, detectPython, LocalRunner, PATH_PYTHON_CANDIDATES, type DetectedRuntime } from '../src/runner';
import type {
  Action, Annotation, AnnotationSource, BatchRecord, LearnerRunOptions, OwnProbe, RunResult, Runner, Runtime, SpecItem, Val,
} from '../src/contracts';
import type { AnnotationSink, GutterCommand, GutterKind } from '../src/annotations';
import type { ActionSink } from '../src/tempoBar';
import { parseCall, sameArgs, validateCall } from '../src/calls';
import {
  MODEL_PROBE_INTERVAL_MS, ModelProbeTrigger, PREDICT_ACTION_ID, PREDICT_COMMAND, PREDICT_PROMPT, PredictFlow, WhatIfFlow, conflictFlag,
  describeProbe, exercisedLines, fallbackProbes, feedbackText, gradePrediction, modelProbes, ownCodeProbePrompt, paramsOf, preHintLine,
  probesForFile, regionAfterEdits, selectProbes, specDerivedProbes, specsGreenFast, whatIfCount,
  whatIfEvidence, whatIfSnippet, whatIfTitle, wrongPredictions, type Answer, type OwnCodeDeps, type PredictResult, type Question,
  type QuestionPort, type StrikePort,
} from '../src/owncode';
import { functionsFromText } from '../src/specs';

// ------------------------------------------------------------------ fakes

class FakeAnnotations implements AnnotationSink {
  items: Annotation[] = [];
  gutters: { uri: string; line: number; kind: GutterKind; hover?: string; command?: GutterCommand }[] = [];
  set(a: Annotation): void {
    this.items = this.items.filter((x) => !(x.uri === a.uri && x.line === a.line && x.source === a.source));
    this.items.push(a);
  }
  clear(source: AnnotationSource, uri?: string): void {
    this.items = this.items.filter((x) => !(x.source === source && (uri === undefined || x.uri === uri)));
  }
  setGutter(uri: string, line: number, kind: GutterKind, hover?: string, command?: GutterCommand): void {
    this.gutters.push({ uri, line, kind, hover, command });
  }
  clearGutter(uri?: string, kind?: GutterKind): void {
    this.gutters = this.gutters.filter((g) => !((uri === undefined || g.uri === uri) && (kind === undefined || g.kind === kind)));
  }
}

class FakeActions implements ActionSink {
  queue = new Map<string, Omit<Action, 'id' | 'createdAt'> & { id: string }>();
  enqueue(a: Omit<Action, 'id' | 'createdAt'> & { id?: string }): string {
    const id = a.id ?? `a${this.queue.size + 1}`;
    this.queue.set(id, { ...a, id });
    return id;
  }
  remove(idOrKind: string): void {
    for (const [id, a] of this.queue) if (id === idOrKind || a.kind === idOrKind) this.queue.delete(id);
  }
  flash(): void {}
}

class ScriptedAsk implements QuestionPort {
  asked: Question[] = [];
  constructor(private readonly answers: Answer[]) {}
  async ask(q: Question): Promise<Answer> {
    this.asked.push(q);
    return this.answers.shift() ?? { kind: 'esc' };
  }
}

class FakeStrike implements StrikePort {
  shown: [string, number, number, number][] = [];
  active = false;
  show(uri: string, line: number, start: number, end: number): void {
    this.shown.push([uri, line, start, end]);
    this.active = true;
  }
  clear(): void {
    this.active = false;
  }
}

type Rec = Record<string, unknown>;

/** Plays probe.py: evaluate(source, call) gives the record it would print. */
class ProbeRunner implements Runner {
  calls: { script: string; args: string[]; opts: LearnerRunOptions }[] = [];
  constructor(private readonly evaluate: (source: string, call: string) => Rec, readonly runtime: Runtime = PY) {}
  async runBatch(): Promise<BatchRecord[]> {
    throw new Error('not used');
  }
  async runLearnerCode(script: string, args: string[], opts: LearnerRunOptions): Promise<RunResult> {
    this.calls.push({ script, args, opts });
    const rec = this.evaluate(opts.stdin ?? '', args[1]);
    return { stdout: `what the call printed\n@@DLB ${JSON.stringify(rec)}\n`, stderr: '', exitCode: 0, timedOut: false, ms: 5 };
  }
}

const PY: Runtime = { lang: 'python', exe: 'python', snippetArgv: [], learnerArgv: [], version: '3.12.1' };
const WS = path.resolve('/tmp/dlb-own');
const HARNESS = path.resolve('/ext/media/harness');
const uriOf = (p: string) => `file:///${p.replace(/\\/g, '/').replace(/^\//, '')}`;

const pyStr = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const strList = (xs: string[]): Rec => ({
  ok: true, type: 'list', repr: `[${xs.map(pyStr).join(', ')}]`, val: { t: 'list', v: xs.map((x) => ({ t: 'str', v: x })) } satisfies Val,
});
const int = (n: number): Rec => ({ ok: true, type: 'int', repr: String(n), val: { t: 'int', v: String(n) } satisfies Val });

function spec(id: string, call: string, expected: string): SpecItem {
  return { id, title: id, conceptId: 'string-split-join', call, expected, expectError: '', parSec: 30, failureSignatures: [] };
}

function deps(runner: Runner, files: Map<string, string>, ask: QuestionPort, extra: Partial<OwnCodeDeps> = {}) {
  const annotations = new FakeAnnotations();
  const actions = new FakeActions();
  let t = 1_700_000_000_000;
  const d: OwnCodeDeps = {
    runner: () => runner, allowRun: () => true, harnessDir: HARNESS, workspaceDir: () => WS, uriOf,
    readText: async (p) => files.get(p), annotations, actions, ask, clock: { now: () => (t += 10), setTimeout: () => 0, clearTimeout: () => undefined },
    ...extra,
  };
  return { d, annotations, actions };
}

// ------------------------------------------------------------------ probe inputs

describe('probe inputs', () => {
  const visible = [spec('s1', "parse_row('a,b')", "['a', 'b']"), spec('s2', "parse_row('a,b,c', ',')", "['a', 'b', 'c']"), spec('s3', "parse_row('', ',')", '[]')];
  const hidden = [spec('h1', "parse_row('x,y')", "['x', 'y']")];

  test('spec-derived inputs never equal a visible (or hidden) spec input', () => {
    const got = specDerivedProbes('parse_row', 'parse_row', 'python', visible, hidden);
    assert.ok(got.length >= 2, JSON.stringify(got));
    for (const c of got) {
      const args = parseCall(c.callExpr, 'python').args;
      for (const s of [...visible, ...hidden]) assert.equal(sameArgs(args, parseCall(s.call, 'python').args), false, `${c.callExpr} repeats ${s.call}`);
      assert.equal(c.source, 'spec-mutation');
    }
    // "parse_row('', ',')" is s3's input: the empty-string mutation of s2 is dropped.
    assert.ok(!got.some((c) => c.callExpr === "parse_row('', ',')"));
    assert.ok(got.some((c) => c.callExpr === "parse_row('')"), 'the empty-input mutation of s1 is kept');
  });

  test('spec-derived inputs are renamed to the learner function', () => {
    const got = specDerivedProbes('split_row', 'parse_row', 'python', visible);
    assert.ok(got.length && got.every((c) => c.callExpr.startsWith('split_row(')));
  });

  test('model probes go through validateCall: code, variables and other functions are rejected', () => {
    const got = modelProbes('parse_row', 'python', [
      { functionName: 'parse_row', callExpr: "parse_row('a,,b')", conceptId: 'string-split-join', misconceptionIfWrong: 'split-drops-empty' },
      { functionName: 'parse_row', callExpr: "parse_row(open('x').read())", conceptId: 'c' },
      { functionName: 'parse_row', callExpr: "__import__('os').system('x')", conceptId: 'c' },
      { functionName: 'parse_row', callExpr: 'parse_row(line)', conceptId: 'c' },
      { functionName: 'other', callExpr: "other('a')", conceptId: 'c' },
    ], 'fallback-concept');
    assert.deepEqual(got.map((c) => c.callExpr), ["parse_row('a,,b')"]);
    assert.equal(got[0].misconceptionIfWrong, 'split-drops-empty');
    assert.equal(validateCall('parse_row(1); import os', 'python', ['parse_row']).ok, false);
  });

  test('fallback inputs come from parameter names and annotations; defaults and *args are left out', () => {
    const src = "def top(xs, n, *rest, sep=','):\n    return xs[:n]\n\ndef greet(name: str, times: int = 1) -> str:\n    return name\n";
    const fns = functionsFromText(src, 'python');
    const top = fallbackProbes('top', paramsOf(src, fns[0], 'python'), 'python', 'c');
    assert.deepEqual(top.map((c) => c.callExpr), ['top([], 0)', 'top([], -1)']);
    assert.ok(top.every((c) => c.source === 'fallback'));
    assert.deepEqual(fallbackProbes('greet', paramsOf(src, fns[1], 'python'), 'python', 'c').map((c) => c.callExpr), ["greet('')"]);
    const js = 'export function score(words, opts = {}) {\n  return 0;\n}\nconst f = (count) => count;\n';
    const jf = functionsFromText(js, 'javascript');
    assert.deepEqual(fallbackProbes('score', paramsOf(js, jf[0], 'javascript'), 'javascript', 'c').map((c) => c.callExpr), ['score([])']);
    assert.deepEqual(fallbackProbes('f', paramsOf(js, jf[1], 'javascript'), 'javascript', 'c').map((c) => c.callExpr), ['f(0)', 'f(-1)']);
    assert.deepEqual(fallbackProbes('m', [{ name: 'self', hasDefault: false, kind: 'self' }], 'python', 'c'), [], 'methods are never probed');
  });

  test('selectProbes keeps the preference order and skips calls already asked', () => {
    const src = "def parse_row(line, sep=','):\n    return line.split(sep)\n";
    const fn = functionsFromText(src, 'python')[0];
    const all = selectProbes({
      fnName: 'parse_row', lang: 'python', visible: visible.slice(0, 1), conceptId: 'c', params: paramsOf(src, fn, 'python'),
      model: [{ functionName: 'parse_row', callExpr: "parse_row('a,,b')", conceptId: 'm' }],
    });
    assert.deepEqual(all.map((c) => c.source), ['spec-mutation', 'model', 'fallback'].filter((s, i, a) => a.indexOf(s) === i).flatMap((s) => all.filter((c) => c.source === s).map(() => s)));
    assert.equal(all[0].source, 'spec-mutation');
    const again = selectProbes({ fnName: 'parse_row', lang: 'python', visible: visible.slice(0, 1), conceptId: 'c', exclude: new Set([all[0].callExpr]) });
    assert.ok(!again.some((c) => c.callExpr === all[0].callExpr));
  });
});

// ------------------------------------------------------------------ PredictFlow

const ROW_FILE = path.join(WS, 'rows.py');
const ROW_SRC = "import csv\n\ndef parse_row(line, sep=','):\n    return line.split(sep)\n\n\ndef helper():\n    return 1\n";

/** parse_row(...) as the fixture's source would compute it ('split' or 'split-drop-empty'). */
function rowEval(source: string, call: string): Rec {
  if (source.includes('input()')) return { ok: false, loadError: { kind: 'top-level', message: 'top-level code runs on import' } };
  const m = /^parse_row\('((?:[^'\\]|\\.)*)'\)$/.exec(call);
  if (!m) return { ok: false, exception: 'TypeError', error: 'TypeError: bad call in fake' };
  const parts = m[1].split(',');
  return strList(source.includes('if p]') ? parts.filter(Boolean) : parts);
}

function predictCtx(over: Partial<Parameters<PredictFlow['run']>[0]> = {}) {
  return { taskId: 't1', lang: 'python' as const, file: ROW_FILE, conceptId: 'string-split-join', ...over };
}

describe('PredictFlow', () => {
  test('a fake runner gives a match: ok feedback on the def line and correct own-predict evidence', async () => {
    const files = new Map([[ROW_FILE, ROW_SRC]]);
    const runner = new ProbeRunner(rowEval);
    const ask = new ScriptedAsk([{ kind: 'answer', text: "['']", ms: 9000 }]);
    const { d, annotations } = deps(runner, files, ask);
    const results: PredictResult[] = [];
    const flow = new PredictFlow(d, (r) => results.push(r));
    const r = await flow.run(predictCtx({ visible: [spec('s1', "parse_row('a,b')", "['a', 'b']")], speed: { cps: 4, speedFactor: 1 } }));
    assert.equal(r.status, 'answered');
    if (r.status !== 'answered') return;
    assert.equal(ask.asked[0].title, "parse_row('') -> ?");
    assert.equal(ask.asked[0].prompt, PREDICT_PROMPT);
    assert.equal(r.verdict, 'correct');
    assert.equal(r.evidence?.kind, 'own-predict');
    assert.equal(r.evidence?.source, 'own-code');
    assert.equal(r.evidence?.correct, true);
    assert.equal(r.evidence?.conceptId, 'string-split-join');
    assert.ok(r.evidence?.parSelfMs && r.evidence?.parAbsMs);
    assert.equal(r.evidence?.weight, 1);
    assert.deepEqual(annotations.items.map((a) => [a.line, a.source, a.text]), [[2, 'own-predict', 'ok 9s']]);
    assert.equal(r.probe.source, 'spec-mutation');
    assert.deepEqual(r.probe.result, { predicted: "['']", actual: "['']", correct: true, ms: 9000 });
    assert.equal(results.length, 1);
    // The probe ran on the editor text via stdin, with the documented argv.
    const c = runner.calls[0];
    assert.equal(c.script, path.join(HARNESS, 'probe.py'));
    assert.deepEqual(c.args, [ROW_FILE, "parse_row('')", '--stdin', '--workspace', WS, '--timeout-ms', '3000']);
    assert.equal(c.opts.stdin, ROW_SRC);
    assert.equal(c.opts.timeoutMs, 3500);
  });

  test('a mismatch: actual vs you said, wrong evidence with the misconception at x3, an atom-offer flag', async () => {
    const files = new Map([[ROW_FILE, ROW_SRC]]);
    const ask = new ScriptedAsk([{ kind: 'answer', text: "['a', 'b']", ms: 12000 }]);
    const { d, annotations } = deps(new ProbeRunner(rowEval), files, ask);
    const r = await new PredictFlow(d).run(predictCtx({
      modelProbes: [{ functionName: 'parse_row', callExpr: "parse_row('a,,b')", conceptId: 'string-split-join', misconceptionIfWrong: 'split-drops-empty' }],
    }));
    assert.equal(r.status, 'answered');
    if (r.status !== 'answered') return;
    assert.equal(r.verdict, 'wrong');
    assert.equal(r.mismatch, true);
    assert.equal(r.evidence?.correct, false);
    assert.equal(r.evidence?.misconceptionId, 'split-drops-empty');
    assert.equal(r.evidence?.misconceptionOdds, 3);
    assert.equal(annotations.items[0].text, "actual ['a', '', 'b'] · you said ['a', 'b']");
    assert.match(r.hintLine, /they predicted parse_row\('a,,b'\) returns \['a', 'b'\]; it actually returns \['a', '', 'b'\]\. Start from this mismatch\./);
  });

  test('Later and Esc are neutral: nothing recorded, nothing annotated', async () => {
    for (const kind of ['later', 'esc'] as const) {
      const files = new Map([[ROW_FILE, ROW_SRC]]);
      const runner = new ProbeRunner(rowEval);
      const { d, annotations } = deps(runner, files, new ScriptedAsk([{ kind }]));
      const r = await new PredictFlow(d).run(predictCtx());
      assert.equal(r.status, kind);
      assert.equal('evidence' in r, false);
      assert.equal(annotations.items.length, 0);
      assert.equal(runner.calls.length, 1, 'only the pre-run that picked the probe');
    }
  });

  test('it runs against the CURRENT text at accept, not the text it was offered on', async () => {
    const files = new Map([[ROW_FILE, ROW_SRC]]);
    const runner = new ProbeRunner(rowEval);
    const ask = new ScriptedAsk([{ kind: 'answer', text: "['a', 'b']", ms: 5000 }]);
    const { d, annotations, actions } = deps(runner, files, ask);
    const flow = new PredictFlow(d);
    const ctx = predictCtx({ modelProbes: [{ functionName: 'parse_row', callExpr: "parse_row('a,,b')", conceptId: 'string-split-join' }] });
    const offer = await flow.offer(ctx);
    assert.ok(offer);
    assert.deepEqual(annotations.gutters.map((g) => [g.line, g.kind, g.command?.command]), [[2, 'offer', PREDICT_COMMAND]]);
    assert.equal(actions.queue.get(PREDICT_ACTION_ID)?.label, '$(question) predict parse_row (15s)');
    const edited = ROW_SRC.replace('return line.split(sep)', 'return [p for p in line.split(sep) if p]');
    files.set(ROW_FILE, edited);
    const r = await flow.run(ctx);
    assert.equal(r.status, 'answered');
    if (r.status !== 'answered') return;
    assert.equal(runner.calls.at(-1)!.opts.stdin, edited);
    assert.equal(r.verdict, 'correct', 'graded against the edited function');
    assert.equal(annotations.gutters.length, 0, 'the offer is consumed');
    assert.equal(actions.queue.has(PREDICT_ACTION_ID), false);
  });

  test('feedback clears on the next edit inside that function only', async () => {
    const files = new Map([[ROW_FILE, ROW_SRC]]);
    const { d, annotations } = deps(new ProbeRunner(rowEval), files, new ScriptedAsk([{ kind: 'answer', text: '?', ms: 3000 }]));
    const flow = new PredictFlow(d);
    const r = await flow.run(predictCtx());
    assert.equal(r.status, 'answered');
    assert.equal(annotations.items[0].text, "actual ['']", 'no idea: the actual value only');
    flow.onEdit(uriOf(ROW_FILE), [{ startLine: 6, endLine: 7 }]);
    assert.equal(annotations.items.length, 1, 'an edit in another function keeps it');
    flow.onEdit(uriOf(ROW_FILE), [{ startLine: 3, endLine: 3 }]);
    assert.equal(annotations.items.length, 0);
  });

  test('lines added above the function move the tracked feedback region', async () => {
    const files = new Map([[ROW_FILE, ROW_SRC]]);
    const { d, annotations } = deps(new ProbeRunner(rowEval), files, new ScriptedAsk([{ kind: 'answer', text: "['']", ms: 3000 }]));
    const flow = new PredictFlow(d);
    assert.equal((await flow.run(predictCtx())).status, 'answered');
    flow.onEdit(uriOf(ROW_FILE), [{ startLine: 0, endLine: 0, text: 'import os\nimport re\n' }]); // def moves from line 2 to 4
    assert.equal(annotations.items.length, 1);
    flow.onEdit(uriOf(ROW_FILE), [{ startLine: 3, endLine: 3, text: 'x' }]);
    assert.equal(annotations.items.length, 1, 'line 3 is now above the function');
    flow.onEdit(uriOf(ROW_FILE), [{ startLine: 5, endLine: 5, text: 'x' }]);
    assert.equal(annotations.items.length, 0, 'line 5 is the moved body');
  });

  test('fallback inputs are recorded at weight .5; an unsafe module is skipped without asking', async () => {
    const files = new Map([[ROW_FILE, ROW_SRC]]);
    const { d } = deps(new ProbeRunner(rowEval), files, new ScriptedAsk([{ kind: 'answer', text: "['']", ms: 4000 }]));
    const r = await new PredictFlow(d).run(predictCtx({ fnName: 'parse_row' }));
    assert.ok(r.status === 'answered' && r.probe.source === 'fallback' && r.evidence?.weight === 0.5);

    files.set(ROW_FILE, ROW_SRC + 'name = input()\n');
    const ask = new ScriptedAsk([{ kind: 'answer', text: 'x', ms: 1 }]);
    const { d: d2 } = deps(new ProbeRunner(rowEval), files, ask);
    const u = await new PredictFlow(d2).run(predictCtx());
    assert.equal(u.status, 'unavailable');
    assert.equal(ask.asked.length, 0);
  });

  test('without consent nothing runs', async () => {
    const runner = new ProbeRunner(rowEval);
    const { d } = deps(runner, new Map([[ROW_FILE, ROW_SRC]]), new ScriptedAsk([]), { allowRun: () => false });
    const r = await new PredictFlow(d).run(predictCtx());
    assert.equal(r.status, 'unavailable');
    assert.equal(runner.calls.length, 0);
  });

  test('a lock held by another flow: busy, nothing asked', async () => {
    const ask = new ScriptedAsk([{ kind: 'answer', text: "['']", ms: 1 }]);
    const { d } = deps(new ProbeRunner(rowEval), new Map([[ROW_FILE, ROW_SRC]]), ask, { lock: { acquire: () => undefined } });
    const r = await new PredictFlow(d).run(predictCtx());
    assert.deepEqual(r, { status: 'unavailable', reason: 'busy' });
    assert.equal(ask.asked.length, 0);
  });
});

// ------------------------------------------------------------------ WhatIfFlow

const TOTAL_FILE = path.join(WS, 'total.py');
const TOTAL_SRC = [
  'def total(n):',
  '    """Sum 1..n-1: and that is all."""',
  '    s = 0',
  '    for i in range(1, n):',
  '        s += i',
  '    return s',
  '',
].join('\n');

/** total(n) as the (mutated) source computes it. */
function totalEval(source: string, call: string): Rec {
  if (source.includes('BROKEN')) return { ok: false, loadError: { kind: 'import', message: 'SyntaxError: invalid syntax' } };
  const n = Number(/^total\((-?\d+)\)$/.exec(call)?.[1]);
  const m = /range\((\d+), n(?: ([+-]) 1)?\)/.exec(source);
  if (!m || Number.isNaN(n)) return { ok: false, exception: 'NameError', error: 'NameError' };
  const hi = n + (m[2] === '+' ? 1 : m[2] === '-' ? -1 : 0);
  let s = 0;
  for (let i = Number(m[1]); i < hi; i++) s = /s \+= i/.test(source) ? s + i : i;
  if (!/return s/.test(source)) return { ok: true, type: 'NoneType', repr: 'None', val: { t: 'none' } };
  return int(s);
}

function whatIfRig(answers: Answer[], evaluate = totalEval) {
  const files = new Map([[TOTAL_FILE, TOTAL_SRC]]);
  const runner = new ProbeRunner(evaluate);
  const ask = new ScriptedAsk(answers);
  const strike = new FakeStrike();
  const { d, annotations } = deps(runner, files, ask);
  const flow = new WhatIfFlow({ ...d, strike });
  const ctx = {
    taskId: 't1', lang: 'python' as const, file: TOTAL_FILE, conceptId: 'loop-accumulator', callExpr: 'total(5)', count: 2, weakestTag: 'for-range-bounds',
    conceptForTag: (tag: string) => (tag === 'for-range-bounds' ? 'for-range-bounds' : undefined),
  };
  return { files, runner, ask, strike, annotations, flow, ctx };
}

describe('WhatIfFlow', () => {
  test('prepare keeps mutants that change the result, with the alternative operator run locally', async () => {
    const { flow, ctx } = whatIfRig([]);
    const list = await flow.prepare(ctx);
    assert.equal(list.length, 2);
    const [a, b] = list;
    assert.equal(a.cand.op, 'bound-plus-1', 'the weakest concept tag comes first');
    assert.equal(a.cand.line, 3);
    assert.equal(a.cand.mutated, '    for i in range(1, n + 1):');
    assert.equal(a.unmutated.display, '10');
    assert.equal(a.actual.display, '15');
    assert.equal(a.alternative?.display, '6', 'range(1, n - 1)');
    assert.notEqual(b.cand.line, 3);
    assert.ok(!list.some((w) => w.cand.line === 1), 'the docstring line never carries a what-if');
  });

  test('attribution: the unmutated answer names the misconception (x3); the right answer is own evidence; others weigh .5', async () => {
    const { flow, ctx } = whatIfRig([]);
    const [w] = await flow.prepare(ctx);
    const o = { conceptId: 'for-range-bounds', taskId: 't1', at: 1, ms: 20000 };
    const stale = whatIfEvidence('10', w, 'python', o);
    assert.equal(stale.attributable, true);
    assert.equal(stale.evidence?.misconceptionId, 'range-includes-end');
    assert.equal(stale.evidence?.misconceptionOdds, 3);
    assert.equal(stale.evidence?.weight, 1);
    assert.equal(stale.evidence?.kind, 'what-if');
    const alt = whatIfEvidence('6', w, 'python', o);
    assert.equal(alt.attributable, true, "the alternative operator's output also attributes");
    const right = whatIfEvidence('15', w, 'python', o);
    assert.deepEqual([right.correct, right.evidence?.weight, right.evidence?.misconceptionId], [true, 1, undefined]);
    const other = whatIfEvidence('12', w, 'python', o);
    assert.deepEqual([other.correct, other.attributable, other.evidence?.weight, other.evidence?.misconceptionId], [false, false, 0.5, undefined]);
    assert.equal(whatIfEvidence('', w, 'python', o).evidence, undefined, 'no answer: nothing recorded');
  });

  test('run: line-through + after-text, the InputBox title, graded records; the file is never edited', async () => {
    const { flow, ctx, ask, strike, annotations, files } = whatIfRig([{ kind: 'answer', text: '10', ms: 15000 }, { kind: 'answer', text: '4', ms: 9000 }]);
    const r = await flow.run(ctx);
    assert.equal(r.status, 'done');
    assert.equal(ask.asked[0].title, whatIfTitle('total(5)'));
    assert.equal(ask.asked[0].title, 'With this change, total(5) -> ?');
    const [uri, line, start, end] = strike.shown[0];
    assert.equal(uri, uriOf(TOTAL_FILE));
    assert.equal(line, 3);
    assert.equal(TOTAL_SRC.split('\n')[3].slice(start, end), 'n');
    assert.equal(strike.active, false, 'cleared at the end');
    assert.equal(r.whatIfs.length, 2);
    assert.deepEqual([r.whatIfs[0].attributable, r.whatIfs[0].correct, r.whatIfs[0].unmutated, r.whatIfs[0].actual], [true, false, '10', '15']);
    assert.equal(r.evidence[0].conceptId, 'for-range-bounds');
    assert.equal(r.evidence[0].misconceptionId, 'range-includes-end');
    assert.equal(r.evidence[1].conceptId, 'loop-accumulator', 'no concept for the tag: the fallback concept');
    assert.equal(files.get(TOTAL_FILE), TOTAL_SRC);
    const fb = annotations.items.filter((a) => a.source === 'what-if');
    assert.ok(fb.length >= 1 && fb.every((a) => !a.text.startsWith('what if:')), 'feedback replaced the question text');
  });

  test('Later stops the sequence and is neutral', async () => {
    const { flow, ctx, strike, annotations } = whatIfRig([{ kind: 'later' }]);
    const r = await flow.run(ctx);
    assert.equal(r.status, 'later');
    assert.deepEqual([r.evidence.length, r.whatIfs.length], [0, 0]);
    assert.equal(strike.active, false);
    assert.equal(annotations.items.length, 0);
  });

  test('mutants that do not load or change nothing are dropped; all-Fluent skips', async () => {
    const evaluate = (source: string, call: string) => (/range\(1, n \+ 1\)/.test(source) ? { ok: false, loadError: { kind: 'import', message: 'SyntaxError' } } : totalEval(source, call));
    const { flow, ctx } = whatIfRig([], evaluate);
    const list = await flow.prepare({ ...ctx, count: 3 });
    assert.ok(!list.some((w) => w.cand.op === 'bound-plus-1'), 'a mutant that fails to load is dropped');
    assert.ok(list.length >= 1);
    const skipped = await flow.run({ ...ctx, allFluent: true });
    assert.equal(skipped.status, 'skipped');
  });

  test('the shown what-if text is the changed code in context', async () => {
    const { flow, ctx, annotations } = whatIfRig([{ kind: 'esc' }]);
    const seen: string[] = [];
    const set = annotations.set.bind(annotations);
    annotations.set = (a) => {
      seen.push(a.text);
      set(a);
    };
    await flow.run(ctx);
    assert.equal(seen[0], 'what if: for i in range(1, n + 1)');
  });
});

// ------------------------------------------------------------------ pure helpers

describe('pure helpers', () => {
  test('exercisedLines follows calls to helpers and skips multi-line strings', () => {
    const src = 'def helper(x):\n    return x + 1\n\ndef main(xs):\n    """Doc\n    and more\n    """\n    return [helper(x) for x in xs]\n\ndef unused():\n    return 1 < 2\n';
    const lines = exercisedLines(src, functionsFromText(src, 'python'), 'main', 'python').map((l) => l.line);
    assert.deepEqual(lines, [1, 4, 7]);
  });

  test('feedback text, snippet and the pre-hint line', () => {
    assert.equal(feedbackText({ verdict: 'correct' }, '3', '3', 9400), 'ok 9s');
    assert.equal(feedbackText({ verdict: 'wrong' }, "['a', '', 'b']", "['a', 'b']", 1), "actual ['a', '', 'b'] · you said ['a', 'b']");
    assert.equal(feedbackText({ verdict: 'format-only', note: "right idea; Python writes it as 'x'" }, "'x'", 'x', 1), "right idea; Python writes it as 'x'");
    const long = '        result = compute_the_total_of(prices[start:end], discount_rate) + shipping_cost(order)';
    const s = whatIfSnippet(long, { start: long.indexOf('discount_rate'), replacement: 'discount_rate' });
    assert.ok([...s].length <= 43 && s.includes('discount_rate'), s);
    assert.equal(preHintLine({ callExpr: 'f(1)', predicted: '2', actual: '2', correct: true }), 'Before this hint they predicted f(1) returns 2; it actually returns 2. Their mental model of this function matches the code, so look for the problem elsewhere.');
  });

  test('describeProbe: a sandbox exception is not a question; a raise is', () => {
    assert.equal(describeProbe({ ok: false, timedOut: false, exception: 'DeliberateSandbox', error: 'x' }, 'python').usable, false);
    const k = describeProbe({ ok: false, timedOut: false, exception: 'KeyError', error: "KeyError: 'x'" }, 'python');
    assert.deepEqual([k.usable, k.display], [true, 'KeyError']);
    assert.equal(gradePrediction('KeyError', k, 'python').verdict, 'correct');
    assert.equal(describeProbe({ ok: false, timedOut: true }, 'python').usable, false);
  });

  test('conflict flag: specs green fast but 2+ wrong own predictions', () => {
    const probe = (predicted: string, correct: boolean): OwnProbe => ({ fnName: 'f', fnHash: 'h', callExpr: 'f()', source: 'fallback', conceptId: 'c', misconceptionIfWrong: '', result: { predicted, actual: '1', correct, ms: 1 } });
    const spec1 = { specs: [spec('s1', 'f()', '1'), spec('s2', 'f()', '1')], greenAt: { s1: 1, s2: 2 }, savesSinceRed: { s1: 1, s2: 2 } };
    assert.equal(specsGreenFast(spec1), true);
    assert.equal(specsGreenFast({ ...spec1, savesSinceRed: { s1: 1, s2: 5 } }), false);
    assert.equal(specsGreenFast(spec1, { activeMs: 61_000 }), false, 'over the 60 s total par');
    assert.equal(wrongPredictions([probe('2', false), probe('', false), probe('?', false), probe('1', true)]), 1);
    assert.equal(conflictFlag({ specsFast: true, ownProbes: [probe('2', false), probe('3', false)] }), true);
    assert.equal(conflictFlag({ specsFast: false, ownProbes: [probe('2', false), probe('3', false)] }), false);
    assert.deepEqual([whatIfCount(true), whatIfCount(false)], [3, 2]);
  });

  test('regionAfterEdits: a touching change clears; changes above shift; changes below do nothing', () => {
    const r = { startLine: 4, endLine: 6 };
    assert.equal(regionAfterEdits(r, [{ startLine: 6, endLine: 6, text: 'x' }]), undefined);
    assert.equal(regionAfterEdits(r, [{ startLine: 1, endLine: 4, text: '' }]), undefined, 'a deletion reaching into it');
    assert.deepEqual(regionAfterEdits(r, [{ startLine: 0, endLine: 0, text: 'import os\nimport re\n' }]), { startLine: 6, endLine: 8 });
    assert.deepEqual(regionAfterEdits(r, [{ startLine: 1, endLine: 3, text: '' }]), { startLine: 2, endLine: 4 }, 'two lines deleted above');
    assert.equal(regionAfterEdits(r, [{ startLine: 9, endLine: 9, text: 'a\nb\n' }]), r);
    assert.equal(regionAfterEdits(r, [{ startLine: 1, endLine: 1 }]), r, 'no text: no shift known');
  });

  test('ModelProbeTrigger: building, no ladder, a changed function set, at most once per 2 min', () => {
    const t = new ModelProbeTrigger();
    const f = path.join(WS, 'app.py');
    const on = { building: true, hasLadder: false };
    assert.equal(t.onSave(f, ['parse'], 0, { building: false, hasLadder: false }), false, 'not building');
    assert.equal(t.onSave(f, ['parse'], 0, { building: true, hasLadder: true }), false, 'the ladder gives spec-derived inputs');
    assert.equal(t.onSave(f, [], 0, on), false, 'no functions yet');
    assert.equal(t.onSave(f, ['parse'], 0, on), true, 'the first save with functions');
    assert.equal(t.onSave(f, ['parse'], 10_000, on), false, 'same set');
    assert.equal(t.onSave(f, ['parse', 'total'], 60_000, on), false, 'changed, but within 2 min');
    assert.equal(t.onSave(f, ['total', 'parse', 'parse'], MODEL_PROBE_INTERVAL_MS, on), true, 'the held-back change fires after the interval');
    assert.equal(t.onSave(f, ['parse', 'total'], 400_000, on), false, 'order and duplicates do not matter');
    t.reset();
    assert.equal(t.onSave(f, ['parse', 'total'], 400_000, on), true, 'a new task');
  });

  test('model probes are kept for their own file only; the OWNCODEPROBE prompt', () => {
    const file = path.join(WS, 'src', 'rows.py');
    const probes = [
      { functionName: 'a', callExpr: 'a()', conceptId: 'c' },
      { file: 'src/rows.py', functionName: 'b', callExpr: 'b()', conceptId: 'c' },
      { file: 'other.py', functionName: 'c', callExpr: 'c()', conceptId: 'c' },
    ];
    assert.deepEqual(probesForFile(probes, file, WS).map((p) => p.functionName), ['a', 'b']);
    const prompt = ownCodeProbePrompt({ taskBrief: 'Parse rows', conceptIds: ['string-split-join', 'list-indexing'], path: 'src/rows.py', code: 'def b(): ...' });
    assert.match(prompt, /^Here is a file the learner just saved/);
    assert.match(prompt, /callExpr is a single expression calling one of their functions with LITERAL arguments only/);
    assert.match(prompt, /\nConcept ids: string-split-join, list-indexing\nFile src\/rows\.py: def b\(\): \.\.\.$/);
  });
});

// ------------------------------------------------------------------ the real probe scripts (skipped without a runtime)

describe('own-code flows with LocalRunner and the real probe scripts', () => {
  const ROOT = path.resolve(__dirname, '..');
  let work = '';
  const rts: { python?: DetectedRuntime; javascript?: DetectedRuntime } = {};
  before(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'dlb-owncode-'));
    const pinned = process.env.DELIBERATE_PYTHON;
    const o = { cwd: work };
    [rts.python, rts.javascript] = await Promise.all([
      detectPython(pinned ? [{ bin: pinned, source: 'DELIBERATE_PYTHON' }, ...PATH_PYTHON_CANDIDATES] : PATH_PYTHON_CANDIDATES, o),
      detectNode(o),
    ]);
  });
  after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 }));

  const sources = {
    python: {
      rows: "def parse_row(line, sep=','):\n    return line.split(sep)\n\n\nif __name__ == '__main__':\n    print(parse_row(input()))\n",
      rowsFile: 'rows.py', fn: 'parse_row',
      total: 'def total(n):\n    s = 0\n    for i in range(1, n):\n        s += i\n    return s\n', totalFile: 'total.py',
    },
    javascript: {
      rows: "export function parseRow(line, sep = ',') {\n  return line.split(sep);\n}\n",
      rowsFile: 'rows.mjs', fn: 'parseRow',
      total: 'export function total(n) {\n  let s = 0;\n  for (let i = 1; i < n; i++) {\n    s += i;\n  }\n  return s;\n}\n', totalFile: 'total.mjs',
    },
  } as const;

  for (const lang of ['python', 'javascript'] as const) {
    test(`${lang}: predict a model probe on the editor text, then a what-if with attribution`, { timeout: 60_000 }, async (t) => {
      const rt = rts[lang];
      if (!rt) return t.skip(`no ${lang} runtime`);
      const s = sources[lang];
      const ws = fs.mkdtempSync(path.join(work, `ws-${lang}-`));
      const rows = path.join(ws, s.rowsFile);
      const total = path.join(ws, s.totalFile);
      // The saved file is stale: the probe must run the editor text (stdin), not the disk copy.
      fs.writeFileSync(rows, s.rows.replace('line.split(sep)', '[]'));
      fs.writeFileSync(total, s.total);
      const editor = new Map<string, string>([[rows, s.rows], [total, s.total]]);
      const runner = new LocalRunner(rt, { runnerDir: path.join(ROOT, 'media', 'runner'), runRoot: path.join(work, 'run') });
      const ask = new ScriptedAsk([{ kind: 'answer', text: "['a', '', 'b']", ms: 8000 }, { kind: 'answer', text: '10', ms: 20000 }]);
      const annotations = new FakeAnnotations();
      const base: OwnCodeDeps = {
        runner: () => runner, allowRun: () => true, harnessDir: path.join(ROOT, 'media', 'harness'), workspaceDir: () => ws, uriOf,
        readText: async (p) => editor.get(p), annotations, actions: new FakeActions(), ask,
      };
      const pr = await new PredictFlow(base).run({
        taskId: 't', lang, file: rows, conceptId: 'string-split-join',
        modelProbes: [{ functionName: s.fn, callExpr: `${s.fn}('a,,b')`, conceptId: 'string-split-join', misconceptionIfWrong: 'split-drops-empty' }],
      });
      assert.equal(pr.status, 'answered', JSON.stringify(pr));
      if (pr.status === 'answered') {
        assert.equal(pr.verdict, 'correct', `${pr.actual}`);
        assert.equal(annotations.items[0].text, 'ok 8s');
      }

      const strike = new FakeStrike();
      const wf = new WhatIfFlow({ ...base, strike });
      const r = await wf.run({ taskId: 't', lang, file: total, conceptId: 'loop-accumulator', callExpr: 'total(5)', count: 1, weakestTag: 'for-range-bounds' });
      assert.equal(r.status, 'done', r.reason);
      assert.equal(r.whatIfs.length, 1);
      const w = r.whatIfs[0];
      assert.equal(w.tag, 'for-range-bounds');
      assert.equal(w.unmutated, '10');
      assert.notEqual(w.actual, '10');
      assert.equal(w.attributable, true, 'answering the unmutated result names the misconception');
      assert.equal(r.evidence[0].misconceptionId, 'range-includes-end');
      assert.equal(fs.readFileSync(total, 'utf8'), s.total, 'the file is never edited');
    });
  }
});
