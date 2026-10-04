// Deliberate prelude (Node): check(), typed console.log capture and the construct token table.
// Used by batch.mjs for model/seed snippets; harness scripts may import check() from here.
import util from 'node:util';

/** console.log output never wraps: breakLength alone still groups arrays of 7+ items into rows. */
export const INSPECT = { breakLength: Infinity, compact: true };
const MAX_NODES = 2000;
const MAX_DEPTH = 30;
const MAX_PRINTS = 200;

// ------------------------------------------------------------------ check()

const checkMessage = (msg) => 'CHECK ' + (msg === undefined || msg === null || msg === '' ? 'failed' : String(msg));

export class CheckFailed extends Error {}
Object.defineProperty(CheckFailed.prototype, 'name', { value: 'CheckFailed' });

/** Harness assertion: throws CheckFailed('CHECK <msg>'), which exits non-zero if uncaught. */
export function check(cond, msg) {
  if (!cond) throw new CheckFailed(checkMessage(msg));
}

/** Defines a non-enumerable check() inside a vm context, so its errors belong to that realm. */
export const CHECK_SOURCE = `Object.defineProperty(globalThis, 'check', { configurable: true, writable: true, value: (() => {
  class CheckFailed extends Error {}
  Object.defineProperty(CheckFailed.prototype, 'name', { value: 'CheckFailed' });
  return function check(cond, msg) {
    if (!cond) throw new CheckFailed('CHECK ' + (msg === undefined || msg === null || msg === '' ? 'failed' : String(msg)));
  };
})() });`;

// ------------------------------------------------------------------ typed values (contracts Val)

/** Runtime type name: typeof for primitives, the constructor name for objects. */
export function typeName(x) {
  if (x === null) return 'null';
  if (typeof x !== 'object') return typeof x;
  try {
    const proto = Object.getPrototypeOf(x);
    const name = proto && proto.constructor && proto.constructor.name;
    return typeof name === 'string' && name ? name : 'Object';
  } catch {
    return 'Object';
  }
}

export function safeInspect(x, limit = 2000) {
  let s;
  try {
    s = util.inspect(x, INSPECT);
  } catch (e) {
    s = `<uninspectable ${typeName(x)}>`;
  }
  return s.length <= limit ? s : s.slice(0, limit);
}

/** Typed encoding of a printed value. Objects from a vm context come from another realm, so no instanceof. */
export function encodeVal(x) {
  return enc(x, { left: MAX_NODES }, new Set());
}

const opaque = (x) => ({ t: 'opaque', type: typeName(x), repr: safeInspect(x, 200) });

function isPlainObject(x) {
  if (Symbol.toStringTag in x) return false; // Math, JSON, module namespaces...
  const proto = Object.getPrototypeOf(x);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function enc(x, budget, stack) {
  budget.left--;
  switch (typeof x) {
    case 'number':
      if (Number.isNaN(x)) return { t: 'num', v: 'NaN' };
      if (x === Infinity) return { t: 'num', v: 'Infinity' };
      if (x === -Infinity) return { t: 'num', v: '-Infinity' };
      if (Object.is(x, -0)) return { t: 'num', v: '-0' };
      return { t: 'num', v: x };
    case 'bigint':
      return { t: 'bigint', v: x.toString() };
    case 'string':
      return { t: 'str', v: x };
    case 'boolean':
      return { t: 'bool', v: x };
    case 'undefined':
      return { t: 'undefined' };
    case 'symbol':
    case 'function':
      return opaque(x);
  }
  if (x === null) return { t: 'null' };
  if (util.types.isProxy(x) || stack.has(x) || stack.size >= MAX_DEPTH) return opaque(x);
  stack.add(x);
  try {
    if (Array.isArray(x)) {
      if (x.length > budget.left) return opaque(x);
      const v = [];
      for (let i = 0; i < x.length; i++) {
        v.push(Object.prototype.hasOwnProperty.call(x, i) ? enc(x[i], budget, stack) : { t: 'opaque', type: 'empty', repr: '<empty item>' });
      }
      return { t: 'list', v };
    }
    if (util.types.isSet(x)) {
      if (x.size > budget.left) return opaque(x);
      return { t: 'set', v: [...x].map((e) => enc(e, budget, stack)) };
    }
    if (util.types.isMap(x)) {
      if (x.size > budget.left) return opaque(x);
      return { t: 'dict', v: [...x].map(([k, val]) => [enc(k, budget, stack), enc(val, budget, stack)]) };
    }
    if (isPlainObject(x)) {
      const keys = Object.keys(x);
      if (keys.length > budget.left) return opaque(x);
      return {
        t: 'dict',
        v: keys.map((k) => {
          const d = Object.getOwnPropertyDescriptor(x, k);
          const val = d && 'value' in d ? enc(d.value, budget, stack) : { t: 'opaque', type: 'accessor', repr: '[Getter]' };
          return [{ t: 'str', v: k }, val];
        }),
      };
    }
    return opaque(x);
  } finally {
    stack.delete(x);
  }
}

/** One console.log argument as contracts PrintedArg. */
export function printedArg(x) {
  return { type: typeName(x), repr: safeInspect(x), val: encodeVal(x) };
}

/**
 * A console for a snippet: log/info/debug/dir print to `sink.out` exactly as Node would (minus
 * line wrapping) and record typed values; error/warn/trace go to `sink.err`.
 */
export function makeConsole(sink) {
  const record = (args) => {
    if (sink.values.length < MAX_PRINTS) sink.values.push(args.map(printedArg));
  };
  const log = (...args) => {
    sink.out(util.formatWithOptions(INSPECT, ...args) + '\n');
    record(args);
  };
  const toErr = (...args) => sink.err(util.formatWithOptions(INSPECT, ...args) + '\n');
  return {
    log,
    info: log,
    debug: log,
    dir: (x, opts) => {
      sink.out(util.inspect(x, { ...INSPECT, ...(opts && typeof opts === 'object' ? opts : {}) }) + '\n');
      record([x]);
    },
    error: toErr,
    warn: toErr,
    trace: toErr,
    table: log,
    assert: (cond, ...args) => {
      if (!cond) toErr('Assertion failed' + (args.length ? ': ' + util.format(...args) : ''));
    },
  };
}

// ------------------------------------------------------------------ constructs (token table)

/**
 * Blank out comments, string contents, template text and regex bodies (newlines kept), so the
 * table below only matches code. Template `${...}` expressions stay, since they are code.
 */
export function stripJs(code) {
  let out = '';
  const flags = { template: false, regex: false };
  const braces = []; // per open '{': true when it opened a template ${ } expression
  let i = 0;
  let lastSig = ''; // last significant character of code, for regex-vs-division
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const n = code.length;
  const readTemplate = () => {
    // at a backtick or just after the '}' closing a ${ } expression; consume text up to ` or ${
    let j = i;
    while (j < n) {
      const c = code[j];
      if (c === '\\') j += 2;
      else if (c === '`') {
        out += blank(code.slice(i, j)) + '`';
        i = j + 1;
        lastSig = '`';
        return;
      } else if (c === '$' && code[j + 1] === '{') {
        out += blank(code.slice(i, j)) + '${';
        i = j + 2;
        braces.push(true);
        lastSig = '{';
        return;
      } else j++;
    }
    out += blank(code.slice(i));
    i = n;
  };
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === '/' && d === '/') {
      const j = code.indexOf('\n', i);
      const end = j < 0 ? n : j;
      out += blank(code.slice(i, end));
      i = end;
    } else if (c === '/' && d === '*') {
      const j = code.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      out += blank(code.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      out += c + blank(code.slice(i + 1, Math.min(j, n))) + (j < n && code[j] === c ? c : '');
      i = j < n && code[j] === c ? j + 1 : j;
      lastSig = c;
    } else if (c === '`') {
      flags.template = true;
      out += '`';
      i++;
      readTemplate();
    } else if (c === '{') {
      braces.push(false);
      out += c;
      i++;
      lastSig = c;
    } else if (c === '}') {
      const wasTemplate = braces.pop();
      out += '}';
      i++;
      if (wasTemplate) readTemplate();
      else lastSig = '}';
    } else if (c === '/' && (lastSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || /\b(?:return|typeof|case|do|else|in|of|void|yield|await)\s*$/.test(out))) {
      // a regex literal: skip to the closing unescaped '/' outside a [class]
      let j = i + 1;
      let cls = false;
      while (j < n && code[j] !== '\n') {
        const r = code[j];
        if (r === '\\') j += 2;
        else {
          if (r === '[') cls = true;
          else if (r === ']') cls = false;
          else if (r === '/' && !cls) break;
          j++;
        }
      }
      flags.regex = true;
      out += '/' + blank(code.slice(i + 1, Math.min(j, n))) + (j < n && code[j] === '/' ? '/' : '');
      i = Math.min(j + 1, n);
      lastSig = '/';
      // regex flags are letters: copy them as code
    } else {
      out += c;
      i++;
      if (!/\s/.test(c)) lastSig = c;
    }
  }
  return { code: out, flags };
}

const TABLE = [
  ['for-of', /\bfor\s*(?:await\s*)?\(\s*(?:const|let|var)?\s*[\w$[\]{},\s]*?\bof\b/],
  ['for-in', /\bfor\s*\(\s*(?:const|let|var)?\s*[\w$]+\s+in\b/],
  ['for', /\bfor\s*\(/],
  ['while', /\bwhile\s*\(/],
  ['do-while', /\bdo\s*\{/],
  ['if', /\bif\s*\(/],
  ['else', /\belse\b/],
  ['switch', /\bswitch\s*\(/],
  ['ternary', /[^?\s]\s*\?(?![?.:])[^;:?]*:/],
  ['function', /\bfunction\b/],
  ['generator', /\bfunction\s*\*|\byield\b/],
  ['arrow', /=>/],
  ['class', /\bclass\s+[\w$]/],
  ['inheritance', /\bextends\b/],
  ['new', /\bnew\s+[\w$]/],
  ['this', /\bthis\b/],
  ['return', /\breturn\b/],
  ['async', /\basync\b/],
  ['await', /\bawait\b/],
  ['promise', /\bPromise\b|\.then\s*\(/],
  ['try', /\btry\s*\{/],
  ['catch', /\bcatch\b/],
  ['finally', /\bfinally\b/],
  ['throw', /\bthrow\b/],
  ['break', /\bbreak\b/],
  ['continue', /\bcontinue\b/],
  ['let', /\blet\s+[\w$[{]/],
  ['const', /\bconst\s+[\w$[{]/],
  ['var', /\bvar\s+[\w$[{]/],
  ['destructure', /\b(?:const|let|var)\s*[[{]/],
  ['spread', /\.\.\./],
  ['optional-chain', /\?\.(?!\d)/],
  ['nullish', /\?\?/],
  ['strict-eq', /[!=]==/],
  ['loose-eq', /(?:^|[^=!<>])(?:==|!=)(?!=)/m],
  ['typeof', /\btypeof\b/],
  ['instanceof', /\binstanceof\b/],
  ['delete', /\bdelete\b/],
  ['increment', /\+\+|--(?!>)/],
  ['aug-assign', /(?:[-+*/%]|\*\*|\?\?|\|\||&&)=(?!=)/],
  ['modulo', /%(?!=)/],
  ['power', /\*\*(?!=)/],
  ['index', /[\w$\])]\s*\[/],
  ['array-literal', /(?:^|[=(,:[;{}?&|!]|\breturn)\s*\[/m],
  ['object-literal', /(?:[=(,:?[]|\breturn)\s*\{/],
  ['getter-setter', /\b(?:get|set)\s+[\w$]+\s*\(/],
  ['static', /\bstatic\b/],
];

const TS_TABLE = [
  ['type-annotation', /[\w$)\]]\s*\??:\s*(?:string|number|boolean|bigint|any|unknown|void|never|null|undefined|readonly|[A-Z][\w$]*|\{|\[|\()/],
  ['interface', /\binterface\s+[\w$]/],
  ['type-alias', /\btype\s+[\w$]+\s*(?:<[^>]*>)?\s*=/],
  ['enum', /\benum\s+[\w$]/],
  ['generic', /[\w$]\s*<\s*[\w$]+(?:\s*(?:,|extends)[^>]*)?>\s*\(/],
  ['as-cast', /\bas\s+(?!const\b)[\w$]/],
  ['non-null', /[\w$)\]]!(?=[.[)])/],
];

const GLOBAL_CALLS = new Set([
  'parseInt', 'parseFloat', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Symbol', 'BigInt',
  'isNaN', 'isFinite', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate',
  'queueMicrotask', 'structuredClone', 'check',
]);

/** Text of the statement or block that follows position `i` (just past a ')' or '=>'). */
function bodyFrom(code, i) {
  while (i < code.length && /\s/.test(code[i])) i++;
  if (code[i] !== '{') {
    const end = code.slice(i).search(/[;\n]/);
    return code.slice(i, end < 0 ? undefined : i + end);
  }
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}' && --depth === 0) return code.slice(i, j + 1);
  }
  return code.slice(i);
}

/** Index just past the ')' matching the '(' at `open`. */
function closeParen(code, open) {
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === '(') depth++;
    else if (code[j] === ')' && --depth === 0) return j + 1;
  }
  return code.length;
}

/** Constructs used by a JS/TS snippet: a token table over the code with strings and comments blanked. */
export function constructsOf(source, ts = false) {
  const { code, flags } = stripJs(source);
  const found = new Set();
  for (const [name, re] of TABLE) if (re.test(code)) found.add(name);
  if (ts) for (const [name, re] of TS_TABLE) if (re.test(code)) found.add(name);
  if (flags.template) found.add('template-literal');
  if (flags.regex) found.add('regex');
  for (const m of code.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) found.add('method:' + m[1]);
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) if (GLOBAL_CALLS.has(m[1])) found.add('call:' + m[1]);
  // nested loops: a loop keyword inside another loop's body
  for (const m of code.matchAll(/\b(?:for|while)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    if (/\b(?:for|while)\s*\(|\bdo\s*\{/.test(bodyFrom(code, closeParen(code, open)))) found.add('nested-loop');
  }
  // recursion: a named function (declaration or `const f = (...) =>`/function) calling itself in its body
  const fnRe = /\bfunction\s*\*?\s*([\w$]+)\s*\(|\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b[^(]*\(|\(|[\w$]+\s*=>)/g;
  for (const m of code.matchAll(fnRe)) {
    const name = m[1] ?? m[2];
    const end = m.index + m[0].length;
    let after = m[0].endsWith('(') ? closeParen(code, end - 1) : end; // past the parameter list
    const arrow = code.slice(after).match(/^\s*(?::[^=]*)?=>/); // arrow, maybe after a TS return type
    if (arrow) after += arrow[0].length;
    if (new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\s*\\(`).test(bodyFrom(code, after))) found.add('recursion');
  }
  return [...found].sort();
}
