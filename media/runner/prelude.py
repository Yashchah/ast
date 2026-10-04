"""Deliberate prelude (Python 3.8+): check(), typed value capture and the sandbox audit hook.

Two ways in:
- batch.py loads it for model/seed snippets.
- Learner-code runs start `python -E -B -X utf8 prelude.py <script> [args...]`: the sandbox is
  installed, then <script> runs as __main__ (sys.argv and sys.path[0] as if it had been started
  directly). The script reaches this module with `import prelude`.

The sandbox is an audit hook (sys.addaudithook), so it cannot be removed once installed. It
raises DeliberateSandbox BEFORE the operation runs: writes outside the run temp dir, deletes,
renames and mkdirs outside it, shutil, process creation, sockets and ctypes.
"""
import builtins
import math
import os
import sys
import types

SANDBOX_MESSAGE = ('your code tried to write a file or start a process while being checked: '
                   'keep that in the main block')

# Shared, per-process state: this file may be loaded more than once (as __main__ by the learner
# bootstrap, then by `import prelude` or by path), but there must be one exception class of each
# kind and at most one hook.
_STATE_NAME = '_deliberate_prelude_state'
_state = sys.modules.get(_STATE_NAME)
if _state is None:
    _state = types.ModuleType(_STATE_NAME)

    class DeliberateSandbox(Exception):
        """str() is the learner-facing sentence; .event and .detail say what was blocked."""

        def __init__(self, event='', detail=''):
            super().__init__(SANDBOX_MESSAGE)
            self.event = event
            self.detail = detail

    class CheckFailed(AssertionError):
        """Raised by check(); its message starts with 'CHECK '."""

    # Tracebacks print 'DeliberateSandbox: ...', not 'prelude.DeliberateSandbox: ...'.
    DeliberateSandbox.__module__ = 'builtins'
    CheckFailed.__module__ = 'builtins'
    _state.DeliberateSandbox = DeliberateSandbox
    _state.CheckFailed = CheckFailed
    _state.tmp = None
    _state.hits = []
    sys.modules[_STATE_NAME] = _state

DeliberateSandbox = _state.DeliberateSandbox
CheckFailed = _state.CheckFailed
# (event, detail) for every blocked operation, even ones the code under test caught and ignored.
sandbox_hits = _state.hits


def check(cond, msg=''):
    """Harness assertion: fails with CheckFailed('CHECK <msg>'), which exits non-zero if uncaught."""
    if not cond:
        raise CheckFailed('CHECK ' + (str(msg) if msg not in (None, '') else 'failed'))


# ------------------------------------------------------------------ typed values (contracts Val)

MAX_NODES = 2000
MAX_DEPTH = 30


def safe_repr(x, limit=2000):
    try:
        r = repr(x)
    except BaseException as e:  # a broken __repr__ must not sink the capture
        r = '<unrepresentable %s: %s>' % (type(x).__name__, type(e).__name__)
    return r if limit is None or len(r) <= limit else r[:limit]


def encode_val(x):
    """Typed encoding of a value for type-aware grading. Exact builtin types only: a subclass
    (Counter, namedtuple, IntEnum...) is 'opaque' because its printed form is not a plain literal."""
    return _enc(x, [MAX_NODES], set())


def _opaque(x):
    return {'t': 'opaque', 'type': type(x).__name__, 'repr': safe_repr(x, 200)}


_CONTAINERS = {list: 'list', tuple: 'tuple', set: 'set', frozenset: 'frozenset', dict: 'dict'}


def _enc(x, budget, stack):
    budget[0] -= 1
    t = type(x)
    if t is bool:
        return {'t': 'bool', 'v': x}
    if t is int:
        try:
            return {'t': 'int', 'v': str(x)}
        except ValueError:  # more digits than sys.get_int_max_str_digits()
            return _opaque(x)
    if t is float:
        if math.isnan(x):
            return {'t': 'float', 'v': 'nan'}
        if math.isinf(x):
            return {'t': 'float', 'v': 'inf' if x > 0 else '-inf'}
        return {'t': 'float', 'v': x}
    if x is None:
        return {'t': 'none'}
    if t is str:
        return {'t': 'str', 'v': x}
    if t is bytes:
        return {'t': 'bytes', 'v': x.decode('latin-1')}
    kind = _CONTAINERS.get(t)
    if kind is None:
        return _opaque(x)
    if id(x) in stack or len(stack) >= MAX_DEPTH or len(x) > budget[0]:
        return _opaque(x)
    stack.add(id(x))
    try:
        if kind == 'dict':
            v = [[_enc(k, budget, stack), _enc(val, budget, stack)] for k, val in x.items()]
        else:
            v = [_enc(e, budget, stack) for e in x]
    finally:
        stack.discard(id(x))
    return {'t': kind, 'v': v}


def printed_arg(x):
    """One print() argument as contracts PrintedArg: runtime type name, repr and typed value."""
    return {'type': type(x).__name__, 'repr': safe_repr(x), 'val': encode_val(x)}


# ------------------------------------------------------------------ sandbox (audit hook)

_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC
# Path-taking events: blocked when a path argument is outside the run temp dir.
# Values: (indexes of path arguments, index of the dir_fd argument or None).
_PATH_EVENTS = {
    'os.remove': ((0,), 1),
    'os.rmdir': ((0,), 1),
    'os.mkdir': ((0,), 2),
    'os.rename': ((0, 1), 2),
    'os.truncate': ((0,), None),
    'os.chmod': ((0,), 2),
    'os.chown': ((0,), 3),
    'os.utime': ((0,), 3),
    'os.chflags': ((0,), None),
    'os.lchflags': ((0,), None),
    'os.setxattr': ((0,), None),
    'os.removexattr': ((0,), None),
}
# Always blocked: process creation, network, native code, and links (a link inside tmp could
# point a later 'inside' write at the workspace).
_ALWAYS = {
    'subprocess.Popen', 'os.system', 'os.exec', 'os.posix_spawn', 'os.spawn', 'os.startfile',
    'os.fork', 'os.forkpty', 'pty.spawn', '_winapi.CreateProcess', 'os.kill', 'os.killpg',
    'webbrowser.open', 'socket.connect', 'socket.sendto', 'socket.sendmsg', 'socket.bind',
    'ctypes.dlopen', 'os.symlink', 'os.link', '_winapi.CreateJunction',
}


def _norm(p):
    return os.path.normcase(os.path.abspath(p))


_DEVNULLS = {_norm(os.devnull), os.path.normcase(os.devnull)}


def _outside(p, dir_fd=None):
    if p is None or isinstance(p, int):  # an already-open file descriptor
        return False
    try:
        p = os.fsdecode(os.fspath(p))
    except TypeError:
        return True
    if dir_fd is not None and not os.path.isabs(p):
        return True  # relative to a directory fd we cannot resolve: assume the worst
    full = _norm(p)
    if full in _DEVNULLS or os.path.normcase(p) in _DEVNULLS:
        return False
    tmp = _state.tmp
    return not (full == tmp or full.startswith(tmp.rstrip(os.sep) + os.sep))


def _blocked(event, args):
    """None, or a short description of why this event is not allowed."""
    if event == 'open':
        path, mode, flags = (tuple(args) + (None, None, None))[:3]
        writing = (isinstance(mode, str) and any(c in mode for c in 'wax+')) or (
            isinstance(flags, int) and bool(flags & _WRITE_FLAGS))
        if writing and _outside(path):
            return 'open %r for writing' % (path,)
        return None
    if event in _ALWAYS or event.startswith('shutil.'):
        return event
    spec = _PATH_EVENTS.get(event)
    if spec is not None:
        idxs, fd_idx = spec
        dir_fd = args[fd_idx] if fd_idx is not None and fd_idx < len(args) else None
        for i in idxs:
            if i < len(args) and _outside(args[i], dir_fd):
                return '%s %r' % (event, args[i])
    return None


def _hook(event, args):
    if _state.tmp is None:
        return
    why = _blocked(event, args)
    if why is not None:
        _state.hits.append((event, why))
        raise DeliberateSandbox(event, why)


def install_sandbox(tmp=None):
    """Install the audit hook once per process; writes stay allowed under `tmp` (default: cwd).
    Returns the normalised tmp actually in force (the first install wins)."""
    if _state.tmp is None:
        _state.tmp = _norm(tmp or os.getcwd())
        sys.addaudithook(_hook)
    return _state.tmp


# ------------------------------------------------------------------ learner-code bootstrap

def _main(argv):
    if not argv:
        sys.stderr.write('usage: prelude.py <script> [args...]\n')
        return 2
    import runpy  # imported before the hook, like everything the bootstrap needs

    script = os.path.abspath(argv[0])
    sys.modules.setdefault('prelude', sys.modules[__name__])
    here = os.path.dirname(os.path.abspath(__file__))
    script_dir = os.path.dirname(script)
    if sys.path and _norm(sys.path[0] or '.') == _norm(here):
        sys.path[0] = script_dir
    else:
        sys.path.insert(0, script_dir)
    sys.argv = [script] + list(argv[1:])
    install_sandbox(os.getcwd())
    runpy.run_path(script, run_name='__main__')
    return 0


if __name__ == '__main__':
    sys.exit(_main(sys.argv[1:]))
