

# runner  tests=True count=35
## exports
- proc.ts: spawnCapped(bin: string, args: string[], o?: SpawnOptions /* {cwd, env, stdin?: string (undefined = ignore), timeoutMs, signal, maxOut, shell, onStdout} */): Promise<ProcResult /* RunResult & {truncated, signal} */>  -- timeout resolves {timedOut:true}; abort rejects with signal.reason (AbortError)
- proc.ts: killTree(pid: number): Promise<void>  -- win32 taskkill /pid /T /F, POSIX process.kill(-pid,'SIGKILL') (children spawned detached on POSIX)
- proc.ts: quoteCmdArg(a: string): string
- codex.ts: runCodex(o: CodexOptions, system: string, prompt: string, jsonSchema: object, signal?: AbortSignal): Promise<string>  -- all other exports unchanged
- runner.ts: class LocalRunner implements Runner { constructor(runtime: Runtime, o: { runnerDir: string; runRoot: string }); runBatch(items: BatchItem[], opts?: LocalBatchOptions /* BatchOptions & {allowImports?: string[]; maxOut?: number} */): Promise<BatchRecord[]>; runLearnerCode(scriptPath: string, args: string[], opts: LearnerRunOptions): Promise<RunResult>; findPythonModules(names: string[], signal?: AbortSignal): Promise<string[]> }
- runner.ts: detectPython(candidates: (string | PythonCandidate)[], o?: DetectOptions): Promise<DetectedRuntime | undefined>
- runner.ts: detectNode(o?: DetectOptions & { bin?: string }): Promise<DetectedRuntime | undefined>
- runner.ts: detectTypeScript(node: Runtime, workspaceDir: string | undefined, o?: DetectOptions & { runnerDir?: string }): Promise<DetectedRuntime | undefined>
- runner.ts: detectRuntimes(o: DetectOptions & { pythonCandidates; workspaceDir?; runnerDir? }): Promise<{ python?; javascript?; typescript? }>
- runner.ts: allowlistCheck(code: string, lang: Lang, extraImports?: readonly string[]): string | undefined  (reason when denied)
- runner.ts: parseException(text: string, lang: Lang): string | undefined
- runner.ts: unstableIds(passA: BatchRecord[], passB: BatchRecord[]): string[]
- runner.ts: buildEnv(profile: 'snippet' | 'learner', tmp: string, extra?): NodeJS.ProcessEnv; permissionFlagFor(version); needsStripFlag(version); pythonSnippetFlags(version); venvCandidates(workspaceDir); PATH_PYTHON_CANDIDATES; findTsx(workspaceDir, envPath?); tsxLoaderUrl(tsxDir); stripPython(code); stripJs(code); pythonImports(code); class RunnerError; DEFAULT_ITEM_TIMEOUT_MS; types DetectedRuntime (Runtime & {source, probeMs, tsxDir?}), DetectOptions {cwd?, timeoutMs?, signal?, log?}, PythonCandidate {bin, args?, source?}, LocalRunnerOptions, LocalBatchOptions, DetectedRuntimes
- runtimeDiscovery.ts (vscode): discoverRuntimes({ extensionUri, globalStorageUri, log?, signal? }): Promise<DetectedRuntimes>; pythonCandidates(folder?: WorkspaceFolder): Promise<PythonCandidate[]>; makeRunner(rt: DetectedRuntime, extensionUri, globalStorageUri): LocalRunner; runnerDir(extensionUri): string; runRoot(globalStorageUri): string
- media/runner/prelude.py: check(cond, msg=''), CheckFailed(AssertionError), DeliberateSandbox(Exception; .event, .detail), SANDBOX_MESSAGE, sandbox_hits, install_sandbox(tmp=None), encode_val(x), printed_arg(x), safe_repr(x, limit); CLI: python -E -B -X utf8 prelude.py <script> [args] (installs sandbox, runs script as __main__)
- media/runner/prelude.mjs: check, CheckFailed, CHECK_SOURCE, INSPECT, encodeVal, printedArg, typeName, safeInspect, makeConsole(sink), constructsOf(code, ts), stripJs
- media/runner/batch.py <items.json> [--start N] [--timeout-ms N] [--max-out N]; batch.mjs <items.json> [--start N] [--timeout-ms N] [--max-out N] [--lang javascript|typescript] [--tsx DIR]  -- protocol lines '@@DLB_START <json id>' then '@@DLB <BatchRecord json>'
## deviations
All 35 tests in test/runner.test.ts pass, and the 4 in test/codex.test.ts still pass. They include real Python 3.14 and Node 24.11.1 runs, real TypeScript strip-mode runs, and real process-tree kills. tsc reports no errors in my files. I also checked by hand: batch.py/prelude.py on Python 3.12 and 3.13, Node 23.9.0 (--permission and strip-mode TS), and tsx fallback mode (batch and learner runs).

Deviations from the spec, and why:
1. Python detection probes each candidate with the LEARNER env, which adds APPDATA and LOCALAPPDATA. It then re-probes the cached absolute sys.executable with the exact snippet env and argv. Reason: on this machine the WindowsApps `python` alias, started with the bare snippet env (no LOCALAPPDATA), silently ran Python 3.13 instead of the user's 3.14. If the real exe cannot be started directly, the launcher is kept only if it reaches the same interpreter under the snippet env.
2. The Python version is unknown before the probe, so the probe tries '-P' and drops it if refused. Node tries '--permission', then '--experimental-permission', then no flag, and cross-checks permissionFlagFor(version). Node 24.11.1 rejects --experimental-permission outright.
3. Node's inspect options are {breakLength: Infinity, compact: true}. breakLength alone still wraps arrays of 7+ elements into rows (verified on 24.11.1), and the spec's goal was "arrays never wrap".
4. --allow-fs-read/--allow-fs-write are emitted as one flag per path, because Node 21+ no longer accepts comma-separated lists.
5. Native TS mode also requires module.stripTypeScriptTypes, because snippets run in vm and need a string transform. Node 22.10-22.12 and 23.0-23.1 therefore fall back to tsx. Snippets are stripped in 'strip' mode, which keeps line numbers, with a 'transform' fallback for enums and namespaces.
6. tsx mode needs --allow-child-process, because esbuild runs its native binary; Node then prints a SecurityWarning on stderr. Learner runs also need read access to package.json/tsconfig.json in every parent directory, because tsx walks up with plain fs calls. Native mode needs neither.
7. tsx snippets are transformed up front through one esbuild service. Using transformSync per item took 1302 ms for 30 items; this takes 213 ms.
8. Allowlist additions beyond the spec:
   - Python: compile/breakpoint/help(; dunder escapes (__builtins__, __subclasses__, __globals__, __code__, __loader__, __spec__); io.open/FileIO; parse_args() with no argv; datetime now/today/utcnow when datetime is used.
   - JS: import.meta; .constructor (except .constructor.name); __proto__; 'constructor' accessed by string; Date() with no arguments. These block vm escapes to host Function/process.
9. Audit-hook additions beyond the spec:
   - Links are blocked everywhere (os.symlink, os.link, _winapi.CreateJunction), so a link inside tmp cannot redirect an "inside" write.
   - Also blocked: os.kill/killpg, webbrowser.open, posix_spawn/spawn/startfile/fork, socket sendto/sendmsg/bind.
   - Blocked outside tmp: truncate, chmod, chown, utime, xattr calls.
   - DeliberateSandbox subclasses Exception. A learner's `except Exception` swallows it, but the operation never happened, and prelude.sandbox_hits still records it.
10. Learner-code Python runs always go through `prelude.py <script>`, which installs the sandbox and then runs the script as __main__. This enforces "installed by the prelude in both profiles" instead of relying on each harness. Classes and the hook are shared per process, so a harness that also imports or loads prelude gets the same classes and only one hook.
11. maxOut 20000 is applied per item inside the batch scripts. Records are parsed from the stream, so the batch protocol itself is not cut at 20000.
12. PYTHONHASHSEED defaults to 0 when no hashSeed is given.
13. Node microtasks use the default shared queue: microtaskMode 'afterEvaluate' breaks awaiting host timers. A hang inside a microtask is killed by the parent watchdog and the batch is respawned. The watchdog allows itemTimeout + 1 s per item for Python, itemTimeout + 2 s + 1 s for Node, and 15 s for the first START line. Timer callbacks run through vm.runInContext, so the vm timeout covers them. Timers still pending, or a completion promise still unsettled, after the 2 s cap mark the item timedOut.
14. Python Val encoding uses exact builtin types only. Subclasses (Counter, defaultdict, namedtuple, IntEnum) are 'opaque', because their printed form is not a plain literal.
15. The Python trace prefixes repeat counts ('x3 a=[1]  b is a'), and the whole line is cut to 60 characters. It shows every name in that frame's scope, not only the ones the line changed. Comprehension and lambda frames are not traced. In 3.12+, inlined comprehensions would otherwise inflate counts, so a line re-run without leaving it counts again only on loop statements.
16. Contract gap: BatchOptions has no allowImports field. LocalBatchOptions extends it; I suggest adding `allowImports?: string[]` to contracts.BatchOptions. I did not modify contracts.ts.
17. runBatch throws RunnerError when the interpreter dies before starting an item. That is a runtime failure, not an item failure. On abort it rejects with the signal's reason (an AbortError by default) and removes its temp dir.
18. spawnCapped keeps the head of stdout and the tail of stderr. The old codex exec kept the tails of both; codex only uses stdout to parse --version, so this changes nothing there.

Timings measured on this machine (Windows 10, medians):
- Python hello-world: 95 ms with the cached real exe, 200 ms through the WindowsApps alias.
- Node hello-world: 75 ms, with or without --permission.
- Python runBatch: 158 ms for 1 item, 178 ms for 30 items in one spawn, 198 ms with state trace, 193 ms for two hash-seed passes run in parallel.
- Node runBatch: 100 ms for 1 item, 146 ms for 30.
- TS strip runBatch: about 154 ms for 1 item and 212 ms for 30, with run-to-run noise up to 200/295 ms.
- TS through tsx: 213 ms for 30 items.
- runLearnerCode: 113 ms for Python (sandbox bootstrap plus module import), 91 ms for Node.
- Detection: detectPython 328 ms (alias probe plus direct probe), detectNode 88 ms, detectTypeScript 250 ms (including a verification batch).
- Python timeout cost: 6 items with a 0.8 s timeout, which needs 2 spawns, took about 1.1 s in total.
## notesForIntegrator
Wiring (extension.ts):
- On activation, call `const rts = await discoverRuntimes({ extensionUri: ctx.extensionUri, globalStorageUri: ctx.globalStorageUri, log })`. Hold the result in memory only.
- Re-run discovery on vscode.workspace.onDidGrantWorkspaceTrust. While a workspace is untrusted, discovery never executes anything the workspace provides: its .venv/venv/env, the ms-python selection, a workspace-level python.defaultInterpreterPath, or workspace node_modules/.bin/tsx.
- Create one runner per language with `makeRunner(rts.python | rts.javascript | rts.typescript, ctx.extensionUri, ctx.globalStorageUri)`. JS and TS are separate Runtime objects; the TS one adds `--lang typescript` to batches.
- If rts.python is undefined, show the spec's 'No Python found' status flash.
- Consent and isTrusted gating belongs to the caller. The runner does not check them.
- package.json still needs deliberate.pythonPath with scope machine; that file is not mine. runtimeDiscovery already reads it.

runBatch(items, { hashSeed, itemTimeoutMs (default 3000), signal, allowImports, maxOut }):
- One spawn per batch. A respawn happens only after a hard hang.
- Denied items come back with `denied` set and are never run.
- Every record has `error` when the item failed: the traceback tail limited to snippet frames.
- For verification, run two passes (e.g. hashSeed 1 and 2, in parallel) and call unstableIds(a, b) to get the ids whose output differs.
- allowImports: pass TagInfo.allowedImports. For tag 'other', pass `await runner.findPythonModules(names)`, which runs importlib.util.find_spec under the snippet profile and never returns always-denied modules.

Grading data:
- A failing check() gives exception 'CheckFailed', and `error` contains 'CheckFailed: CHECK <msg>' plus the snippet frame for the check line (Python: File "<snippet>", line N; JS: 'at snippet.js:N:C').
- Traceback items (V1-9): Python frames read 'File "<snippet>", line N, in <module>', followed by the source line and carets. Node frames read 'at snippet.js:L:C' or 'at f (snippet.ts:L:C)'. Node's source/caret header is kept only when it points at the snippet.

Typed values:
- values[k] is one print/console.log call, holding {type, repr, val}.
- Python: int is a decimal string; float is a number or 'nan'/'inf'/'-inf'; dict is a list of entries; exact builtin types only.
- JS: num, including 'NaN'/'Infinity'/'-0'; Map and plain objects become dict.
- JS stdout is formatWithOptions({breakLength: Infinity, compact: true}), so output stays on one line.

runLearnerCode(scriptPath, args, { workspaceDir, timeoutMs, readDirs?, stdin?, signal }):
- cwd is always a fresh temp dir under globalStorage/run, removed afterwards.
- RunResult.exception is parseException(stderr) when the exit code is non-zero.
- Python: runs `<exe> -E -B -X utf8 media/runner/prelude.py <script> <args>`.
  - The audit-hook sandbox is already installed when the harness starts.
  - The harness can `import prelude` with no sys.path work, and gets check, DeliberateSandbox (.event/.detail), sandbox_hits, SANDBOX_MESSAGE, encode_val and printed_arg.
  - sys.path[0] is the script's own folder. The harness must still prepend the workspace and module folders (spec).
  - Writes and removes outside the run tmp, subprocesses, sockets and ctypes raise DeliberateSandbox. Relative writes land in the tmp dir.
- Node: the script may read workspaceDir, the script's folder, media/runner (it can import '../runner/prelude.mjs' for check, encodeVal and printedArg), the run tmp and readDirs. Only the run tmp is writable; a denied write throws ERR_ACCESS_DENIED.
- TS strip mode: learnerArgv already carries --experimental-strip-types on 22.6-23.5. The harness's module.register resolve hook is the harness owner's.
- TS tsx mode: learnerArgv carries `--import <tsx loader URL>`.
- Python learner runs add APPDATA/LOCALAPPDATA to the env so user site-packages load.

Other modules:
- parseException(text, lang) also handles terminal tails, including ANSI and OSC 633 shell-integration escapes. Use it for the V1-10 rung-0 hint.
- runCodex has a new trailing `signal?: AbortSignal`; the JobQueue can pass its abort signal. Timeouts and aborts now kill the whole tree behind a .cmd shim (tested with a fake codex .cmd whose grandchild is gone afterwards).
- Constructs vocabulary, for AtomCache allowedConstructs:
  - Python: for, while, nested-loop, if, elif, else, ternary, def, nested-def, default-arg, varargs, kwargs, decorator, recursion, lambda, class, inheritance, return, yield, await, async, list-comp, dict-comp, set-comp, genexp, slice, index, negative-index, dict-literal, list-literal, set-literal, tuple, f-string, bytes, try, except, finally, try-else, raise, with, assert, import, global, nonlocal, break, continue, del, walrus, aug-assign, unpack, chained-assign, star, bool-op, not, is, in, chained-compare, floor-div, true-div, power, modulo, percent-format, match, loop-else, keyword-arg, call:<builtin>, method:<name>.
  - JS: for, for-of, for-in, while, do-while, if, else, switch, ternary, function, generator, arrow, class, inheritance, new, this, return, async, await, promise, try, catch, finally, throw, break, continue, let, const, var, destructure, spread, optional-chain, nullish, strict-eq, loose-eq, typeof, instanceof, delete, increment, aug-assign, modulo, power, index, array-literal, object-literal, getter-setter, static, template-literal, regex, nested-loop, recursion, method:<name>, call:<global>.
  - TS adds: type-annotation, interface, type-alias, enum, generic, as-cast, non-null.
- Gotcha: Runtime.snippetArgv/learnerArgv hold only the static flags. LocalRunner appends the per-run --allow-fs-* flags itself, so do not spawn snippets by hand with those argv.
- runRoot (globalStorage/run) is created on demand. The b-*, l-* and m-* temp dirs are deleted after each run, including on abort.


# compare  tests=True count=51
## exports
- compare.ts: compareOutput(answer: string, recorded: RecordedOutput, lang: Lang, opts?: CompareOpts): Verdict
- compare.ts: interface CompareOpts extends CompareOptions { returnValue?: boolean }
- compare.ts: answerSpaceG(recorded: RecordedOutput): number
- compare.ts: actualText(recorded: RecordedOutput, lang: Lang, returnValue?: boolean): string  // the actual output on one line, lines joined with ' | ', for 'actual: X' lines
- compare.ts: valEquals(a: Val, b: Val, opts?: { strict: boolean }): boolean  // default strict; sets and dicts are order-free multisets
- compare.ts: parsePyLiteral(text: string, mode?: LiteralMode): Val  // throws LiteralError
- compare.ts: parseJs5(text: string, mode?: LiteralMode): Val  // throws LiteralError
- compare.ts: parseLiteral(text: string, lang: Lang, mode?: LiteralMode): Val
- compare.ts: parseLiteralAt(text: string, pos: number, lang: Lang, mode?: LiteralMode): { node: LitNode; end: number }
- compare.ts: type LiteralMode = 'repr' | 'loose' | 'source'; interface LitNode { val; start; end; items?; entries? }; class LiteralError extends Error { pos }
- compare.ts: formatVal(val: Val, lang: Lang): string  // Python repr() / single-line util.inspect
- compare.ts: pyFloatRepr(v: number | 'nan' | 'inf' | '-inf'): string
- compare.ts: editDistance(a: string, b: string, max?: number): number  // Levenshtein over code points; returns max+1 once max is exceeded
- calls.ts: parseCall(text: string, lang: Lang): CallCheck
- calls.ts: validateCall(text: string, lang: Lang, allowedFunctionNames: readonly string[]): CallCheck
- calls.ts: interface CallCheck { ok: boolean; callee: string; args: CallArg[]; call?: string /* canonical text */; error?: string }
- calls.ts: interface CallArg { name?: string; text: string; val: Val; node: LitNode }
- calls.ts: mutateLiteral(callText: string, lang: Lang): string[]
- calls.ts: renameCallee(call: string, newName: string): string  // throws if newName is not an identifier
- calls.ts: sameArgs(a: CallArg[], b: CallArg[]): boolean  // positional in order, keyword arguments by name, strict valEquals
## deviations
1. compareOutput's options are CompareOpts = CompareOptions + returnValue?: boolean (local type; contracts.ts untouched). Own-code predicts and what-ifs compare RETURN values. In print mode a str shows bare, so 'abc' would come out format-only and None would equal the string 'None'. In returnValue mode, strings are literals: 'abc' is correct, a bare abc is format-only, and None for 'None' is wrong.
2. The spec's claim that util.inspect with {breakLength: Infinity} keeps arrays on one line is false. Node 24 still groups arrays of more than 6 short items into columns over several lines (checked). compare handles this: a call whose printed text spans several lines matches an answer typed on one line or on its printed lines, through alignment over answer lines. formatVal and actualText always render one line.
3. The slip rule followed literally means single-character outputs can never name a mutant (actual 4, mutant 5, answer 5 is distance 1). Off-by-one probes that print one digit therefore never attribute a belief.
4. The contract models JS Maps and plain objects both as 'dict'. So the answer { a: 1 } is correct for a printed Map(1) { 'a' => 1 }, and formatVal prints a Map whose keys are all strings in object notation.
5. Interpretations I chose:
- An empty answer returns 'dont-know'; the pad should re-prompt before calling.
- Answer lines may carry '# -> ' or '// -> ' prefixes; these are stripped.
- ' | ' splitting also retries without splitting, so a printed 'a | b' still matches.
- Blank lines at the start or end of output and answer are ignored; blank lines in the middle count.
- Leading whitespace of a top-level str counts.
- Exception names compare case-insensitively and accept 'Name: msg', 'raises Name', 'Name(args)' and dotted names. A raising probe that printed lines first can be answered with the name alone or with lines plus the name.
- Typed duplicates are kept, so {1, 1, 2} for a printed {1, 2} is wrong: it signals the belief that sets keep duplicates.
- "Removing outer brackets" is format-only only when the answer has a top-level comma (or ':' / '=>' for a dict) and is not already a complete value. So 5 for [5] and [1, 2] for [[1, 2]] stay wrong.
- Tuple-to-list conversion applies at any depth.
- A multi-match on two non-ambiguous mutants is reported as ambiguous. An ambiguous match returns { verdict: 'wrong', ambiguous: true } with no mutantId.
- Bare 'error', 'an error', 'it raises an error' and 'error: ...' never match a mutant. JS 'Error' and Python 'Exception' are real class names and do match.
- The slip check uses edit distance at most 1 against the printed text, the one-line text, and both with whitespace removed.
- JS only: a top-level str starting with [ or { (JSON.stringify output) is also compared as parsed JSON, so spacing and quote style do not matter. Python top-level strs stay strict text, per the spec.
- Unparseable answers fall back to a collapsed-whitespace comparison that also drops whitespace next to punctuation outside quotes, e.g. Counter({'a':2}) matches Counter({'a': 2}).
6. parsePyLiteral rejects a bare top-level tuple '1, 2' (literal_eval would accept it), so that the bracket-removal format-only rule can apply. It also accepts printed-only forms: inf, nan, set(...), frozenset(...) and float('inf').
7. mutateLiteral goes slightly beyond the spec's list:
- tuples become () and get a duplicated element; bytes become b''.
- It recurses into list elements and dict values, but never into dict keys or set members.
- Floats, bools and None are not mutated.
- Boundaries (len-1 and len of each top-level sequence argument) apply only to top-level int arguments.
- Results are ordered top-level first, then empty, boundary, 0, -1, duplicate.
8. parseCall accepts Python set() (literal_eval accepts it) and rejects frozenset(), float(), inf/nan names and complex numbers. In JS it accepts NaN, Infinity, undefined, bigint and template literals without ${}, and rejects parentheses (the comma operator), __proto__ keys and Map/Set notation. One trailing ';' is accepted in JS; CallCheck.call returns the canonical text without it. Calls over 4000 characters are rejected, and nesting is capped at 100 levels.
## notesForIntegrator
WIRING:
- Predict items (pad, placement, sprints): compareOutput(answerText, probe.output, lang, { typeSensitive: tagInfo.typeSensitive, mutants: probe.mutants.map(m => ({ id: m.id, output: m.output, ambiguous: m.ambiguous })) }).
  - Pass what follows '# -> ' on each answer line, joined with '\n' (raw lines with the prefix also work).
  - Verdict.note is set only for format-only ('right idea; Python writes it as X').
  - For a 'actual: X' line use actualText(recorded, lang). For one value use formatVal(val, lang).
- Own-code predict / what-if: build RecordedOutput { stdout: repr, values: [[{ type, repr, val }]] }, or { stdout: '', values: [], exception: 'KeyError' } when the call raised, and pass { typeSensitive: false, returnValue: true }.
  - The what-if attribution check ('equals the unmutated output' / 'the alternative operator's output') is compareOutput(answer, thatOutput, lang, { typeSensitive: false, returnValue: true }).verdict === 'correct'.
- Model-pack verification (V1-5): compareOutput(modelPredicted, realOutput, lang, { typeSensitive: false }).verdict === 'correct'.
- answerSpaceG(recorded) is already used by src/atoms/seeds.ts with matching signatures, as is valEquals(a, b, { strict: true }).
- Spec ladder (V1-11):
  - Validate each call with validateCall(spec.call, lang, names), where names = interface.functions.map(f => mappedNames?.[f.name] ?? f.name). Store r.call (canonical: no trailing ';', ', ' separators).
  - Validate expected with parseLiteral(expected, lang, 'source'). For Python this matches what ast.literal_eval accepts (no inf/nan names); for JS it is a superset of JSON (JSON.parse in the harness still decides).
  - Interface mapping: renameCallee(call, learnerName).
- Own-code probes from spec mutation (V1-12): mutateLiteral(spec.call, lang) gives candidates, most telling first. Keep those where !visibleSpecs.some(s => sameArgs(parseCall(m, lang).args, parseCall(s.call, lang).args)). Run renameCallee as needed.

GOTCHAS:
- PrintedArg.val must be present for typed comparison. A missing val is treated as an opaque repr, compared as text.
- compare maps stdout lines to print calls only when the calls' rendered text (str args bare, others by repr, joined by ' ') reproduces stdout exactly. Otherwise (end='', sep=, '%d' formats, custom __str__) it falls back to text comparison with whitespace collapsed. The batch runner should therefore put Python repr(x) (= str(x) for builtins) and JS util.inspect(x) in PrintedArg.repr.
- I recommend the JS runner use util.inspect(x, { breakLength: Infinity, compact: true, depth: 8 }). Plain { breakLength: Infinity } still groups arrays into columns and prints [Object] past depth 2. compare copes with both forms either way.
- 'typescript' behaves exactly like 'javascript'.
- compareOutput is fast (all pathological cases I tried run under 15 ms) and never throws on bad input. Parse errors are internal (LiteralError) and only exported parse* functions throw.


# evidence  tests=True count=54
## exports
- evidence.ts: PARAMS (g/s by kind, caps, misconception odds, latency, fragile, propagation, audit, schedule, calibration numbers)
- evidence.ts: interface EvidenceRecord extends Evidence { s?: number; unverified?: boolean; belief?: string }
- evidence.ts: type CoverageFn = (c: ConceptState) => string[]; type TaxonomyFn = (misconceptionId, c) => {belief, prior} | undefined
- evidence.ts: applyEvidence(c: ConceptState, ev: EvidenceRecord, ctx?: { learner?: Learner; coverage?; taxonomy?; now?: number; propagate?: boolean; stats?: boolean }): ApplyResult  // steps 1-17; ApplyResult {discarded, weight, bits, guess, implicitGuess, latencyValid, before, after, outcome, propagated, mastered, masteredNow, revoked, fragile?, misconception?, suppressed?, cleared}
- evidence.ts: effGS(g, s): {g, s}; bkt(p, correct, g, s); posterior(p, correct, g, s) (capped); bits(prior, post) (KL in bits); scaleOdds(p, k); baseGS(ev, bumpG?); guessesUnflagged(learner); latencyUsable(ev); isPassive(ev)
- evidence.ts: parSelf(item: {kind?, codeLines, answerChars, parSec}, {cps, speedFactor}): ms; parAbs(item, {cps}): ms
- evidence.ts: caps(c, required?): {groups, production, coverage, missing, ok}; isMastered(c, required?); isFluent(c, required?); chip(c, required?): ConceptChip; blockingMisconceptions(c)
- evidence.ts: updateMisconception(c, ev, flags: AnswerFlags, taxonomy?): MisconceptionUpdate; propagate(learner, src, {up, down}, at, now?, coverage?): string[]; resolveId(concepts, id); syncMastered(c, at, required?); auditDue(concepts, now, rng?): ConceptState[]; scheduleOutcome(c, outcome: 'misconception'|'fragile'|'guess'|'solid'|'fail', now, restart?); touch(c, now); ITEM_KINDS
- learner.ts: recordEvidence(learner, input: EvidenceInput, opts?: EvidenceEnv): { evidence, result, concept } | undefined  // the single writer of mastery; EvidenceInput needs conceptId, kind, correct, source; defaults weight 1, learnT .05, guessFlag false, latencyValid false
- learner.ts: bindEvidenceEnv(learner, { log?, window?, coverage?, taxonomy?, clock? }); evidenceEnv(learner)
- learner.ts: migrateLearner(raw: unknown): Learner; migrateConcept(id, raw): ConceptState; emptyLearner(); PRIOR = .3; DECOMPOSITION = 'decomposition'
- learner.ts: upsertConcepts(learner, concepts: ConceptInput[] /* id, name, description?, prerequisites?, tag?, kind?, aliases? */, now?); concept(learner, id) (resolves aliases)
- learner.ts: recordSolve(learner, task, opts?: { solo?: boolean }); recordHintEvidence(learner, taskId, rung: number | 'reveal', diagnosedConceptIds); recordMistake(learner, { pattern, detail, conceptIds, taskId, misconceptionId? })
- learner.ts: allMastered(learner, ids); conceptMastered(learner, c); conceptChip(learner, c); snapshot(learner, ids?); conceptLine(c, required?)
- learner.ts: setPrior(learner, id, p, selfRating?); recordTypingCalibration(learner, chars, ms): cps
- learner.ts (kept for old coach): MASTERY_TARGET (deprecated), nudge(learner, ids, delta) (deprecated llm-grade wrapper), setMastery(learner, id, v) (deprecated), schedule(c, boolean | Outcome, now?), dueForReview(learner, limit?, now?), stuckThreshold, weakest, slug, clamp01
- store.ts: class Store { constructor(ctx: StoreContext /* vscode.ExtensionContext fits */, deps?: { fs?: EvidenceFs; windowId?: string; clock?: () => number }); learner; project; windowId; save(); flush(); resetProject(); resetLearner(); setEvidenceEnv({ coverage?, taxonomy? }); readEvidence(since, until?): Promise<EvidenceRecord[]>; flushLog() }
- store.ts: interface EvidenceFs { append(name, text); read(name); clear() }; interface Memento; evidenceFile(at): 'evidence-YYYY-MM.jsonl'; mergeLearner(base, mine, theirs, pending, env?): Learner
- types.ts: ConceptState extends Concept, ConceptEvidenceFields (+ lastWrongAt?); Learner extends LearnerEvidenceFields (+ audits {passed, failed}, resetAt?); Mistake.misconceptionId?; Task.pastedChars?, assistedChars?, assistedFunctions?
## deviations
All of the spec's test numbers come out of the stated formulas exactly, with no discrepancies: .30 -> .734, a second group gives the .8 cap, a completion then gives .962 and mastery, boolean .464, committed wrong .113, '?' and guess-flagged wrong .224, plan-pick .562. Correct answers use g_eff with the raw s; wrong answers use s_eff with the raw g. The weight is applied first, then T.

Where I departed from the spec, or had to read an ambiguous rule one way:

1. answerSpaceG is not re-exported from compare.ts. That file belongs to V1-2 and did not exist, so the caller passes Evidence.g. The base g values are in PARAMS.gs.

2. The Evidence contract has no fields for three things, so EvidenceRecord adds them locally, and they are also written to the log:
   - `s`: a slip override. recordSolve uses s .2 after rung 1-2 hints.
   - `unverified`: slip .2 and guess +.1.
   - `belief`: the belief text of a model mutant, used when the taxonomy has none.

3. Think time is clamped to 3-8 s only for probe-like items. Completions use 20-40 s, because clamp(parSec, 3, 8) would cut their 20-40 s par to 8 s and make every completion Fragile. Spec and task items are not clamped. The 60 s latency discard does not apply to 'spec' and 'task', whose latency is active coding time.

4. The caps never lower P: P = min(P', max(P_before, .8)). This only matters for:
   - v0.1 profiles above .8 (kept as the prior, but not mastered)
   - a guess-flagged correct answer on a concept already above .8, so honesty costs nothing

5. Added rule: a correct non-guess answer on an item carrying a candidate misconception's mutant multiplies the candidate's odds by 1/3. Without this, an unconfirmed placement candidate at p >= .3 would block mastery forever.

6. Added rule: propagation never raises an ancestor that had its own full-weight wrong answer in the last 7 days. This mirrors the spec's lowering rule and uses a new field, ConceptState.lastWrongAt.

7. A missed audit also clears `production` and `inferred`. Otherwise one correct predict would re-master the concept straight away.

8. Scheduling choices:
   - The ladders advance only when the previous review has come due, and Solid's x2.2 applies only on a due review. Otherwise several answers in one session would stretch the interval to 60 days.
   - The misconception ladder is 10 min -> .25 day -> 1 day, which combines the two versions in the spec.

9. The second delayed hit must come at least 1 day after the refutation (the spec's wording is ambiguous).

10. cps is set by recordTypingCalibration(). The calibration item is not scored, so it is never an Evidence record.

11. The snapshot example in the spec shows '[Learning ...] ... active', but the step-12 chip priority puts Misconception first, so I follow the chip. A suppressed misconception is printed as 'recently corrected'. Candidates are printed only when p >= .3.

12. `bits` is the KL divergence from the prior to the weighted Bayesian posterior, before T and the caps, so it measures information only.

13. Production credit comes only from 'completion', and from 'spec' at full weight.

14. Classification rules:
   - Passive evidence is kind 'passive', source 'passive', or kind 'spec'. It can raise p but never adds a group, never activates a misconception and never causes a relapse.
   - gradedCount, calibration and speedFactor count only pad-style items: predict, completion, traceback, own-predict, what-if, which-pattern, contrast-pick.

15. Format-only and weight-0 records are still logged, at weight 0, so the format-only-rate metric can be computed.

16. Additions to the types:
   - Learner: `audits {passed, failed}` and `resetAt`
   - Mistake: `misconceptionId`
   - ConceptState: `lastWrongAt`

17. Merging and storage:
   - The merge replays this window's unsynced evidence from memory, not by re-reading the log file. That covers this window's records, which is what 'rebuild from the log since the checkpoint' needs.
   - There is no load-time crash recovery from the log.
   - resetLearner also deletes the evidence-*.jsonl files.
   - On non-file (remote) storage, appends read and rewrite the file.

18. Extra changes:
   - stuckThreshold gives Fluent concepts the full 1.5x rope (learnerModelChanges).
   - selectionGap is set by a committed wrong sprint answer on a concept that has any correct non-guess group, and cleared by a correct sprint answer.
   - In a one-to-one alias merge, the plan concept's prerequisites are added to the seed concept's.
## notesForIntegrator
Breakage check: test/flow.test.ts (old coach) still passes unchanged. src/coach.ts compiles; MASTERY_TARGET, nudge, setMastery, schedule(c, bool) and recordMistake's old shape are still exported. tsc reports no errors in any of my files. The only other errors are in test/compare.test.ts, which is someone else's.

Wiring:
- `new Store(ctx)` works as before. The Store binds its log sink and window id to store.learner through bindEvidenceEnv (a WeakMap keyed on the learner object). Coach code therefore only calls `recordEvidence(this.learner, {...})`.
- Call `store.setEvidenceEnv({ coverage, taxonomy })` once the tag taxonomy and AtomCache exist:
  - coverage(c) returns the taxonomy misconception ids with prior >= .2 that have verified bank items
  - taxonomy(id) returns {belief, prior}
  - Without them, coverage is treated as satisfied and new misconceptions start at prior .15.
- Flushes keep the identity of the learner, its concepts and their misconception objects, so references held across awaits stay valid.
- If you mutate a ConceptState directly and that change must win when two windows edit the same concept, call `touch(c, Date.now())` from evidence.ts.

Evidence conventions for callers:
- Record ONE record per answer, after the y/n of the belief check:
  - y: misconceptionId, beliefConfirmed: true, misconceptionOdds: 6
  - n: beliefConfirmed: false, which halves the weight automatically and skips the misconception update
- Placement mutant match: misconceptionOdds 3 for curated mutants, 2 for model mutants, no beliefConfirmed.
- Correct re-probe after a refutation: `suppresses: M`.
- Sprint delayed checks: source 'sprint', `delayedCheckFor: M`, and avoidedMisconceptionIds listing the mutants the item carried. Correct items should always list the mutants they carried, because that list is the coverage.
- For model mutants, pass `belief`.
- learnT defaults to .05. Pass .3 after a contrast pick that follows a confirmed refutation, after a worked example followed by a passing completion, or after an escalation. Pass 0 if no feedback was shown.
- Predict-like items: pass g = answerSpaceG(output) from compare.ts.
- Latency: pass latencyMs, parSelfMs = parSelf(item, learner), parAbsMs = parAbs(item, learner) and latencyValid (focus kept). For a copied literal, set implicitGuess: true.
- Weights the caller decides: .3 for rung 1, lures, tinkering and assisted functions; .5 for hint rungs 2-5, failure signatures, unattributable what-ifs and confounded probes.
- Weights enforced automatically: '?', guess-flagged wrong, 'n' and llm-grade are capped at .5. Format-only or weight 0 means discarded (still logged).
- Spec greens: kind 'spec', production: true, weight 1 only within 3 saves and not assisted, otherwise .3.
- Audits: source 'audit', kind 'completion'. Use auditDue(learner.concepts, now) for sprint selection; inferred concepts come first. Misconception nextCheckAt drives the delayed checks.
- gotIt() should call recordHintEvidence(learner, taskId, rung | 'reveal', diagnosedIds).
- recordSolve(learner, task, {solo}) also reads task.fade === 'solo'.
- recordMistake accepts misconceptionId.
- setPrior(learner, id, p, 'used' | 'not-used') is for the tick picker; it never overrides a tested concept.
- recordTypingCalibration(learner, chars, ms) sets cps.
- The 'decomposition' concept is created automatically.

viewModel and stage-2 coach:
- Replace `c.mastery >= MASTERY_TARGET` with conceptMastered(learner, c) and conceptChip(learner, c), which use the bound coverage.
- For the Progress tab, show c.inferred, c.tested, c.misconceptions[*].belief/status, learner.calibration ({sure: [right, total], guess: [...]}), learner.audits and learner.falseMastery.
- Plan concept ids may now be aliases of seed ids. Filters like `p.conceptIds.includes(c.id)` should resolve through concept(learner, id) or c.aliases.
- Store.readEvidence(since, until) returns the JSONL log for the Pace metrics (bits, latency, verdicts).
- Delete the old nudge and setMastery calls when coach.ts is rewritten.


# jobs  tests=True count=60
## exports
- jobs.ts: class JobQueue implements Disposable { constructor(opts?: JobQueueOptions {concurrency?, callsPerHour?, hintReserve?, clock?: Clock, currentGen?: () => Gen, log?: (line: string) => void}); fg<T>(label: string, run: (signal: AbortSignal) => Promise<T>): Promise<T>; bg<T>(spec: JobSpec<T>, apply?: (value: T) => void): Promise<T | undefined>; has(key: string): boolean; cancel(key: string): boolean; cancelWhere(pred: (spec: JobSpec<unknown>) => boolean): number; pause(ms = 15min, reason: 'limit'|'manual' = 'manual', halved = false): void; stats(): JobStats; configure(opts: {concurrency?, callsPerHour?}): void; dispose(): void; readonly budget: RollingBudget; onDidSettle: Event<JobSettled>; onDidChange: Event<void>; onDeadlineMissed: Event<DeadlineMissed>; onDidPause: Event<JobPaused> }
- jobs.ts: class RollingBudget { constructor(opts?: {perHour?, hintReserve?, windowMs?, now?}); limit; hintLimit; isHalved; share(kind: JobKind): number; used(kind?: JobKind): number; canSpend(kind): boolean; spend(kind): void; nextFreeAt(kind): number; halve(): boolean; setPerHour(n): void }
- jobs.ts: genMatches(job: Gen, current: Gen, scope: JobScope): boolean; isLimitError(err: unknown): boolean; describeJobs(s: JobStats, now?: number): string ('running 2 · queued 1 · 7/20 this hour'); clampConcurrency(n?: number): number
- jobs.ts: class Emitter<T> { event: Event<T>; fire(e: T); dispose() }; interface Clock { now(); setTimeout(fn, ms); clearTimeout(h) }; const systemClock: Clock; types JobStats, JobSettled {key,label,priority,kind,scope,outcome:'done'|'error'|'dropped'|'canceled'|'stale',reason?,waitMs?,runMs?,error?}, DeadlineMissed {key,label,priority,neededBy,state:'queued'|'running',waitingFor?}, JobPaused {until,reason,halved}; re-exports Gen, JobSpec, JobScope, JobPriority, JobKind; constants WINDOW_MS, DEFAULT_CALLS_PER_HOUR=20, HINT_RESERVE=4, MIN_HALVED_BUDGET=6, LIMIT_PAUSE_MS, DEFAULT_CONCURRENCY=2, MAX_CONCURRENCY=3
- lock.ts: class InteractionLock { constructor(now?: () => number); acquire(kind: LockKind, onAbort?: (reason: 'esc') => void): (() => void) | undefined; abortActive(): LockReleased | undefined; get active(): LockKind | undefined; get held(): boolean; onDidRelease: Event<LockReleased {kind, reason: 'done'|'esc', ms}>; dispose() }
- tempo.ts: decide(input: TempoInput): SchedulerDecision (TempoInput = SchedulerInput & { activeAtPopByKind?: Record<string, number> }); sortActions(actions: Action[]): Action[]; popWindowOpen(input: SchedulerInput): boolean; sprintCapReached(input): boolean; pushBack(pushed: Record<string, number> | undefined, kind: ActionKind, now: number): Record<string, number>; savePause(reason: number, errorCount: number): PauseKind | undefined
- tempo.ts: statusText(icon: string, text: string): string; clip(text: string, max: number): string; status.{specProgress(green,total,nextTitle?), jitOffer(pattern, specTitle?), hintReady(file,line), warmup(due, seconds=60), predictOwn(fnName, seconds=15), preparing(what, progress?), runningSpecs(), specsReady(n), stateChange(concept, from, to)}; tempoTooltip(t: TooltipInfo): string (markdown); mdEscape(s); LIMIT_FLASH; constants NO_EDIT_MS, POP_SPACING_MS, PAUSE_WINDOW_MS, OWN_PREDICT_SPACING_MS, SPRINT_SHARE, PUSH_BACK_MS, STATUS_MAX, STATE_FLASH_MS
- annotationModel.ts: class AnnotationModel { set(a: Annotation, lineText: string): Route ('after'|'thread'|'folded'); routeOf(uri, line, source): Route | undefined; at(uri, line): Annotation[]; all(): Annotation[]; uris(): string[]; clear(filter?: {source?, uri?, line?}): Annotation[]; onDidChange(uri: string, changes: LineChange[], lineText: (line: number) => string | undefined): Annotation[]; render(uri: string): LineView[] }; routeText(source, text): 'after'|'thread'; toAfterText(text): string; AFTER_TEXT_MAX = 52; types LineView {uri,line,owner,afterText?,thread?,hover,sources}, LineChange {startLine,startCharacter,endLine,endCharacter,text}
- llm.ts: class Llm { constructor(secrets: vscode.SecretStorage, lmAccess?: vscode.LanguageModelAccessInformation); json<S>(req: JsonRequest<S>, opts?: JsonOptions {signal?: AbortSignal; fast?: boolean; background?: boolean}): Promise<z.infer<S>>; ensureBackgroundConsent(): Promise<boolean> }; class LlmError extends Error { constructor(message: string, kind: LlmErrorKind = 'other'); readonly kind }; type LlmErrorKind = 'limit'|'auth'|'format'|'other'; codexErrorKind(message: string): LlmErrorKind
## deviations
The spec does not settle these points, so I chose a rule for each one:

1. Hint reserve: 4 calls, but never more than half the limit. That gives 4/16 at the default of 20, 4/6 after halving to 10, and 3/3 at the floor of 6. Without the cap, a small configured budget would leave no share for other jobs, and the plan and TaskPrep would wait forever.
2. Halving: the new limit is max(min(n,6), floor(n/2)). A budget already configured below 6 is never raised. callsPerHour is clamped to at least 2 so each share has at least 1 call.
3. Added scheduling rule: speculative jobs (priority 2-3) may use at most concurrency-1 slots when concurrency is 2 or more. This keeps a slot free for priority 0-1 work. At concurrency 1 they may use the only slot.
4. During a pause, a new speculative job is dropped at once. The spec only says that queued ones are dropped when the limit is hit.
5. A priority 0-1 job that fails with a usage-limit error is retried once after the pause. The spec says nothing about this.
6. Missed deadlines: onDeadlineMissed fires for any job with neededBy that has not settled by then, whether it is queued (with waitingFor budget, pause or slot) or running. The spec only mentions jobs waiting for budget. The job keeps going either way.
7. bg(spec, apply?) takes an optional apply callback, because JobSpec has no apply field. The returned promise resolves undefined when the job is dropped, cancelled, stale or errored. Errors go to the log and are never thrown. Dedupe returns the identical promise. A dedupe request with a more urgent priority or an earlier neededBy raises those of a queued job. A key re-enqueued under a newer generation cancels the old job (reason 'superseded').
8. fg calls queue up one at a time rather than being refused while another is running. They are not counted against the budget. A usage-limit error in an fg call also pauses the bg lane.
9. Tempo, rule 4: the contract's lastPopByKind holds wall-clock times, but the spec counts active minutes. I added an optional input field, activeAtPopByKind, in tempo.ts (TempoInput extends SchedulerInput). When it is missing, wall-clock time is used. An own-predict offer that is not blocking appears only once it is allowed to pop (V1-12: shown only when the scheduler allows). It is held back while the stuck score is in [.5, 1.0); at 1.0 or more it is the pre-hint step and allowed.
10. Tempo, other choices:
   - Action.priority: lower numbers come first, as in the job queue.
   - Each action pops at most once (lastPopByKind[kind] >= createdAt).
   - jit-atom, specs-ready, spec, placement and info never pop.
   - Blocking actions other than sprints (atom, gate) are started by the learner, so Skip/Esc push-back and offer limits don't apply to them.
   - A blocking sprint opens on its own only outside building and with no edit in the last 8 s (V1-9). A warm-up never opens on its own.
   - The 15% cap applies to both sprint and warm-up.
   - In the tooltip, deliberate.showTimers controls only the streak line, as the spec says.
11. Annotations:
   - Hint text that is too long or spans several lines goes to a comment thread. Long text from any other source is cut to 52 characters with an ellipsis, and the full text goes in the hover. The spec defines threads only for hints.
   - A hint in a thread still owns its line, so no other source's after-text appears there.
   - Lines are 0-based.
   - Trailing whitespace does not count as a change to the anchored line.
   - Anchors move with lines inserted or deleted above them, following VS Code's in-order contentChanges.
12. llm.ts:
   - opts adds `background?: boolean`, which defaults to fast === false. It triggers the canSendRequest check for vscode-lm.
   - The constructor takes an optional lmAccess argument. ensureBackgroundConsent() is added.
   - Anthropic: 403 maps to 'auth'; a 'credit balance' error maps to 'limit'; max_tokens and a missing parsed_output map to 'format'.
   - The Anthropic client is now created inside the try block, so a missing-key error maps to 'auth'.
   - An aborted call throws signal.reason, an AbortError.
   - A Codex plan-limit message maps to 'limit' and 'not signed in' maps to 'auth'.
   - vscode.LanguageModelError code Blocked maps to 'limit' and NoPermissions to 'auth'.
13. contracts.ts was not modified, and no npm dependencies were added.
## notesForIntegrator
WIRING (extension.ts):
- Create the job queue: `const jobs = new JobQueue({ concurrency: cfg.get('backgroundConcurrency', 2), callsPerHour: cfg.get('backgroundCallsPerHour', 20), currentGen: () => coach.gen(), log: (l) => output.appendLine(l) })`.
- On configuration change, call jobs.configure({concurrency, callsPerHour}). Push jobs into ctx.subscriptions; dispose() cancels everything, including a running fg call.
- currentGen should not throw. Return {projectCreatedAt: project?.createdAt ?? 0, taskId: task?.id, taskSwitch: project?.taskSwitch ?? 0}. If it does throw, the queue logs it and treats project and task results as stale.
- The package.json settings are not added (that file isn't mine): deliberate.backgroundConcurrency (default 2, min 1, max 3) and deliberate.backgroundCallsPerHour (default 20; I suggest minimum 6).
- Create the LLM client as `new Llm(ctx.secrets, ctx.languageModelAccessInformation)`. Call `await llm.ensureBackgroundConsent()` from Start, which is a user action. For other providers it returns true at once.

COACH:
- bgAsk:
  `jobs.bg({key, priority, effort, label, scope, gen: this.gen(), kind: isHint ? 'hint' : undefined, neededBy, run: (signal) => this.llm.json({system, prompt, schema, effort}, {signal, fast: false})}, apply)`
  - Do every write in `apply`, which runs only if the generation still matches.
  - The promise resolves undefined when the job is dropped, cancelled, stale or errored. Treat undefined as 'no result'. It never rejects.
- fg replaces run(): `jobs.fg(label, (signal) => this.llm.json(req, {signal}))`.
  - Errors propagate, so keep the error card.
  - The busy label is jobs.stats().fg. 'n preparing in background' is stats().running (+ queued). Subscribe jobs.onDidChange to refresh the busy bar and the tooltip.
- The queue recognises usage-limit errors by err.kind === 'limit' (LlmError.kind), in both lanes. On jobs.onDidPause, flash LIMIT_FLASH (from tempo.ts) with setStatusBarMessage.
- jobs.onDeadlineMissed(e) is where to apply the degraded path by key (TaskPrep late, TaskBatch late, ...). The job keeps running and its apply still attaches later.
- maybeOfferHelp: `jobs.has('hint:' + taskId)` is the 'hint job for this task is in flight' check.
- hint() single-flight: bg with the same key returns the in-flight promise. A dedupe request at priority 0 raises a queued priority-2 prefetch.
- On-demand hint calls on a prefetch miss: use fg (unbudgeted), or bg with kind 'other'. A priority-0 job of kind 'hint' waits if the 4/hour hint reserve is used up.
- startTask, newProject, resetProfile:
  - call lock.abortActive() (its return value has reason 'esc': record Esc, no penalty)
  - bump project.taskSwitch
  - jobs.cancelWhere(s => s.scope === 'task'), plus s.scope === 'project' for a new project or a reset

LOCK:
- `const release = lock.acquire('atom', () => closePadOrPick()); if (!release) { enqueueAction(...); return; } try { ... } finally { release(); }`
- release() is idempotent and never frees a later holder's lock. The abort callback runs before onDidRelease fires.
- Use lock.onDidRelease to re-run decide(), so a queued blocking action can open.

TEMPO (tempoBar.ts):
- Call decide({...SchedulerInput, activeAtPopByKind}) on: each monitor tick (5 s), each pause event, each enqueued action, each lock release.
- When pop is true: show the warning background and flash action.label, then record lastPopAt = now, lastPopByKind[kind] = now and activeAtPopByKind[kind] = activeMsToday.
- When open is true: run action.command(...args) and remove the action from the queue.
- On Skip/Esc: pushedBack = pushBack(pushedBack, kind, now).
- Monitor: in onWillSaveTextDocument, use savePause(e.reason, errorCount); a value of 'manual-save' is a pause.
- Text helpers:
  - status.* and statusText give texts within 40 chars; when clipping, only the variable part is cut, so the '· 60s?', '(15s)' and ':line' endings survive.
  - tempoTooltip(info) returns markdown for new vscode.MarkdownString.
  - describeJobs(jobs.stats()) gives the jobs line.

ANNOTATIONS (annotations.ts):
- Lines are 0-based. Call model.set(annotation, doc.lineAt(line).text); it returns 'after', 'thread' or 'folded'.
- On onDidChangeTextDocument:
  `const removed = model.onDidChange(uri, e.contentChanges.map(c => ({startLine: c.range.start.line, startCharacter: c.range.start.character, endLine: c.range.end.line, endCharacter: c.range.end.character, text: c.text})), l => l < doc.lineCount ? doc.lineAt(l).text : undefined)`
  Then dispose the threads of the removed annotations and re-render.
- model.render(uri) returns LineView[]:
  - afterText goes in after.contentText
  - hover is markdown: the owner's raw hover first, then the escaped lower-priority texts
  - thread is the hint text for the comment controller
- The model does not own threads. Compare the thread lines in render() with the threads you hold.

TESTS:
- systemClock timers are unref'd. A test using the real clock that waits for a wake-up (neededBy, a budget window, a pause) must keep the event loop alive itself, or use a manual clock like FakeClock in test/jobs.test.ts.
- jobs.ts exports Emitter, which matches the vscode.Event listener shape; lock.ts reuses it.

NOTE: llm.ts calls runCodex(opts, system, prompt, schema, signal). The other engineer's codex.ts change has landed, and tsc is clean for all my files.


# seedsEngine  tests=True count=30
## exports
- tags.ts: interface TaxonomyMisconception extends TagMisconception { langs?: Lang[] }
- tags.ts: interface TaxonomyEntry extends TagInfo { misconceptions: TaxonomyMisconception[]; jsExample?: string }
- tags.ts: const OTHER_TAG = 'other'; const SEMANTICS_TAGS: readonly string[] (the 10 spec semantics tags)
- tags.ts: const CANONICAL_TAGS: readonly string[] (64 spec tags in fundamentals-first order + 'other' last)
- tags.ts: const TAXONOMY: Record<string, TaxonomyEntry>
- tags.ts: tagInfo(tag: string): TaxonomyEntry | undefined
- tags.ts: canonicalTag(tag: string): string  // 'List Slicing' -> 'list-slicing', unknown -> 'other'
- tags.ts: isSemantics(tag: string): boolean
- tags.ts: tagsFor(lang: Lang): string[]  // never 'other'
- tags.ts: misconceptionsFor(tag: string, lang: Lang): TaxonomyMisconception[]
- tags.ts: findMisconception(tag: string, id: string): TaxonomyMisconception | undefined
- tags.ts: exampleFor(tag: string, lang: Lang): string
- tags.ts: ancestors(tag: string, lang?: Lang): string[]  // transitive prereqs + parents
- tags.ts: descendants(tag: string, lang?: Lang): string[]  // tags that transitively build on it
- tags.ts: topoOrder(lang: Lang): string[]  // throws on a cycle
- tags.ts: const PLACEMENT_FUNDAMENTALS: Record<Lang, readonly string[]>  // 22 python, 22 js, 23 ts, dependency-ordered
- seeds.ts: class Instantiator { constructor(runner: Runner, seed = 1, hooks?: InstantiatorHooks); get lang(): Lang; instantiate(templates: readonly SeedTemplate[], n: number, opts?: InstantiateOptions): Promise<InstantiateResult> }
- seeds.ts: interface InstantiateOptions { seed?: number; exclude?: Iterable<string>; maxRounds?: number /*default 3*/; signal?: AbortSignal; itemTimeoutMs?: number }
- seeds.ts: interface InstantiatorHooks { sameOutput?(a, b): boolean; buildTraceback?: TracebackBuilder; answerSpaceG?(out): number }
- seeds.ts: interface InstantiateResult { byTag: Record<string, SeedPieces>; reports: TemplateReport[] }
- seeds.ts: interface SeedPieces { probes: StoredProbe[]; examples: StoredExample[]; completions: StoredCompletion[]; contrasts: StoredContrast[]; tracebacks: TracebackItem[] }; emptyPieces()
- seeds.ts: interface TemplateReport { templateId; tag; kind; requested; drawn; valid; rounds; exhausted; rejected: Record<reason, number>; transforms: {misconceptionId; applies; ran; changed}[]; droppedWrongFills; problems: string[] }
- seeds.ts: interface SeedBank extends SeedFile { patterns?: Record<string, AtomPattern> }
- seeds.ts: parseSeedBank(json: unknown, lang?: Lang): { bank: SeedBank; problems: string[] }
- seeds.ts: prepareTemplate(t: SeedTemplate, lang?: Lang): PreparedTemplate  // static validation: { ok, problems, transforms (applicable indexes), themeNames, derive }
- seeds.ts: seedPattern(tag: string, bank?: SeedBank): AtomPattern  // name forced to canonical patternName
- seeds.ts: seedAtom(tag: string, lang: Lang, pieces: SeedPieces, bank: SeedBank | undefined, now: number): StoredAtom
- seeds.ts: seenWithin7Days(stats: Pick<ItemStats,'seenAt'> | undefined, now: number): boolean; REPEAT_WINDOW_MS
- seeds.ts: templateIdOf(itemId: string): string; emptyStats(): ItemStats
- seeds.ts: sameOutput(a: RecordedOutput, b: RecordedOutput): boolean  // strict comparison via compare.ts valEquals
- seeds.ts: buildTraceback: TracebackBuilder = (code, record, lang, rng) => TracebackParts | undefined; EXCEPTION_MEANINGS
- seeds.ts: class Rng { int; pick; sample; shuffle; float }; mulberry32(seed); hash53(s, seed?)
- seeds.ts: drawSlot(spec: SlotSpec, rng: Rng, values, parsed?): [SlotValue, string]; parseDerive(expr); evalDerive(expr, values): number; class SlotError
- seeds.ts: fillHoles(text, texts, vars); applyTransform(code, find, replace): string | undefined; countOccurrences; singleDiffLine(a, b): number | undefined; fillBlanks(code, fills); harnessChecks(harness): { calls: number; expected: string[] }
- seeds.ts: WORD_POOLS (nouns, names, fruits, cities, colors, animals); PASS_SEEDS = [1, 2]
## deviations
1. Language-specific misconceptions. The TagMisconception contract has no language field, but several beliefs exist in only one language (Python `-7 % 3`, JS `arr[-1]`, empty list vs empty array truthiness). I added a local `TaxonomyMisconception { langs?: Lang[] }` and `TaxonomyEntry extends TagInfo { jsExample? }`, plus `misconceptionsFor(tag, lang)` and `exampleFor(tag, lang)`. TAXONOMY is still assignable to Record<string, TagInfo>. Each language sees 2-4 misconceptions per tag. Four tags (string-indexing, integer-division-modulo, function-params-defaults, file-read-lines) have 5 in total across languages. A misconception id shared between tags always has the same belief text (tested).
2. CANONICAL_TAGS has 65 entries: the 64 spec tags plus 'other' last. tagsFor() and topoOrder() leave 'other' out. reading-tracebacks is kind 'shape', since it is not in the spec's semantics list. For sub-atoms, parent = the head of the LARGE TAGS chain, and prereqs = the previous tag in the chain.
3. Seed file format adds `patterns: { [tag]: AtomPattern }` (local type `SeedBank extends SeedFile`). Seed atoms need a pattern card and SeedFile has nowhere to put one. If a card is missing, parseSeedBank reports it and falls back to a minimal card built from the taxonomy.
4. The instance id hashes the theme name as well as the slot values (`${templateId}#${hash}`), because the theme changes the code.
5. A transform that does not apply (find not exactly once, multi-line find/replace, replace == find, misconception id not in the taxonomy for this tag and language) is dropped and reported. It does not invalidate the whole template; a probe template is unusable only if no transform applies. Overruns of word limits, line counts and parSec are reported but are not fatal at runtime. verify-seeds fails on any reported problem.
6. Rounds: pass A runs every instance and mutant of every template in ONE runBatch call. Pass B (hash seed 2) reruns only the instances that survived pass A, which saves a spawn when everything is already invalid. Each round costs two spawns at most.
7. Traceback items use a default builder in seeds.ts with a local exception-meaning table, because src/atoms/traceback.ts did not exist yet. It can be swapped in through `hooks.buildTraceback`. It is tested against the real batch.py and batch.mjs error formats. correctMeaning is 0-based.
8. Probes that raise on purpose are accepted when the original raises a real exception (never a syntax error) and are marked `raises: true`. Lines printed before the raise count toward the 1-4 line limit. answerSpaceG comes from compare.ts, as planned.
9. The tags' allowedImports are passed to the runner as `allowImports` on an extended BatchOptions object (LocalRunner reads it as LocalBatchOptions); the contract's BatchOptions has no such field.
10. verify-seeds runs with maxRounds 1 and a fixed seed, so the 80% threshold measures raw per-draw validity and failures reproduce. If a template runs out of distinct slot values, the ratio is valid/drawn and a note is printed.
11. tsconfig `include` covers only src and test, so `npx tsc --noEmit` does not check scripts/verify-seeds.ts. I checked it separately with a scratch tsconfig: clean. I did not add the package.json `verify:seeds` script, because package.json is not my file.
## notesForIntegrator
LOADING
- Read media/seed/<lang>.json with vscode.workspace.fs, then `const { bank, problems } = parseSeedBank(JSON.parse(text), lang)`. Log `problems` to 'Deliberate: content'.
- Create the instantiator with a seed that varies per session: `const inst = new Instantiator(runner, Date.now() >>> 0)`. The default seed of 1 gives the same draws every session (fine for tests).
- Call `const { byTag, reports } = await inst.instantiate(templates, 3, { exclude: <every item id already in the AtomCache for this lang>, signal })`.
- Each call costs 2 spawns at most per round (all templates in one batch), and 3 rounds at most by default.
- byTag is keyed by tag. For seeds, conceptId = key = tag. Without a cached atom, use `seedAtom(tag, lang, byTag[tag], bank, Date.now())`; otherwise append the pieces to the cached atom (LRU 60).

REFILL AND PLACEMENT
- Refill: `bank.templates.filter(t => t.tag === tag)` with n = 6 minus the unseen stock, still passing `exclude`.
- Placement candidates: templates whose tag is in PLACEMENT_FUNDAMENTALS[lang].
- For unseenProbes and sprints: `seenWithin7Days(item.stats, now)` and `templateIdOf(id)`.

IDS
- Instance (probe/completion/etc.) id: `${templateId}#${hash36}`.
- Mutant id: `${probeId}~${misconceptionId}`.
- Batch item ids: `${instanceId}~orig|m<i>|sol|empty|wf<i>|const<i>b<j>|wrong|right|run`.
- Template ids must not contain '#', '~' or spaces (validated).

RUNNER BEHAVIOUR
- wantTrace is set only for Python probe originals whose tag has stateTrace.
- The tags' allowedImports go to LocalRunner as `allowImports`.
- Denied items are reported in TemplateReport.problems.
- For traceback items, `hooks.buildTraceback` can switch to src/atoms/traceback.ts once it exists. The default already handles the real batch.py and batch.mjs formats (snippet frames only, renumbered to pad lines; JSON SyntaxError recognised as a real error).

PACKAGING
- package.json needs `"verify:seeds": "tsx scripts/verify-seeds.ts"`, and `package` should run it.
- The script exits 1 on: seed-file problems, fewer than 80% valid draws, a transform that never changes the output, or no runtime found. `DELIBERATE_PYTHON=<python.exe>` pins the interpreter; the broken `py -3` launcher is just a later fallback.
- Make sure .vscodeignore keeps media/seed/*.json in the vsix.

FOR THE SEED-BANK AUTHORS
- The exact JSON format, with an example, is documented at the top of src/atoms/seeds.ts. media/seed/python.json is a working sample (20/20 valid on Python 3.14) with a probe (2 transforms), a completion and a contrast.
- Every transform, wrongFill and contrast misconceptionId must be a tags.ts id valid for the language: check with `misconceptionsFor(tag, lang)`.
- Use derived slots in `replace` so mutants read like real code (`[2:5]`, not `[2:4 + 1]`).
- Harness checks must have the shape `check(f(...) == literal, 'msg')`, at least 2 of them, so the constant-fill test can work.
- Under typeSensitive tags, print repr/type or JSON.stringify/typeof.
- Run `npx tsx scripts/verify-seeds.ts python` before handing off.

GENERAL
- tags.ts is pure and has no dependencies. seeds.ts imports valEquals and answerSpaceG from src/compare.ts and nothing from vscode.
- `canonicalTag()` normalises a model's tag output to a canonical tag or 'other'.


# atoms  tests=True count=100
## exports
- schemas.ts: AtomPackSchema (+ types AtomPack, PackAtom, PackProbe, PackMutant), MisconceptionGuessSchema (MisconceptionGuess), EscalationLessonSchema (EscalationLesson), TaskOutSchema (TaskOut, has `interface`), PlanOutlineSchema (PlanOutline), TaskBatchSchema (TaskBatch), SpecItemSchema (SpecItemOut), SpecLadderPartSchema (SpecLadderPart), GatePartSchema (GatePart), TaskPrepSchema (TaskPrep), HintLadderSchema (HintLadder), OwnCodeProbeSchema (OwnCodeProbes), ConceptSchema now has tag (ConceptOut). Legacy PlanSchema/DiagnosticSchema/LessonSchema/RecallSchema etc. kept.
- verify.ts: verifyPack(pack: AtomPack, runner: Runner | null | undefined, lang: Lang, ctx?: VerifyContext): Promise<PackVerifyResult>
- verify.ts: PackVerifyResult { atom: StoredAtom | null; repairs: RepairItem[]; dropped: DroppedItem[]; log: string[]; needsRepair: boolean; failRatio: number; results: VerifyResult[] }
- verify.ts: VerifyContext { now?; variant?: 'full'|'mini'|'probes-only'; concepts?: {id, tag}[]; keyFor?(conceptId, tag); extraImports?; signal?; itemTimeoutMs? }
- verify.ts: VerifyResult { conceptId; tag; key; atom; accepted; repairs; dropped; log; failed; total }, RepairItem { conceptId; itemId; kind; what; stderr }, DroppedItem { conceptId; itemId; kind; reason }
- verify.ts: verifyLesson(lesson: EscalationLesson, runner: Runner | null | undefined, opts?: { signal?; extraImports?; itemTimeoutMs? }): Promise<LessonVerifyResult { lesson; outputVerified: boolean; output?: RecordedOutput; log: string[] }>
- verify.ts helpers: REPAIR_THRESHOLD (0.4), normCode, cutWords, slugId, diffLine(a, b): number, refutationLeak(refutation, code), checkConditions(harness), typeVisible(code, out, lang)
- prompts.ts: atomPackPrompt(p: AtomPackPromptInput), miniAtomPrompt(p), probesOnlyPrompt(p), repairPrompt(runtime: string, failures: RepairItem[], previous?: AtomPack), repairLine(f), misconceptionGuessPrompt(MisconceptionGuessInput), escalationLessonPrompt(EscalationLessonInput), PROMPT_EFFORT, REPAIR_STDERR_CHARS
- prompts.ts input helpers: runtimeLabel(rt) -> 'Python 3.14.0' | 'Node v24.11.1', packConcept(id, tag, description, name?), taxonomyFor(tags, lang), anyTypeSensitive(tags), tagImports(tags)
- cache.ts: class AtomCache(lang: Lang, io?: AtomCachePersistence { load(): Promise<AtomCacheData|undefined>; save(d): Promise<void> }, opts?: { now?; debounceMs? (default 2000, <0 = manual); onError? })
- AtomCache methods: load(), keys(), has(key), get(key): StoredAtom | undefined, put(atom), unseenProbes(key, n, excludeGroups?, preferMisconception?, allowedConstructs?): StoredProbe[], unseen(key, kind, n?, excludeGroups?), seenIds(key): string[], markSeen(key, itemId, at?): boolean, recordItemStat(key, itemId, correct, ms?): boolean, recordMutantResponse(key, mutantId, 'match'|'yes'|'no'): { retired; precision? } | undefined, stock(key): StockInfo, lowStock(key): boolean, merge(other: AtomCache | AtomCacheData), toJSON(): AtomCacheData, flush(): Promise<void>, dispose(): Promise<void>
- cache.ts: ITEM_CAP (60), LOW_STOCK (3), RETIRE_ASKS (5), RETIRE_PRECISION (0.3), isRetired(m), precision(m), mergeAtoms(base, incoming), types AtomCacheData { version: 1; lang; atoms; meta }, ItemMeta, StockInfo, MutantResponse, ItemKind
## deviations
1. verifyPack return shape: a pack has 1-2 atoms and the spec wants one batch for the whole pack. So it returns PackVerifyResult. Its top-level {atom, repairs, dropped, log} is the shape you asked for: `atom` is the first atom's result, and repairs, dropped and log are concatenated over all atoms. `results[]` has one VerifyResult per atom; use it for 2-concept packs.
2. needsRepair = there are repairs AND (failRatio > 0.4 OR some atom failed acceptance). The extra trigger exists because a mini atom (2 probes + completion) with one bad probe is at 33% and could otherwise never be repaired. Exactly 40% does not trigger; the spec says "more than 40%".
3. failRatio counts runnable items only: probes, example, completion and contrast. Missing expected parts count as failures. Pattern useCases < 6 goes to the repair list but is not in the ratio and does not block acceptance. Pattern fields over their word limits are logged, not cut.
4. Completion harness: besides ≥2 distinct check(...) conditions, the harness must contain check(f(...) == literal) (or ===) checks. Without them no constant fill can be built, so the completion is rejected.
5. The type-sensitive check is a heuristic. A bare numeric printed argument fails. A str argument fails only when the probe code never uses repr(/!r/%r/type(/__name__ (Python) or JSON.stringify/typeof (JS). Bools and None are allowed (the spec names only str and numbers).
6. A mutant whose output is within edit distance 1 of the real output is kept, but it does not make the probe discriminating: compareOutput's slip rule means it can never match.
7. Execution off (runner null): verified=false, as the spec says. In addition: mutants are marked ambiguous=true, so matching stays off even if a grader ignores `verified`; contrasts are dropped, because their outputs would only be model claims; the example output is empty; probe and mutant outputs are the model's claimed text.
8. REPAIR prompt: the text is verbatim, with the previous pack appended as JSON when it is passed in. The call is stateless, so the model cannot "return the same atoms" without seeing them.
9. verifyLesson: a stated output is either a marker comment ('# -> x', '# Output: x'), a trailing comment on a print line, or an 'Output:' line or text block after the fence. Each group of stated output is checked against the real output and removed on mismatch. An example that does not parse is removed whole. An allowlist-denied or crashing example keeps its code but loses its stated output.
10. Schemas live in src/schemas.ts, as assigned, not src/atoms/schema.ts as the spec's file list says. ConceptSchema gains tag. The legacy PlanSchema uses a tag-less copy (ConceptSchema.omit({tag})) so the v0.1 coach and flow.test.ts keep working (FakeLlm validates against the real schema).
11. Cache merge across windows: counters (n, nCorrect, matches, confirmations, rejections) take the max and show times are unioned. Nothing is ever double counted, but a concurrent increment can be lost. Retired mutants are hidden by get() and unseenProbes(), worked out from the counters, and are never deleted, so a merge cannot bring one back. The LRU cap keeps at least 4 probes and 1 item of every other kind. Show times of evicted items are kept for 7 days, so the no-repeat rule still holds.
12. Strictness choices: a probe over 8 lines or a contrast snippet over 4 lines is rejected before running. Example and completion line counts are only logged. parSec is clamped to 3-8 for probes and 20-40 for completions. The refutation number check compares whole number tokens, so '2' is not cleared by '12' in the code.
## notesForIntegrator
PACK FLOW (prefetch.ts):
- Build the prompt input with packConcept(id, tag, description, name), taxonomyFor(tags, lang), anyTypeSensitive(tags) and runtimeLabel(runtime).
- allowedImports is not built for you: it is the runner's base Python allowlist plus tagImports(tags). The base list is private in runner.ts, so pass your own copy, or [] for JS.
- Call the model with AtomPackSchema at PROMPT_EFFORT.atomPack ('medium'). Use miniAtomPrompt/probesOnlyPrompt at 'low'.
- Then: r = await verifyPack(pack, runner (null when execution is off, untrusted or there is no runtime), lang, { variant, concepts: [{id, tag}], extraImports, signal }). variant is 'mini' or 'probes-only' for those prompts.
- If r.needsRepair: call the model again with repairPrompt(runtimeLabel(rt), r.repairs, pack) at 'low' and AtomPackSchema, then verifyPack again with the same ctx.
- For each r.results[i].atom that is non-null: cache.put(atom). put() merges by item id, so you can put both rounds' atoms.
- Repairs still left after the second round go to the 'Deliberate: content' channel (r.log has ready-made lines).
- A concept with no atom in either round: ConceptState.probeable = false.
- 'other' concepts: get extraImports from LocalRunner.findPythonModules().

GOTCHAS:
- verifyPack needs no special Runner: it checks the allowlist itself and also passes allowImports in the batch options, as LocalBatchOptions expects.
- Stored ids depend only on content: `${key}#p<hash>` for probes, #x for examples, #c for completions, #k for contrasts, and mutants are `${probeId}~${misconceptionId}`. Model ids such as 'p2' appear only in RepairItem.itemId, for the repair prompt.
- Probe groups are 'm:<slug(siblingGroup)>'.

ESCALATION:
- Call escalationLessonPrompt(...) with EscalationLessonSchema at 'low'.
- Then v = await verifyLesson(lesson, runner) and store v.lesson in project.prefetch['lesson:<concept>:<M>'].
- Log v.log. v.output holds the real output if you want to show it.

CACHE (extension.ts):
- One AtomCache per language: new AtomCache(lang, { load: read and JSON.parse globalStorageUri/atoms/<lang>.json, or undefined if missing; save: JSON.stringify then write }, { onError: log }).
- `await cache.load()` at activation; `await cache.dispose()` on deactivate (it flushes).
- Writes are debounced at 2 s. Every write re-reads the file and merges by item id first, which makes it multi-window safe.
- A put() whose atom lang differs from the cache lang throws.

PAD / GRADE / SPRINT:
- get(key) returns a deep copy without retired mutants.
- Call markSeen(key, itemId) when an item is shown; that is what enforces the 7-day rule. recordItemStat(key, itemId, correct, ms) on grading does not mark seen.
- recordMutantResponse(key, mutantId, 'match') on a match, then 'yes' or 'no' after the belief check. The result says whether the mutant is now retired.
- unseenProbes only orders by preferMisconception and allowedConstructs; it does not filter. The caller must check:
  - whether the chosen probe carries an unambiguous mutant for M (RE-PROBE);
  - whether p.constructs ⊆ allowed; if not, record the item at weight .5.
- Other kinds: unseen(key, 'completions' | 'tracebacks' | ...).
- seenIds(key) is the Instantiator's `exclude` list.
- stock(key) / lowStock(key): low stock means fewer than 3 unseen probes.

SCHEMAS:
- PlanSchema (v0.1) still uses tag-less concepts. ConceptSchema with tag is used by PlanOutlineSchema.
- Stage 2 can delete PlanSchema, DiagnosticSchema, LessonSchema and RecallSchema; the LegacyConceptSchema helper goes with PlanSchema.
- test/schemas.test.ts checks at compile time that the zod outputs still fit contracts SpecItem, FailureSignature, GatePattern, GatePlan and TaskInterface.


# cores  tests=True count=110
## exports
- grade.ts: commentToken(lang): '#'|'//'; parseAnswerLines(text, token, {split?}): string[]; answerText(text, token): string (unsplit, for compareOutput); gradePredict(answer, probe, lang, typeSensitive): PredictGrade {verdict, empty, correct?: boolean|null, mutant?, misconceptionId?, actual, avoidedMisconceptionIds, copiedLiteral, note?, ambiguous?}; copiesLiteral(answer, code, lang); codeLiterals(code, lang); async gradeCompletion(docText, completion, runner, lang, {signal?, itemTimeoutMs?, allowImports?}): Promise<CompletionGrade {empty, pass, fills?, blankLines (0-based), misconceptionId?, wrongFillBlank?, message?, checkFailed, crashLine?, timedOut, denied?, ms}>; extractFills(doc, code); unfilled(fills); matchWrongFill(completion, fills?, doc?); failingCheckLine(error): string|undefined; exceptionLine(error, exception?, lang?); parseTracebackAnswer(answer); gradeTraceback(answer, item, {lineOffset?, pick?}): TracebackGrade {line?, name?, empty, dontKnow, lineOk, nameOk, meaningOk?, correct, misconceptionId?}; gradeMeaningPick(pick1Based, item)
- render.ts: renderView(view: PadView, ctx: {lang, keyUse?}): PadRender {text, snippet?: SnippetPart[], snippetText?, await: 'answer'|'yn'|'pick2'|'pick3'|'read', answerLine?, answerColumn?, answerSelectEnd?, decorations: {line (0-based), text<=52, hover?, kind}[], codeStart?, lineOffset?, correctPick?, blankLines?}; renderProbe/renderTyping/renderBeliefCheck/renderContrastPick/renderReveal/renderExample/renderCompletion/renderCompletionReveal/renderEscalate(lesson?, completion?, ctx, pending?)/renderTraceback/renderTracebackMeaning; feedbackDecoration(fb: Feedback, line): PadDecoration; keysUsed(answer, guess): string[]; legendNeeded(keyUse); KEYS; LEGEND; indentTo4(code); snippetString(parts); afterText(text); lessonComments(lesson, tok); types PadView, PadRender, PadDecoration, DecorationKind, Feedback, LessonText, SnippetPart
- stepMachine.ts: startAtom(input: AtomStart): StepOutput; stepAtom(state: AtomRunState, ev: AtomEvent): {state, effects: AtomEffect[]}; atomDeadline(state): number|undefined; activeMs(state, now); routeAtom(concept, {now, tag?, placementDontKnow?, confirmedMisconceptions?}): Route; recentCorrectGroups(concept, now); isLargeTag(tag); chooseItem(atom, req: PickRequest, {now, allowedConstructs?}): PickedItem|undefined; itemId(item); ATOM_CAPS; REVIEW_MS; types AtomRunState, AtomStep, AtomEvent ('item'|'submit'|'completion-graded'|'yn'|'pick'|'continue'|'lesson'|'esc'|'abort'|'tick'), AtomEffect ('pick'|'render'|'feedback'|'evidence'|'seen'|'item-stat'|'mutant'|'run-completion'|'request-lesson'|'review'|'exit'), PickRequest, PickedItem, GradedEntry, Route
- traceback.ts: EXCEPTION_TABLE; meaningOf(exc, lang); meaningChoices(exc, lang, rng?): {meanings, correctMeaning (0-based)}|undefined; parseTrace(error, lang, exception?): ParsedTrace|undefined; failingFrame(t); outermostFrame(t); formatTrace(t, code, lineOffset=0); renumberTrace(trace, offset); parseItemTrace(trace); frameCount(item); preferMultiFrame(items); buildTracebackParts: TracebackBuilder (seeds-compatible); buildTracebackItem({id, code, record, lang, siblingGroup, conceptId?, rng?}): TracebackItem|undefined; raisingCandidates(probes, lang)
- placement.ts: newPlacement(now, calibrated?); nextItem(state, sources: {candidates, now, lang, constructConcept?}, learner, dag: {prereqs?, needed?}, {planPending?}): PlacementItem|undefined ('typing'|'predict'|'completion', extra?/label? for 'roadmap almost ready'); record(state, obs): PlacementState; escape(state); shouldStop(state, sources, learner, dag, {planPending?}): {stop, reason?: 'esc'|'fast-lane'|'time'|'max-items'|'classified'|'no-items'|'plan-pending', extraPhase?}; summary(state, learner, {now, names?, needed?}): {items, ms, solid, newConcepts, misconceptions, text, flash}; placementScore(...); importance(...); typingLiteral(lang, seed); formatDuration(ms); PLACEMENT
- sprintSelect.ts: newSprint(now); nextSprintItem(state, ctx: {now, lang, learner, stock: Record<id, {probes?, completions?, contrasts?, tracebacks?}>, guessFlagged?, deck?, rng?}): SprintPick|undefined ('predict' w/ delayedCheckFor?|'completion' w/ audit|'contrast'|'traceback'|'which-pattern' w/ options+correct); recordSprintPick(state, pick, at); sprintItemId(pick); sprintShouldStop(state, {now, budgetMs?, maxItems?, esc?, untilSettledAt?, itemOpen?}): {stop, reason?, abandonCurrent?}; SPRINT
- mutants.ts: OPERATORS (MutantOp {id, tag, misconceptionId, families, alternative?, label}); applyOperator(lineText, op, lang, occurrence=0): string|null; findOperator(lineText, op, lang, occurrence?): {start, end, replacement, mutated}|null; operatorSites; alternativeLine(lineText, op, lang); maskLine(line, lang); shiftExpr(text, delta, lang?); operatorsFor(lang); operatorsForTag(tag, lang); tagOfOperator(id); tagOfMisconception(id); whatIfCandidates(lines: {line, text}[], lang, {weakestTag?, journal?, max=2}): WhatIfCandidate[]; attributeWhatIf(answer, {actual, unmutated, alternative?}, lang, op?): {verdict, correct, evidence, attributable, matched?, weight, misconceptionId?, misconceptionOdds?}
- gateCore.ts: fadeLevel(decompositionP, solo?): FadeLevel; taskFade(learner, solo?); isSoloTask(milestones, taskId); gateDecision(task: {conceptIds, solo?, fade}, earlierTasks, learner): {run, reason, newConcepts}; gateRuns(...); planLengthsOk(plans); gateSteps(fade, plans): {stepA, stepB}; shuffled(xs, rng?); gateWords(patterns, plans?); gradePatternPick(patterns, selectedNames, at, taskId?): PatternGrade {selected, missed, lures, requiredTotal, requiredHit, evidence: EvidenceInput[], notes}; patternTitle(grade, withStepB); gradePlanPick(plans, pickedIndex, {at, taskId?, priorFlawedTasks?, flawedPicksThisTask?}): PlanGrade {workable, evidence, whyFlawed?, workablePlan?, guideApproach, flawedTasks}; routeGaps({learner, taskConceptIds, patterns?, patternGrade?, plans?, planGrade?, now}): {atoms: RoutedGap[], jit: RoutedGap[]}; atomCostSec(learner, id, now); GATE
## deviations
Interpretations where the spec was silent or conflicting (all documented in code comments):
1. Flagged guesses: "PROBE2 ... otherwise as in PROBE" conflicts with "honesty adds no steps now". A flagged-correct PROBE2 exits 'partial' (not another PROBE2). A flagged-correct RE-PROBE/SECOND SIBLING exits 'confirmed': the evidence model does not suppress on a guess, so 'fixed' would be false.
2. Copied-literal implicit guess (5+ chars): not applied when the wrong answer strictly matches a mutant. The alias belief, for example, predicts the list exactly as written in the code, so the rule would otherwise halve every belief-backed answer.
3. ROUTE-time BELIEF-CHECK (a stored candidate with nothing answered yet) shows the question alone. 'y' records predict-kind wrong evidence at weight .5 with beliefConfirmed and odds x6. 'n' records nothing and goes to PROBE; it is not a slip. "Already confirmed" means listed in the confirmedMisconceptions input, or status active/suppressed (MisconceptionState has no confirmed flag).
4. When REFUTE has no matched probe, it picks one probe carrying M only for display in the REVEAL. That probe is not graded.
5. Completions: the retry failure is recorded at weight .5 (same item). learnT .3 applies when the pass follows a worked example or a landed escalation lesson.
6. Caps: ESCALATE is exempt from the 7-item cap (it has its own 150 s). Timer ticks wait while a completion grade is in flight, so that answer is still recorded. The cap exit path is 'confirmed' inside REFUTE after a 'y', otherwise 'partial'. No probe in stock goes to UNKNOWN; no PROBE2 item exits 'partial'; no re-probe item exits 'confirmed'.
7. Review effects: 'partial' after 10 min. For 'escalated' ("same-day review") I chose 60 min.
8. Key legend: shown as its own comment line under the header, not appended to line 1, so codeStart/lineOffset move while it shows. Multi-line '# ->' answers count as using the '|' key. Traceback header text '# which line failed, and with what error?' is my wording; the spec gives none.
9. gradeTraceback: correct = line and name right, plus the meaning pick when it is supplied. Answering the outermost frame names 'first-frame-is-failure' (Python) / 'last-frame-is-failure' (JS). The exception table adds UnboundLocalError to the spec list. TracebackItem.line stays a code line; render shifts the trace to pad lines and grading takes lineOffset.
10. mutants: applyOperator needs lang as a third parameter to mask strings and comments. Additions: JS .slice()/.slice(0) count as copies; .copy() is Python-only; list(x) only for a plain name. 'Loop limit' means Python range() bounds and JS for(;;) conditions; while loops are covered by the comparison operators. Operator to misconception: off-by-one->le-visits-each-once, for-range-bounds->range-includes-end, return->print-is-return, and/or->and-or-return-bool, copy->assignment-copies, +=->assign-instead-of-add, await->async-returns-value, ==/is->is-means-equal. Alternatives exist only for bound+1/-1 and and/or.
11. Gate: a workable plan pick is correct evidence on 'decomposition' (the spec names no concept). A flawed pick that makes 3 tasks with flawed picks also records wrong evidence on decomposition. guideApproach fires on the 2nd flawed pick in one task. Routing order is misconception candidates, then the flawed plan's concept, then missed patterns (lowest P first). Atom cost estimates come from the route: 25/55/95 s. Solid and Fluent concepts are skipped.
12. Placement: while the plan is pending, every candidate with items counts as needed, and needed concepts with no items never hold placement open. The predict phase ends at 12 items, 3 minutes, all classified, or nothing left, so the last 2 items can be completions. The fast lane serves a leaf completion after 2 quick correct leaf predicts; otherwise it could only fire at the very end. 'Leaf' means no descendants, or ticked with no ticked descendant. The extras after the stop apply to every stop reason except Esc and no-items.
13. Sprint: each misconception is delayed-checked at most once per sprint, and tiers 2-5 skip concepts already picked in the sprint, so selection does not depend on evidence landing between picks. Traceback items appear only in every 5th slot. Which-pattern distractors are topped up from taxonomy pattern names when the deck is small. Not covered here: 'no auto-open while building' and the '15% cap' (coach/tempo concerns).
14. recentCorrectGroups(c, now) is an approximation (groupsCorrect if practised within 7 days), because ConceptState keeps no per-group times. Pass exact groups from the evidence log when you can.
15. I use a local structural LessonText type, compatible with src/schemas.ts EscalationLesson. render's after-text keeps inner double spaces, which the trace format needs; annotationModel.toAfterText would collapse them.
16. The step-machine scenarios the spec lists for test/pad.test.ts are in test/stepMachine.test.ts against the pure reducer, as assigned. src/contracts.ts was not modified.
## notesForIntegrator
PAD (src/atoms/pad.ts) wiring:
- Start with startAtom({conceptId, conceptKey, tag, lang, pattern: storedAtom.pattern, concept: learner concept, at, speed: {cps: learner.cps, speedFactor: learner.speedFactor}, recentCorrectGroups (from the evidence log if possible), placementDontKnow?, confirmedMisconceptions?}).
- Then feed every event through stepAtom(state, ev) and interpret the effects IN ORDER:
  - 'pick': query AtomCache.unseenProbes etc. using request.excludeGroups, excludeIds, misconceptionId (+requireMisconception) and blanks. chooseItem(atom, request, {now, allowedConstructs}) is a reference picker. Mark the fallback probe {confounded: true} (it is recorded at weight .5). Dispatch {type:'item', at, item} (item undefined = nothing in stock).
  - 'render': r = renderView(view, {lang, keyUse: learner.keyUse}). If r.snippet: empty the doc, then insertSnippet built from the parts (appendText / appendPlaceholder(value, n)). Otherwise replace the full text. Set padAwait = r.await, put the cursor at answerLine/answerColumn (select to answerSelectEnd if set), and apply r.decorations by kind.
  - 'feedback': feedbackDecoration(fb, line). Use line = target.line, or for 'answer' the last '# -> ' line in the current doc.
  - 'evidence': recordEvidence(learner, e).
  - 'seen' / 'item-stat' / 'mutant': AtomCache.markSeen / recordItemStat / recordMutantResponse.
  - 'run-completion': gradeCompletion(text, completion, runner, lang, {allowImports: tagInfo(tag)?.allowedImports}), then dispatch {type:'completion-graded', at, grade}.
  - 'request-lesson': enqueue the EscalationLesson job under key (low effort, priority 0). If project.prefetch already has it, dispatch {type:'lesson', lesson} at once. Dispatch lesson: undefined if the job fails.
  - 'review': schedule a review in inMs.
  - 'exit': set result.stateAfter = conceptChip(learner, c), optionally overwrite misconceptionStatus from the learner, then do the EXIT steps.
- Events:
  - 'submit' {text: the WHOLE pad document, guess, latencyMs, latencyValid, assisted} for Ctrl+Enter / Ctrl+Shift+Enter. Ctrl+Enter on reading steps also works as continue.
  - 'yn' for y/n; 'pick' {choice: 1|2} for the contrast pick.
  - 'esc' for EVERY Esc press with its timestamp (the reducer detects two within 600 ms).
  - 'abort' for Leave practice / tab closed.
  - 'tick' at atomDeadline(state) (recompute after each step).
- After each submit, increment learner.keyUse[k] for each k in keysUsed(answerText(doc, commentToken(lang)), guess).

PLACEMENT:
- s = newPlacement(now). Loop: it = nextItem(s, {candidates, now, lang, constructConcept?}, learner, {needed: task 1-3 concept ids or [] while pending}, {planPending}).
- 'typing': recordTypingCalibration, then s = record(s, {kind:'typing', at}).
- 'predict': gradePredict, then recordEvidence with source 'placement'. On a mutant match, pass misconceptionId with misconceptionOdds 3 for curated / 2 for model mutants; no belief check. Then s = record(s, {conceptId, itemId, kind, group, correct, guess, latencyMs, latencyValid, parSelfMs, at, misconceptionId?, extra: it.extra}).
- When it is undefined: shouldStop(...).reason, then summary(s, learner, {now, names, needed}).

SPRINT:
- st = newSprint(now); p = nextSprintItem(st, {now, lang, learner, stock (by concept id or key), guessFlagged, rng}).
- Record evidence with source 'audit' when p.audit, otherwise 'sprint', with delayedCheckFor when set. Which-pattern goes to a QuickPick (p.options, p.correct 0-based, mark card.useCaseSeenAt[useCase]).
- Then st = recordSprintPick(st, p, at). Check sprintShouldStop(st, {now, budgetMs, maxItems, esc, untilSettledAt, itemOpen}) between items, and on a timer while an item is open.
- An empty pick means stop. Refill stock from seeds when it runs dry.

TRACEBACK items (pad/sprint):
- r = renderTraceback(item, ctx). Grade with gradeTraceback(answer, item, {lineOffset: r.lineOffset}), then renderTracebackMeaning(item, answer, ctx). The final grade is gradeTraceback(answer, item, {lineOffset, pick}).
- Evidence: kind 'traceback' on 'reading-tracebacks', with misconceptionId when it is named.
- To use these tables in seeds: new Instantiator(runner, seed, {buildTraceback: buildTracebackParts}). raisingCandidates(probes, lang) plus one runBatch plus buildTracebackItem builds items from raising mutants.

GATE (src/gate.ts):
- At task start: fade = isSoloTask(...) ? 'solo' : taskFade(learner). Then gateDecision(task, earlierTasks, learner).
- gateSteps(fade, shuffled(plans)) decides step B.
- Step A: gradePatternPick(patterns, selectedLabels, at, taskId). Record its evidence, and use patternTitle(g, stepB) as step B's title (or the flash).
- Step B: gradePlanPick(plans, idx, {at, taskId, priorFlawedTasks, flawedPicksThisTask}). Persist flawedTasks.
- Then routeGaps({...}): open .atoms in order, turn .jit into JIT offers.

WHAT-IFS (src/owncode.ts):
- whatIfCandidates(lines the probe call exercises, lang, {weakestTag, journal: learner.mistakes}). Each candidate gives the mutated line plus the start/end span for the line-through decoration.
- alternativeLine(...) produces the alternative operator's output.
- attributeWhatIf(answer, {actual, unmutated, alternative}, lang, op) returns weight, misconceptionId and odds 3 for kind 'what-if' evidence. evidence=false means record nothing.

Gotchas:
- PadRender lines are 0-based. Item-relative lines (subgoals, trace, diffLine, TracebackItem.line) are 1-based code lines; codeStart/lineOffset map them.
- Completion text is re-indented to 4 spaces. extractFills tolerates that and the header and lesson comment lines.
- Contrast evidence carries no siblingGroup, so it never counts as a surface for mastery.


# harness  tests=True count=55
## exports
- specsCore.ts: buildHarnessInput(specs: SpecItem[], o?: { workspace?: string; timeoutMs?: number; functions?: string[] }): HarnessInput
- specsCore.ts: specTimeoutMs(importMs: number | undefined): number  // 5000, or 5000 + importMs once importMs > 1000
- specsCore.ts: parseHarnessOutput(stdout: string, stderr: string, timedOut: boolean, opts?: { ids?: string[] }): HarnessRun  // HarnessRun extends HarnessReport { results: HarnessSpecResult[]; loadError?: HarnessLoadError; finished: boolean }
- specsCore.ts: parseProbeOutput(stdout: string, stderr: string, timedOut: boolean): ProbeOutcome  // { ok, type?, repr?, val?: Val, exception?, error?, line?, stdout?, ms?, importMs?, loadError?, timedOut }
- specsCore.ts: stderrTail(stderr: string, max?: number): string
- specsCore.ts: targetSpec(order: string[], results: Record<string, SpecResult | undefined> | SpecResult[]): TargetReport  // { target?, display: Record<id, 'passed'|'failed'|'not-yet'|'not-run'>, passed, total }
- specsCore.ts: visibleTitles(fade: FadeLevel, state: Pick<TaskSpecState, 'specs'|'greenAt'|'last'>): VisibleLadder  // { titles, summary 'n of m behaviours pass', passed, total, next?, target?: { id, call, actual, text } }
- specsCore.ts: actualLine(call: string, result: SpecResult | string): string
- specsCore.ts: specEvidenceWeight(savesSinceRed: number | undefined, assisted: boolean): number  // 1 or 0.3
- specsCore.ts: hiddenFailureCard(spec: SpecItem, actual: SpecResult | string): string
- specsCore.ts: signatureMatch(result: SpecResult, spec: SpecItem, lang?: Lang): FailureSignature | undefined
- specsCore.ts: arityOf(signature: string): number; countParams(params: string): number
- specsCore.ts: mapInterface(iface: TaskInterface, learnerFunctions: { name: string; arity: number }[]): InterfaceMapping  // { ok, mappedNames, reason? = DESIGN_DIFFERS }
- specsCore.ts: rewriteSpecCalls(specs: SpecItem[], mappedNames: Record<string, string>): SpecItem[]
- specsCore.ts: normalizeExpected(text: string, lang: Lang): string | undefined
- specsCore.ts: validateSpecs(items: SpecItem[], iface: TaskInterface, lang: Lang, seenIds?: Set<string>): { kept: SpecItem[]; dropped: DroppedSpec[] }
- specsCore.ts: findTopLevelFunctions(source: string, lang: Lang): FunctionRange[]  // { name, startLine, endLine (0-based inclusive), arity? }
- specsCore.ts: moduleKindFor(file: string, packageType: string | undefined, learnerSource: string | undefined): 'esm' | 'cjs'
- specsCore.ts: buildVerificationPlan(ladder: SpecLadderDraft, iface: TaskInterface, o: { lang; learnerSource?; functionRanges?; moduleKind?; timeoutMs?; workspace? }): VerificationPlan
- specsCore.ts: verifySpecLadder(ladder: SpecLadderDraft, iface: TaskInterface, deps: VerifyDeps): Promise<VerifyResult>  // deps { runner, workspaceDir, harnessDir, tmpRoot, fs?, learnerSource?, functionRanges?, timeoutMs?, signal?, repair?, log? }
- specsCore.ts: nodeVerifyFs: VerifyFs; constants TIMEOUT_TEXT, DESIGN_DIFFERS, SPEC_TIMEOUT_MS, SLOW_IMPORT_MS, MIN_SPECS; types HarnessInput, HarnessSpecInput, HarnessRun, HarnessSpecResult, HarnessLoadError, ProbeOutcome, SpecDisplay, TargetReport, LadderLine, VisibleLadder, LearnerFunction, InterfaceMapping, DroppedSpec, FunctionRange, ModuleKind, SpecLadderDraft, VerificationPlan, VerifyFs, VerifyFailure, VerifyDeps, VerifyResult
- media/harness/harness.py: CLI `harness.py <module file> <spec json>`; library: Session(module_path, workspace=None, timeout_ms=None, source=None) with .load() -> (importMs, loadError|None), .function(name), .run_guarded(thunk); parse_call(text) -> (callee, args, kwargs); same(actual, expected); exc_matches(e, name)
- media/harness/probe.py: CLI `probe.py <module file> <call> [--stdin] [--workspace DIR] [--timeout-ms N]` -> one `@@DLB {json}` line
- media/harness/harness.mjs: CLI `harness.mjs <module file> <spec json>`; exports Session, runSpec, checkTopLevel(src) -> {line,text,why}|undefined, checkModuleTree(file, workspace, source?), parseCall(text) -> {callee, args}, tokenize, moduleSpecifiers, topLevelNames, definesName, looksCommonJs, moduleKind, exported, same, errorNames, describeError, errorLine, emit, UNSAFE_NUDGE, SANDBOX_MESSAGE, TIMEOUT_TEXT
- media/harness/probe.mjs: CLI `probe.mjs <module file> <call> [--stdin] [--workspace DIR] [--timeout-ms N]` -> one `@@DLB {json}` line
- media/harness/loader.mjs: resolve (async, for module.register), resolveSync (for module.registerHooks), tsAlternative(specifier, parentURL)
## deviations
All spec rules are implemented as written except for these additions and judgement calls:

1. Harness protocol. Besides '@@DLB_START <id>' and '@@DLB {json}', the harness also prints three lines: '@@DLB_PLAN [ids]' before the import, '@@DLB_LOAD {importMs, loadError?}' after it, and '@@DLB_END {timedOut?}' at the end. Without them parseHarnessOutput could not tell which specs never started, could not tell a top-level hang from a spec hang, and could not detect a crash. Records carry extra fields: exception, line, sig (index of the matched failureSignature), stdout (what the call printed, <= 300 chars) and val (typed Val when small). HarnessSpecResult extends SpecResult with these; HarnessLoadError adds line/file/why. contracts.ts is untouched.

2. Optional extra parameters. parseHarnessOutput takes an optional 4th argument {ids}, used when the harness died before PLAN. signatureMatch takes an optional lang. It prefers the harness's own match (same equality as the spec) and falls back to the exception name or a typed/printed value comparison.

3. Equality.
   - Python uses == except that bool never equals int, NaN equals NaN, and Counter or defaultdict equal a plain dict. 2 == 2.0 passes.
   - JS uses util.isDeepStrictEqual against JSON.parse(expected), except that 0 and -0 are equal at the top level.

4. JS top-level check, beyond the spec's list:
   - require('literal') counts as an import, and Symbol.for() is allowed.
   - Main guards are recognised: require.main === module, import.meta.main, and process.argv[1] compared with import.meta.url or __filename. The guarded branch is not checked; the else branch is.
   - An `if` whose test makes no calls and whose body is only allowed statements passes (UMD-style module.exports guards).
   - Every workspace module the file imports with a relative path is checked too (up to 50 files), because its top level also runs on import. The loadError gets `file` and `why`, e.g. 'createServer() runs on import'.
   - TS is checked after module.stripTypeScriptTypes when available, otherwise with a TS-tolerant tokenizer.

5. A 'not-exported' loadError does not stop the run; the other specs still run, and every other loadError kind ends it. CommonJS files get 'X is defined but not exported: add it to module.exports'.

6. TS resolve hook. module.register needs --allow-worker under --permission (I tested this on Node 24.11.1). So harness.mjs uses module.registerHooks (in-thread, Node 22.15+/23.5+) and falls back to module.register on older Node. loader.mjs exports both resolve and resolveSync.

7. Python entry points.
   - DeliberateTopLevel derives from BaseException, so `except Exception` cannot swallow it.
   - If the module swallows it with a bare except, it is still reported as top-level.
   - input() or sys.argv[1:] inside a spec call raises it with a spec-specific message.
   - sys.argv has len() 1 and allows argv[0] and argv[:1].
   - A top-level SystemExit (usage exits, argparse) is also reported as 'top-level'.
   - A top-level hang inside site-packages is reported as kind 'import' (slow library) rather than as learner code.

8. Timeouts. The harness stops itself 400 ms before timeoutMs:
   - Python uses a watchdog thread. It calls signal.raise_signal on Windows, which also interrupts time.sleep, and pthread_kill elsewhere (os.kill is blocked by the audit hook).
   - Node uses a vm.Script runInThisContext timeout; a returned promise gets min(2 s, remaining time).
   - Code that swallows the interrupt is left to the parent kill, which parseHarnessOutput handles.

9. probe.mjs always imports a temp copy in the cwd (the spec says 'temp copy'). Relative specifiers are rewritten to absolute paths or URLs. A top-level function that is not exported gets exported from the copy so the learner's helpers can be probed. Downside: a function that reads files relative to __dirname or import.meta.url sees the temp dir.

10. verifySpecLadder.
   - If the merged reference variant (learner file with reference functions) fails to load, for example because the learner's file has a top-level input(), it is retried with the reference alone. The stub is retried with stubs alone in the same way.
   - Specs are judged one result at a time, so specs that failed cleanly before a stub crash still count.
   - JS/TS exports: inserted chunks lose `export`, then one `export { name };` or `module.exports.name = name;` is appended for each interface function not already exported.
   - Reference import/const bindings the learner already declares are skipped, since a duplicate is a SyntaxError.
   - The reference's own main blocks, export lists and (JS) bare top-level statements are not copied.

11. Validation. A JS expected value that is not JSON but is a literal JSON can express is normalised ({a: 1} becomes {"a":1}); undefined, NaN or bigint expected values are dropped. Spec ids are trimmed, whitespace becomes '-', and duplicates are dropped. Invalid failureSignatures are removed without dropping their spec.

12. Copy globs. Python: .py. JS/TS: .js .mjs .cjs .ts .mts .cts .json (package.json decides the module type). The interface file is copied first. The real node_modules path is added to readDirs, because Node resolves packages through the junction to their real path under --permission. The link is unlinked before the temp dir is removed (I confirmed fs.rm does not follow junctions).

13. mapInterface returns ok with no mapping when the learner has written no functions yet, so a fresh task never shows 'design differs'.
## notesForIntegrator
Wiring for stage 2 (src/specs.ts, src/owncode.ts):

SPEC RUNS
- Rewrite calls to the learner's names at run time: specs = rewriteSpecCalls(task.spec.specs, task.interface.mappedNames ?? {}). The stored specs keep interface names.
- Write the spec file to globalStorage/specs/<taskId>.json: JSON.stringify(buildHarnessInput(specs, { workspace: wsRoot, timeoutMs: t, functions: <learner names of the interface functions> })), with t = specTimeoutMs(task.spec.importMs).
- Run it:
  r = runner.runLearnerCode(path.join(harnessDir, lang === 'python' ? 'harness.py' : 'harness.mjs'), [absInterfaceFile, specJsonPath], { workspaceDir: wsRoot, readDirs: [path.dirname(specJsonPath)], timeoutMs: t })
  - Pass the same t in the JSON and as timeoutMs. The harness stops itself 400 ms early, so the process kill is only a backstop.
  - For Node, readDirs must include the spec JSON's folder. harness.mjs imports ../runner/prelude.mjs, which is readable because LocalRunner always allows its runnerDir. For Python, LocalRunner already wraps the script in prelude.py; the harness reuses that sandbox.
- Then: rep = parseHarnessOutput(r.stdout, r.stderr, r.timedOut, { ids: specs.map(s => s.id) }). Store rep.importMs into task.spec.importMs on the first run; > 1000 means show 'running specs...' and extend the timeout.
- rep.loadError?.message is already the learner-facing nudge:
  - Python top-level input()/argv/SystemExit/timeout: "top-level code runs on import: move it under if __name__ == '__main__'"
  - JS unsafe top level: the require.main / import.meta.main nudge
  - 'parse_args is defined but not exported: add export'
  - 'sandbox': the keep-it-in-the-main-block sentence
  - .line is the 1-based learner line; .file is set when an imported module is the unsafe one; .name/.why carry details.
- 'crash' means errored with the stderr tail, and the running spec's error holds that tail. 'not-exported' does not stop the run; other specs still have results.

REPORTING
- targetSpec(order, task.spec.last) gives the target and per-id display ('failed' only for the target, 'not-yet' for later reds, which get no message or location).
- visibleTitles(task.fade, task.spec) gives titles, summary ('n of m behaviours pass'), next (for '3/5 · next: <title>') and, for minimal/solo, target.text (call plus actual, never the expected value).
- signatureMatch(targetResult, spec, lang): call it on the target only, not in solo.
- specEvidenceWeight(task.spec.savesSinceRed[id], assisted) on the first green.
- hiddenFailureCard(hiddenSpec, result) for a hidden failure.
- HarnessSpecResult.stdout shows what the call printed, useful when actual is None.

INTERFACE MAPPING
- learnerFunctions come from DocumentSymbol (name plus parameter count) or from findTopLevelFunctions(text, lang), the regex fallback. It returns 0-based inclusive line ranges and arity.
- mapInterface(iface, learnerFunctions): !ok means applicable = false with the card text in reason (DESIGN_DIFFERS). mappedNames goes into Task.interface.mappedNames.

VERIFICATION (prefetch)
- verifySpecLadder(draft, iface, { runner, workspaceDir, harnessDir, tmpRoot: <globalStorage>/verify, learnerSource: <editor text or undefined>, functionRanges: <DocumentSymbol ranges, 0-based startLine/endLine>, repair: async (failures) => <one low-effort SpecLadderPart call quoting {id, reason, actual}> })
- It returns { specs, hidden, applicable, verified, reason, dropped, importMs, repaired }. Store specs, hidden, verified, applicable and reason in Task.spec.
- The draft's reference must not be kept anywhere after this call; the result never contains it.
- runtime.lang decides harness.py vs harness.mjs; for TS use the typescript runtime, whose learnerArgv carries the strip flag or the tsx --import.

PROBES (V1-12)
- runner.runLearnerCode(path.join(harnessDir, 'probe.py' or 'probe.mjs'), [absFile, callExpr, '--stdin', '--workspace', wsRoot, '--timeout-ms', '3000'], { workspaceDir: wsRoot, timeoutMs: 3500, stdin: currentEditorText })
- Then parseProbeOutput(stdout, stderr, timedOut). For what-ifs, pass the mutated text as stdin.
- On ok, {type, repr, val} has the same shape as a batch PrintedArg: grade with compareOutput(answer, { stdout: repr, values: [[{ type, repr, val }]] }, lang). Raising calls give exception (the class name). A loadError means the module is skipped.
- probe.mjs can call unexported top-level helpers; probe.py can call any module-level function.

GOTCHAS
- Python 3.8+ is required (audit hook, raise_signal).
- Node network is not blocked (as the spec says).
- On Node 22.6–22.14 with --permission, module.registerHooks is missing and module.register would need --allow-worker. There, TS imports of './x.js' that mean x.ts fail with an 'import' loadError. Consider applicable=false for TS ladders on those versions rather than adding --allow-worker.
- A JS reference written as an ESM file into a .js in a package without "type" relies on Node 22.7+ ESM syntax detection.
- The integration tests spawn python/node directly with the learner-profile flags, not LocalRunner, so they do not depend on runner.ts changes.


# seedsPython  tests=True count=6
## exports
- media/seed/python.json: SeedBank { lang: 'python', patterns: Record<tag, AtomPattern> (23 cards: the 22 Python PLACEMENT_FUNDAMENTALS plus reading-tracebacks), templates: SeedTemplate[] (148: 69 probes, 22 examples, 23 completions, 27 contrasts, 7 tracebacks) }
- media/seed/neutral.json: { lang: 'neutral', note: string, patterns (3 cards), templates: (SeedTemplate & { verified: false; answer: string; transforms: (SeedTransform & { prints: string })[] })[] } with 3 fixed pseudocode probes (variables-assignment, while-loop-termination, loop-accumulator) and no slots or themes
- test/seed-bank.test.ts: 6 node:test tests (5 static content checks plus 1 runtime sample that is skipped when no Python is found)
## deviations
1. Extra file: test/seed-bank.test.ts is new and was not in my assigned list. The rules require tests, so I gave it a distinct name to avoid colliding with anyone. It checks: the bank parses with no problems; every fundamental has a pattern card, 2+ probe families, 4+ sibling groups, an example, a completion with a wrong fill, and a contrast for semantics tags; every Python misconception of each fundamental is carried in 2+ sibling groups; word limits hold; refutation numbers appear in the code; the neutral bank is well-formed. With Python available it also instantiates 2 of each template and checks that typing a mutant's exact output names that mutant (not a slip, not ambiguous), that type-sensitive tags show types, and that tracebacks cover all 7 exceptions.

2. Broken test I don't own: test/seeds.test.ts 'the bundled python sample is a valid seed file' now fails on one assertion only. It expects the template kinds to be exactly ['completion','contrast','probe'], which was true of the 3-template sample. Suggested replacement: assert.deepEqual([...new Set(bank.templates.map((t) => t.kind))].sort(), ['completion','contrast','example','probe','traceback']). Its other assertions still pass: the first probe, py-var-before-after, has 2 transforms, prepareTemplate gives [0,1] for Python and ok for JS, and card names are canonical.

3. Design constraint not stated in the spec: compareOutput treats any answer within edit distance 1 of the real output (also compared with whitespace removed) as a slip and never matches it to a mutant. My first draft had about 20 probes whose beliefs could therefore never be named (for example '5.875 5' vs '5.875 6'). I chose values so every mutant is at least 2 edits away:
   - numbers ending in 9 (10j+9) or changing by 11k, so the shifted value differs in two characters
   - multiples of 100 for values inserted into small-digit lists
   - range stops at 10/20/30
   - a list of 6-letter words with no repeated adjacent letters, so an off-by-one index changes every character
   - per-pass prints for accumulator and counter probes
   - a three-value round() probe
   Checked across 5 seeds × 60 instances per template: no non-attributable mutant left.

4. strip-removes-inside uses strip('-') with dashes, not spaces. A spaces-only difference vanishes under the whitespace-insensitive slip check, so that mutant could never be attributed.

5. Beyond the brief: there are 27 contrasts covering every fundamental, not just the 3 semantics tags (REFUTE uses a contrast for every misconception). loop-accumulator has 2 completions. The sample's ids py-slice-window, py-accumulate-filtered and py-alias-append (the contrast) are kept.

6. neutral.json adds fields outside contracts.SeedTemplate: a top-level note, plus per template 'verified': false, 'answer', and transforms[].prints. parseSeedBank tolerates them; contracts.ts is unchanged.

7. Some loop probes print with end=' ', which adds the 'keyword-arg' construct.

8. Some mutants are not idiomatic code because only one line may change: 'pass' for the reset-inside-loop and counts-dict-inside-loop mutants, 'if True:' replacing a loop else, and a literal assignment in the swap mutant. They are used only for their output and diff line.

9. I generated the JSON from a builder script in my scratchpad, which is not shipped. Treat media/seed/python.json as the source and edit it directly; it is formatted for hand editing.
## notesForIntegrator
LOADING: parseSeedBank(JSON.parse(python.json), 'python') returns no problems. Pattern names match tags.ts patternName. Template ids all start with 'py-' and contain no '#' or '~'. Traceback templates have tag 'reading-tracebacks', and the Instantiator sets conceptId to that tag. No template imports anything, so allowImports never matters. Every traceback raises through a helper function, so the failing line is the last frame.

VALIDITY: npx tsx scripts/verify-seeds.ts python passes on Python 3.14.0, found through PATH or DELIBERATE_PYTHON: 148/148 templates ok, every draw valid, 2922 valid items in about 12 s, no dropped wrong fills, every transform changes the output.

Per tag (probe templates/families | sibling groups | transforms | misconceptions covered | examples | completions | contrasts | valid draws):
- variables-assignment 3/3 | 8 | 4 | 3/3 | 1 | 1 | 1 | 120/120
- numbers-int-float 4/4 | 10 | 5 | 4/4 | 1 | 1 | 1 | 140/140
- integer-division-modulo 3/3 | 7 | 6 | 4/4 | 1 | 1 | 1 | 120/120
- str-vs-number 3/3 | 7 | 4 | 4/4 | 1 | 1 | 1 | 120/120
- string-indexing 4/4 | 8 | 5 | 4/4 | 1 | 1 | 1 | 140/140
- string-methods 3/3 | 6 | 5 | 3/3 | 1 | 1 | 1 | 120/120
- comparison-equality 3/3 | 6 | 3 | 3/3 | 1 | 1 | 1 | 120/120
- conditionals 3/3 | 7 | 3 | 3/3 | 1 | 1 | 1 | 120/120
- booleans-truthiness 3/3 | 6 | 6 | 3/3 | 1 | 1 | 1 | 120/120
- for-range-bounds 3/3 | 7 | 6 | 4/4 | 1 | 1 | 1 | 102/102
- loop-accumulator 3/3 | 6 | 3 | 3/3 | 1 | 2 | 1 | 140/140
- while-loop-termination 3/3 | 7 | 4 | 4/4 | 1 | 1 | 1 | 108/108
- break-continue 3/3 | 6 | 5 | 4/4 | 1 | 1 | 1 | 120/120
- list-indexing 4/4 | 9 | 6 | 3/3 | 1 | 1 | 1 | 140/140
- list-slicing 4/4 | 9 | 8 | 4/4 | 1 | 1 | 1 | 140/140
- list-mutation-methods 3/3 | 6 | 4 | 4/4 | 1 | 1 | 1 | 120/120
- alias-copy 4/4 | 9 | 4 | 4/4 | 1 | 1 | 1 | 140/140
- string-split-join 4/4 | 8 | 5 | 4/4 | 1 | 1 | 1 | 140/140
- dict-access-missing-key 3/3 | 7 | 3 | 3/3 | 1 | 1 | 1 | 120/120
- counting-with-dict 3/3 | 6 | 3 | 3/3 | 1 | 1 | 1 | 112/112
- function-def-call 3/3 | 7 | 3 | 3/3 | 1 | 1 | 1 | 120/120
- function-return-vs-print 5/5 | 10 | 5 | 4/4 | 1 | 1 | 1 | 160/160
- reading-tracebacks: 7 templates (IndexError, KeyError, TypeError, NameError, AttributeError, ValueError, ZeroDivisionError), 140/140

REFILL: a few templates have fewer than 20 distinct instances: py-range-example 6, py-count-example 12, py-range-sum-to 16, py-while-years 16, py-ret-greeting 48. The refill logic must tolerate report.exhausted.

PROBE PROPERTIES:
- Every probe is 8 lines or fewer and prints 1-4 lines of 200 characters or fewer.
- Each has 1-2 transforms.
- Mutant outputs differ from the original and from each other, at edit distance 2 or more, so compareOutput can attribute each one.
- Type-sensitive tags (numbers-int-float, integer-division-modulo, str-vs-number) print repr(), type().__name__, lists or bools, and pass verify.ts's typeVisible rule.
- Raising probes (answer = exception name) print nothing before they raise.
- stateTrace tags get traces automatically.
- Mutant diff lines usually point at the line the belief is about; some point at the print line, so refutations are worded to read well there.

NEUTRAL: neutral.json can't go through the Instantiator because there is no runtime. Build StoredProbe pieces directly:
- output = { stdout: answer + '\n', values: [] }
- each mutant: output from transforms[i].prints, code = applyTransform(code, find, replace), diffLine = singleDiffLine(code, mutantCode), source 'curated'
- atom stored with verified = false, and mutant matching disabled, per the spec
The top-level note documents the pseudocode conventions (SET/PRINT/WHILE/FOR EACH/IF THEN).

TESTS: npx tsx --tsconfig test/tsconfig.json --test test/seed-bank.test.ts gives 6/6 passing in about 2 s with Python. The runtime test calls t.skip('no python found') when there is none, and honours DELIBERATE_PYTHON. The test only imports seeds.ts, tags.ts, compare.ts and runner.ts (not verify.ts), with a local copy of the typeVisible rule. npx tsc --noEmit shows no errors in my files.


# seedsJs  tests=True count=271
## exports
- media/seed/javascript.json: SeedBank { lang: 'javascript', patterns: 25 cards (22 placement fundamentals + this-method-call, closure-late-binding, reading-tracebacks), templates: 134 (72 probe, 24 example, 24 completion, 6 contrast, 4 traceback) } — ids prefixed 'js-'
- media/seed/typescript.json: SeedBank { lang: 'typescript', patterns: 26 cards (23 placement fundamentals incl. type-annotations + this-method-call, closure-late-binding, reading-tracebacks), templates: 137 (73 probe, 25 example, 25 completion, 6 contrast, 4 traceback) } — ids prefixed 'ts-', erasable TS syntax only (annotations, interface, as, unknown/any)
## deviations
1) No node:test file: only the two JSON files were assigned to me. Validation is the real runner (verify-seeds.ts, 20 instances per template, both languages exit 0, 100% valid on every template, every transform changes the output), plus scratchpad scripts that printed one live instance per template for manual semantic review and linted every filled refutation with src/atoms/verify.ts refutationLeak (no digits or quoted text outside the code), plus the runner allowlist and erasable-TS checks. testCount = 271 templates verified, not test cases. 2) Added this-method-call and closure-late-binding, which are not in PLACEMENT_FUNDAMENTALS, because the brief asked for them. 3) JS-only families: js-cmp-chained and js-scope-var-vs-let, because tsc rejects that code; TS still covers both misconceptions (chained-compare-math via the completion's wrongFill, var-block-scoped via scope-var-loop). TS-only: 5 type-annotations templates. 56 TS templates share the JS body unchanged (allowed by the brief); 76 carry annotations. 4) Belief text is the taxonomy text verbatim, except print-sees-later-assignment, reworded for JS as 'console.log shows a value assigned on a later line'. 5) 'Belief predicts an error' misconceptions (slice-past-end-errors, const-freezes-contents, types-checked-at-runtime) are modelled as mutants that raise (an explicit throw new RangeError/TypeError, or Object.freeze(...).push). 6) index-starts-at-one transforms are only used where the index is 1 or more (1-based reading of [k] = 0-based k-1). range-starts-at-one is modelled as `for (let i = 1; i <= n; ...)`. 7) In TS, string-item-assignable uses `let word: any` so the snippet type-checks, and the TDZ probe calls a function before the `let` line (the only TDZ form tsc accepts).
## notesForIntegrator
- Load the files with parseSeedBank(json, lang); every template tag has a pattern card, and parseSeedBank reports no problems. Sibling group = family:theme: 9-15 groups per fundamental tag (6 for TS comparison-equality, 2 families x 3 themes).
- Every taxonomy misconception for each tag and language has at least one probe mutant or completion wrongFill, so mastery coverage is satisfiable from seeds.
- Contrasts exist for all six semantics tags present: str-vs-number, loose-vs-strict-equality, null-undefined, booleans-truthiness, alias-copy, closure-late-binding.
- Traceback templates (tag reading-tracebacks): TypeError x2 (property of undefined, not a function), ReferenceError (typo), RangeError (negative repeat count), each raised through a helper. The default buildTraceback yields 'at fn (pad:L:C)' frames, and the failing line is the helper line.
- Intentionally raising items (answer = exception name): originals of scope-tdz (ReferenceError) and obj-undefined-chain (prints a line, then TypeError); several mutants also raise.
- Some recorded outputs depend on batch.mjs running snippets as sloppy-mode scripts: a detached method printing 'Hello undefined', a regular-function callback giving NaN, s[0]='J' silently ignored, and a completion's empty blank becoming an implicit global. Outputs are recorded at runtime, so they stay correct if the runner changes, but the strict-mode behaviour would differ (TypeErrors).
- Type-sensitive tags print JSON.stringify/typeof.
- Small instance spaces (verify notes 'only N distinct instances'): for-example 6, late-contrast 6, and some contrasts/examples 15-18. All probe families have about 75 or more.
- Verification time with 20 instances per template: about 17 s JS, about 20 s TS on Node 24.11.1 (native type stripping).
- The generator that produced these files lived in the scratchpad (not the project); the JSON files are now the source of truth and can be edited by hand. Re-run `npx tsx scripts/verify-seeds.ts javascript|typescript` after any edit.


# INTEGRATION tests=True count=539
## deviations
Final state:
- `npx tsc --noEmit` exits 0 for the whole project, and now includes `scripts/`: I added "scripts" to the tsconfig include.
- `npm test`: 539/539 pass, 0 skipped. The baseline was 521 with 1 failing.
- `verify-seeds` exits 0 for all three languages: Python 2922 valid items, JavaScript 2633, TypeScript 2692.
- `node esbuild.mjs` builds.
- A scratch esbuild bundle of all 30 stage-1 modules loads under node, and there are no value-import cycles.

coach.ts, view.ts and extension.ts needed no edits: they already compiled, and test/flow.test.ts passes.

Fixes:

1. test/seeds.test.ts asserted the old 3-template sample. It is now a set check on kinds, as the seedsPython engineer suggested.

2. Vocabulary mismatch between two modules. The step machine's 'mutant' effect emitted 'confirmed'/'rejected', but AtomCache.recordMutantResponse takes 'yes'/'no', so the 'y' answer would never have been counted. The effect is now typed as cache.MutantResponse and can be passed straight through.

3. Mismatch between compare.ts and the seed content. compareOutput never names a mutant whose output is within 1 edit of the real output (a probable slip). seeds.ts did not know this rule, and verify.ts had its own weaker copy of it.
   - Instances where this happens are now rejected and redrawn, with reason 'mutant-slip'. This uses a new compare.mutantAttributable, which verify.ts now uses too.
   - verify-seeds reports a transform that is a slip in most runs.
   - Measured on real runs before the fix: 8 JS and 8 TS templates could never name their belief (100% slips), and about 10 more per language failed 5-45% of the time.
   - I edited 19 templates in each of javascript.json and typescript.json:
     - si-char-at, si-negative, li-pick: shift two printed indexes at once.
     - si-assign: also prints s[0].
     - sm-trim: prints split(' ') and raw === clean.
     - fmt-tofixed: second decimal fixed at 9.
     - fn-args-position: division instead of subtraction, with new themes.
     - ret-silent: two-digit first result.
     - acc-reset, acc-sum: print on every pass, as the Python bank does.
     - num-trunc: values of the form 10k+9.
     - ls-copy, ac-nested, var-copy-reassign, var-swap, scope-block-let, obj-dot-bracket: values drawn from 100/200/... next to single digits.
     - var-derived: d drawn from 11/22/33.
     - ret-in-loop: safe values.
   - Every JS/TS template is now 100% valid, apart from 3 that redraw about 1 instance in 30. The Python bank was already clean.

4. traceback.ts took the snippet file from the FIRST `<module>` frame, so a trace that included runner frames lost all snippet frames. It now uses the last `<module>` frame.

5. chooseItem never applied the 7-day rule to examples, because examples have no stats and their show times live only in AtomCache's metadata. PickContext gained `seen` for this.

Duplicates consolidated onto one owner:
- RNG, hashing and Fisher-Yates (seeds, gateCore and sprintSelect had copies) now live in atoms/rng.ts.
- seeds.ts had its own default traceback builder and exception table. It now uses traceback.ts; the two tables had drifted, e.g. on the NameError meaning.
- verify.ts had byte-copies of seeds.ts helpers (scanCode, isParseError, ranOk, passes, recordOutput/toOutput, outputLines) and a second check() parser. It now imports them from seeds.ts.
- Smaller copies now reuse the owner's version:
  - cache.ts median and freshness check: from evidence.ts and seeds.ts.
  - learner.ts addUnique: from evidence.ts.
  - annotationModel.ts mdEscape: from tempo.ts.
  - test/seed-bank.test.ts's local typeVisible: from verify.ts.

Similar helpers deliberately left in place, because they do different jobs:
- verify.diffLine vs seeds.singleDiffLine: verify.diffLine tolerates trailing whitespace in model code.
- runner.stripPython/stripJs vs mutants.maskLine vs grade.codeLiterals.
- runner.parseException vs traceback.parseTrace: the first reads process stderr, including terminal escapes.
- specsCore.clip vs tempo.clip.
- render's afterText vs annotationModel.toAfterText: render keeps double spaces on purpose.
- The harness.py and harness.mjs call parsers run inside the target runtime. I checked 55 calls: they agree with calls.ts on all of them, except that calls.ts also rejects Python complex numbers, which is the safe direction.

Gaps between modules that I filled:
- tags.constructTag: no module mapped runner constructs to tags. allowedConstructs and placement's constructConcept need that mapping.
- prompts.allowedImportsFor and runner.PY_ALLOWED_IMPORTS: the base import allowlist was private.

Not fixed:
- The JS/TS null-undefined probes print bare NaN and numbers next to typeof. verify.typeVisible would reject those in a model pack, but wrapping them in JSON.stringify would turn NaN into null. I left them as they are.

contracts.ts and package.json are untouched.
## notes
New test: test/integration.test.ts (13 tests, about 6 s). It drives the real modules together through LocalRunner, with real Python 3.14 and Node 24, and doubles as a reference for stage-2 wiring. Its Pad class is a minimal model of src/atoms/pad.ts:
- 'pick': chooseItem(cache.get(key), request, { now, seen: new Set(cache.seenIds(key)) })
- 'render': renderView, and answers are written on r.answerLine / r.answerColumn
- 'evidence': recordEvidence(learner, e.evidence)
- 'seen', 'item-stat', 'mutant': cache.markSeen / recordItemStat / recordMutantResponse(key, e.mutantId, e.response)
- 'run-completion': gradeCompletion(e.text, ...), using the document text with the ___ blanks filled
It also covers:
- placement over seeded fundamentals, including real completions
- traceback seeds rendered and graded on pad lines
- harness spec runs for py, js and ts (spec JSON folder passed in readDirs)
- probe.py and probe.mjs with stdin, and what-if attribution
- verifySpecLadder and verifyPack through LocalRunner

Wiring facts:
- AtomCache must share the pad's clock (`opts.now`). Otherwise show times stamped by the pad are invisible to seenIds and unseenProbes.
- allowedConstructs: give the pad and placement `new Set(constructs.filter(c => { const t = constructTag(c, lang); return !t || t === targetTag || P(concept for t) >= .5 }))`. For placement, use `constructConcept: c => constructTag(c, lang)` (map the tag to its concept id or alias).
- AtomPackPromptInput.allowedImports = allowedImportsFor(lang, tags, await runner.findPythonModules(names)) for 'other' concepts.
- Seeds: the Instantiator's default traceback builder is now traceback.ts buildTracebackParts. Do not pass hooks.buildTraceback.
- Realistic latencies matter. A 7 s answer to a 33-character output is flagged as an implicit (too fast) guess and exits the atom as 'partial', so the pad must pass real latencyMs.
- The JobQueue's usage-limit check (err.kind === 'limit') and LlmError agree.

Stage-2 to-dos noted by the stage-1 engineers, still open:
- package.json, which I did not touch:
  - deliberate.pythonPath and deliberate.localExecution (machine scope), and codexPath set to machine scope
  - deliberate.backgroundConcurrency and deliberate.backgroundCallsPerHour
  - "verify:seeds": "tsx scripts/verify-seeds.ts", with `package` running it
- .vscodeignore: consider adding `scripts/**` and `**/__pycache__/**`. The runner uses -B, so no __pycache__ appears in normal use.
- media/seed/neutral.json has no consumer yet. The seedsPython notes describe how to build unverified StoredProbes from it, with mutant matching off.
- On Node 22.6-22.14, TS harness imports of './x.js' fail. The harness notes suggest applicable = false for TS ladders there.
- TemplateReport.transforms entries now carry `attributable`. Any code that builds them by hand must add it.
