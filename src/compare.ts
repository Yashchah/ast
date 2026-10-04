// Type-aware answer comparison for predict items (spec V1-2 COMPAREOUTPUT, conceptAtom ITEM TYPES
// AND GRADING). Pure: no vscode import.
// - Python answers are parsed as Python literals; JS/TS answers with a JSON5-style parser that also
//   reads util.inspect output (Map(n) {...}, Set(n) {...}). Both are compared with the typed values
//   the batch runner captured, never with re-parsed output text.
// - The same parser reads call arguments for spec and own-code probes (src/calls.ts, 'source' mode).

import type { CompareOptions, Lang, MutantOutput, PrintedArg, RecordedOutput, Val, Verdict } from './contracts';

// =====================================================================================
// Literal parser
// =====================================================================================

/**
 * repr:   what the language prints (Python adds inf/nan/set()/frozenset()/float('inf'); JS adds
 *         Map(n) {...} / Set(n) {...}).
 * loose:  repr plus the other language's True/true and None/null spellings (format-only checks).
 * source: literals as written in code (call arguments): no inf/nan names, no frozenset(), no
 *         Map/Set notation, no JS parentheses, no __proto__ keys. Python set() is allowed.
 */
export type LiteralMode = 'repr' | 'loose' | 'source';

/** A parsed literal with its source span, so callers can rewrite one literal in place. */
export interface LitNode {
  val: Val;
  start: number;
  end: number;
  /** list / tuple / set / frozenset elements. */
  items?: LitNode[];
  /** dict / object / Map entries. */
  entries?: [LitNode, LitNode][];
}

export class LiteralError extends Error {
  constructor(message: string, readonly pos: number) {
    super(message);
    this.name = 'LiteralError';
  }
}

const MAX_DEPTH = 100;

const PY_WORD = /[A-Za-z_\p{L}][A-Za-z0-9_\p{L}\p{N}]*/uy;
const JS_WORD = /[A-Za-z_$\p{L}][A-Za-z0-9_$\p{L}\p{N}]*/uy;
const PY_RADIX = /0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+/y;
const PY_FLOAT = /(?:\d(?:_?\d)*\.(?:\d(?:_?\d)*)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|\d(?:_?\d)*[eE][+-]?\d(?:_?\d)*/y;
const PY_INT = /\d(?:_?\d)*/y;
const JS_RADIX = /0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*n?|0[oO][0-7](?:_?[0-7])*n?|0[bB][01](?:_?[01])*n?/y;
const JS_BIGINT = /(?:0|[1-9](?:_?\d)*)n/y;
const JS_DEC = /(?:(?:0|[1-9](?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?/y;
const PY_FLOAT_TEXT = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

class LitParser {
  pos: number;
  private depth = 0;

  constructor(
    private readonly src: string,
    private readonly py: boolean,
    private readonly mode: LiteralMode,
    start = 0,
  ) {
    this.pos = start;
  }

  private err(msg: string, at = this.pos): LiteralError {
    return new LiteralError(`${msg} (at ${at})`, at);
  }

  ws(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  private match(re: RegExp): string | undefined {
    re.lastIndex = this.pos;
    const m = re.exec(this.src);
    if (!m) return undefined;
    this.pos += m[0].length;
    return m[0];
  }

  private expect(ch: string): void {
    this.ws();
    if (this.src[this.pos] !== ch) throw this.err(`expected '${ch}'`);
    this.pos++;
  }

  value(): LitNode {
    this.ws();
    if (this.pos >= this.src.length) throw this.err('expected a value');
    if (++this.depth > MAX_DEPTH) throw this.err('nested too deeply');
    try {
      return this.py ? this.pyValue() : this.jsValue();
    } finally {
      this.depth--;
    }
  }

  /** Elements up to `close`, positioned just after the opening bracket or a separator. */
  private rest(close: string, items: LitNode[]): LitNode[] {
    for (;;) {
      this.ws();
      if (this.src[this.pos] === close) {
        this.pos++;
        return items;
      }
      items.push(this.value());
      this.ws();
      const c = this.src[this.pos];
      if (c === ',') this.pos++;
      else if (c !== close) throw this.err(`expected ',' or '${close}'`);
    }
  }

  // ---------------------------------------------------------------- Python

  private pyValue(): LitNode {
    const start = this.pos;
    const c = this.src[start];
    if (c === '[') {
      this.pos++;
      const items = this.rest(']', []);
      return { val: { t: 'list', v: items.map((n) => n.val) }, start, end: this.pos, items };
    }
    if (c === '(') return this.pyParen();
    if (c === '{') return this.pyBrace();
    if (c === '-' || c === '+') return this.pyUnary();
    if (c === '"' || c === "'") return this.pyString(start, '');
    if (isDigit(c) || (c === '.' && isDigit(this.src[start + 1]))) return this.pyNumber();
    const word = this.match(PY_WORD);
    if (word === undefined) throw this.err(`unexpected '${c}'`);
    const q = this.src[this.pos];
    if ((q === '"' || q === "'") && /^(?:[rRuUbB]|[bB][rR]|[rR][bB])$/.test(word)) return this.pyString(start, word);
    const lit = (val: Val): LitNode => ({ val, start, end: this.pos });
    switch (word) {
      case 'True':
        return lit({ t: 'bool', v: true });
      case 'False':
        return lit({ t: 'bool', v: false });
      case 'None':
        return lit({ t: 'none' });
      case 'set':
      case 'frozenset':
        return this.pySetCall(start, word);
      case 'true':
      case 'false':
        if (this.mode === 'loose') return lit({ t: 'bool', v: word === 'true' });
        break;
      case 'null':
        if (this.mode === 'loose') return lit({ t: 'none' });
        break;
      case 'inf':
      case 'nan':
        if (this.mode !== 'source') return lit({ t: 'float', v: word });
        break;
      case 'float':
        if (this.mode !== 'source') return this.pyFloatCall(start);
        break;
    }
    throw this.err(`unexpected name '${word}'`, start);
  }

  private pyUnary(): LitNode {
    const start = this.pos;
    const neg = this.src[this.pos++] === '-';
    const inner = this.value().val;
    let val: Val;
    if (inner.t === 'int') val = { t: 'int', v: neg ? negInt(inner.v) : inner.v };
    else if (inner.t === 'float') val = { t: 'float', v: neg ? negFloat(inner.v) : inner.v };
    else throw this.err('a sign must be followed by a number', start);
    return { val, start, end: this.pos };
  }

  private pyNumber(): LitNode {
    const start = this.pos;
    let val: Val;
    let text = this.match(PY_RADIX);
    if (text !== undefined) {
      val = { t: 'int', v: BigInt(text.replace(/_/g, '')).toString() };
    } else if ((text = this.match(PY_FLOAT)) !== undefined) {
      const n = Number(text.replace(/_/g, ''));
      val = { t: 'float', v: n === Infinity ? 'inf' : n };
    } else if ((text = this.match(PY_INT)) !== undefined) {
      const digits = text.replace(/_/g, '');
      if (/^0+[1-9]/.test(digits)) throw this.err('leading zeros are not allowed in an int', start);
      val = { t: 'int', v: BigInt(digits).toString() };
    } else {
      throw this.err('bad number', start);
    }
    const next = this.src[this.pos];
    if (next !== undefined && /[\w.]/.test(next)) {
      throw this.err(next === 'j' || next === 'J' ? 'complex numbers are not supported' : 'bad number', start);
    }
    return { val, start, end: this.pos };
  }

  private pyString(start: number, prefix: string): LitNode {
    const raw = /r/i.test(prefix);
    const bytes = /b/i.test(prefix);
    const src = this.src;
    const q = src[this.pos];
    const triple = src.startsWith(q + q + q, this.pos);
    this.pos += triple ? 3 : 1;
    let out = '';
    for (;;) {
      if (this.pos >= src.length) throw this.err('unterminated string', start);
      const c = src[this.pos];
      if (c === q && (!triple || src.startsWith(q + q + q, this.pos))) {
        this.pos += triple ? 3 : 1;
        break;
      }
      if (c === '\n' && !triple) throw this.err('unterminated string', start);
      if (c === '\\') {
        out += this.pyEscape(raw, bytes);
        continue;
      }
      if (bytes && c.charCodeAt(0) > 0x7f) throw this.err('bytes can only contain ASCII characters');
      out += c;
      this.pos++;
    }
    return { val: bytes ? { t: 'bytes', v: out } : { t: 'str', v: out }, start, end: this.pos };
  }

  private pyEscape(raw: boolean, bytes: boolean): string {
    const src = this.src;
    const n = src[this.pos + 1];
    if (n === undefined) throw this.err('unterminated string');
    this.pos += 2;
    // Raw strings keep the backslash; it only stops the next character from closing the string.
    if (raw) return '\\' + n;
    switch (n) {
      case '\n':
        return '';
      case '\r':
        if (src[this.pos] === '\n') this.pos++;
        return '';
      case '\\':
      case "'":
      case '"':
        return n;
      case 'a':
        return '\x07';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'v':
        return '\v';
      case 'x':
        return String.fromCharCode(this.hex(2, '\\x'));
    }
    if (n >= '0' && n <= '7') {
      let digits = n;
      while (digits.length < 3 && /[0-7]/.test(src[this.pos] ?? '')) digits += src[this.pos++];
      const code = parseInt(digits, 8);
      if (bytes && code > 0xff) throw this.err('octal escape out of range for bytes');
      return String.fromCharCode(code);
    }
    if (!bytes && (n === 'u' || n === 'U')) {
      const code = this.hex(n === 'u' ? 4 : 8, '\\' + n);
      if (code > 0x10ffff) throw this.err('escape out of range');
      return String.fromCodePoint(code);
    }
    if (!bytes && n === 'N') throw this.err('\\N{...} escapes are not supported');
    // Unknown escapes keep their backslash, as Python does.
    return '\\' + n;
  }

  private hex(len: number, what: string): number {
    const h = this.src.slice(this.pos, this.pos + len);
    if (h.length !== len || !/^[0-9a-fA-F]+$/.test(h)) throw this.err(`bad ${what} escape`);
    this.pos += len;
    return parseInt(h, 16);
  }

  private pyParen(): LitNode {
    const start = this.pos++;
    this.ws();
    if (this.src[this.pos] === ')') {
      this.pos++;
      return { val: { t: 'tuple', v: [] }, start, end: this.pos, items: [] };
    }
    const first = this.value();
    this.ws();
    // (x) is just x in parentheses; (x,) is a 1-tuple.
    if (this.src[this.pos] === ')') {
      this.pos++;
      return first;
    }
    if (this.src[this.pos] !== ',') throw this.err("expected ',' or ')'");
    this.pos++;
    const items = this.rest(')', [first]);
    return { val: { t: 'tuple', v: items.map((n) => n.val) }, start, end: this.pos, items };
  }

  private pyBrace(): LitNode {
    const start = this.pos++;
    this.ws();
    if (this.src[this.pos] === '}') {
      this.pos++;
      return { val: { t: 'dict', v: [] }, start, end: this.pos, entries: [] };
    }
    const first = this.value();
    this.ws();
    if (this.src[this.pos] !== ':') {
      if (this.src[this.pos] === ',') this.pos++;
      else if (this.src[this.pos] !== '}') throw this.err("expected ',' or '}'");
      const items = this.rest('}', [first]);
      for (const n of items) this.requireHashable(n);
      return { val: { t: 'set', v: items.map((n) => n.val) }, start, end: this.pos, items };
    }
    this.pos++;
    this.requireHashable(first);
    const entries: [LitNode, LitNode][] = [[first, this.value()]];
    for (;;) {
      this.ws();
      const c = this.src[this.pos];
      if (c === '}') {
        this.pos++;
        break;
      }
      if (c !== ',') throw this.err("expected ',' or '}'");
      this.pos++;
      this.ws();
      if (this.src[this.pos] === '}') {
        this.pos++;
        break;
      }
      const k = this.value();
      this.requireHashable(k);
      this.expect(':');
      entries.push([k, this.value()]);
    }
    return { val: { t: 'dict', v: entries.map(([k, v]) => [k.val, v.val]) }, start, end: this.pos, entries };
  }

  private requireHashable(n: LitNode): void {
    if (!hashable(n.val)) throw this.err(`unhashable ${n.val.t}`, n.start);
  }

  /** set() / set([..]) / frozenset({..}), as Python prints empty sets and frozensets. */
  private pySetCall(start: number, word: 'set' | 'frozenset'): LitNode {
    this.ws();
    if (this.src[this.pos] !== '(') throw this.err(`unexpected name '${word}'`, start);
    if (this.mode === 'source' && word === 'frozenset') throw this.err('frozenset() is a call, not a literal', start);
    this.pos++;
    this.ws();
    let items: LitNode[] = [];
    if (this.src[this.pos] !== ')') {
      if (this.mode === 'source') throw this.err('only an empty set() is allowed', start);
      const arg = this.value();
      if (!['list', 'tuple', 'set', 'frozenset'].includes(arg.val.t)) throw this.err(`${word}() needs a list, tuple or set`, arg.start);
      items = arg.items ?? [];
      this.ws();
      if (this.src[this.pos] === ',') this.pos++;
      this.expect(')');
    } else {
      this.pos++;
    }
    for (const n of items) this.requireHashable(n);
    return { val: { t: word, v: items.map((n) => n.val) }, start, end: this.pos, items };
  }

  /** float('inf') / float('nan') / float('-inf') / float('2.5'). */
  private pyFloatCall(start: number): LitNode {
    this.expect('(');
    const arg = this.value();
    if (arg.val.t !== 'str') throw this.err('float() needs a string here', arg.start);
    this.ws();
    if (this.src[this.pos] === ',') this.pos++;
    this.expect(')');
    const s = arg.val.v.trim().toLowerCase();
    let v: number | 'nan' | 'inf' | '-inf';
    if (/^[+-]?nan$/.test(s)) v = 'nan';
    else if (/^\+?inf(inity)?$/.test(s)) v = 'inf';
    else if (/^-inf(inity)?$/.test(s)) v = '-inf';
    else if (PY_FLOAT_TEXT.test(s)) v = normFloat(Number(s.replace(/_/g, '')));
    else throw this.err('float() of a non-number', arg.start);
    return { val: { t: 'float', v }, start, end: this.pos };
  }

  // ---------------------------------------------------------------- JavaScript

  private jsValue(): LitNode {
    const start = this.pos;
    const c = this.src[start];
    if (c === '[') {
      this.pos++;
      const items = this.rest(']', []);
      return { val: { t: 'list', v: items.map((n) => n.val) }, start, end: this.pos, items };
    }
    if (c === '{') return this.jsObject();
    if (c === '-' || c === '+') return this.jsUnary();
    if (c === "'" || c === '"' || c === '`') {
      const v = this.jsString();
      return { val: { t: 'str', v }, start, end: this.pos };
    }
    if (isDigit(c) || (c === '.' && isDigit(this.src[start + 1]))) return this.jsNumber();
    const word = this.match(JS_WORD);
    if (word === undefined) throw this.err(`unexpected '${c}'`);
    const lit = (val: Val): LitNode => ({ val, start, end: this.pos });
    switch (word) {
      case 'true':
      case 'false':
        return lit({ t: 'bool', v: word === 'true' });
      case 'null':
        return lit({ t: 'null' });
      case 'undefined':
        return lit({ t: 'undefined' });
      case 'NaN':
        return lit({ t: 'num', v: 'NaN' });
      case 'Infinity':
        return lit({ t: 'num', v: 'Infinity' });
      case 'True':
      case 'False':
        if (this.mode === 'loose') return lit({ t: 'bool', v: word === 'True' });
        break;
      case 'None':
        if (this.mode === 'loose') return lit({ t: 'null' });
        break;
      case 'Map':
      case 'Set':
        if (this.mode !== 'source') return this.jsCollection(start, word);
        break;
    }
    throw this.err(`unexpected name '${word}'`, start);
  }

  private jsUnary(): LitNode {
    const start = this.pos;
    const neg = this.src[this.pos++] === '-';
    this.ws();
    // '--1' is a decrement in JS, not a double negation.
    if (this.src[this.pos] === '-' || this.src[this.pos] === '+') throw this.err('bad sign', start);
    const inner = this.value().val;
    let val: Val;
    if (inner.t === 'num') val = neg ? { t: 'num', v: negNum(inner.v) } : inner;
    else if (inner.t === 'bigint' && neg) val = { t: 'bigint', v: negInt(inner.v) };
    else throw this.err('a sign must be followed by a number', start);
    return { val, start, end: this.pos };
  }

  private jsNumber(): LitNode {
    const start = this.pos;
    let val: Val;
    let text = this.match(JS_RADIX);
    if (text !== undefined) {
      const digits = text.replace(/_/g, '');
      val = digits.endsWith('n')
        ? { t: 'bigint', v: BigInt(digits.slice(0, -1)).toString() }
        : { t: 'num', v: Number(digits) };
    } else if ((text = this.match(JS_BIGINT)) !== undefined) {
      val = { t: 'bigint', v: BigInt(text.slice(0, -1).replace(/_/g, '')).toString() };
    } else if ((text = this.match(JS_DEC)) !== undefined) {
      const n = Number(text.replace(/_/g, ''));
      val = { t: 'num', v: n === Infinity ? 'Infinity' : n };
    } else {
      throw this.err('bad number', start);
    }
    const next = this.src[this.pos];
    if (next !== undefined && /[\w$.]/.test(next)) throw this.err('bad number', start);
    return { val, start, end: this.pos };
  }

  private jsString(): string {
    const src = this.src;
    const start = this.pos;
    const q = src[this.pos++];
    let out = '';
    for (;;) {
      if (this.pos >= src.length) throw this.err('unterminated string', start);
      const c = src[this.pos];
      if (c === q) {
        this.pos++;
        return out;
      }
      if (q === '`' && c === '$' && src[this.pos + 1] === '{') throw this.err('template substitutions are not literals');
      if ((c === '\n' || c === '\r') && q !== '`') throw this.err('unterminated string', start);
      if (c === '\\') {
        out += this.jsEscape();
        continue;
      }
      out += c;
      this.pos++;
    }
  }

  private jsEscape(): string {
    const src = this.src;
    const n = src[this.pos + 1];
    if (n === undefined) throw this.err('unterminated string');
    this.pos += 2;
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
        if (isDigit(src[this.pos])) throw this.err('octal escapes are not supported');
        return '\0';
      case 'x':
        return String.fromCharCode(this.hex(2, '\\x'));
      case 'u': {
        if (src[this.pos] !== '{') return String.fromCharCode(this.hex(4, '\\u'));
        const close = src.indexOf('}', this.pos);
        const h = close < 0 ? '' : src.slice(this.pos + 1, close);
        if (!/^[0-9a-fA-F]{1,6}$/.test(h) || parseInt(h, 16) > 0x10ffff) throw this.err('bad \\u{...} escape');
        this.pos = close + 1;
        return String.fromCodePoint(parseInt(h, 16));
      }
      case '\r':
        if (src[this.pos] === '\n') this.pos++;
        return '';
      case '\n':
      case ' ':
      case ' ':
        return '';
    }
    if (n >= '1' && n <= '9') throw this.err('octal escapes are not supported');
    return n;
  }

  private jsObject(): LitNode {
    const start = this.pos++;
    const entries: [LitNode, LitNode][] = [];
    for (;;) {
      this.ws();
      if (this.src[this.pos] === '}') {
        this.pos++;
        break;
      }
      const k = this.jsKey();
      this.expect(':');
      entries.push([k, this.value()]);
      this.ws();
      const c = this.src[this.pos];
      if (c === ',') this.pos++;
      else if (c !== '}') throw this.err("expected ',' or '}'");
    }
    return { val: { t: 'dict', v: entries.map(([k, v]) => [k.val, v.val]) }, start, end: this.pos, entries };
  }

  /** Object keys are always strings in JS: { 1: 'a' } has the key '1'. */
  private jsKey(): LitNode {
    const start = this.pos;
    const c = this.src[start];
    let key: string;
    if (c === "'" || c === '"') {
      key = this.jsString();
    } else if (isDigit(c) || c === '.') {
      const n = this.jsNumber().val;
      key = n.t === 'num' ? numText(n.v) : n.t === 'bigint' ? n.v : '';
    } else {
      const w = this.match(JS_WORD);
      if (w === undefined) throw this.err('expected a key');
      key = w;
    }
    if (this.mode === 'source' && key === '__proto__') throw this.err('__proto__ keys are not allowed', start);
    return { val: { t: 'str', v: key }, start, end: this.pos };
  }

  /** util.inspect's Map(2) { 'a' => 1 } and Set(2) { 1, 2 }; the size is optional and not checked. */
  private jsCollection(start: number, word: 'Map' | 'Set'): LitNode {
    this.ws();
    if (this.src[this.pos] === '(') {
      this.pos++;
      this.ws();
      if (this.match(/\d+/y) === undefined) throw this.err('expected a size');
      this.expect(')');
    }
    this.expect('{');
    if (word === 'Set') {
      const items = this.rest('}', []);
      return { val: { t: 'set', v: items.map((n) => n.val) }, start, end: this.pos, items };
    }
    const entries: [LitNode, LitNode][] = [];
    for (;;) {
      this.ws();
      if (this.src[this.pos] === '}') {
        this.pos++;
        break;
      }
      const k = this.value();
      this.ws();
      if (!this.src.startsWith('=>', this.pos)) throw this.err("expected '=>'");
      this.pos += 2;
      entries.push([k, this.value()]);
      this.ws();
      const c = this.src[this.pos];
      if (c === ',') this.pos++;
      else if (c !== '}') throw this.err("expected ',' or '}'");
    }
    return { val: { t: 'dict', v: entries.map(([k, v]) => [k.val, v.val]) }, start, end: this.pos, entries };
  }
}

function hashable(v: Val): boolean {
  switch (v.t) {
    case 'list':
    case 'dict':
    case 'set':
      return false;
    case 'tuple':
      return v.v.every(hashable);
    default:
      return true;
  }
}

function negInt(v: string): string {
  if (v.startsWith('-')) return v.slice(1);
  return v === '0' ? '0' : '-' + v;
}

function negFloat(v: number | 'nan' | 'inf' | '-inf'): number | 'nan' | 'inf' | '-inf' {
  if (v === 'inf') return '-inf';
  if (v === '-inf') return 'inf';
  if (v === 'nan') return 'nan';
  return -v;
}

type NumV = number | 'NaN' | 'Infinity' | '-Infinity' | '-0';

function negNum(v: NumV): NumV {
  const x = numValue(v);
  if (Number.isNaN(x)) return 'NaN';
  if (x === 0) return Object.is(x, -0) ? 0 : '-0';
  if (x === Infinity) return '-Infinity';
  if (x === -Infinity) return 'Infinity';
  return -x;
}

function numValue(v: NumV): number {
  switch (v) {
    case 'NaN':
      return NaN;
    case 'Infinity':
      return Infinity;
    case '-Infinity':
      return -Infinity;
    case '-0':
      return -0;
    default:
      return v;
  }
}

function normFloat(n: number): number | 'nan' | 'inf' | '-inf' {
  if (Number.isNaN(n)) return 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  return n;
}

/** Parse one literal starting at `pos`; returns the node and the index just after it. */
export function parseLiteralAt(text: string, pos: number, lang: Lang, mode: LiteralMode = 'repr'): { node: LitNode; end: number } {
  const p = new LitParser(text, lang === 'python', mode, pos);
  const node = p.value();
  return { node, end: p.pos };
}

/** Parse text that must be exactly one literal (surrounding whitespace allowed). Throws LiteralError. */
export function parseLiteral(text: string, lang: Lang, mode: LiteralMode = 'repr'): Val {
  const p = new LitParser(text, lang === 'python', mode);
  const node = p.value();
  p.ws();
  if (p.pos < text.length) throw new LiteralError(`unexpected text after the value (at ${p.pos})`, p.pos);
  return node.val;
}

/** A Python literal as repr() prints it or a learner types it. Throws LiteralError on anything else. */
export function parsePyLiteral(text: string, mode: LiteralMode = 'repr'): Val {
  return parseLiteral(text, 'python', mode);
}

/** A JSON5-style JS value, including util.inspect output. Throws LiteralError on anything else. */
export function parseJs5(text: string, mode: LiteralMode = 'repr'): Val {
  return parseLiteral(text, 'javascript', mode);
}

// =====================================================================================
// Value equality
// =====================================================================================

/**
 * strict: types must match (2 vs 2.0, tuple vs list differ). Not strict: tuple and list, None and
 * null are interchangeable (the format-only conversions). Sets and dicts compare order-free as
 * multisets, so a typed {1, 1, 2} never equals a printed {1, 2}.
 */
export function valEquals(a: Val, b: Val, opts: { strict: boolean } = { strict: true }): boolean {
  const strict = opts.strict;
  if (kindOf(a, strict) !== kindOf(b, strict)) return false;
  switch (a.t) {
    case 'int':
    case 'bigint':
      return intKey(a.v) === intKey((b as { v: string }).v);
    case 'float':
      return floatKey(a.v) === floatKey((b as Extract<Val, { t: 'float' }>).v);
    case 'num':
      return numKey(a.v) === numKey((b as Extract<Val, { t: 'num' }>).v);
    case 'str':
    case 'bytes':
      return a.v === (b as { v: string }).v;
    case 'bool':
      return a.v === (b as { v: boolean }).v;
    case 'none':
    case 'null':
    case 'undefined':
      return true;
    case 'list':
    case 'tuple': {
      const bv = (b as { v: Val[] }).v;
      return a.v.length === bv.length && a.v.every((x, i) => valEquals(x, bv[i], opts));
    }
    case 'set':
    case 'frozenset':
      return sameMultiset(a.v, (b as { v: Val[] }).v, (x, y) => valEquals(x, y, opts));
    case 'dict':
      return sameMultiset(a.v, (b as { v: [Val, Val][] }).v, (x, y) => valEquals(x[0], y[0], opts) && valEquals(x[1], y[1], opts));
    case 'opaque': {
      const o = b as Extract<Val, { t: 'opaque' }>;
      return a.type === o.type && a.repr === o.repr;
    }
  }
}

function kindOf(v: Val, strict: boolean): string {
  if (strict) return v.t;
  if (v.t === 'tuple') return 'list';
  if (v.t === 'null') return 'none';
  return v.t;
}

/** Greedy matching is exact here because equality is an equivalence relation. */
function sameMultiset<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): boolean {
  if (a.length !== b.length) return false;
  const used = new Array<boolean>(b.length).fill(false);
  return a.every((x) => {
    const i = b.findIndex((y, j) => !used[j] && eq(x, y));
    if (i < 0) return false;
    used[i] = true;
    return true;
  });
}

function intKey(v: string | number): string {
  try {
    return BigInt(String(v).trim().replace(/^\+/, '')).toString();
  } catch {
    return String(v);
  }
}

function floatKey(v: number | string): string {
  if (typeof v === 'string') return v;
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  return Object.is(v, -0) ? '-0' : String(v);
}

/** The batch runner may send -0 / NaN as strings (JSON cannot carry them) or as numbers. */
function numKey(v: NumV | string): string {
  if (typeof v === 'string') return v === '-0' || v === 'NaN' || v.endsWith('Infinity') ? v : String(Number(v));
  return numText(v);
}

function numText(v: NumV): string {
  if (typeof v === 'string') return v;
  if (Object.is(v, -0)) return '-0';
  return String(v);
}

// =====================================================================================
// Formatting: how each language prints a value (for 'actual: ...' lines and notes)
// =====================================================================================

/**
 * Python: repr(). JS/TS: util.inspect on one line (arrays are never grouped into columns).
 * Strings come back quoted, as they appear inside a container.
 */
export function formatVal(val: Val, lang: Lang): string {
  return lang === 'python' ? pyRepr(val) : jsInspect(val);
}

function pyRepr(val: Val): string {
  switch (val.t) {
    case 'int':
    case 'bigint':
      return intKey(val.v);
    case 'float':
      return pyFloatRepr(val.v);
    case 'num':
      return numText(val.v);
    case 'str':
      return pyStrRepr(val.v, false);
    case 'bytes':
      return 'b' + pyStrRepr(val.v, true);
    case 'bool':
      return val.v ? 'True' : 'False';
    case 'none':
    case 'null':
    case 'undefined':
      return 'None';
    case 'list':
      return '[' + val.v.map(pyRepr).join(', ') + ']';
    case 'tuple':
      return val.v.length === 1 ? '(' + pyRepr(val.v[0]) + ',)' : '(' + val.v.map(pyRepr).join(', ') + ')';
    case 'set':
      return val.v.length ? '{' + val.v.map(pyRepr).join(', ') + '}' : 'set()';
    case 'frozenset':
      return val.v.length ? 'frozenset({' + val.v.map(pyRepr).join(', ') + '})' : 'frozenset()';
    case 'dict':
      return '{' + val.v.map(([k, v]) => pyRepr(k) + ': ' + pyRepr(v)).join(', ') + '}';
    case 'opaque':
      return val.repr;
  }
}

/** Python's float repr: shortest round-trip digits, scientific below 1e-4 and from 1e16. */
export function pyFloatRepr(v: number | 'nan' | 'inf' | '-inf'): string {
  const x = typeof v === 'number' ? v : v === 'nan' ? NaN : v === 'inf' ? Infinity : -Infinity;
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  // toExponential() with no argument gives the shortest digits that round-trip, like Python's repr.
  const [mant, expText] = Math.abs(x).toExponential().split('e');
  const exp = Number(expText);
  const digits = mant.replace('.', '');
  let out: string;
  if (exp < -4 || exp >= 16) {
    out = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  } else if (exp < 0) {
    out = '0.' + '0'.repeat(-exp - 1) + digits;
  } else if (digits.length <= exp + 1) {
    out = digits + '0'.repeat(exp + 1 - digits.length) + '.0';
  } else {
    out = digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
  }
  return (x < 0 ? '-' : '') + out;
}

const PY_NONPRINTABLE = /^[\p{C}\p{Z}]$/u;

function pyStrRepr(s: string, bytes: boolean): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === q || ch === '\\') out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (bytes ? cp < 0x20 || cp >= 0x7f : cp !== 0x20 && PY_NONPRINTABLE.test(ch)) out += pyHexEscape(cp);
    else out += ch;
  }
  return out + q;
}

function pyHexEscape(cp: number): string {
  if (cp < 0x100) return '\\x' + cp.toString(16).padStart(2, '0');
  if (cp < 0x10000) return '\\u' + cp.toString(16).padStart(4, '0');
  return '\\U' + cp.toString(16).padStart(8, '0');
}

function jsInspect(val: Val): string {
  switch (val.t) {
    case 'int':
      return intKey(val.v);
    case 'bigint':
      return intKey(val.v) + 'n';
    case 'float':
      return typeof val.v === 'number' ? numText(val.v) : val.v === 'nan' ? 'NaN' : val.v === 'inf' ? 'Infinity' : '-Infinity';
    case 'num':
      return numKey(val.v);
    case 'str':
    case 'bytes':
      return jsStrQuote(val.v);
    case 'bool':
      return String(val.v);
    case 'none':
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    case 'list':
    case 'tuple':
      return val.v.length ? '[ ' + val.v.map(jsInspect).join(', ') + ' ]' : '[]';
    case 'set':
    case 'frozenset':
      return `Set(${val.v.length}) ` + (val.v.length ? '{ ' + val.v.map(jsInspect).join(', ') + ' }' : '{}');
    case 'dict': {
      if (val.v.every(([k]) => k.t === 'str')) {
        if (!val.v.length) return '{}';
        return '{ ' + val.v.map(([k, v]) => jsKeyText((k as { v: string }).v) + ': ' + jsInspect(v)).join(', ') + ' }';
      }
      return `Map(${val.v.length}) { ` + val.v.map(([k, v]) => jsInspect(k) + ' => ' + jsInspect(v)).join(', ') + ' }';
    }
    case 'opaque':
      return val.repr;
  }
}

function jsKeyText(k: string): string {
  return /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(k) ? k : jsStrQuote(k);
}

const JS_META: Record<number, string> = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' };

/** util.inspect's string quoting: ' by default, then ", then `, else ' with \' escapes. */
function jsStrQuote(s: string): string {
  let q = "'";
  if (s.includes("'")) {
    if (!s.includes('"')) q = '"';
    else if (!s.includes('`') && !s.includes('${')) q = '`';
  }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if (c === q || c === '\\') {
      out += '\\' + c;
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += JS_META[code] ?? '\\x' + code.toString(16).toUpperCase().padStart(2, '0');
    } else if (code >= 0xd800 && code <= 0xdfff) {
      const next = s.charCodeAt(i + 1);
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        out += c + s[++i];
      } else {
        out += '\\u' + code.toString(16);
      }
    } else {
      out += c;
    }
  }
  return q + out + q;
}

// =====================================================================================
// compareOutput
// =====================================================================================

/** CompareOptions plus a flag for comparing return values instead of printed output. */
export interface CompareOpts extends CompareOptions {
  /**
   * The recorded output holds a function's return value (own-code probes, what-ifs): values[0][0]
   * is the value, stdout its repr. Strings are then written as literals ('abc'), and a bare abc
   * is format-only.
   */
  returnValue?: boolean;
}

interface Ctx {
  lang: Lang;
  py: boolean;
  valueMode: boolean;
}

/** One expected answer line (or block): a print call with typed args, a plain text line, or an exception. */
type Unit =
  | { kind: 'call'; args: PrintedArg[]; lines: string[] }
  | { kind: 'text'; text: string; loose: boolean }
  | { kind: 'exc'; name: string };

const NONE = -1;
const WRONG = 0;
const FORMAT = 1;
const CORRECT = 2;

/** The pad's answer markers, in case a caller passes whole answer lines. */
const ANSWER_PREFIX = /^\s*(?:#|\/\/)\s*->\s?/;

/**
 * Grade a predict answer against the recorded output (spec V1-2 COMPAREOUTPUT):
 * - '?' (or an empty answer, which the pad re-prompts before calling) is dont-know.
 * - correct: every line matches the typed value (Python literal / JSON5 parse), a top-level str
 *   matches as text after CRLF and trailing-whitespace normalisation, an exception by its name.
 * - format-only: right value, wrong notation (quotes around a printed str, tuple vs list, missing
 *   outer brackets, True/true, None/null). Wrong under typeSensitive or when a mutant prints exactly
 *   that answer.
 * - wrong: names a mutant only on a strict, unambiguous match that is not a bare 'error' and not a
 *   probable slip (edit distance <= 1 from the actual output).
 */
export function compareOutput(answer: string, recorded: RecordedOutput, lang: Lang, opts: CompareOpts = { typeSensitive: false }): Verdict {
  const ctx: Ctx = { lang, py: lang === 'python', valueMode: !!opts.returnValue };
  const cands = answerCandidates(answer, ctx.valueMode);
  if (!cands[0].length || cands[0].every((l) => l.trim() === '?')) return { verdict: 'dont-know' };
  const mutants = opts.mutants ?? [];
  const rank = bestRank(cands, expectedVariants(recorded, ctx.valueMode), ctx);
  if (rank === CORRECT) return { verdict: 'correct' };
  if (rank === FORMAT && !opts.typeSensitive && !mutants.some((m) => strictMatch(cands, m.output, ctx))) {
    return { verdict: 'format-only', note: `right idea; ${ctx.py ? 'Python' : 'JavaScript'} writes it as ${actualText(recorded, lang, ctx.valueMode)}` };
  }
  return wrongVerdict(answer, cands, recorded, mutants, ctx);
}

function wrongVerdict(answer: string, cands: string[][], recorded: RecordedOutput, mutants: MutantOutput[], ctx: Ctx): Verdict {
  if (!mutants.length || isGenericError(answer, ctx) || isSlip(cands, recorded, ctx)) return { verdict: 'wrong' };
  const hits = mutants.filter((m) => strictMatch(cands, m.output, ctx));
  if (!hits.length) return { verdict: 'wrong' };
  if (hits.length > 1 || hits[0].ambiguous) return { verdict: 'wrong', ambiguous: true };
  return { verdict: 'wrong', mutantId: hits[0].id };
}

function strictMatch(cands: string[][], output: RecordedOutput, ctx: Ctx): boolean {
  return bestRank(cands, expectedVariants(output, ctx.valueMode), ctx) === CORRECT;
}

/** Answer lines: split on newlines and ' | ' (and, as a fallback, on newlines only, for a printed '|'). */
function answerCandidates(answer: string, valueMode: boolean): string[][] {
  const base = answer.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(ANSWER_PREFIX, ''));
  if (valueMode) {
    const one = base.map((l) => l.trim()).filter(Boolean).join(' ');
    return [one ? [one] : []];
  }
  const split = base.flatMap((l) => l.split(' | '));
  const cands = split.length === base.length ? [base] : [split, base];
  return cands.map((c) => trimEmptyEnds(c.map((l) => l.trimEnd())));
}

function trimEmptyEnds(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a] === '') a++;
  while (b > a && lines[b - 1] === '') b--;
  return lines.slice(a, b);
}

function bestRank(cands: string[][], variants: Unit[][], ctx: Ctx): number {
  let best = WRONG;
  for (const lines of cands) {
    for (const units of variants) {
      best = Math.max(best, rankUnits(lines, units, ctx));
      if (best === CORRECT) return best;
    }
  }
  return best;
}

/**
 * Expected units. A raising output can be answered with its exception name alone, or with the
 * lines printed before it plus the name.
 */
function expectedVariants(rec: RecordedOutput, valueMode: boolean): Unit[][] {
  const exc: Unit[] = rec.exception ? [{ kind: 'exc', name: rec.exception }] : [];
  if (valueMode) {
    if (exc.length) return [exc];
    const calls = rec.values ?? [];
    if (calls.length === 1 && calls[0].length === 1 && calls[0][0].val) {
      const arg = calls[0][0];
      return [[{ kind: 'call', args: [arg], lines: splitLines(arg.repr) }]];
    }
    return [printedUnits({ stdout: rec.stdout, values: [] })];
  }
  const body = printedUnits(rec);
  return body.length && exc.length ? [[...body, ...exc], exc] : [[...body, ...exc]];
}

function splitLines(s: string): string[] {
  return s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd());
}

function stdoutLines(stdout: string): string[] {
  const s = stdout.replace(/\r\n?/g, '\n');
  if (s === '') return [];
  return splitLines(s.endsWith('\n') ? s.slice(0, -1) : s);
}

/** What a print/console.log call shows for one argument: a str bare, anything else its repr. */
function printedArgText(a: PrintedArg): string {
  return a.val.t === 'str' ? a.val.v : a.repr;
}

/**
 * Map stdout lines to print calls. When the calls' rendered text reproduces stdout exactly, each
 * call is a unit with typed args (a call may span several lines: a str with newlines, or an array
 * util.inspect grouped into columns). Otherwise (end='', sep=..., %s formats, custom __str__)
 * the lines are compared as text.
 */
function printedUnits(rec: RecordedOutput): Unit[] {
  const out = stdoutLines(rec.stdout ?? '');
  // An argument the runner could not type is compared by its repr text.
  const calls = (rec.values ?? []).map((args) => args.map((a): PrintedArg => (a.val ? a : { ...a, val: { t: 'opaque', type: a.type, repr: a.repr } })));
  let units: Unit[] | undefined;
  if (calls.length) {
    const rendered = calls.map((args) => splitLines(args.map(printedArgText).join(' ')));
    const flat = rendered.flat();
    if (flat.length === out.length && flat.every((l, i) => l === out[i])) {
      units = calls.map((args, i): Unit => (args.length ? { kind: 'call', args, lines: rendered[i] } : { kind: 'text', text: '', loose: false }));
    }
  }
  units ??= out.map((text): Unit => ({ kind: 'text', text, loose: true }));
  // Blank lines at either end are not part of the answer.
  while (units.length && unitBlank(units[units.length - 1])) units.pop();
  while (units.length && unitBlank(units[0])) units.shift();
  const last = units[units.length - 1];
  if (last?.kind === 'call') units[units.length - 1] = { ...last, lines: trimEmptyEnds(last.lines) };
  const first = units[0];
  if (first?.kind === 'call') units[0] = { ...first, lines: trimEmptyEnds(first.lines) };
  return units;
}

function unitBlank(u: Unit): boolean {
  return (u.kind === 'text' && u.text === '') || (u.kind === 'call' && u.lines.every((l) => l === ''));
}

/** Best rank over alignments of answer lines to units (a multi-line unit may be typed on 1..n lines). */
function rankUnits(lines: string[], units: Unit[], ctx: Ctx): number {
  // Very long outputs (learner code): one answer line per unit, no recursion.
  if (units.length > 500) {
    if (lines.length !== units.length) return WRONG;
    let worst = CORRECT;
    for (let i = 0; i < units.length && worst > WRONG; i++) worst = Math.min(worst, unitRank(units[i], [lines[i]], ctx));
    return worst;
  }
  const memo = new Map<number, number>();
  const rec = (u: number, i: number): number => {
    if (u === units.length) return i === lines.length ? CORRECT : NONE;
    const key = u * (lines.length + 1) + i;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const unit = units[u];
    const maxK = unit.kind === 'call' ? Math.max(1, unit.lines.length) : 1;
    let best = NONE;
    for (let k = 1; k <= maxK && i + k <= lines.length; k++) {
      const rest = rec(u + 1, i + k);
      if (rest <= best) continue;
      best = Math.max(best, Math.min(rest, unitRank(unit, lines.slice(i, i + k), ctx)));
    }
    memo.set(key, best);
    return best;
  };
  return Math.max(WRONG, rec(0, 0));
}

function unitRank(u: Unit, lines: string[], ctx: Ctx): number {
  const text = lines.join('\n');
  switch (u.kind) {
    case 'exc':
      return excMatches(text, u.name) ? CORRECT : WRONG;
    case 'text':
      if (text === u.text) return CORRECT;
      if (u.loose && squash(text) === squash(u.text)) return CORRECT;
      return unquote(text, ctx) === u.text ? FORMAT : WRONG;
    case 'call':
      return callRank(u, lines, ctx);
  }
}

function callRank(u: Extract<Unit, { kind: 'call' }>, lines: string[], ctx: Ctx): number {
  const text = lines.join('\n');
  if (!ctx.valueMode && lines.length === u.lines.length && lines.every((l, i) => l === u.lines[i])) return CORRECT;
  const strict = matchArgs(text, u.args, ctx, false);
  if (strict.ok) return CORRECT;
  const single = u.args.length === 1 ? u.args[0].val : undefined;
  if (!ctx.py && !ctx.valueMode && single?.t === 'str' && jsonEqual(text, single.v)) return CORRECT;
  // Unparseable answer or opaque value: compare the text with whitespace collapsed.
  if ((strict.parseFailed || u.args.some((a) => a.val.t === 'opaque')) && squash(text) === squash(u.lines.join('\n'))) return CORRECT;
  if (matchArgs(text, u.args, ctx, true).ok) return FORMAT;
  if (single && bracketless(text, single, ctx)) return FORMAT;
  if (single?.t === 'str') {
    if (!ctx.valueMode && unquote(text, ctx) === tailNorm(single.v)) return FORMAT;
    // Return value: the right string, written without its quotes (but not None for 'None').
    if (ctx.valueMode && text.trim() === single.v && !parses(text, ctx.lang, 'loose')) return FORMAT;
  }
  return WRONG;
}

/**
 * Match the answer against the args of one print call, in order. A str arg prints bare and is
 * matched as text (in loose mode also as a quoted literal); other args are parsed as literals.
 * Args are separated by one space next to a str, by any whitespace between values.
 */
function matchArgs(text: string, args: PrintedArg[], ctx: Ctx, loose: boolean): { ok: boolean; parseFailed: boolean } {
  let parseFailed = false;
  const mode: LiteralMode = loose ? 'loose' : 'repr';
  const bare = (a: PrintedArg): boolean => !ctx.valueMode && a.val.t === 'str';
  const literalAt = (i: number, pos: number): boolean => {
    let r: { node: LitNode; end: number };
    try {
      r = parseLiteralAt(text, pos, ctx.lang, mode);
    } catch {
      parseFailed = true;
      return false;
    }
    return valEquals(r.node.val, args[i].val, { strict: !loose }) && go(i + 1, r.end);
  };
  const go = (i: number, pos: number): boolean => {
    if (i === args.length) return text.slice(pos).trim() === '';
    const a = args[i];
    if (i > 0) {
      if (bare(a) || bare(args[i - 1])) {
        if (text[pos] !== ' ') return false;
        pos++;
      } else {
        if (!/\s/.test(text[pos] ?? '')) return false;
        while (/\s/.test(text[pos] ?? '')) pos++;
      }
    } else if (!bare(a)) {
      while (/\s/.test(text[pos] ?? '')) pos++;
    }
    if (!bare(a)) return literalAt(i, pos);
    const v = (a.val as { v: string }).v.replace(/\r\n?/g, '\n');
    if (i === args.length - 1) {
      if (tailNorm(text.slice(pos)) === tailNorm(v)) return true;
    } else {
      const mid = v.split('\n').map((l, j, all) => (j < all.length - 1 ? l.trimEnd() : l)).join('\n');
      if (text.startsWith(mid, pos) && go(i + 1, pos + mid.length)) return true;
    }
    return loose && literalAt(i, pos);
  };
  return { ok: go(0, 0), parseFailed };
}

/** Trailing whitespace on every line and at the end does not count. */
function tailNorm(s: string): string {
  return s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trimEnd();
}

function parses(text: string, lang: Lang, mode: LiteralMode): boolean {
  try {
    parseLiteral(text, lang, mode);
    return true;
  } catch {
    return false;
  }
}

/** The answer without one pair of surrounding quotes (for 'it's', which no parser accepts). */
function unquote(text: string, ctx: Ctx): string | undefined {
  const t = text.trim();
  const quotes = ctx.py ? `'"` : `'"\``;
  if (t.length >= 2 && quotes.includes(t[0]) && t[t.length - 1] === t[0]) return t.slice(1, -1);
  return undefined;
}

/** console.log(JSON.stringify(x)) prints a str; spacing and quote style inside JSON never matter (JS). */
function jsonEqual(text: string, printed: string): boolean {
  const p = printed.trim();
  if (!/^[[{]/.test(p)) return false;
  try {
    return valEquals(parseLiteral(text, 'javascript'), parseLiteral(p, 'javascript'));
  } catch {
    return false;
  }
}

/**
 * Format-only "outer brackets removed": '1, 2' for (1, 2) or [1, 2], "'a': 1" for {'a': 1}. Only
 * when the answer is not itself a complete value, so [1, 2] for [[1, 2]] or 5 for [5] stay wrong.
 */
function bracketless(text: string, val: Val, ctx: Ctx): boolean {
  const seq = val.t === 'list' || val.t === 'tuple' || val.t === 'set' || val.t === 'frozenset';
  if (!seq && val.t !== 'dict') return false;
  if (!hasTopLevel(text, seq ? [','] : [',', ':', '=>']) || parses(text, ctx.lang, 'loose')) return false;
  const tries = seq ? [['[', ']']] : ctx.py ? [['{', '}']] : [['{', '}'], ['Map {', '}']];
  for (const [open, close] of tries) {
    let got: Val;
    try {
      got = parseLiteral(open + text + close, ctx.lang, 'loose');
    } catch {
      continue;
    }
    if (seq && got.t === 'list') got = { t: val.t as 'list', v: got.v };
    if (valEquals(got, val, { strict: false })) return true;
  }
  return false;
}

/** Does `text` contain one of `marks` outside quotes and brackets? */
function hasTopLevel(text: string, marks: string[]): boolean {
  let depth = 0;
  let q = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') q = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && marks.some((m) => text.startsWith(m, i))) return true;
  }
  return false;
}

const SQUASH_PUNCT = new Set([...'[](){},:;=<>']);

/** Collapse whitespace runs to one space, and drop them next to punctuation, outside quotes. */
function squash(s: string): string {
  let out = '';
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      out += c;
      if (c === '\\' && i + 1 < s.length) out += s[++i];
      else if (c === q) q = '';
      continue;
    }
    if (/\s/.test(c)) {
      let j = i;
      while (j + 1 < s.length && /\s/.test(s[j + 1])) j++;
      const prev = out[out.length - 1];
      const next = s[j + 1];
      if (prev !== undefined && next !== undefined && !SQUASH_PUNCT.has(prev) && !SQUASH_PUNCT.has(next)) out += ' ';
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') q = c;
    out += c;
  }
  return out;
}

/** 'ZeroDivisionError', 'zerodivisionerror', 'ZeroDivisionError: division by zero', 'raises KeyError', 'KeyError()'. */
function excMatches(answer: string, name: string): boolean {
  const a = excName(answer);
  return a !== undefined && a === excName(name);
}

/** The class name, lower-cased: followed by nothing, ': message', or '(args)' (the exception's repr). */
function excName(s: string): string | undefined {
  const t = s.trim().replace(/^(?:uncaught\s+)?(?:(?:it\s+)?(?:raises|raise|throws|throw)\s+(?:an?\s+)?)?/i, '');
  const m = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:[.!]*$|:|\()/.exec(t);
  const name = m ? m[1].slice(m[1].lastIndexOf('.') + 1) : '';
  return name ? name.toLowerCase() : undefined;
}

const GENERIC_ERROR = /^(?:(?:it|this|that)\s+)?(?:(?:an?|some)\s+)?(?:errors?|exceptions?|crash(?:es)?|fails?|raises?|throws?)(?:\s+an?\s+(?:error|exception))?[.!]*$/i;

/** 'error' without an exception name never names a mutant. JS 'Error' and Python 'Exception' are real class names. */
function isGenericError(answer: string, ctx: Ctx): boolean {
  const t = answer.replace(ANSWER_PREFIX, '').split(':')[0].trim();
  if ((!ctx.py && t === 'Error') || (ctx.py && t === 'Exception')) return false;
  return GENERIC_ERROR.test(t);
}

/** Within edit distance 1 of the actual output, as printed or with whitespace ignored: a probable slip. */
function isSlip(cands: string[][], recorded: RecordedOutput, ctx: Ctx): boolean {
  const actuals = new Set<string>();
  for (const units of expectedVariants(recorded, ctx.valueMode)) {
    actuals.add(units.map((u) => (u.kind === 'call' ? u.lines.join('\n') : u.kind === 'text' ? u.text : u.name)).join('\n'));
    actuals.add(units.map((u) => displayUnit(u, ctx.lang, ctx.valueMode)).join('\n'));
  }
  for (const lines of cands) {
    const a = lines.join('\n');
    for (const t of actuals) {
      if (withinOne(a, t) || withinOne(a.replace(/\s+/g, ''), t.replace(/\s+/g, ''))) return true;
    }
  }
  return false;
}

function withinOne(a: string, b: string): boolean {
  if (a === b) return true;
  const x = Array.from(a);
  const y = Array.from(b);
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = x.length - 1;
  let k = y.length - 1;
  while (j >= i && k >= i && x[j] === y[k]) {
    j--;
    k--;
  }
  return j - i < 1 && k - i < 1;
}

/** Levenshtein distance over code points. With `max`, stops early and returns max + 1 once exceeded. */
export function editDistance(a: string, b: string, max = Infinity): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (Math.abs(x.length - y.length) > max) return max + 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return Math.min(prev[y.length], max + 1);
}

// =====================================================================================
// Display and answer-space guess rate
// =====================================================================================

function displayArg(a: PrintedArg, lang: Lang, valueMode: boolean): string {
  if (!valueMode && a.val.t === 'str') return a.val.v;
  // util.inspect may group long arrays into columns; show them on one line instead.
  if (a.repr && !a.repr.includes('\n')) return a.repr;
  return a.val.t === 'opaque' ? a.repr.replace(/\s*\n\s*/g, ' ') : formatVal(a.val, lang);
}

function displayUnit(u: Unit, lang: Lang, valueMode: boolean): string {
  if (u.kind === 'exc') return u.name;
  if (u.kind === 'text') return u.text;
  return u.args.map((a) => displayArg(a, lang, valueMode)).join(' ');
}

/**
 * The actual output on one line, as the learner should have typed it: printed lines joined with
 * ' | ', arrays on one line, the exception name last. For 'actual: ...' lines and format notes.
 */
export function actualText(recorded: RecordedOutput, lang: Lang, returnValue = false): string {
  return expectedVariants(recorded, returnValue)[0]
    .map((u) => displayUnit(u, lang, returnValue).replace(/\r?\n/g, ' | '))
    .join(' | ');
}

/**
 * Can an answer ever name this mutant? Typing exactly what the mutant printed must match it under
 * compareOutput's own rules: not when its output is within edit distance 1 of the actual output (a
 * probable slip), nor when it is the same answer. Seeds and model packs use this, so a mutant that
 * can never name its belief is not counted as discriminating.
 */
export function mutantAttributable(mutant: RecordedOutput, recorded: RecordedOutput, lang: Lang): boolean {
  const v = compareOutput(actualText(mutant, lang), recorded, lang, { typeSensitive: true, mutants: [{ id: 'm', output: mutant, ambiguous: false }] });
  return v.mutantId === 'm';
}

/**
 * Guess rate from the answer space (spec V1-3): boolean .5, exception name .25, an integer with
 * |n| < 20 .2, another single token of <= 3 characters .12, anything else .06, 2-4 lines .04.
 */
export function answerSpaceG(recorded: RecordedOutput): number {
  if (recorded.exception) return 0.25;
  const units = printedUnits(recorded);
  if (units.length !== 1) return units.length ? 0.04 : 0.06;
  const u = units[0];
  const val = u.kind === 'call' && u.args.length === 1 ? u.args[0].val : undefined;
  const text = u.kind === 'call' ? u.lines.join('\n') : u.kind === 'text' ? u.text : '';
  // One print showing several lines (a str with newlines) is a multi-line answer; a grouped array is one value.
  if (text.includes('\n') && (!val || val.t === 'str')) return 0.04;
  if (val?.t === 'bool' || /^(?:True|False|true|false)$/.test(text)) return 0.5;
  if (smallInt(val, text)) return 0.2;
  if (!/\s/.test(text) && Array.from(text).length <= 3) return 0.12;
  return 0.06;
}

function smallInt(val: Val | undefined, text: string): boolean {
  if (val?.t === 'int' || val?.t === 'bigint') {
    try {
      const n = BigInt(val.v);
      return n > -20n && n < 20n;
    } catch {
      return false;
    }
  }
  if (val?.t === 'num') {
    const n = numValue(val.v as NumV);
    return Number.isInteger(n) && Math.abs(n) < 20;
  }
  return /^-?\d{1,2}$/.test(text) && Math.abs(Number(text)) < 20;
}
