"""Deliberate batch runner (Python 3.8+): many model/seed snippets in one process.

usage: python -s -B -X utf8 [-P] batch.py <items.json> [--start N] [--timeout-ms N] [--max-out N]

<items.json> is a JSON array of {id, code, wantTrace?}. For each item from index --start on:
  @@DLB_START <json id>
  @@DLB {"id", "stdout", "values", "exception"?, "error"?, "exitOk", "timedOut", "ms",
         "constructs", "trace"?}
Each item runs in a fresh namespace with stdout captured and print() wrapped to record every
argument's type, repr and typed value. A snippet still running after the timeout is stopped by
faulthandler, which exits the whole process: the parent marks that item timedOut and starts a
new process with --start past it (Python threads cannot be killed, so there is no watchdog).
"""
import ast
import builtins
import contextlib
import faulthandler
import importlib.util
import io
import json
import linecache
import os
import sys
import time
import traceback
import types

HERE = os.path.dirname(os.path.abspath(__file__))
SNIPPET = '<snippet>'
MAX_PRINTS = 200          # print() calls recorded per item
MAX_ERROR = 1000          # traceback tail kept per item
TRACE_EVENTS = 5000       # line events traced per item before tracing stops
TRACE_REPR = 40
TRACE_TEXT = 60


def _load_prelude():
    # Loaded by path: with -P the script's own folder is not on sys.path.
    spec = importlib.util.spec_from_file_location('prelude', os.path.join(HERE, 'prelude.py'))
    mod = importlib.util.module_from_spec(spec)
    sys.modules['prelude'] = mod
    spec.loader.exec_module(mod)
    return mod


prelude = _load_prelude()
REAL_OUT = sys.stdout


def emit(tag, payload):
    REAL_OUT.write('%s %s\n' % (tag, json.dumps(payload, ensure_ascii=True)))
    REAL_OUT.flush()


class CappedText(io.StringIO):
    """stdout/stderr stand-in that keeps the first `cap` characters and drops the rest."""

    def __init__(self, cap):
        super().__init__()
        self.cap = cap
        self.size = 0

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError('write() argument must be str, not %s' % type(s).__name__)
        n = len(s)
        room = self.cap - self.size
        if room > 0:
            part = s[:room]
            self.size += len(part)
            super().write(part)
        return n


# ------------------------------------------------------------------ constructs (ast walk)

BUILTIN_NAMES = frozenset(n for n in dir(builtins) if not n.startswith('_'))


class Constructs(ast.NodeVisitor):
    """Constructs a snippet uses, named the same way as the JS token table where they overlap."""

    def __init__(self):
        self.found = set()
        self.funcs = []
        self.loops = 0

    def add(self, *names):
        self.found.update(names)

    def _loop(self, node):
        if self.loops:
            self.add('nested-loop')
        self.loops += 1
        self.generic_visit(node)
        self.loops -= 1

    def visit_For(self, node):
        self.add('for')
        if isinstance(node.target, (ast.Tuple, ast.List)):
            self.add('unpack')
        if node.orelse:
            self.add('loop-else')
        self._loop(node)

    def visit_AsyncFor(self, node):
        self.add('async')
        self.visit_For(node)

    def visit_While(self, node):
        self.add('while')
        if node.orelse:
            self.add('loop-else')
        self._loop(node)

    def _func(self, node):
        self.add('def')
        if self.funcs:
            self.add('nested-def')
        if node.decorator_list:
            self.add('decorator')
        a = node.args
        if a.defaults or any(d is not None for d in a.kw_defaults):
            self.add('default-arg')
        if a.vararg:
            self.add('varargs')
        if a.kwarg:
            self.add('kwargs')
        loops, self.loops = self.loops, 0
        self.funcs.append(node.name)
        self.generic_visit(node)
        self.funcs.pop()
        self.loops = loops

    def visit_FunctionDef(self, node):
        self._func(node)

    def visit_AsyncFunctionDef(self, node):
        self.add('async')
        self._func(node)

    def visit_Lambda(self, node):
        self.add('lambda')
        self.generic_visit(node)

    def visit_ClassDef(self, node):
        self.add('class')
        if node.bases:
            self.add('inheritance')
        self.generic_visit(node)

    def visit_Call(self, node):
        f = node.func
        if isinstance(f, ast.Name):
            if f.id in self.funcs:
                self.add('recursion')
            elif f.id in BUILTIN_NAMES:
                self.add('call:' + f.id)
        elif isinstance(f, ast.Attribute):
            self.add('method:' + f.attr)
        if node.keywords:
            self.add('keyword-arg')
        self.generic_visit(node)

    def visit_Subscript(self, node):
        s = node.slice
        if type(s).__name__ == 'Index':  # Python 3.8 wraps plain subscripts
            s = s.value
        if isinstance(s, ast.Slice):
            self.add('slice')
        else:
            self.add('index')
            if isinstance(s, ast.UnaryOp) and isinstance(s.op, ast.USub):
                self.add('negative-index')
        self.generic_visit(node)

    def visit_If(self, node):
        self.add('if')
        if len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
            self.add('elif')
        elif node.orelse:
            self.add('else')
        self.generic_visit(node)

    def visit_Compare(self, node):
        for op in node.ops:
            if isinstance(op, (ast.Is, ast.IsNot)):
                self.add('is')
            elif isinstance(op, (ast.In, ast.NotIn)):
                self.add('in')
        if len(node.ops) > 1:
            self.add('chained-compare')
        self.generic_visit(node)

    def visit_BinOp(self, node):
        op = node.op
        if isinstance(op, ast.FloorDiv):
            self.add('floor-div')
        elif isinstance(op, ast.Div):
            self.add('true-div')
        elif isinstance(op, ast.Pow):
            self.add('power')
        elif isinstance(op, ast.Mod):
            left = node.left
            is_fmt = isinstance(left, ast.Constant) and isinstance(left.value, str)
            self.add('percent-format' if is_fmt else 'modulo')
        self.generic_visit(node)

    def visit_Assign(self, node):
        if len(node.targets) > 1:
            self.add('chained-assign')
        if any(isinstance(t, (ast.Tuple, ast.List)) for t in node.targets):
            self.add('unpack')
        self.generic_visit(node)

    def visit_Try(self, node):
        self.add('try')
        if node.handlers:
            self.add('except')
        if node.finalbody:
            self.add('finally')
        if node.orelse:
            self.add('try-else')
        self.generic_visit(node)

    visit_TryStar = visit_Try

    def visit_Tuple(self, node):
        if isinstance(node.ctx, ast.Load):
            self.add('tuple')
        self.generic_visit(node)

    def visit_Constant(self, node):
        if isinstance(node.value, bytes):
            self.add('bytes')


SIMPLE = {
    'Return': 'return', 'Yield': 'yield', 'YieldFrom': 'yield', 'Await': 'await',
    'ListComp': 'list-comp', 'DictComp': 'dict-comp', 'SetComp': 'set-comp',
    'GeneratorExp': 'genexp', 'Dict': 'dict-literal', 'List': 'list-literal', 'Set': 'set-literal',
    'JoinedStr': 'f-string', 'Raise': 'raise', 'With': 'with', 'AsyncWith': 'with',
    'Assert': 'assert', 'Import': 'import', 'ImportFrom': 'import', 'Global': 'global',
    'Nonlocal': 'nonlocal', 'Break': 'break', 'Continue': 'continue', 'Delete': 'del',
    'NamedExpr': 'walrus', 'AugAssign': 'aug-assign', 'Starred': 'star', 'BoolOp': 'bool-op',
    'IfExp': 'ternary', 'Match': 'match',
}


def _simple_visitor(name):
    def visit(self, node):
        self.add(name)
        self.generic_visit(node)
    return visit


for _node, _name in SIMPLE.items():
    if not hasattr(Constructs, 'visit_' + _node):
        setattr(Constructs, 'visit_' + _node, _simple_visitor(_name))


def _visit_unary(self, node):
    if isinstance(node.op, ast.Not):
        self.add('not')
    self.generic_visit(node)


Constructs.visit_UnaryOp = _visit_unary


def constructs_of(tree):
    v = Constructs()
    v.visit(tree)
    return sorted(v.found)


# ------------------------------------------------------------------ state trace (sys.settrace)

_SKIP_IN_TRACE = (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, type,
                  types.MethodType)
_IMMUTABLE = (int, float, complex, str, bytes, bool, type(None), tuple, frozenset, range)


class Tracer:
    """Per snippet line: the names in scope after the line LAST ran ('a=[1, 2]  b is a'),
    prefixed with 'x3' when it ran 3 times."""

    def __init__(self, tree):
        self.last = {}     # frame -> line it is on
        self.counts = {}   # line -> times run
        self.text = {}     # line -> snapshot text
        self.events = 0
        # A line re-run without leaving it is a new iteration only on a loop statement's line
        # (`for x in xs: total += x`). Elsewhere it is an inlined comprehension (3.12+) looping.
        self.loop_lines = {n.lineno for n in ast.walk(tree) if isinstance(n, (ast.For, ast.AsyncFor, ast.While))}

    def start(self):
        sys.settrace(self.global_trace)

    def stop(self):
        sys.settrace(None)

    def global_trace(self, frame, event, arg):
        code = frame.f_code
        # Comprehensions, lambdas and genexps would inflate counts on their own line.
        if code.co_filename != SNIPPET or (code.co_name.startswith('<') and code.co_name != '<module>'):
            return None
        return self.local_trace

    def local_trace(self, frame, event, arg):
        if event == 'line':
            self.events += 1
            if self.events > TRACE_EVENTS:
                sys.settrace(None)
                frame.f_trace = None
                return None
            prev = self.last.get(frame)
            line = frame.f_lineno
            if prev is not None:
                self.text[prev] = self.snapshot(frame, prev)
            if prev != line or line in self.loop_lines:
                self.counts[line] = self.counts.get(line, 0) + 1
            self.last[frame] = line
        elif event == 'return':
            prev = self.last.pop(frame, None)
            if prev is not None:
                self.text[prev] = self.snapshot(frame, prev)
        return self.local_trace

    def snapshot(self, frame, line):
        parts = []
        owners = {}
        try:
            names = list(frame.f_locals.items())
        except Exception:
            names = []
        for k, v in names:
            if k.startswith('__') or k.startswith('.') or isinstance(v, _SKIP_IN_TRACE):
                continue
            if not isinstance(v, _IMMUTABLE):
                first = owners.get(id(v))
                if first is not None:
                    parts.append('%s is %s' % (k, first))
                    continue
                owners[id(v)] = k
            r = prelude.safe_repr(v, None)
            if len(r) > TRACE_REPR:
                r = r[:TRACE_REPR - 3] + '...'
            parts.append('%s=%s' % (k, r))
        n = self.counts.get(line, 0)
        text = '  '.join(parts)
        if n > 1:
            text = ('x%d  %s' % (n, text)).rstrip()
        if len(text) > TRACE_TEXT:
            text = text[:TRACE_TEXT - 3] + '...'
        return text

    def result(self):
        return [{'line': ln, 'text': t} for ln, t in sorted(self.text.items()) if t]


# ------------------------------------------------------------------ running one item

def make_builtins(values):
    """A builtins dict for one snippet: print() records typed values, check() is predefined."""
    b = dict(builtins.__dict__)
    real_print = builtins.print
    capturing = [False]

    def print(*args, sep=' ', end='\n', file=None, flush=False):  # noqa: A001 - shadows on purpose
        if capturing[0]:
            return  # a __repr__ that prints, called again by our capture: no duplicate output
        real_print(*args, sep=sep, end=end, file=file, flush=flush)
        if (file is None or file is sys.stdout) and len(values) < MAX_PRINTS:
            capturing[0] = True
            try:
                values.append([prelude.printed_arg(a) for a in args])
            finally:
                capturing[0] = False

    b['print'] = print
    b['check'] = prelude.check
    return b


def format_error(e):
    """Traceback limited to snippet frames (the runner's own frames are noise), plus the exception."""
    frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == SNIPPET]
    parts = []
    if frames:
        parts.append('Traceback (most recent call last):\n')
        parts.extend(traceback.format_list(frames))
    parts.extend(traceback.format_exception_only(type(e), e))
    if isinstance(e, prelude.DeliberateSandbox) and getattr(e, 'detail', ''):
        parts.append('(blocked: %s)\n' % e.detail)
    return ''.join(parts)[-MAX_ERROR:]


def run_item(item, max_out):
    code = item.get('code') or ''
    rec = {'id': item.get('id'), 'stdout': '', 'values': [], 'exitOk': False, 'timedOut': False,
           'ms': 0, 'constructs': []}
    out = CappedText(max_out)
    err = CappedText(max_out)
    values = []
    tracer = None
    t0 = time.perf_counter()
    try:
        tree = ast.parse(code, SNIPPET)
        rec['constructs'] = constructs_of(tree)
        if item.get('wantTrace'):
            tracer = Tracer(tree)
        compiled = compile(tree, SNIPPET, 'exec')
        linecache.cache[SNIPPET] = (len(code), None, code.splitlines(True), SNIPPET)
        ns = {'__name__': '__main__', '__builtins__': make_builtins(values)}
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            if tracer:
                tracer.start()
            try:
                exec(compiled, ns)
            finally:
                if tracer:
                    tracer.stop()
        rec['exitOk'] = True
    except SystemExit as e:
        rec['exitOk'] = e.code in (None, 0)
        if not rec['exitOk']:
            rec['exception'] = 'SystemExit'
            rec['error'] = 'SystemExit: %s' % (e.code,)
    except BaseException as e:
        rec['exception'] = type(e).__name__
        tail = err.getvalue()
        rec['error'] = ((tail + '\n') if tail else '') + format_error(e)
        rec['error'] = rec['error'][-MAX_ERROR:]
    rec['ms'] = round((time.perf_counter() - t0) * 1000, 2)
    rec['stdout'] = out.getvalue()
    rec['values'] = values
    if tracer:
        rec['trace'] = tracer.result()
    return rec


def parse_args(argv):
    opts = {'path': None, 'start': 0, 'timeout_ms': 3000, 'max_out': 20000}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ('--start', '--timeout-ms', '--max-out') and i + 1 < len(argv):
            opts[a[2:].replace('-', '_')] = int(argv[i + 1])
            i += 2
        else:
            opts['path'] = a
            i += 1
    return opts


def main(argv):
    opts = parse_args(argv)
    if not opts['path']:
        sys.stderr.write('usage: batch.py <items.json> [--start N] [--timeout-ms N] [--max-out N]\n')
        return 2
    with open(opts['path'], encoding='utf-8') as f:
        items = json.load(f)
    prelude.install_sandbox(os.getcwd())
    timeout_s = max(0.05, opts['timeout_ms'] / 1000.0)
    for item in items[opts['start']:]:
        emit('@@DLB_START', item.get('id'))
        # On timeout faulthandler dumps the stack to the real stderr and exits the process.
        faulthandler.dump_traceback_later(timeout_s, exit=True, file=sys.__stderr__)
        try:
            rec = run_item(item, opts['max_out'])
        finally:
            faulthandler.cancel_dump_traceback_later()
        emit('@@DLB', rec)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
