"""Deliberate behaviour-spec harness (Python 3.8+), spec V1-11.

usage: python -E -B -X utf8 [prelude.py] harness.py <module file> <spec json>

<spec json> (written by src/specsCore.ts buildHarnessInput):
  {"workspace"?: str, "timeoutMs"?: int, "functions"?: [str],
   "specs": [{"id", "call", "expected", "expectError", "signatures"?: [{"match", "value"}]}]}

stdout protocol, one flushed line each (src/specsCore.ts parseHarnessOutput reads it):
  @@DLB_PLAN ["id", ...]                     spec ids in ladder order, printed before the import
  @@DLB_LOAD {"importMs", "loadError"?}      after the import; a loadError ends the run
  @@DLB_START <id>                           before each spec
  @@DLB {"id", "pass", "status", "actual"?, "error"?, "exception"?, "line"?, "sig"?, "stdout"?, "val"?}
  @@DLB_END {"timedOut"?}                    the harness finished on its own

Module loading: the module is imported normally under a non-__main__ name ('dlb_<module>'), so
`if __name__ == '__main__'` blocks do not run while ordinary top-level assignments do. input()
and sys.argv[1:] raise DeliberateTopLevel, and a top-level run past the time limit is reported the
same way: entry code that belongs under the main guard. The audit-hook sandbox of
media/runner/prelude.py blocks writes outside the run temp dir, processes and sockets.

Calls and expected values are parsed with ast / ast.literal_eval only: nothing in the spec file
is ever evaluated as code. probe.py reuses Session and parse_call from this file.
"""
import ast
import builtins
import contextlib
import importlib.util
import io
import json
import os
import re
import signal
import sys
import threading
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER_DIR = os.path.join(os.path.dirname(HERE), 'runner')

TOP_LEVEL_NUDGE = "top-level code runs on import: move it under if __name__ == '__main__'"
SLOW_IMPORT = 'importing took longer than %.1f s: is a library slow to load?'
TIMEOUT_TEXT = 'timeout (infinite loop?)'
DEFAULT_TIMEOUT_MS = 5000
MARGIN_MS = 400          # stop on our own this long before the parent kills the process
ACTUAL_MAX = 200         # contracts SpecResult.actual
ERROR_MAX = 300
STDOUT_MAX = 300         # learner print() output kept per call
VAL_JSON_MAX = 2000      # typed values above this size are left out of spec records
REAL_OUT = sys.stdout


def emit(tag, payload=None):
    line = tag if payload is None else '%s %s' % (tag, payload if isinstance(payload, str) else _dumps(payload))
    REAL_OUT.write(line + '\n')
    REAL_OUT.flush()


def _dumps(obj):
    try:
        return json.dumps(obj, ensure_ascii=True, allow_nan=False)
    except (TypeError, ValueError):
        obj = {k: v for k, v in obj.items() if k != 'val'} if isinstance(obj, dict) else obj
        return json.dumps(obj, ensure_ascii=True, default=str)


def short(text, limit):
    text = str(text)
    return text if len(text) <= limit else text[:limit - 3] + '...'


class CappedText(io.StringIO):
    """stdout/stderr stand-in that keeps the first `cap` characters."""

    def __init__(self, cap):
        super().__init__()
        self.cap = cap
        self.size = 0

    def reconfigure(self, *args, **kwargs):
        """`sys.stdout.reconfigure(encoding='utf-8')` is a common first line of Windows scripts."""

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError('write() argument must be str, not %s' % type(s).__name__)
        room = self.cap - self.size
        if room > 0:
            part = s[:room]
            self.size += len(part)
            super().write(part)
        return len(s)


# ------------------------------------------------------------------ sandbox (prelude.py)

class _FallbackPrelude:
    """Used only when media/runner/prelude.py is missing: the same audit-hook rules, and typed
    values reduced to 'opaque'."""
    SANDBOX_MESSAGE = ('your code tried to write a file or start a process while being checked: '
                       'keep that in the main block')

    class DeliberateSandbox(Exception):
        def __init__(self, event='', detail=''):
            super().__init__(_FallbackPrelude.SANDBOX_MESSAGE)
            self.event = event
            self.detail = detail

    _ALWAYS = ('subprocess.Popen', 'os.system', 'os.exec', 'os.posix_spawn', 'os.spawn', 'os.startfile',
               'os.fork', 'os.forkpty', 'pty.spawn', '_winapi.CreateProcess', 'os.kill', 'os.killpg',
               'webbrowser.open', 'socket.connect', 'socket.sendto', 'socket.sendmsg', 'socket.bind',
               'ctypes.dlopen', 'os.symlink', 'os.link', '_winapi.CreateJunction')
    _PATHS = ('os.remove', 'os.rmdir', 'os.mkdir', 'os.rename', 'os.truncate', 'os.chmod', 'os.utime')

    def __init__(self):
        self.tmp = None
        self.sandbox_hits = []
        self.DeliberateSandbox.__module__ = 'builtins'

    def safe_repr(self, x, limit=2000):
        try:
            r = repr(x)
        except BaseException as e:
            r = '<unrepresentable %s: %s>' % (type(x).__name__, type(e).__name__)
        return r if limit is None or len(r) <= limit else r[:limit]

    def encode_val(self, x):
        return {'t': 'opaque', 'type': type(x).__name__, 'repr': self.safe_repr(x, 200)}

    def _outside(self, p):
        if p is None or isinstance(p, int):
            return False
        try:
            full = os.path.normcase(os.path.abspath(os.fsdecode(os.fspath(p))))
        except TypeError:
            return True
        if full == os.path.normcase(os.path.abspath(os.devnull)):
            return False
        return not (full == self.tmp or full.startswith(self.tmp.rstrip(os.sep) + os.sep))

    def _hook(self, event, args):
        why = None
        if event == 'open':
            path, mode, flags = (tuple(args) + (None, None, None))[:3]
            writing = (isinstance(mode, str) and any(c in mode for c in 'wax+')) or (
                isinstance(flags, int) and bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC)))
            if writing and self._outside(path):
                why = 'open %r for writing' % (path,)
        elif event.startswith(self._ALWAYS) or event.startswith('shutil.'):
            why = event
        elif event in self._PATHS and args and self._outside(args[0]):
            why = '%s %r' % (event, args[0])
        if why is not None:
            self.sandbox_hits.append((event, why))
            raise self.DeliberateSandbox(event, why)

    def install_sandbox(self, tmp=None):
        if self.tmp is None:
            self.tmp = os.path.normcase(os.path.abspath(tmp or os.getcwd()))
            sys.addaudithook(self._hook)
        return self.tmp


def _load_prelude():
    mod = sys.modules.get('prelude')
    if mod is not None and hasattr(mod, 'install_sandbox'):
        return mod  # started through prelude.py: the hook is already in place
    path = os.path.join(RUNNER_DIR, 'prelude.py')
    if os.path.isfile(path):
        try:
            spec = importlib.util.spec_from_file_location('prelude', path)
            mod = importlib.util.module_from_spec(spec)
            sys.modules['prelude'] = mod
            spec.loader.exec_module(mod)
            return mod
        except Exception:
            sys.modules.pop('prelude', None)
    return _FallbackPrelude()


prelude = _load_prelude()
DeliberateSandbox = prelude.DeliberateSandbox


# ------------------------------------------------------------------ entry-point sentinels

class DeliberateTopLevel(BaseException):
    """input() or sys.argv[1:] used while the module is checked. A BaseException, so a learner's
    `except Exception` cannot swallow it."""

    def __init__(self, what, message):
        super().__init__(message)
        self.what = what


DeliberateTopLevel.__module__ = 'builtins'


class TimedOut(BaseException):
    """The run's deadline passed while learner code was running."""


class _Argv(list):
    """sys.argv with only the program name: reading any argument raises DeliberateTopLevel.
    len() is 1, so `if len(sys.argv) > 1` checks behave as if no arguments were given."""

    def __init__(self, items, session):
        super().__init__(items)
        self._session = session

    def __getitem__(self, i):
        if isinstance(i, slice):
            if i.start in (None, 0) and i.stop is not None and 0 <= i.stop <= 1 and i.step in (None, 1):
                return list.__getitem__(self, i)
        elif i == 0:
            return list.__getitem__(self, 0)
        raise self._session.entry_error('sys.argv')

    def pop(self, i=-1):
        raise self._session.entry_error('sys.argv')


# ------------------------------------------------------------------ watchdog

def _interrupt_main():
    """KeyboardInterrupt in the main thread. raise_signal also wakes time.sleep() on Windows;
    pthread_kill does it elsewhere (the audit hook blocks os.kill)."""
    try:
        if os.name == 'nt':
            signal.raise_signal(signal.SIGINT)
        else:
            signal.pthread_kill(threading.main_thread().ident, signal.SIGINT)
    except Exception:
        import _thread
        _thread.interrupt_main()


class Watchdog:
    """Interrupts the main thread once an armed deadline passes. Python threads cannot be killed,
    so the parent's process timeout stays the backstop (C code that never checks signals, or code
    that swallows KeyboardInterrupt in a loop)."""

    REFIRE_S = 0.25
    MAX_FIRES = 4

    def __init__(self):
        self._cond = threading.Condition()
        self._deadline = None
        self._fires = 0
        self.fired = False
        threading.Thread(target=self._run, name='deliberate-watchdog', daemon=True).start()

    def arm(self, seconds):
        with self._cond:
            self._deadline = time.monotonic() + max(0.0, seconds)
            self._cond.notify()

    def disarm(self):
        with self._cond:
            self._deadline = None
            self._cond.notify()

    def _run(self):
        with self._cond:
            while True:
                if self._deadline is None:
                    self._cond.wait()
                    continue
                left = self._deadline - time.monotonic()
                if left > 0:
                    self._cond.wait(left)
                    continue
                self.fired = True
                self._fires += 1
                # Fire again shortly in case learner code swallowed the interrupt.
                self._deadline = time.monotonic() + self.REFIRE_S if self._fires < self.MAX_FIRES else None
                _interrupt_main()


# ------------------------------------------------------------------ calls and values

def parse_call(text):
    """(callee, args, kwargs) of exactly one call `name(literal, ..., key=literal)`. Arguments go
    through ast.literal_eval; anything else raises ValueError."""
    try:
        tree = ast.parse(str(text).strip(), mode='eval')
    except (SyntaxError, ValueError):
        raise ValueError('not a single call expression')
    node = tree.body
    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
        raise ValueError('expected one call to a function name')
    args = []
    for a in node.args:
        if isinstance(a, ast.Starred):
            raise ValueError('argument unpacking is not allowed')
        args.append(_literal(a))
    kwargs = {}
    for k in node.keywords:
        if k.arg is None:
            raise ValueError('** unpacking is not allowed')
        kwargs[k.arg] = _literal(k.value)
    return node.func.id, args, kwargs


def _literal(node):
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        raise ValueError('argument is not a literal: %s' % short(_unparse(node), 60))


def _unparse(node):
    try:
        return ast.unparse(node)
    except Exception:  # Python < 3.9
        return type(node).__name__


def same(actual, expected):
    """Spec equality: Python == except that bool never equals int (True is not 1) and NaN equals
    NaN; containers compare element-wise with the same rule. int vs float follows == (2 == 2.0).
    Dict subclasses (Counter, defaultdict) equal a plain dict with the same items."""
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(actual) is bool and type(expected) is bool and actual == expected
    if isinstance(expected, float) and expected != expected:
        return isinstance(actual, float) and actual != actual
    if isinstance(expected, (list, tuple)):
        base = list if isinstance(expected, list) else tuple
        return (isinstance(actual, base) and len(actual) == len(expected)
                and all(same(a, e) for a, e in zip(actual, expected)))
    if isinstance(expected, dict):
        if not isinstance(actual, dict) or len(actual) != len(expected):
            return False
        for k, e in expected.items():
            if k not in actual or not same(actual[k], e):
                return False
        return True
    if isinstance(expected, (set, frozenset)):
        return isinstance(actual, (set, frozenset)) and actual == expected
    result = actual == expected
    return result if type(result) is bool else bool(result)


def exc_matches(e, name):
    """The exception's class or any base class is called `name` ('json.JSONDecodeError' -> 'JSONDecodeError')."""
    want = str(name).strip().split('.')[-1]
    return bool(want) and any(c.__name__ == want for c in type(e).__mro__)


def describe_error(e):
    if isinstance(e, SystemExit):
        return 'SystemExit: %s' % (e.code,)
    msg = str(e)
    return short('%s: %s' % (type(e).__name__, msg) if msg else type(e).__name__, ERROR_MAX)


def _same_file(a, b):
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def learner_line(tb, path):
    """Line of the innermost traceback frame inside the learner's module file."""
    line = None
    for fr in traceback.extract_tb(tb):
        if _same_file(fr.filename, path):
            line = fr.lineno
    return line


def _within(path, folder):
    p = os.path.normcase(os.path.abspath(path))
    d = os.path.normcase(os.path.abspath(folder)).rstrip(os.sep)
    return p == d or p.startswith(d + os.sep)


# ------------------------------------------------------------------ session

class Session:
    """One learner module under check: sandbox, sys.path, entry-point sentinels, watchdog and a
    deadline shared by the import and every call."""

    def __init__(self, module_path, workspace=None, timeout_ms=None, source=None):
        self.path = os.path.abspath(module_path)
        self.dir = os.path.dirname(self.path)
        self.workspace = os.path.abspath(workspace) if workspace else self.dir
        self.source = source
        budget_ms = (timeout_ms or DEFAULT_TIMEOUT_MS) - MARGIN_MS
        self.deadline = time.monotonic() + max(0.3, budget_ms / 1000.0)
        self.loading = True
        self.touched = None
        self.module = None
        prelude.install_sandbox(os.getcwd())
        self.pkg_root, self.name = self._module_name()
        self._setup_paths()
        builtins.input = self._input
        sys.argv = _Argv([self.path], self)
        sys.stdin = io.StringIO('')
        try:
            signal.signal(signal.SIGINT, signal.default_int_handler)
        except (ValueError, OSError):
            pass
        self.wd = Watchdog()

    def remaining(self):
        return self.deadline - time.monotonic()

    # -- setup

    def _module_name(self):
        """'dlb_<stem>', inside its package when the folder has __init__.py (relative imports)."""
        stem = re.sub(r'\W', '_', os.path.splitext(os.path.basename(self.path))[0])
        parts = []
        d = self.dir
        while (len(parts) < 20 and os.path.isfile(os.path.join(d, '__init__.py'))
               and _within(d, self.workspace) and os.path.dirname(d) != d):
            parts.insert(0, os.path.basename(d))
            d = os.path.dirname(d)
        return d, '.'.join(parts + ['dlb_' + stem])

    def _setup_paths(self):
        ours = {os.path.normcase(os.path.abspath(p)) for p in (HERE, RUNNER_DIR)}
        front = [self.dir, self.pkg_root, self.workspace]
        seen = set()
        out = []
        for p in front + list(sys.path):
            if not p:
                continue  # '' is the cwd: the run temp dir
            key = os.path.normcase(os.path.abspath(p))
            if key in seen or key in ours:
                continue
            seen.add(key)
            out.append(p)
        sys.path[:] = out

    def entry_error(self, what):
        if self.loading:
            self.touched = self.touched or what
            return DeliberateTopLevel(what, '%s used while the module was imported: %s' % (what, TOP_LEVEL_NUDGE))
        return DeliberateTopLevel(what, '%s is not available while specs run: pass the value as an argument' % what)

    def _input(self, prompt=''):
        raise self.entry_error('input()')

    # -- running learner code

    def run_guarded(self, thunk):
        """thunk() under the deadline with print() output captured: (result, stdout text).
        Raises TimedOut when the deadline passes."""
        out = CappedText(STDOUT_MAX)
        err = CappedText(STDOUT_MAX)
        try:
            self.wd.arm(self.remaining())
            try:
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    result = thunk()
            finally:
                self.wd.disarm()
            if self.wd.fired:
                raise KeyboardInterrupt  # the deadline passed right at the end: the interrupt may still land
        except KeyboardInterrupt as e:
            if not self.wd.fired:
                raise
            stop_interrupts()
            raise TimedOut() from e
        return result, out.getvalue()

    def load(self):
        """Import the module. Returns (importMs, loadError or None)."""
        t0 = time.perf_counter()
        err = None
        try:
            self.module, _ = self.run_guarded(self._exec_module)
            if self.touched:  # input()/argv raised at top level but the module swallowed it
                err = {'kind': 'top-level', 'message': TOP_LEVEL_NUDGE, 'name': self.touched}
        except (TimedOut, KeyboardInterrupt) as e:
            if not self.wd.fired:  # the module raised KeyboardInterrupt itself
                err = {'kind': 'import', 'message': describe_error(e), 'name': type(e).__name__}
                return round((time.perf_counter() - t0) * 1000, 1), err
            stop_interrupts()
            cause = e.__cause__ if isinstance(e, TimedOut) else e
            tb = cause.__traceback__ if cause is not None else None
            frames = traceback.extract_tb(tb) if tb is not None else []
            inner = frames[-1].filename if frames else self.path
            library = 'site-packages' in inner.replace('\\', '/').split('/')  # a workspace .venv
            if (_within(inner, self.workspace) or _within(inner, self.dir)) and not library:
                err = {'kind': 'top-level', 'message': TOP_LEVEL_NUDGE, 'name': 'timeout'}
            else:
                err = {'kind': 'import', 'message': SLOW_IMPORT % ((time.perf_counter() - t0)), 'name': 'timeout'}
            line = learner_line(tb, self.path) if tb is not None else None
            if line:
                err['line'] = line
        except DeliberateTopLevel as e:
            err = {'kind': 'top-level', 'message': TOP_LEVEL_NUDGE, 'name': e.what}
            self._add_line(err, e)
        except SystemExit as e:
            err = {'kind': 'top-level', 'message': TOP_LEVEL_NUDGE, 'name': 'SystemExit'}
            self._add_line(err, e)
        except DeliberateSandbox as e:
            err = {'kind': 'sandbox', 'message': str(e), 'name': getattr(e, 'detail', '') or 'DeliberateSandbox'}
            self._add_line(err, e)
        except SyntaxError as e:
            where = ' (line %s)' % e.lineno if e.lineno and e.filename and _same_file(e.filename, self.path) else ''
            err = {'kind': 'import', 'message': short('%s: %s%s' % (type(e).__name__, e.msg, where), ERROR_MAX),
                   'name': type(e).__name__}
            if where:
                err['line'] = e.lineno
        except BaseException as e:  # ImportError, NameError, ... raised by top-level code
            err = {'kind': 'import', 'message': describe_error(e), 'name': type(e).__name__}
            self._add_line(err, e)
        finally:
            self.loading = False
        return round((time.perf_counter() - t0) * 1000, 1), err

    def _add_line(self, err, e):
        line = learner_line(e.__traceback__, self.path)
        if line:
            err['line'] = line

    def _exec_module(self):
        name = self.name
        if self.source is None:
            spec = importlib.util.spec_from_file_location(name, self.path)
            if spec is None or spec.loader is None:
                raise ImportError('cannot load %s' % os.path.basename(self.path))
            mod = importlib.util.module_from_spec(spec)
            run = lambda: spec.loader.exec_module(mod)  # noqa: E731
        else:
            spec = importlib.util.spec_from_loader(name, loader=None, origin=self.path)
            mod = importlib.util.module_from_spec(spec)
            mod.__file__ = self.path
            code = compile(self.source, self.path, 'exec', dont_inherit=True)
            run = lambda: exec(code, mod.__dict__)  # noqa: E731
        sys.modules[name] = mod  # dataclasses and pickle look the module up by name
        try:
            run()
        except BaseException:
            sys.modules.pop(name, None)
            raise
        return mod

    def function(self, name):
        """(callable, None) or (None, error text)."""
        fn = getattr(self.module, name, None) if self.module is not None else None
        if fn is None:
            return None, "NameError: name '%s' is not defined in %s" % (name, os.path.basename(self.path))
        if not callable(fn):
            return None, "TypeError: '%s' in %s is not a function" % (name, os.path.basename(self.path))
        return fn, None


def stop_interrupts():
    """After a timeout: a late watchdog interrupt must not hit the harness's own code."""
    try:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    except (ValueError, OSError):
        pass


def finish(code=0):
    """Flush and leave at once: threads the learner's code started must not keep us alive."""
    for stream in (REAL_OUT, sys.__stderr__):
        try:
            stream.flush()
        except Exception:
            pass
    os._exit(code)


# ------------------------------------------------------------------ specs

_MISSING = object()


def run_spec(session, spec):
    sid = str(spec.get('id'))
    rec = {'id': sid, 'pass': False, 'status': 'ok'}
    try:
        callee, args, kwargs = parse_call(spec.get('call') or '')
    except ValueError as e:
        rec['error'] = 'BadCall: %s' % e
        return rec
    expect_error = str(spec.get('expectError') or '').strip()
    expected = _MISSING
    if not expect_error:
        try:
            expected = ast.literal_eval(str(spec.get('expected') or '').strip())
        except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
            rec['error'] = 'BadExpected: the expected value is not a Python literal'
            return rec
    signatures = [s for s in (spec.get('signatures') or []) if isinstance(s, dict)]
    fn, missing = session.function(callee)
    if fn is None:
        rec['error'] = missing
        rec['exception'] = missing.split(':', 1)[0]
        return rec

    def thunk():
        try:
            value = fn(*args, **kwargs)
        except BaseException as e:
            if session.wd.fired:
                raise
            return _raised(session, rec, e, expect_error, signatures)
        return _returned(rec, value, expected, expect_error, signatures)

    _, out = session.run_guarded(thunk)
    if out:
        rec['stdout'] = short(out, STDOUT_MAX)
    return rec


def _raised(session, rec, e, expect_error, signatures):
    rec['exception'] = type(e).__name__
    rec['error'] = describe_error(e)
    line = learner_line(e.__traceback__, session.path)
    if line:
        rec['line'] = line
    if expect_error:
        rec['pass'] = exc_matches(e, expect_error)
    if not rec['pass']:
        for i, sig in enumerate(signatures):
            if sig.get('match') == 'error' and exc_matches(e, sig.get('value') or ''):
                rec['sig'] = i
                break
    return rec


def _returned(rec, value, expected, expect_error, signatures):
    rec['actual'] = short(prelude.safe_repr(value, None), ACTUAL_MAX)
    if not expect_error:
        try:
            rec['pass'] = same(value, expected)
        except Exception as e:  # a learner __eq__ that raises
            rec['error'] = 'comparing the result raised %s' % describe_error(e)
    if not rec['pass']:
        for i, sig in enumerate(signatures):
            if sig.get('match') != 'equals':
                continue
            try:
                if same(value, ast.literal_eval(str(sig.get('value') or '').strip())):
                    rec['sig'] = i
                    break
            except Exception:
                continue
    try:
        val = prelude.encode_val(value)
        if len(_dumps(val)) <= VAL_JSON_MAX:
            rec['val'] = val
    except Exception:
        pass
    return rec


def main(argv):
    if len(argv) < 2:
        sys.stderr.write('usage: harness.py <module file> <spec json>\n')
        return 2
    module_path, spec_path = argv[0], argv[1]
    with open(spec_path, encoding='utf-8') as f:
        data = json.load(f)
    specs = [s for s in (data.get('specs') or []) if isinstance(s, dict)]
    emit('@@DLB_PLAN', [str(s.get('id')) for s in specs])
    session = Session(module_path, workspace=data.get('workspace'), timeout_ms=data.get('timeoutMs'))
    current = None
    try:
        import_ms, err = session.load()
        load = {'importMs': import_ms}
        if err:
            load['loadError'] = err
        emit('@@DLB_LOAD', load)
        if err:
            emit('@@DLB_END', {})
            return 0
        for spec in specs:
            current = str(spec.get('id'))
            emit('@@DLB_START', current)
            rec = run_spec(session, spec)
            emit('@@DLB', rec)
            current = None
    except (TimedOut, KeyboardInterrupt):
        if not session.wd.fired:
            raise
        stop_interrupts()
        if current is not None:
            emit('@@DLB', {'id': current, 'pass': False, 'status': 'timeout', 'error': TIMEOUT_TEXT})
        emit('@@DLB_END', {'timedOut': True})
        return 0
    emit('@@DLB_END', {})
    return 0


if __name__ == '__main__':
    try:
        exit_code = main(sys.argv[1:])
    except BaseException:  # our own failure: the parent reports it as a harness crash
        traceback.print_exc()
        exit_code = 70
    finish(exit_code)
