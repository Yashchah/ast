=== runner  tests=True count=35
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

=== compare  tests=True count=51
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

=== evidence  tests=True count=54
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

=== jobs  tests=True count=60
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

=== seedsEngine  tests=True count=30
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

=== atoms  tests=True count=100
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

=== cores  tests=True count=110
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

=== harness  tests=True count=55
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

=== seedsPython  tests=True count=6
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

=== seedsJs  tests=True count=271
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

=== INTEGRATION tests=True count=539
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