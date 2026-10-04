

# pad tests=True count=66
## deviations
Resumed run: most of pad.ts, padfs.ts, stock.ts, placementRun.ts, sprint.ts and the pad/stock tests already existed and were largely correct. I kept them and fixed or finished:
- stock.ts: two stock tests were failing. refillIfLow now returns undefined at once when the key is already stocked (the old code always started an async refill). cacheKeyFor no longer lends a tag's seed stock to separate plan concepts that share the tag.
- pad.ts behaviour changes:
  - An assisted insert now removes the inserted answer: the item is re-rendered before the 'looked auto-inserted: not counted' note, so the pasted text cannot just be resubmitted.
  - Leave practice and a closed tab end placement and sprints as 'esc'. Only the InteractionLock abort counts as 'aborted', and an aborted placement or sprint ends with no flash and no log card. Atoms still flash on every exit, as the spec says.
  - Esc Esc on an idle pad left open with keepOpen closes it.
  - padAwait is reset when a flow ends with the pad still open.
  - Refill is poked after every probe pick; Stock decides whether anything is needed.
- placementRun.ts: the typing calibration sets cps only when the learner typed a faithful copy (spaces and quote style ignored). An assisted typing answer re-prompts.
- sprint.ts: an `until` that has already settled shows no item. The sprint flash and card are skipped when aborted.
- The VS Code implementation lives in padfs.ts: the FS provider, VscodePadEditor, VscodePadUi and command and wiring helpers.
- Package fragment additions beyond the spec, which the shell engineer may drop:
  - `editorTextFocus` added to the y, n and 1/2/3 when-clauses, so typing y in the Search box does not answer.
  - `!editorHasSelection && !editorHasMultipleSelections` added to the Escape when-clause, so the Esc that clears the preselected '?' on a traceback item does not count toward double-Esc.
  - numpad1-3 bindings.
  - files.trimTrailingWhitespace, files.insertFinalNewline and files.trimFinalNewlines set to false per pad language. The pad saves itself after every coach edit, and these would otherwise edit the '# -> ' line.
  - A top-level `activationEvents: ["onFileSystem:deliberate-pad"]` key, so a pad tab restored after a reload resolves before closeLeftoverPadTabs closes it.
  - editor.hover.enabled is not set.
- SprintResult adds score, best, newBest, stopReason and conceptIds to the spec's fields.
- Two stage-1 behaviours I noticed, not changed:
  - placement.ts treats a ticked concept with no ticked descendants as a leaf. So the fast lane can fire after 3 quick items on one ticked root concept.
  - Unticked concepts get P .2, count as classified and are never asked. That is per the spec.
- evidence.ts also sets and clears selectionGap on sprint evidence (it clears to false). sprint.ts additionally marks a gap for concepts in AtomPad.atomPassed.
- Not done: padfs.ts was not run in a live VS Code host. It compiles against the 1.93 typings, and all behaviour is tested through the PadEditor fakes. The Go, Java and Rust pad languages are not included, because Lang covers only python, javascript and typescript.
- Full suite: 721/729 passed, 1 skipped. All 7 failures are in Python harness, specs and own-code tests that timed out under parallel load. harness.integration.test.ts passes on its own, and none of these tests import my modules.
## notesForNext
EXTENSION.TS (shell)
1. Create the surface: `const surface = createPadSurface(); ctx.subscriptions.push(...surface.disposables); void closeLeftoverPadTabs();`.
2. Create one Stock per language that has a cache:
   `new Stock({ lang, cache: caches[lang], readFile: async (rel) => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ctx.extensionUri, ...rel.split('/')))), runner: () => (consent && vscode.workspace.isTrusted ? runners[lang] : undefined), log: (l) => contentChannel.appendLine(l) })`
3. After runtime discovery, call `void stocks[lang].ensureStock()` (also when there is no runner: it then stocks the neutral items).
4. Create the pad:
   `const pad = new AtomPad({ editor: surface.editor, ui: surface.ui, learner: () => store.learner, recordEvidence: (e) => recordEvidence(store.learner, e), cache: (l) => caches[l], runner: (l) => runners[l], canRun: (l) => consent && vscode.workspace.isTrusted, lesson: (req) => coach.escalationLesson(req), onLog: (card) => coach.pushLogCard(card), onExit: (r) => coach.onAtomExit(r), markProgress: (now, why) => coach.markProgressIfBuilding(now, why), lock, refill: (l, key) => void stocks[l]?.refillIfLow(key) })`
   Then `ctx.subscriptions.push(...registerPadCommands(pad), { dispose: () => pad.dispose() })`.
5. Register `deliberate.sprint` (Ctrl+Alt+S) yourself, as `coach.sprint(180_000)`.
6. Merge docs/stage2/pad.package.json:
   - contributes: languages, grammars, configurationDefaults, commands, keybindings, menus.
   - setting deliberate.padColumn.
   - the top-level activationEvents entry.
   - .vscodeignore must keep syntaxes/** and media/seed/** (it does today).

COACH
- Atom:
  - `const key = stocks[lang].cacheKeyFor(learner, conceptId); const atom = key ? caches[lang].get(key) : undefined;`
  - `const release = pad.acquire('atom'); if (!release) { enqueueAction(...); return; } try { const r = await pad.run(atom, { taskId, placementDontKnow, confirmedMisconceptions, recentCorrectGroups }); task.atomRuns.push(r); } finally { release(); }`
  - The pad does every EXIT step itself (save, close, restore the editor, deck, flash, log card, markProgress, onExit). The caller only releases the lock and returns to resumePhase.
- Lesson provider:
  - Return `project.prefetch[req.key]` synchronously when it is there.
  - Otherwise return a Promise from `jobs.bg({ key: req.key, priority: 0, effort: 'low', ... })` that runs escalationLessonPrompt, then verifyLesson, and stores v.lesson.
  - Resolve undefined on failure (never reject).
- Placement:
  - `const pr = new PlacementRun(pad, stocks[lang]);` and keep it, so the plan merge handler can call `pr.addCandidates(planConceptIds)`.
  - Under `pad.acquire('placement')`, run `await pr.run({ needed: () => conceptIdsOfTasks1to3, planPending: () => project.placement.planPending, calibrated: project.placement.calibrated })`.
  - Persist selfRated, calibrated and done from the result.
  - reason 'plan-pending' means: show the wait plus the 'Practice while you wait' sprint offer.
  - reason 'aborted' (from lock.abortActive) is silent: no flash, no card.
- Sprint:
  - `const s = new Sprint({ pad, stock: stocks[lang], best: { get: () => ctx.globalState.get<number>('deliberate.sprintBest'), set: (v) => void ctx.globalState.update('deliberate.sprintBest', v) } })`.
  - Use `s.available(2) >= 2` for fgWithSprint's stock check.
  - Wait filling: `s.run({ reason: 'wait', until: jobPromise, keepOpen: atomFollows })`.
  - Command: `s.run({ reason: 'sprint', budgetMs: 180_000 })`.
  - Warm-up: `s.run({ reason: 'warmup', budgetMs: 60_000 })`.
  - Hold the lock as 'sprint' or 'warmup' around every run.
  - A Sprint and a PlacementRun each run only once: create a new one per run.
- Log cards: PadLogCard is { kind: 'atom' | 'placement' | 'sprint', title, lines, conceptIds, atom?, data? }. It is the only place besides the status flash that names the concept.
- Tests: MemoryPadEditor, ScriptedPadUi and ManualClock from src/atoms/pad.ts can drive a real AtomPad headlessly in coach and flow tests. pad.whenAwaiting() resolves when the pad waits for input.


# surfaces tests=True count=51
## deviations
Changes from the spec, or additions to it, that the wiring engineers need to know:

1. The HINTLADDER prompt asks for rung 1 in 44 characters or fewer, not 50. 'Hint 1: ' plus 50 characters would be over the 52-character after-text cap and go to a thread.
2. The pre-hint sentence uses the spec's exact wording ('Before this they predicted X returns Y; it actually returns Z.'), then adds one line of guidance: either 'Start from this mismatch.' or 'look for the problem elsewhere'.
3. Paste/assisted detection does not count three extra cases:
   - inserts whose text is already in a shadowed task file (copy line down, duplicating your own function);
   - reloads from disk (the document is not dirty after the change);
   - moves inside one event (drag and drop).
   If the clipboard can't be read, only inserts of 120+ characters are reported, and they are reported as pastes.
4. The terminal pause fires on a success when the run just before it failed (any command), or when this same command's last run failed. Unknown exit codes count as neither.
5. Additions to the tempo bar:
   - a deliberate.skipAction command, plus 'Do it (Alt+N) · Not now' links in the tooltip, so rule 6 (Skip pushes the kind back 5 minutes) also works for status-bar offers;
   - an onDidSkip event;
   - pops wait until the window has focus;
   - after opening a blocking action, nothing else opens for 2 s (or until that command settles), so two blocking actions can't both open before the first flow takes the lock.
6. Error counts differ by trigger:
   - SaveEvent.errorCount counts only the saved document's Error diagnostics at save time;
   - the 20 s idle pause uses Error diagnostics across the whole workspace.
7. The edit counter counts changed lines in every code document, not only task files. Whitespace-only re-indentation of text it already knows counts 0.
8. Anchor re-resolution has a fallback: if lineText is 12+ characters, a line that contains it also matches (for when the model dropped a trailing comment).
9. Rung 0 details:
   - Terminal: only the newest project error counts. It needs the same exception in the same innermost project file in two runs, and a later success of that command cancels it.
   - Diagnostics: the oldest Error diagnostic that has been present for 60 s or more.
   - A diagnostic message gets a question phrased around the message, unless it starts with an exception name.
10. HintPrefetcher counters live in memory, so a window reload resets the unused-prefetch cap. contentHash also hashes each file's key (its uri).

Not done here (other engineers own these):
- the coach-side model calls and hint() rungs 4-5 (the rung-4 pad skeleton);
- extension.ts registration of deliberate.gotIt and removing the old status item;
- the inline-AI offer.
## notesForNext
SHELL (extension.ts):
1. Create the surfaces in this order:
   - `const monitor = new Monitor()`
   - `const annotations = new LineAnnotationManager(ctx.extensionUri, { log })`
   - `const hintDisplay = new HintDisplay(annotations)` (annotations is its own HintHost)
   - `const tempo = new TempoBar({ state: () => coach.tempoState(), jobs, lock, monitor, log })`
   Push all four into ctx.subscriptions (dispose HintDisplay via `{ dispose: () => hintDisplay.dispose() }`). Give coach, specs and owncode `annotations` as their AnnotationSink and `tempo` as their ActionSink.
2. TempoBar handles a lot itself:
   - it registers deliberate.next and deliberate.skipAction, so don't register them again (or pass `registerCommands: false`);
   - it sets the context keys deliberate.hasAction and deliberate.building (from TempoState.phase === 'building');
   - it decides on every monitor tick, pause and lock release;
   - it flashes LIMIT_FLASH when jobs.onDidPause fires with reason 'limit'.
   Delete the old renderStatus status-bar item.
3. Merge docs/stage2/surfaces.package.json: the commands deliberate.next, deliberate.skipAction and deliberate.gotIt; the alt+n / mac ctrl+alt+n keybinding; the setting deliberate.showTimers. Then register `deliberate.gotIt` -> `coach.gotIt()`.
4. Spec controller wiring:
   - saves: `monitor.onSave(e => specs.onSave({ uri: e.uri.toString(), fsPath: e.uri.fsPath, reason: e.manual ? 'manual' : 'auto', errorCount: e.errorCount }))`
   - when an update has `turnedGreen.length > 0`: call `monitor.notePause('spec-green')` (this reaches the tempo bar through onPause) and `hintDisplay.clear('spec-green')`.
5. Inserts: `monitor.onInsert(e => coach.onInsert(e))`.
   - paste: `task.pastedChars += e.chars`
   - assisted: `task.assistedChars += e.chars`, and add e.functions to task.assistedFunctions (deduped)
   Never show a message. Pad documents are never reported.

COACH:
1. `tempoState()` returns { phase, stuckScore: signals.score, lastEditAt: monitor.lastEditAt, activeMsToday, sprintMsToday, task: {title, activeMin, estimateMin}, progressReason: monitor.detector.progressReason, calibration: sure[0]/sure[1], streak, idleText (e.g. status.specProgress(...)) }.
   - Call `tempo.update()` after phase changes.
   - Subscribe `tempo.onDidSkip(a => ...)`: skip is neutral. If `a.kind === 'jit-atom'`, remember it for the known-gap shortcut (threshold x.6).
2. startTask:
   - `monitor.startTask()`
   - `monitor.setTaskFiles(task.files ?? [] plus the interface file uri)`
   - `prefetcher.reset(prevTaskId)`
   - `hintDisplay.clear('task-changed')`
   - `tempo.remove('hint-ready')`
3. onTick prefetch, with `const pf = new HintPrefetcher()` held by the coach:
   - Staleness: if t.hintPrefetch exists, get `lines = (await annotations.readLines(t.hintPrefetch.anchor.file))?.lines`. If `pf.check(t.hintPrefetch, { taskId: t.id, errorHash: monitor.errorSetHash(), anchorLines: lines, changedLinesSince: m => monitor.changedLinesSince(m) })` returns a reason, call `pf.discard(t.hintPrefetch)` and set t.hintPrefetch = undefined.
   - Fire: `if (pf.wants({ taskId, score, mode: proactiveHints, hasValidPrefetch: !!t.hintPrefetch, inFlight: jobs.has(prefetchKey(t.id)), hintBudgetLeft: s.hintLimit - s.hintUsed, phase }))`, then `const h = await monitor.taskFileHash(t.files ?? [])`. If `pf.tryFire(t.id, h, { mark: monitor.mark(), errorHash: monitor.errorSetHash() })` returns true:
     - start `jobs.bg({ key: prefetchKey(t.id), priority: HINT_JOB.priority, effort: 'medium', kind: 'hint', scope: 'task', gen, label, run: signal => llm.json({ system, prompt: hintLadderPrompt({...ctx, speculative: true}), schema: HintLadderSchema, effort: 'medium' }, { signal, fast: false }) }, ladder => { t.hintPrefetch = pf.accept(ladder, { taskId: t.id, now: Date.now() }) })`
     - then `.finally(() => pf.settled(t.id))`.
4. hint():
   - Rung 0: `const r0 = monitor.rung0(lang)`. If it is new this episode, show `hintDisplay.show({ rung: 0, text: r0.text, anchor: { file: r0.file, line: r0.line } })`. Got it on rung 0 records nothing.
   - Rungs 1-3: `prefetchedRung(t.hintPrefetch, rung)`, then `pf.markUsed(p)`.
   - On a miss: an on-demand HintLadderSchema call at low effort (fg, or bg with kind 'other') with `hintLadderPrompt({ speculative: false, ownProbe })`, then `pf.accept(ladder, { taskId, now, contentHash: await monitor.taskFileHash(files), errorHash: monitor.errorSetHash(), mark: monitor.mark() })`.
   - Display: `const shown = await hintDisplay.show({ rung, text, anchor: p.anchor, drill: verifiedAtom ? { patternName } : undefined })`. undefined means sidebar card only. With a shown hint, the tempo label is `status.hintReady(shown.file, shown.line + 1)`.
5. maybeOfferHelp (score >= 1, 'offer' mode): `tempo.enqueue({ id: 'hint-ready', kind: 'hint-ready', label: status.hintReady(anchor.file, anchor.line), priority: 1, blocking: false, command: 'deliberate.hint' })`.
6. gotIt(): `hintDisplay.clear('got-it')`, `tempo.remove('hint-ready')`, recordHintEvidence, markProgress.
7. A hint dropped because its anchored line changed is reported through `hintDisplay.onDidClear` with reason 'anchor-changed'.
8. Blocking flows: when lock.acquire fails, enqueue a blocking action (atom/gate). TempoBar opens it on lock release.


# buildloop tests=True count=74
## deviations
Resumed run: specs.ts, owncode.ts, gate.ts and the three test files from the interrupted attempt were reviewed against V1-8/V1-11/V1-12 and stage1-notes and kept. Work added this run:
(1) BUG FIX in specs.ts: the failure-signature observation key was (signature, actual, error). An 'equals' signature only matches one actual value, so the count could never reach 2 and the V1-11 rule 'target still red past 2x par with the same signature twice queues an atom offer' could never fire. A new observation is now the same signature after the interface file's code changed (codeHash ignores CRLF/trailing whitespace); re-saving unchanged code is not one. Implemented the 2x-par rule: signatureStuck(count, activeMs, parSec) is checked on every matching run; once per spec it enqueues an ActionSink action (id 'specs:stuck', kind 'atom', label stuckOfferLabel(pattern), command = commands.jit, args [conceptId, specId]), removes the superseded JIT offer for that spec, and fires on.onSignatureStuck. Active time comes from the new optional dep activeMsSince(wallMs), with a wall-clock fallback. The offer is removed when the target changes.
(2) owncode.ts additions: ModelProbeTrigger (when to fire the OwnCodeProbeSchema job), ownCodeProbePrompt (spec OWNCODEPROBE text word for word), probesForFile (model probes filtered to their file), regionAfterEdits (feedback regions shift with edits above, clear on touching edits; used by both onEdit methods; onEdit's change type gained an optional text field, backward compatible), and a cap of 8 probe processes per prepare().
(3) specs.ts: saveTrigger(reason) maps a TextDocumentSaveReason to 'manual'|'auto' (an unknown reason counts as auto).
(4) Fragment: added command deliberate.jitAtom (hidden from the palette), which my controller uses by default.
Design deviations kept from the earlier attempt:
(a) Interface mapping uses resolveMapping (mapInterface's rules) rather than specsCore.mapInterface: an interface function with no candidate is 'pending' (not written yet), not DESIGN_DIFFERS. The ladder is not applicable only when a function has several same-arity candidates and nothing in the file matches; a later save that clears it up brings the ladder back (onApplicableChange).
(b) Non-parsing what-if mutants are dropped because running them through probe.py/probe.mjs reports a loadError (SyntaxError on import) and is treated as unusable, rather than a separate py_compile / node --check process. Same result, one fewer process per mutant.
(c) In continuous Testing-view mode a save produces one 'continuous' run, published as a TestRun, instead of a save run plus a continuous run.
(d) GateUi: on step B, 'I'd do it differently' or Esc records no plan evidence, but the step A evidence already submitted stays in GateResult.evidence. The coach can drop it if it reads 'records nothing' strictly.
(e) Signature matching (nudge, onSignature evidence and the stuck offer) is off in solo tasks, per stage1-notes.
Not verified: SpecTestView (the optional TestController) and the Vscode* ports typecheck against @types/vscode 1.93 but have not been run in a real VS Code window. No stage-1 modules were edited and no stage-1 bugs were found. All seven files are LF.
## notesForNext
COACH WIRING (src/coach.ts / extension.ts):
1. Construct once: const host = vscodeSpecHost(); const specs = new SpecController({ ...host, annotations, actions /*tempoBar ActionSink*/, harnessDir: Uri.joinPath(ctx.extensionUri,'media','harness').fsPath, specDir: Uri.joinPath(ctx.globalStorageUri,'specs').fsPath, verifyDir: Uri.joinPath(ctx.globalStorageUri,'verify').fsPath, conceptInfo: id => ({ p: P(learner,id), pattern: patternName(id) }), activeMsSince: since => <active ms from the tempo/StuckDetector since a wall time>, commands: { jit: 'deliberate.jitAtom', ladder: 'deliberate.open' }, log, on: {...} }). Optionally new SpecTestView(specs) and call view.show(task, specs.interfaceFile!, await host.functions!(file, text, lang)) after a successful attach.
2. Task start / specs land: await specs.attach(task, lang, runnerFor(lang), { allowRun: consent==='all' && vscode.workspace.isTrusted, deferredConcepts: routing.jit, announce: landedWhileBuilding, reservedNames: earlier tasks' interface + mapped names in the same file }). Persist task.interface.mappedNames and task.spec afterwards (both are mutated in place, also in onUpdate). Call specs.setAllowRun(...) on consent or trust changes and specs.detach() on task end. If applicable is false, keep Check my work. Show the DESIGN_DIFFERS card when reason === DESIGN_DIFFERS.
3. Saves: monitor.onSave(e => specs.onSave({ uri: e.uri.toString(), fsPath: e.uri.fsPath, reason: saveTrigger(e.reason), errorCount: e.errorCount })). Edits: vscode.workspace.onDidChangeTextDocument(e => { if (!e.contentChanges.length) return; const uri = e.document.uri.toString(); specs.onEdit({ uri, fsPath: e.document.uri.fsPath }); const ch = e.contentChanges.map(c => ({ startLine: c.range.start.line, endLine: c.range.end.line, text: c.text })); predict.onEdit(uri, ch); whatIf.onEdit(uri, ch); }).
4. Callbacks: onGreen(id, weight, info) -> recordEvidence kind 'spec', correct, production true, weight, latency = active ms since info.previousGreenAt ?? task start against info.spec.parSec, and detector.markProgress(now, `spec ${info.number} green`). onSignature(spec, sig, info) -> passive misconception evidence (sig.misconceptionId, odds 1.5, weight .5) + recordMistake. onSignatureStuck -> the 'atom' offer is already queued; the deliberate.jitAtom handler must cope with a concept that has no cached atom. onAllVisibleGreen may fire again after a regression and re-green, so make it idempotent. onHiddenResult: pass -> criteria met, flash, whatIf.run, completeTask (polish review only when deliberate.polishReview is on); fail -> show r.card, record transfer evidence (wrong) on r.spec.conceptId (task.spec.overfit is already set), stay in building. onLoadError(n) -> the nudge is already on the line; optionally show n.message in the card.
5. Register the commands: deliberate.jitAtom(conceptId, specId) opens the atom (mechanism 6), and deliberate.predictOwn -> predict.run({...ctx, via:'key', cursorLine}) (it reuses the current offer). Set context key deliberate.building.
6. Own code: const predict = new PredictFlow({ ...host-like deps, runner: () => runnerFor(lang), allowRun: () => consent==='all' && isTrusted, harnessDir, annotations, actions, ask: new VscodeQuestionPort(), lock: interactionLock }, r => { if (r.status==='answered') { if (r.evidence) recordEvidence(learner, r.evidence); task.ownProbes.push(r.probe); if (r.mismatch && atomCached(r.conceptId)) enqueue the atom offer; keep r.hintLine for the hint prompt when via==='pre-hint' } }). Call predict.offer(ctx) when the scheduler allows (ctx.visible/hidden = task.spec specs, mappedNames, asked = task.ownProbes, conceptId = weakest task concept). What-ifs: new WhatIfFlow({...same, strike: new VscodeStrike()}).run({ ...ctx, count: whatIfCount(task.notUnderstood), weakestTag, journal: learner.mistakes, conceptForTag, allFluent }) -> push res.whatIfs into task.whatIfs and record res.evidence. Conflict flag: task.notUnderstood = conflictFlag({ ownProbes: task.ownProbes, specsFast: specsGreenFast(task.spec, { activeMs }) }). Model probes (no ladder only): if (modelProbeTrigger.onSave(file, fnNames, now, { building, hasLadder })) enqueue a low-effort bg job (priority 2) with ownCodeProbePrompt(...) + OwnCodeProbeSchema, and pass the results as ctx.modelProbes. Call modelProbeTrigger.reset() on a new task.
7. Gate: const res = await new GateUi({ lock: interactionLock }).run({ id, title, number }, task.gate /*patterns, plans*/, { fade: task.fade, priorFlawedTasks }). Then: record res.evidence; set task.gate.result = res.record; persist res.flawedTasks. If res.flash, flash it for 3 s. Put res.notes on the sidebar log card. res.required = pending pattern list. routing = gateRouting(res, prep, learner, task.conceptIds, now) -> open routing.atoms, pass routing.jit to specs.attach/addDeferredConcepts. Then flash res.goBuild, set phase 'building', monitor.startTask(), executeCommand('workbench.action.focusActiveEditorGroup'). On kind 'own-plan', focus the composer in explain mode. On 'no-pack', show res.card and go build. 'busy' -> enqueue a 'gate' action. If res.guideApproach, show the guideApproach card.
SHELL: merge docs/stage2/buildloop.package.json (predictOwn command + ctrl+alt+p keybinding, jitAtom command hidden from the palette, setting deliberate.polishReview default false). The gutter icons media/gutter-{pass,fail,offer}.svg already exist and annotations.ts trusts deliberate.predictOwn for hover links.


# coach tests=True count=52
## deviations
Results:
- Full suite: 771/771 tests pass.
- My new tests: 52 (flow 36, prefetch 14, context 2).
- tsc is clean for everything I own. The only remaining errors are in src/extension.ts and src/view.ts, which still call coach methods I deleted (speedDrill, maybeRecall, answerRecall, skipExplain, answerDiagnostic, skipRecall) and the old Coach(store, llm, monitor) constructor. Those files belong to the shell engineer.
- No prefetch.ts or coach work existed from the interrupted attempt, so everything was written fresh.

Deviations and choices:
1. **Task fields are optional in the stored type.** The new Task fields (interface, fade, solo, ownProbes, whatIfs, atomRuns, the paste/assist counters) are optional. Stored v0.1 projects and the stage-1 test helper in test/learner.test.ts lack them. normTask()/normProject() fill defaults on load, so coach code always sees them set.
2. **FollowUpSchema is now TaskOutSchema plus why.** It gains an interface, so follow-ups can get their own TaskPrep and spec ladder. The spec said FollowUpSchema is unchanged.
3. **Stage-1 test edit.** I edited test/schemas.test.ts: its assertion that the legacy PlanSchema still parses now asserts that PlanSchema, DiagnosticSchema, LessonSchema and RecallSchema are gone, since my assignment deletes them.
4. **TaskPrep jobs use 'project' scope, not 'task'.** TaskPrep for tasks 1-3 is enqueued before task 1 starts, and startTask bumps taskSwitch, so task scope would always drop it. Instead the apply checks each task: a part attaches to a task that has not started yet, or to the current task (a late prep, whose specs attach at once). A part for a task the learner has left is ignored and marked failed, so reconcile re-preps it. Tested.
5. **Repair calls are not budgeted.** The spec-ladder repair and the AtomPack repair run inside their parent job as direct calls. A nested background job could deadlock at concurrency 1, so these calls do not count against the hourly budget.
6. **The private reference never leaves the prep job.** It is not stored, not logged, and not sent back in the repair prompt. The repair prompt asks for an empty reference unless the reference itself was wrong, and specsCore then keeps the original.
7. **Prompt text additions.**
   - PlanOutline appends one line after the spec text: 'Files already in the workspace: ...'.
   - TaskBatch adds a context header (concept ids, done titles) before the spec's task rules.
8. **On-demand hints run in the foreground lane at low effort** (the spec lists 'hint on a miss' under foreground). An in-flight speculative job for the same task is awaited first, through bg dedupe raised to priority 0.
9. **Rung 4 is in coach.ts.** The pad has no 'skeleton' mode, so padSkeleton(pad) builds rung 4 from AtomPad's public flow API (beginFlow, openSession, show a snippet render, Ctrl+Enter closes) under the lock 'skeleton'. It never touches project files.
10. **Explain-back fallback.** With no runtime or no probe, or when the conflict flag is set, the task goes to phase 'explain-back' with a composer question. Submit or Skip completes the task at once; the grade lands later in project scope.
11. **Degraded paths are applied where results are used**, not inside onDeadlineMissed:
    - task start with no prep: the 'Plan it in your head' card and a late TaskPrep;
    - routing with no cached atom: a JIT offer, with a pack queued;
    - milestone end with no tasks: a 'next milestone is being prepared' card and a sprint offer.
    Prefetcher records misses (isLate) and calls onLate. The coach only flashes when the current task's prep is late.
12. **Usage-limit flash is off by default in the Prefetcher** (the optional flash dep), because TempoBar already flashes LIMIT_FLASH.
13. **The coach owns every PredictFlow.run call** (Ctrl+Alt+P and the pre-hint step), so construct PredictFlow without onResult.
14. **Teach while building** never opens the pad when nothing is cached. It queues a 'preparing <concept> drill' tempo action, builds the mini atom through the foreground lane, then offers the atom.

Not done:
- **Languages outside python/javascript/typescript** (go, java, rust, other) get no placement, pad, specs or own-code probes. Teach shows a short foreground lesson card. The probes-only seed pack for those languages is not implemented: AtomCache and Stock only take python/javascript/typescript.
- **Pace metrics:** streak is not computed. The rest is there: bits per task, solo unaided rate, share of hints served from the prefetch, deadline misses, active minutes and model wait per milestone.
- **vscodeCoachHost** has not been run in a live VS Code host; it typechecks against the 1.93 typings.
## notesForNext
SHELL (extension.ts). Build in this order:
1. Basics:
   - `store = new Store(ctx)`
   - `llm = new Llm(ctx.secrets, ctx.languageModelAccessInformation)`
   - `monitor = new Monitor()`
   - `lock = new InteractionLock()`
   - `let coach!: Coach; const jobs = new JobQueue({ concurrency: cfg.get('backgroundConcurrency', 2), callsPerHour: cfg.get('backgroundCallsPerHour', 20), currentGen: () => coach.gen(), log })`
2. Surfaces, per surfaces/pad/buildloop notes: annotations, `hintDisplay = new HintDisplay(annotations)`, `tempo = new TempoBar({ state: () => coach.tempoState(), jobs, lock, monitor, log })`, caches, runners, stocks, pad.
   - For the pad, use exactly the pad notes' hooks: `lesson: (r) => coach.escalationLesson(r), onLog: (c) => coach.pushLogCard(c), onExit: (r) => coach.onAtomExit(r), markProgress: (n, w) => coach.markProgressIfBuilding(n, w)`.
3. `specs = new SpecController({ ...vscodeSpecHost(), annotations, actions: tempo, harnessDir, specDir, verifyDir, conceptInfo, activeMsSince: (w) => coach.activeMsSince(w), commands: { jit: 'deliberate.jitAtom', ladder: 'deliberate.open' }, log })`.
   - Do NOT set specs.on: the Coach constructor assigns it.
4. Own-code flows and the gate:
   - `predict = new PredictFlow({...})` with NO onResult callback.
   - `whatIf = new WhatIfFlow({..., strike: new VscodeStrike()})`
   - `gate = new GateUi({ lock })`
5. Construct the coach:
   - `coach = new Coach({ store, llm, monitor, jobs, lock, tempo, specs, predict, whatIf, gate, hints: hintDisplay, pad, log, ... })`
   - `host: vscodeCoachHost({ monitor, globalStoragePath: ctx.globalStorageUri.fsPath, focusComposer: (m) => view.focusComposer(m), functionNames: async (f, t, l) => (await documentFunctions(vscode.Uri.file(f), t, l)).map((x) => x.name) })`
   - `runtime: { runner: (l) => (snippetConsent && vscode.workspace.isTrusted ? runners[l] : undefined), allowRun: () => consent === 'all' && vscode.workspace.isTrusted }`
   - `caches: (l) => caches[l], stocks: (l) => stocks[l], prefetchDeps: { specs, contentLog: (l) => contentChannel.appendLine(l) }`
   - `placement: (l) => (stocks[l] ? new PlacementRun(pad, stocks[l]) : undefined)`
   - `sprint: (l) => (stocks[l] ? new Sprint({ pad, stock: stocks[l], best: { get: () => ctx.globalState.get('deliberate.sprintBest'), set: (v) => void ctx.globalState.update('deliberate.sprintBest', v) } }) : undefined)`
   - `skeleton: padSkeleton(pad)`
6. Push coach, jobs, lock and coach.prefetcher (`{ dispose }`) into ctx.subscriptions.
7. On activation:
   - `void coach.reconcile()`
   - after runtime discovery and `stocks[l].ensureStock()`: `coach.offerWarmup()`
   - delete `setTimeout(maybeRecall)` and the old renderStatus status item.
8. Events:
   - monitor.onSave: call `specs.onSave({ uri: e.uri.toString(), fsPath: e.uri.fsPath, reason: saveTrigger(e.reason), errorCount: e.errorCount })`, then `void coach.onSave({ uri: e.uri.toString(), fsPath: e.uri.fsPath })`.
   - `monitor.onInsert((e) => coach.onInsert(e))`
   - onDidChangeTextDocument → `specs.onEdit` / `predict.onEdit` / `whatIf.onEdit` (buildloop notes).
   - Consent or trust change → `coach.setAllowRun(allowed)`.
   - Config change → `jobs.configure({ concurrency, callsPerHour })`.
   - When a spec turns green, also call `monitor.notePause('spec-green')`. The coach already clears the hint on green.
9. Commands:

   | Command | Handler |
   |---|---|
   | deliberate.hint | coach.hint() |
   | deliberate.gotIt | coach.gotIt() |
   | deliberate.teach | coach.teach() |
   | deliberate.checkWork | coach.checkWork() |
   | deliberate.reveal | coach.reveal() |
   | deliberate.sprint | coach.sprint() |
   | deliberate.warmup | coach.warmup() |
   | deliberate.practiceWhileWaiting | coach.practiceWhileWaiting() |
   | deliberate.retryPlan | coach.retryPlan() |
   | deliberate.gate | coach.openGate() |
   | deliberate.placement | coach.placement() |
   | deliberate.jitAtom (conceptId) | coach.jitAtom(conceptId) |
   | deliberate.predictOwn | coach.predictOwn(vscode.window.activeTextEditor?.selection.active.line) |
   | deliberate.ask | coach.askCoach(q) |
   | deliberate.newProject | confirm, then coach.newProject() |
   | deliberate.resetProfile | confirm, then coach.resetProfile() |

   Remove deliberate.speedDrill.
10. Merge docs/stage2/coach.package.json; read its `_notes`. maxFollowUps default becomes 2; deliberate.sprint and its keybinding are already in pad.package.json.

VIEW (view.ts):
- Card command routing:

  | Card command | Handler |
  |---|---|
  | hint, teach(arg), checkWork, gotIt, imFine, reveal, noIdea | coach methods of the same name |
  | startTask(arg) | coach.startTask(arg) |
  | sprint | coach.sprint() |
  | warmup, practiceWhileWaiting, retryPlan, skipExplainBack, buildNow | coach methods of the same name |
  | jitAtom(arg) | coach.jitAtom(arg) |
  | newProject | deliberate.newProject |

- Delete skipExplain, diagnosticSkip, speedDrill, skipRecall and the answerRecall cardInput.
- Add `focusComposer(mode)`: reveal the view, then post `{ type: 'focusComposer', mode }`.
- coach.onChange and coach.onStatus have vscode.Event-shaped listeners.

WEBVIEW (main.js):
- Composer label:
  - use `state.input.label` when present;
  - MODE_LABELS add: placement, waiting, atom ('Practice open in the editor'), gate ('Answer in the popup (or explain your own plan)'), explain, explain-back;
  - remove the diagnostic and check modes.
- Busy bar:
  - `status.busy` is the foreground label;
  - `status.background` gives 'n preparing in background';
  - when `status.practiceWhileWaiting` is true, show a 'Practice while you wait' button (command practiceWhileWaiting).
  - While busy, disable only Ask, Reveal, Check my work and Teach.
- Card kind 'log' is a compact one-liner.
- Roadmap tab:
  - 'Sprint (3 min)' replaces Speed drill;
  - show `milestones[].preparing` and `tasks[].solo`;
  - show `project.planError` with Retry.
- Task header: `task.interface` and `task.ladder` (titles, summary, next).
- Progress tab:
  - per concept: chip, P%, inferred, misconceptions[] (belief, status 'fixing' or 'active');
  - deck, calibration.text, audits, pace.
- Onboarding copy as in spec removeOrShrink.


# shell tests=True count=33
## deviations
Verified: tsc --noEmit is clean. npm test passes 804/804; 33 of those tests are mine: shell.test.ts 26, activation.test.ts 2, webview.test.ts 5. verify:seeds passes for python (3.14.0), javascript and typescript (Node 24.11.1). node esbuild.mjs builds. npm run package ran end to end and produced C:\ast\deliberate-coach-0.2.0.vsix (31 files, 546 KB; media/seed, media/runner, media/harness and syntaxes are included; src, test, scripts, docs and *.vsix are not). The activation smoke test passes against a fresh esbuild bundle and against the production dist/extension.js (SMOKE_BUNDLE=dist/extension.js).

The smoke test uses a permissive Proxy vscode. Every vscode.X name the sources use, plus the listed namespaces, is an own enumerable member. It checks:
- every command declared in package.json is registered, and every registered deliberate.* command is declared;
- keybinding and palette commands exist;
- the webview HTML has a nonce CSP and no unsafe-inline, and the 'ready' message posts state;
- all command and provider registrations are released on dispose;
- there are no unhandled rejections;
- with consent 'all' saved, real seed stock is instantiated (423 python, 357 js and 366 ts items) and atoms/python.json is flushed on deactivate.

Deviations and additions:
1. package.json declares capabilities.untrustedWorkspaces = limited. Without it VS Code disables the extension in Restricted Mode, and v0.1 was disabled there. The spec's 'execution needs isTrusted; re-check on onDidGrantWorkspaceTrust' only works if the extension runs while untrusted. In an untrusted workspace nothing runs.
2. Consent 'Not now', or dismissing the modal, means off for this session only and nothing is saved. The modal comes back at the first need in a later session. New command deliberate.chooseExecution ('Choose What Practice May Run Locally') re-picks the choice and saves it to globalState. If deliberate.localExecution is not 'ask', it says the setting overrides the choice.
3. New command deliberate.showLog opens the 'Deliberate' output channel.
4. The consent modal fires before these actions: startProject, teach, jitAtom, noIdea, checkWork, startTask, sprint, warmup, practiceWhileWaiting, placement, predictOwn. It is never shown at activation, never in an untrusted workspace, and never when no runtime was found. Before showing it, the shell waits for runtime discovery for at most 8 s.
5. Spec re-attach. Coach.setAllowRun(true) only flips SpecController.allowRun, and a ladder attached before consent has no runner. The shell wraps SpecController in a SpecsLike port that remembers the last attach. When consent, trust or a new runtime makes learner code runnable, it re-attaches the current task's ladder with the runner (not when the reason is DESIGN_DIFFERS). The same port refreshes the Testing view (SpecTestView.show) in the background after each attach. coach.ts was not edited.
6. Spec-green pause. The coach never calls monitor.notePause('spec-green'). The shell does it from SpecController.onDidRun when a spec newly passes, using the pass set seeded from task.spec.last at attach.
7. Stock:
   - Activation stocks the project language only. With no project, it stocks every language that has a runtime (all three when none, as neutral items).
   - While consent is undecided or off, the neutral unverified items are stocked. mergeAtoms replaces them with verified seeds once snippets are allowed, because stocking re-runs when consent changes and when the project language changes.
8. Pace. The coach's PaceData lacks start-to-first-keystroke, concept block times and model wait per task, so the shell computes them (shell.paceExtras) and the view merges them in as state.shell.pace:
   - the first keystroke is recorded in workspaceState: the first file edit while task 1 is building, keyed by project.createdAt;
   - block times are medians of task.atomRuns by path;
   - wait per task is the median waitMs of finished tasks;
   - solo tasks give a count, the unaided rate and median active minutes.
   The Progress tab asks for coach.refreshPace() when it opens.
9. CSP fix. The v0.1 webview used inline style="width:..." attributes, which its own CSP (no unsafe-inline) blocks. Widths and indents are now data-w / data-indent attributes applied through the CSSOM. The CSP and nonce are otherwise unchanged; the nonce now comes from crypto.randomBytes.
10. Busy semantics in main.js:
   - While a foreground call runs, only these are disabled: Ask (composer submit in ask-like modes, and 'Ask instead'), Reveal, Teach, I have no idea, and Check my work when the task has no applicable ladder.
   - Hint, gate submissions and the other buttons stay enabled.
   - The busy bar shows the foreground label, 'n preparing in background' (running + queued), a 'background prep paused' note, and the Practice while you wait button driven by coach statusInfo().practiceWhileWaiting.
11. Inline AI offer:
   - It shows once per workspace while a task is building, when an inline-AI extension is active and editor.inlineSuggest.enabled is true. It is checked on coach changes and on extensions.onDidChange, and skipped when no folder is open.
   - Turn off here sets the value at ConfigurationTarget.Workspace.
   - deliberate.newProject removes our override and re-arms the offer for the next project.
12. Atom caches are written atomically (temp file plus rename, with retries, then an in-place write). A file with corrupt JSON is renamed to *.corrupt-<ts> and logged.
13. activate() returns { ready } for tests, which becomes the extension's exports.

Not done or not verified:
- Nothing ran in a real VS Code window; only the Proxy stub was used.
- deliberate.nameNewMisconceptions is in package.json (default false), but no module reads it: the MisconceptionGuess flow is not wired in coach.ts or prefetch.ts.
- The 'Practice while you wait' visibility uses the coach's statusInfo, which checks that a Sprint can be built but not Sprint.available(2) >= 2.
- No stage-1 files and no files of the other stage-2 engineers were edited.
## notesForNext
1. Live test in an Extension Development Host (F5). None of these were exercised outside the Proxy stub:
   - the consent modal and the chooseExecution QuickPick;
   - pad keybindings (Ctrl+Enter, y/n, 1/2/3, Esc Esc);
   - status-bar pops;
   - the Testing view (continuous run profile);
   - comment-thread hints;
   - the inline-AI offer with Copilot active;
   - the webview in light, dark and high-contrast themes.
2. To smoke-test any bundle: SMOKE_BUNDLE=dist/extension.js npx tsx --tsconfig test/tsconfig.json --test test/activation.test.ts. Add SMOKE_VERBOSE=1 to print the output channels.
3. If the coach later implements the nameNewMisconceptions enrichment, read the setting through CoachHost.config(); package.json already declares it.
4. If the coach starts calling monitor.notePause('spec-green') itself, remove the specs.onDidRun pause in extension.ts so the pause is not reported twice.
5. Coach.setAllowRun does not re-attach the spec ladder; the shell's specsPort.reattach covers that today. If coach.ts gains its own re-attach, remove reattachSpecs from extension.ts.
6. The old deliberate-coach-0.1.0.vsix is still in the repo root; .vscodeignore excludes *.vsix, so it is not packed.
