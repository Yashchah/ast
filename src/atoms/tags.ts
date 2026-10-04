// Canonical tag taxonomy (spec V1-5 TAXONOMY, LARGE TAGS, SEMANTICS TAGS).
// Every concept maps to one of these tags (or 'other'). The misconception ids below are the stable
// taxonomy that seed transforms, model prompts, evidence and mistake keys all reuse: never rename one,
// only add. Pure module: no vscode import.

import { Lang, TagInfo, TagMisconception } from '../contracts';

export interface TaxonomyMisconception extends TagMisconception {
  /** Only these languages hold this belief in this form (default: every language of the tag). */
  langs?: Lang[];
}

export interface TaxonomyEntry extends TagInfo {
  misconceptions: TaxonomyMisconception[];
  /** JS/TS form of the picker example when `example` is Python. */
  jsExample?: string;
}

const PY: Lang[] = ['python'];
const JS: Lang[] = ['javascript', 'typescript'];
const TS: Lang[] = ['typescript'];
const ALL: Lang[] = ['python', 'javascript', 'typescript'];

export const OTHER_TAG = 'other';

/** Rules about how a program runs, not code shapes: they get a Rule card instead of a template. */
export const SEMANTICS_TAGS: readonly string[] = [
  'alias-copy', 'scope-local-global', 'booleans-truthiness', 'identity-vs-equality', 'callbacks-event-loop',
  'mutable-default-arg', 'closure-late-binding', 'str-vs-number', 'null-undefined', 'loose-vs-strict-equality',
];

// Beliefs shared by several tags: one id always means one belief, word for word.
const STARTS_AT_ONE = 'The first item is at position 1, not 0';
const LAST_IS_LEN = 'The last item is at index len, not len - 1';
const NEG_INDEX_ERROR = 'A negative index is always an error';
const NEG_INDEX_FROM_END = 'Index -1 gives the last item';

function mc(id: string, belief: string, prior: number, langs?: Lang[]): TaxonomyMisconception {
  return langs ? { id, belief, prior, langs } : { id, belief, prior };
}

interface Def {
  tag: string;
  langs: Lang[];
  name: string;
  prereqs: string[];
  misconceptions: TaxonomyMisconception[];
  example: string;
  jsExample?: string;
  parent?: string;
  alternatives?: string[];
  typeSensitive?: boolean;
  stateTrace?: boolean;
  allowedImports?: string[];
}

function def(d: Def): TaxonomyEntry {
  const e: TaxonomyEntry = {
    tag: d.tag,
    langs: d.langs,
    kind: SEMANTICS_TAGS.includes(d.tag) ? 'semantics' : 'shape',
    patternName: d.name,
    prereqs: d.prereqs,
    alternatives: d.alternatives ?? [],
    typeSensitive: d.typeSensitive ?? false,
    stateTrace: d.stateTrace ?? false,
    allowedImports: d.allowedImports ?? [],
    misconceptions: d.misconceptions,
    example: d.example,
  };
  if (d.parent) e.parent = d.parent;
  if (d.jsExample) e.jsExample = d.jsExample;
  return e;
}

// Order matters: fundamentals first. It is the tie-break order of topoOrder().
const DEFS: TaxonomyEntry[] = [
  // ---- values and names -----------------------------------------------------------------------
  def({
    tag: 'variables-assignment', langs: ALL, name: 'Assign and reassign names', prereqs: [], stateTrace: true,
    misconceptions: [
      mc('assignment-links-names', 'After b = a, reassigning a also changes b', 0.3),
      mc('swap-without-temp', 'a = b then b = a swaps the two values', 0.25),
      mc('print-sees-later-assignment', 'print shows a value assigned on a later line', 0.15),
    ],
    example: 'total = 0; total = total + 5',
    jsExample: 'let total = 0; total = total + 5;',
  }),
  def({
    tag: 'numbers-int-float', langs: ALL, name: 'Whole and decimal numbers', prereqs: ['variables-assignment'],
    typeSensitive: true,
    misconceptions: [
      mc('division-gives-int', 'Dividing two whole numbers gives a whole number', 0.35),
      mc('float-math-exact', '0.1 + 0.2 equals exactly 0.3', 0.25),
      mc('int-conversion-rounds', 'Converting 2.7 to a whole number rounds it to 3', 0.25),
      mc('round-half-up', 'round(2.5) always rounds up to 3', 0.15, PY),
    ],
    example: '7 / 2 -> 3.5; int(3.9) -> 3',
    jsExample: '7 / 2 -> 3.5; Math.trunc(3.9) -> 3',
  }),
  def({
    tag: 'integer-division-modulo', langs: ALL, name: 'Floor division and remainder', prereqs: ['numbers-int-float'],
    typeSensitive: true,
    misconceptions: [
      mc('floor-div-rounds', 'Floor division rounds to the nearest whole number', 0.3),
      mc('floor-div-truncates-negatives', 'Floor division of a negative number just drops the decimals', 0.2),
      mc('mod-gives-quotient', '% gives how many times it divides, not the remainder', 0.2),
      mc('mod-negative-sign', '-7 % 3 gives -1', 0.15, PY),
      mc('mod-negative-positive', '-7 % 3 gives a positive remainder', 0.15, JS),
    ],
    example: '17 // 5 -> 3; 17 % 5 -> 2',
    jsExample: 'Math.floor(17 / 5) -> 3; 17 % 5 -> 2',
  }),
  def({
    tag: 'str-vs-number', langs: ALL, name: 'Text versus number values', prereqs: ['numbers-int-float'],
    typeSensitive: true,
    misconceptions: [
      mc('digit-strings-add', "'2' + '3' adds them to make 5", 0.35),
      mc('mixed-plus-adds', 'Adding a number to digit text does arithmetic', 0.3),
      mc('string-times-number-math', "'4' * 2 doubles the number to 8", 0.2, PY),
      mc('digit-strings-compare-numerically', "'10' < '9' compares them as numbers", 0.2),
    ],
    example: "'3' + '4' -> '34'; int('3') + 4 -> 7",
    jsExample: "'3' + 4 -> '34'; Number('3') + 4 -> 7",
  }),

  // ---- strings ----------------------------------------------------------------------------------
  def({
    tag: 'string-indexing', langs: ALL, name: 'Index into a string', prereqs: ['variables-assignment'],
    misconceptions: [
      mc('index-starts-at-one', STARTS_AT_ONE, 0.35),
      mc('last-index-is-length', LAST_IS_LEN, 0.25),
      mc('negative-index-error', NEG_INDEX_ERROR, 0.15, PY),
      mc('negative-index-from-end', NEG_INDEX_FROM_END, 0.2, JS),
      mc('string-item-assignable', "You can change one character with s[0] = 'x'", 0.15),
    ],
    example: "word[0] -> 'c'; word[-1] -> 't'",
    jsExample: "word[0] -> 'c'; word.at(-1) -> 't'",
  }),
  def({
    tag: 'string-methods', langs: ALL, name: 'Call string methods', prereqs: ['string-indexing'],
    misconceptions: [
      mc('string-method-mutates', 'A method like upper changes the string itself', 0.4),
      mc('replace-first-only', 'replace changes only the first match', 0.2, PY),
      mc('replace-all', 'replace with a string changes every match', 0.25, JS),
      mc('strip-removes-inside', 'strip/trim also removes spaces inside the text', 0.2),
    ],
    example: 'name.strip().title()',
    jsExample: 'name.trim().toUpperCase()',
  }),
  def({
    tag: 'string-formatting', langs: ALL, name: 'Format values into text', prereqs: ['str-vs-number'],
    misconceptions: [
      mc('braces-without-f', 'A string without the f prefix still fills in {name}', 0.3, PY),
      mc('template-in-quotes', '${name} fills in inside normal quotes too', 0.3, JS),
      mc('format-cuts-digits', 'Formatting to 2 decimals just cuts off the extra digits', 0.25),
      mc('padding-cuts-text', 'Padding to a width also cuts longer text', 0.15),
    ],
    example: "f'{name}: {score:.1f}'",
    jsExample: '`${name}: ${score.toFixed(1)}`',
  }),
  def({
    tag: 'string-split-join', langs: ALL, name: 'Split and join text', prereqs: ['string-methods', 'list-indexing'],
    misconceptions: [
      mc('split-keeps-separator', 'split keeps the separator in the pieces', 0.25),
      mc('split-skips-empty', "Splitting 'a,,b' on commas gives no empty pieces", 0.25),
      mc('join-trailing-separator', 'join also puts the separator after the last item', 0.2),
      mc('join-accepts-numbers', 'join works on a list of numbers', 0.2, PY),
    ],
    example: "'a,b'.split(',') -> ['a', 'b']; '-'.join(parts)",
    jsExample: "'a,b'.split(',') -> ['a', 'b']; parts.join('-')",
  }),

  // ---- comparisons and branching ----------------------------------------------------------------
  def({
    tag: 'comparison-equality', langs: ALL, name: 'Compare values', prereqs: ['variables-assignment'],
    alternatives: ['loose-vs-strict-equality'],
    misconceptions: [
      mc('string-compare-by-length', 'Comparing two strings compares their lengths', 0.25),
      mc('capitals-compare-bigger', 'Capital letters compare as bigger than lowercase ones', 0.2),
      mc('number-equals-digit-text', "1 == '1' is True", 0.25, PY),
      mc('chained-compare-math', 'a < b < c checks both comparisons like in math', 0.2, JS),
    ],
    example: "'apple' < 'banana' -> True",
    jsExample: "'apple' < 'banana' -> true",
  }),
  def({
    tag: 'conditionals', langs: ALL, name: 'Branch with if and else', prereqs: ['comparison-equality'],
    misconceptions: [
      mc('all-true-branches-run', 'Every branch whose condition is true runs', 0.35),
      mc('separate-ifs-exclusive', 'Separate ifs act like elif: only one runs', 0.25),
      mc('or-compares-both', "x == 'a' or 'b' compares x with both", 0.25),
    ],
    example: 'if n < 0: ... elif n == 0: ... else: ...',
    jsExample: 'if (n < 0) {...} else if (n === 0) {...} else {...}',
  }),
  def({
    tag: 'booleans-truthiness', langs: ALL, name: 'Truthy and falsy values', prereqs: ['conditionals'],
    misconceptions: [
      mc('empty-list-truthy', 'An empty list counts as true in an if', 0.3, PY),
      mc('empty-array-falsy', 'An empty array counts as false in an if', 0.35, JS),
      mc('zero-string-falsy', "The string '0' counts as false", 0.2),
      mc('and-or-return-bool', 'and / or always give a boolean, never one of the values', 0.25),
    ],
    example: 'if items: ...  # an empty list is falsy',
    jsExample: "if (name) {...}  // '' is falsy, [] is truthy",
  }),
  def({
    tag: 'identity-vs-equality', langs: ALL, name: 'Same object versus equal', prereqs: ['comparison-equality', 'alias-copy'],
    stateTrace: true,
    misconceptions: [
      mc('is-means-equal', 'is checks whether two values are equal', 0.35, PY),
      mc('equal-lists-same-object', 'Two lists with equal items are the same object', 0.3),
      mc('strict-equal-compares-contents', '=== compares arrays by their contents', 0.35, JS),
      mc('copy-is-same-object', 'A copy is the same object as the original', 0.15),
    ],
    example: 'a == b -> True; a is b -> False',
    jsExample: '[1] === [1] -> false',
  }),

  // ---- loops ------------------------------------------------------------------------------------
  def({
    tag: 'while-loop-termination', langs: ALL, name: 'Loop until a condition', prereqs: ['conditionals'], stateTrace: true,
    misconceptions: [
      mc('stops-mid-body', 'The loop stops the moment the condition turns false', 0.3),
      mc('last-value-after-loop', 'After the loop, the counter holds the last value that passed', 0.25),
      mc('checks-after-body', 'The body always runs once before the condition is checked', 0.2),
      mc('counter-auto-updates', 'The loop variable goes up by itself each pass', 0.15),
    ],
    example: 'while n > 0: n //= 10',
    jsExample: 'while (n > 0) { n = Math.floor(n / 10); }',
  }),
  def({
    tag: 'for-range-bounds', langs: ALL, name: 'Count with a range loop', prereqs: ['variables-assignment'],
    misconceptions: [
      mc('range-includes-end', 'The loop also runs for the end value', 0.4),
      mc('range-starts-at-one', 'Counting starts at 1, not 0', 0.25),
      mc('step-reaches-end', 'A loop with a step always lands on the end value', 0.15),
      mc('loop-var-past-end', 'After the loop, the variable equals the end value', 0.15, PY),
    ],
    example: 'for i in range(1, 4): ...  # 1, 2, 3',
    jsExample: 'for (let i = 1; i < 4; i++) {...}  // 1, 2, 3',
  }),
  def({
    tag: 'loop-accumulator', langs: ALL, name: 'Accumulate in a loop', prereqs: ['for-range-bounds'], stateTrace: true,
    alternatives: ['list-comprehension', 'array-map-filter-reduce'],
    misconceptions: [
      mc('reset-inside-loop', 'Setting the total inside the loop still keeps a running sum', 0.3),
      mc('assign-instead-of-add', 'total = x adds x to the total', 0.3),
      mc('max-starts-at-zero', 'Starting the best value at 0 works for any numbers', 0.2),
    ],
    example: 'total = 0; for x in xs: total += x',
    jsExample: 'let total = 0; for (const x of xs) total += x;',
  }),
  def({
    tag: 'nested-loops', langs: ALL, name: 'Loop inside a loop', prereqs: ['for-range-bounds'], stateTrace: true,
    misconceptions: [
      mc('loops-advance-together', 'Both loops step together, pairing up items', 0.3),
      mc('inner-runs-once', 'The inner loop runs only once overall', 0.2),
      mc('inner-continues', 'The inner loop continues where it stopped last time', 0.2),
    ],
    example: 'for r in rows: for c in cols: ...',
    jsExample: 'for (const r of rows) for (const c of cols) {...}',
  }),
  def({
    tag: 'break-continue', langs: ALL, name: 'Exit or skip iterations', prereqs: ['for-range-bounds', 'conditionals'],
    misconceptions: [
      mc('break-exits-all-loops', 'break leaves every loop it is inside', 0.25),
      mc('continue-stops-loop', 'continue stops the loop like break', 0.25),
      mc('break-skips-one', 'break skips only the current item', 0.2),
      mc('loop-else-on-break', "A loop's else runs when break happens", 0.15, PY),
    ],
    example: 'for x in xs: if x < 0: break',
    jsExample: 'for (const x of xs) { if (x < 0) break; }',
  }),
  def({
    tag: 'print-placement-in-loops', langs: ALL, name: 'Print inside or after loops', prereqs: ['for-range-bounds'],
    misconceptions: [
      mc('inside-prints-final', 'A print inside the loop prints only the final value', 0.25),
      mc('after-prints-each', 'A print after the loop runs on every pass', 0.3),
      mc('indent-irrelevant', 'Indentation does not change what the loop repeats', 0.2, PY),
    ],
    example: 'for x in xs: print(x)  # every pass',
    jsExample: 'for (const x of xs) console.log(x);  // every pass',
  }),

  // ---- lists ------------------------------------------------------------------------------------
  def({
    tag: 'list-indexing', langs: ALL, name: 'Index into a list', prereqs: ['variables-assignment'],
    misconceptions: [
      mc('index-starts-at-one', STARTS_AT_ONE, 0.35),
      mc('last-index-is-length', LAST_IS_LEN, 0.25),
      mc('negative-index-error', NEG_INDEX_ERROR, 0.15, PY),
      mc('negative-index-from-end', NEG_INDEX_FROM_END, 0.2, JS),
    ],
    example: 'xs[0], xs[-1]',
    jsExample: 'xs[0], xs[xs.length - 1]',
  }),
  def({
    tag: 'list-slicing', langs: ALL, name: 'Slice a sequence', prereqs: ['list-indexing'],
    misconceptions: [
      mc('slice-end-included', 'The slice includes the item at the stop index', 0.4),
      mc('index-starts-at-one', STARTS_AT_ONE, 0.2),
      mc('slice-past-end-errors', 'Slicing past the end raises an error', 0.15),
      mc('slice-aliases-original', 'Changing a slice also changes the original list', 0.15),
    ],
    example: 'xs[1:3]  # items 1 and 2',
    jsExample: 'xs.slice(1, 3)  // items 1 and 2',
  }),
  def({
    tag: 'list-mutation-methods', langs: ALL, name: 'Change a list in place', prereqs: ['list-indexing'], stateTrace: true,
    misconceptions: [
      mc('append-returns-list', 'Adding an item gives back the updated list', 0.35),
      mc('append-list-flattens', 'Appending a list adds its items one by one', 0.25),
      mc('sort-returns-list', 'xs.sort() gives back the sorted list', 0.25, PY),
      mc('pop-removes-first', 'pop() removes the first item', 0.15),
    ],
    example: 'xs.append(4); xs.sort()',
    jsExample: 'xs.push(4); xs.sort((a, b) => a - b);',
  }),
  def({
    tag: 'alias-copy', langs: ALL, name: 'Aliases share one object', prereqs: ['list-mutation-methods'], stateTrace: true,
    allowedImports: ['copy'],
    misconceptions: [
      mc('assignment-copies', 'b = a makes a separate copy of the list', 0.45),
      mc('param-gets-copy', 'A function gets its own copy of a list argument', 0.25),
      mc('shallow-copy-deep', 'Copying a list also copies the lists inside it', 0.25),
      mc('rebind-changes-alias', 'Pointing a at a new list also changes b', 0.2),
    ],
    example: 'b = a  # same list; c = a.copy()  # new list',
    jsExample: 'const b = a;  // same array; const c = [...a];',
  }),
  def({
    tag: 'list-comprehension', langs: PY, name: 'List comprehension',
    prereqs: ['for-range-bounds', 'conditionals', 'list-indexing'], alternatives: ['loop-accumulator'],
    misconceptions: [
      mc('comprehension-if-maps', 'The if in a comprehension changes items instead of dropping them', 0.25),
      mc('comprehension-mutates', 'A comprehension changes the original list', 0.2),
      mc('nested-for-order', 'In a nested comprehension the first for is the inner loop', 0.2),
    ],
    example: '[x * x for x in xs if x > 0]',
  }),
  def({
    tag: 'tuple-unpacking', langs: ALL, name: 'Unpack values into names', prereqs: ['list-indexing'],
    typeSensitive: true, stateTrace: true,
    misconceptions: [
      mc('swap-sequential', 'Swapping with a, b = b, a gives both the same value', 0.3),
      mc('star-rest-is-tuple', '*rest collects the leftover values into a tuple', 0.25, PY),
      mc('extra-values-ignored', 'Extra values are quietly ignored when unpacking', 0.2, PY),
      mc('missing-values-error', 'Unpacking more names than values raises an error', 0.2, JS),
    ],
    example: 'a, b = b, a; first, *rest = xs',
    jsExample: '[a, b] = [b, a]; const [first, ...rest] = xs;',
  }),

  // ---- dicts and sets ---------------------------------------------------------------------------
  def({
    tag: 'dict-access-missing-key', langs: ALL, name: 'Look up a key safely', prereqs: ['list-indexing'],
    alternatives: ['object-property-access'],
    misconceptions: [
      mc('missing-key-none', 'd[key] gives None when the key is missing', 0.3, PY),
      mc('get-default-stored', 'get(key, default) also stores the default in the dict', 0.2, PY),
      mc('missing-key-error', 'Reading a missing key throws an error', 0.25, JS),
      mc('in-checks-values', 'in checks the values, not the keys', 0.25),
    ],
    example: "d.get('x', 0)  # 0 if missing",
    jsExample: 'obj.x ?? 0  // 0 if missing',
  }),
  def({
    tag: 'dict-iteration', langs: ALL, name: 'Loop over a dictionary', prereqs: ['dict-access-missing-key', 'for-range-bounds'],
    misconceptions: [
      mc('loop-gives-values', 'Looping over a dict gives its values', 0.35),
      mc('dict-order-random', 'A dict loops in a random order', 0.2),
      mc('add-keys-while-looping', 'Adding keys while looping over a dict is fine', 0.15, PY),
      mc('number-keys-keep-order', 'Number-like keys keep the order they were added in', 0.15, JS),
    ],
    example: 'for k, v in d.items(): ...',
    jsExample: 'for (const [k, v] of Object.entries(obj)) {...}',
  }),
  def({
    tag: 'counting-with-dict', langs: ALL, name: 'Count with a dictionary', prereqs: ['dict-access-missing-key', 'loop-accumulator'],
    alternatives: ['collections-counter'], stateTrace: true,
    misconceptions: [
      mc('increment-missing-key', 'counts[w] += 1 works even before w is a key', 0.3),
      mc('assign-one-each-time', 'counts[w] = 1 adds one each time', 0.25),
      mc('counts-dict-inside-loop', 'Creating the dict inside the loop keeps the old counts', 0.2),
    ],
    example: 'counts[w] = counts.get(w, 0) + 1',
    jsExample: 'counts[w] = (counts[w] ?? 0) + 1;',
  }),
  def({
    tag: 'collections-counter', langs: PY, name: 'Count with Counter', prereqs: ['dict-access-missing-key', 'modules-imports'],
    alternatives: ['counting-with-dict'], typeSensitive: true, allowedImports: ['collections'],
    misconceptions: [
      mc('counter-missing-key-error', 'A missing key in a Counter raises KeyError', 0.25),
      mc('most-common-dict', 'most_common() returns a dict', 0.25),
      mc('counter-of-string-words', 'Counter of a string counts whole words', 0.25),
    ],
    example: 'Counter(words).most_common(2)',
  }),
  def({
    tag: 'set-membership', langs: ALL, name: 'Test membership with a set', prereqs: ['list-indexing'],
    misconceptions: [
      mc('set-keeps-duplicates', 'A set keeps duplicate items', 0.3),
      mc('set-of-string-whole', 'A set made from a string holds the whole string', 0.2),
      mc('set-keeps-order', 'A set keeps items in the order they were added', 0.2, PY),
      mc('set-indexable', 'You can get a set item by its position', 0.15),
    ],
    example: "'x' in seen  # fast membership test",
    jsExample: "seen.has('x')  // fast membership test",
  }),
  def({
    tag: 'sorting-key', langs: ALL, name: 'Sort by a key', prereqs: ['list-mutation-methods', 'function-def-call'],
    allowedImports: ['operator'],
    misconceptions: [
      mc('sorted-changes-original', 'sorted(xs) also sorts xs itself', 0.25, PY),
      mc('key-values-in-result', 'Sorting by length gives back the lengths', 0.2),
      mc('case-insensitive-order', 'Capital and small letters sort together alphabetically', 0.2),
      mc('default-sort-numeric', 'sort() orders numbers by their value', 0.35, JS),
    ],
    example: 'sorted(words, key=len)',
    jsExample: 'words.sort((a, b) => a.length - b.length);',
  }),

  // ---- functions (large: def-call -> return-vs-print -> params-defaults) -----------------------
  def({
    tag: 'function-def-call', langs: ALL, name: 'Define and call a function', prereqs: ['variables-assignment'],
    misconceptions: [
      mc('def-runs-body', 'Defining a function runs its body', 0.3),
      mc('name-without-parens-calls', 'Writing the name without () calls it', 0.2),
      mc('args-match-by-name', "Arguments match parameters by the caller's variable names", 0.2),
    ],
    example: 'def area(w, h): return w * h',
    jsExample: 'function area(w, h) { return w * h; }',
  }),
  def({
    tag: 'function-return-vs-print', langs: ALL, name: 'Return a value, not print', prereqs: ['function-def-call'],
    parent: 'function-def-call',
    misconceptions: [
      mc('print-is-return', 'A function that prints gives back that value', 0.4),
      mc('return-prints', 'return shows the value on the screen', 0.3),
      mc('code-after-return-runs', 'Lines after return still run', 0.2),
      mc('return-in-loop-continues', 'return inside a loop only ends that pass', 0.2),
    ],
    example: 'def double(x): return x * 2',
    jsExample: 'const double = (x) => x * 2;',
  }),
  def({
    tag: 'function-params-defaults', langs: ALL, name: 'Parameters with default values', prereqs: ['function-return-vs-print'],
    parent: 'function-def-call',
    misconceptions: [
      mc('default-overrides-argument', 'The default is used even when an argument is given', 0.25),
      mc('keyword-args-positional', 'f(b=1, a=2) assigns by position, not by name', 0.2, PY),
      mc('missing-arg-none', 'A missing argument becomes None', 0.2, PY),
      mc('missing-arg-error', 'Leaving out an argument raises an error', 0.2, JS),
      mc('extra-args-error', 'Passing extra arguments raises an error', 0.2, JS),
    ],
    example: "def greet(name, greeting='Hi'): ...",
    jsExample: "function greet(name, greeting = 'Hi') {...}",
  }),
  def({
    tag: 'mutable-default-arg', langs: PY, name: 'Mutable defaults are shared', prereqs: ['function-params-defaults', 'alias-copy'],
    stateTrace: true,
    misconceptions: [
      mc('default-fresh-each-call', 'A default list starts empty on every call', 0.45),
      mc('none-default-shared', 'Using None as the default still shares one list', 0.15),
    ],
    example: 'def add(x, xs=None): xs = [] if xs is None else xs',
  }),
  def({
    tag: 'scope-local-global', langs: ALL, name: 'Local versus global names', prereqs: ['function-def-call'], stateTrace: true,
    misconceptions: [
      mc('assign-changes-global', 'Assigning a name inside a function changes the global one', 0.35),
      mc('local-visible-outside', 'Variables made inside a function exist after it returns', 0.25),
      mc('param-rebind-changes-caller', "Reassigning a parameter changes the caller's variable", 0.25),
      mc('read-then-assign-global', 'A function can read a global, then assign it', 0.15, PY),
    ],
    example: 'def f(): x = 1  # local; the global x is unchanged',
    jsExample: 'function f() { let x = 1; }  // the outer x is unchanged',
  }),

  // ---- closures (large: capture -> late binding) ------------------------------------------------
  def({
    tag: 'closure-capture', langs: ALL, name: 'Inner function captures variables',
    prereqs: ['scope-local-global', 'function-return-vs-print'], stateTrace: true,
    misconceptions: [
      mc('closure-copies-value', 'The inner function keeps a copy of the value at creation', 0.3),
      mc('calls-share-closure', 'Every call of the outer function shares one variable', 0.2),
      mc('nonlocal-optional', 'An inner function can reassign an outer variable without nonlocal', 0.2, PY),
    ],
    example: 'def make_adder(n): return lambda x: x + n',
    jsExample: 'const makeAdder = (n) => (x) => x + n;',
  }),
  def({
    tag: 'closure-late-binding', langs: ALL, name: 'Closures read variables late', prereqs: ['closure-capture', 'for-range-bounds'],
    parent: 'closure-capture', stateTrace: true,
    misconceptions: [
      mc('loop-closure-keeps-value', "Each function made in a loop remembers that pass's value", 0.4),
      mc('default-arg-no-effect', 'Adding i=i as a default changes nothing', 0.15, PY),
      mc('let-same-as-var-loop', 'let and var behave the same in loop callbacks', 0.25, JS),
    ],
    example: 'fs = [lambda: i for i in range(3)]  # all see i = 2',
    jsExample: 'for (var i = 0; i < 3; i++) fs.push(() => i);  // all see 3',
  }),

  // ---- recursion (large: base case -> call stack -> combine) ------------------------------------
  def({
    tag: 'recursion-base-case', langs: ALL, name: 'Recursion with a base case', prereqs: ['function-return-vs-print', 'conditionals'],
    misconceptions: [
      mc('base-case-ends-everything', 'Returning from the base case ends every call at once', 0.3),
      mc('recursion-stops-itself', 'Recursion stops by itself when the values run out', 0.25),
      mc('base-case-order-free', 'The base case check can come after the recursive call', 0.15),
    ],
    example: 'def fact(n): return 1 if n == 0 else n * fact(n - 1)',
    jsExample: 'const fact = (n) => (n === 0 ? 1 : n * fact(n - 1));',
  }),
  def({
    tag: 'recursion-call-stack', langs: ALL, name: 'Trace the call stack', prereqs: ['recursion-base-case'],
    parent: 'recursion-base-case',
    misconceptions: [
      mc('print-after-call-same-order', 'Prints after the recursive call come out in calling order', 0.35),
      mc('calls-share-locals', 'All recursive calls share the same local variables', 0.25),
    ],
    example: 'def show(n): if n: show(n - 1); print(n)',
    jsExample: 'function show(n) { if (n) show(n - 1); console.log(n); }',
  }),
  def({
    tag: 'recursion-combine', langs: ALL, name: 'Combine recursive results', prereqs: ['recursion-call-stack'],
    parent: 'recursion-base-case',
    misconceptions: [
      mc('missing-return-passes-up', "The recursive call's result passes up even without return", 0.3),
      mc('base-value-is-answer', 'The base case value is the final answer', 0.25),
      mc('combine-order-irrelevant', 'Joining before or after the recursive call gives the same result', 0.15),
    ],
    example: 'def total(xs): return 0 if not xs else xs[0] + total(xs[1:])',
    jsExample: 'const total = (xs) => (xs.length ? xs[0] + total(xs.slice(1)) : 0);',
  }),

  // ---- errors -----------------------------------------------------------------------------------
  def({
    tag: 'exceptions-try-except', langs: ALL, name: 'Catch errors with try', prereqs: ['function-def-call'],
    misconceptions: [
      mc('rest-of-try-runs', 'After an error, the rest of the try block still runs', 0.35),
      mc('finally-only-on-error', 'finally runs only when an error happens', 0.25),
      mc('else-runs-on-error', "A try's else runs when an exception happens", 0.15, PY),
      mc('except-best-match', 'The most specific except is chosen, whatever the order', 0.15, PY),
    ],
    example: 'try: n = int(s) / except ValueError: n = 0',
    jsExample: 'try { data = JSON.parse(s); } catch (e) { data = null; }',
  }),
  def({
    tag: 'raising-errors', langs: ALL, name: 'Raise an error', prereqs: ['exceptions-try-except'],
    misconceptions: [
      mc('raise-returns-value', 'raise hands the message back to the caller like return', 0.25),
      mc('code-after-raise-runs', 'Lines after raise still run', 0.25),
      mc('uncaught-raise-continues', 'An uncaught error prints a message, then the program continues', 0.2),
    ],
    example: "if n < 0: raise ValueError('negative')",
    jsExample: "if (n < 0) throw new RangeError('negative');",
  }),
  def({
    tag: 'reading-tracebacks', langs: ALL, name: 'Read a traceback', prereqs: ['function-def-call'],
    misconceptions: [
      mc('first-frame-is-failure', 'The first frame of the traceback is where it failed', 0.3, PY),
      mc('last-frame-is-failure', 'The last line of the stack is where it failed', 0.3, JS),
      mc('error-line-has-bug', 'The line named in the error always holds the bug', 0.25),
    ],
    example: 'IndexError on line 4: the last frame is where it failed',
    jsExample: 'TypeError at f (pad:2:5): the first frame is where it failed',
  }),

  // ---- classes (large: def/init -> instance attributes -> methods) ------------------------------
  def({
    tag: 'class-def-init', langs: ALL, name: 'Define a class constructor', prereqs: ['function-def-call'],
    misconceptions: [
      mc('constructor-called-manually', 'You must call the constructor yourself after creating an object', 0.2),
      mc('class-attr-per-object', 'A list in the class body is separate for each object', 0.25, PY),
      mc('init-returns-object', '__init__ must return the new object', 0.15, PY),
      mc('class-field-shared', 'A field declared in the class body is shared by all objects', 0.2, JS),
    ],
    example: 'class Point: def __init__(self, x): self.x = x',
    jsExample: 'class Point { constructor(x) { this.x = x; } }',
  }),
  def({
    tag: 'instance-attributes', langs: ALL, name: 'Per-object attributes', prereqs: ['class-def-init'],
    parent: 'class-def-init', stateTrace: true,
    misconceptions: [
      mc('one-object-changes-all', "Changing one object's attribute changes every object", 0.3),
      mc('local-becomes-attribute', 'A plain variable in the constructor becomes an attribute', 0.25),
    ],
    example: 'p.x = 5  # only p changes',
    jsExample: 'p.x = 5;  // only p changes',
  }),
  def({
    tag: 'methods-self-this', langs: ALL, name: 'Methods use self or this', prereqs: ['instance-attributes'],
    parent: 'class-def-init',
    misconceptions: [
      mc('bare-name-is-attribute', "Inside a method, a bare name means the object's attribute", 0.3),
      mc('method-changes-copy', 'A method changes a copy, not the object itself', 0.2),
      mc('self-passed-explicitly', 'You must pass self when calling a method', 0.2, PY),
    ],
    example: 'def grow(self): self.size += 1',
    jsExample: 'grow() { this.size += 1; }',
  }),

  // ---- generators (large: yield -> laziness) ----------------------------------------------------
  def({
    tag: 'generator-yield', langs: ALL, name: 'Yield values one by one', prereqs: ['function-return-vs-print', 'for-range-bounds'],
    allowedImports: ['itertools'],
    misconceptions: [
      mc('yield-ends-function', 'yield ends the function like return', 0.3),
      mc('call-runs-body', 'Calling a generator function runs its body right away', 0.3),
      mc('generator-is-list', 'A generator function returns a list', 0.2),
    ],
    example: 'def evens(n): for i in range(n): yield 2 * i',
    jsExample: 'function* evens(n) { for (let i = 0; i < n; i++) yield 2 * i; }',
  }),
  def({
    tag: 'generator-laziness', langs: ALL, name: 'Generators run on demand', prereqs: ['generator-yield'],
    parent: 'generator-yield', allowedImports: ['itertools'],
    misconceptions: [
      mc('generator-restarts', 'Looping over a generator again starts it over', 0.35),
      mc('values-made-upfront', 'All values are computed when the generator is created', 0.3),
    ],
    example: 'g = (x * x for x in xs)  # nothing computed yet',
    jsExample: 'const it = evens(3);  // nothing runs yet',
  }),

  // ---- files, data, modules ---------------------------------------------------------------------
  def({
    tag: 'file-read-lines', langs: ALL, name: 'Read lines from a file', prereqs: ['string-methods', 'for-range-bounds'],
    allowedImports: ['io'],
    misconceptions: [
      mc('lines-without-newline', 'Lines read from a file have no newline at the end', 0.35, PY),
      mc('reread-starts-over', 'Reading the file again starts from the beginning', 0.25, PY),
      mc('read-gives-list', 'read() gives a list of lines', 0.2, PY),
      mc('split-no-trailing-empty', 'Splitting text on newlines never gives an empty last piece', 0.3, JS),
      mc('split-removes-carriage-return', "Splitting on '\\n' also removes Windows '\\r' characters", 0.15, JS),
    ],
    example: 'for line in f: name = line.strip()',
    jsExample: "for (const line of text.split('\\n')) {...}",
  }),
  def({
    tag: 'json-parse-serialize', langs: ALL, name: 'Parse and write JSON', prereqs: ['dict-access-missing-key', 'str-vs-number'],
    typeSensitive: true, allowedImports: ['json'],
    misconceptions: [
      mc('parse-returns-string', 'Parsing JSON text gives back a string', 0.25),
      mc('int-keys-survive', 'Number keys stay numbers after a JSON round trip', 0.25, PY),
      mc('dumps-single-quotes', 'json.dumps writes strings with single quotes', 0.2, PY),
      mc('stringify-keeps-undefined', 'JSON.stringify keeps properties whose value is undefined', 0.25, JS),
    ],
    example: 'data = json.loads(text); text = json.dumps(data)',
    jsExample: 'const data = JSON.parse(text); const out = JSON.stringify(data);',
  }),
  def({
    tag: 'modules-imports', langs: ALL, name: 'Import from a module', prereqs: ['function-def-call'], allowedImports: ['math'],
    misconceptions: [
      mc('from-import-binds-module', 'from math import sqrt also makes math usable', 0.25, PY),
      mc('import-runs-nothing', "Importing a module never runs its top-level code", 0.2),
      mc('import-twice-reruns', 'Importing a module twice runs its code twice', 0.2),
      mc('default-import-is-named', "import x from './m' gets the export named x", 0.2, JS),
    ],
    example: 'from math import sqrt',
    jsExample: "import { readFile } from 'node:fs/promises';",
  }),
  def({
    tag: 'off-by-one', langs: ALL, name: 'Count boundaries exactly', prereqs: ['for-range-bounds', 'list-indexing'],
    misconceptions: [
      mc('last-index-is-length', LAST_IS_LEN, 0.3),
      mc('count-is-difference', 'The count of numbers from a to b is b minus a', 0.25),
      mc('le-visits-each-once', 'Looping while i <= len visits every item exactly once', 0.25),
    ],
    example: 'range(len(xs) - 1)  # stops before the last pair',
    jsExample: 'for (let i = 0; i < xs.length - 1; i++) {...}',
  }),

  // ---- JavaScript / TypeScript ------------------------------------------------------------------
  def({
    tag: 'null-undefined', langs: JS, name: 'Null versus undefined', prereqs: ['variables-assignment'], typeSensitive: true,
    misconceptions: [
      mc('missing-property-null', 'A missing property is null', 0.3),
      mc('typeof-null-is-null', "typeof null gives 'null'", 0.25),
      mc('null-strict-equals-undefined', 'null === undefined is true', 0.2),
      mc('undefined-plus-number', 'undefined + 1 gives 1', 0.2),
    ],
    example: "obj.missing -> undefined; typeof null -> 'object'",
  }),
  def({
    tag: 'loose-vs-strict-equality', langs: JS, name: 'Strict equality with ===', prereqs: ['comparison-equality', 'str-vs-number'],
    alternatives: ['comparison-equality'],
    misconceptions: [
      mc('loose-equals-strict', '== and === always give the same answer', 0.3),
      mc('strict-converts-types', "'1' === 1 is true", 0.25),
      mc('nan-equals-itself', 'NaN === NaN is true', 0.2),
      mc('null-loose-zero', 'null == 0 is true', 0.15),
    ],
    example: "'1' == 1 -> true; '1' === 1 -> false",
  }),
  def({
    tag: 'let-const-var-scope', langs: JS, name: 'Block scope: let and const', prereqs: ['variables-assignment', 'conditionals'],
    misconceptions: [
      mc('const-freezes-contents', "const makes an object's contents unchangeable", 0.35),
      mc('let-visible-after-block', 'A let inside a block is visible after it', 0.25),
      mc('var-block-scoped', 'A var inside a block disappears after the block', 0.2),
      mc('use-before-let-undefined', 'Using a let before its line gives undefined', 0.15),
    ],
    example: 'const xs = []; xs.push(1);  // allowed: the binding is constant',
  }),
  def({
    tag: 'array-map-filter-reduce', langs: JS, name: 'Map, filter and reduce', prereqs: ['function-return-vs-print', 'list-indexing'],
    alternatives: ['loop-accumulator'],
    misconceptions: [
      mc('map-changes-original', 'map changes the original array', 0.3),
      mc('braces-implicit-return', 'An arrow function with braces returns its last expression', 0.3),
      mc('reduce-starts-at-zero', 'reduce without a start value starts from 0', 0.2),
      mc('filter-keeps-failing', 'filter keeps the items where the test is false', 0.15),
    ],
    example: 'xs.map((x) => x * 2).filter((x) => x > 2)',
  }),
  def({
    tag: 'object-property-access', langs: JS, name: 'Access object properties', prereqs: ['variables-assignment', 'str-vs-number'],
    alternatives: ['dict-access-missing-key'],
    misconceptions: [
      mc('dot-uses-variable', 'obj.key uses the value of the variable key', 0.3),
      mc('property-of-undefined-ok', 'Reading a property of undefined just gives undefined', 0.25),
      mc('bracket-literal-name', 'obj[key] looks up a property literally named key', 0.2),
      mc('number-keys-distinct', "obj[1] and obj['1'] are different properties", 0.15),
    ],
    example: 'obj[key]  // the property named by key, not "key"',
  }),
  def({
    tag: 'callbacks-event-loop', langs: JS, name: 'Callbacks run later', prereqs: ['function-def-call'],
    misconceptions: [
      mc('timeout-zero-immediate', 'setTimeout with 0 runs before the next line', 0.35),
      mc('timeout-before-promise', 'A setTimeout 0 callback runs before a promise callback', 0.25),
      mc('callback-runs-when-passed', 'A callback runs as soon as it is passed in', 0.2),
    ],
    example: "setTimeout(() => console.log('later'), 0); console.log('now');",
  }),
  def({
    tag: 'promise-basics', langs: JS, name: 'Promises and then', prereqs: ['callbacks-event-loop'],
    misconceptions: [
      mc('then-runs-immediately', 'A then callback runs before the next line', 0.35),
      mc('log-promise-shows-value', 'Logging a promise prints its value', 0.25),
      mc('executor-runs-later', 'The function given to new Promise runs later', 0.2),
    ],
    example: 'Promise.resolve(5).then((n) => console.log(n));',
  }),
  def({
    tag: 'await-sequencing', langs: JS, name: 'Await in sequence', prereqs: ['promise-basics'], parent: 'promise-basics',
    misconceptions: [
      mc('await-blocks-program', 'await pauses the whole program, not just this function', 0.3),
      mc('async-returns-value', 'Calling an async function gives back its value directly', 0.3),
      mc('foreach-awaits', 'forEach with an async callback waits for each one', 0.2),
    ],
    example: 'const a = await first(); const b = await second(a);',
  }),
  def({
    tag: 'async-error-handling', langs: JS, name: 'Catch async errors', prereqs: ['await-sequencing', 'exceptions-try-except'],
    parent: 'promise-basics',
    misconceptions: [
      mc('try-catches-unawaited', 'try/catch catches a rejected promise even without await', 0.3),
      mc('async-throw-is-sync', 'Throwing inside an async function throws at the call', 0.25),
      mc('catch-ends-chain', 'After .catch, later .then callbacks never run', 0.2),
    ],
    example: 'try { await load(); } catch (e) { console.log(e.message); }',
  }),
  def({
    tag: 'this-method-call', langs: JS, name: 'this in method calls', prereqs: ['object-property-access', 'function-def-call'],
    misconceptions: [
      mc('detached-keeps-this', 'A method keeps its object as this when stored in a variable', 0.3),
      mc('callback-this-outer', "A regular function callback sees the outer method's this", 0.25),
      mc('this-is-function', 'this inside a method means the function itself', 0.15),
    ],
    example: 'const f = obj.greet; f();  // this is lost',
  }),
  def({
    tag: 'this-arrow-vs-function', langs: JS, name: 'Arrow functions keep outer this', prereqs: ['this-method-call'],
    parent: 'this-method-call',
    misconceptions: [
      mc('arrow-own-this', 'An arrow function gets this from whoever calls it', 0.3),
      mc('arrow-method-sees-object', 'An arrow function used as a method sees the object as this', 0.3),
      mc('nested-function-inherits-this', 'A nested regular function inherits the outer this', 0.2),
    ],
    example: 'setTimeout(() => this.tick(), 0);  // the arrow keeps this',
  }),
  def({
    tag: 'type-annotations', langs: TS, name: 'Type annotations are erased', prereqs: ['variables-assignment', 'function-def-call'],
    typeSensitive: true,
    misconceptions: [
      mc('types-checked-at-runtime', 'Type annotations are checked while the program runs', 0.35),
      mc('annotation-converts', 'Annotating a value as number converts it to a number', 0.25),
      mc('as-converts-value', 'x as number turns the value into a number', 0.25),
    ],
    example: 'function area(w: number, h: number): number { return w * h; }',
  }),

  // ---- project concepts with no canonical tag ---------------------------------------------------
  def({
    tag: OTHER_TAG, langs: ALL, name: 'Project concept', prereqs: [], misconceptions: [],
    example: '',
  }),
];

/** Every canonical tag, fundamentals first, 'other' last. */
export const CANONICAL_TAGS: readonly string[] = DEFS.map((d) => d.tag);

export const TAXONOMY: Record<string, TaxonomyEntry> = Object.fromEntries(DEFS.map((d) => [d.tag, d]));

const ORDER = new Map(CANONICAL_TAGS.map((t, i) => [t, i]));
const byOrder = (a: string, b: string) => (ORDER.get(a) ?? 1e9) - (ORDER.get(b) ?? 1e9);

export function tagInfo(tag: string): TaxonomyEntry | undefined {
  return Object.prototype.hasOwnProperty.call(TAXONOMY, tag) ? TAXONOMY[tag] : undefined;
}

/** Map free text from a model ('List Slicing', 'list_slicing') to a canonical tag, else 'other'. */
export function canonicalTag(tag: string): string {
  const t = (tag ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return tagInfo(t) ? t : OTHER_TAG;
}

export function isSemantics(tag: string): boolean {
  return tagInfo(tag)?.kind === 'semantics';
}

/** Real tags of a language (never 'other'), in canonical order. */
export function tagsFor(lang: Lang): string[] {
  return CANONICAL_TAGS.filter((t) => t !== OTHER_TAG && TAXONOMY[t].langs.includes(lang));
}

/** The tag's misconceptions that apply to this language. */
export function misconceptionsFor(tag: string, lang: Lang): TaxonomyMisconception[] {
  return (tagInfo(tag)?.misconceptions ?? []).filter((m) => !m.langs || m.langs.includes(lang));
}

export function findMisconception(tag: string, id: string): TaxonomyMisconception | undefined {
  return tagInfo(tag)?.misconceptions.find((m) => m.id === id);
}

/** One-line picker example in the learner's language. */
export function exampleFor(tag: string, lang: Lang): string {
  const e = tagInfo(tag);
  if (!e) return '';
  return lang !== 'python' && e.jsExample ? e.jsExample : e.example ?? '';
}

function inLang(tag: string, lang?: Lang): boolean {
  return !lang || (tagInfo(tag)?.langs.includes(lang) ?? false);
}

/** Every tag this one transitively builds on (prerequisites and parents), canonical order. */
export function ancestors(tag: string, lang?: Lang): string[] {
  const seen = new Set<string>();
  const stack = [tag];
  while (stack.length) {
    const e = tagInfo(stack.pop()!);
    if (!e) continue;
    for (const p of e.parent ? [...e.prereqs, e.parent] : e.prereqs) {
      if (p === tag || seen.has(p) || !inLang(p, lang)) continue;
      seen.add(p);
      stack.push(p);
    }
  }
  return [...seen].sort(byOrder);
}

const dependents = new Map<string, string[]>();
for (const d of DEFS) {
  for (const p of new Set(d.parent ? [...d.prereqs, d.parent] : d.prereqs)) {
    dependents.set(p, [...(dependents.get(p) ?? []), d.tag]);
  }
}

/** Every tag that transitively builds on this one, canonical order. */
export function descendants(tag: string, lang?: Lang): string[] {
  const seen = new Set<string>();
  const stack = [tag];
  while (stack.length) {
    for (const c of dependents.get(stack.pop()!) ?? []) {
      if (c === tag || seen.has(c) || !inLang(c, lang)) continue;
      seen.add(c);
      stack.push(c);
    }
  }
  return [...seen].sort(byOrder);
}

/** The language's tags with every prerequisite before its dependents (Kahn, canonical tie-break). Throws on a cycle. */
export function topoOrder(lang: Lang): string[] {
  const tags = tagsFor(lang);
  const inSet = new Set(tags);
  const indeg = new Map(tags.map((t) => [t, 0]));
  for (const t of tags) {
    for (const p of new Set(TAXONOMY[t].prereqs)) if (inSet.has(p)) indeg.set(t, indeg.get(t)! + 1);
  }
  const ready = tags.filter((t) => indeg.get(t) === 0);
  const out: string[] = [];
  while (ready.length) {
    ready.sort(byOrder);
    const t = ready.shift()!;
    out.push(t);
    for (const c of dependents.get(t) ?? []) {
      if (!inSet.has(c) || !TAXONOMY[c].prereqs.includes(t)) continue;
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) ready.push(c);
    }
  }
  if (out.length !== tags.length) {
    const stuck = tags.filter((t) => !out.includes(t));
    throw new Error(`tag DAG has a cycle through: ${stuck.join(', ')}`);
  }
  return out;
}

/**
 * The ~22 fundamentals placement draws from (and the seed banks cover), per language,
 * ordered so that every prerequisite comes before the tags that need it.
 */
export const PLACEMENT_FUNDAMENTALS: Record<Lang, readonly string[]> = {
  python: [
    'variables-assignment', 'numbers-int-float', 'integer-division-modulo', 'str-vs-number',
    'string-indexing', 'string-methods', 'comparison-equality', 'conditionals', 'booleans-truthiness',
    'for-range-bounds', 'loop-accumulator', 'while-loop-termination', 'break-continue',
    'list-indexing', 'list-slicing', 'list-mutation-methods', 'alias-copy', 'string-split-join',
    'dict-access-missing-key', 'counting-with-dict', 'function-def-call', 'function-return-vs-print',
  ],
  javascript: [
    'variables-assignment', 'numbers-int-float', 'str-vs-number', 'comparison-equality',
    'loose-vs-strict-equality', 'null-undefined', 'conditionals', 'booleans-truthiness', 'let-const-var-scope',
    'string-indexing', 'string-methods', 'string-formatting', 'for-range-bounds', 'loop-accumulator',
    'list-indexing', 'list-slicing', 'list-mutation-methods', 'alias-copy', 'object-property-access',
    'function-def-call', 'function-return-vs-print', 'array-map-filter-reduce',
  ],
  typescript: [
    'variables-assignment', 'numbers-int-float', 'str-vs-number', 'comparison-equality',
    'loose-vs-strict-equality', 'null-undefined', 'conditionals', 'booleans-truthiness', 'let-const-var-scope',
    'string-indexing', 'string-methods', 'string-formatting', 'for-range-bounds', 'loop-accumulator',
    'list-indexing', 'list-slicing', 'list-mutation-methods', 'alias-copy', 'object-property-access',
    'function-def-call', 'function-return-vs-print', 'array-map-filter-reduce', 'type-annotations',
  ],
};

// ---------------------------------------------------------------- runner constructs -> tags

// BatchRecord.constructs (media/runner: the Python ast walk, the JS/TS token table) name syntax, not
// concepts. These tables say which canonical tag a construct belongs to, so the pad can keep probes
// to constructs the learner knows (spec V1-6: allowedConstructs = constructs whose tag has P >= .5,
// plus the target) and placement can filter by construct (PlacementSources.constructConcept).
// Constructs every probe leans on (print, len, list literals, let/const, typeof and JSON.stringify
// for type-visible output, plain TS annotations) map to nothing: they never make a probe confounded.

const PY_CONSTRUCTS: Record<string, string> = {
  for: 'for-range-bounds', 'call:range': 'for-range-bounds', 'call:enumerate': 'for-range-bounds',
  while: 'while-loop-termination', 'nested-loop': 'nested-loops', break: 'break-continue', continue: 'break-continue',
  'loop-else': 'break-continue', if: 'conditionals', elif: 'conditionals', else: 'conditionals', ternary: 'conditionals',
  match: 'conditionals', def: 'function-def-call', return: 'function-def-call', 'keyword-arg': 'function-def-call',
  lambda: 'function-def-call', 'default-arg': 'function-params-defaults', varargs: 'function-params-defaults',
  kwargs: 'function-params-defaults', 'nested-def': 'closure-capture', decorator: 'closure-capture',
  nonlocal: 'closure-capture', global: 'scope-local-global', recursion: 'recursion-base-case', class: 'class-def-init',
  inheritance: 'class-def-init', yield: 'generator-yield', genexp: 'generator-laziness', 'list-comp': 'list-comprehension',
  'dict-comp': 'list-comprehension', 'set-comp': 'list-comprehension', slice: 'list-slicing', index: 'list-indexing',
  'negative-index': 'list-indexing', 'dict-literal': 'dict-access-missing-key', 'set-literal': 'set-membership',
  in: 'set-membership', tuple: 'tuple-unpacking', unpack: 'tuple-unpacking', star: 'tuple-unpacking',
  'f-string': 'string-formatting', 'percent-format': 'string-formatting', try: 'exceptions-try-except',
  except: 'exceptions-try-except', finally: 'exceptions-try-except', 'try-else': 'exceptions-try-except',
  raise: 'raising-errors', assert: 'raising-errors', with: 'file-read-lines', import: 'modules-imports',
  del: 'list-mutation-methods', walrus: 'variables-assignment', 'aug-assign': 'variables-assignment',
  'chained-assign': 'variables-assignment', 'bool-op': 'booleans-truthiness', not: 'booleans-truthiness',
  is: 'identity-vs-equality', 'chained-compare': 'comparison-equality', 'floor-div': 'integer-division-modulo',
  modulo: 'integer-division-modulo', 'true-div': 'numbers-int-float', power: 'numbers-int-float',
  'call:int': 'str-vs-number', 'call:float': 'str-vs-number', 'call:str': 'str-vs-number', 'call:round': 'numbers-int-float',
  'call:sorted': 'sorting-key', 'call:open': 'file-read-lines', 'call:Counter': 'collections-counter',
  'method:append': 'list-mutation-methods', 'method:extend': 'list-mutation-methods', 'method:insert': 'list-mutation-methods',
  'method:pop': 'list-mutation-methods', 'method:remove': 'list-mutation-methods', 'method:sort': 'list-mutation-methods',
  'method:reverse': 'list-mutation-methods', 'method:clear': 'list-mutation-methods', 'method:copy': 'alias-copy',
  'method:split': 'string-split-join', 'method:join': 'string-split-join', 'method:strip': 'string-methods',
  'method:lstrip': 'string-methods', 'method:rstrip': 'string-methods', 'method:upper': 'string-methods',
  'method:lower': 'string-methods', 'method:title': 'string-methods', 'method:replace': 'string-methods',
  'method:find': 'string-methods', 'method:startswith': 'string-methods', 'method:endswith': 'string-methods',
  'method:format': 'string-formatting', 'method:get': 'dict-access-missing-key', 'method:items': 'dict-iteration',
  'method:keys': 'dict-iteration', 'method:values': 'dict-iteration', 'method:setdefault': 'counting-with-dict',
  'method:add': 'set-membership', 'method:discard': 'set-membership', 'method:most_common': 'collections-counter',
  'method:readlines': 'file-read-lines', 'method:readline': 'file-read-lines', 'method:loads': 'json-parse-serialize',
  'method:dumps': 'json-parse-serialize',
};

const JS_CONSTRUCTS: Record<string, string> = {
  for: 'for-range-bounds', 'for-of': 'for-range-bounds', 'for-in': 'dict-iteration', while: 'while-loop-termination',
  'do-while': 'while-loop-termination', 'nested-loop': 'nested-loops', break: 'break-continue', continue: 'break-continue',
  if: 'conditionals', else: 'conditionals', switch: 'conditionals', ternary: 'conditionals', function: 'function-def-call',
  arrow: 'function-def-call', return: 'function-def-call', generator: 'generator-yield', recursion: 'recursion-base-case',
  class: 'class-def-init', inheritance: 'class-def-init', new: 'class-def-init', static: 'class-def-init',
  'getter-setter': 'class-def-init', instanceof: 'class-def-init', this: 'this-method-call', async: 'await-sequencing',
  await: 'await-sequencing', promise: 'promise-basics', try: 'exceptions-try-except', catch: 'exceptions-try-except',
  finally: 'exceptions-try-except', throw: 'raising-errors', var: 'let-const-var-scope', destructure: 'tuple-unpacking',
  spread: 'alias-copy', 'optional-chain': 'null-undefined', nullish: 'null-undefined', 'strict-eq': 'comparison-equality',
  'loose-eq': 'loose-vs-strict-equality', delete: 'object-property-access', 'object-literal': 'object-property-access',
  increment: 'variables-assignment', 'aug-assign': 'variables-assignment', modulo: 'integer-division-modulo',
  power: 'numbers-int-float', index: 'list-indexing', 'template-literal': 'string-formatting',
  'call:parseInt': 'str-vs-number', 'call:parseFloat': 'str-vs-number', 'call:Number': 'str-vs-number',
  'call:String': 'str-vs-number', 'call:setTimeout': 'callbacks-event-loop', 'call:setInterval': 'callbacks-event-loop',
  'call:queueMicrotask': 'callbacks-event-loop', 'call:structuredClone': 'alias-copy',
  'method:map': 'array-map-filter-reduce', 'method:filter': 'array-map-filter-reduce', 'method:reduce': 'array-map-filter-reduce',
  'method:forEach': 'array-map-filter-reduce', 'method:push': 'list-mutation-methods', 'method:pop': 'list-mutation-methods',
  'method:shift': 'list-mutation-methods', 'method:unshift': 'list-mutation-methods', 'method:splice': 'list-mutation-methods',
  'method:sort': 'sorting-key', 'method:reverse': 'list-mutation-methods', 'method:slice': 'list-slicing',
  'method:at': 'list-indexing', 'method:split': 'string-split-join', 'method:join': 'string-split-join',
  'method:trim': 'string-methods', 'method:toUpperCase': 'string-methods', 'method:toLowerCase': 'string-methods',
  'method:replace': 'string-methods', 'method:replaceAll': 'string-methods', 'method:startsWith': 'string-methods',
  'method:endsWith': 'string-methods', 'method:padStart': 'string-formatting', 'method:padEnd': 'string-formatting',
  'method:toFixed': 'string-formatting', 'method:then': 'promise-basics', 'method:catch': 'promise-basics',
  'method:keys': 'dict-iteration', 'method:values': 'dict-iteration', 'method:entries': 'dict-iteration',
  'method:has': 'set-membership', 'method:add': 'set-membership', 'method:parse': 'json-parse-serialize',
  'method:call': 'this-method-call', 'method:bind': 'this-method-call', 'method:apply': 'this-method-call',
  // A plain annotation changes no output; casts and declared types are what the tag's beliefs are about.
  interface: 'type-annotations', 'type-alias': 'type-annotations',
  enum: 'type-annotations', generic: 'type-annotations', 'as-cast': 'type-annotations', 'non-null': 'type-annotations',
};

/**
 * The canonical tag a runner construct belongs to in `lang`, or undefined for basics every probe may
 * use (and for a tag that does not exist in that language).
 */
export function constructTag(construct: string, lang: Lang): string | undefined {
  const tag = (lang === 'python' ? PY_CONSTRUCTS : JS_CONSTRUCTS)[construct];
  return tag && TAXONOMY[tag]?.langs.includes(lang) ? tag : undefined;
}
