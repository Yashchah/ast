// Call expressions with literal-only arguments (spec V1-11 CALL AND EXPECTED VALIDATION, V1-12
// spec-derived probe inputs). Pure: no vscode import.
// Spec calls and own-code probe calls come from a model prompted with workspace content, so a call
// is accepted only when it is exactly one call to an interface function whose arguments are plain
// literals: nothing in it can run code when the harness evaluates it.

import type { Lang, Val } from './contracts';
import { LiteralError, parseLiteralAt, valEquals, type LitNode } from './compare';

export interface CallArg {
  /** Python keyword argument name (name=literal). */
  name?: string;
  /** Source text of the literal, without the name=. */
  text: string;
  val: Val;
  /** Parsed literal with spans into the call text (for mutateLiteral). */
  node: LitNode;
}

export interface CallCheck {
  ok: boolean;
  callee: string;
  args: CallArg[];
  /** Canonical call text when ok: callee(arg, name=arg) with the literals as written, no trailing ';'. */
  call?: string;
  error?: string;
}

/** Longer calls are never a spec input; also bounds parser work. */
const MAX_CALL_CHARS = 4000;

const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

const JS_KEYWORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

const PY_IDENT = /[A-Za-z_\p{L}][A-Za-z0-9_\p{L}\p{N}]*/uy;
const JS_IDENT = /[A-Za-z_$\p{L}][A-Za-z0-9_$\p{L}\p{N}]*/uy;
const IDENT_ONLY = /^[A-Za-z_$\p{L}][A-Za-z0-9_$\p{L}\p{N}]*$/u;

function fail(error: string): CallCheck {
  return { ok: false, callee: '', args: [], error };
}

function sticky(re: RegExp, text: string, pos: number): string | undefined {
  re.lastIndex = pos;
  return re.exec(text)?.[0];
}

/**
 * Parse exactly one call `name(arg, ...)` whose arguments are literals: numbers (with unary minus),
 * strings, booleans, None/null/undefined, lists, tuples, dicts/objects of literals; Python also
 * name=literal keyword arguments. Variables, attribute access, nested or chained calls, operators,
 * comprehensions, lambdas, spreads and anything after the closing parenthesis are rejected.
 */
export function parseCall(text: string, lang: Lang): CallCheck {
  const py = lang === 'python';
  if (text.length > MAX_CALL_CHARS) return fail('call is too long');
  let pos = 0;
  const ws = (newlines: boolean): void => {
    while (pos < text.length && (newlines ? /\s/ : /[ \t]/).test(text[pos])) pos++;
  };
  ws(true);
  const callee = sticky(py ? PY_IDENT : JS_IDENT, text, pos);
  if (callee === undefined) return fail('expected a function name');
  if ((py ? PY_KEYWORDS : JS_KEYWORDS).has(callee)) return fail(`'${callee}' is a keyword, not a function`);
  pos += callee.length;
  ws(false);
  const c = text[pos];
  if (c === '.') return fail('attribute access is not allowed');
  if (c !== '(') return fail(c === undefined ? 'expected a call' : `expected '(' after ${callee}`);
  pos++;

  const args: CallArg[] = [];
  const names = new Set<string>();
  for (;;) {
    ws(true);
    if (text[pos] === ')') {
      pos++;
      break;
    }
    const n = args.length + 1;
    if (text[pos] === '*' || text.startsWith('...', pos)) return fail(`argument ${n}: unpacking is not allowed`);
    let name: string | undefined;
    const ident = sticky(py ? PY_IDENT : JS_IDENT, text, pos);
    if (ident !== undefined) {
      let after = pos + ident.length;
      while (/[ \t]/.test(text[after] ?? '')) after++;
      // name=literal, but not == or an arrow function's =>.
      if (text[after] === '=' && text[after + 1] !== '=' && text[after + 1] !== '>') {
        if (!py) return fail(`argument ${n}: assignment is not allowed`);
        if (PY_KEYWORDS.has(ident)) return fail(`argument ${n}: '${ident}' is a keyword`);
        if (names.has(ident)) return fail(`argument ${n}: repeated keyword '${ident}'`);
        names.add(ident);
        name = ident;
        pos = after + 1;
        ws(true);
      }
    }
    if (!name && names.size) return fail(`argument ${n}: positional argument after keyword argument`);
    const start = pos;
    let parsed: { node: LitNode; end: number };
    try {
      parsed = parseLiteralAt(text, pos, lang, 'source');
    } catch (e) {
      const why = e instanceof LiteralError ? e.message : String(e);
      return fail(`argument ${n} is not a literal: ${why}`);
    }
    pos = parsed.end;
    args.push({ name, text: text.slice(start, pos), val: parsed.node.val, node: parsed.node });
    ws(true);
    if (text[pos] === ',') {
      pos++;
      continue;
    }
    if (text[pos] === ')') {
      pos++;
      break;
    }
    return fail(pos >= text.length ? "missing ')'" : `argument ${n} is not a literal: unexpected '${text[pos]}' (at ${pos})`);
  }

  ws(true);
  // JS statements may end with one semicolon; nothing else may follow the call.
  if (!py && text[pos] === ';') {
    pos++;
    ws(true);
  }
  if (pos < text.length) return fail(`only one call is allowed: unexpected '${text.slice(pos, pos + 20)}'`);
  const call = `${callee}(${args.map((a) => (a.name ? a.name + '=' : '') + a.text).join(', ')})`;
  return { ok: true, callee, args, call };
}

/** parseCall plus: the callee must be one of the interface's function names. */
export function validateCall(text: string, lang: Lang, allowedFunctionNames: readonly string[]): CallCheck {
  const r = parseCall(text, lang);
  if (!r.ok) return r;
  if (!allowedFunctionNames.includes(r.callee)) {
    return { ok: false, callee: r.callee, args: r.args, error: `'${r.callee}' is not one of: ${allowedFunctionNames.join(', ') || '(none)'}` };
  }
  return r;
}

/** Same arguments: positional in order, keyword arguments by name in any order, values strictly equal. */
export function sameArgs(a: CallArg[], b: CallArg[]): boolean {
  if (a.length !== b.length) return false;
  const kw = (args: CallArg[]): Map<string, Val> => new Map(args.filter((x) => x.name).map((x) => [x.name!, x.val]));
  const pa = a.filter((x) => !x.name);
  const pb = b.filter((x) => !x.name);
  if (pa.length !== pb.length || !pa.every((x, i) => valEquals(x.val, pb[i].val))) return false;
  const ka = kw(a);
  const kb = kw(b);
  return ka.size === kb.size && [...ka].every(([k, v]) => kb.has(k) && valEquals(v, kb.get(k)!));
}

/** Replace the callee, e.g. to the learner's own function name (spec V1-11 interface mapping). */
export function renameCallee(call: string, newName: string): string {
  if (!IDENT_ONLY.test(newName)) throw new Error(`not a function name: ${newName}`);
  const m = /^(\s*)([A-Za-z_$\p{L}][A-Za-z0-9_$\p{L}\p{N}]*)/u.exec(call);
  if (!m) return call;
  return m[1] + newName + call.slice(m[0].length);
}

type Mutation = { text: string; depth: number; rank: number };

// Order: whole arguments before elements inside them; then empty inputs (the most telling edge
// case), index boundaries, 0, -1, duplicates.
const EMPTY = 0;
const BOUNDARY = 1;
const ZERO = 2;
const MINUS_ONE = 3;
const DUPLICATE = 4;

/**
 * Single-literal mutations of a spec call, as call strings (spec V1-12 probe inputs (1)):
 * a non-empty list, tuple or string becomes empty; an int becomes 0, -1, or (for top-level int
 * arguments) a boundary len - 1 or len of a top-level sequence argument; a list or tuple gets its
 * first element appended again. Each result differs from the original in exactly one literal and
 * has different argument values. Returns [] for a call that does not parse.
 */
export function mutateLiteral(callText: string, lang: Lang): string[] {
  const first = parseCall(callText, lang);
  if (!first.ok) return [];
  // Work on the canonical text so spans and output share one spelling.
  const call = first.call!;
  const parsed = parseCall(call, lang);
  if (!parsed.ok) return [];
  const py = lang === 'python';
  const found: Mutation[] = [];
  const replace = (node: LitNode, depth: number, text: string, rank: number): void => {
    found.push({ text: call.slice(0, node.start) + text + call.slice(node.end), depth, rank });
  };

  // Lengths of top-level sequence arguments: int arguments next to them are often indexes or counts.
  const bounds = new Set<number>();
  for (const a of parsed.args) {
    const len = seqLength(a.val, py);
    if (len !== undefined && len > 0) {
      bounds.add(len - 1);
      bounds.add(len);
    }
  }

  const walk = (node: LitNode, depth: number): void => {
    const v = node.val;
    switch (v.t) {
      case 'list':
      case 'tuple': {
        const items = node.items ?? [];
        if (items.length) {
          replace(node, depth, v.t === 'tuple' ? '()' : '[]', EMPTY);
          const parts = items.map((n) => call.slice(n.start, n.end));
          const [open, close] = v.t === 'tuple' ? ['(', ')'] : ['[', ']'];
          replace(node, depth, open + [...parts, parts[0]].join(', ') + close, DUPLICATE);
        }
        for (const item of items) walk(item, depth + 1);
        break;
      }
      case 'dict':
        for (const [, value] of node.entries ?? []) walk(value, depth + 1);
        break;
      case 'str':
        if (v.v.length) replace(node, depth, "''", EMPTY);
        break;
      case 'bytes':
        if (v.v.length) replace(node, depth, "b''", EMPTY);
        break;
      case 'int':
      case 'bigint':
      case 'num': {
        const cur = intOf(v);
        if (cur === undefined) break;
        const suffix = v.t === 'bigint' ? 'n' : '';
        const targets: [bigint, number][] = [[0n, ZERO], [-1n, MINUS_ONE]];
        if (depth === 0) for (const b of bounds) targets.push([BigInt(b), BOUNDARY]);
        for (const [t, rank] of targets) if (t !== cur) replace(node, depth, t.toString() + suffix, rank);
        break;
      }
    }
  };
  for (const a of parsed.args) walk(a.node, 0);

  const out: string[] = [];
  const seen = new Set<string>([call]);
  for (const m of found.sort((a, b) => a.depth - b.depth || a.rank - b.rank)) {
    if (seen.has(m.text)) continue;
    seen.add(m.text);
    const check = parseCall(m.text, lang);
    if (check.ok && !sameArgs(check.args, parsed.args)) out.push(m.text);
  }
  return out;
}

function seqLength(v: Val, py: boolean): number | undefined {
  switch (v.t) {
    case 'list':
    case 'tuple':
      return v.v.length;
    case 'str':
      // len() counts code points in Python, UTF-16 units in JS.
      return py ? Array.from(v.v).length : v.v.length;
    case 'bytes':
      return v.v.length;
    default:
      return undefined;
  }
}

function intOf(v: Val): bigint | undefined {
  if (v.t === 'int' || v.t === 'bigint') return BigInt(v.v);
  if (v.t === 'num' && typeof v.v === 'number' && Number.isSafeInteger(v.v) && !Object.is(v.v, -0)) return BigInt(v.v);
  return undefined;
}
