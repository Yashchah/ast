# Stage 3 review findings (v0.2)

Six adversarial review lenses raised these findings; an independent skeptic then tried to refute each one.
"Confirmed" means the skeptic could not refute it. Status for ALL of them: NOT YET FIXED (the fixer was interrupted mid-way; some edits may be partially applied; re-check each against the current code).

| id | severity (verified) | confirmed | file:line | title |
|---|---|---|---|---|
| flow-1 | major | yes | `src/coach.ts:2157` | A task whose criteria were met but which never reached completeTask can never be completed (task switch or reload during what-ifs / lockFree) |
| flow-2 | major | yes | `src/coach.ts:1890` | 'I got it' during explain-back throws away the question and strands the task (criteriaMetAt already set) |
| flow-3 | major | yes | `src/coach.ts:754` | Retry while the plan job is waiting out a usage-limit pause applies the plan twice: duplicate milestone-1 tasks and an orphaned current task |
| flow-5 | major | yes | `src/coach.ts:1006` | A failed (or empty) TaskBatch at a milestone end strands the learner with no task, no error and no retry |
| pad-1 | major | yes | `src/coach.ts:426` | Rung-4 skeleton pad keeps the InteractionLock with no time limit, so task completion stalls for 5 minutes |
| pad-2 | major | yes | `src/atoms/padfs.ts:372` | When a flow ends, closing the pad moves focus and an out-of-date cursor position into the learner's code |
| pad-3 | major | yes | `src/atoms/pad.ts:833` | abortActive releases the lock before the pad flow has finished, so the next flow either throws or loses focus to the pad's close |
| pad-4 | major | yes | `src/atoms/grade.ts:41` | Multi-line answers written as the legend shows ('1/2'), or with Enter, are graded wrong |
| security-1 | major | yes | `src/runner.ts:469` | Model-code allowlist misses computed `constructor` access, enabling a vm escape to the host realm (RCE in tsx TypeScript mode) |
| security-2 | major | yes | `media/runner/prelude.py:184` | Native/C file writers (sqlite3, node:sqlite) bypass the write sandbox; own-code probes run with __file__ = the real workspace path, so learner code writes/corrupts real project files |
| evidence-1 | major | yes | `src/atoms/sprintSelect.ts:127` | Sprints can't find a model pack stored under its tag, so delayed checks, audits and reviews never run for that concept |
| evidence-2 | major | yes | `src/coach.ts:2040` | Spec-green latency becomes wall-clock time after a reload, which marks the concept Fragile on the green that should master it |
| evidence-3 | major | yes | `src/coach.ts:2097` | A hidden-spec failure is re-recorded as full-weight wrong evidence on every spec run |
| evidence-4 | major | yes | `src/atoms/sprintSelect.ts:195` | A concept that tests out earns production only from a clean spec green, so it can stay at P .8 'Learning' forever |
| evidence-5 | major | yes | `src/atoms/prefetch.ts:631` | Concepts that share a seeded tag get no stock and no pack, yet coverage is measured against the seed atom they are never shown |
| concurrency-1 | major | yes | `src/coach.ts:758` | Clicking Retry during a usage-limit pause runs onPlan twice, so the roadmap is duplicated and the current task is left out of it |
| concurrency-2 | major | yes | `src/coach.ts:2157` | A task switch or window reload while what-ifs are open leaves the task permanently impossible to complete |
| spec-2 | major | yes | `src/coach.ts:727` | Go, Java and Rust (offered in the language QuickPick) silently fall back to the v0.1 loop, but the onboarding copy, README and picker promise placement checks, practice and specs |
| spec-4 | major | yes | `src/coach.ts:2755` | Results that land for a finished task go into that task's feed, which is never shown, so background grading feedback is invisible |
| flow-4 | minor | yes | `src/coach.ts:350` | A v0.1 task saved in the mid-task 'Lock it in' explain-back is marked complete when the learner answers or skips |
| flow-6 | minor | yes | `src/atoms/prefetch.ts:566` | TaskPrep run while no runner is available (consent 'Not now', untrusted workspace, runtime not yet found) permanently stores a non-applicable ladder; granting consent later never brings specs back |
| flow-7 | minor | yes | `src/coach.ts:2210` | Rung-4 skeleton holds the InteractionLock with no deadline; at task end criteriaMet silently waits up to 5 min before completing |
| flow-8 | minor | yes | `src/coach.ts:1849` | Rung 4 while another modal flow holds the lock: the card says the skeleton is open in the pad, its code is stripped, and the pad never opens |
| flow-9 | minor | yes | `src/coach.ts:2359` | completeTask waits up to 20 s for a pending follow-up without rendering, so the finished task still looks active and its actions do nothing |
| flow-10 | minor | yes | `src/coach.ts:1055` | A TaskPrep that lands after the learner left the task is marked failed and never requested again when they return (no specs or gate for that task until a reload) |
| flow-11 | minor | yes | `src/coach.ts:961` | Reconcile never starts a task when the roadmap exists but no task is current (v0.1 project saved mid-diagnostic; reload during placement after the plan landed; reload during the follow-up wait) |
| flow-12 | minor | yes | `src/gate.ts:252` | guideApproach ('2 flawed plan picks in one task') can never fire |
| pad-5 | minor | yes | `src/owncode.ts:1170` | What-if asks the learner to predict a change that may not be on screen |
| pad-6 | minor | yes | `src/atoms/render.ts:548` | Traceback items: typing '?' for 'no idea' over the preselected template is treated as an empty answer |
| pad-7 | minor | yes | `package.json:436` | Esc Esc does not leave completion or traceback items, and the first Esc breaks Tab between blanks |
| pad-8 | minor | yes | `src/atoms/pad.ts:620` | Ctrl+Z gets past the assisted-insert guard after a discard |
| pad-9 | minor | yes | `src/atoms/padfs.ts:296` | Snippet renders take focus even though ensureEditor uses preserveFocus, e.g. when the escalation lesson arrives |
| pad-10 | minor | yes | `src/atoms/coach.ts:1427` | Out-of-date practice tab stays open after a keepOpen wait sprint when the drill it was waiting for never arrives |
| pad-11 | minor | yes | `src/atoms/pad.ts:1091` | 'running...' note stays on the first blank after a completion fails on another line |
| evidence-6 | minor | yes | `src/coach.ts:1887` | gotIt() is not idempotent: after a Reveal it re-records the last rung's hint evidence |
| evidence-7 | minor | yes | `src/learner.ts:285` | Merging into an untagged tag owner never sets its tag, so coverage is silently dropped |
| concurrency-3 | minor | yes | `src/atoms/prefetch.ts:729` | Errors in nested repair calls, including usage limits, are swallowed: the concept is marked probeable=false for good and the background lane never pauses |
| concurrency-4 | minor | yes | `src/atoms/prefetch.ts:927` | A hint the learner asks for, which dedupes onto a queued speculative ladder, can hang for the 15-minute pause and block the hint button |
| concurrency-5 | minor | yes | `src/coach.ts:1406` | A Teach waiting on a pack or mini atom opens the old task's drill after a task switch |
| concurrency-6 | minor | yes | `src/lock.ts:75` | abortActive releases the lock before the pad flow has finished, so the next pad flow throws and its gap atom or placement is skipped |
| concurrency-7 | minor | yes | `src/extension.ts:747` | Shutdown order saves a spurious 'Roadmap failed' card on every reload while the roadmap is pending |
| concurrency-8 | minor | yes | `src/coach.ts:2484` | Erasing the profile mid-task detaches the spec ladder and cancels needed jobs, and nothing re-attaches or re-queues them |
| concurrency-9 | minor | yes | `src/jobs.ts:572` | Nested repair calls are not counted, so one budget unit can be up to 4 model calls and the hourly cap does not hold |
| concurrency-10 | minor | yes | `src/coach.ts:2359` | A reload during completeTask's follow-up wait leaves no active task, and the follow-up is lost |
| concurrency-11 | minor | yes | `src/coach.ts:1114` | Task switches and new projects never abort the foreground call: an old task's call keeps the single fg lane busy while its result is thrown away |
| spec-1 | minor | yes | `src/atoms/render.ts:319` | REVEAL clips the refutation to 52 characters, so on every seeded misconception the sentence that does the refuting only appears on hover |
| spec-3 | minor | yes | `src/coach.ts:2359` | Task end waits up to 20 s on the follow-up call with no UI update, and Pace's 'Model wait per task' never counts it |
| spec-5 | minor | yes | `src/atoms/stepMachine.ts:697` | ESCALATE can leave the learner on '# preparing a short lesson... (~10 s)' for up to 150 s with no way to continue, and the lesson's wait counts against ESCALATE's own clock |
| spec-7 | minor | yes | `package.json:630` | The 'deliberate.nameNewMisconceptions' setting in the README and package.json does nothing |
| spec-6 | minor | NO (refuted) | `src/coach.ts:2165` | The free-text 'Explain it back' essay also appears when the learner's code runs fine but no what-if changes its result, not only when there is no runtime |

## flow-1: A task whose criteria were met but which never reached completeTask can never be completed (task switch or reload during what-ifs / lockFree)

- Lens: flow. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/coach.ts:2157`

**Failure scenario.** All specs and the hidden spec pass, so criteriaMet sets t.criteriaMetAt and opens the what-if InputBoxes (or waits in lockFree() for up to 5 min). Two ways to get stuck from here. (a) The learner clicks another task in the roadmap: abortFlows aborts the what-ifs, criteriaMet sees `this.task !== t` and returns. When the learner comes back, t is still 'active'/'building'. (b) VS Code is closed or reloaded at that point: criteriaMetAt was already saved by changed(), and reconcile re-attaches the specs. In both cases every later route to completion is guarded by criteriaMetAt. Saving with all specs green, Run my specs and Check my work all do nothing, and the task stays active forever.

**Evidence.** criteriaMet: `if (t.criteriaMetAt || t.status !== 'active') return; t.criteriaMetAt = this.now(); ... this.changed(); const what = await this.whatIfs(t); if (this.task !== t || t.status !== 'active') return;`. checkWork (spec-less): `if (t.criteriaMetAt) return;`. onHidden pass -> criteriaMet -> immediate return. Confirmed with scratch tests on the flow-test harness. S2a: a switch during what-ifs, then a return, hidden pass and checkWork leave t1 'active building' and the what-ifs never run again. S2b: a project with criteriaMetAt set, status active, then reconcile and a hidden pass leave t1 'active building' with mode 'building'.

**Suggested fix.** When criteriaMet bails because the task changed, clear criteriaMetAt (or record a 'pending completion' state). In beginTask's returning path and in reconcile, resume an active task that has criteriaMetAt set and is not in explain-back: rerun the what-ifs or go straight to completeTask. Alternatively, let criteriaMet re-enter when the task is still active and building.

**Verifier note.** Confirmed by reading and by a scratch test on the flow harness. criteriaMet sets t.criteriaMetAt before awaiting whatIfs and returns when `this.task !== t`. Nothing ever clears criteriaMetAt. On return, beginTask only re-attaches specs; onHidden goes to criteriaMet, which returns at once. checkWork with specs only re-runs them, and without specs it returns on criteriaMetAt. completeTask has only three callers: criteriaMet, answerExplainBack and skipExplainBack. Experiment F1a (switch during what-ifs, return, hidden pass, checkWork): t1 stays 'active building' and the what-ifs never run again. F1b (criteriaMetAt persisted, reconcile, hidden pass): t1 stays 'active building', mode 'building'.

## flow-2: 'I got it' during explain-back throws away the question and strands the task (criteriaMetAt already set)

- Lens: flow. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/coach.ts:1890`

**Failure scenario.** Spec-less task (or the conflict-flag path): Check my work says criteria met, there is no runtime, so askExplainBack sets phase 'explain-back'. Two 'I got it' controls are still live: the sidebar hint cards keep their 'I got it' button (card actions are never cleared), and the in-editor hint annotation keeps its [Got it](command:deliberate.gotIt) link (it is not cleared on criteriaMet). The learner clicks either one and gotIt forces phase 'building'. The Submit/Skip composer disappears, the composer returns to 'building', and Check my work silently returns because criteriaMetAt is set. A typed answer becomes an Ask call instead of the grade. The task can never complete.

**Evidence.** gotIt(): `if (t.phase !== 'building' && t.status === 'active' && t.phase !== 'learning') t.phase = 'building';` (this also covers 'explain-back'). hintActions always adds `{ label: 'I got it', command: 'gotIt', primary: true }`, and main.js actionsHtml renders card actions forever. HINT_LINKS contains `[Got it](command:deliberate.gotIt)`. Scratch test S3: phase goes explain-back -> building after gotIt(), checkWork makes 0 review calls, the task stays 'active', and submit() makes an AnswerSchema call with 0 GradeSchema calls.

**Suggested fix.** In gotIt, change the phase only from 'learning'/'building'. Never leave 'explain-back', 'gate' or 'explain'. Also clear hint annotations, and disable old hint-card actions, when criteria are met.

**Verifier note.** gotIt() moves any phase other than 'building'/'learning' to 'building' while the task is active, and that includes 'explain-back'. Hint-card actions are rendered by main.js actionsHtml for every card with no phase guard, and view.ts sends 'gotIt' straight to coach.gotIt(). Experiment (allowRun=false; review meets criteria, then explain-back, then gotIt): phase becomes building and mode building. checkWork then makes 0 review calls, and submit makes 1 AnswerSchema call and 0 GradeSchema calls. The task stays 'active' with no path to completeTask.

## flow-3: Retry while the plan job is waiting out a usage-limit pause applies the plan twice: duplicate milestone-1 tasks and an orphaned current task

- Lens: flow. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/coach.ts:754`

**Failure scenario.** PlanOutline hits the Codex plan limit. onTrouble shows the 'Roadmap failed: usage limit reached (... it retries after the pause)' card with Retry, and the JobQueue re-queues the same 'plan' entry for after the 15-min pause. The learner clicks Retry. enqueuePlan calls jobs.bg with the same key and the same project gen, so the dedupe returns the in-flight promise and pushes a second apply. When the retry succeeds, onPlan runs twice. The first run builds milestone 1 and (placement done) starts task 1. The second run replaces p.milestones with fresh tasks. The current task is no longer in any milestone, and the roadmap shows a second, todo 'Add a todo'. After finishing the orphan, nextRoadmapTask hands the learner the duplicate, so task 1 is done twice. Extra TaskPrep calls and two 'Roadmap ready' cards also appear.

**Evidence.** retryPlan guards only `p.milestones.some((m) => m.taskIds.length)`. jobs.bg: `if (genMatches(existing.spec.gen, spec.gen, spec.scope)) { if (apply) existing.applies.push(apply) ... return existing.promise }`. onPlan has no idempotence check: `p.milestones = (o.milestones ?? []).map((m) => ({ ..., taskIds: [] }))`. Scratch test S1: 'milestone 1 taskIds: 3 | tasks in project: 6', 'current task in roadmap order: false', 'Roadmap ready cards: 2'.

**Suggested fix.** Make onPlan idempotent: return early if !p.placement.planPending or milestones already have tasks. In retryPlan, skip the enqueue when jobs.has('plan') and the job is still queued for retry.

**Verifier note.** jobs.onError puts a limit-failed priority 0-1 entry back in the queue and keeps its key in this.jobs. retryPlan's only guard is 'milestones have tasks', so it calls enqueuePlan, and jobs.bg with the same key and project gen pushes a second apply. onPlan has no idempotence check. Experiment (first PlanOutline throws kind:'limit', Retry clicked, pause ended): 'm1 tasks 3, tasks 6, current in order false, ready cards 2'. The Roadmap failed card with Retry really does appear during the pause.

## flow-5: A failed (or empty) TaskBatch at a milestone end strands the learner with no task, no error and no retry

- Lens: flow. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/coach.ts:1006`

**Failure scenario.** The learner finishes the last task of a milestone. completeTask enqueues the batch and shows 'The next milestone is being prepared... It starts the moment it lands.' If the batch call fails (codex error, schema/parse error, dropped), or if it was still in flight from milestone start and fails, nothing reacts. No error card, no Retry, no re-enqueue. The composer offers only Sprint, and the roadmap says 'Tasks are written when you get close to this milestone.' Only a window reload (reconcile -> ensureNextBatch) recovers. A batch (or a plan's milestone1Tasks) that comes back with `tasks: []` (the schema allows it) gets stuck the same way: onBatch adds 0 tasks and beginNext finds nothing.

**Evidence.** enqueueBatch: `const job = this.prefetcher.taskBatch(k, ..., (tasks) => this.onBatch(p, k, tasks)); void this.track(job);` has no handling for an undefined result, unlike enqueuePlan/planFailed. TaskBatchSchema = `z.object({ tasks: z.array(TaskOutSchema).describe('3-6') })` with no min. Scratch test S5: 2 TaskBatch calls both fail, current task is t1 'done', no 'batch:1' job, 0 error cards, inputMode 'ask' with only 'sprint'.

**Suggested fix.** Await the batch result in enqueueBatch. When it is undefined or empty and the learner is waiting (current task done), push a 'Milestone failed' error card with a Retry action that calls enqueueBatch again. Treat an empty task list as a failure.

**Verifier note.** enqueueBatch only tracks the job and ignores an undefined (failed) or empty result. No settle listener in prefetch reacts to a failed batch, and ensureNextBatch is called only from reconcile. Experiment (TaskBatch throws; last task of milestone 1 completes): 2 batch calls, t1 done, no batch:1 job, 0 error cards, inputMode 'ask' with only 'sprint'. The learner is stuck with no message until a window reload.

## pad-1: Rung-4 skeleton pad keeps the InteractionLock with no time limit, so task completion stalls for 5 minutes

- Lens: pad. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/coach.ts:426`

**Failure scenario.** The learner takes hint rung 4. The skeleton opens beside their code with the instruction 'fill the ___ here, then write it in your own file'. They leave that tab open as a reference and write the real code. When every spec passes, criteriaMet() runs whatIfs(), which waits up to 5 minutes in lockFree() for the 'skeleton' lock. For those 5 minutes nothing happens after 'Every behaviour passes'. The what-if InputBox then gets 'busy' and is skipped, and only then does the next task start. While the tab stays open, the tempo bar cannot pop or auto-open anything because lockHeld is true, and Ctrl+Alt+H keeps returning the same in-flight hint promise, so rung 5 cannot be requested.

**Evidence.** coach.ts:424-429 padSkeleton: `await s.show(skeletonRender(lang, code)); for (;;) { const i = await s.next(); if (i.type === 'continue' || i.type === 'submit' || i.type === 'abort') break; ...}`. next() gets no deadline, so the loop ends only on Ctrl+Enter, Esc Esc or tab close. coach.ts:1857-1865: `const release = pad!.acquire('skeleton'); ... await this.deps.skeleton!(lang!, code); ... finally { release(); }`. coach.ts:2210 `await this.lockFree();` and 2236 `private async lockFree(maxMs = 5 * MIN)`. owncode.ts:1159-1160: acquire('what-if') fails, so the result is `{ status: 'unavailable', reason: 'busy' }` and whatIfs returns 'later'. tempo.ts:108 `if (input.lockHeld) return false;` (no pops) and :53 `const open = !input.lockHeld && ...` (no auto-open). coach.ts:1693: hint() returns hintFlight.p while skeletonRung is still awaiting the pad. Found by reading the code.

**Suggested fix.** The skeleton is reference material, not a modal flow. Either do not hold the InteractionLock for it, or release the lock once it has rendered. At minimum, give s.next() a deadline, and in criteriaMet/lockFree abort a holder whose kind is 'skeleton' instead of waiting 5 minutes.

**Verifier note.** Confirmed in the code. In coach.ts, skeletonRung holds pad.acquire('skeleton') until padSkeleton's loop ends. That loop calls s.next() with no deadline and exits only on continue, submit, abort or a double Esc. Nothing in criteriaMet, gotIt or the spec-green path aborts a 'skeleton' holder. whatIfs reaches lockFree (5*MIN) when running is allowed and the concepts are not all Fluent, then WhatIfFlow.run fails acquire with 'busy', which maps to 'later', and only then does completeTask run. hint() returns hintFlight.p while skeletonRung is still waiting, so neither Ctrl+Alt+H nor 'Next hint' can serve rung 5. While the lock is held, tempo.decide blocks pops and auto-open.

## pad-2: When a flow ends, closing the pad moves focus and an out-of-date cursor position into the learner's code

- Lens: pad. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/atoms/padfs.ts:372`

**Failure scenario.** The learner accepts 'practice while you wait' during Check my work (or starts a JIT atom). The pad opens beside the code, and the code cursor is recorded at line 40. After one item they click back into their code and keep typing at line 80, or in the terminal. The flow then ends without any pad input: the review lands and the 15 s grace passes, or the atom's 150 s cap fires, or the 5-minute idle limit hits. close() then calls showTextDocument(prev.uri, {selection: <line 40>, preserveFocus: false}). The cursor jumps back to line 40, or focus moves from the terminal into the source file, and the next keystrokes are inserted in the wrong place in the learner's project.

**Evidence.** padfs.ts:254-256 records the previous editor once, at open: `this.prev = { uri: active.document.uri, viewColumn: active.viewColumn, selection: active.selection }`. padfs.ts:368-372 on close: `const prev = this.prev; ... await vscode.window.showTextDocument(prev.uri, { viewColumn: prev.viewColumn, selection: prev.selection, preserveFocus: false });`. Nothing checks whether the pad still has focus or whether the learner moved on. Flows that end without input: pad.ts:973 `session.next(atomDeadline(ctx.state))` (150 s cap, stepMachine.ts:364-367), sprint.ts:251 deadline `untilSettledAt + SPRINT.untilGraceMs`, then sprint.ts:443 `await pad.closeSession()`, and the PAD.idleMs 5-minute limit in placement and sprints.

**Suggested fix.** Restore the previous editor only if the pad is still the active or focused editor when it closes (check window.activeTextEditor before closeSession). Even then, do not pass the recorded selection, because the learner may have edited the file since; reveal the document with preserveFocus: true instead.

**Verifier note.** Confirmed. VscodePadEditor.open records prev (uri, viewColumn, selection) once, at lines 258-260. close() at lines 372-376 always calls showTextDocument(prev.uri, {selection: prev.selection, preserveFocus: false}) and never checks whether the pad still has focus. Flows that end without pad input are real: sprint.finish calls closeSession after the 'until' grace or the idle deadline, and atoms have atomDeadline caps. Either path moves the caret back to the recorded selection and takes focus from wherever the learner is.

## pad-3: abortActive releases the lock before the pad flow has finished, so the next flow either throws or loses focus to the pad's close

- Lens: pad. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/atoms/pad.ts:833`

**Failure scenario.** (a) A pad flow such as an atom or sprint is waiting for input and the coach calls lock.abortActive() (task switch, new project, reset). The lock is freed at once, but the pad flow has only had an abort posted; it still needs its feedback hold (up to 1.5 s) and the tab close. If the coach then starts a pad flow straight away (startProject → runPlacement, beginTask → repairGaps → runAtom, or the tempo auto-opening a queued blocking 'atom:'/'placement' action on lock release), beginFlow throws. Reproduced with the real AtomPad, PlacementRun, Stock and Coach in a scratch test: calling startProject while a placement waits logs "[coach] placement failed: AtomPad: 'placement' is running; 'placement' cannot start" and sets placement.done=true, so the new project never gets a placement. A gap atom started this way is silently deferred, and a queued blocking action is removed from the queue and lost. (b) If the next flow is the gate, its QuickPick (ignoreFocusOut) opens first. The old pad's close() then calls showTextDocument(prev, preserveFocus:false) and takes focus from it, so the learner's Space and Enter, which the placeholder tells them to use ('Space toggles · Enter submits'), are typed into their source file.

**Evidence.** lock.ts:66-77 abortActive: `h.onAbort?.('esc'); return this.release(h.token, 'esc') ...` releases synchronously. pad.ts:833-841 endActive only posts the abort: `f.onAbort?.(reason); ... this.session?.abort(reason);`. pad.ts:816-817: `if (this.flow) throw new Error(`AtomPad: '${...}' is running; '${...}' cannot start`)`, and `this.flow` is cleared only in run()'s finally, after exitAtom → closeSession → hold → editor.close(). coach.ts:910-930: the catch only logs, then `p.placement.done = true; ... await this.afterPlacement(p)`. coach.ts:1141-1172: beginTask calls abortFlows and then runGate or repairGaps with no wait in between. Scratch test output: `placement runs created: 2`, `second project placement done? true`, logs `["[coach] placement failed: AtomPad: 'placement' is running; 'placement' cannot start"]`.

**Suggested fix.** Make the pad's abort complete before the lock is released. For example, let the lock's onAbort return a promise that AtomPad resolves when its flow's finally has run, and await it in abortFlows before starting the next flow. Alternatively, make beginFlow wait for the previous flow to end instead of throwing. In either case, do not restore focus in close() when the close came from an 'external' abort.

**Verifier note.** Reproduced. I copied the real AtomPad + PlacementRun + Stock + Coach integration test into the scratchpad, called startProject while placement was waiting for an answer, then called startProject again. Output: runs=2, the second project's placement.done=true, and the log shows "[coach] placement failed: AtomPad: 'placement' is running; 'placement' cannot start". Cause: lock.abortActive releases the lock synchronously. AtomPad.endActive only posts the abort, and this.flow is cleared in the old flow's finally, which runs after closeSession/editor.close. The only await between abortFlows and runPlacement is ensureBackgroundConsent, which settles in microtasks.

## pad-4: Multi-line answers written as the legend shows ('1|2'), or with Enter, are graded wrong

- Lens: pad. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/atoms/grade.ts:41`

**Failure scenario.** The probe `for x in [1, 2]: print(x)` shows the legend '| between lines'. The learner types `# -> 1|2` and is graded wrong, with 'actual: 1 | 2' shown next to their answer, which differs only in spacing. Or they press Enter after `# -> 1` and type `2` on the new line, because nothing continues the '# -> ' prefix; that line is silently ignored, the answer is graded as '1', and it is wrong. Either way real wrong evidence is recorded, and in an atom a learner who knew the output is sent to UNKNOWN teaching. keysUsed does not count '1|2' as using the '|' key either, so the legend never fades.

**Evidence.** render.ts:104 `LEGEND = 'Ctrl+Enter submit · Ctrl+Shift+Enter guessing · ? no idea · | between lines'`. grade.ts:41 `lines.push(...body.split(' | ')...)` and compare.ts:1033 `base.flatMap((l) => l.split(' | '))` split only on ' | ' with spaces. pad-python.language-configuration.json has no onEnterRule for '# ->' lines. Scratch run of answerText+gradePredict on that probe: `"1|2" | verdict: wrong | feedback: actual: 1 | 2 | keysUsed: ['ctrl+enter']` and, with Enter, `answer: "1" | verdict: wrong`. Also '1 |2' and '1| 2' are graded wrong.

**Suggested fix.** In answerCandidates, also try splitting on /\s*\|\s*/ as a fallback candidate (keeping the unsplit form for outputs that really print '|'), or grade a spacing-only difference as format-only. Add an onEnterRule (beforeText `^\s*#\s*->.*$`, appendText '# -> '; '// -> ' for JS/TS), or treat non-comment lines below the last answer line as answer lines.

**Verifier note.** Confirmed by experiment with answerText and gradePredict on a probe printing '1\n2'. '1|2', '1 |2' and '1| 2' are all graded wrong, and only '1 | 2' is correct. Typing '# -> 1', pressing Enter and typing '2' gives answer '1', which is graded wrong. parseAnswerLines and answerCandidates split only on ' | ', while the legend reads '| between lines'. The pad language configurations have no onEnterRule that continues '# -> '. keysUsed matches only / \| /.

## security-1: Model-code allowlist misses computed `constructor` access, enabling a vm escape to the host realm (RCE in tsx TypeScript mode)

- Lens: security. Reported severity: critical. Verified severity: major. Confirmed: yes.
- Location: `src/runner.ts:469`

**Failure scenario.** A model-generated JS/TS snippet (atom / seed / placement item, run in the background by LocalRunner.runBatch whenever snippet execution is consented in a trusted workspace) contains `structuredClone['con'+'structor']('return this')()`. The allowlist passes it, and inside batch.mjs's vm context that reaches the HOST realm's Function (because host functions such as structuredClone/console.log/setTimeout are injected directly as context globals), giving `process`. In the tsx TypeScript runner path the process is spawned with `--allow-child-process`, so `process.getBuiltinModule('child_process').execSync(...)` runs arbitrary OS commands. I ran exactly this through batch.mjs with the real snippet flags and `echo PWNED-%USERNAME%` executed (stdout: `spawned: PWNED-yashc`). In native-strip TS mode and plain JS mode the same payload still breaks out to the host `process` object (vm/sandbox integrity gone), though child_process stays blocked by --permission there.

**Evidence.** src/runner.ts JS_DENIED only blocks dotted access `[/\.\s*constructor\b(?!\s*\.\s*name\b)/, '.constructor']` (line 469) and JS_DENIED_RAW only blocks the quoted literal `[/['"`](?:constructor|__proto__)['"`]/, 'constructor by name']` (line 474). I ran allowlistCheck on `"const k='con'+'structor';const F=structuredClone[k];..."` -> returned ALLOWED, while `structuredClone['constructor']` -> 'constructor by name' and `.constructor` -> '.constructor'. batch.mjs builds the context with host globals: `const globals = { console: makeConsole(sink), setTimeout: ..., structuredClone, ... }; const ctx = vm.createContext(globals);` (media/runner/batch.mjs lines ~203-214), so their `.constructor` is the host Function. detectTypeScript adds child-process permission in tsx mode: `const allowChild = node.permissionFlag ? ['--allow-child-process'] : []; ... snippetArgv: [...node.snippetArgv, ...allowChild]` (src/runner.ts lines ~379-384). Confirmed RCE output `spawned: PWNED-yashc` from `node --permission --allow-child-process ... batch.mjs items.json --lang typescript --tsx <dir>`.

**Suggested fix.** Do not rely on source-text pattern matching to contain model code. In batch.mjs, never expose host functions as context globals: define console/timers/structuredClone INSIDE the context (via runInContext source, like CHECK_SOURCE) or wrap them so their prototype chain cannot reach a host Function, and freeze the context's own Function/eval. As defense in depth, extend the allowlist to reject any computed member access with a non-plain-string key (and any string that normalizes to 'constructor'/'__proto__'/'prototype'), and stop passing --allow-child-process for tsx by pre-transforming TS without spawning esbuild (ESBUILD_WORKER_THREADS=0 still shells out to the esbuild binary).

**Verifier note.** Confirmed by experiment. allowlistCheck returns undefined (allowed) for `const k='con'+'structor'; const F=structuredClone[k]; const g=F('return this')(); const p=g['pro'+'cess']` in both javascript and typescript. JS_DENIED only matches dotted `.constructor` on stripped text (runner.ts:469), and JS_DENIED_RAW (runner.ts:475) only matches the whole quoted literal. In batch.mjs:203-214 host functions (structuredClone, the console object, timer wrappers) are injected directly as context globals, so their constructor is the host Function. Running it through the real LocalRunner.runBatch gave these results. JS mode and native-strip TS mode (the default on this Node 24.11.1 machine): reached the host process (`host process: object v24.11.1`) and host fetch, but child_process and fs writes were blocked with ERR_ACCESS_DENIED. Forced tsx mode (snippetArgv plus --allow-child-process, as detectTypeScript builds it at runner.ts:379-384): printed `spawned: PWNED-yashc`. That is full RCE. The line-468 comment shows this exact escape was meant to be blocked. I downgraded it from critical because two things must both hold. First, the model has to emit hostile code (a compromised or prompt-injected Codex output). Second, full RCE needs the tsx fallback, which is used only on Node builds without module.stripTypeScriptTypes (20.x, 22.0-22.12, 23.0-23.1) that have tsx installed. getBuiltinModule also needs 20.16+ or 22.3+. On current Node the escape is real, but --permission still limits it to network access and reads of the tmp and runner dirs.

## security-2: Native/C file writers (sqlite3, node:sqlite) bypass the write sandbox; own-code probes run with __file__ = the real workspace path, so learner code writes/corrupts real project files

- Lens: security. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `media/runner/prelude.py:184`

**Failure scenario.** The documented guarantee (redesign-spec line 750 / consent UI: 'your project files are never written') relies on the Python audit hook and Node --permission to confine writes to a temp dir. Both only cover interpreted file APIs. A learner building the kind of 'real project' this tool targets (e.g. a todo app with a SQLite DB) has a function like `def add(t): con=sqlite3.connect(os.path.join(os.path.dirname(__file__),'todos.db')); con.execute(...); con.commit()`. When Deliberate runs an own-code probe or a what-if MUTANT of that function (triggered by the coach on the learner's own code, not by the learner choosing to run their program), harness.py sets the module's __file__ to the REAL workspace file, so the sqlite write lands in the real workspace and is NOT blocked by the audit hook. A what-if mutant runs an ALTERED version of the function against the real DB, silently corrupting it. The Node analog: `node:sqlite` DatabaseSync ignores --allow-fs-write entirely.

**Evidence.** prelude.py blocks only `open`, `os.*` path events, shutil and process/socket/link events (_PATH_EVENTS/_ALWAYS, _blocked at lines ~184-202); sqlite3's C extension emits none of these. I ran a probe end to end: `printf <sqlite source> | python -E -B -X utf8 media/harness/probe.py <realws>/todos.py 'add("from-probe")' --stdin --workspace <realws>` from an unrelated temp cwd -> probe returned ok and `todos.db` was created in the REAL realws directory (sandbox temp dir stayed empty); a plain `open(...,'a')` in the same spot is blocked with DeliberateSandbox. harness.py `_exec_module` sets `mod.__file__ = self.path` where `self.path = os.path.abspath(module_path)` is the real file (harness.py ~lines 383, 530); owncode.ts calls `runner.runLearnerCode(script, [o.file, o.call, '--stdin', ...])` with o.file = the real workspace path (src/owncode.ts lines ~99-102). Node side: under `node --permission --allow-fs-read=<ws> --allow-fs-write=<tmp>`, `fs.writeFileSync(<ws>/plain.txt)` -> BLOCKED ERR_ACCESS_DENIED, but `new DatabaseSync(<ws>/via_sqlite.db); db.exec('create table...')` -> ALLOWED and via_sqlite.db appeared in the read-only ws dir.

**Suggested fix.** Confine writes at the OS level rather than by hooking interpreted APIs: run spec/probe processes with the real workspace mounted read-only (or copy the module to the temp dir and point __file__/sys.path there for probes too, as spec runs already do), so native writers cannot reach project files. At minimum, add sqlite3/_sqlite3 and node:sqlite to the denied set for any code that is not run from a throwaway copy, and set __file__ to the temp location during own-code probes so __file__-relative writes stay in the sandbox.

**Verifier note.** Confirmed end to end, and it is broader than reported. prelude.py's audit hook (_blocked, lines 184-202) only covers `open` and the os/shutil/process/socket events. It does not hook sqlite3.connect, and SQLite's C VFS writes without raising an `open` audit event. Experiment: with a learner module whose add() runs sqlite3.connect(os.path.join(os.path.dirname(__file__),'todos.db')), I ran probe.py through LocalRunner.runLearnerCode with the same args owncode.ts:99-102 uses (real file path, --stdin). It returned ok and created todos.db in the real workspace dir, while add_plain() using open(...,'a') was blocked with DeliberateSandbox. harness.py sets mod.__file__ = the real path (lines 383, 530). The finding says on-save spec runs avoid this, but they do not: specs.ts:1024 also passes the real workspace file. Running harness.py with a spec call `add("spec-row")` likewise wrote todos.db into the real workspace, so model-chosen spec calls would insert rows into the learner's DB on every save. Node: under `--permission --allow-fs-write=<tmp>`, node:sqlite DatabaseSync created a DB in a dir where fs.writeFileSync got ERR_ACCESS_DENIED. harness.mjs spec runs import the real file (copy is false without source), and that wrote todos.db into the real JS workspace. JS own-code probes are not affected through import.meta.url, because they import a temp copy (harness.mjs writeCopy). This breaks the UI promise 'your project files are never written' (extension.ts:687) for the todo-app persistence case the spec itself cites. Relative DB paths are safe because cwd is the temp dir, so only __file__-relative or absolute paths are affected. There is no attacker; the impact is silent pollution or corruption of the learner's own data. I kept it at major.

## evidence-1: Sprints can't find a model pack stored under its tag, so delayed checks, audits and reviews never run for that concept

- Lens: evidence. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/atoms/sprintSelect.ts:127`

**Failure scenario.** Take a plan concept on a taxonomy tag that has no seeds, such as 'parse-json' with tag 'json-parse-serialize', and suppose it is the only concept with that tag (the common case). packKey() stores its AtomPack under the tag key. Sprint.stockMap() keys stock by cache key. mergeStock then calls resolveId(concepts, 'json-parse-serialize'), finds no concept or alias with that id, and keeps the bare tag. Every selection tier then looks stock up by the concept id ('parse-json') and finds nothing. As a result this concept never gets a delayed misconception check, an audit, a due review, or a guess or fragile follow-up. A misconception that an atom suppressed can then never clear, because clearing needs sprint delayed hits. It blocks mastery for good, and the chip stays 'Fixing'. Each later atom on the concept also re-routes to REFUTE, because nextCheckAt stays due and `suppresses` is a no-op on an already-suppressed M.

**Evidence.** prefetch.ts:158-164 packKey: `const owner = learner.concepts[tag] ?? (tagged.length === 1 ? tagged[0] : undefined); return owner === c ? tag : c.id;` (test/prefetch.test.ts:162 asserts packKey(solo,'parse-json') === 'json-parse-serialize'). sprint.ts:232 `for (const key of this.deps.stock.cache.keys()) ... out[key] = {...}`. sprintSelect.ts:127 `const id = resolveId(ctx.learner.concepts, key) ?? key;`, and line 168 `freshProbes(sel, d.c.id, ...)` -> `sel.stock.get(id)`. resolveId only checks ids and aliases, never tags. Scratchpad check: a learner with 'parse-json-config' (tag json-parse-serialize) holds a suppressed misconception that is due and also has a due review. nextSprintItem with stock keyed by packKey (the tag) returns NONE. With the same stock keyed by the concept id it returns `predict parse-json-config json-keys-any-type`.

**Suggested fix.** Resolve stock keys the way Stock.cacheKeyFor does. In mergeStock, map a tag key to the concept that owns the tag (learner.concepts[tag] ?? the single concept tagged with it). Alternatively, have Sprint.stockMap() key each entry by the owning concept id.

**Verifier note.** Confirmed by code and experiment. When a plan concept is the only one carrying a tag that has no seeds, packKey() files its pack under the tag. Sprint.stockMap() (sprint.ts:232) keys stock by that cache key. mergeStock (sprintSelect.ts:127) maps keys with resolveId, which only checks concept ids and aliases, so the bare tag key stays unresolved. Every tier then looks stock up by the concept id and finds nothing. onPlan's seedTags only creates tag-owner concepts for seeded or fundamental tags, so no concept or alias with the tag's id exists. Scratch run: learner with 'parse-json-config' (tag json-parse-serialize), a suppressed misconception that is due, and a due review. Stock keyed by packKey gave nextSprintItem = undefined; the same stock keyed by concept id gave 'predict parse-json-config delayed-check'. Stock.cacheKeyFor handles this case; sprint selection does not.

## evidence-2: Spec-green latency becomes wall-clock time after a reload, which marks the concept Fragile on the green that should master it

- Lens: evidence. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/coach.ts:2040`

**Failure scenario.** A learner turns two specs green, closes VS Code, and comes back the next day. They make the next spec green. onGreen calls activeMsSince(previousGreenAt). activeSamples is in-memory only and starts empty after a reload (or when the previous green is older than the oldest of the 4000 kept samples), so the function returns `now - wallMs`, about 18 hours. The record is kind 'spec' with latencyValid true. ACTIVE_TIME kinds skip the 60 s cap, so applyEvidence treats it as a correct answer slower than 2x par_self and sets Fragile once gradedCount >= 15. A scratchpad run with P .8, 2 groups, gradedCount 40 and an 18 h latency gives P .962, production true, fragile true, chip 'Fragile', mastered false. The green that should have mastered the concept blocks mastery instead and starts the 10 min / 1 day fragile ladder.

**Evidence.** coach.ts:2039-2044 `const since = info.previousGreenAt ?? t.startedAt ?? info.at; const latencyMs = this.activeMsSince(since); recordEvidence(..., latencyMs, latencyValid: latencyMs > 0, ...)`. coach.ts:703 `if (!this.activeSamples.length || wallMs < this.activeSamples[0][0]) return Math.max(0, this.now() - wallMs);`. activeSamples (line 497) is never persisted. evidence.ts:212 `return ACTIVE_TIME.has(ev.kind) || ms <= PARAMS.latency.maxMs;` and lines 701-704 set fragile when `ms > F.slow * par`.

**Suggested fix.** When the sample window does not cover `since`, mark the latency invalid (latencyValid: false) instead of falling back to wall-clock time. Alternatively, measure per-spec active ms from persisted task.activeMs snapshots, such as storing task.activeMs at each green.

**Verifier note.** Confirmed. activeSamples (coach.ts:497) lives only in memory. It holds one sample per 5 s monitor tick, capped at 4000, which covers only about 5.5 hours even inside one session. previousGreenAt comes from the persisted spec.greenAt (specs.ts:953). activeMsSince (coach.ts:703) falls back to now - wallMs when the samples do not reach back to `since`. onGreen then records it with latencyValid = latencyMs > 0. latencyUsable skips the 60 s cap for the 'spec' kind (evidence.ts:212). The fragile step (evidence.ts:700) sets fragile when ms > 2x par after 15 graded items, and isMastered (evidence.ts:294) refuses mastery while fragile.

## evidence-3: A hidden-spec failure is re-recorded as full-weight wrong evidence on every spec run

- Lens: evidence. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/coach.ts:2097`

**Failure scenario.** All visible specs are green and one hidden spec fails. The task stays in building, and every save, auto-save or 'Check my work' re-runs the hidden specs, because hiddenPassed is still false. Each run calls onHidden, which records another weight-1 'spec' wrong on the same concept and pushes another card. Re-saving unchanged code also counts. In a scratchpad run, four runs while the learner fixes one transfer failure take P from .80 to .43, .156, .078 and .063. They also set lastWrongAt, which drives ROUTE to UNKNOWN, propagation caps and follow-up targeting. Failure signatures, by contrast, are explicitly de-duplicated per code version.

**Evidence.** specs.ts:995-1001 `if (allGreen && !this.hiddenPassed) { const hidden = await this.runHidden(...); ... else spec.overfit = true; this.on.onHiddenResult?.(hidden);` runs on every execute(). coach.ts:2092-2097 `if (r.pass) {...} this.push({... 'Passes your checks, not this one' ...}); recordEvidence(this.learner, { conceptId: r.spec.conceptId, kind: 'spec', source: 'spec', correct: false, ... });`. There is no dedupe by spec id or code hash. Compare specs.ts:1107-1118, where signature evidence is keyed `${k}|${textKey}` so 're-saving unchanged code does not' count again.

**Suggested fix.** Record the transfer failure once per hidden spec per task, for example only when spec.overfit flips from false to true, or keyed by the hidden spec id plus the code hash as the signature path does. Show the card only once as well.

**Verifier note.** Confirmed. SpecController.execute re-runs hidden specs on every run while hiddenPassed is false (specs.ts:995-1001). Nothing checks the code hash, so re-saving unchanged code also re-runs them. Every run calls onHiddenResult, and onHidden (coach.ts:2097) records a weight-1 'spec' wrong and pushes another card. recordEvidence and applyEvidence never de-duplicate by itemId. Scratch run: four records took P from .8 to .43, .156, .078 and .063. The spec frames the hidden failure as one transfer-failure event, and signature evidence is explicitly de-duplicated per code version.

## evidence-4: A concept that tests out earns production only from a clean spec green, so it can stay at P .8 'Learning' forever

- Lens: evidence. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/atoms/sprintSelect.ts:195`

**Failure scenario.** The atom ends PROBE → PROBE2 → 'tested-out' and never shows a completion. P stays capped at .8 because caps require production. The spec says the cap lifts on 'the task's first clean spec green on this concept, or a sprint completion'. No sprint tier asks for a completion for a concept that lacks production. itemFor always returns a predict while any fresh probe is in stock, and seeded keys are refilled to 6 unseen. Audits only cover concepts that are already mastered, which is circular. So any concept without a weight-1 spec green on it never reaches mastery: placement fundamentals no spec targets, concepts in tasks whose ladder is not applicable (DESIGN_DIFFERS, spec-less tasks), and concepts whose only spec took more than 3 saves. Such a concept is never Solid or Fluent and is never audited. A scratchpad run after a tested-out atom (P .800, production false) simulated 120 days of sprints answered correctly. It served only predicts and ended at P .800, production false, 8 groups, chip 'Learning'. A learner who does NOT know the concept gets production through UNKNOWN's completion, but one who knows it never does.

**Evidence.** stepMachine.ts:826-834: the probe / probe2 correct paths `return this.exit('tested-out')`, so no completion. sprintSelect.ts:194-198 `const probe = probes.find(...) ?? probes[0]; if (probe) return { kind: 'predict', ... }; const completion = freshCompletions(sel, c.id)[0];`. The completion is reached only when no probe is left. sprintSelect.ts:175-182 audits use `auditDue`, which requires masteredAt. evidence.ts:632-634 `earnsProduction`: completion, or spec with w >= 1.

**Suggested fix.** In itemFor (or in a dedicated tier ahead of due reviews), serve a completion when the concept is tested, capped by !c.production, and has a completion in stock. Alternatively, add a completion after PROBE2 tested-out when production is missing, as the spec's 'sprint completion' route intends.

**Verifier note.** Confirmed by code. stepMachine's probe and probe2 correct paths exit 'tested-out' without a completion. P stays capped at .8 until caps().ok holds, which includes production (evidence.ts:737). Only a completion or a spec green with weight >= 1 earns production (evidence.ts:633). In sprints, itemFor serves a completion only when no fresh probe is left (sprintSelect.ts:194-198). Seeded stock is refilled to unseen probes, so a fresh probe is effectively always there. Audits require masteredAt. No tier targets concepts missing production, even though spec line 200 names 'a sprint completion' as a way to lift the cap. Concepts with no clean spec green therefore never earn production. That includes a common case: a spec that needed more than 3 saves, which gives weight < 1.

## evidence-5: Concepts that share a seeded tag get no stock and no pack, yet coverage is measured against the seed atom they are never shown

- Lens: evidence. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/atoms/prefetch.ts:631`

**Failure scenario.** Case 1: the plan has two concepts on a seeded tag, such as 'count-words' and 'count-letters' on 'counting-with-dict'. upsertConcepts keeps them separate. Case 2: a migrated v0.1 concept 'loops' gains tag 'for-range-bounds' from the plan while the seed concept for that tag also exists. In either case Stock.cacheKeyFor returns undefined because the concept is not the tag owner. packCandidates skips the concept because its tag has seeds, despite the cacheKeyFor comment that such concepts 'get their own packs instead'. Placement, sprints and gate 'gap' atoms therefore have nothing to serve: openAtom returns 'unavailable' after a prepareConcepts call that does nothing. The rung-2 drill offer, the own-predict mismatch offer and onSignatureStuck likewise find no atom. CoverageIndex still falls back to the tag key, so the concept must avoid the seed atom's misconceptions. A scratchpad run gave required coverage ['increment-missing-key','assign-one-each-time','counts-dict-inside-loop'] for count-words, which no item will ever carry. The concept cannot reach mastery or get sprint reviews until the learner explicitly opens Teach or JIT, which builds a mini atom under the concept id.

**Evidence.** prefetch.ts:631 `if (tag !== OTHER_TAG && seeds?.hasSeeds(tag)) continue;` in packCandidates. stock.ts:351-353 `const owner = learner.concepts[tag] ?? (tagged.length === 1 ? tagged[0] : undefined); return owner === c ? tag : undefined;`. shell.ts:253 `const key = this.deps.has(lang, c.id) ? c.id : tag;`. Scratchpad check: packKey count-words, Stock.cacheKeyFor(count-words) = undefined, packCandidates([count-words, count-letters]) = [], and coverage is the 3 seed misconceptions.

**Suggested fix.** In packCandidates, skip seeded tags only when the concept owns the tag (packKey(learner,c) === tag). Separate plan concepts would then get their own pack under c.id. In CoverageIndex, use the cache key the concept is actually served from (Stock.cacheKeyFor), and require nothing when there is none.

**Verifier note.** Confirmed by experiment. With the seed concept 'counting-with-dict' and two plan concepts on that tag, upsertConcepts keeps them separate. packKey(count-words) = count-words, and packCandidates returned [] because of the hasSeeds skip at prefetch.ts:631. That contradicts the cacheKeyFor comment saying such concepts 'get their own packs'. cacheKeyFor returns undefined because the concept is not the tag owner, and cachedAtom finds nothing. openAtom in the 'gap' context then calls prepareConcepts, which does nothing, and returns 'unavailable'. CoverageIndex.coverage falls back to the tag key (shell.ts:253), so the concept must cover the seed atom's verified misconceptions, yet no item is ever served under its id. Only Teach/JIT miniAtom bypasses packCandidates.

## concurrency-1: Clicking Retry during a usage-limit pause runs onPlan twice, so the roadmap is duplicated and the current task is left out of it

- Lens: concurrency. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/coach.ts:758`

**Failure scenario.** 1. PlanOutline hits the Codex plan limit. planOutline's run calls onTrouble, which shows the card 'Roadmap failed: usage limit reached (...it retries after the pause)' with a primary Retry button. JobQueue.onError puts the priority-0 'plan' job back in the queue for one retry after the 15-minute pause.
2. The learner clicks Retry. retryPlan calls enqueuePlan, which calls jobs.bg('plan'). bg() dedupes onto the queued retry and pushes a second apply.
3. The pause ends and the retry succeeds, so onResult runs both applies. onPlan runs twice.
4. The second onPlan replaces p.milestones and calls addTasks again. Three new copies of the milestone-1 tasks are created.
5. The task the first onPlan started is no longer in any milestone. After the learner finishes it, nextRoadmapTask returns the duplicate 'Add a todo' and they build task 1 again. Each copy also gets its own TaskPrep and packs (budget), and 'Roadmap ready' is logged twice.

**Evidence.** jobs.ts:379-381 `if (genMatches(existing.spec.gen, spec.gen, spec.scope)) { if (apply) existing.applies.push(apply ...)`. jobs.ts:611 `if (e.priority <= 1 && !e.retried) { e.retried = true; e.state = 'queued'; this.queue.push(e);` keeps 'plan' in flight. coach.ts:754-758 retryPlan only checks `p.milestones.some((m) => m.taskIds.length)` and then calls `this.enqueuePlan(p)`. coach.ts:812-814 `p.milestones = (o.milestones ?? []).map(...)` and `this.addTasks(p, 0, ...)` have no guard against running twice. Repro: scratchpad/conc-rev-x7/retryplan.test.ts uses the real JobQueue and Coach (pause forced to end). Output: 'PlanOutline calls 2 | Roadmap ready cards 2 | tasks 6', roadmap = 3 todo copies, current = orphaned 'Add a todo (active)'.

**Suggested fix.** Make onPlan idempotent: return early when p.placement.planPending is false or milestone 1 already has tasks. Also have retryPlan do nothing while jobs.has('plan') is true, and say that the queued retry is pending.

**Verifier note.** Confirmed in code. The plan's run catches the limit error, calls onTrouble (planFailed: card with a primary Retry button, plus a 'Retry roadmap' extra in inputMode), then rethrows. JobQueue.onError re-queues the priority-0 'plan' entry (retried=false). retryPlan only checks for milestone tasks, so it goes on to enqueuePlan, and bg() dedupes onto the queued entry and pushes a second apply (jobs.ts:379-381). onPlan has no planPending or idempotency guard, so the second call replaces p.milestones and runs addTasks again. The repro with the real JobQueue and Coach shows 2 'Roadmap ready' cards, 6 tasks and an orphaned active task. The existing test (flow.test.ts:532) only covers a non-limit failure, where the job has already settled. My own experiment shows the same double apply with no usage limit at all: the stale 'Roadmap failed' card from concurrency-7 offers Retry while the re-enqueued plan is running, and clicking it gives 1 PlanOutline call, 2 'Roadmap ready' cards and 6 tasks.

## concurrency-2: A task switch or window reload while what-ifs are open leaves the task permanently impossible to complete

- Lens: concurrency. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/coach.ts:2157`

**Failure scenario.** 1. All specs and the hidden spec pass. criteriaMet sets t.criteriaMetAt and saves (debounced 300 ms).
2. It then awaits whatIfs, which includes lockFree (up to 5 min), WhatIfFlow.prepare running probes, and the InputBoxes.
3. The learner either clicks another task in the sidebar (abortActive closes the InputBox, and criteriaMet sees `this.task !== t` and returns), or reloads or closes VS Code while an InputBox is open.
4. When they come back to the task (startTask, or reconcile after the reload), specs re-attach and pass again. onHiddenResult calls criteriaMet, which returns at once because criteriaMetAt is set. checkWork/reviewWork also return because of criteriaMetAt.
5. completeTask never runs: the task stays 'active' forever, with no 'task' evidence, no follow-up and no automatic next task.

**Evidence.** coach.ts:2157-2158 `if (t.criteriaMetAt || t.status !== 'active') return; t.criteriaMetAt = this.now();`, then 2163 `const what = await this.whatIfs(t);` and 2164 `if (this.task !== t || t.status !== 'active') return;`. The only other readers of criteriaMetAt are guards (lines 1989 and 2117), and reconcile (line 982) never clears it. Repro: scratchpad/conc-rev-x7/strand.test.ts. Reload variant: 'after reload: status active ... current t1'. Switch-and-back variant: 't1 active building' after hidden passes again.

**Suggested fix.** Set a persisted completion marker only once completeTask or askExplainBack is actually reached. Alternatively, in criteriaMet (and in reconcile/beginTask on return), if criteriaMetAt is set but the task is still active, go on to completeTask or askExplainBack instead of returning.

**Verifier note.** Confirmed. criteriaMet sets t.criteriaMetAt (saved through changed()) before awaiting whatIfs, which runs lockFree and then the InputBoxes. On a task switch, it sees this.task !== t and returns. Nothing ever clears criteriaMetAt: it is written only at coach.ts:2158, and reconcile, normTask and beginTask's return path leave it alone. So when the learner comes back (beginTask's return branch, or reconcile after a reload or quit), the specs re-attach and pass, onHidden calls criteriaMet, and criteriaMet returns at once. checkWork and reviewWork also bail on criteriaMetAt. No other command (skip or mark done) calls completeTask. Quitting VS Code while a what-if InputBox is open is a very plausible trigger, and the task stays active forever.

## spec-2: Go, Java and Rust (offered in the language QuickPick) silently fall back to the v0.1 loop, but the onboarding copy, README and picker promise placement checks, practice and specs

- Lens: spec. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/coach.ts:727`

**Failure scenario.** A learner types 'learn golang by building a cli todo app', or picks Go in the 'Which language?' QuickPick, whose placeholder says 'The roadmap, practice and specs use this language'. runnableLang('go') is undefined, so nothing practice-related runs. There is no placement, although the onboarding said 'you answer ~10 quick predict-the-output checks in the editor. No essays.'. The 'Your roadmap is almost ready' card says 'Practice while you wait from the status bar if you like', but no sprint exists, so the status bar offers nothing. There is no spec ladder, so 'Check my work' is a foreground medium-effort LLM review that decides done. Teach is a foreground 120-word lesson card that ends with a predict question nothing can grade. What-ifs are unavailable, so every task ends with the free-text 'Explain it back' essay. The README never says these languages are limited.

**Evidence.** coach.ts:727-728 `const lang = runnableLang(language); const stocked = !!lang && !!this.deps.pad && !!this.deps.placement;`. runPlacement (883-892) marks placement done at once when there is no pad or placement. coach.ts:947 says 'Practice while you wait from the status bar if you like.'. offerWaitSprint returns early because sprintFor() is undefined. teach() → shortLesson() (1504-1518) uses `this.fg('Writing a short lesson', ... AnswerSchema ...)`. pickLanguage (2861) offers 'Go','Java','Rust'. media/main.js:160 'while you answer ~10 quick predict-the-output checks in the editor. No essays.'. README.md:14-16 has no language caveat. Checked with a scratch flow test (harness copied from test/flow.test.ts) calling startProject('learn golang by building a cli todo app'): language go, lang undefined, placement done with 0 pad runs, the feed shows 'Practice while you wait from the status bar', tempo actions [], practiceWhileWaiting false, and teach() made one foreground AnswerSchema call. docs/stage2-reports.md:211 records this as an internal deviation, but nothing user-facing does.

**Suggested fix.** Either remove Go/Java/Rust/Other from the picker and keyword table until the probes-only pack and neutral items exist for them, or make the copy honest. For non-runnable languages, the start card and README should say there is no placement, practice tab or specs, and the 'Practice while you wait' line should be dropped when sprintFor() is undefined. The spec's probes-only pack plus the 3 neutral items would at least restore placement.

**Verifier note.** I confirmed this. runnableLang (coach.ts:281) returns undefined for go, java and rust. extension.ts:386 builds a PlacementRun only for stocked languages, so runPlacement (coach.ts:883-892) marks placement done at once. pickLanguage (coach.ts:2861) still offers Go, Java and Rust with the placeholder 'The roadmap, practice and specs use this language'. The onboarding (main.js:160) and the README promise about 10 predict checks with no language caveat. afterPlacement (coach.ts:947) always says 'Practice while you wait from the status bar', and offerWaitSprint then returns early because sprintFor() is undefined. The spec requires neutral items plus a probes-only pack for these languages (spec 1498, 1584, 316). docs/stage2-reports.md:211 lists this as Not done, so it is a known internal gap, but nothing user-facing says so. One mitigation: the 'Designing your roadmap' start card is already honest, because it leaves out the placement sentence when the language is not stocked.

## spec-4: Results that land for a finished task go into that task's feed, which is never shown, so background grading feedback is invisible

- Lens: spec. Reported severity: major. Verified severity: major. Confirmed: yes.
- Location: `src/coach.ts:2755`

**Failure scenario.** The sidebar renders only the current task's feed. When a task completes, the next task starts at once, so cards pushed to the old task's feed are never shown: the 'Task complete' summary with per-concept state changes, the 'What-ifs N/M predicted right' card, and every background result that arrives later. Concretely, a learner with no runtime or consent, or with a conflict flag, writes the 'Explain it back' essay. answerExplainBack queues the background grade and immediately starts the next task. When the grade arrives, its 'Explanation: clear / partly there' card with the model's feedback goes into the finished task's feed, and the learner never sees it. The spec says async open-ended grading 'results arrive as a log card'. The opt-in Polish review has the same problem. The only way to read those cards is to click the done task in the Roadmap. That calls beginTask → abortFlows('task') and switches the current task away from the one being built.

**Evidence.** coach.ts:2755 `feed: (t ? t.feed : (p?.feed ?? [])).slice(-80)` (t = current task). completeTask pushes 'Task complete' into t.feed (2352-2355) and then calls `await this.beginTask(next)` (2367-2369). answerExplainBack: the bg apply pushes `this.logCard(..., [g.feedback], t.feed)` (2272) and `await this.completeTask(t)` runs right after enqueueing (2276). Checked with a scratch flow test (what-ifs 'unavailable', GradeSchema deferred until after submit): after the grade resolved, the visible feed was ["Task 2: Task 2","Plan it in your head"]. t1.feed held [..., "You","Task complete","Explanation: clear"].

**Suggested fix.** Push task-completion and late background results (explain-back grade, polish review, what-if summary, 'Follow-up added') into the feed that is visible when they land: the project feed, or the current task's feed with a 'from Task N' prefix. Alternatively, keep the last finished task's closing cards visible at the top of the next task's feed.

**Verifier note.** I confirmed this. The state's feed is `(t ? t.feed : p.feed)` for the current task only (coach.ts:2755), and main.js:286 renders only state.feed. completeTask pushes 'Task complete' into the finished task's feed and then calls beginTask(next), which switches currentTaskId and calls changed(). So the summary with the concept deltas is never shown. answerExplainBack pushes the background grade card into t.feed (coach.ts:2272) after completeTask has already moved on. polishReview does the same (it pushes into t.feed). beginTask carries no cards over from the previous task. Viewing them means clicking the done task in the Roadmap, which goes through beginTask → abortFlows('task') and makes the done task current. The spec says async grading results 'arrive as a log card'.

## flow-4: A v0.1 task saved in the mid-task 'Lock it in' explain-back is marked complete when the learner answers or skips

- Lens: flow. Reported severity: major. Verified severity: minor. Confirmed: yes.
- Location: `src/coach.ts:350`

**Failure scenario.** In v0.1, gotIt() after a hint set `phase='explain-back', resumePhase='building'` with the question 'what was the problem, and why does your fix work?'. This was a mid-task check, and v0.1 went back to building afterwards. A learner who upgrades with a task saved in that state gets the v0.2 explain-back composer (Submit/Skip). answerExplainBack and skipExplainBack call completeTask. The unfinished task is marked done, recordSolve credits its concepts, 'Task complete' is shown, and the next task starts.

**Evidence.** v0.1 bundle (deliberate-coach-0.1.0.vsix): `gotIt(){let r=this.task;r&&(r.phase="explain-back",r.resumePhase="building",r.explainBackQuestion="In one or two sentences: what was the problem, and why does your fix work?" ...`. v0.2 normTask migrates only pendingCheck and leaves 'explain-back' untouched. skipExplainBack: `if (!t || t.phase !== 'explain-back') return; ... await this.completeTask(t);`. Scratch test S4: after normProject and reconcile the mode is 'explain-back'. skipExplainBack -> t1 'done', next task current, 1 'task' evidence record.

**Suggested fix.** In normTask (or normProject), map the legacy state `phase === 'explain-back' && resumePhase === 'building' && !criteriaMetAt` back to 'building' and clear explainBackQuestion and resumePhase.

**Verifier note.** Confirmed from the v0.1 vsix bundle. v0.1 gotIt set phase='explain-back' with resumePhase='building', and v0.1 answerExplainBack returned to building when resumePhase==='building'. Both versions use the same workspaceState key 'deliberate.project.v1', so v0.1 projects load in v0.2. normTask migrates only pendingCheck, reconcile leaves 'explain-back' alone, and v0.2 answerExplainBack/skipExplainBack always call completeTask. Real, but it only affects a one-time upgrade with a task saved in that exact state, so I downgraded it to minor.

## flow-6: TaskPrep run while no runner is available (consent 'Not now', untrusted workspace, runtime not yet found) permanently stores a non-applicable ladder; granting consent later never brings specs back

- Lens: flow. Reported severity: major. Verified severity: minor. Confirmed: yes.
- Location: `src/atoms/prefetch.ts:566`

**Failure scenario.** The learner chooses 'Not now' on the consent modal, or works in an untrusted workspace. snippetRunner is undefined, so verifyLadder returns notApplicable('no runtime for the spec harness'). onPrep stores it as t.spec and prep becomes 'done' for tasks 1-3 (and every trio prepared ahead). The learner then grants consent (chooseExecution) or trusts the workspace. reattachSpecs returns early because `!last.task.spec?.applicable`. prepTasks filters out tasks that already have a spec, so neither the next task start nor a reload re-prepares them. These tasks never get a spec ladder and fall back to LLM Check my work.

**Evidence.** prefetch.ts verifyPrep: `const runner = this.deps.runner(input.runLang); ... const v = await this.deps.specs.verifyLadder(draft, t.interface!, { runner, ... }); r.spec = specState(v);`. specs.ts: `if (!o.runner) return notApplicable('no runtime for the spec harness');`. coach.ts prepTasks: `tasks.filter((t) => ... !t.gate && !t.spec && t.prep?.state !== 'done' ...)`. extension.ts reattachSpecs: `if (!last.task.spec?.applicable || ...) return;`. Scratch test S11: t1 and t2 spec applicable=false; after the runner appears, reconcile and startTask('t2') make 0 TaskPrep calls and specs stay non-applicable.

**Suggested fix.** Do not persist a spec state whose only failure is a missing runner or consent. Leave t.spec unset and set prep to 'failed' with that reason, so prepTasks retries. Alternatively, on applyExecution(snippets became true), clear such specs and re-run prepTasks for the current and upcoming tasks.

**Verifier note.** verifyLadder returns notApplicable when there is no runner. With snippets-only consent or an untrusted workspace, the inner verifyLadder also returns notApplicable ('running your code is off'). onPrep stores that as t.spec. prepTasks filters out tasks that have t.spec, reconcile does the same, and reattachSpecs bails on `!last.task.spec?.applicable`. Granting consent or trust later therefore never brings specs back for tasks prepared before then. Real, but downgraded to minor: it affects only the 3-4 tasks prepared before consent, and Check my work falls back to the LLM review, so nothing gets stuck.

## flow-7: Rung-4 skeleton holds the InteractionLock with no deadline; at task end criteriaMet silently waits up to 5 min before completing

- Lens: flow. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/coach.ts:2210`

**Failure scenario.** Rung 4 opens the skeleton in the pad with 'fill the ___ here, then write it in your own file'. Keeping that tab open as a reference while typing the real code is natural. padSkeleton loops on `s.next()` with no deadline, so the lock stays held. When every spec then passes, criteriaMet flashes 'Every behaviour passes' and blocks in lockFree() for up to 5 minutes, with the task still shown as active and nothing explaining why. The what-ifs then return 'busy', so they are skipped anyway. A task switch during that wait leads to the stuck state in F1. Gate, JIT atom, own-predict and sprint flows are also all 'busy' while the tab is open.

**Evidence.** padSkeleton: `for (;;) { const i = await s.next(); if (i.type === 'continue' || i.type === 'submit' || i.type === 'abort') break; ... }` with no deadline (PadSession.next arms a timer only when a deadline is given). whatIfs: `await this.lockFree();` -> `lockFree(maxMs = 5 * MIN)`. WhatIfFlow: `if (!release) return { status: 'unavailable', reason: 'busy', ... }`.

**Suggested fix.** Give the skeleton session an idle deadline or release the lock once it is shown (it records nothing). In criteriaMet, abort a 'skeleton' holder (or skip the what-ifs) instead of waiting, or at least flash why it is waiting.

**Verifier note.** padSkeleton loops on s.next() with no deadline and ends only on continue/submit/abort/Esc-Esc or when the tab is closed. Nothing closes it on focus loss. InteractionLock has no preemption. whatIfs awaits lockFree() for up to 5 minutes, then WhatIfFlow returns 'busy', which maps to 'later', and completeTask runs. So completion is silently delayed by up to 5 minutes while the skeleton tab stays open.

## flow-8: Rung 4 while another modal flow holds the lock: the card says the skeleton is open in the pad, its code is stripped, and the pad never opens

- Lens: flow. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/coach.ts:1849`

**Failure scenario.** A sprint (Ctrl+Alt+S) or another lock holder is open while the task is building. The learner asks for the next hint, or 'auto' mode serves it at stuck >= 1, and it reaches rung 4. The rung is fetched and recorded (rung 4 counts as served), and the card is pushed with the fenced code removed and the text 'The skeleton is open in the practice tab'. pad.acquire('skeleton') then fails and skeletonRung returns silently. The skeleton is never shown, and the next hint jumps to rung 5.

**Evidence.** `const inPad = !!(lang && pad && this.deps.skeleton && code.includes('___'));` is computed without checking the lock. The card html is `inPad ? `${r.hint.replace(/```[\s\S]*?```/g, '').trim() ...}\n\n_The skeleton is open in the practice tab..._` : r.hint`. Then `const release = pad!.acquire('skeleton'); if (!release) return;`. Scratch test S8: card body '<p>Fill it:</p> <p><em>The skeleton is open in the practice tab...</em></p>', 0 skeletons opened, rung 4 recorded.

**Suggested fix.** Acquire the lock before building the card. If it is busy, show the code in the card, or enqueue a blocking tempo action that opens the skeleton when the lock frees.

**Verifier note.** inPad is computed without checking the lock, and the card is pushed with the code stripped before pad.acquire('skeleton') fails. A sprint can run while building, and the Ctrl+Alt+H keybinding has no when clause. Experiment (lock held by 'sprint', rung 4): 0 skeletons opened, rung 4 recorded, card body 'Fill it: ... The skeleton is open in the practice tab'.

## flow-9: completeTask waits up to 20 s for a pending follow-up without rendering, so the finished task still looks active and its actions do nothing

- Lens: flow. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/coach.ts:2359`

**Failure scenario.** Weakest concept P < .6, so a FollowUp call starts at criteriaMet. The what-ifs finish quickly ('skipped', or one or two answers) while the medium-effort FollowUp is still running. completeTask sets status/phase 'done' and pushes 'Task complete', then awaits the follow-up for up to 20 s without calling changed(). The sidebar keeps showing the task as current in building mode, with no 'Task complete' card. Check my work and hint silently return because the status is no longer 'active'.

**Evidence.** completeTask: `t.status = 'done'; t.phase = 'done'; ... this.push({ kind: 'info', title: 'Task complete', ... }); ... if (fu) await settleOrTimeout(fu, this.deps.delays?.followUpWaitMs ?? COACH.followUpWaitMs);` with no this.changed() before the await. Scratch test S7 (wait 400 ms): at 300 ms t1 is 'done' but 0 change events carried a done status (last view 'active/building'); 3 arrived only after the wait.

**Suggested fix.** Call this.changed() (and flash 'Task complete · next task in a moment') before awaiting the follow-up.

**Verifier note.** push() does not call changed(), and completeTask awaits settleOrTimeout(fu, 20s) without calling changed() first. specs.detach also emits nothing. Experiment: at 20 ms t1 is 'done' but the change events seen so far report only 'active'. The 'done' events arrive only after the follow-up wait. The view is stale for up to 20 s.

## flow-10: A TaskPrep that lands after the learner left the task is marked failed and never requested again when they return (no specs or gate for that task until a reload)

- Lens: flow. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/coach.ts:1055`

**Failure scenario.** The learner starts a task whose TaskPrep is still running, switches to another task, and the prep lands. onPrep marks it failed with 'landed after a task switch'. The comment says it is prepared again on return, but beginTask's returning path only calls attachSpecs. With t.spec unset that does nothing, and no prepTasks call is made. The task runs without a spec ladder unless the window is reloaded.

**Evidence.** onPrep: `if (t.status !== 'todo' && !current) { t.prep = { state: 'failed', at: this.now(), reason: 'landed after a task switch' }; ... continue; }`. beginTask: `if (t.status !== 'todo') { if (t.status === 'active' && t.phase !== 'done') { ...; await this.attachSpecs(t, false); } this.changed(); return; }` has no prepTasks. Scratch test S9: on return, t1 prep 'failed', spec false, 0 new TaskPrep calls, specs not attached.

**Suggested fix.** In beginTask's returning path, call `if (!t.spec && !this.prefetcher.prepInFlight(t.id)) this.prepTasks([t], now + 30_000)`.

**Verifier note.** onPrep marks the prep 'failed' for a task the learner left. beginTask's returning path calls only attachSpecs, which needs t.spec, and has no prepTasks call. Only reconcile (on reload) prepares it again. Experiment: after switching away and back, 0 new TaskPrep calls, no spec, nothing attached. The existing flow test asserts 'failed' with the comment 'reconcile prepares it again on return', but never tests the return itself.

## flow-11: Reconcile never starts a task when the roadmap exists but no task is current (v0.1 project saved mid-diagnostic; reload during placement after the plan landed; reload during the follow-up wait)

- Lens: flow. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/coach.ts:961`

**Failure scenario.** Case 1: a v0.1 project saved mid-diagnostic loads with every milestone filled and no currentTaskId. normProject marks placement done, and reconcile only preps tasks. No task starts, the dead v0.1 'Placement n/8' question cards remain in the feed, and the composer is 'ask' with only Sprint. Case 2: a v0.2 reload during placement after the plan landed. Task 1 starts only by accident about a minute later, when the milestone-2 TaskBatch lands (onBatch -> beginNext), and never if that batch fails or there is only one milestone. Case 3: a reload during completeTask's follow-up wait leaves the current task 'done' with the next one never started.

**Evidence.** reconcile: `} else if (!p.placement.done) { p.placement.done = true; ... }` and later `const cur = this.task; ... if (cur && cur.status === 'active') {...}`. There is no beginNext when cur is undefined or done and a todo task exists. Scratch test S12: current task undefined, inputMode 'ask' ['sprint'], 0 TaskBatch calls.

**Suggested fix.** At the end of reconcile, if the project has tasks and placement is done but there is no active current task, run `void this.track(this.beginNext())`, the same as onPlan and afterPlacement do.

**Verifier note.** reconcile marks placement done but never calls beginNext when no active current task exists and todo tasks do. Experiment (roadmap present, placement.done=false, reload): current task undefined, mode 'ask' with only 'sprint', 0 batch calls. The v0.1 bundle confirms that v0.1 built the roadmap before the diagnostic. Kept at minor because the learner can still start a task by clicking its roadmap row.

## flow-12: guideApproach ('2 flawed plan picks in one task') can never fire

- Lens: flow. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/gate.ts:252`

**Failure scenario.** The spec says 2 flawed picks in one task show the background 'How to think about this task' card. GateUi runs step B once per gate and always passes flawedPicksThisTask: 0. gradePlanPick computes `0 + 1 >= GATE.flawedPicksForGuide (2)`, which is always false, so coach.guideApproach() is unreachable.

**Evidence.** gate.ts: `gradePlanPick(plans, idx, { ..., priorFlawedTasks: opts.priorFlawedTasks ?? 0, flawedPicksThisTask: 0 })`. gateCore.ts: `guideApproach: (ctx.flawedPicksThisTask ?? 0) + 1 >= GATE.flawedPicksForGuide` with `flawedPicksForGuide: 2`. coach.ts gateDone: `if (res.guideApproach) this.guideApproach(t);`.

**Suggested fix.** Count flawed picks per task (for example on Task.gate.result) and pass them in. Or define the trigger as a flawed plan pick plus missed required patterns, so a single gate run can reach it.

**Verifier note.** GateUi.steps hard-codes flawedPicksThisTask: 0, and gradePlanPick computes guideApproach as (0)+1 >= GATE.flawedPicksForGuide (2), which is always false. Step B runs at most once per gate run, so coach.guideApproach() can never be reached from the gate. This is dead functionality that contradicts the documented '2 flawed picks in one task' behaviour.

## pad-5: What-if asks the learner to predict a change that may not be on screen

- Lens: pad. Reported severity: major. Verified severity: minor. Confirmed: yes.
- Location: `src/owncode.ts:1170`

**Failure scenario.** Mutants come from every line the call exercises, including helper functions elsewhere in the file (exercisedLines follows callees). Example: when the specs go green, the struck-through line is in a helper 60 lines below the viewport, or in todo.py while the learner is in cli.py, or the learner pressed Check my work from the sidebar. The InputBox 'With this change, total([4, 5, 6]) -> ?' opens, but the strike-through and the 'what if: ...' after-text are on a line or file that is not visible, and the title never says what changed. The learner answers blind, and the answer is recorded as what-if evidence with misconception attribution.

**Evidence.** owncode.ts:1170-1176: `this.deps.strike.show(w.uri, cand.line, ...); this.deps.annotations.set({ uri: w.uri, line: cand.line, source: 'what-if', text: `what if: ...` }); const answer = await this.deps.ask.ask({ title: whatIfTitle(w.callExpr), prompt: PREDICT_PROMPT }, ac.signal);`. whatIfTitle (owncode.ts:1026) is `With this change, ${callExpr} -> ?`. Nothing reveals or opens the document. Compare hints.ts:767, where HintDisplay calls `this.host.reveal?.(doc.uri, line)`. owncode.ts:552-558: exercisedLines queues callee functions.

**Suggested fix.** Before asking, open or reveal w.uri at cand.line (showTextDocument with selection/revealRange InCenter, preserveFocus true). Also put the mutated line in the InputBox title or prompt, e.g. 'If line 12 read `total += x * 2`: total([4,5,6]) -> ?'.

**Verifier note.** Confirmed. WhatIfFlow.run calls strike.show, which decorates only visible editors (VscodeStrike.apply), then annotations.set, then ask.ask. Nothing reveals or opens w.uri at cand.line. The InputBox title is only 'With this change, <call> -> ?', and the mutated line appears only in the hover. exercisedLines follows callees, so the line can be off-screen. Lowered to minor: the learner usually has the file open just after saving, and the 'Later' button gives a neutral way out.

## pad-6: Traceback items: typing '?' for 'no idea' over the preselected template is treated as an empty answer

- Lens: pad. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/atoms/render.ts:548`

**Failure scenario.** A sprint traceback item renders `# -> line ?, ?` with the first '?' selected. The learner does not know and types '?', as the re-prompt suggests. The line still reads `line ?, ?`, which parses as empty, so they get 'type line N, ExceptionName (or ? for no idea)' again. Typing '?' once more gives `line ??, ?`, also empty. The only way to answer 'don't know' is to delete the whole template by hand.

**Evidence.** render.ts:548-554: `const body = answer ?? 'line ?, ?'; ... r.answerColumn = q; r.answerSelectEnd = q + 1;`, which selects the first '?'. grade.ts:384-386: `if (t === '?') return { ..., dontKnow: true }` only matches a bare '?'. pad.ts:1404-1406: empty → `'type line N, ExceptionName (or ? for no idea)'`. Scratch run: replacing the selected '?' with '?' gives answer text "line ?, ?", which parses to `{ empty: true, dontKnow: false }`.

**Suggested fix.** Treat an answer whose only non-template content is '?' (for example `line ?, ?` that the learner changed, or any answer matching /^line\s*\?+,\s*\?$/ after a submit with a typed '?') as don't-know. Or select the whole 'line ?, ?' template so typing replaces it, or render an empty answer with the template as a placeholder decoration.

**Verifier note.** Confirmed. renderTraceback selects the first '?' of 'line ?, ?'. Typing '?' over it leaves 'line ?, ?'. parseTracebackAnswer gives dontKnow only for a bare '?'. 'line' is excluded from the name words and there is no digit, so the result is empty, and askTraceback re-prompts 'type line N, ExceptionName (or ? for no idea)'. The tests miss this because MemoryPadEditor.answer() clears the template first.

## pad-7: Esc Esc does not leave completion or traceback items, and the first Esc breaks Tab between blanks

- Lens: pad. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `package.json:436`

**Failure scenario.** On a fresh completion, insertSnippet leaves the editor in snippet mode with the first ___ selected. Esc #1 runs the built-in leaveSnippet, Esc #2 runs cancelSelection, and only Esc #3 and #4 reach deliberate.atomEscape. On a traceback item the '?' is preselected, so it takes three presses. A learner who presses Esc Esc (which the pad itself advertises: 'cannot run code here (Esc Esc to leave)') sees nothing happen except that Tab no longer moves between blanks.

**Evidence.** package.json:436 when-clause for deliberate.atomEscape: `... && !inSnippetMode && ... && !editorHasSelection && !editorHasMultipleSelections`. padfs.ts:296 `ed.insertSnippet(sn, new vscode.Position(0, 0), ...)` (snippet mode, placeholder selected). render.ts:553-554 `r.answerSelectEnd = q + 1`, and padfs.ts:309 `ed.selection = new vscode.Selection(a, b)`. pad.ts:1094 `note = 'cannot run code here (Esc Esc to leave)'`.

**Suggested fix.** Drop !inSnippetMode and !editorHasSelection from the atomEscape when-clause. AtomPad.escape can leave snippet mode itself (executeCommand('leaveSnippet')) and still count the press. Or count the built-in Esc presses through a context key set while the pad awaits input.

**Verifier note.** Confirmed. The atomEscape when-clause excludes inSnippetMode and editorHasSelection. A completion is inserted through insertSnippet with the first ___ placeholder selected, and a traceback preselects '?'. The built-in leaveSnippet and cancelSelection therefore take the first presses, so Esc Esc does nothing visible except leave snippet mode, and Tab between blanks stops working.

## pad-8: Ctrl+Z gets past the assisted-insert guard after a discard

- Lens: pad. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/atoms/pad.ts:620`

**Failure scenario.** The learner pastes an output they got by running the code elsewhere, e.g. "['apple', 'fig', 'pear']", and presses Ctrl+Enter. The answer is discarded with 'looked auto-inserted: not counted' and the item is repainted empty. They press Ctrl+Z, which undoes the coach's repaint and brings the pasted answer back, wait a few seconds, and press Ctrl+Enter. It is graded correct, not as a guess, with valid latency. Scratch run with MemoryPadEditor: `graded: correct correct: true latencyValid: true implicit: false guess: false`. This contradicts the comment 'so the pasted text cannot simply be resubmitted'.

**Evidence.** pad.ts:620-625 onLearnerChange: `if (change.undoRedo) { if (frameOf(...) !== frameOf(r.text, ...)) this.paint(r, true)...; return; }`. frameOf (pad.ts:207-215) excludes answer lines, so a restored answer never triggers a repaint, and undo never sets `this.assisted`. padfs.ts:282: the repaint is `ed.edit(... replace ..., { undoStopBefore: true, undoStopAfter: true })`, so a single Ctrl+Z reverts it. padfs.ts:394: `undoRedo: e.reason !== undefined`.

**Suggested fix.** Record the discarded answer text. In onLearnerChange for undo/redo, or in submit, set assisted when the answer lines equal the discarded text again. Or make the assisted repaint a non-undoable step (undoStopBefore: false so it merges with the paste).

**Verifier note.** Confirmed by reading the code. The assisted repaint is setText, i.e. ed.edit replace with undoStopBefore/After true, so it is its own undo step. Ctrl+Z fires onDocChange with reason set, which gives undoRedo=true. onLearnerChange then compares frameOf, which ignores answer lines, so it neither repaints nor sets this.assisted. The next submit is graded normally, with a latency clock restarted at the discard. Low impact, since retyping by hand also gets past the guard.

## pad-9: Snippet renders take focus even though ensureEditor uses preserveFocus, e.g. when the escalation lesson arrives

- Lens: pad. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/atoms/padfs.ts:296`

**Failure scenario.** An atom escalates and the pad shows 'preparing a short lesson... (~10 s)'. The learner switches to their code or the terminal and starts typing. When the lesson job lands, showEscalate renders a lesson plus a completion as a snippet. TextEditor.insertSnippet focuses the pad editor on the main thread (MainThreadTextEditor.insertSnippet sets the selection and calls this._codeEditor.focus()), so the keystrokes the learner is still typing land in the pad's blanks.

**Evidence.** padfs.ts:228-235 ensureEditor deliberately uses `showTextDocument(this.doc, { ..., preserveFocus: true })`, but padfs.ts:294-296 then calls `await ed.insertSnippet(sn, new vscode.Position(0, 0), ...)`. stepMachine.ts:711-716 onLesson → showEscalate renders `{ kind: 'escalate', lesson, completion }` asynchronously, posted from pad.ts:1116-1119 when the lesson promise resolves. render.ts:536 `return renderCompletion(completion, ctx, block)` is a snippet render.

**Suggested fix.** When the pad is not the focused editor at render time, insert the completion text with TextEditor.edit and placeholders shown as decorations (or defer insertSnippet until the pad regains focus via onDidChangeActiveTextEditor). Or only render asynchronous results such as the lesson after the learner presses Ctrl+Enter.

**Verifier note.** Confirmed against the installed VS Code bundle. MainThreadTextEditor's insertSnippet calls this._codeEditor.focus() before snippetController.apply. VscodePadEditor.insertSnippet calls ed.insertSnippet even though ensureEditor used preserveFocus:true. The escalation lesson arrives asynchronously (onLesson then showEscalate) and renders through renderCompletion as a snippet, so it takes focus. Keystrokes land in the in-memory pad, not in the project.

## pad-10: Out-of-date practice tab stays open after a keepOpen wait sprint when the drill it was waiting for never arrives

- Lens: pad. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/atoms/coach.ts:1427`

**Failure scenario.** Outside the building phase, the learner clicks Teach me on a concept without a cached atom. The mini-atom job runs and an auto 'wait' sprint opens with keepOpen: true. The job fails or produces no atom, so openAtom pushes 'No practice for X yet' and returns. The pad tab stays open beside the code with the last sprint item and its feedback, no flow is running, and nothing ever closes it. The same happens when the learner chose Leave practice or Esc Esc during that sprint: the tab stays open.

**Evidence.** coach.ts:1427-1432 atomForTeach: `else await this.fgWithSprint(..., { learnerStarted: true, atomFollows: true }); ... return this.cachedAtom(lang, c.id);`. coach.ts:1638 `runSprint(s, { reason: 'wait', until: p, ...(o.atomFollows ? { keepOpen: true } : {}) })`. sprint.ts:443-444 `if (!opts.keepOpen || aborted) await pad.closeSession(); else await pad.session?.hold();`. coach.ts:1399-1402 on a missing atom only pushes an info card and returns 'unavailable'; there is no closeSession.

**Suggested fix.** In openAtom/atomForTeach, call pad.closeSession() whenever the atom will not run after a keepOpen sprint (missing atom, error, or a 'deferred' result). Also close it when the sprint stopped with 'esc' (the learner chose to leave).

**Verifier note.** Confirmed. fillWait runs runSprint with keepOpen:true when atomFollows is set. sprint.finish then holds the pad instead of closing it unless the sprint was aborted. When the mini-atom job fails or yields no atom, openAtom only pushes 'No practice for X yet', and the coach never calls closeSession outside padSkeleton. The tab stays open with a stale sprint item until the learner closes it. The Esc sub-claim is overstated: if the atom does land, it runs in that same tab.

## pad-11: 'running...' note stays on the first blank after a completion fails on another line

- Lens: pad. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/atoms/pad.ts:1091`

**Failure scenario.** In an atom completion, the learner submits and 'running...' is shown on the first blank's line. The check fails on a different line: a crash in a later line, or a tagged wrong fill in blank 2 of a two-blank completion. The failure message goes on that other line, and 'running...' stays on blank 1 for the whole retry, so it looks as if the check is still running.

**Evidence.** pad.ts:1091 `ctx.session.feedback({ kind: 'note', text: 'running...' }, 'answer', 0);` (the answer target resolves to render.answerLine = blankLines[0]). stepMachine.ts:986-988: `const target = grade.crashLine !== undefined && !grade.checkFailed ? { line: grade.crashLine } : blankTarget(grade, blank); this.feedback({ kind: 'check', ... }, target);`. pad.ts:486 addFeedback only replaces decorations on the same line: `this.fbDecos = [...this.fbDecos.filter((x) => x.line !== line), d];`. Retry keeps phase 'show' with no new render (stepMachine.ts:989-993).

**Suggested fix.** Remove the 'running...' note decoration when the grade arrives (for example, clear all 'note' feedback decorations before adding the check feedback, or give 'running...' its own transient slot).

**Verifier note.** Confirmed. gradeAtomCompletion posts 'running...' on target 'answer', which resolves to render.answerLine = blankLines[0] when there are no '# ->' lines. A failure goes to crashLine or to blankTarget(grade, wrongFillBlank). addFeedback filters out only decorations on the same line, and a retry keeps phase 'show' with no new render, so the 'running...' note stays on blank 1.

## evidence-6: gotIt() is not idempotent: after a Reveal it re-records the last rung's hint evidence

- Lens: evidence. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/coach.ts:1887`

**Failure scenario.** At the last rung (5) the learner clicks 'Reveal...'. reveal() records weight-1 wrong evidence on the hint concepts. The only action on the resulting 'Revealed' card is 'I got it', which calls gotIt(). t.hints' last entry is still rung 5, so gotIt records rung-5 evidence a second time: .5 wrong on the diagnosed concepts plus .5 wrong on 'decomposition'. One reveal therefore counts as two answers. Clicking 'I got it' on any earlier hint card, whose button persists in the feed, also records the latest rung again.

**Evidence.** coach.ts:1885-1887 `if (last && last.rung >= 1) { ... recordHintEvidence(this.learner, t.id, last.rung, ...) }`. There is no record of which hint was already credited. coach.ts:1924-1928: reveal() calls `recordHintEvidence(this.learner, t.id, 'reveal', ...)`, then pushes a card with `actions: [{ label: 'I got it', command: 'gotIt', primary: true }]`. media/main.js:278-281 renders actions as permanent buttons.

**Suggested fix.** Mark the hint as credited (for example t.hints[i].gotItAt, or a task-level 'creditedRung') and skip gotIt evidence when the latest hint was already credited or a reveal happened after it.

**Verifier note.** Confirmed. gotIt (coach.ts:1880-1888) records recordHintEvidence for the last hint's rung on every call and keeps no record of what was already credited. The Reveal card's only action is 'I got it' (coach.ts:1928). reveal() has already recorded weight-1 reveal evidence, so gotIt adds rung-5 evidence on top: .5 on the diagnosed concepts and .5 on decomposition. Buttons stay in the feed (main.js actionsHtml), and the hint hover link (deliberate.gotIt) is another way in, so repeated clicks re-record. learner.ts:427 describes the evidence as 'by the rung that unblocked the learner', which after a reveal is the reveal.

## evidence-7: Merging into an untagged tag owner never sets its tag, so coverage is silently dropped

- Lens: evidence. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/learner.ts:285`

**Failure scenario.** A v0.1 profile contains a model-made concept whose id equals a seed tag, such as 'list-slicing' (no tag, P .7, attempts 2). The same happens to a task conceptId created without a tag at coach.ts:838. placementRun.ensureSeedConcepts and onPlan's seedTags both skip the tag because concepts['list-slicing'] already exists. The plan concept {id:'slice-the-rows', tag:'list-slicing'} then takes the alias branch into it, and that branch sets only kind, never tag. In a scratchpad run, concept('slice-the-rows') resolves to 'list-slicing' with tag undefined. Seed items are still served (the cache key equals its id), but CoverageIndex returns [] for an untagged concept and taxonomy beliefs and priors are not found. Mastery is then granted without the coverage condition.

**Evidence.** learner.ts:284-290 `const owner = tag && id !== tag ? tagOwner(learner, tag) : undefined; if (owner && perTag.get(tag!) === 1) { addUnique(owner.aliases, id); ...; if (!owner.kind && c.kind) owner.kind = c.kind; touch(owner, now); continue; }`. There is no `owner.tag ??= tag`. tagOwner at line 254 returns `learner.concepts[tag]` regardless of its tag. shell.ts:250 `if (!tag || tag === 'other' || !tagInfo(tag)) return [];`.

**Suggested fix.** In the alias branch set `owner.tag ??= tag`. Also, in ensureSeedConcepts or onPlan, backfill tag = id on existing concepts whose id is a taxonomy tag.

**Verifier note.** Confirmed by experiment. migrateLearner does not backfill tags. After upsertConcepts with {id:'slice-the-rows', tag:'list-slicing'}, an untagged existing 'list-slicing' gained the alias but kept tag undefined. The alias branch (learner.ts:285-290) never sets owner.tag, unlike the existing-concept branch (`existing.tag ??= tag`). ensureSeedConcepts and the onPlan seedTags both skip because the concept id already exists. CoverageIndex returns [] for an untagged concept (shell.ts:250), so mastery skips the coverage condition, and taxonomyEntry finds no beliefs. It needs a v0.1 profile or an earlier untagged task conceptId, which is why the severity is minor.

## concurrency-3: Errors in nested repair calls, including usage limits, are swallowed: the concept is marked probeable=false for good and the background lane never pauses

- Lens: concurrency. Reported severity: major. Verified severity: minor. Confirmed: yes.
- Location: `src/atoms/prefetch.ts:729`

**Failure scenario.** 1. A background AtomPack's first round produces no verifiable atom for a concept.
2. The low-effort repair call fails with LlmError kind 'limit' (a Codex plan limit or an Anthropic 429). A Codex timeout or crash has the same effect.
3. buildPack logs 'pack repair failed' and carries on as if the second round had run. It sets `c.probeable = false` on the learner profile. Nothing ever resets this, so packCandidates and refillLowStock skip the concept in every future project.
4. The limit error never reaches JobQueue.onError, so hitLimit/pause never fires and other queued jobs keep starting against the exhausted plan.
5. TaskPrep has the same pattern: verifySpecLadder catches the repair error and drops the failing specs. If fewer than 3 survive, t.spec is stored with applicable=false. prepTasks filters on `!t.spec`, so that task never gets a ladder.

**Evidence.** prefetch.ts:720-731 `if (r.needsRepair ...) { try { const fixed = await this.deps.llm.json(... effort: 'low' ...) ... } catch (err) { if (signal.aborted) throw err; this.log(`[prefetch] pack repair failed...`); } }`, then 740-746 `if (accepted.has(c.id)) continue; c.probeable = false;`. specsCore.ts:1481-1486 `try { fixed = await deps.repair(failures, deps.signal); } catch (e) { if (deps.signal?.aborted) throw e; deps.log?.(`verify: repair failed...`) }`. The only writes to probeable are prefetch.ts:744 (false) and learner.ts defaults. Repro: scratchpad/conc-rev-x7/packlimit.test.ts. Output: calls [AtomPackSchema/medium, AtomPackSchema/low], probeable false, paused 0, budget used 1.

**Suggested fix.** In both repair catches, rethrow when isLimitError(err), so the job errors, the queue pauses and the job is retried. Only set probeable=false when the second verification round actually ran and failed, not when the repair call itself failed.

**Verifier note.** Confirmed. buildPack's repair catch (prefetch.ts:729) and verifySpecLadder's repair catch (specsCore.ts:1483) swallow every error except an abort, including LlmError 'limit' and Codex timeouts. buildPack then sets c.probeable=false. The only writes are that line and the learner defaults, so the flag persists across projects, and packCandidates and refillLowStock skip the concept. JobQueue.hitLimit is the only pause path, so this error does not pause the lane. Downgraded to minor: the next background job that hits the limit pauses the lane anyway, and Teach/JIT still build a foreground mini atom for a non-probeable concept (miniAtom only skips queueing the full pack). TaskPrep's fallback is applicable=false and the model review.

## concurrency-4: A hint the learner asks for, which dedupes onto a queued speculative ladder, can hang for the 15-minute pause and block the hint button

- Lens: concurrency. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/atoms/prefetch.ts:927`

**Failure scenario.** 1. At stuck 0.6, a speculative HintLadder (priority 2) is queued waiting for a slot, because another speculative or refill job holds the speculative slot.
2. The learner presses Ctrl+Alt+H. onDemandHints dedupes through jobs.bg with priority 0, and bg() lowers the queued entry's priority to 0.
3. The job starts and gets a 'limit' error (for example an Anthropic 429 'Wait a moment and retry'). Because its priority is now 0, onError queues it for a retry after LIMIT_PAUSE_MS.
4. onDemandHints keeps awaiting that promise, and never falls back to the on-demand fg call. hintFlight stays set, so every further hint press returns the same pending promise, and maybeOfferHelp is suppressed. The learner gets no hint and no error for 15 minutes.

**Evidence.** prefetch.ts:927-930 `await this.deps.jobs.bg<HintLadder>({ key, priority: 0, ... run: () => Promise.reject(new Error('dedupe only: never runs')) });`. jobs.ts:383-384 `if (existing.state === 'queued') { existing.priority = Math.min(existing.priority, spec.priority)`. jobs.ts:611 `if (e.priority <= 1 && !e.retried) { ... this.queue.push(e); ... return; }`. coach.ts hint(): `if (this.hintFlight?.taskId === t.id) return this.hintFlight.p;`. Repro: scratchpad/conc-rev-x7/hinthang.test.ts (manual clock, concurrency 1). Output: 'after the limit error: hint done? false fg calls 0 ... pausedUntil-now 900000'. The fg fallback ran only after the 15 minutes were advanced.

**Suggested fix.** Do not let the dedupe raise a speculative job's priority. Instead, await the existing job only while it is running, or race it against a short timeout and then fall through to the fg on-demand call. Alternatively, mark entries created at priority 2 or higher as never retried.

**Verifier note.** Confirmed. onDemandHints dedupes through bg() with priority 0, and for a queued entry bg() lowers its priority to 0 (jobs.ts:383-384). pause() drops only queued entries with priority 2 or higher, and onError re-queues priority ≤ 1 entries on a limit error for retry after LIMIT_PAUSE_MS. So the awaited promise stays pending for 15 minutes. coach.hint() returns the same hintFlight promise on every further press, and maybeOfferHelp is suppressed while hintFlight is set. The repro (manual clock) shows no fg fallback until the 15 minutes are advanced; its later failure is only a missing fake response. Minor: it needs the speculative ladder to be queued, not running, and that exact call to be the first one to hit the limit.

## concurrency-5: A Teach waiting on a pack or mini atom opens the old task's drill after a task switch

- Lens: concurrency. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/coach.ts:1406`

**Failure scenario.** 1. During a non-building phase (for example 'explain', then 'I have no idea'), or for a jitAtom, openAtom goes into atomForTeach. It awaits an in-flight global-scope pack via fillWait, or the 20-40 s fg mini atom.
2. The learner clicks task 2. abortFlows does not cancel the global pack or the fg call.
3. The pack lands. openAtom continues without re-checking the current task or phase, and calls runAtom(atom, c, t) with the OLD task.
4. runAtom takes the lock and opens the practice pad over task 2, which may be building or in its gate. If the lock is busy, it queues a blocking 'atom' action that opens on release. It also sets the old task's phase to 'learning' and records the atom evidence under the old task's id.

**Evidence.** coach.ts:1397 `const got = await this.atomForTeach(lang, c);`, then 1406 `return this.runAtom(atom, c, t ?? this.task);`, with no `this.task !== t` check. coach.ts:1427-1428 are the long awaits (fillWait on inflight, fgWithSprint miniAtom). abortFlows only cancels `s.scope === 'task' || (project...)`, and packs are scope 'global'. Repro: scratchpad/conc-rev-x7/teachlate.test.ts. Output: 'current task t2 building | late pad runs [ [ parse-command, t1 ] ] | t1 atomRuns 1'.

**Suggested fix.** After atomForTeach resolves, return 'queued' (or offer a non-blocking tempo action) when this.task !== t or the current phase is 'building'. Capture the gen at the start and drop the result if it no longer matches.

**Verifier note.** Confirmed. In a non-building phase, atomForTeach awaits fillWait(inflight) or fgWithSprint(miniAtom). abortFlows does not cancel global-scope packs or the fg call, and when it aborts the wait sprint, fillWait just returns the still-pending promise. openAtom then calls runAtom(atom, c, t) without re-checking this.task or the phase. runAtom opens the pad, or queues a blocking tempo action, over the new task and records the run on the old task. The repro shows the late pad run with taskId t1 while t2 is building. The impact is a misplaced drill or a stolen focus, not lost data.

## concurrency-6: abortActive releases the lock before the pad flow has finished, so the next pad flow throws and its gap atom or placement is skipped

- Lens: concurrency. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/lock.ts:75`

**Failure scenario.** 1. An atom, sprint or placement is open in the pad.
2. startTask (or startProject) calls abortFlows, then lock.abortActive(). The pad only posts an abort input, but the lock is released synchronously.
3. The aborted flow still has to process the abort, wait for any feedback hold (up to 1.5 s), and run closeSession, which saves, calls tabGroups.close and showTextDocument(prev). Its end() runs only after all that.
4. Meanwhile beginTask(B) goes to repairGaps, openAtom and runAtom. pad.acquire succeeds, atomHistory reads the log, then pad.run calls beginFlow, which throws.
5. runAtom logs 'atom failed' and the gap atom becomes a JIT offer. The same throw makes runPlacement log 'placement failed' and mark placement done, or makes runSprint return 'Finish the open practice first'.

**Evidence.** lock.ts:68-75: abortActive calls `h.onAbort?.('esc')` and then releases at once (`return this.release(h.token, 'esc') ...`). pad.ts:829-843: endActive only does `this.session?.abort(reason)`, which is asynchronous. pad.ts:817 `if (this.flow) throw new Error(`AtomPad: '...' is running; '...' cannot start`)`. coach.ts:1462 and 911 catch it as failures. Repro: scratchpad/conc-rev-x7/padrace.test.ts uses the real AtomPad and InteractionLock, with a 30 ms editor close modelling tabGroups.close. Output: 'second run error: AtomPad: 'atom' is running; 'atom' cannot start'.

**Suggested fix.** Give AtomPad a whenIdle() promise that resolves when the current flow's end() runs. Have pad.run, beginFlow, padSkeleton and PlacementRun await it, with a timeout, instead of throwing. Alternatively, have abortActive accept an async onAbort and release the lock only after the pad flow has ended.

**Verifier note.** Confirmed. lock.abortActive calls onAbort, which only posts an abort to the session, then releases the lock synchronously. The old pad.run still goes through applyAtom, exitAtom and closeSession (which awaits session.hold(), up to the feedback hold, then editor.close) before end() clears this.flow. beginFlow throws when this.flow is set (pad.ts:817), and no caller waits for the pad to go idle: the only beginFlow callers are pad.run, PlacementRun, Sprint and padSkeleton. beginTask can reach repairGaps, runAtom, atomHistory (a disk read) and pad.run within that window. runAtom catches the throw as 'atom failed' (the gap becomes a JIT offer). runPlacement catches it as 'placement failed' and marks placement done. The repro uses the real AtomPad and InteractionLock with a 30 ms editor close.

## concurrency-7: Shutdown order saves a spurious 'Roadmap failed' card on every reload while the roadmap is pending

- Lens: concurrency. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/extension.ts:747`

**Failure scenario.** 1. The window reloads during the 40-70 s PlanOutline call.
2. shutdown() calls jobs.dispose(), which cancels 'plan' (resolved as undefined), and then store.flush().
3. At flush's first await, the cancellation continuations run: planOutline returns {ok:false, reason:'the roadmap call was cancelled or dropped', stale:false}, and enqueuePlan's handler calls planFailed. That sets planError and pushes the error card with a Retry button into p.feed.
4. flush then writes this mutated project to workspaceState.
5. After the reload, reconcile re-enqueues the plan and clears planError, but the 'Roadmap failed: the roadmap call was cancelled or dropped' card stays in the project feed. It is shown while the learner waits for the roadmap that is actually still being made.

**Evidence.** extension.ts:747-748 `jobs.dispose(); const results = await Promise.allSettled([store.flush(), ...])`. prefetch.ts:417 `return { ok: false, reason: failure ?? 'the roadmap call was cancelled or dropped', stale };`. coach.ts:772 `if (!r.ok && !r.stale && this.deps.store.project === p && p.placement.planPending) this.planFailed(p, r.reason);`. Repro: scratchpad/conc-rev-x7/shutdown.test.ts. Output: persisted planError 'the roadmap call was cancelled or dropped', and the feed still contains the card after reconcile.

**Suggested fix.** Flush before disposing jobs, or set a disposing flag that the coach checks before planFailed and other cancellation side effects. Alternatively, treat outcome 'canceled' as stale in planOutline, so no error card is ever created for a cancelled plan.

**Verifier note.** Confirmed. shutdown calls jobs.dispose() first, which cancels 'plan' through settle(), resolving it to undefined. store.flush's first real await is globalState.update; flushLog does not await when its queue is empty. During that await, planOutline returns ok:false with stale=false (the gen is unchanged), and enqueuePlan's handler calls planFailed, which sets planError and pushes the error card. workspaceState.update(project) then persists that state. After the reload, reconcile clears planError but the feed card stays. My experiment shows it is worse than cosmetic: clicking the stale card's Retry while the re-enqueued plan runs dedupes onto it and applies the plan twice (2 'Roadmap ready' cards, 6 tasks).

## concurrency-8: Erasing the profile mid-task detaches the spec ladder and cancels needed jobs, and nothing re-attaches or re-queues them

- Lens: concurrency. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/coach.ts:2484`

**Failure scenario.** 1. While building a task with an applicable ladder, the learner runs 'Erase profile'.
2. resetProfile calls abortFlows('project'), which calls specs.detach() and cancels every project- and task-scoped job (TaskBatch, TaskPrep, follow-up).
3. It then only resets the learner and calls refresh(). The task stays active in 'building', but saves no longer run specs. 'Run my specs' turns into a model 'Check my work' call.
4. If the learner was waiting at a milestone end ('The next milestone is being prepared'), the cancelled TaskBatch is never re-queued, so they wait forever. Only a task switch or a window reload (reconcile) recovers.

**Evidence.** coach.ts:2484-2488 `async resetProfile() { this.abortFlows('project'); this.prefetcher.reset(); await this.deps.store.resetLearner(); this.refresh(); }`. abortFlows (1114-1120): `cancelWhere(...)` and `this.deps.specs?.detach();`. refresh() only does `this.signals = undefined; this.changed();`. Repro: scratchpad/conc-rev-x7/reset.test.ts. Output: 'current task t1 active building | specs.taskId undefined | applicable false', then checkWork made 1 WorkReviewSchema call and 0 spec runs.

**Suggested fix.** In resetProfile, keep the project and task: only cancel jobs whose results depend on the old learner. Afterwards call reconcile(), or re-attach specs for the current task and re-run ensureNextBatch and prepTasks.

**Verifier note.** Confirmed. resetProfile calls abortFlows('project'), which runs specs.detach() and cancels every project- and task-scoped job (plan, batch, prep, follow-up). Afterwards it only resets the learner and calls refresh(). The only re-attach paths are reconcile, beginTask, goBuilding and onPrep; onSave does not re-attach. checkWork then falls through to the model reviewWork. A cancelled TaskBatch or plan is not re-queued until a task switch or a reload. Minor: Erase profile is a rare command behind a confirmation dialog.

## concurrency-9: Nested repair calls are not counted, so one budget unit can be up to 4 model calls and the hourly cap does not hold

- Lens: concurrency. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/jobs.ts:572`

**Failure scenario.** 1. A TaskPrep for 3 tasks spends one budget unit when it starts. verifyPrep then calls verifyLadder for each task, and each can make one SpecLadderPart repair call. That is up to 4 Codex calls charged as 1.
2. An AtomPack with a repair round is 2 calls charged as 1.
3. With the default 20/hour (16 'other'), the learner's plan can see far more than 20 background calls per hour, while the tempo tooltip still reports e.g. '7/20 this hour'.
4. This makes reaching the plan limit (and C3) more likely.

**Evidence.** jobs.ts:572 `this.budget.spend(e.kind);` runs once per job start. prefetch.ts:604-609: repairLadder calls `this.deps.llm.json(...)` directly ('inside the TaskPrep job: a nested bg job could deadlock the lane'). prefetch.ts:722-726: the pack repair also calls llm.json directly. The existing test prefetch.test.ts:198 asserts `llm.count('SpecLadderPartSchema') === 3` for one TaskPrep. scratchpad/conc-rev-x7/packlimit.test.ts shows 2 AtomPackSchema calls with stats().used === 1.

**Suggested fix.** Add a JobQueue method (e.g. charge(kind) or a nested-call wrapper) that calls budget.spend without taking a slot, and call it before each repair. If the share is exhausted, skip the repair rather than exceed the cap.

**Verifier note.** Confirmed. budget.spend is called in exactly one place (jobs.ts:572, once per job start). repairLadder and the pack repair call llm.json directly inside the job, so a TaskPrep can make 1 + N SpecLadderPart calls and an AtomPack 2 calls for one budget unit. The spec's RollingBudget and the deliberate.backgroundCallsPerHour description both define the budget as background model calls, and the spec's per-task budget counts repair as its own call ('plus repair about 0.1'). So the cap and the 'x/20' tooltip undercount. The real-world impact is modest, so minor.

## concurrency-10: A reload during completeTask's follow-up wait leaves no active task, and the follow-up is lost

- Lens: concurrency. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/coach.ts:2359`

**Failure scenario.** 1. A task with a weak concept meets its criteria. maybeFollowUp starts the FollowUp job.
2. completeTask sets t.status='done' (saved), then waits up to 20 s for the follow-up.
3. The window reloads in that window. reconcile only acts when `cur.status === 'active'`, and only prepares cur and next. It never begins the next roadmap task and never re-requests the follow-up (the followUps map is in memory only).
4. The learner lands on a finished task with no next task started and no follow-up. They have to pick the next task by hand.

**Evidence.** coach.ts:2334 `t.status = 'done';` comes before coach.ts:2359 `if (fu) await settleOrTimeout(fu, ...)`. reconcile at coach.ts:982 is `if (cur && cur.status === 'active') {` and has no branch for a done current task. Repro: scratchpad/conc-rev-x7/fureload.test.ts. Output: 'after reload: current t1 done | t2 todo | FollowUp calls 0'.

**Suggested fix.** In reconcile, when the current task is done and placement is done, run maybeFollowUp's policy again (or just beginNext) so the loop continues.

**Verifier note.** Confirmed. completeTask sets status 'done' (saved) and then waits up to followUpWaitMs for a follow-up still in flight. reconcile only acts on an active current task, never begins the next roadmap task for a done one, and cannot re-request the follow-up because followUps is an in-memory Map and the bg job is gone after a reload. inputMode then shows only Ask/Sprint, so the learner has to pick the next task in the sidebar, and the follow-up the policy wanted is lost. The window is short (until the follow-up lands, at most the grace wait), so minor.

## concurrency-11: Task switches and new projects never abort the foreground call: an old task's call keeps the single fg lane busy while its result is thrown away

- Lens: concurrency. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/coach.ts:1114`

**Failure scenario.** 1. On a spec-less task, the learner clicks 'Check my work'. reviewWork starts a medium-effort fg call (Codex timeout 180 s).
2. The learner switches task, or starts a new goal. abortFlows cancels bg jobs but has no way to abort jobs.fg; JobQueue only aborts fgAbort in dispose().
3. The new task's Ask, Reveal or mini-atom Teach queues behind the old call on the one-at-a-time fg lane, with the busy bar showing 'Reviewing your work', for up to 3 minutes.
4. When the old call returns, reviewWork discards the result (`this.task !== t`), so the wait gained nothing. The same happens with an on-demand hint ('Preparing a hint') and with rungHint.

**Evidence.** coach.ts:1113-1120 abortFlows: `this.deps.lock.abortActive(); this.deps.jobs.cancelWhere(...)` and nothing for the fg lane. jobs.ts fg(): `this.fgAbort = ac;` is only aborted in `dispose(): ... this.fgAbort?.abort();`. coach.ts:2136 `if (this.task !== t || t.status !== 'active') return;` discards the review.

**Suggested fix.** Add JobQueue.cancelFg() (abort fgAbort, and optionally drop waiting fg turns), or tag fg calls with a gen and scope. Call it from abortFlows so a task-scoped foreground call is killed on a task switch and a new project.

**Verifier note.** Confirmed. JobQueue.fg serialises calls through fgTail and only aborts fgAbort in dispose(). abortFlows cancels bg jobs and the lock but has no way to cancel the fg lane, and no user-facing cancel exists. A task-scoped fg call such as reviewWork (medium effort, Codex timeout 180 s) keeps the single lane busy after a task switch, and reviewWork discards its result (this.task !== t). The new task's Ask, Reveal, hint or mini atom waits behind it. Minor: this is latency only, and not every fg call is wasted (a mini atom still fills the cache, and Ask is not task-specific).

## spec-1: REVEAL clips the refutation to 52 characters, so on every seeded misconception the sentence that does the refuting only appears on hover

- Lens: spec. Reported severity: major. Verified severity: minor. Confirmed: yes.
- Location: `src/atoms/render.ts:319`

**Failure scenario.** A Python learner answers a variables-assignment probe the way the 'assignment-links-names' mutant predicts and presses y at 'Did you think: Changing score later also changes saved?'. REVEAL then shows the refutation as after-text on the changed line: 'saved = score gave saved the value score had at th…'. The part that actually refutes the belief ('...a new value for score later does not reach saved') is cut off and only shows on hover. The misconception path is the step meant to fix a belief in 25-40 s, so the learner is sent to the re-probe without having read the refutation. This happens on every seeded misconception: all 100 Python, 95 JavaScript and 97 TypeScript seed refutations are longer than 52 characters (shortest 58 / 68 / 68, median about 90-99), and model refutations may run to 25 words.

**Evidence.** render.ts renderReveal: `p.deco(start + diff - 1, ref, 'removed', [ref, ...].join(...))`. Then decoration() calls afterText(text), which clips at AFTER_TEXT_MAX: `if ([...one].length <= AFTER_TEXT_MAX) return one; return [...one].slice(0, AFTER_TEXT_MAX - 1).join('').trimEnd() + '…'` (annotationModel.ts:18 `AFTER_TEXT_MAX = 52`). padfs.ts paint() shows only `renderOptions.after.contentText = d.text`; the full text goes into hoverMessage. Checked by running renderReveal in the scratchpad with the seed refutation '{{@b}} = {{@a}} gave {{@b}} the value {{@a}} had at that moment; a new value for {{@a}} later does not reach {{@b}}.' (slots filled). The output decoration was {"text":"b = a gave b the value a had at that moment; a new…","kind":"removed","hover":"<full>"}. Then measured every refutation in media/seed/*.json with a node script: none fits in 52 characters.

**Suggested fix.** Show the refutation in the pad text itself, as one or two '# ' comment lines (wrapped with wrapText) directly under the changed line or under the '# Rule:' line. Keep the after-text only as a short marker such as '<- this line'. The reading budget already allows 25 words for it.

**Verifier note.** I confirmed the clipping. renderReveal passes the refutation to p.deco(), and decoration()/afterText() in render.ts:176-187 cut it to 52 characters. padfs.ts:331 shows only d.text and puts the full text in hoverMessage. I measured every seed refutation: none is 52 characters or shorter (python min 58, median 91; js and ts min 68, median 100; neutral min 80). So the concrete refutation always ends in '…'. This matches the spec's own wording, though: 'after-text 52 characters or fewer; full text in hoverMessage', 'with the refutation as after-text and hover', and 'The pad shows refutations in hovers'. test/render.test.ts:94 asserts it on purpose. The '# Rule:' comment line is shown in full and carries the general refuting fact, e.g. 'Assignment copies the current value; later changes do not follow.' So the claim that the refuting part only appears on hover is overstated. What remains is a real but minor gap: a 25-word sentence the spec budgets as reading is always truncated in the step meant for reading it.

## spec-3: Task end waits up to 20 s on the follow-up call with no UI update, and Pace's 'Model wait per task' never counts it

- Lens: spec. Reported severity: major. Verified severity: minor. Confirmed: yes.
- Location: `src/coach.ts:2359`

**Failure scenario.** A beginner finishes task 1 (all specs green). The weakest task concept is below P .6, which is typical: a task concept with no spec on it stays at the .3 prior. So a medium-effort FollowUp job is queued at criteria-met. The learner presses Later on the first what-if, or the what-ifs are skipped, or the follow-up is queued behind other bg jobs. completeTask then awaits the follow-up for up to 20 s before starting anything. During that time changed() is never called, so the sidebar is not re-rendered: no 'Task complete' card, no busy label, and the input mode is 'ask'. The learner sees a frozen UI for up to 20 s at every such task end. This wait is not added to Task.waitMs, which only fg() increments, so the Progress tab's 'Model wait per task' (goal 5 s or less) shows 0 s in green. The same metric also misses Teach waiting on an in-flight pack (fillWait without fg) and the in-atom escalation-lesson wait. It counts a mini-atom fg call made while the learner keeps building, during which nobody is waiting.

**Evidence.** coach.ts:2357-2359 `const fu = this.followUps.get(t.id); if (fu) await settleOrTimeout(fu, this.deps.delays?.followUpWaitMs ?? COACH.followUpWaitMs);` (COACH.followUpWaitMs = 20_000), with no changed() or busy label before it. Wait accounting exists only in fg(): coach.ts:680-681 `this.deps.jobs.fg(label, run).finally(() => { if (t) t.waitMs = ... })`. shell.ts:364-365 `const waits = done.map((t) => (t.waitMs ?? 0) / 1000)`. atomForTeach line 1427 `if (inflight) await this.fillWait(inflight, ...)` does not go through fg. Checked with a scratch flow test (followUpWaitMs 400 ms, FollowUp deferred, what-if 'later'): onChange fired at 12 ms and then not again until 421 ms. During the wait busy was undefined, task status 'done' and mode 'ask'. Afterwards t1.waitMs was 0 and paceExtras(...).waitPerTaskSec was 0.

**Suggested fix.** Don't block task start on the follow-up. Start the next roadmap task at once and let onFollowUp insert the follow-up after it, or show it as a tempo offer. If a grace period stays, call changed() first, show a busy or tempo 'preparing follow-up' state, and add the elapsed time to t.waitMs. Record learner-visible waits (fillWait on in-flight packs, escalation-lesson waits, the follow-up grace) in the Pace wait metric, and leave out fg calls made while the phase is 'building' with offerOnly.

**Verifier note.** I confirmed it in the code. completeTask (coach.ts:2333-2359) sets status and phase to done, pushes 'Task complete' into t.feed and then awaits settleOrTimeout(followUp, 20 s). Nothing calls changed() before that, so the webview gets no full-state refresh. Only status posts from ticks and job changes arrive, and they carry no feed. waitMs is incremented only inside fg() (coach.ts:681), and shell.ts:364 builds 'Model wait per task' from it, so this grace wait is never counted. The 20 s grace is an implementation choice that the spec does not contain. I lowered the severity to minor: the wait is bounded at 20 s, the 'Every behaviour passes' flash is visible, and the full stall mostly happens on the what-if later, skipped or busy paths. When 2 what-ifs actually run, they usually cover much of the follow-up call.

## spec-5: ESCALATE can leave the learner on '# preparing a short lesson... (~10 s)' for up to 150 s with no way to continue, and the lesson's wait counts against ESCALATE's own clock

- Lens: spec. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `src/atoms/stepMachine.ts:697`

**Failure scenario.** A re-probe fails and the escalation lesson is queued as a priority-0 background job. It does not pre-empt running jobs: with backgroundConcurrency 2, both slots can be busy with medium jobs such as the milestone-2 TaskBatch enqueued at task 1's start, or AtomPacks. If the 16 non-hint calls/hour are used up, the job waits on 'budget' instead. The second sibling item fails, and the pad shows '# preparing a short lesson... (~10 s)' in phase 'wait-lesson'. Ctrl+Enter and continue are ignored in that phase, and the spec forbids a sprint inside an atom. The only exit is Esc Esc, which is recorded as 'aborted'. escalateStartedAt starts when the wait starts, so a lesson that lands after 120 s leaves 30 s to read 120 words and do the completion. Then the cap exits 'escalated' mid-item, or with nothing shown if the lesson never landed.

**Evidence.** stepMachine.ts:697-704 `if (s.lessonState === 'requested') { s.phase = 'wait-lesson'; this.render({ kind: 'escalate', pending: true }); return; }`. onContinue (718-721) `if (s.phase !== 'show') return;`. onSubmit (746-748) returns unless phase is 'show'. enterEscalate (585-591) sets `s.escalateStartedAt = this.at` before the lesson lands. checkCaps (482-485) exits after `ATOM_CAPS.escalateMs`. prefetch.ts:820-823 queues the lesson as `jobs.bg({... priority: 0 ...})`. jobs.ts pump only reserves a slot against priority>=2 work and puts priority 0-1 jobs on `waitingFor = 'budget'` when the share is spent. render.ts:97 LESSON_PENDING promises '~10 s'.

**Suggested fix.** Start ESCALATE's 150 s clock when the lesson (or the completion) is rendered, not when the wait starts. Let Ctrl+Enter in 'wait-lesson' skip straight to the fresh completion. Give the escalation lesson a reserved bg slot, or exempt it from the hourly share as the hint reserve is.

**Verifier note.** The mechanics are as described. showEscalate sets phase 'wait-lesson' while lessonState is 'requested' (stepMachine.ts:697-704). onContinue and onSubmit ignore every phase except 'show' (718-721, 746-748). enterEscalate sets escalateStartedAt before the lesson lands (585-591), and checkCaps exits after 150 s. The lesson is a priority-0 background job. It can wait for a slot, because the speculative cap only keeps priority>=2 jobs out of one slot and priority-1 jobs can still fill it. It can also wait for budget, since priority 0-1 jobs wait rather than drop. In normal conditions the lesson is requested when the re-probe fails, and the second-sibling item (20-40 s) covers a low-effort call. A long wait therefore needs queue contention, the wait is bounded at 150 s, and Esc Esc exits. So this is a real but edge-case robustness issue, which is why it stays minor.

## spec-7: The 'deliberate.nameNewMisconceptions' setting in the README and package.json does nothing

- Lens: spec. Reported severity: minor. Verified severity: minor. Confirmed: yes.
- Location: `package.json:630`

**Failure scenario.** A learner turns on deliberate.nameNewMisconceptions, expecting what the README and the setting description promise: 'after a wrong practice answer that matches no known misconception, ask the model in the background to name the belief behind it (at most 2 per task)'. Nothing happens. No code reads the setting and no job ever uses the misconception-guess prompt, so unmatched wrong answers never get a named belief. The spec's opt-in diagnosis path is missing while the docs say it exists.

**Evidence.** README.md:114 documents the setting. package.json:630-633 declares it. `grep -rn nameNewMisconceptions src` finds nothing. misconceptionGuessPrompt (src/atoms/prompts.ts:184) and MisconceptionGuessSchema (src/schemas.ts:128) are referenced only by test/atom-prompts.test.ts and test/schemas.test.ts, never by coach, pad or prefetch code.

**Suggested fix.** Either wire it in: after an unmatched wrong predict, if the setting is on and fewer than 2 have run this task, queue a low-effort priority-3 background job with misconceptionGuessPrompt and record its result as a candidate. Or remove the setting from package.json and the README until it is implemented.

**Verifier note.** I confirmed this. package.json:630-633 declares deliberate.nameNewMisconceptions, and README.md:114 documents it. A case-insensitive grep of src/ and media/ finds no reader of the setting. misconceptionGuessPrompt and MisconceptionGuessSchema are referenced only where they are defined and in tests. docs/stage2-reports.md:354 itself says 'no module reads it: the MisconceptionGuess flow is not wired'. It stays minor because the setting is opt-in and off by default, so turning it on simply does nothing.

## spec-6: The free-text 'Explain it back' essay also appears when the learner's code runs fine but no what-if changes its result, not only when there is no runtime

- Lens: spec. Reported severity: minor. Verified severity: minor. Confirmed: no (refuted).
- Location: `src/coach.ts:2165`

**Failure scenario.** With Python, consent 'Snippets and my code' and a trusted workspace, the learner's function has no exercised line from the small operator table that changes the probe's result. For example, every candidate mutant gives the same output, the probe call is a load error, or the result is over MAX_ANSWER_CHARS. WhatIfFlow.run returns status 'unavailable' with reason 'no what-if changes the result of your function'. criteriaMet treats this like 'no runtime': it sets phase 'explain-back', asks 'In two or three sentences: how does your solution work...?' and does not start the next task until the learner types an essay or finds Skip in the sidebar. The tempo bar shows nothing for this phase. The spec keeps the essay only as the fallback when there is no runtime (removeOrShrink) and says the next task starts at once.

**Evidence.** coach.ts:2165-2167 `if (what === 'unavailable' || (what === 'done' && t.notUnderstood)) { this.askExplainBack(t); return; }`. whatIfs() maps every non-busy unavailable reason to 'unavailable' (2224). owncode.ts:1154 `if (!list.length) return { status: 'unavailable', reason: 'no what-if changes the result of your function', ... }` runs after the runtime and consent checks have passed (1151-1152). askExplainBack (2247-2254) sets phase 'explain-back' and only focuses the composer.

**Suggested fix.** Fall back to the essay only for the runtime and consent reasons. When what-ifs find nothing to ask, use one predict-your-function probe instead (PredictFlow already exists), or simply completeTask. If the conflict-flag explain question stays, grade it in the background without blocking the next task, and put it in the tempo bar.

**Verifier note.** This behaviour matches the spec's detailed mechanism. V1-12 (redesign-spec.md:2104) says 'FALLBACK when there is no runtime, consent or probe: the free-text explain-back, graded in the background'. V1-9 (1725) says answerExplainBack is 'only used when there is no runtime or probe'. 'No what-if changes the result of your function' is exactly the no-probe case. The high-level lines (302, 453) that mention only runtime are shorthand that the detailed mechanism refines. stage2-reports item 10 also documents 'no runtime or no probe'. Grading already runs in the background, and Submit or Skip completes the task at once, which is what the spec describes. Whether the fallback should be a predict probe instead is a design suggestion, not a defect against the spec.
