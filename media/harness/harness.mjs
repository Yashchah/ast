// Deliberate behaviour-spec harness (Node), spec V1-11.
//
// usage: node [--permission ...] harness.mjs <module file> <spec json>
//
// <spec json> (written by src/specsCore.ts buildHarnessInput):
//   {"workspace"?, "timeoutMs"?, "functions"?: [name], "specs": [{"id", "call", "expected", "expectError", "signatures"?}]}
// stdout protocol, one line each, written synchronously (src/specsCore.ts parseHarnessOutput):
//   @@DLB_PLAN ["id", ...]                  before the import
//   @@DLB_LOAD {"importMs", "loadError"?}   after it; any loadError but 'not-exported' ends the run
//   @@DLB_START <id>                        before each spec
//   @@DLB {"id", "pass", "status", "actual"?, "error"?, "exception"?, "line"?, "sig"?, "stdout"?, "val"?}
//   @@DLB_END {"timedOut"?}
//
// Module safety: before anything is imported, the file's top level (and that of every relative
// module it imports) may hold only imports, exports, declarations, function and class definitions,
// main-guarded entry code and const/let initialisers that call nothing but new Map/Set/RegExp/
// Array/Object, Object.freeze and Symbol. Anything else is reported as 'unsafe-top-level' and
// never imported. Calls are parsed as literals (never evaluated) and expected values with
// JSON.parse; a synchronous call runs under a vm timeout, a returned promise gets 2 s at most.
// probe.mjs reuses Session, parseCall and the checker from this file.
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import vm from 'node:vm';
import { Writable } from 'node:stream';
import * as nodeModule from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UNSAFE_NUDGE = 'wrap the entry code in a main guard (if (require.main === module) or, on Node 24.2+, if (import.meta.main))';
export const SANDBOX_MESSAGE = 'your code tried to write a file or start a process while being checked: keep that in the main block';
export const TIMEOUT_TEXT = 'timeout (infinite loop?)';
const DEFAULT_TIMEOUT_MS = 5000;
const MARGIN_MS = 400; // stop on our own this long before the parent kills the process
const PROMISE_CAP_MS = 2000;
const ACTUAL_MAX = 200;
const ERROR_MAX = 300;
const STDOUT_MAX = 300;
const VAL_JSON_MAX = 2000;
const MAX_CHECKED_FILES = 50;
const INSPECT = { breakLength: Infinity, compact: true, depth: 6, maxArrayLength: 50, maxStringLength: 300 };

const realExit = process.exit.bind(process);

// Typed values come from the batch runner's prelude, so probes grade like atoms do.
let prelude;
try {
  prelude = await import(pathToFileURL(path.join(HERE, '..', 'runner', 'prelude.mjs')).href);
} catch {
  const typeName = (x) => (x === null ? 'null' : typeof x !== 'object' ? typeof x : (Object.getPrototypeOf(x)?.constructor?.name ?? 'Object'));
  const safeInspect = (x, limit = 2000) => {
    try {
      return util.inspect(x, INSPECT).slice(0, limit);
    } catch {
      return `<uninspectable ${typeName(x)}>`;
    }
  };
  prelude = { typeName, safeInspect, encodeVal: (x) => ({ t: 'opaque', type: typeName(x), repr: safeInspect(x, 200) }) };
}
export const { typeName, safeInspect, encodeVal } = prelude;

/** Protocol lines are written synchronously, so a kill right after cannot lose them. */
export function emit(tag, payload) {
  const text = payload === undefined ? tag : `${tag} ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`;
  const buf = Buffer.from(text + '\n', 'utf8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(1, buf, off);
    } catch (e) {
      if (e && e.code === 'EAGAIN') continue;
      throw e;
    }
  }
}

export const short = (s, n) => (s.length <= n ? s : s.slice(0, n - 3) + '...');

// =====================================================================================
// Tokenizer (enough JS/TS lexing to see statements, brackets, calls and module specifiers)
// =====================================================================================

const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=',
  '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const NUM = /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y;
const isIdStart = (c) => c !== undefined && (/[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 0x7f);
const isIdPart = (c) => c !== undefined && (/[\w$]/.test(c) || c.charCodeAt(0) > 0x7f);
const LS = String.fromCharCode(0x2028); // line and paragraph separators end lines too
const PS = String.fromCharCode(0x2029);
const BOM = String.fromCharCode(0xfeff);
const isNewline = (c) => c === '\n' || c === '\r' || c === LS || c === PS;

/**
 * Tokens {t: 'id'|'num'|'str'|'tpl'|'re'|'p', v, pos, end, nl (newline before), sp (space before),
 * parts (template ${} token lists)}. Comments are dropped. Positions index into `src`.
 */
export function tokenize(src, start = 0, stopAtBrace = false) {
  const tokens = [];
  const n = src.length;
  let i = start;
  let nl = false;
  let sp = false;
  let depth = 0;
  if (i === 0 && src.startsWith('#!')) {
    const j = src.indexOf('\n');
    i = j < 0 ? n : j;
  }
  while (i < n) {
    const c = src[i];
    if (isNewline(c)) {
      nl = sp = true;
      i++;
      continue;
    }
    if (/\s/.test(c) || c === BOM) {
      sp = true;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && !isNewline(src[i])) i++;
      sp = true;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      if ([...src.slice(i, end)].some(isNewline)) nl = true;
      sp = true;
      i = end;
      continue;
    }
    const tok = { t: 'p', v: c, pos: i, end: i, nl, sp };
    nl = sp = false;
    if (isIdStart(c) || (c === '#' && isIdStart(src[i + 1]))) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      tok.t = 'id';
      tok.v = src.slice(i, j);
      i = j;
    } else if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) {
      NUM.lastIndex = i;
      const m = NUM.exec(src);
      tok.t = 'num';
      tok.v = m ? m[0] : c;
      i += tok.v.length;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && !isNewline(src[j])) j += src[j] === '\\' ? 2 : 1;
      tok.t = 'str';
      tok.v = src.slice(i + 1, Math.min(j, n));
      i = j < n && src[j] === c ? j + 1 : j;
    } else if (c === '`') {
      tok.t = 'tpl';
      tok.parts = [];
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '`') {
          j++;
          break;
        } else if (src[j] === '$' && src[j + 1] === '{') {
          const r = tokenize(src, j + 2, true);
          tok.parts.push(r.tokens);
          j = r.end + 1;
        } else j++;
      }
      i = Math.min(j, n);
    } else if (c === '/' && regexAllowed(tokens[tokens.length - 1])) {
      let j = i + 1;
      let cls = false;
      while (j < n && !isNewline(src[j])) {
        const r = src[j];
        if (r === '\\') {
          j += 2;
          continue;
        }
        if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if (r === '/' && !cls) break;
        j++;
      }
      j++;
      while (j < n && isIdPart(src[j])) j++;
      tok.t = 're';
      tok.v = src.slice(i, Math.min(j, n));
      i = Math.min(j, n);
    } else {
      if (c === '}' && stopAtBrace && depth === 0) return { tokens, end: i };
      if (c === '{') depth++;
      else if (c === '}') depth--;
      let p = PUNCT.find((q) => src.startsWith(q, i)) ?? c;
      if (p === '?.' && /\d/.test(src[i + 2] ?? '')) p = '?'; // a ? .5 : 1
      tok.v = p;
      i += p.length;
    }
    tok.end = i;
    tokens.push(tok);
  }
  return { tokens, end: n };
}

function regexAllowed(prev) {
  if (!prev) return true;
  if (prev.t === 'id') return REGEX_AFTER.has(prev.v);
  if (prev.t !== 'p') return false;
  return !(prev.v === ')' || prev.v === ']' || prev.v === '++' || prev.v === '--');
}

/** Line number (1-based) of a source offset. */
function lineOf(src, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

// =====================================================================================
// Top-level safety check (spec V1-11 MODULE LOADING, V1-12 MODULE SAFETY)
// =====================================================================================

class Unsafe extends Error {
  constructor(tok, why) {
    super(why);
    this.tok = tok;
  }
}

const OPEN = { '(': ')', '[': ']', '{': '}' };
const ALLOWED_NEW = new Set(['Map', 'Set', 'RegExp', 'Array', 'Object']);
const ALLOWED_CALLS = new Set(['Object.freeze', 'Symbol', 'Symbol.for']);
/** Words followed by '(' that do not call anything. */
const NOT_CALLEE = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'void', 'delete', 'in', 'of',
  'instanceof', 'new', 'else', 'do', 'case', 'throw', 'yield', 'await', 'function', 'class', 'extends', 'as', 'satisfies', 'keyof']);
const CONTINUE_AFTER = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=',
  ',', '(', '[', '{', '.', '?.', '=>', ':', '?', '+', '-', '*', '/', '%', '**', '&&', '||', '??', '&', '|', '^', '<<', '>>', '>>>',
  '<', '>', '<=', '>=', '==', '===', '!=', '!==', '!', '~', '...']);
const CONTINUE_WORDS_AFTER = new Set(['new', 'typeof', 'void', 'delete', 'in', 'instanceof', 'of', 'await', 'extends', 'as', 'satisfies', 'keyof']);
const CONTINUE_BEFORE = new Set(['.', '?.', ',', '?', ':', '=>', '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=',
  '^=', '&&=', '||=', '??=', '*', '/', '%', '**', '&&', '||', '??', '&', '|', '^', '<<', '>>', '>>>', '<', '>', '<=', '>=', '==', '===',
  '!=', '!==', '(', '[', '+', '-']);
const CLASS_MODIFIERS = new Set(['static', 'public', 'private', 'protected', 'readonly', 'abstract', 'override', 'declare', 'accessor', 'async', 'get', 'set']);
const TYPE_PREFIX = new Set(['keyof', 'typeof', 'readonly', 'unique', 'infer', 'asserts', 'new']);

class Checker {
  constructor(tokens, src) {
    this.tk = tokens;
    this.src = src;
    this.match = new Array(tokens.length).fill(-1);
    const stack = [];
    tokens.forEach((t, i) => {
      if (t.t !== 'p') return;
      if (OPEN[t.v]) stack.push(i);
      else if (t.v === ')' || t.v === ']' || t.v === '}') {
        const o = stack.pop();
        if (o === undefined || OPEN[tokens[o].v] !== t.v) throw new Unsafe(t, 'unbalanced brackets');
        this.match[o] = i;
        this.match[i] = o;
      }
    });
    if (stack.length) throw new Unsafe(tokens[stack[stack.length - 1]], 'unbalanced brackets');
  }

  is(i, v) {
    const t = this.tk[i];
    return t !== undefined && (t.t === 'p' || t.t === 'id') && t.v === v;
  }

  id(i) {
    const t = this.tk[i];
    return t !== undefined && t.t === 'id';
  }

  fail(i, why) {
    throw new Unsafe(this.tk[Math.min(i, this.tk.length - 1)], why);
  }

  // ---------------------------------------------------------------- statements

  statements(i, end) {
    while (i < end) i = this.statement(i, end);
  }

  /** Checks one top-level statement; returns the index after it. */
  statement(i, end) {
    const t = this.tk[i];
    if (t.t === 'p') {
      if (t.v === ';') return i + 1;
      if (t.v === '{') {
        this.statements(i + 1, this.match[i]);
        return this.match[i] + 1;
      }
      if (t.v === '@') this.fail(i, 'a decorator runs on import');
      this.unsafeStatement(i, end);
    }
    if (t.t === 'str' && (this.is(i + 1, ';') || i + 1 >= end || this.tk[i + 1].nl)) return this.semi(i + 1); // 'use strict'
    if (t.t !== 'id') this.unsafeStatement(i, end);
    const next = this.tk[i + 1];
    switch (t.v) {
      case 'import':
        if (this.is(i + 1, '(') || this.is(i + 1, '.')) break;
        return this.semi(this.importDecl(i, end));
      case 'export':
        return this.semi(this.exportDecl(i, end));
      case 'function':
        return this.semi(this.skipFunction(i));
      case 'async':
        if (this.is(i + 1, 'function') && !next.nl) return this.semi(this.skipFunction(i + 1));
        break;
      case 'class':
        return this.semi(this.checkClass(i));
      case 'abstract':
        if (this.is(i + 1, 'class')) return this.semi(this.checkClass(i + 1));
        break;
      case 'const':
        if (this.is(i + 1, 'enum')) return this.semi(this.enumDecl(i + 1));
        return this.semi(this.varDecl(i, end));
      case 'let':
      case 'var':
        if (this.id(i + 1) || this.is(i + 1, '{') || this.is(i + 1, '[')) return this.semi(this.varDecl(i, end));
        break;
      case 'type':
        if (this.id(i + 1) && !next.nl) return this.semi(this.exprEnd(i + 1, end, false));
        break;
      case 'interface':
        if (this.id(i + 1)) return this.semi(this.skipToBody(i + 1, end));
        break;
      case 'enum':
        if (this.id(i + 1)) return this.semi(this.enumDecl(i));
        break;
      case 'declare':
        return this.semi(this.exprEnd(i + 1, end, false)); // types only: no runtime code
      case 'namespace':
      case 'module':
        if ((this.id(i + 1) || this.tk[i + 1]?.t === 'str') && !next.nl) {
          let j = i + 2;
          while (this.is(j, '.') && this.id(j + 1)) j += 2;
          if (this.is(j, '{')) {
            this.statements(j + 1, this.match[j]);
            return this.match[j] + 1;
          }
        }
        if (t.v === 'module') return this.semi(this.cjsExport(i, end));
        break;
      case 'exports':
        return this.semi(this.cjsExport(i, end));
      case 'if':
        return this.ifStatement(i, end);
    }
    this.unsafeStatement(i, end);
  }

  /** Fails with the most specific reason: the call inside the statement if there is one. */
  unsafeStatement(i, end) {
    this.checkRange(i, this.exprEnd(i, end, false));
    this.fail(i, 'code that runs on import');
  }

  semi(i) {
    return this.is(i, ';') ? i + 1 : i;
  }

  importDecl(i, end) {
    // TS: import x = require('y') / import x = A.B
    if (this.id(i + 1) && this.is(i + 2, '=')) {
      const e = this.exprEnd(i + 3, end, false);
      this.checkRange(i + 3, e);
      return e;
    }
    let j = i + 1;
    if (this.tk[j]?.t === 'str') return this.attributes(j + 1);
    while (j < end) {
      const t = this.tk[j];
      if (t.t === 'id' && t.v === 'from' && this.tk[j + 1]?.t === 'str') return this.attributes(j + 2);
      if (t.t === 'p' && OPEN[t.v]) j = this.match[j] + 1;
      else if (t.t === 'p' && t.v === ';') break;
      else j++;
    }
    this.fail(i, 'an unreadable import');
  }

  /** `with { type: 'json' }` / `assert {...}` after a module specifier. */
  attributes(j) {
    if ((this.is(j, 'with') || this.is(j, 'assert')) && this.is(j + 1, '{') && !this.tk[j].nl) return this.match[j + 1] + 1;
    return j;
  }

  exportDecl(i, end) {
    const n = this.tk[i + 1];
    if (!n) this.fail(i, 'an unreadable export');
    if (n.v === 'default') {
      const d = i + 2;
      if (this.is(d, 'function')) return this.skipFunction(d);
      if (this.is(d, 'async') && this.is(d + 1, 'function')) return this.skipFunction(d + 1);
      if (this.is(d, 'class')) return this.checkClass(d);
      if (this.is(d, 'abstract') && this.is(d + 1, 'class')) return this.checkClass(d + 1);
      if (this.is(d, 'interface')) return this.skipToBody(d + 1, end);
      const e = this.exprEnd(d, end, false);
      this.checkRange(d, e);
      return e;
    }
    if (n.v === '{') {
      const j = this.match[i + 1] + 1;
      return this.is(j, 'from') && this.tk[j + 1]?.t === 'str' ? this.attributes(j + 2) : j;
    }
    if (n.v === '*') {
      let j = i + 2;
      if (this.is(j, 'as')) j += 2;
      if (this.is(j, 'from') && this.tk[j + 1]?.t === 'str') return this.attributes(j + 2);
      this.fail(i, 'an unreadable export');
    }
    if (n.v === 'type' && this.is(i + 2, '{')) {
      const j = this.match[i + 2] + 1;
      return this.is(j, 'from') && this.tk[j + 1]?.t === 'str' ? this.attributes(j + 2) : j;
    }
    if (n.v === '=') {
      const e = this.exprEnd(i + 2, end, false);
      this.checkRange(i + 2, e);
      return e;
    }
    if (n.v === 'as' && this.is(i + 2, 'namespace')) return i + 4;
    if (n.v === 'import') return this.exprEnd(i + 2, end, false);
    if (n.t === 'id' && ['function', 'async', 'class', 'abstract', 'const', 'let', 'var', 'type', 'interface', 'enum', 'declare', 'namespace', 'module'].includes(n.v)) {
      return this.statement(i + 1, end);
    }
    this.fail(i, 'an unreadable export');
  }

  /** const/let/var: destructuring defaults and initialisers are checked. */
  varDecl(i, end) {
    let j = i + 1;
    for (;;) {
      if (this.is(j, '{') || this.is(j, '[')) {
        this.checkRange(j + 1, this.match[j]);
        j = this.match[j] + 1;
      } else if (this.id(j)) j++;
      else this.fail(j, 'an unreadable declaration');
      if (this.is(j, '!')) j++;
      if (this.is(j, ':')) j = this.skipType(j + 1);
      if (this.is(j, '=')) {
        const e = this.exprEnd(j + 1, end, true);
        this.checkRange(j + 1, e);
        j = e;
      }
      if (this.is(j, ',')) {
        j++;
        continue;
      }
      return j;
    }
  }

  enumDecl(i) {
    let j = i + 1;
    if (this.id(j)) j++;
    if (!this.is(j, '{')) this.fail(i, 'an unreadable enum');
    this.checkRange(j + 1, this.match[j]);
    return this.match[j] + 1;
  }

  /** interface X<T> extends Y { ... } */
  skipToBody(i, end) {
    let j = i;
    while (j < end && !this.is(j, '{')) j++;
    return j < end ? this.match[j] + 1 : j;
  }

  /** module.exports = ... / module.exports.x = ... / exports.x = ... (CommonJS exports). */
  cjsExport(i, end) {
    let j = i + 1;
    if (this.tk[i].v === 'module') {
      if (!(this.is(j, '.') && this.is(j + 1, 'exports'))) this.fail(i, 'code that runs on import');
      j += 2;
    }
    let steps = 0;
    for (;;) {
      if (this.is(j, '.') && this.id(j + 1)) j += 2;
      else if (this.is(j, '[') && this.tk[j + 1]?.t === 'str' && this.match[j] === j + 2) j += 3;
      else break;
      steps++;
    }
    if (this.tk[i].v === 'exports' && steps === 0) this.fail(i, 'code that runs on import');
    if (!this.is(j, '=')) this.fail(i, 'code that runs on import');
    const e = this.exprEnd(j + 1, end, false);
    this.checkRange(j + 1, e);
    return e;
  }

  /** if (main guard) {...}: the guarded branch never runs on import, so it is not checked. */
  ifStatement(i, end) {
    if (!this.is(i + 1, '(')) this.fail(i, 'code that runs on import');
    const close = this.match[i + 1];
    const guard = this.mainGuard(i + 2, close);
    if (guard === 0) this.checkRange(i + 2, close);
    let j = close + 1;
    j = guard === 1 ? this.skipStatement(j, end) : this.statement(j, end);
    if (this.is(j, 'else')) j = guard === -1 ? this.skipStatement(j + 1, end) : this.statement(j + 1, end);
    return j;
  }

  /** 1: the test is true only when run as a program; -1: only when imported; 0: neither. */
  mainGuard(a, b) {
    if (a >= b) return 0;
    const text = this.src.slice(this.tk[a].pos, this.tk[b - 1].end).replace(/\s+/g, '');
    const conj = splitTop(text, '&&');
    if (conj.length > 1 && !text.includes('||')) {
      const kinds = conj.map(guardKind);
      if (kinds.includes(1) && conj.every((c, k) => kinds[k] === 1 || !/[\w$\])]\(/.test(c))) return 1;
      return 0;
    }
    return guardKind(text);
  }

  skipStatement(i, end) {
    if (this.is(i, '{')) return this.match[i] + 1;
    if (this.is(i, 'if') && this.is(i + 1, '(')) {
      let j = this.skipStatement(this.match[i + 1] + 1, end);
      if (this.is(j, 'else')) j = this.skipStatement(j + 1, end);
      return j;
    }
    return this.semi(this.exprEnd(i, end, false));
  }

  // ---------------------------------------------------------------- expressions

  /**
   * End of the expression starting at i (exclusive): a ';', a closing bracket, a ',' when
   * stopAtComma, or a line break where JavaScript would insert a semicolon.
   */
  exprEnd(i, end, stopAtComma) {
    let k = i;
    while (k < end) {
      const t = this.tk[k];
      if (k > i && t.nl && !continues(this.tk[k - 1], t)) return k;
      if (t.t === 'p') {
        if (OPEN[t.v]) {
          k = this.match[k] + 1;
          continue;
        }
        if (t.v === ')' || t.v === ']' || t.v === '}' || t.v === ';' || (stopAtComma && t.v === ',')) return k;
        if (t.v === '<') {
          // TypeScript type arguments (new Map<string, number>(), <T,>(x: T) => x): their commas do not end anything
          const j = this.skipAngles(k);
          if (j < end && this.is(j, '(')) {
            k = j;
            continue;
          }
        }
      }
      k++;
    }
    return end;
  }

  /** Everything in [i, end) must be free of calls, except the allowed constructors and functions. */
  checkRange(i, end) {
    let k = i;
    while (k < end) {
      const t = this.tk[k];
      const prev = k > 0 ? this.tk[k - 1] : undefined;
      if (t.t === 'tpl') {
        if (prev && callable(prev)) this.fail(k, 'a tagged template runs on import');
        for (const part of t.parts) {
          const sub = new Checker(part, this.src);
          sub.checkRange(0, part.length);
        }
        k++;
        continue;
      }
      if (t.t === 'id') {
        if (prev && (prev.v === '.' || prev.v === '?.') && prev.t === 'p') {
          k++; // a property name, not a keyword
          continue;
        }
        switch (t.v) {
          case 'await':
            this.fail(k, 'top-level await runs on import');
            break;
          case 'yield':
            this.fail(k, 'code that runs on import');
            break;
          case 'import':
            if (this.is(k + 1, '(')) this.fail(k, 'a dynamic import runs on import');
            break;
          case 'function':
            k = this.skipFunction(k);
            continue;
          case 'class':
            k = this.checkClass(k);
            continue;
          case 'new':
            k = this.checkNew(k);
            continue;
          case 'require':
            if (this.is(k + 1, '(') && this.tk[k + 2]?.t === 'str' && this.match[k + 1] === k + 3) {
              k += 4; // require('x'): a CommonJS import
              continue;
            }
            break;
        }
        k++;
        continue;
      }
      if (t.t !== 'p') {
        k++;
        continue;
      }
      if (t.v === '(') {
        const close = this.match[k];
        const fn = this.functionAfter(close, end);
        if (fn !== undefined) {
          k = fn; // arrow parameters or a method: defaults and bodies run later, not on import
          continue;
        }
        if (prev && (callable(prev) || (prev.t === 'p' && prev.v === '>' && !t.sp))) {
          const callee = this.calleeBefore(k);
          if (!ALLOWED_CALLS.has(callee)) this.fail(k - 1, callee ? `${callee}() runs on import` : 'a call runs on import');
        }
        k++;
        continue;
      }
      if (t.v === '?.' && this.is(k + 1, '(')) this.fail(k, 'a call runs on import');
      if (t.v === '=>') {
        k = this.is(k + 1, '{') ? this.match[k + 1] + 1 : this.exprEnd(k + 1, end, true);
        continue;
      }
      if (t.v === '@') this.fail(k, 'a decorator runs on import');
      k++;
    }
  }

  /** For a '(' whose ')' is at `close`: the index after a method body or at an arrow, else undefined. */
  functionAfter(close, end) {
    const after = this.tk[close + 1];
    if (!after || close + 1 >= end) return undefined; // a body outside the range is not this function's
    if (after.v === '=>' && after.t === 'p') return close + 1;
    if (after.v === '{' && after.t === 'p') return this.match[close + 1] + 1;
    if (after.v === ':' && after.t === 'p') {
      const j = this.skipType(close + 2);
      if (this.is(j, '=>')) return j;
      if (this.is(j, '{') && j > close + 2) return this.match[j] + 1;
    }
    return undefined;
  }

  /** 'Object.freeze' for the call whose '(' is at k, or '' when the callee is not a plain name chain. */
  calleeBefore(k) {
    const parts = [];
    let j = k - 1;
    while (j >= 0 && this.id(j)) {
      parts.unshift(this.tk[j].v);
      if (j >= 2 && this.is(j - 1, '.') && this.id(j - 2)) j -= 2;
      else {
        j--;
        break;
      }
    }
    if (j >= 0 && (this.is(j, '.') || this.is(j, '?.'))) return ''; // a call on an expression
    return parts.join('.');
  }

  /** new X(...): only the allowed constructors. Returns the index to continue at (inside the arguments). */
  checkNew(k) {
    if (this.is(k + 1, '.')) return k + 3; // new.target
    let j = k + 1;
    const parts = [];
    while (this.id(j)) {
      parts.push(this.tk[j].v);
      if (this.is(j + 1, '.') && this.id(j + 2)) j += 2;
      else {
        j++;
        break;
      }
    }
    const name = parts.join('.');
    if (!ALLOWED_NEW.has(name)) this.fail(k, name ? `new ${name}() runs on import` : 'new runs on import');
    if (this.is(j, '<')) j = this.skipAngles(j);
    return this.is(j, '(') ? j + 1 : j;
  }

  skipFunction(i) {
    let j = i + 1;
    if (this.is(j, '*')) j++;
    if (this.id(j) && !this.is(j, '(')) j++;
    if (this.is(j, '<')) j = this.skipAngles(j);
    if (!this.is(j, '(')) this.fail(i, 'an unreadable function');
    j = this.match[j] + 1;
    if (this.is(j, ':')) j = this.skipType(j + 1);
    return this.is(j, '{') ? this.match[j] + 1 : j; // TS overloads have no body
  }

  /**
   * class declarations and expressions: the heritage clause, computed keys, static field
   * initialisers and static blocks run when the class is defined, so they are checked.
   */
  checkClass(i) {
    let j = i + 1;
    if (this.id(j) && !['extends', 'implements'].includes(this.tk[j].v)) j++;
    if (this.is(j, '<')) j = this.skipAngles(j);
    if (this.is(j, 'extends')) {
      const start = j + 1;
      j = start;
      while (j < this.tk.length && !this.is(j, '{') && !this.is(j, 'implements')) j = this.is(j, '(') || this.is(j, '[') ? this.match[j] + 1 : j + 1;
      this.checkRange(start, j);
    }
    while (j < this.tk.length && !this.is(j, '{')) j++;
    if (j >= this.tk.length) this.fail(i, 'an unreadable class');
    const close = this.match[j];
    this.checkClassBody(j + 1, close);
    return close + 1;
  }

  checkClassBody(i, close) {
    let k = i;
    while (k < close) {
      if (this.is(k, ';')) {
        k++;
        continue;
      }
      if (this.is(k, '@')) this.fail(k, 'a decorator runs on import');
      let isStatic = false;
      while (this.id(k) && CLASS_MODIFIERS.has(this.tk[k].v)) {
        const nx = this.tk[k + 1];
        if (!nx || nx.nl || (nx.t === 'p' && ['(', '=', ';', ':', '?', '!', '}', '<'].includes(nx.v))) break;
        if (this.tk[k].v === 'static') isStatic = true;
        k++;
      }
      if (isStatic && this.is(k, '{')) this.fail(k, 'a static block runs on import');
      if (this.is(k, '*')) k++;
      if (this.is(k, '[')) {
        this.checkRange(k + 1, this.match[k]); // computed key
        k = this.match[k] + 1;
      } else if (this.id(k) || this.tk[k]?.t === 'str' || this.tk[k]?.t === 'num') k++;
      else this.fail(k, 'an unreadable class member');
      if (this.is(k, '?') || this.is(k, '!')) k++;
      if (this.is(k, '<')) k = this.skipAngles(k);
      if (this.is(k, '(')) {
        k = this.match[k] + 1;
        if (this.is(k, ':')) k = this.skipType(k + 1);
        if (this.is(k, '{')) k = this.match[k] + 1;
        continue;
      }
      if (this.is(k, ':')) k = this.skipType(k + 1);
      if (this.is(k, '=')) {
        const e = this.exprEnd(k + 1, close, false);
        if (isStatic) this.checkRange(k + 1, e); // instance fields run per construction, not on import
        k = e;
      }
    }
  }

  /** Index after a <...> group, counting '>>' and '>>>' as several closers. */
  skipAngles(i) {
    let depth = 0;
    let j = i;
    while (j < this.tk.length) {
      const t = this.tk[j];
      if (t.t === 'p') {
        if (OPEN[t.v]) {
          j = this.match[j] + 1;
          continue;
        }
        if (t.v === '<') depth++;
        else if (t.v === '>') depth--;
        else if (t.v === '>>') depth -= 2;
        else if (t.v === '>>>') depth -= 3;
        else if (t.v === ';' || t.v === ')' || t.v === ']' || t.v === '}') return j;
      }
      j++;
      if (depth <= 0) return j;
    }
    return j;
  }

  /** Index after a TypeScript type starting at i. */
  skipType(i) {
    let j = i;
    for (let guard = 0; guard < 200 && j < this.tk.length; guard++) {
      while (this.is(j, '|') || this.is(j, '&') || (this.id(j) && TYPE_PREFIX.has(this.tk[j].v) && !this.is(j + 1, ':'))) j++;
      const t = this.tk[j];
      if (!t) return j;
      if (t.t === 'p' && t.v === '(') {
        j = this.match[j] + 1;
        if (this.is(j, '=>')) {
          j = this.skipType(j + 1);
          return j;
        }
      } else if (t.t === 'p' && (t.v === '[' || t.v === '{')) j = this.match[j] + 1;
      else if (t.t === 'p' && t.v === '<') {
        j = this.skipAngles(j); // generic function type <T>(x: T) => T
        continue;
      } else if (t.t === 'id' || t.t === 'str' || t.t === 'num' || t.t === 'tpl' || (t.t === 'p' && t.v === '-')) {
        j++;
        while (this.is(j, '.') && this.id(j + 1)) j += 2;
        if (this.is(j, '<') && !this.tk[j].nl) j = this.skipAngles(j);
        if (this.is(j, 'is') && !this.tk[j].nl) {
          j++;
          continue; // x is T
        }
      } else return j;
      while (this.is(j, '[') && !this.tk[j].nl) j = this.match[j] + 1; // T[] / T[K]
      if (this.is(j, '|') || this.is(j, '&')) continue;
      if (this.is(j, 'extends') && !this.tk[j].nl) {
        j++;
        continue; // conditional type: A extends B ? C : D
      }
      if (this.is(j, '?') && this.tk[j - 1] && !this.tk[j].nl && this.isConditional(j)) {
        j++;
        continue;
      }
      return j;
    }
    return j;
  }

  /** A '?' inside a conditional type is followed by a type and ':' (rare enough to approximate). */
  isConditional(j) {
    for (let k = j - 1; k >= 0 && k > j - 40; k--) {
      if (this.is(k, 'extends')) return true;
      if (this.is(k, '=') || this.is(k, ';') || this.is(k, ',')) return false;
    }
    return false;
  }
}

function callable(prev) {
  if (prev.t === 'id') return !NOT_CALLEE.has(prev.v);
  if (prev.t === 'tpl') return true;
  return prev.t === 'p' && (prev.v === ')' || prev.v === ']');
}

function continues(prev, next) {
  if (prev.t === 'p' && CONTINUE_AFTER.has(prev.v)) return true;
  if (prev.t === 'id' && CONTINUE_WORDS_AFTER.has(prev.v)) return true;
  if (next.t === 'tpl') return true;
  if (next.t === 'p' && CONTINUE_BEFORE.has(next.v)) return true;
  return next.t === 'id' && ['in', 'instanceof', 'as', 'satisfies'].includes(next.v);
}

/** Split on `sep` outside parentheses and brackets. */
function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      out.push(text.slice(last, i));
      last = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(text.slice(last));
  return out;
}

/** Main-guard tests, whitespace removed: 1 = true only for the program entry, -1 = negated. */
function guardKind(text) {
  let t = text;
  while (t.startsWith('(') && t.endsWith(')')) t = t.slice(1, -1);
  if (/^(?:require\.main===?module|module===?require\.main)$/.test(t)) return 1;
  if (/^(?:require\.main!==?module|module!==?require\.main)$/.test(t)) return -1;
  if (/^import\.meta\.main(?:===?true)?$/.test(t)) return 1;
  if (/^!import\.meta\.main$/.test(t) || /^import\.meta\.main===?false$/.test(t)) return -1;
  // process.argv[1] compared with this module's own path or URL
  if (/process\.argv\[1\]/.test(t) && /import\.meta\.(?:url|filename|dirname)|__filename/.test(t)) {
    if (/!==?/.test(t)) return -1;
    if (/===?/.test(t)) return 1;
  }
  return 0;
}

/**
 * The first top-level construct that would run code on import, or undefined when the module is
 * safe to import. {line, text, why}.
 */
export function checkTopLevel(src) {
  let tokens;
  try {
    tokens = tokenize(src).tokens;
    const c = new Checker(tokens, src);
    c.statements(0, tokens.length);
    return undefined;
  } catch (e) {
    if (!(e instanceof Unsafe)) throw e;
    const tok = e.tok ?? tokens?.[0];
    const pos = tok ? tok.pos : 0;
    const lineStart = src.lastIndexOf('\n', pos - 1) + 1;
    const lineEnd = src.indexOf('\n', pos);
    const text = src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd).trim();
    return { line: lineOf(src, pos), text: short(text, 80), why: e.message };
  }
}

/**
 * Static module specifier tokens: import/export ... from 'x', import 'x', require('x'), import('x').
 * `req` marks require(), which takes a path rather than a URL.
 */
export function moduleSpecifiers(tokens) {
  const out = [];
  const visit = (list) => {
    list.forEach((t, i) => {
      if (t.t === 'tpl') t.parts.forEach(visit);
      if (t.t !== 'str') return;
      const p = list[i - 1];
      const pp = list[i - 2];
      if (p && p.t === 'id' && (p.v === 'from' || p.v === 'import')) out.push({ tok: t, req: false });
      else if (p && p.v === '(' && pp && pp.t === 'id' && (pp.v === 'require' || pp.v === 'import') && list[i + 1]?.v === ')') {
        out.push({ tok: t, req: pp.v === 'require' });
      }
    });
  };
  visit(tokens);
  return out.sort((a, b) => a.tok.pos - b.tok.pos);
}

/** Names declared at the top level: function, class, const/let/var (simple bindings). */
export function topLevelNames(tokens) {
  const names = new Set();
  let depth = 0;
  tokens.forEach((t, i) => {
    if (t.t === 'p') {
      if (OPEN[t.v]) depth++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') depth--;
      return;
    }
    if (depth !== 0 || t.t !== 'id' || tokens[i - 1]?.v === '.') return;
    let j = i + 1;
    if (t.v === 'function' && tokens[j]?.v === '*') j++;
    if (['function', 'class', 'const', 'let', 'var'].includes(t.v) && tokens[j]?.t === 'id') names.add(tokens[j].v);
  });
  return names;
}

const isRelative = (s) => /^\.\.?(?:[\\/]|$)/.test(s);

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function within(p, dir) {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The local file a relative specifier loads (Node's rules plus the TS .js -> .ts mapping). */
export function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [base];
  const ext = path.extname(base).toLowerCase();
  if (ext === '.js') cands.push(base.slice(0, -3) + '.ts');
  else if (ext === '.mjs') cands.push(base.slice(0, -4) + '.mts');
  else if (ext === '.cjs') cands.push(base.slice(0, -4) + '.cts');
  for (const e of ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json']) cands.push(base + e);
  for (const e of ['index.js', 'index.ts', 'index.mjs']) cands.push(path.join(base, e));
  return cands.find(isFile);
}

/** TypeScript is checked after Node's own type stripping when available (types become blanks). */
function codeOf(src, file) {
  if (!/\.[mc]?tsx?$/i.test(file) || typeof nodeModule.stripTypeScriptTypes !== 'function') return src;
  try {
    return nodeModule.stripTypeScriptTypes(src, { mode: 'strip' });
  } catch {
    return src; // enums, namespaces...: the checker reads TypeScript too
  }
}

/**
 * Checks the module and every workspace module it imports with a relative specifier (they run
 * their top level too). Returns {file, line, text, why} for the first unsafe one.
 */
export function checkModuleTree(file, workspace, source) {
  const queue = [path.resolve(file)];
  const seen = new Set();
  while (queue.length && seen.size < MAX_CHECKED_FILES) {
    const f = queue.shift();
    const key = process.platform === 'win32' ? f.toLowerCase() : f;
    if (seen.has(key)) continue;
    seen.add(key);
    if (/\.json$/i.test(f)) continue;
    let src = f === path.resolve(file) && source != null ? source : undefined;
    if (src === undefined) {
      try {
        src = fs.readFileSync(f, 'utf8');
      } catch {
        continue; // unreadable: its import will fail and report itself
      }
    }
    const code = codeOf(src, f);
    const bad = checkTopLevel(code);
    if (bad) return { file: f, ...bad };
    for (const { tok } of moduleSpecifiers(tokenize(code).tokens)) {
      if (!isRelative(tok.v)) continue;
      const dep = resolveLocal(f, tok.v);
      if (dep && within(dep, workspace)) queue.push(dep);
    }
  }
  return undefined;
}

/** Top-level declarations of `name` (function, class, const/let/var), at any depth for simplicity. */
export function definesName(tokens, name) {
  return tokens.some((t, i) => t.t === 'id' && t.v === name && tokens[i - 1]?.t === 'id' && ['function', 'class', 'const', 'let', 'var'].includes(tokens[i - 1].v))
    || tokens.some((t, i) => t.t === 'id' && t.v === name && tokens[i - 1]?.v === '*' && tokens[i - 2]?.v === 'function');
}

/** CommonJS style: module.exports / exports.x and no import/export declarations. */
export function looksCommonJs(tokens) {
  let cjs = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t !== 'id' || tokens[i - 1]?.v === '.') continue;
    if (t.v === 'export' || (t.v === 'import' && tokens[i + 1]?.v !== '(' && tokens[i + 1]?.v !== '.')) return false;
    if ((t.v === 'module' && tokens[i + 1]?.v === '.' && tokens[i + 2]?.v === 'exports') || (t.v === 'exports' && tokens[i + 1]?.v === '.')) cjs = true;
    if (t.v === 'require' && tokens[i + 1]?.v === '(') cjs = true;
  }
  return cjs;
}

// =====================================================================================
// Call parsing: one call with literal arguments, never evaluated (spec V1-11)
// =====================================================================================

const KEYWORDS = new Set(['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static']);

class CallParser {
  constructor(s) {
    this.s = s;
    this.i = 0;
    this.depth = 0;
  }

  fail(msg) {
    throw new SyntaxError(`${msg} (at ${this.i})`);
  }

  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  ident() {
    if (!isIdStart(this.s[this.i])) return undefined;
    const start = this.i;
    this.i++;
    while (this.i < this.s.length && isIdPart(this.s[this.i])) this.i++;
    return this.s.slice(start, this.i);
  }

  call() {
    this.ws();
    const callee = this.ident();
    if (!callee || KEYWORDS.has(callee)) this.fail('expected a function name');
    this.ws();
    if (this.s[this.i] !== '(') this.fail("expected '('");
    this.i++;
    const args = this.list(')');
    this.ws();
    if (this.s[this.i] === ';') {
      this.i++;
      this.ws();
    }
    if (this.i < this.s.length) this.fail('only one call is allowed');
    return { callee, args };
  }

  list(close) {
    const out = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === close) {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.ws();
      const c = this.s[this.i];
      if (c === ',') this.i++;
      else if (c !== close) this.fail(`expected ',' or '${close}'`);
    }
  }

  value() {
    this.ws();
    if (this.i >= this.s.length) this.fail('expected a value');
    if (++this.depth > 100) this.fail('nested too deeply');
    try {
      return this.inner();
    } finally {
      this.depth--;
    }
  }

  inner() {
    const c = this.s[this.i];
    if (c === '[') {
      this.i++;
      return this.list(']');
    }
    if (c === '{') return this.object();
    if (c === '-' || c === '+') {
      this.i++;
      this.ws();
      if (this.s[this.i] === '-' || this.s[this.i] === '+') this.fail('bad sign');
      const v = this.value();
      if (typeof v === 'number') return c === '-' ? -v : v;
      if (typeof v === 'bigint' && c === '-') return -v;
      this.fail('a sign must be followed by a number');
    }
    if (c === "'" || c === '"' || c === '`') return this.string();
    if (/\d/.test(c) || (c === '.' && /\d/.test(this.s[this.i + 1] ?? ''))) return this.number();
    const word = this.ident();
    switch (word) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
        return null;
      case 'undefined':
        return undefined;
      case 'NaN':
        return NaN;
      case 'Infinity':
        return Infinity;
    }
    this.fail(word ? `'${word}' is not a literal` : `unexpected '${c}'`);
  }

  object() {
    this.i++;
    const obj = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') {
        this.i++;
        return obj;
      }
      let key;
      const c = this.s[this.i];
      if (c === "'" || c === '"') key = this.string();
      else if (/\d/.test(c) || c === '.') key = String(this.number());
      else key = this.ident();
      if (key === undefined) this.fail('expected a key');
      if (key === '__proto__') this.fail('__proto__ keys are not allowed');
      this.ws();
      if (this.s[this.i] !== ':') this.fail("expected ':'");
      this.i++;
      Object.defineProperty(obj, key, { value: this.value(), enumerable: true, writable: true, configurable: true });
      this.ws();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== '}') this.fail("expected ',' or '}'");
    }
  }

  number() {
    const s = this.s;
    let m;
    const at = (re) => {
      re.lastIndex = this.i;
      return re.exec(s);
    };
    let v;
    if ((m = at(/0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*n?|0[oO][0-7](?:_?[0-7])*n?|0[bB][01](?:_?[01])*n?/y))) {
      const d = m[0].replace(/_/g, '');
      v = d.endsWith('n') ? BigInt(d.slice(0, -1)) : Number(d);
    } else if ((m = at(/(?:0|[1-9](?:_?\d)*)n/y))) v = BigInt(m[0].slice(0, -1).replace(/_/g, ''));
    else if ((m = at(/(?:(?:0|[1-9](?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?/y))) v = Number(m[0].replace(/_/g, ''));
    else this.fail('bad number');
    this.i += m[0].length;
    if (/[\w$.]/.test(s[this.i] ?? '')) this.fail('bad number');
    return v;
  }

  string() {
    const s = this.s;
    const q = s[this.i++];
    let out = '';
    for (;;) {
      if (this.i >= s.length) this.fail('unterminated string');
      const c = s[this.i];
      if (c === q) {
        this.i++;
        return out;
      }
      if (q === '`' && c === '$' && s[this.i + 1] === '{') this.fail('template substitutions are not literals');
      if (q !== '`' && (c === '\n' || c === '\r')) this.fail('unterminated string');
      if (c === '\\') {
        out += this.escape();
        continue;
      }
      out += c;
      this.i++;
    }
  }

  escape() {
    const s = this.s;
    const n = s[this.i + 1];
    if (n === undefined) this.fail('unterminated string');
    this.i += 2;
    const hex = (len) => {
      const h = s.slice(this.i, this.i + len);
      if (h.length !== len || !/^[0-9a-fA-F]+$/.test(h)) this.fail('bad escape');
      this.i += len;
      return parseInt(h, 16);
    };
    switch (n) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      case '0':
        if (/\d/.test(s[this.i] ?? '')) this.fail('octal escapes are not supported');
        return '\0';
      case 'x':
        return String.fromCharCode(hex(2));
      case 'u': {
        if (s[this.i] !== '{') return String.fromCharCode(hex(4));
        const close = s.indexOf('}', this.i);
        const h = close < 0 ? '' : s.slice(this.i + 1, close);
        if (!/^[0-9a-fA-F]{1,6}$/.test(h) || parseInt(h, 16) > 0x10ffff) this.fail('bad escape');
        this.i = close + 1;
        return String.fromCodePoint(parseInt(h, 16));
      }
      case '\r':
        if (s[this.i] === '\n') this.i++;
        return '';
      case '\n':
      case LS:
      case PS:
        return '';
    }
    if (/[1-9]/.test(n)) this.fail('octal escapes are not supported');
    return n;
  }
}

/** {callee, args} of one call with literal arguments. Throws SyntaxError on anything else. */
export function parseCall(text) {
  return new CallParser(String(text)).call();
}

// =====================================================================================
// Values and errors
// =====================================================================================

/** util.isDeepStrictEqual, except that 0 and -0 are equal at the top level. */
export function same(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number' && actual === expected) return true;
  return util.isDeepStrictEqual(actual, expected);
}

/** Most specific name first: e.name unless it is the generic 'Error', then the class chain. */
export function errorNames(e) {
  const names = [];
  const add = (n) => {
    if (typeof n === 'string' && n && !names.includes(n)) names.push(n);
  };
  if (e !== null && typeof e === 'object') {
    let own = '';
    try {
      own = typeof e.name === 'string' ? e.name : '';
    } catch {
      // a throwing getter
    }
    if (own && own !== 'Error') add(own);
    try {
      for (let p = Object.getPrototypeOf(e), n = 0; p && n < 20; p = Object.getPrototypeOf(p), n++) {
        const ctor = Object.prototype.hasOwnProperty.call(p, 'constructor') ? p.constructor : undefined;
        if (ctor && ctor.name !== 'Object') add(ctor.name);
      }
    } catch {
      // a proxy
    }
    add(own);
  }
  if (!names.length) add(e === null ? 'null' : typeof e);
  return names;
}

export function describeError(e) {
  const name = errorNames(e)[0];
  let msg = '';
  try {
    msg = e !== null && typeof e === 'object' && 'message' in e ? String(e.message) : safeInspect(e, ERROR_MAX);
  } catch {
    msg = '';
  }
  msg = msg.split('\n')[0];
  return short(msg ? `${name}: ${msg}` : name, ERROR_MAX);
}

/** Innermost stack line inside `file` (path or file: URL form). */
export function errorLine(e, file) {
  let stack = '';
  try {
    stack = e !== null && typeof e === 'object' && typeof e.stack === 'string' ? e.stack : '';
  } catch {
    return undefined;
  }
  const url = pathToFileURL(file).href;
  for (const line of stack.split('\n')) {
    for (const f of [url, file]) {
      const k = line.indexOf(f + ':');
      if (k >= 0) {
        const m = /^:(\d+)(?::\d+)?/.exec(line.slice(k + f.length));
        if (m) return Number(m[1]);
      }
    }
  }
  return undefined;
}

const isSandboxError = (e) => e !== null && typeof e === 'object' && e.code === 'ERR_ACCESS_DENIED';
const isVmTimeout = (e) => e !== null && typeof e === 'object' && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';

class ProcessExit extends Error {
  constructor(code) {
    super(`process.exit(${code ?? ''}) was called`);
    this.name = 'ProcessExit';
  }
}

// =====================================================================================
// Session: one learner module under check
// =====================================================================================

const INVOKE = new vm.Script('globalThis.__deliberateInvoke__()', { filename: 'deliberate-harness.js' });

export class Session {
  /**
   * @param {{file: string, workspace?: string, timeoutMs?: number, functions?: string[], source?: string, copy?: boolean}} o
   * copy: import a temp copy in the cwd (probes: the editor text, a what-if mutant, unexported functions).
   */
  constructor(o) {
    this.file = path.resolve(o.file);
    this.workspace = o.workspace ? path.resolve(o.workspace) : path.dirname(this.file);
    this.functions = o.functions ?? [];
    this.source = o.source;
    this.copy = o.copy ?? o.source != null;
    this.deadline = performance.now() + Math.max(300, (o.timeoutMs || DEFAULT_TIMEOUT_MS) - MARGIN_MS);
    this.stdout = '';
    this.ns = undefined;
    this.tokens = [];
    this.target = this.file; // the file actually imported
    this.expose = undefined; // probe: a top-level function exported from the copy under this name
  }

  remaining() {
    return this.deadline - performance.now();
  }

  /** Runs thunk synchronously under the vm timeout (it stops infinite loops in learner code). */
  runTimed(thunk, ms = this.remaining()) {
    Object.defineProperty(globalThis, '__deliberateInvoke__', { value: thunk, configurable: true, writable: true });
    try {
      return INVOKE.runInThisContext({ timeout: Math.max(1, Math.floor(ms)), displayErrors: false });
    } finally {
      delete globalThis.__deliberateInvoke__;
    }
  }

  takeStdout() {
    const s = this.stdout;
    this.stdout = '';
    return s;
  }

  /** console, process.stdout and process.exit stand-ins for learner code; argv without our arguments. */
  installCapture() {
    const sink = new Writable({
      write: (chunk, _enc, cb) => {
        if (this.stdout.length < STDOUT_MAX) this.stdout += String(chunk).slice(0, STDOUT_MAX - this.stdout.length);
        cb();
      },
    });
    const con = new console.Console({ stdout: sink, stderr: sink, inspectOptions: INSPECT });
    globalThis.console = con;
    process.stdout.write = (chunk, enc, cb) => {
      sink.write(String(chunk));
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    };
    process.exit = (code) => {
      throw new ProcessExit(code);
    };
    process.argv = [process.argv[0], this.file];
    // A rejection or timer error from learner code after a spec returned must not kill the run.
    process.on('unhandledRejection', () => {});
    process.on('uncaughtException', () => {});
  }

  async registerHooks() {
    if (!/\.[mc]?ts$/i.test(this.file)) return;
    try {
      if (typeof nodeModule.registerHooks === 'function') {
        const loader = await import(new URL('./loader.mjs', import.meta.url).href);
        nodeModule.registerHooks({ resolve: loader.resolveSync });
      } else if (typeof nodeModule.register === 'function') {
        nodeModule.register(new URL('./loader.mjs', import.meta.url).href);
      }
    } catch {
      // module.register needs --allow-worker under --permission: '.js' imports of '.ts' files then fail visibly
    }
  }

  /** Probe copy: same basename in the cwd (the run temp dir), relative specifiers made absolute. */
  writeCopy(src, tokens) {
    const ext = path.extname(this.file).toLowerCase();
    const ts = /^\.[mc]?ts$/.test(ext);
    const esm = moduleKind(this.file, tokens) === 'esm';
    const newExt = ts ? (esm ? '.mts' : '.cts') : esm ? '.mjs' : '.cjs';
    const dir = path.dirname(this.file);
    let out = '';
    let last = 0;
    for (const { tok, req } of moduleSpecifiers(tokens)) {
      if (!isRelative(tok.v)) continue;
      const abs = path.resolve(dir, tok.v);
      out += src.slice(last, tok.pos) + JSON.stringify(req ? abs : pathToFileURL(abs).href);
      last = tok.end;
    }
    out += src.slice(last);
    const name = this.expose;
    if (name) out += esm ? `\nexport { ${name} as __deliberateProbe__ };\n` : `\nmodule.exports.__deliberateProbe__ = ${name};\n`;
    const target = path.join(process.cwd(), 'dlb_' + path.basename(this.file, path.extname(this.file)) + newExt);
    fs.writeFileSync(target, out);
    return target;
  }

  /** Import the module. {importMs, loadError?}; a 'not-exported' loadError does not stop the run. */
  async load() {
    let src = this.source;
    if (src == null) {
      try {
        src = fs.readFileSync(this.file, 'utf8');
      } catch (e) {
        return { importMs: 0, loadError: this.importError(e) };
      }
    }
    const code = codeOf(src, this.file);
    this.tokens = tokenize(code).tokens;
    const bad = checkModuleTree(this.file, this.workspace, src);
    if (bad) {
      const loadError = { kind: 'unsafe-top-level', message: UNSAFE_NUDGE, name: bad.text, line: bad.line, why: bad.why };
      if (path.resolve(bad.file) !== this.file) loadError.file = path.relative(this.workspace, bad.file) || bad.file;
      return { importMs: 0, loadError };
    }
    await this.registerHooks();
    this.installCapture();
    if (this.copy) {
      try {
        this.target = this.writeCopy(src, tokenize(src).tokens);
      } catch (e) {
        return { importMs: 0, loadError: this.importError(e) };
      }
    }
    const t0 = performance.now();
    let ns;
    let err;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(TIMEOUT_MARK), Math.max(1, this.remaining()));
    });
    try {
      ns = await Promise.race([import(pathToFileURL(this.target).href), timeout]);
    } catch (e) {
      err = e;
    }
    if (err !== undefined && err !== TIMEOUT_MARK && !isSandboxError(err)) {
      try {
        ns = nodeModule.createRequire(this.target)(this.target); // CommonJS the ESM loader refused
        err = undefined;
      } catch {
        // keep the import() error: it is the one the learner can act on
      }
    }
    clearTimeout(timer);
    const importMs = Math.round((performance.now() - t0) * 10) / 10;
    if (err === TIMEOUT_MARK) {
      return { importMs, loadError: { kind: 'import', message: `importing took longer than ${(importMs / 1000).toFixed(1)} s: is a library slow to load?`, name: 'timeout' } };
    }
    if (err !== undefined) return { importMs, loadError: this.importError(err) };
    this.ns = ns;
    for (const name of this.functions) {
      if (exported(ns, name) === undefined && definesName(this.tokens, name)) {
        return { importMs, loadError: { kind: 'not-exported', message: this.notExported(name), name } };
      }
    }
    return { importMs };
  }

  notExported(name) {
    return looksCommonJs(this.tokens) ? `${name} is defined but not exported: add it to module.exports` : `${name} is defined but not exported: add export`;
  }

  importError(e) {
    if (isSandboxError(e)) return { kind: 'sandbox', message: SANDBOX_MESSAGE, name: String(e.permission || e.code) };
    const err = { kind: 'import', message: describeError(e), name: errorNames(e)[0] };
    const line = errorLine(e, this.target);
    if (line) err.line = line;
    return err;
  }

  /** {fn} or {error, exception}. */
  lookup(name) {
    const v = this.expose === name ? exported(this.ns, '__deliberateProbe__') : exported(this.ns, name);
    if (typeof v === 'function') return { fn: v };
    const base = path.basename(this.file);
    if (v !== undefined) return { error: `TypeError: ${name} in ${base} is not a function`, exception: 'TypeError' };
    if (definesName(this.tokens, name)) return { error: this.notExported(name), exception: 'NotExported' };
    return { error: `ReferenceError: ${name} is not defined in ${base}`, exception: 'ReferenceError' };
  }

  /** {kind: 'value', value} | {kind: 'raised', error} | {kind: 'timeout'}. */
  async invoke(fn, args) {
    if (this.remaining() <= 0) return { kind: 'timeout' };
    let value;
    try {
      value = this.runTimed(() => fn(...args));
    } catch (e) {
      return isVmTimeout(e) ? { kind: 'timeout' } : { kind: 'raised', error: e };
    }
    let thenable = false;
    try {
      thenable = value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
    } catch {
      thenable = false;
    }
    if (!thenable) return { kind: 'value', value };
    const cap = Math.min(PROMISE_CAP_MS, this.remaining());
    if (cap <= 0) return { kind: 'timeout' };
    const r = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ pending: true }), cap);
      Promise.resolve(value).then(
        (v) => {
          clearTimeout(t);
          resolve({ value: v });
        },
        (e) => {
          clearTimeout(t);
          resolve({ error: e, rejected: true });
        },
      );
    });
    if (r.pending) {
      if (this.remaining() <= 0) return { kind: 'timeout' };
      const e = new Error(`the returned Promise did not settle within ${(cap / 1000).toFixed(1)} s`);
      e.name = 'PromiseTimeout';
      return { kind: 'raised', error: e };
    }
    return r.rejected ? { kind: 'raised', error: r.error } : { kind: 'value', value: r.value };
  }
}

const TIMEOUT_MARK = Symbol('deliberate import timeout');

/** An exported binding: the ESM namespace, or a property of the default export (CommonJS module.exports). */
export function exported(ns, name) {
  if (ns === null || ns === undefined) return undefined;
  try {
    if (name in ns && ns[name] !== undefined) return ns[name];
    const d = ns.default;
    if (d !== null && (typeof d === 'object' || typeof d === 'function') && Object.prototype.hasOwnProperty.call(d, name)) return d[name];
    if (typeof d === 'function' && d.name === name) return d; // module.exports = function parseArgs() {...}
  } catch {
    return undefined;
  }
  return undefined;
}

/** 'esm' or 'cjs' for a file: extension, nearest package.json "type", then syntax. */
export function moduleKind(file, tokens) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mjs' || ext === '.mts') return 'esm';
  if (ext === '.cjs' || ext === '.cts') return 'cjs';
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg && pkg.type === 'module') return 'esm';
      if (pkg && pkg.type === 'commonjs') return 'cjs';
      break; // the nearest package.json decides, even without "type"
    } catch {
      // none here, or unreadable under --permission
    }
    if (path.dirname(dir) === dir) break;
  }
  const esmSyntax = tokens.some((t, i) => t.t === 'id' && tokens[i - 1]?.v !== '.' && (t.v === 'export' || (t.v === 'import' && tokens[i + 1]?.v !== '(' && tokens[i + 1]?.v !== '.')));
  return esmSyntax ? 'esm' : 'cjs';
}

// =====================================================================================
// Specs
// =====================================================================================

function inspectValue(v) {
  try {
    return util.inspect(v, INSPECT);
  } catch {
    return `<uninspectable ${typeName(v)}>`;
  }
}

function lastPart(name) {
  return String(name ?? '').trim().split('.').pop();
}

export async function runSpec(session, spec) {
  const rec = { id: String(spec.id), pass: false, status: 'ok' };
  let call;
  try {
    call = parseCall(spec.call ?? '');
  } catch (e) {
    rec.error = `BadCall: ${e.message}`;
    return rec;
  }
  const expectError = String(spec.expectError ?? '').trim();
  let expected;
  if (!expectError) {
    try {
      expected = JSON.parse(String(spec.expected ?? ''));
    } catch {
      rec.error = 'BadExpected: the expected value is not JSON';
      return rec;
    }
  }
  const sigs = Array.isArray(spec.signatures) ? spec.signatures.filter((s) => s && typeof s === 'object') : [];
  const target = session.lookup(call.callee);
  if (!target.fn) {
    rec.error = target.error;
    rec.exception = target.exception;
    return rec;
  }
  session.takeStdout();
  const r = await session.invoke(target.fn, call.args);
  if (r.kind === 'timeout') return { id: rec.id, pass: false, status: 'timeout', error: TIMEOUT_TEXT };
  try {
    // inspect() and deep equality can reach learner code (getters on proxies, toJSON...): same time limit
    session.runTimed(() => (r.kind === 'value' ? describeValue(rec, r.value, expected, expectError, sigs) : describeRaised(session, rec, r.error, expectError, sigs)));
  } catch (e) {
    if (isVmTimeout(e)) return { id: rec.id, pass: false, status: 'timeout', error: TIMEOUT_TEXT };
    rec.pass = false;
    rec.error = `describing the result failed: ${describeError(e)}`;
  }
  const out = session.takeStdout();
  if (out) rec.stdout = short(out, STDOUT_MAX);
  return rec;
}

function describeValue(rec, value, expected, expectError, sigs) {
  rec.actual = short(inspectValue(value), ACTUAL_MAX);
  if (!expectError) rec.pass = same(value, expected);
  if (!rec.pass) {
    for (let i = 0; i < sigs.length; i++) {
      if (sigs[i].match !== 'equals') continue;
      try {
        if (same(value, JSON.parse(String(sigs[i].value ?? '')))) {
          rec.sig = i;
          break;
        }
      } catch {
        // a signature that is not JSON never matches
      }
    }
  }
  try {
    const val = encodeVal(value);
    if (JSON.stringify(val).length <= VAL_JSON_MAX) rec.val = val;
  } catch {
    // typed values are optional in spec records
  }
}

function describeRaised(session, rec, e, expectError, sigs) {
  if (isSandboxError(e)) {
    rec.exception = 'DeliberateSandbox';
    rec.error = `DeliberateSandbox: ${SANDBOX_MESSAGE}`;
  } else {
    rec.exception = errorNames(e)[0];
    rec.error = describeError(e);
  }
  const line = errorLine(e, session.target);
  if (line) rec.line = line;
  const names = errorNames(e);
  if (expectError) rec.pass = names.includes(lastPart(expectError));
  if (!rec.pass) {
    for (let i = 0; i < sigs.length; i++) {
      if (sigs[i].match === 'error' && names.includes(lastPart(sigs[i].value))) {
        rec.sig = i;
        break;
      }
    }
  }
}

async function main(argv) {
  const [file, specPath] = argv;
  if (!file || !specPath) {
    process.stderr.write('usage: harness.mjs <module file> <spec json>\n');
    return 2;
  }
  const data = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const specs = (Array.isArray(data.specs) ? data.specs : []).filter((s) => s && typeof s === 'object');
  const ids = specs.map((s) => String(s.id).replace(/\s+/g, ' '));
  emit('@@DLB_PLAN', ids);
  let functions = Array.isArray(data.functions) ? data.functions.map(String) : undefined;
  if (!functions) {
    functions = [];
    for (const s of specs) {
      try {
        const { callee } = parseCall(s.call ?? '');
        if (!functions.includes(callee)) functions.push(callee);
      } catch {
        // reported per spec
      }
    }
  }
  const session = new Session({ file, workspace: data.workspace, timeoutMs: data.timeoutMs, functions });
  const { importMs, loadError } = await session.load();
  emit('@@DLB_LOAD', loadError ? { importMs, loadError } : { importMs });
  if (loadError && loadError.kind !== 'not-exported') {
    emit('@@DLB_END', {});
    return 0;
  }
  for (let i = 0; i < specs.length; i++) {
    emit('@@DLB_START', ids[i]);
    const rec = await runSpec(session, specs[i]);
    rec.id = ids[i];
    emit('@@DLB', rec);
    if (rec.status === 'timeout') {
      emit('@@DLB_END', { timedOut: true });
      return 0;
    }
  }
  emit('@@DLB_END', {});
  return 0;
}

function isEntry() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  try {
    const a = fs.realpathSync(process.argv[1] ?? '');
    const b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isEntry()) {
  let code;
  try {
    code = await main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`harness.mjs: ${e && e.stack ? e.stack : String(e)}\n`);
    code = 70;
  }
  realExit(code);
}
