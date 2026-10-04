"""Deliberate own-code probe (Python 3.8+), spec V1-12: run ONE call against a learner's module.

usage: python -E -B -X utf8 [prelude.py] probe.py <module file> <call> [--stdin] [--workspace DIR] [--timeout-ms N]

--stdin: the module's source comes from stdin (the editor's current text, or a what-if mutant)
instead of the file on disk; <module file> still names it, for sys.path, __file__ and line numbers.

Prints one line:
  @@DLB {"ok": true, "type", "repr", "val", "ms", "importMs", "stdout"?}       the call returned
  @@DLB {"ok": false, "exception", "error", "line"?, "ms", "importMs", ...}    the call raised
  @@DLB {"ok": false, "timedOut": true, "error"}                              past the deadline
  @@DLB {"ok": false, "loadError": {...}, "importMs"}                         the module did not load
The module loader, sandbox, input()/argv sentinels and the literal-only call parser are
harness.py's (spec V1-12 MODULE SAFETY).
"""
import importlib.util
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_harness():
    spec = importlib.util.spec_from_file_location('dlb_harness_lib', os.path.join(HERE, 'harness.py'))
    mod = importlib.util.module_from_spec(spec)
    sys.modules['dlb_harness_lib'] = mod
    spec.loader.exec_module(mod)
    return mod


harness = _load_harness()


def parse_args(argv):
    opts = {'module': None, 'call': None, 'stdin': False, 'workspace': None, 'timeout_ms': None}
    rest = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--stdin':
            opts['stdin'] = True
        elif a == '--workspace' and i + 1 < len(argv):
            opts['workspace'] = argv[i + 1]
            i += 1
        elif a == '--timeout-ms' and i + 1 < len(argv):
            opts['timeout_ms'] = int(argv[i + 1])
            i += 1
        else:
            rest.append(a)
        i += 1
    if len(rest) >= 2:
        opts['module'], opts['call'] = rest[0], rest[1]
    return opts


def probe(session, call):
    rec = {'ok': False}
    try:
        callee, args, kwargs = harness.parse_call(call)
    except ValueError as e:
        rec['error'] = 'BadCall: %s' % e
        return rec
    fn, missing = session.function(callee)
    if fn is None:
        rec['exception'] = missing.split(':', 1)[0]
        rec['error'] = missing
        return rec

    def thunk():
        t0 = time.perf_counter()
        try:
            value = fn(*args, **kwargs)
        except BaseException as e:
            if session.wd.fired:
                raise
            rec['ms'] = round((time.perf_counter() - t0) * 1000, 1)
            rec['exception'] = type(e).__name__
            rec['error'] = harness.describe_error(e)
            line = harness.learner_line(e.__traceback__, session.path)
            if line:
                rec['line'] = line
            return
        rec['ms'] = round((time.perf_counter() - t0) * 1000, 1)
        rec['ok'] = True
        rec.update(harness.prelude.printed_arg(value) if hasattr(harness.prelude, 'printed_arg') else {
            'type': type(value).__name__, 'repr': harness.prelude.safe_repr(value), 'val': harness.prelude.encode_val(value)})

    try:
        _, out = session.run_guarded(thunk)
    except harness.TimedOut:
        return {'ok': False, 'timedOut': True, 'error': harness.TIMEOUT_TEXT}
    if out:
        rec['stdout'] = harness.short(out, harness.STDOUT_MAX)
    return rec


def main(argv):
    opts = parse_args(argv)
    if not opts['module']:
        sys.stderr.write('usage: probe.py <module file> <call> [--stdin] [--workspace DIR] [--timeout-ms N]\n')
        return 2
    source = sys.stdin.read() if opts['stdin'] else None
    session = harness.Session(opts['module'], workspace=opts['workspace'], timeout_ms=opts['timeout_ms'], source=source)
    try:
        import_ms, err = session.load()
        if err:
            harness.emit('@@DLB', {'ok': False, 'loadError': err, 'importMs': import_ms})
            return 0
        rec = probe(session, opts['call'])
        rec['importMs'] = import_ms
    except (harness.TimedOut, KeyboardInterrupt):
        if not session.wd.fired:
            raise
        harness.stop_interrupts()
        rec = {'ok': False, 'timedOut': True, 'error': harness.TIMEOUT_TEXT}
    harness.emit('@@DLB', rec)
    return 0


if __name__ == '__main__':
    try:
        exit_code = main(sys.argv[1:])
    except BaseException:
        import traceback
        traceback.print_exc()
        exit_code = 70
    harness.finish(exit_code)
