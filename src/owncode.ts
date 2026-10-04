// Own-code probes (spec V1-12): A. predict your own function, B. what-if mutants on your own lines.
// Both replace the free-text explain-back. Nothing here ever edits a project file: probes and
// mutants run the editor's CURRENT text (or an in-memory mutated copy) through
// media/harness/probe.{py,mjs} via stdin, in the learner-code sandbox (docs/stage1-notes.md PROBES).
//
// Pure parts (probe-input selection, grading, attribution, feedback text, the conflict flag) are
// exported and tested under node:test. The vscode pieces (VscodeQuestionPort, VscodeStrike) are thin
// and touch `vscode` only inside methods.

import * as path from 'path';
import * as vscode from 'vscode';
import type { Lang, OwnProbe, RecordedOutput, Runner, SpecItem, TaskSpecState, Val, VerdictKind, WhatIf } from './contracts';
import type { AnnotationSink } from './annotations';
import type { ActionSink } from './tempoBar';
import { mutateLiteral, parseCall, renameCallee, sameArgs, validateCall, type CallArg } from './calls';
import { actualText, answerSpaceG, compareOutput, valEquals } from './compare';
import { parAbs, parSelf } from './evidence';
import type { EvidenceInput } from './learner';
import { systemClock, type Clock } from './jobs';
import { alternativeLine, attributeWhatIf, maskLine, operator, whatIfCandidates, type WhatIfCandidate, type WhatIfLine } from './mutants';
import { parseProbeOutput, TIMEOUT_TEXT, type ProbeOutcome } from './specsCore';
import { calleeOf, functionHash, functionsFromText, type FunctionLoc } from './specs';
import { mdEscape, status } from './tempo';
import { hash53 } from './atoms/rng';

// =====================================================================================
// Constants
// =====================================================================================

/** probe.{py,mjs} stops itself at this; the process timeout is 500 ms later (stage1-notes PROBES). */
export const PROBE_TIMEOUT_MS = 3000;
export const PREDICT_PROMPT = 'Type the return value, or the error name. Enter submits';
export const EMPTY_MEANS = 'Empty means no idea';
/** Probe candidates tried before giving up on a function (each one is a process). */
const MAX_PROBE_TRIES = 4;
/** Probe processes one prepare() may start across all functions (a file of sandbox-blocked functions stays cheap). */
const MAX_PREPARE_RUNS = 8;
/** OwnCodeProbeSchema jobs: at most one per this interval (spec V1-12 PROBE INPUTS (2)). */
export const MODEL_PROBE_INTERVAL_MS = 120_000;
/** A result longer than this is not a fair thing to ask someone to type. */
export const MAX_ANSWER_CHARS = 80;
/** Thinking seconds for an own-code prediction (par). */
const PREDICT_PAR_SEC = 8;
/** Tempo-bar action id of the predict offer. */
export const PREDICT_ACTION_ID = 'own:predict';
export const PREDICT_COMMAND = 'deliberate.predictOwn';
/** Exceptions that are the sandbox talking, not the learner's code: never a question. */
const NOT_AN_ANSWER = new Set(['DeliberateSandbox', 'DeliberateTopLevel', 'KeyboardInterrupt', 'SystemExit']);

// =====================================================================================
// Running one probe
// =====================================================================================

export interface ProbeRun {
  outcome: ProbeOutcome;
  /** RecordedOutput for compareOutput (returnValue mode): the value, or the exception. */
  recorded?: RecordedOutput;
  /** One-line actual result for feedback: the value as the learner would type it, or the exception name. */
  display: string;
  /** A result the learner can be asked to predict (returned or raised in their code). */
  usable: boolean;
}

/** A probe outcome as a gradable result. */
export function describeProbe(outcome: ProbeOutcome, lang: Lang): ProbeRun {
  if (outcome.ok) {
    const type = outcome.type ?? 'object';
    const repr = outcome.repr ?? '';
    const val: Val = outcome.val ?? { t: 'opaque', type, repr };
    const recorded: RecordedOutput = { stdout: repr, values: [[{ type, repr, val }]] };
    return { outcome, recorded, display: actualText(recorded, lang, true), usable: true };
  }
  if (outcome.timedOut) return { outcome, display: 'does not finish (infinite loop?)', usable: false };
  if (outcome.loadError) return { outcome, display: outcome.loadError.message, usable: false };
  if (outcome.exception && !/^BadCall/.test(outcome.error ?? '')) {
    const recorded: RecordedOutput = { stdout: '', values: [], exception: outcome.exception };
    return { outcome, recorded, display: outcome.exception, usable: !NOT_AN_ANSWER.has(outcome.exception) };
  }
  return { outcome, display: outcome.error ?? 'the probe did not run', usable: false };
}

export interface ProbeRunOptions {
  harnessDir: string;
  workspaceDir: string;
  /** The module's path (sys.path, __file__, relative imports); its source comes from `source`. */
  file: string;
  call: string;
  /** The editor's current text, or a what-if mutant. */
  source: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** One call against `source` through probe.py / probe.mjs (stdin), parsed and described. */
export async function runProbe(runner: Runner, o: ProbeRunOptions): Promise<ProbeRun> {
  const lang = runner.runtime.lang;
  const t = o.timeoutMs ?? PROBE_TIMEOUT_MS;
  const script = path.join(o.harnessDir, lang === 'python' ? 'probe.py' : 'probe.mjs');
  const r = await runner.runLearnerCode(
    script,
    [o.file, o.call, '--stdin', '--workspace', o.workspaceDir, '--timeout-ms', String(t)],
    { workspaceDir: o.workspaceDir, timeoutMs: t + 500, stdin: o.source, signal: o.signal },
  );
  return describeProbe(parseProbeOutput(r.stdout, r.stderr, r.timedOut), lang);
}

/** Same result: the same exception, or strictly equal values (repr text when a value is opaque). */
export function sameResult(a: ProbeRun, b: ProbeRun): boolean {
  if (!a.recorded || !b.recorded) return false;
  if (a.recorded.exception || b.recorded.exception) return a.recorded.exception === b.recorded.exception;
  const va = a.recorded.values[0]?.[0];
  const vb = b.recorded.values[0]?.[0];
  if (va && vb && va.val.t !== 'opaque' && vb.val.t !== 'opaque') return valEquals(va.val, vb.val, { strict: true });
  return a.recorded.stdout === b.recorded.stdout;
}

// =====================================================================================
// Probe inputs (spec V1-12 PROBE INPUTS, in order of preference)
// =====================================================================================

export interface ProbeCandidate {
  /** The learner's function name. */
  fnName: string;
  callExpr: string;
  source: OwnProbe['source'];
  conceptId: string;
  misconceptionIfWrong: string;
  edgeCase?: string;
}

/** An OwnCodeProbeSchema item (model probes, only when the task has no spec ladder). */
export interface ModelProbe {
  file?: string;
  functionName: string;
  callExpr: string;
  conceptId: string;
  edgeCase?: string;
  misconceptionIfWrong?: string;
}

export interface ParamInfo {
  name: string;
  annotation?: string;
  hasDefault: boolean;
  kind: 'plain' | 'star' | 'kwstar' | 'rest' | 'self' | 'pattern-object' | 'pattern-array' | 'marker';
}

function parsedArgs(call: string, lang: Lang): CallArg[] | undefined {
  const r = parseCall(call, lang);
  return r.ok ? r.args : undefined;
}

/**
 * (1) Spec calls with one literal changed (calls.ts mutateLiteral, most telling first), renamed to
 * the learner's function. A mutation whose arguments equal any visible OR hidden spec's is dropped:
 * visible expected values are on screen, and hidden calls exist to catch hard-coding.
 */
export function specDerivedProbes(
  fnName: string, ifaceName: string, lang: Lang, visible: readonly SpecItem[], hidden: readonly SpecItem[] = [],
): ProbeCandidate[] {
  const all = [...visible, ...hidden];
  const taken = all.map((s) => parsedArgs(s.call, lang)).filter((a): a is CallArg[] => !!a);
  const out: ProbeCandidate[] = [];
  const seen = new Set<string>();
  for (const s of all) {
    if (calleeOf(s.call) !== ifaceName) continue;
    for (const m of mutateLiteral(s.call, lang)) {
      const args = parsedArgs(m, lang);
      if (!args || taken.some((t) => sameArgs(args, t))) continue;
      let call: string;
      try {
        call = fnName === ifaceName ? m : renameCallee(m, fnName);
      } catch {
        continue;
      }
      if (seen.has(call)) continue;
      seen.add(call);
      out.push({ fnName, callExpr: call, source: 'spec-mutation', conceptId: s.conceptId, misconceptionIfWrong: '' });
    }
  }
  return out;
}

/** (2) Model probes for this function, each through validateCall (literal arguments only). */
export function modelProbes(fnName: string, lang: Lang, probes: readonly ModelProbe[], fallbackConcept: string): ProbeCandidate[] {
  const out: ProbeCandidate[] = [];
  for (const p of probes) {
    const check = validateCall(String(p.callExpr ?? ''), lang, [fnName]);
    if (!check.ok || !check.call) continue;
    if (p.functionName && p.functionName !== fnName) continue;
    out.push({
      fnName, callExpr: check.call, source: 'model', conceptId: p.conceptId?.trim() || fallbackConcept,
      misconceptionIfWrong: (p.misconceptionIfWrong ?? '').trim(), ...(p.edgeCase ? { edgeCase: p.edgeCase } : {}),
    });
  }
  return out;
}

/** Split at top-level commas (brackets and TS generics nest; strings are skipped). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\') {
        cur += s[++i] ?? '';
        continue;
      }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{<'.includes(c)) depth++;
    else if (')]}'.includes(c) || (c === '>' && s[i - 1] !== '=' && s[i - 1] !== '-')) depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Index of the top-level `ch` in s (outside brackets and strings), or -1. */
function topLevelIndex(s: string, test: (s: string, i: number) => boolean): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{<'.includes(c)) depth++;
    else if (')]}'.includes(c) || (c === '>' && s[i - 1] !== '=')) depth = Math.max(0, depth - 1);
    else if (depth === 0 && test(s, i)) return i;
  }
  return -1;
}

/** The parameter list text of a function at `loc` (between its parentheses), or a bare arrow parameter. */
function paramText(text: string, loc: FunctionLoc): string | undefined {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').slice(loc.defLine, loc.endLine + 1).join('\n');
  const at = lines.search(new RegExp(`\\b${loc.name.replace(/[$]/g, '\\$')}\\b`));
  if (at < 0) return undefined;
  const rest = lines.slice(at + loc.name.length);
  const arrow = /^\s*(?::[^=]*)?=\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(rest);
  const open = rest.indexOf('(');
  if (arrow && (open < 0 || rest.indexOf('=>') < open)) return arrow[1];
  if (open < 0) return undefined;
  let depth = 0;
  let quote = '';
  for (let i = open; i < rest.length; i++) {
    const c = rest[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return rest.slice(open + 1, i);
  }
  return undefined;
}

/** Parameters of a top-level function, from its header text. */
export function paramsOf(text: string, loc: FunctionLoc, lang: Lang): ParamInfo[] | undefined {
  const raw = paramText(text, loc);
  if (raw === undefined) return undefined;
  const py = lang === 'python';
  return splitTopLevel(raw.replace(/#[^\n]*|\/\/[^\n]*/g, '')).map((p, i): ParamInfo => {
    if (py) {
      if (p === '*' || p === '/') return { name: p, hasDefault: true, kind: 'marker' };
      if (p.startsWith('**')) return { name: p.slice(2).split(':')[0].trim(), hasDefault: true, kind: 'kwstar' };
      if (p.startsWith('*')) return { name: p.slice(1).split(':')[0].trim(), hasDefault: true, kind: 'star' };
    } else {
      if (p.startsWith('...')) return { name: p.slice(3).split(':')[0].trim(), hasDefault: true, kind: 'rest' };
      if (/^this\s*:/.test(p)) return { name: 'this', hasDefault: true, kind: 'marker' };
    }
    const eq = topLevelIndex(p, (s, k) => s[k] === '=' && s[k + 1] !== '=' && s[k + 1] !== '>' && s[k - 1] !== '=' && s[k - 1] !== '!' && s[k - 1] !== '<' && s[k - 1] !== '>');
    const head = (eq >= 0 ? p.slice(0, eq) : p).trim();
    const colon = topLevelIndex(head, (s, k) => s[k] === ':');
    let name = (colon >= 0 ? head.slice(0, colon) : head).trim();
    const annotation = colon >= 0 ? head.slice(colon + 1).trim() : undefined;
    let hasDefault = eq >= 0;
    if (name.endsWith('?')) {
      name = name.slice(0, -1);
      hasDefault = true;
    }
    if (py && i === 0 && (name === 'self' || name === 'cls')) return { name, hasDefault, kind: 'self' };
    if (name.startsWith('{')) return { name, annotation, hasDefault, kind: 'pattern-object' };
    if (name.startsWith('[')) return { name, annotation, hasDefault, kind: 'pattern-array' };
    return { name, ...(annotation ? { annotation } : {}), hasDefault, kind: 'plain' };
  });
}

type ValueKind = 'str' | 'list' | 'dict' | 'int' | 'bool' | 'unknown';

function kindFromAnnotation(ann: string | undefined): ValueKind | undefined {
  if (!ann) return undefined;
  let a = ann.replace(/\s+/g, '');
  const opt = /^(?:Optional|typing\.Optional)\[(.*)\]$/.exec(a);
  if (opt) a = opt[1];
  a = a.replace(/\|(?:None|null|undefined)$/, '').replace(/^(?:None|null|undefined)\|/, '');
  if (/^(?:str|string|String)$/.test(a)) return 'str';
  if (/^(?:int|float|number|Number|bigint)$/.test(a)) return 'int';
  if (/^(?:bool|boolean|Boolean)$/.test(a)) return 'bool';
  if (/\[\]$|^(?:readonly)?(?:list|List|Sequence|Iterable|tuple|Tuple|Array|ReadonlyArray|set|Set)\b/.test(a)) return 'list';
  if (/^(?:dict|Dict|Mapping|MutableMapping|Record|object|Counter|defaultdict)\b|^\{/.test(a)) return 'dict';
  return undefined;
}

function kindFromName(name: string): ValueKind {
  const n = name.toLowerCase();
  if (/^(?:is|has|should|can|allow|use|enable)_?[a-z]|^(?:flag|verbose|strict|reverse|quiet|debug)$/.test(n)) return 'bool';
  if (/^(?:n|k|i|j|m|count|num|number|index|idx|pos|position|size|length|len|limit|start|end|stop|step|width|height|depth|max|min|amount|total|times|age|year|cents|offset|x|y)$|_(?:count|index|idx|size|len|limit|num|max|min)$|^(?:num|max|min|n)_/.test(n)) return 'int';
  if (/^(?:d|dict|dct|map|mapping|counts|counter|table|config|cfg|opts|options|settings|scores|index_of|lookup|freq|freqs|tally)$|_(?:map|dict|counts|table|lookup)$/.test(n)) return 'dict';
  if (/^(?:xs|ys|items|values|nums|numbers|lst|list|arr|array|seq|elements|words|lines|rows|cols|columns|args|argv|tokens|parts|names|records|entries|scores_list|data|prices|grades|matrix|grid|pairs)$|_(?:list|items|lines|rows|words|values|nums|arr)$/.test(n)) return 'list';
  if (/^(?:s|str|string|text|txt|line|word|name|sentence|path|key|prefix|suffix|sep|separator|delim|delimiter|char|ch|c|title|msg|message|csv|row|query|pattern|label|token|raw|content|source|src|code|email|url|phrase)$|_(?:str|text|name|line|word|path)$/.test(n)) return 'str';
  if (n.length > 2 && n.endsWith('s')) return 'list';
  return 'unknown';
}

function literalsFor(p: ParamInfo, lang: Lang): string[] {
  const py = lang === 'python';
  const none = py ? 'None' : 'null';
  if (p.kind === 'pattern-object') return ['{}'];
  if (p.kind === 'pattern-array') return ['[]'];
  const kind = kindFromAnnotation(p.annotation) ?? kindFromName(p.name);
  switch (kind) {
    case 'str':
      return ["''"];
    case 'list':
      return ['[]'];
    case 'dict':
      return ['{}'];
    case 'int':
      return ['0', '-1'];
    case 'bool':
      return [py ? 'False' : 'false'];
    default:
      return [none];
  }
}

/**
 * (3) Local fallback inputs from parameter names (and annotations): empty list or string, 0, -1,
 * None/null. Parameters with defaults, *args, **kwargs and ...rest are left out. Methods (self) are
 * never probed.
 */
export function fallbackProbes(fnName: string, params: readonly ParamInfo[] | undefined, lang: Lang, conceptId: string, max = 3): ProbeCandidate[] {
  if (!params || params.some((p) => p.kind === 'self')) return [];
  const required = params.filter((p) => !p.hasDefault && p.kind !== 'star' && p.kind !== 'kwstar' && p.kind !== 'rest' && p.kind !== 'marker');
  const options = required.map((p) => literalsFor(p, lang));
  const calls: string[] = [`${fnName}(${options.map((o) => o[0]).join(', ')})`];
  options.forEach((o, i) => {
    for (const alt of o.slice(1)) calls.push(`${fnName}(${options.map((x, k) => (k === i ? alt : x[0])).join(', ')})`);
  });
  const out: ProbeCandidate[] = [];
  for (const c of calls) {
    const check = validateCall(c, lang, [fnName]);
    if (!check.ok || !check.call || out.some((x) => x.callExpr === check.call)) continue;
    out.push({ fnName, callExpr: check.call, source: 'fallback', conceptId, misconceptionIfWrong: '' });
    if (out.length >= max) break;
  }
  return out;
}

export interface ProbeSources {
  /** The learner's function name. */
  fnName: string;
  /** Its interface name, when it is an interface function (spec calls use interface names). */
  ifaceName?: string;
  lang: Lang;
  visible?: readonly SpecItem[];
  hidden?: readonly SpecItem[];
  model?: readonly ModelProbe[];
  params?: readonly ParamInfo[];
  /** Concept for model probes without one and for fallback probes. */
  conceptId: string;
  /** Calls already asked for this function text. */
  exclude?: ReadonlySet<string>;
}

/** Model probes for `file` (absolute): those without a file, or whose workspace-relative file resolves to it. */
export function probesForFile(probes: readonly ModelProbe[] | undefined, file: string, workspaceDir: string): ModelProbe[] {
  return (probes ?? []).filter((p) => !p.file?.trim() || samePathish(path.resolve(workspaceDir, p.file.trim()), file));
}

/**
 * When to fire the OwnCodeProbeSchema job (spec V1-12 PROBE INPUTS (2)): only during building, only
 * for a task without a spec ladder, on a save whose set of function names changed (the first save
 * of a file with functions counts), at most once per 2 min. A change held back by the interval
 * stays pending, so the next save after it fires.
 */
export class ModelProbeTrigger {
  private seen = new Map<string, string>();
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly intervalMs = MODEL_PROBE_INTERVAL_MS) {}

  onSave(file: string, functionNames: readonly string[], now: number, o: { building: boolean; hasLadder: boolean }): boolean {
    if (!o.building || o.hasLadder) return false;
    const key = [...new Set(functionNames)].sort().join('\n');
    const fileKey = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    if (!key || this.seen.get(fileKey) === key) return false;
    if (now - this.lastAt < this.intervalMs) return false;
    this.seen.set(fileKey, key);
    this.lastAt = now;
    return true;
  }

  /** A new task: every file counts as unseen again (the interval still applies). */
  reset(): void {
    this.seen.clear();
  }
}

/** The OWNCODEPROBE prompt (spec V1-12, low effort, background; only when there is no spec ladder). */
export function ownCodeProbePrompt(i: { taskBrief: string; conceptIds: readonly string[]; path: string; code: string }): string {
  return [
    'Here is a file the learner just saved while working on the task below. Choose up to 3 calls to functions THEY wrote that test whether they understand what their own code does; favour edge cases tied to the task concepts (empty input, boundary index, missing key, duplicate values).',
    'Rules: callExpr is a single expression calling one of their functions with LITERAL arguments only (numbers, strings, lists, dicts, tuples, booleans, None/null). No other code, no variables, no imports. Never write or change their implementation. Skip functions that read files, the network, the clock, randomness or input().',
    'For each: file, functionName, callExpr, conceptId (from the given ids), edgeCase (<= 10 words), misconceptionIfWrong (kebab-case id or empty).',
    `Task: ${i.taskBrief}`,
    `Concept ids: ${i.conceptIds.join(', ')}`,
    `File ${i.path}: ${i.code}`,
  ].join('\n');
}

/** Every candidate in the spec's preference order: spec-mutated literals, model probes, fallbacks. */
export function selectProbes(s: ProbeSources): ProbeCandidate[] {
  const out: ProbeCandidate[] = [];
  const add = (cs: ProbeCandidate[]) => {
    for (const c of cs) if (!s.exclude?.has(c.callExpr) && !out.some((x) => x.callExpr === c.callExpr)) out.push(c);
  };
  if (s.visible?.length || s.hidden?.length) add(specDerivedProbes(s.fnName, s.ifaceName ?? s.fnName, s.lang, s.visible ?? [], s.hidden ?? []));
  if (s.model?.length) add(modelProbes(s.fnName, s.lang, s.model, s.conceptId));
  add(fallbackProbes(s.fnName, s.params, s.lang, s.conceptId));
  return out;
}

// =====================================================================================
// Grading and feedback (pure)
// =====================================================================================

export interface PredictGrade {
  verdict: VerdictKind;
  /** Evidence.correct: null for no idea and format-only. */
  correct: boolean | null;
  /** Record evidence at all (format-only is discarded). */
  evidence: boolean;
  note?: string;
}

/** Grade an own-code prediction as a return value (or the exception name). */
export function gradePrediction(answer: string, run: ProbeRun, lang: Lang): PredictGrade {
  if (!run.recorded) return { verdict: 'dont-know', correct: null, evidence: false };
  if (!answer.trim()) return { verdict: 'dont-know', correct: null, evidence: true };
  const v = compareOutput(answer, run.recorded, lang, { typeSensitive: false, returnValue: true });
  if (v.verdict === 'correct') return { verdict: 'correct', correct: true, evidence: true };
  if (v.verdict === 'format-only') return { verdict: 'format-only', correct: null, evidence: false, ...(v.note ? { note: v.note } : {}) };
  if (v.verdict === 'dont-know') return { verdict: 'dont-know', correct: null, evidence: true };
  return { verdict: 'wrong', correct: false, evidence: true };
}

/** 'ok 9s' / 'actual ['a', '', 'b'] · you said ['a', 'b']' / 'actual KeyError' (no idea). */
export function feedbackText(grade: Pick<PredictGrade, 'verdict' | 'note'>, actual: string, predicted: string, ms: number): string {
  const one = (s: string) => s.replace(/\s+/g, ' ').trim();
  switch (grade.verdict) {
    case 'correct':
      return `ok ${Math.max(1, Math.round(ms / 1000))}s`;
    case 'format-only':
      return grade.note ? one(grade.note) : `right idea · ${one(actual)}`;
    case 'dont-know':
      return `actual ${one(actual)}`;
    default:
      return `actual ${one(actual)} · you said ${one(predicted)}`;
  }
}

/** The hint-prompt addition (spec V1-12) when a pre-hint prediction exists. */
export function preHintLine(r: { callExpr: string; predicted: string; actual: string; correct: boolean | null }): string {
  const pred = r.predicted.trim() || 'no idea';
  const tail = r.correct === true
    ? 'Their mental model of this function matches the code, so look for the problem elsewhere.'
    : 'Start from this mismatch.';
  return `Before this hint they predicted ${r.callExpr} returns ${pred}; it actually returns ${r.actual}. ${tail}`;
}

/** Wrong own predictions in a task (not 'no idea', not format-only). */
export function wrongPredictions(probes: readonly OwnProbe[]): number {
  return probes.filter((p) => p.result && !p.result.correct && p.result.predicted.trim() && p.result.predicted.trim() !== '?').length;
}

/**
 * Specs 'went green fast': every visible spec green, each within 3 saves of becoming the target
 * (full spec weight), and, when given, the active time within the ladder's total par.
 */
export function specsGreenFast(spec: Pick<TaskSpecState, 'specs' | 'greenAt' | 'savesSinceRed'>, o: { activeMs?: number } = {}): boolean {
  if (!spec.specs.length) return false;
  const allGreen = spec.specs.every((s) => spec.greenAt?.[s.id] !== undefined);
  const quick = spec.specs.every((s) => (spec.savesSinceRed?.[s.id] ?? 0) <= 3);
  const par = spec.specs.reduce((n, s) => n + (Number.isFinite(s.parSec) ? s.parSec : 60), 0) * 1000;
  return allGreen && quick && (o.activeMs === undefined || o.activeMs <= par);
}

/**
 * CONFLICT FLAG (Task.notUnderstood): specs went green fast, but 2 or more own predictions were wrong
 * in this task. Then what-ifs become 3, the next stuck threshold drops 25%, and one bg-graded
 * explain question is added (the coach's part).
 */
export function conflictFlag(o: { ownProbes: readonly OwnProbe[]; specsFast: boolean }): boolean {
  return o.specsFast && wrongPredictions(o.ownProbes) >= 2;
}

/** What-ifs per task: 2, or 3 when the conflict flag is set. */
export function whatIfCount(notUnderstood: boolean | undefined): number {
  return notUnderstood ? 3 : 2;
}

// =====================================================================================
// What-if lines and display (pure)
// =====================================================================================

/**
 * Lines the probe call exercises: the probed function's body and, transitively, the bodies of
 * other top-level functions it calls by name (0-based). Lines inside multi-line strings and block
 * comments are left out.
 */
export function exercisedLines(text: string, fns: readonly FunctionLoc[], fnName: string, lang: Lang): WhatIfLine[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const inside = blockLines(lines, lang);
  const byName = new Map(fns.map((f) => [f.name, f] as const));
  const seen = new Set<string>();
  const queue = [fnName];
  const out = new Map<number, WhatIfLine>();
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const f = byName.get(name);
    if (!f) continue;
    const from = f.defLine === f.endLine ? f.defLine : f.defLine + 1;
    for (let i = from; i <= f.endLine && i < lines.length; i++) {
      if (inside.has(i)) continue;
      out.set(i, { line: i, text: lines[i] });
      const masked = maskLine(lines[i], lang);
      for (const other of byName.keys()) {
        if (seen.has(other) || queue.includes(other)) continue;
        if (new RegExp(`(?<![\\w$.])${other.replace(/\$/g, '\\$')}\\s*\\(`).test(masked)) queue.push(other);
      }
    }
  }
  return [...out.values()].sort((a, b) => a.line - b.line);
}

/**
 * Lines that start inside a multi-line string (Python triple quotes, JS template literal) or a
 * block comment. The line that opens one is kept: maskLine masks an unterminated string to its end.
 */
function blockLines(lines: string[], lang: Lang): Set<number> {
  const out = new Set<number>();
  const re = lang === 'python' ? /"""|'''/g : /\/\*|\*\/|`/g;
  let open: string | undefined; // the token that closes the open block
  lines.forEach((l, i) => {
    if (open) out.add(i);
    for (const m of l.matchAll(re)) {
      const t = m[0];
      if (open) {
        if (t === open) open = undefined;
      } else if (t === '/*') open = '*/';
      else if (t !== '*/') open = t;
    }
  });
  return out;
}

/** The changed part of a mutated line in a little context, for 'what if: <snippet>' (<= 43 chars). */
export function whatIfSnippet(mutatedLine: string, edit: { start: number; replacement: string }, max = 43): string {
  let s = mutatedLine.trim().replace(/\s*[:{;]\s*$/, '');
  const lead = mutatedLine.length - mutatedLine.trimStart().length;
  if ([...s].length <= max) return s;
  const at = Math.max(0, edit.start - lead);
  const room = Math.max(10, max - 2);
  let from = Math.max(0, at - Math.floor((room - edit.replacement.length) / 2));
  from = Math.min(from, Math.max(0, s.length - room));
  const to = Math.min(s.length, from + room);
  s = (from > 0 ? '…' : '') + s.slice(from, to).trim() + (to < s.length ? '…' : '');
  return s;
}

/** One onDidChangeTextDocument content change: its range lines (before the edit) and the inserted text. */
export interface LineChange {
  startLine: number;
  endLine: number;
  /** The inserted text: lets an edit above a region shift it. */
  text?: string;
}

/** 0-based inclusive line region. */
export interface LineRegion {
  startLine: number;
  endLine: number;
}

/**
 * A feedback region after an edit: undefined when a change touches it (the feedback clears), else
 * moved by the lines that changes above it added or removed. Ranges are those of the document
 * before the event, as VS Code reports them.
 */
export function regionAfterEdits(r: LineRegion, changes: readonly LineChange[]): LineRegion | undefined {
  let shift = 0;
  for (const c of changes) {
    if (c.startLine <= r.endLine && c.endLine >= r.startLine) return undefined;
    if (c.endLine < r.startLine && c.text !== undefined) shift += (c.text.match(/\n/g)?.length ?? 0) - (c.endLine - c.startLine);
  }
  return shift ? { startLine: r.startLine + shift, endLine: r.endLine + shift } : r;
}

function replaceLine(text: string, line: number, newLine: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  lines[line] = newLine;
  return lines.join(eol);
}

// =====================================================================================
// Ports (injected; vscode implementations below)
// =====================================================================================

export interface Question {
  title: string;
  prompt: string;
  placeholder?: string;
}

/** 'later' = the Later button; 'esc' = Esc or the box closed. Both are neutral. */
export type Answer = { kind: 'answer'; text: string; ms: number; focusLost?: boolean } | { kind: 'later' } | { kind: 'esc' };

export interface QuestionPort {
  ask(q: Question, signal?: AbortSignal): Promise<Answer>;
}

/** The what-if 'line-through' decoration on the changed token. */
export interface StrikePort {
  show(uri: string, line: number, start: number, end: number): void;
  clear(): void;
}

/** InteractionLock's acquire (src/lock.ts). */
export interface LockPort {
  acquire(kind: 'own-predict' | 'what-if', onAbort?: (reason: 'esc') => void): (() => void) | undefined;
}

export interface OwnCodeDeps {
  /** The runner for the task's language (undefined: no runtime). */
  runner(): Runner | undefined;
  /** Consent 'all' and a trusted workspace. */
  allowRun(): boolean;
  harnessDir: string;
  workspaceDir(): string | undefined;
  uriOf(fsPath: string): string;
  /** The CURRENT text (open editor first, else disk). */
  readText(fsPath: string): Promise<string | undefined>;
  functions?(fsPath: string, text: string, lang: Lang): Promise<FunctionLoc[]>;
  annotations: AnnotationSink;
  actions: ActionSink;
  ask: QuestionPort;
  lock?: LockPort;
  clock?: Clock;
  log?(msg: string): void;
}

// =====================================================================================
// A. PredictFlow
// =====================================================================================

export interface PredictContext {
  taskId: string;
  lang: Lang;
  /** Absolute path of the file whose function is probed (the interface file when there is a ladder). */
  file: string;
  /** Function to probe (the learner's name). Default: the eligible function at the cursor, else the first. */
  fnName?: string;
  /** Eligible task functions (the learner's names); default every top-level function in the file. */
  functions?: readonly string[];
  cursorLine?: number;
  /** Interface name -> learner name (Task.interface.mappedNames). */
  mappedNames?: Record<string, string>;
  visible?: readonly SpecItem[];
  hidden?: readonly SpecItem[];
  /** OwnCodeProbeSchema results (only when the task has no ladder). */
  modelProbes?: readonly ModelProbe[];
  /** Concept for fallback / model probes without one (e.g. the task's weakest concept). */
  conceptId: string;
  /** Task.ownProbes so far: a call is never asked twice for the same function text. */
  asked?: readonly OwnProbe[];
  /** Learner speed for par (learner.cps, learner.speedFactor). */
  speed?: { cps: number; speedFactor: number };
  /** How the prediction was started: an accepted offer, Ctrl+Alt+P, or the pre-hint step. */
  via?: 'offer' | 'key' | 'pre-hint';
}

export interface PreparedProbe {
  probe: OwnProbe;
  file: string;
  uri: string;
  fn: FunctionLoc;
  edgeCase?: string;
  /** Result on the text at prepare time (reused when the function is unchanged at accept). */
  preRun?: ProbeRun;
  textHash?: string;
}

export type PredictResult =
  | {
    status: 'answered';
    probe: OwnProbe;
    verdict: VerdictKind;
    correct: boolean | null;
    predicted: string;
    actual: string;
    ms: number;
    /** Record with recordEvidence (absent for format-only answers). */
    evidence?: EvidenceInput;
    /** A wrong prediction: queue an 'atom' offer when its concept has a cached atom. */
    mismatch: boolean;
    conceptId: string;
    uri: string;
    line: number;
    /** For the hint prompt when this was the pre-hint step. */
    hintLine: string;
  }
  | { status: 'later' | 'esc'; probe: OwnProbe }
  | { status: 'unavailable'; reason: string };

/** Title 'parse_row('a,,b') -> ?'. */
export function predictTitle(callExpr: string): string {
  return `${callExpr} -> ?`;
}

export class PredictFlow {
  private readonly clock: Clock;
  private offered?: PreparedProbe & { taskId: string };
  private feedback?: { uri: string; startLine: number; endLine: number };
  /** Calls asked per function text hash (the probe store). */
  private asked = new Map<string, Set<string>>();

  constructor(private readonly deps: OwnCodeDeps, private readonly onResult?: (r: PredictResult) => void) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Pick the function and the first usable probe (pre-run on the current text). Undefined when none. */
  async prepare(ctx: PredictContext, o: { skipAnsweredFunctions?: boolean } = {}): Promise<PreparedProbe | undefined> {
    const runner = this.deps.runner();
    const ws = this.deps.workspaceDir();
    if (!runner || !ws || !this.deps.allowRun()) return undefined;
    const text = await this.deps.readText(ctx.file);
    if (text === undefined) return undefined;
    const fns = await this.functionsOf(ctx.file, text, ctx.lang);
    const eligible = fns.filter((f) => !ctx.functions || ctx.functions.includes(f.name));
    const order = orderFunctions(eligible, ctx);
    const model = probesForFile(ctx.modelProbes, ctx.file, ws);
    let runs = 0;
    for (const fn of order) {
      const hash = functionHash(text, fn);
      if (o.skipAnsweredFunctions && this.answeredHashes(ctx).has(hash)) continue;
      const ifaceName = Object.entries(ctx.mappedNames ?? {}).find(([, v]) => v === fn.name)?.[0] ?? fn.name;
      const exclude = new Set([...(this.asked.get(hash) ?? []), ...(ctx.asked ?? []).filter((p) => p.fnHash === hash).map((p) => p.callExpr)]);
      const cands = selectProbes({
        fnName: fn.name, ifaceName, lang: ctx.lang, visible: ctx.visible, hidden: ctx.hidden, model,
        params: paramsOf(text, fn, ctx.lang), conceptId: ctx.conceptId, exclude,
      });
      for (const c of cands.slice(0, MAX_PROBE_TRIES)) {
        if (++runs > MAX_PREPARE_RUNS) return undefined;
        let run: ProbeRun;
        try {
          run = await runProbe(runner, { harnessDir: this.deps.harnessDir, workspaceDir: ws, file: ctx.file, call: c.callExpr, source: text });
        } catch (e) {
          this.log(`own-code: probe failed: ${e instanceof Error ? e.message : String(e)}`);
          return undefined;
        }
        if (run.outcome.loadError) {
          this.log(`own-code: module skipped (${run.outcome.loadError.kind}): ${run.outcome.loadError.message}`);
          return undefined; // an unsafe module is skipped (spec V1-12 MODULE SAFETY)
        }
        if (!run.usable || run.display.length > MAX_ANSWER_CHARS) continue;
        const probe: OwnProbe = { fnName: fn.name, fnHash: hash, callExpr: c.callExpr, source: c.source, conceptId: c.conceptId, misconceptionIfWrong: c.misconceptionIfWrong };
        return { probe, file: ctx.file, uri: this.deps.uriOf(ctx.file), fn, preRun: run, textHash: hash53(text).toString(36), ...(c.edgeCase ? { edgeCase: c.edgeCase } : {}) };
      }
    }
    return undefined;
  }

  /**
   * Offer a prediction: gutter 'offer' icon on the def line (hover links to deliberate.predictOwn)
   * and the tempo action '$(question) predict parse_row (15s)'. The scheduler decides when it shows.
   */
  async offer(ctx: PredictContext): Promise<PreparedProbe | undefined> {
    const p = await this.prepare(ctx, { skipAnsweredFunctions: true });
    if (!p) return undefined;
    this.clearOffer();
    this.offered = { ...p, taskId: ctx.taskId };
    this.deps.annotations.setGutter(p.uri, p.fn.defLine, 'offer', mdEscape(`Predict what ${p.probe.callExpr} returns (Ctrl+Alt+P)`), { command: PREDICT_COMMAND });
    this.deps.actions.enqueue({ id: PREDICT_ACTION_ID, kind: 'own-predict', label: status.predictOwn(p.fn.name, 15), priority: 3, blocking: false, command: PREDICT_COMMAND });
    return p;
  }

  /** The current offer, if any (e.g. to decide whether Ctrl+Alt+P reuses it). */
  get currentOffer(): PreparedProbe | undefined {
    return this.offered;
  }

  clearOffer(): void {
    if (!this.offered) return;
    this.deps.annotations.clearGutter(this.offered.uri, 'offer');
    this.deps.actions.remove(PREDICT_ACTION_ID);
    this.offered = undefined;
  }

  /**
   * Ask, run against the CURRENT text, grade, show feedback on the def line. Later / Esc are neutral
   * (nothing recorded). Uses `prepared`, else the current offer for this task (when the cursor is
   * not in another function), else prepares now.
   */
  async run(ctx: PredictContext, prepared?: PreparedProbe): Promise<PredictResult> {
    const runner = this.deps.runner();
    const ws = this.deps.workspaceDir();
    if (!runner || !ws) return this.done({ status: 'unavailable', reason: 'no runtime for your code' });
    if (!this.deps.allowRun()) return this.done({ status: 'unavailable', reason: 'running your code is off (needs consent and a trusted workspace)' });
    let p = prepared;
    const offer = this.offered;
    if (!p && offer && offer.taskId === ctx.taskId && samePathish(offer.file, ctx.file) && (!ctx.fnName || ctx.fnName === offer.fn.name)) {
      const inOther = ctx.cursorLine !== undefined && (ctx.cursorLine < offer.fn.startLine || ctx.cursorLine > offer.fn.endLine);
      if (!inOther || ctx.via !== 'key') p = offer;
    }
    p ??= await this.prepare(ctx);
    if (!p) return this.done({ status: 'unavailable', reason: 'no function to predict here yet' });
    this.clearOffer();

    const ac = new AbortController();
    let release: (() => void) | undefined;
    if (this.deps.lock) {
      release = this.deps.lock.acquire('own-predict', () => ac.abort());
      if (!release) return this.done({ status: 'unavailable', reason: 'busy' });
    }
    try {
      const answer = await this.deps.ask.ask({ title: predictTitle(p.probe.callExpr), prompt: PREDICT_PROMPT, ...(p.edgeCase ? { placeholder: p.edgeCase } : {}) }, ac.signal);
      if (answer.kind !== 'answer') return this.done({ status: answer.kind, probe: p.probe });
      const asked = this.asked.get(p.probe.fnHash) ?? new Set<string>();
      asked.add(p.probe.callExpr);
      this.asked.set(p.probe.fnHash, asked);

      // Run against the CURRENT text (reuse the prepare-time result when nothing changed).
      const text = (await this.deps.readText(p.file)) ?? '';
      let result = p.preRun && p.textHash === hash53(text).toString(36) ? p.preRun : undefined;
      if (!result) {
        try {
          result = await runProbe(runner, { harnessDir: this.deps.harnessDir, workspaceDir: ws, file: p.file, call: p.probe.callExpr, source: text });
        } catch (e) {
          return this.done({ status: 'unavailable', reason: `the probe did not run: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
      const fns = await this.functionsOf(p.file, text, ctx.lang);
      const fn = fns.find((f) => f.name === p!.fn.name) ?? p.fn;
      if (!result.usable) {
        // The code changed under the question (now loops, fails to load, ...): show it, record nothing.
        const msg = result.outcome.loadError ? result.display : result.outcome.timedOut ? `${p.probe.callExpr} ${TIMEOUT_TEXT}` : `actual: ${result.display}`;
        this.showFeedback(p.uri, fn, msg, msg);
        return this.done({ status: 'unavailable', reason: result.display });
      }
      const grade = gradePrediction(answer.text, result, ctx.lang);
      const fb = feedbackText(grade, result.display, answer.text, answer.ms);
      this.showFeedback(p.uri, fn, fb, `${p.probe.callExpr} returns ${result.display}`);
      const correctish = grade.verdict === 'correct' || grade.verdict === 'format-only';
      const probe: OwnProbe = { ...p.probe, result: { predicted: answer.text, actual: result.display, correct: correctish, ms: answer.ms } };
      const conceptId = p.probe.conceptId || ctx.conceptId;
      let evidence: EvidenceInput | undefined;
      if (grade.evidence) {
        evidence = {
          conceptId, kind: 'own-predict', source: 'own-code', correct: grade.correct, verdict: grade.verdict, at: this.clock.now(),
          taskId: ctx.taskId, itemId: `own:${fn.name}:${hash53(p.probe.callExpr).toString(36)}`, siblingGroup: `own:${fn.name}`,
          guessFlag: false, latencyMs: answer.ms, latencyValid: !answer.focusLost && answer.ms > 0, g: answerSpaceG(result.recorded!),
          // Fallback inputs only guess at the concept they test.
          weight: p.probe.source === 'fallback' ? 0.5 : 1,
        };
        if (grade.correct === false && p.probe.misconceptionIfWrong) {
          evidence.misconceptionId = p.probe.misconceptionIfWrong;
          evidence.misconceptionOdds = 3;
        }
        if (ctx.speed) {
          const item = { kind: 'own-predict' as const, codeLines: fn.endLine - fn.startLine + 1, answerChars: result.display.length, parSec: PREDICT_PAR_SEC };
          evidence.parSelfMs = parSelf(item, ctx.speed);
          evidence.parAbsMs = parAbs(item, ctx.speed);
        }
      }
      return this.done({
        status: 'answered', probe, verdict: grade.verdict, correct: grade.correct, predicted: answer.text, actual: result.display, ms: answer.ms,
        evidence, mismatch: grade.verdict === 'wrong', conceptId, uri: p.uri, line: fn.defLine,
        hintLine: preHintLine({ callExpr: p.probe.callExpr, predicted: answer.text, actual: result.display, correct: grade.correct }),
      });
    } finally {
      release?.();
    }
  }

  /**
   * Call from onDidChangeTextDocument (changes: range.start.line, range.end.line, text): feedback
   * clears on the next edit inside that function; edits above it move the tracked lines.
   */
  onEdit(uri: string, changes: readonly LineChange[]): void {
    const f = this.feedback;
    if (!f || f.uri !== uri) return;
    const next = regionAfterEdits(f, changes);
    if (next) {
      this.feedback = { uri, ...next };
      return;
    }
    this.deps.annotations.clear('own-predict', uri);
    this.feedback = undefined;
  }

  dispose(): void {
    this.clearOffer();
    if (this.feedback) this.deps.annotations.clear('own-predict', this.feedback.uri);
    this.feedback = undefined;
  }

  private showFeedback(uri: string, fn: FunctionLoc, text: string, hover: string): void {
    this.deps.annotations.clear('own-predict', uri);
    this.deps.annotations.set({ uri, line: fn.defLine, source: 'own-predict', text, hover: mdEscape(hover) });
    this.feedback = { uri, startLine: fn.startLine, endLine: fn.endLine };
  }

  private answeredHashes(ctx: PredictContext): Set<string> {
    const out = new Set<string>(this.asked.keys());
    for (const p of ctx.asked ?? []) if (p.result) out.add(p.fnHash);
    return out;
  }

  private done(r: PredictResult): PredictResult {
    try {
      this.onResult?.(r);
    } catch (e) {
      this.log(`own-code: result callback failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return r;
  }

  private async functionsOf(file: string, text: string, lang: Lang): Promise<FunctionLoc[]> {
    try {
      return this.deps.functions ? await this.deps.functions(file, text, lang) : functionsFromText(text, lang);
    } catch {
      return functionsFromText(text, lang);
    }
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }
}

function samePathish(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** fnName first, then the function at the cursor, then file order. */
function orderFunctions(fns: readonly FunctionLoc[], ctx: Pick<PredictContext, 'fnName' | 'cursorLine'>): FunctionLoc[] {
  if (ctx.fnName) return fns.filter((f) => f.name === ctx.fnName);
  const at = ctx.cursorLine !== undefined ? fns.find((f) => ctx.cursorLine! >= f.startLine && ctx.cursorLine! <= f.endLine) : undefined;
  return at ? [at, ...fns.filter((f) => f !== at)] : [...fns];
}

// =====================================================================================
// B. WhatIfFlow
// =====================================================================================

export interface WhatIfContext extends Omit<PredictContext, 'via'> {
  /** The probe call to ask about; default: the first usable probe for the function (as PredictFlow picks). */
  callExpr?: string;
  /** 2, or 3 when Task.notUnderstood (whatIfCount). */
  count?: number;
  /** Tag of the task's weakest concept (operators on it are preferred). */
  weakestTag?: string;
  /** Learner.mistakes: their misconceptions and tags are preferred. */
  journal?: readonly { misconceptionId?: string }[];
  /** Concept id for an operator's tag (what-if evidence goes there); default ctx.conceptId. */
  conceptForTag?(tag: string): string | undefined;
  /** Every task concept is Fluent: what-ifs are skipped entirely. */
  allFluent?: boolean;
}

export interface PreparedWhatIf {
  cand: WhatIfCandidate;
  file: string;
  uri: string;
  fnName: string;
  callExpr: string;
  /** The original line text. */
  lineText: string;
  actual: ProbeRun;
  unmutated: ProbeRun;
  alternative?: ProbeRun;
}

export interface WhatIfRunResult {
  status: 'done' | 'later' | 'skipped' | 'unavailable';
  reason?: string;
  /** Task.whatIfs records (answered ones carry predicted / correct / attributable). */
  whatIfs: WhatIf[];
  /** Records for recordEvidence, one per graded answer. */
  evidence: EvidenceInput[];
}

/** 'With this change, total([4, 5, 6]) -> ?'. */
export function whatIfTitle(callExpr: string): string {
  return `With this change, ${callExpr} -> ?`;
}

/** Evidence for one what-if answer (attributeWhatIf decides weight and misconception), or undefined. */
export function whatIfEvidence(
  answer: string, w: Pick<PreparedWhatIf, 'cand' | 'actual' | 'unmutated' | 'alternative' | 'fnName'>, lang: Lang,
  o: { conceptId: string; taskId: string; at: number; ms: number; focusLost?: boolean },
): { evidence?: EvidenceInput; correct: boolean | null; attributable: boolean; verdict: VerdictKind } {
  if (!w.actual.recorded || !w.unmutated.recorded) return { correct: null, attributable: false, verdict: 'dont-know' };
  const att = attributeWhatIf(answer, { actual: w.actual.recorded, unmutated: w.unmutated.recorded, alternative: w.alternative?.recorded }, lang, w.cand.op);
  if (!att.evidence) return { correct: att.correct, attributable: false, verdict: att.verdict };
  const e: EvidenceInput = {
    conceptId: o.conceptId, kind: 'what-if', source: 'own-code', correct: att.correct, verdict: att.verdict, weight: att.weight,
    at: o.at, taskId: o.taskId, itemId: `whatif:${w.fnName}:${w.cand.line}:${w.cand.op}`, siblingGroup: `own:${w.fnName}`,
    guessFlag: false, latencyMs: o.ms, latencyValid: !o.focusLost && o.ms > 0, g: answerSpaceG(w.actual.recorded),
  };
  if (att.attributable && att.misconceptionId) {
    e.misconceptionId = att.misconceptionId;
    e.misconceptionOdds = att.misconceptionOdds ?? 3;
  }
  return { evidence: e, correct: att.correct, attributable: att.attributable, verdict: att.verdict };
}

export class WhatIfFlow {
  private readonly clock: Clock;
  private feedback?: { uri: string; startLine: number; endLine: number };

  constructor(private readonly deps: OwnCodeDeps & { strike: StrikePort }) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Candidates on lines the probe call exercises (mutants.ts), applied to an in-memory copy and run.
   * Kept: mutants whose result differs from the unmutated one (raising counts). Dropped: mutants
   * that do not load (a parse error shows as a load error), time out or give the same result.
   */
  async prepare(ctx: WhatIfContext): Promise<PreparedWhatIf[]> {
    const runner = this.deps.runner();
    const ws = this.deps.workspaceDir();
    if (!runner || !ws || !this.deps.allowRun()) return [];
    const text = await this.deps.readText(ctx.file);
    if (text === undefined) return [];
    const fns = await this.functionsOf(ctx.file, text, ctx.lang);
    const want = Math.max(1, ctx.count ?? 2);
    const run = (source: string, call: string) => runProbe(runner, { harnessDir: this.deps.harnessDir, workspaceDir: ws, file: ctx.file, call, source });

    // Calls to try, in order: the given one (validated), then probe inputs for the task functions.
    const calls: string[] = [];
    if (ctx.callExpr) {
      const check = parseCall(ctx.callExpr, ctx.lang);
      if (check.ok && fns.some((f) => f.name === check.callee)) calls.push(check.call!);
    }
    const eligible = fns.filter((f) => !ctx.functions || ctx.functions.includes(f.name));
    const model = probesForFile(ctx.modelProbes, ctx.file, ws);
    for (const fn of orderFunctions(eligible, ctx)) {
      const ifaceName = Object.entries(ctx.mappedNames ?? {}).find(([, v]) => v === fn.name)?.[0] ?? fn.name;
      const cands = selectProbes({ fnName: fn.name, ifaceName, lang: ctx.lang, visible: ctx.visible, hidden: ctx.hidden, model, params: paramsOf(text, fn, ctx.lang), conceptId: ctx.conceptId });
      for (const c of cands) if (!calls.includes(c.callExpr)) calls.push(c.callExpr);
    }

    // A call that raises early exercises few lines: try the next one until enough what-ifs differ.
    let best: PreparedWhatIf[] = [];
    for (const call of calls.slice(0, MAX_PROBE_TRIES)) {
      let unmutated: ProbeRun;
      try {
        unmutated = await run(text, call);
      } catch (e) {
        this.log(`what-if: probe failed: ${e instanceof Error ? e.message : String(e)}`);
        return best;
      }
      if (unmutated.outcome.loadError) return best; // an unsafe module is skipped
      if (!unmutated.usable || unmutated.display.length > MAX_ANSWER_CHARS) continue;
      const kept = await this.mutantsFor(ctx, text, fns, call, unmutated, want, run);
      if (kept.length > best.length) best = kept;
      if (best.length >= want) break;
    }
    return best;
  }

  /** Mutants on the lines `call` exercises that change its result. */
  private async mutantsFor(
    ctx: WhatIfContext, text: string, fns: FunctionLoc[], call: string, unmutated: ProbeRun, want: number,
    run: (source: string, call: string) => Promise<ProbeRun>,
  ): Promise<PreparedWhatIf[]> {
    const fnName = calleeOf(call)!;
    const lines = exercisedLines(text, fns, fnName, ctx.lang);
    const cands = whatIfCandidates(lines, ctx.lang, { weakestTag: ctx.weakestTag, journal: ctx.journal, max: want + 4 });
    const kept: PreparedWhatIf[] = [];
    const uri = this.deps.uriOf(ctx.file);
    const all = text.split(/\r?\n/);
    for (const cand of cands) {
      if (kept.length >= want) break;
      const lineText = all[cand.line] ?? '';
      let actual: ProbeRun;
      try {
        actual = await run(replaceLine(text, cand.line, cand.mutated), call);
      } catch (e) {
        this.log(`what-if: probe failed: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
      // Kept only when it runs (a non-parsing mutant shows as a load error), finishes, and changes the result.
      if (!actual.usable || actual.display.length > MAX_ANSWER_CHARS || sameResult(actual, unmutated)) continue;
      const w: PreparedWhatIf = { cand, file: ctx.file, uri, fnName, callExpr: call, lineText, actual, unmutated };
      const alt = alternativeLine(lineText, cand.op, ctx.lang);
      if (alt !== null && alt !== lineText) {
        try {
          const a = await run(replaceLine(text, cand.line, alt), call);
          if (a.usable) w.alternative = a;
        } catch {
          // the alternative only widens attribution; without it the unmutated output still attributes
        }
      }
      kept.push(w);
    }
    return kept;
  }

  /**
   * Show each what-if (line-through on the changed token, after-text 'what if: ...'), ask
   * 'With this change, total([4, 5, 6]) -> ?', grade with attribution. Later / Esc stop the
   * sequence and are neutral. The file is never edited.
   */
  async run(ctx: WhatIfContext, prepared?: PreparedWhatIf[]): Promise<WhatIfRunResult> {
    if (ctx.allFluent) return { status: 'skipped', reason: 'every task concept is Fluent', whatIfs: [], evidence: [] };
    if (!this.deps.runner() || !this.deps.workspaceDir()) return { status: 'unavailable', reason: 'no runtime for your code', whatIfs: [], evidence: [] };
    if (!this.deps.allowRun()) return { status: 'unavailable', reason: 'running your code is off (needs consent and a trusted workspace)', whatIfs: [], evidence: [] };
    const list = prepared ?? (await this.prepare(ctx));
    if (!list.length) return { status: 'unavailable', reason: 'no what-if changes the result of your function', whatIfs: [], evidence: [] };

    const ac = new AbortController();
    let release: (() => void) | undefined;
    if (this.deps.lock) {
      release = this.deps.lock.acquire('what-if', () => ac.abort());
      if (!release) return { status: 'unavailable', reason: 'busy', whatIfs: [], evidence: [] };
    }
    const out: WhatIfRunResult = { status: 'done', whatIfs: [], evidence: [] };
    try {
      for (const w of list) {
        const { cand } = w;
        const record: WhatIf = {
          file: w.file, line: cand.line, op: cand.op, tag: cand.tag, callExpr: w.callExpr, mutatedLine: cand.mutated,
          actual: w.actual.display, unmutated: w.unmutated.display, ...(w.alternative ? { alternative: w.alternative.display } : {}),
        };
        this.deps.strike.show(w.uri, cand.line, cand.start, cand.end);
        this.deps.annotations.clear('what-if', w.uri);
        this.deps.annotations.set({
          uri: w.uri, line: cand.line, source: 'what-if', text: `what if: ${whatIfSnippet(cand.mutated, cand)}`,
          hover: mdEscape(`What if line ${cand.line + 1} read: ${cand.mutated.trim()} (${operator(cand.op).label})`),
        });
        const answer = await this.deps.ask.ask({ title: whatIfTitle(w.callExpr), prompt: PREDICT_PROMPT }, ac.signal);
        if (answer.kind !== 'answer') {
          this.deps.strike.clear();
          this.deps.annotations.clear('what-if', w.uri);
          out.status = 'later';
          break;
        }
        const conceptId = ctx.conceptForTag?.(cand.tag) || ctx.conceptId;
        const graded = whatIfEvidence(answer.text, w, ctx.lang, { conceptId, taskId: ctx.taskId, at: this.clock.now(), ms: answer.ms, focusLost: answer.focusLost });
        record.predicted = answer.text;
        record.correct = graded.correct === true;
        record.attributable = graded.attributable;
        out.whatIfs.push(record);
        if (graded.evidence) out.evidence.push(graded.evidence);
        const fb = graded.verdict === 'correct'
          ? `ok ${Math.max(1, Math.round(answer.ms / 1000))}s · ${w.actual.display}`
          : feedbackText({ verdict: graded.verdict }, w.actual.display, answer.text, answer.ms);
        this.deps.strike.clear();
        this.deps.annotations.clear('what-if', w.uri);
        this.deps.annotations.set({
          uri: w.uri, line: cand.line, source: 'what-if', text: fb,
          hover: mdEscape(`With ${cand.mutated.trim()}, ${w.callExpr} returns ${w.actual.display}; your code returns ${w.unmutated.display}.`),
        });
        this.feedback = { uri: w.uri, startLine: cand.line, endLine: cand.line };
      }
    } finally {
      this.deps.strike.clear();
      release?.();
    }
    return out;
  }

  /** Call from onDidChangeTextDocument: what-if feedback clears on an edit to its line; edits above move it. */
  onEdit(uri: string, changes: readonly LineChange[]): void {
    const f = this.feedback;
    if (!f || f.uri !== uri) return;
    const next = regionAfterEdits(f, changes);
    if (next) {
      this.feedback = { uri, ...next };
      return;
    }
    this.deps.annotations.clear('what-if', uri);
    this.feedback = undefined;
  }

  dispose(): void {
    this.deps.strike.clear();
    if (this.feedback) this.deps.annotations.clear('what-if', this.feedback.uri);
    this.feedback = undefined;
  }

  private async functionsOf(file: string, text: string, lang: Lang): Promise<FunctionLoc[]> {
    try {
      return this.deps.functions ? await this.deps.functions(file, text, lang) : functionsFromText(text, lang);
    } catch {
      return functionsFromText(text, lang);
    }
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }
}

// =====================================================================================
// VS Code ports (thin)
// =====================================================================================

/**
 * The prediction InputBox (spec V1-12 A): ignoreFocusOut, an Info validation message while empty,
 * a 'Later' button (history icon). Later and Esc are neutral; an abort closes it as Esc.
 */
export class VscodeQuestionPort implements QuestionPort {
  ask(q: Question, signal?: AbortSignal): Promise<Answer> {
    return new Promise<Answer>((resolve) => {
      if (signal?.aborted) return resolve({ kind: 'esc' });
      const box = vscode.window.createInputBox();
      const later: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('history'), tooltip: 'Later' };
      const empty: vscode.InputBoxValidationMessage = { message: EMPTY_MEANS, severity: vscode.InputBoxValidationSeverity.Info };
      box.title = q.title;
      box.prompt = q.prompt;
      if (q.placeholder) box.placeholder = q.placeholder;
      box.ignoreFocusOut = true;
      box.buttons = [later];
      box.validationMessage = empty;
      const t0 = Date.now();
      let focusLost = !vscode.window.state.focused;
      let done = false;
      const subs: vscode.Disposable[] = [];
      const finish = (a: Answer) => {
        if (done) return;
        done = true;
        for (const s of subs) s.dispose();
        resolve(a);
        box.hide();
        box.dispose();
      };
      subs.push(
        box.onDidChangeValue((v) => (box.validationMessage = v.trim() ? undefined : empty)),
        box.onDidTriggerButton((b) => {
          if (b === later) finish({ kind: 'later' });
        }),
        box.onDidAccept(() => finish({ kind: 'answer', text: box.value, ms: Date.now() - t0, focusLost })),
        box.onDidHide(() => finish({ kind: 'esc' })),
        vscode.window.onDidChangeWindowState((s) => {
          if (!s.focused) focusLost = true;
        }),
      );
      signal?.addEventListener('abort', () => finish({ kind: 'esc' }), { once: true });
      box.show();
    });
  }
}

/** The what-if 'line-through' on the changed token, re-applied when the editor becomes visible. */
export class VscodeStrike implements StrikePort {
  private type?: vscode.TextEditorDecorationType;
  private current?: { uri: string; range: vscode.Range };
  private sub?: vscode.Disposable;

  show(uri: string, line: number, start: number, end: number): void {
    this.type ??= vscode.window.createTextEditorDecorationType({ textDecoration: 'line-through', opacity: '0.75' });
    this.sub ??= vscode.window.onDidChangeVisibleTextEditors(() => this.apply());
    this.current = { uri, range: new vscode.Range(line, start, line, Math.max(start + 1, end)) };
    this.apply();
  }

  clear(): void {
    this.current = undefined;
    this.apply();
  }

  private apply(): void {
    if (!this.type) return;
    for (const ed of vscode.window.visibleTextEditors) {
      const on = this.current && ed.document.uri.toString() === this.current.uri;
      ed.setDecorations(this.type, on ? [this.current!.range] : []);
    }
  }

  dispose(): void {
    this.clear();
    this.sub?.dispose();
    this.type?.dispose();
    this.sub = undefined;
    this.type = undefined;
  }
}
