

# vision

Deliberate stops being a sidebar you read and becomes a fast loop you do inside the editor. Every concept is an 'atom' that starts with a question instead of an explanation. The learner predicts what a few lines print and types the answer on the answer line of a practice tab. No autocomplete, AI suggestion or language server can see that tab. Ctrl+Enter submits, and a type-aware comparer grades the answer in about 200 ms against output recorded by actually running the code on the learner's own machine. A learner who already knows the concept answers two items on different surfaces and is through in about 25 s. Mastery itself is granted only after they have also written the pattern, in a completion item or a spec in their own task, so one lucky reading never counts as knowing.

A wrong answer can match a 'misconception mutant': a copy of the code, also run in advance, that behaves the way one specific wrong belief predicts. On a match the learner gets a one-key 'Did you think <belief>? y/n'. A yes leads to an active contrast pick, a reveal with a line-by-line state trace for state concepts, and a re-test on a different surface. The belief counts as cleared only after delayed, unlabelled re-checks.

Patterns, which is how this learner thinks about coding, are first-class. Shape concepts teach a reusable code template; semantics concepts teach a rule about how code runs. Both go into a Pattern Deck that comes back in interleaved sprints, alongside items on reading tracebacks. Fundamentals come from bundled parametric templates that produce unlimited fresh variants at no model cost.

Tasks become ladders of 3-6 behaviour specs that run on save, sandboxed in a temp folder, and turn green one at a time. The scaffolding (gate, plan choices, spec titles) fades as the learner's decomposition skill grows. One solo task per milestone measures real transfer.

The model is never between the learner and their next action. It works one step ahead in a throttled background lane at about 2-3 calls per task. Its content is checked by running it locally, and its open-ended judgements are graded in the background. Model waits on the learner's path drop from about 3-5 minutes per task to under 5 seconds. Every interaction records typed evidence into one Bayesian learner model, in which no single item can move a concept's estimate by more than a capped amount. That model pins each gap down to a single belief, behaviour or line of the learner's code.


# coreLoop

GOAL TO MASTERY, with time budgets (in seconds unless stated; the budgets assume a beginner)

0. Start (0-20):
   - The learner types a goal (and optional background) and presses Start.
   - The language comes from the workspace, the goal text, or a one-key QuickPick. It is fixed input to every prompt.
   - Runtime detection and seed instantiation run locally (1-2).
   - PlanOutline (medium effort, about 40-70) starts in the background. Nothing waits on it.

1. Placement blitz (0-180, overlapping PlanOutline and then TaskPrep for tasks 1-3):
   - Optional 'tick what you've used' QuickPick (8 or less; Esc skips).
   - Item 1 is a typing calibration: copy a short literal (5-8). It sets the learner's typing speed for par.
   - Then 8-14 adaptive predict items in the Atom Pad, an in-memory practice tab beside the code.
     - Items are drawn from parametric seed instances run on this machine.
     - The header is generic and never names the concept.
     - Each takes 10-20 and is graded locally in under 0.3.
     - Ticked concepts start at the DAG leaves.
     - The last 2 items are completions.
   - No teaching. A wrong answer shows the actual output for 1.5. A mutant match is stored as an unconfirmed candidate misconception.
   - Placement stops when any of these happens:
     - every concept needed by tasks 1-3 is classified
     - 14 items, 4 minutes, or Esc
     - the experienced fast lane: 3 correct leaf items in a row under par, one of them a completion
   - The summary is one status flash and one compact card (about 5 to read).

2. Task start (0-45):
   - The task card is 2-4 lines: what to build, the interface (file and signatures, fixed by the plan), and the spec titles the fade level allows.
   - The gate runs only when all of these hold. Otherwise it costs 0.
     - the task brings in an unmastered concept that no earlier task used
     - it is not a solo task
     - decomposition P < 0.8
   - Step A: pick the needed patterns from 5 names (15-20).
   - Step B, only while decomposition P < 0.5: pick 1 of 3 plans of 10 words or fewer (15-20). Step A's feedback goes in its title.
   - The gate shows at most 50 words in total and is graded locally from the prefetched key.
   - 'I'd do it differently' on either step skips it without penalty.

3. Gap repair, at most 120 before building:
   - These each open one atom, up to 2:
     - a missed required pattern whose concept has P below 0.5
     - a flawed plan pick
     - a task concept with a candidate misconception
   - Atom cost:
     - known concept: 20-30 (2 predictions on 2 surfaces)
     - misconception: 40-70
     - unknown concept: 70-120 (large topics are split into sub-atoms)
   - Other gaps become just-in-time offers on the spec that needs them (step 4) instead of waiting for the stuck detector.

4. Build (5-15 minutes per task, growing to 20-30 as scaffolds fade; the learner writes all the code):
   - A manual save runs the spec ladder in a sandboxed temp folder (under 1; 'running specs...' when imports are heavy).
   - An auto-save runs the specs only after 1.5 idle with no errors.
   - Only the next red spec is reported. A known failure signature puts a one-line question on the function's def line (0 wait).
   - Just in time: when the next red spec's concept has P below 0.5, the tempo bar shows 'next: <spec> uses <pattern> · 60s drill? Alt+N' (20-120 if accepted).
   - The tempo status item always shows the single next action (Alt+N or click).
   - At natural pauses, at most once per 3 active minutes, a 'predict parse_row("a,,b")' offer appears in the tempo bar (15-20).

5. Stuck (help is ready the moment it is needed):
   - At stuck score 0.6 the hint ladder (rungs 1-3) is prefetched in the background, keyed by task.
   - At score 1.0 or Ctrl+Alt+H, help comes in this order:
     (a) a persistent error first gets the local rung 0: 'Which line does the trace point at, and what does <ExceptionName> mean?' (0 wait)
     (b) predict one call of your own function (15-20, graded by running it)
     (c) rung 1 on the anchored line, or in a comment thread if it is long (0 wait)
     (d) rung 2 runs that concept's atom (20-120)
     (e) rung 3 gives plain-language steps
     (f) rung 4 is a skeleton in the pad, never in the project
     (g) rung 5 is the smallest piece
   - Solo tasks stop at rung 2.

6. Done (20-70):
   - When every visible spec is green, hidden specs run (under 1). A hidden failure shows the failing call and the learner's result, and the task stays open.
   - 2 what-if mutants on the learner's own lines (15-30 each) replace the free-text explain-back. They are skipped when every task concept is Fluent.
   - The next task starts at once.
   - A follow-up task is created only if the weakest concept is below P 0.6 or has an active misconception, with at most 2 in a chain.
   - The last task of each milestone is a solo task: no gate, no spec titles, hints capped at rung 2.

7. Spacing (at most 15% of active time):
   - A warm-up sprint at session start (at most 60) is offered in the status bar.
   - Sprints fill model waits over 3 that the learner started outside building. During building they are only offered.
   - Sprint items interleave concepts under generic headers:
     - delayed misconception checks
     - mastery audits
     - due and fragile items
     - traceback items (1 in 5)
     - which-pattern picks from the Pattern Deck
   - No exact item repeats within 7 days.

8. Mastery:
   - A concept is mastered when all of these hold:
     - P(known) of at least 0.85
     - correct answers on 2 or more surfaces
     - a production item: a completion, or a spec green earned cleanly
     - coverage of the tag's common misconceptions
     - no active or recently corrected misconception
     - not fragile
   - Alternatively, it can be inferred from 2 or more tested descendants, one of them with production evidence.
   - A delayed production audit re-checks it 1 or more days later. A miss revokes mastery.
   - It becomes Fluent when it holds in a sprint 1 or more days later with latency at or under absolute par. From then on the concept costs 0 in gates and what-ifs and is never re-taught.

Typical totals:
- Start to first keystroke in task 1: 4 minutes or less (today 10-15 minutes).
- Known concept 20-30; misconception 40-70; unknown concept 70-120 (today 4-6 minutes per lesson plus its check).
- Per-task overhead (gate, pre-build atoms, what-ifs): about 90 median early on, shrinking as gates are skipped for reused concepts and scaffolds fade.
- Model wait on the critical path per task: about 0-5 (today about 3-5 minutes).


# conceptAtom

DEFINITION: one atom = one concept, keyed by canonical tag (or a sub-tag for large topics).
- It teaches one pattern (shape concepts: a reusable code template) or one rule (semantics concepts: how the program runs, e.g. alias-copy, scope, truthiness).
- All content is run locally before first use.
- Nothing is read before the first question.

SOURCES:
- Fundamentals: bundled parametric seed templates with typed slots, instantiated and run on the learner's own runtime. They give unlimited surface variants and curated mutants with hand-written beliefs, at no model cost.
- Other tags and project concepts: model AtomPacks, verified locally (mechanism 5).

PARTS (stored per language in globalStorage):
- Card. Shown only at exit or after a miss, never first.
  - shape: name (canonical, 5 words or fewer), useWhen (12 or fewer), template (3 lines or fewer with <holes>), pitfall (12 or fewer)
  - semantics: name, rule (12 or fewer), howItRuns (20 or fewer), pitfall
  - useCases: 6 or more one-line problems of 12 words or fewer, never the same one twice within 7 days
- Probes: predict-the-output items.
  - Model packs need 4 probes in 4 sibling groups (a group = one surface: names, data, story). Seeds give unlimited instances (group = template family x theme).
  - Code is 8 lines or fewer, deterministic, and prints 1-4 lines (200 characters or fewer).
  - Type-sensitive tags print repr()/type() or JSON.stringify/typeof, so a str and an int print differently.
  - Computed locally: the constructs used, the answer-space guess rate, and (Python, state tags) a per-line variable trace.
  - parSec is thinking time (3-8). Par itself is computed locally: reading + typing at the learner's measured speed + thinking.
  - Each probe carries 1-3 executed misconception mutants: {misconceptionId, belief (12 words or fewer), refutation (25 words or fewer, no output values), single-line diff, recorded output, source curated|model, confirmation counts}.
  - Mutant outputs must differ from the original and from each other. Equal ones are marked ambiguous and never name a belief.
- Worked example: 5-8 lines, a subgoal label (6 words or fewer) on each meaningful line, and its real output. Large topics get 2 examples on different surfaces.
- Completion item: 6-10 lines on a new surface, parSec 20-40.
  - The pattern sits inside a function, with 1-2 blanks at the pattern lines.
  - A hidden harness calls it with 2 or more inputs through check().
  - 1-2 wrong fills are tagged with misconceptions.
  - A constant fill is verified to fail.
- Contrast pair: two snippets of 4 lines or fewer that differ in one feature, their real outputs, and a rule of 12 words or fewer. Used as an active pick.
- Traceback items: generated from raising mutants and templates (mechanism 9).

READING BUDGET: 60 words or fewer per atom on any path, not counting code or values.
- The misconception path uses 53: generic header 4 + belief 12 + rule 12 + refutation 25.
- The only exception is escalation, which uses a lesson of 120 words or fewer.

ITEM TYPES AND GRADING (all local, under 300 ms):
- predict (typed). The learner types the output after '# -> ' or '// -> '. Further lines go on more '# -> ' lines or after ' | '. The pad never says how many lines are printed.
  - compareOutput is type-aware:
    - Python answers are parsed as Python literals: 2 differs from 2.0 and a tuple from a list; sets and dicts compare order-free; quotes and apostrophes are handled by a real parser.
    - JS answers are parsed with a JSON5-style parser and compared with the captured values, so spacing never matters.
  - Verdicts: correct, wrong, don't know, or format-only.
    - Format-only means the right value in the wrong notation, e.g. 'hi' with quotes for a printed str, or a tuple written as a list.
    - It records no evidence and shows a one-line note: 'right idea; Python writes it as ...'.
    - It counts as wrong under type-sensitive tags, or when a mutant prints exactly that answer.
  - Mutant match: strict comparison against each mutant's output. There is no match for the bare answer 'error', for an answer within edit distance 1 of the actual output (a slip), or for ambiguous outputs.
  - A raising probe is answered with the exception name.
  - An empty answer re-prompts. '?' means don't know.
  - Guess rate comes from the answer space: boolean .5, exception name .25, small integer .2, short token .12, other .06, several lines .04. No item moves the odds by more than 6x.
- completion (produce). The learner fills snippet tab stops.
  - Grading: run the document plus the harness in the batch runner; exit 0 = pass.
  - The failing check is found by its 'CHECK' marker and shown inline on the blank's line.
  - A document equal to the code with a tagged wrongFill names that misconception.
  - One retry. On the second fail the fill is revealed, which is allowed because this is scratch code, not the project.
- contrast-pick: '# Which one prints [2, 3]?  1 / 2', answered with one key. Guess rate .5.
- traceback: code plus its real trace. The learner answers with the failing line and the exception name, then picks 1 of 3 meanings.
- which-pattern (sprints only): a QuickPick of 4 deck names for a one-line use case. Distractors come from tags that are not valid alternatives. Guess rate .25.

CONFIDENCE:
- Keys: Ctrl+Enter is a neutral submit; Ctrl+Shift+Enter means 'I'm guessing'; '?' means 'don't know'.
- A guess is also inferred when latency is under 0.3x par, or when the answer copies a literal of 5 or more characters from the code.
- Honesty never costs time:
  - a flagged correct answer counts as correct, with P capped at .8 and one later interleaved item; it is not marked Fragile and adds no steps now
  - '?' takes the same path as an unmatched wrong answer
- Latency runs from render (window focused) to submit. It is discarded if focus was lost or it exceeds 60 s.
- Fragile is never set from latency during the learner's first 15 items.

STEP MACHINE:
- ROUTE:
  1. If the concept has a misconception that is active, suppressed and due, or a candidate with p >= .3 (for example from placement): go to BELIEF-CHECK(M), or straight to REFUTE(M) if M is already confirmed.
  2. Otherwise go to UNKNOWN if P < .15 with full-weight wrong evidence, if placement got a don't-know, or if the learner self-rated 'not used' and has no correct evidence.
  3. Otherwise go to PROBE.
- PROBE (8-20 s): one predict item from an unseen sibling group whose other constructs the learner knows, under the generic header '# what does this print?'.
  - Correct (flagged or not): PROBE2. Exception: if the concept already holds a correct non-guess answer from another group in the last 7 days, EXIT 'tested-out'.
  - Format-only: show the note, record no evidence, then PROBE2.
  - Wrong and matches mutant M: BELIEF-CHECK(M).
  - Wrong with no match, or '?': UNKNOWN.
- PROBE2 (8-20 s): a predict item from another unseen group.
  - Correct and not guessed: EXIT 'tested-out'. P stays capped at .8 until production evidence arrives (the task's first clean spec green on this concept, or a sprint completion).
  - Otherwise, as in PROBE.
- BELIEF-CHECK(M), about 3 s: 'actual: X' appears on the answer line, then '# Did you think: <belief>?   y / n'.
  - y: REFUTE(M), with misconception odds x6.
  - n: treated as a slip. Half-weight wrong evidence, no misconception update, and one more PROBE on another group. A second miss goes to UNKNOWN.
- REFUTE(M), 25-40 s:
  - CONTRAST-PICK (about 5 s): both snippets without their outputs, under '# Which one prints X?  1 / 2'.
  - REVEAL (about 10 s): both outputs as '# prints: ...', '# Rule: <rule>', and the refutation on the changed line. For Python state tags, each line also shows its variable values as after-text ('a=[1, 2]  b is a'). Ctrl+Enter continues.
  - RE-PROBE (10-20 s): a predict item from a different sibling group that also carries M.
    - Correct: EXIT 'fixed'. M becomes suppressed, not cleared (learning transition .3, odds x.25).
    - Wrong: the escalation lesson is requested in the background now (about 10 s) while a SECOND SIBLING item from another group runs (20-40 s).
      - SECOND SIBLING correct: EXIT 'fixed'. M is suppressed and the lesson stays cached.
      - SECOND SIBLING wrong: ESCALATE.
- UNKNOWN (70-120 s):
  - Worked example under the header '# Pattern: <name> - <useWhen>' (or '# Rule: <rule>'), with subgoal labels as end-of-line text. Read for up to 15 s, then Ctrl+Enter. Large topics get a second example on another surface.
  - Completion item with 1 blank. Large topics then get a 2-blank one.
  - Predict item on a new sibling group: EXIT 'learned' if correct, or 'partial' if wrong (review in 10 min).
- ESCALATE: the lesson of 120 words or fewer, aimed at the confirmed belief M, appears as a comment block above a fresh completion item.
  - If the lesson has not landed yet, the pad shows '# preparing a short lesson... (~10 s)'. No sprint is ever nested inside an atom.
  - EXIT 'escalated' with a same-day review.
- CAPS: 7 graded items or 150 s, whichever comes first. The clock pauses during ESCALATE, which has its own 150 s limit.
- Double-Esc exits at any point and keeps the evidence. Unseen steps are not penalised.

PASS/FAIL RULES:
- The atom passes when its final graded item is correct and not flagged as a guess.
- A concept counts as MASTERED only when all of these hold:
  - P(known) >= 0.85
  - no misconception that is active, suppressed (Fixing), or a candidate with p >= .3
  - not fragile
  - correct non-guess answers from 2 or more sibling groups, and 1 or more production items (a completion pass, or a spec on this concept turning green within 3 saves without assisted inserts)
  - coverage: those items carried mutants for every taxonomy misconception of the tag with prior >= .2 that the bank has verified items for
  - or, in place of the last two conditions: the concept is inferred-mastered, with support from 2 or more tested descendants, one of them with production evidence
  Until then, P is capped at .8.
- Delayed audit: every mastered concept gets one production item in a sprint 1 or more days later. A miss revokes mastery and sets P to .6 or lower.
- Misconception lifecycle:
  - CANDIDATE on the first match.
  - ACTIVE with matches from 2 or more sibling groups and p > .6.
  - SUPPRESSED after an immediate correct re-probe. It is still scheduled and still blocks mastery.
  - CLEARED only after 2 delayed hits on items carrying its mutant: the first 10 or more minutes later in an unlabelled interleaved sprint, the second 1 or more days later.
  - A later match relapses it to active.
- A concept is FLUENT when it is mastered and the median latency/absolute par of its last 3 correct answers, spread over 2 or more calendar days, is at most 1.0.
- EXIT always does the following:
  - saves the in-memory pad (no prompt), closes its tab, and restores the previous editor and selection
  - updates the Pattern Deck
  - flashes '<concept>: <old state> -> <new state> (41s)' in the status bar; this flash and the log card are the only places that name the concept
  - writes one compact sidebar log card


# latencyStrategy

PER-TASK CALL BUDGET (designed to 4 or fewer background calls per task; expected about 2.5)
- TaskBatch: 1 per milestone of 3-6 tasks (about 0.25 per task).
- TaskPrep (gate + spec ladder for up to 3 tasks): about 0.35, plus repair about 0.1.
- AtomPacks: only for tags with no seed template and for project concepts, 1-2 concepts per call. About 0.5 per task in the first project, falling towards 0 as the cross-project cache fills.
- HintLadder: up to about 0.7, from a reserved 4 per hour.
- Escalation lesson: only after a failed re-probe, about 0.2.
- Follow-up: only when the weakest P < 0.6 or a misconception is active, about 0.3.
- OwnCodeProbe: only for spec-less tasks, about 0.2.
- Polish review and misconception naming: off by default.
At about 4 tasks per hour this is 10-12 calls, plus at most 4 hint ladders: 14-16 against the default budget of 20. Background calls run without the priority service tier.

PREFETCH SCHEDULE
- t=0, Start:
  - PlanOutline (medium, about 40-70 s, priority 0).
  - Runtime detection and seed instantiation run locally (about 1-2 s).
  - No seed for the language: a probes-only seed pack (low, about 10-15 s plus compile time, priority 0). Neutral pseudocode items fill the wait.
- Plan lands:
  - TaskPrep for tasks 1-3 (medium, about 40-60 s, priority 1, neededBy = predicted end of placement).
  - AtomPacks for the non-seed concepts of tasks 1-3 (medium, about 30-40 s each, priority 1).
- Milestone k starts: TaskBatch for milestone k+1 (medium, priority 1).
- The second-to-last task of a trio enters building: TaskPrep for the next trio (priority 1), plus AtomPacks for their non-seed concepts.
- Re-probe fails: escalation lesson (low, about 10 s, priority 0). The second sibling item (20-40 s) covers the call.
- Stuck score reaches 0.6:
  - HintLadder rungs 1-3 (medium, priority 2, from the hint reserve, keyed per task, at most 4 per hour).
  - Without a spec ladder: OwnCodeProbe inputs (low, priority 2, at most 1 per 2 min).
- Criteria met: FollowUp, only if the weakest P < 0.6 or a misconception is active (medium, priority 1).
- Low stock (fewer than 3 unseen items) for a due, fragile, Fixing or misconception concept:
  - Seeded tags refill locally, with no call.
  - Other tags get a single-concept refill (low, priority 3).
- Usage-limit error (any provider): the background lane pauses for 15 min, queued speculative jobs are dropped, and the hourly budget halves for the session.

DEADLINES AND DEGRADED PATHS (priority-1 jobs carry neededBy)
- TaskPrep late at task start: show the interface card from the plan, skip the gate ('Plan it in your head'), and attach the specs when they land.
- AtomPack late when the gate routes to it: the gap becomes a JIT offer. If the learner presses Teach meanwhile, the foreground mini atom is used.
- TaskBatch late at milestone end: show a 'next milestone is being prepared' card with a sprint offer.
- HintLadder not prefetched: on-demand call at low effort, about 10-15 s.

GRADED LOCALLY (never waits on a model)
- Placement items; atom predict, completion, contrast and traceback items; belief checks; refutation re-probes; sprints and which-pattern picks.
- Gate pattern and plan picks.
- Spec runs on save, failure-signature nudges, hidden-spec checks and JIT offers.
- Own-code predictions and what-if mutants.
- Paste and assisted-insert detection, all evidence and BKT maths, scheduling, propagation, audits and tempo decisions.
- Execution cost, measured here:
  - one Python spawn: about 96 ms with the real exe
  - Node: about 80 ms; Node with .ts: about 130 ms
  - a verification batch: about 0.3-0.8 s per pass
  - a spec run with light imports: about 150-400 ms for Python, 100-300 ms for Node
  - completion grading in compiled languages: 1-2 s

STILL MODEL-JUDGED, BUT IN THE BACKGROUND (results arrive as a log card plus evidence)
- 'I'd do it differently' / the free-text plan.
- The explain-back fallback, used only when there is no runtime.
- Follow-up design.
- Polish review and naming of unmatched wrong answers (both opt-in).

STILL BLOCKS ON A MODEL (foreground, rare)
- Ask the coach and Reveal.
- Teach on a concept with no seed and no cached or in-flight pack: a mini atom at low effort, about 20-30 s including verification. (The earlier 10-15 s estimate ignored Codex start-up, output size and verification.) A sprint fills the wait only when the learner is not building.
- A hint on a prefetch miss: low effort, about 10-15 s (was 20-40 s at medium).
- Check my work for spec-less tasks: medium effort, about 30-40 s. It runs async, and the learner keeps coding.

TARGET WAITS
- Atom, placement, sprint, gate, belief-check and traceback feedback: under 300 ms.
- Completion grading: under 1 s for Python/JS/TS, 1-2 s for compiled languages.
- Spec verdict after a manual save: under 1 s with light imports; otherwise 'running specs...' is shown.
- Start to first placement item: 2 s or less for Python/JS/TS; other languages get neutral items immediately.
- Start to first keystroke in task 1: 4 min or less.
- Hint rungs 1-3: 0 s when prefetched (target: at least 70% of served rungs); 15 s or less on a miss.
- Task end to next task: 0 s when TaskPrep is on time (target: 10% or fewer priority-1 deadline misses).
- Learner-visible model wait per task: 5 s or less median.
- Any wait over 3 s that the learner started outside building is filled with a sprint. During building a sprint is offered, never forced.


# learnerModelChanges

ONE ENTRY POINT
- Every gap signal becomes an Evidence record passed to recordEvidence().
- Each record is appended to a JSONL log, which is the source of truth.
- ConceptState.mastery stores P(known), so stuckThreshold, weakest, the Progress bars and every prompt keep working.

NO SINGLE ITEM DECIDES
- The likelihood ratio of any one update is capped at 6.
- Predict items take their guess rate from the answer space: boolean .5, small integer .2, structured .06 (raised to the cap).
- P stays at or below .8 until the concept has all of:
  - correct non-guess answers from 2 sibling groups
  - a production item (a completion, or a cleanly earned spec green)
  - coverage of its common misconceptions
- Worked example: one correct predict moves P from .30 to .734; two reach the .8 cap; a passing completion then gives .962 and mastery.
- Downward evidence is limited too:
  - one wrong answer caps only direct children
  - '?' and flagged guesses count at half weight
  - an empty submit is never scored
- A delayed production audit (in a sprint, 1+ day later) re-checks every mastered concept. A miss revokes mastery.

HOW EACH DIAGNOSIS SOURCE FEEDS THE MODEL
- Wrong prediction that matches an executed mutant:
  - The learner is asked 'Did you think <belief>? y/n'.
  - y: misconception odds x6, and the mutant's precision count rises. Then an active contrast pick, a reveal (with a Python state trace for semantics tags), and a re-probe on another surface.
  - n: treated as a slip: half-weight wrong evidence, no misconception update.
  - Never names a belief for: the bare answer 'error', answers within edit distance 1 of the actual output, or ambiguous mutant outputs.
  - In placement the match is stored unconfirmed (x3 for curated mutants, x2 for model mutants), and the later atom starts from it.
- Misconception lifecycle:
  - candidate on the first match
  - active with matches from 2+ sibling groups
  - suppressed after an immediate correct re-probe: still scheduled, still blocks mastery, named in prompts as Fixing
  - cleared after 2 delayed hits: 10+ min later in an unlabelled interleaved sprint, then 1+ day later
  - a later match is a relapse
- Wrong prediction with no mutant match, or '?': both take the same UNKNOWN path, so honesty is never slower than guessing. Optional background naming of the belief is off by default.
- Format-only answers ('hi' with quotes, a tuple written as a list): no evidence, just a one-line format note.
- Completion failure: wrong production evidence. A fill equal to a tagged wrongFill names that misconception (x3).
- Correct but slow (over 2x par_self, after the first 15 items): Fragile.
- Correct but guess-flagged (explicitly, or inferred from very fast latency or a copied literal): counted, with P capped at .8 and one interleaved item scheduled. Not Fragile.
- Traceback items: the line and exception name are graded locally, plus the meaning pick, on the 'reading-tracebacks' concept.
- Gate pattern pick:
  - A missed required pattern is recognition evidence (guess .3).
  - A lure pick is weight .3 wrong evidence with no misconception.
- Flawed plan pick: wrong on flawConceptId, with misconception odds x2. Repeated across 3 tasks, it lowers 'decomposition'.
- Specs:
  - The first green is production evidence, at full weight only within 3 saves and without assisted inserts.
  - A failure-signature match is passive misconception evidence (x1.5, weight .5). It never activates a misconception on its own.
  - Visible specs green with hidden specs red is a transfer failure and flags 'overfit'.
- Own-code prediction:
  - A mismatch is wrong evidence plus misconceptionIfWrong (x3, unconfirmed). A match is correct evidence.
  - Fast greens combined with 2+ wrong own predictions set Task.notUnderstood.
- What-if mutant: a wrong answer counts against the operator's misconception only if it equals the unmutated output or the alternative operator's output. Otherwise it is half-weight wrong evidence on the concept.
- Hints: rung 1 at weight .3; rungs 2-5 at weight .5 (model diagnoses are not decisive); reveal at weight 1.
- Paste (120+ characters equal to the clipboard) and assisted inserts (40+ net-new characters not from the clipboard):
  - add to the task's pasted or assisted characters
  - lower spec evidence on that function to weight .3
  - count against an unaided solve
- Task solve: 'task' evidence by maximum rung, reveal, paste and assist. Solo tasks also update 'decomposition' at full weight.
- Model grades (background explain-back, free-text plan): guess .2, slip .2, weight .5.

GRAPH AND PATTERNS
- Prerequisite propagation (cycle-checked, at most 3 hops):
  - An ancestor becomes inferred-mastered (P .9) only with support from 2+ tested descendants, one of them with production evidence.
  - Support from a single descendant gives at most .75.
  - Inferred-mastered concepts skip gates and are audited first.
- Concept aliases merge plan ids into seed ids by tag, so placement evidence is never orphaned.
- Pattern Deck: each atom exit adds or updates a PatternCard under its canonical name, with 6+ use cases (shape concepts: a template; semantics concepts: a rule). Deck names feed the gate options and which-pattern items; distractors come from tags that are not valid alternatives.
- selectionGap: a concept answered correctly in an atom but wrong when interleaved gets which-pattern and contrast practice.
- Fluency is measured against par_abs: reading time + the learner's own typing speed + unscaled thinking time. Fluent therefore means fast thinking, regardless of typing speed. Fluent concepts:
  - skip gates and what-ifs
  - get maximum stuck rope (1.5)
  - appear only in long-interval sprints
- Decomposition P drives scaffold fading (mechanism 8), and solo tasks measure it directly.

SCHEDULING AND SELECTION BY STATE
- Misconception (active or Fixing): a delayed check at 10 min (interleaved, unlabelled), then at .25 day and 1 day until cleared.
- Fragile: 10 min, then 1 day.
- Guess-flagged correct: one interleaved item this session.
- Solid: interval x2.2, plus one delayed production audit.
- Follow-up tasks only when the weakest P < .6 or a misconception is active.
- The coach never starts atoms for Solid or Fluent concepts.

MIGRATION, PERSISTENCE AND LOGGING
- Existing profiles keep mastery as their P prior. New fields get defaults, with tested = attempts > 0.
- Evidence lives in globalStorageUri/evidence-YYYY-MM.jsonl. globalState keeps compact summaries, merged per concept before each write, so two windows never erase each other's progress.
- The log keeps every observation, with the bits of information each item carried. This lets the guess, slip, learning-rate and par parameters, and mutant precision, be refitted locally later.


# removeOrShrink

DELETE
- Placement quiz:
  - buildDiagnostic, pushDiagnosticQuestion, answerDiagnostic, finishDiagnostic
  - DiagnosticSchema, Project.diagnostic, the Diagnostic and DiagnosticQuestion types
  - the 'diagnostic' input mode, the 'diagnosticSkip' command and MODE_LABELS.diagnostic
  - all per-answer GradeSchema calls during placement
- Default micro-lesson:
  - the 250-word LessonSchema card in teachInner, plus keyPoints, checkQuestion and checkExpected
  - Task.pendingCheck, answerCheck(), the 'check' input mode and the 'Try once more' grading loop
- LLM spaced recall:
  - maybeRecall, maybeRecallInner, answerRecall, skipRecall
  - RecallSchema, Project.pendingRecall and recall-card pinning in viewModel
  - the 'answerRecall' cardInput route
  - setTimeout(maybeRecall, 20000) in extension.ts
- The 'Lock it in' explain-back after hints. gotIt() now records rung evidence and resumes building.
- The LLM-designed speed drill in speedDrill(). It becomes a local 180 s sprint.
- The showInformationMessage pop-up in maybeOfferHelp. It becomes a tempo-bar action.
- skipExplain. Skipping the gate is now automatic.
- The single PlanSchema call that wrote every task of every milestone at high effort, together with its language field. It is replaced by PlanOutline plus a TaskBatch per milestone, and the language becomes fixed input.
- Ideas from the earlier draft of this design that are dropped before being built:
  - the AST-strip module loader
  - the CodeLens for own-code predictions
  - path-prefix scratch exclusions in Monitor (the pad's own URI scheme makes them unnecessary)
  - the persisted Project.runtime
  - output comparison by quote-swapping and JSON parsing
  - overwriting a model's wrong answer with the real output
  - spec runs with the workspace folder as the working directory

SHRINK OR DEMOTE
- Explain gate: the free-text approach essay is no longer the default.
  - submitExplanation/ExplanationReviewSchema is reachable only via 'I'd do it differently', and is graded in the background.
  - noIdea opens an atom.
  - guideApproach runs only after 2 flawed plan picks.
- The gate itself:
  - runs only when a task brings in a new, unmastered concept
  - shows at most 50 words
  - includes step B only at the 'full' fade level
  - does not run at 'minimal' or in solo tasks
- Lessons survive only as escalations of 120 words or fewer (EscalationLessonSchema). They fire when a re-probe fails and target one confirmed belief.
- Explain-back after Check my work: replaced by what-if mutants on the learner's own code, which are skipped when all of the task's concepts are Fluent. Free-text explain-back remains only as a background-graded fallback when there is no runtime.
- Check my work:
  - no longer decides 'done' when a spec ladder exists
  - otherwise runs async at medium effort (was high), and is offer-only while building
  - the polish-only review is opt-in
- Testing view: no longer the primary surface. Save-triggered runs report through gutter icons, the tempo bar and the task card. The Testing view gets results only for runs the learner starts, or for continuous runs.
- Coach.run() single-flight busy lock:
  - becomes a foreground lane used only by Ask, Reveal, mini-atom Teach and spec-less Check
  - local flows use the InteractionLock instead
  - remove the busy early returns at coach.ts:242, 322, 844 and 1011
- learner.ts: the nudge() heuristic deltas, the setMastery caps, the MASTERY_TARGET checks in viewModel, and recordSolve's flat +0.35/-0.15 all go. recordEvidence() and isMastered() replace them; nudge stays only as a thin wrapper.
- Follow-ups:
  - only when the weakest concept is below P .6 or has an active misconception
  - maxFollowUps default 4 -> 2
  - generated in the background when criteria are met
- Task size in the plan prompt: 15-45 min -> 5-15 min (first task 5-10), growing to 20-30 min as decomposition improves and the scaffolds fade.
- On-demand hint calls: medium -> low effort. Rungs 1-3 come from the prefetch.
- Background model calls: no priority service tier. codexFast applies to foreground calls only.
- Mistake journal keys: slug of the model's free text -> stable misconception ids.
- Model AtomPacks: only for tags with no parametric seed, and for project concepts.

SIDEBAR
- It stops being where learning happens. The feed becomes a compact log: one card per placement, gate, atom, sprint, review and hint.
- The composer is only for Ask and the optional free-text plan.
- The Roadmap tab stays.
- The Progress tab gains:
  - state chips (Unknown, Learning, Misconception, Fixing, Fragile, Solid, Fluent)
  - misconception beliefs
  - the Pattern Deck
  - calibration and audits
  - a Pace section
- Onboarding copy changes. 'check what you already know in ~5 minutes', 'a 3-minute lesson' and 'Explain first' are replaced with '~2 min of quick predict-the-output checks while I plan', 'quick checks, 1-minute fixes' and 'specs turn green as you build'.

TESTS
- test/flow.test.ts is rewritten for the gate, pad, spec and background flow, with a FakeLlm that can resolve out of order.
  - Coach takes GateUi, AtomRunner, SpecRunner and InputFlow interfaces, so flow tests use fakes and test/vscode-stub.ts stays small.
- test/learner.test.ts moves to evidence maths.


# v2Backlog

1. Plan Parsons (from A5). The learner reorders plan steps in the pad with Alt+Up/Down, graded against a precedence DAG. In the fading ladder it sits between the 1-of-3 plan pick and free decomposition.
2. 'Break it' step (C3): 'Change one line so this prints X'. It becomes the remedy when the miss is at apply depth. Also an Aleven-style self-explanation subgoal menu inside atoms.
3. Eraser and Saboteur (E5).
   - Eraser: rebuild your own function from memory against your own specs, with par set to half your original time, as spaced retrieval.
   - Saboteur: a bug hunt in a shadow copy of your code, including a 'missing case' judgement for mutants that survive the specs.
4. Trace stepper beyond V1 (C4). V1 ships a Python sys.settrace trace for probe refutations on state tags. v2 extends it to the learner's own functions, with a local classifier for state misconceptions, and adds a DAP-based recorder for JS and other languages.
5. Pattern sightings (D6). Detect a deck pattern used unprompted in project code. This promotes it from Fluent to Automatic and acts as a progress signal for the stuck detector. Also a local 'which pattern goes here?' rung.
6. Comments API threads for the design review and Check my work findings (V1 uses threads only for long hints), plus type-over ghost text for rung 5.
7. One-click answer buttons (E3) for own-code predictions, with model-written distractors, as a faster warm-up variant.
8. Passive error-signature evidence (B6). A per-language regex table over terminal output and diagnostics, weighted by how long each error lived, using StuckDetector.errorsFirstSeen.
9. Expected-information-per-second item selection (B3), and offline refitting of guess, slip, learning rate and par from the evidence log. Also item analytics that retire items too easy for low-P learners.
10. Stdout/CLI specs (argv + stdin -> expectContains) and smoke checks for CLI tasks.
11. Spec ladders and own-code probes for Go, Java and Rust (V1 uses these runtimes for atoms only). Adapters for Ruby, PHP and C#. Better handling of mixed ESM/CJS JavaScript modules.
12. A persistent per-task spec worker that reloads only changed modules (importlib.reload or a fresh vm context), for projects with heavy imports.
13. A level ladder per concept (Recognize / Predict / Construct / Fluent), daily targets and streaks. Chunk katas: templates combining several patterns, written from memory.
14. Predict-before-run on the learner's own terminal command. Only for commands that match a detected run pattern, and always with confirmation.
15. A webview deck as an optional surface for small screens, only if the editor pad proves awkward there.
16. Generalisation checks for own-code probes. A 'my plan differs' path that proposes an alternative interface instead of marking the spec ladder not applicable.


# successMetrics

All metrics are computed locally from the evidence log, per-task timestamps and job stats. They are shown in a 'Pace' section of the Progress tab, and nothing is sent anywhere.

HEADLINE (transfer speed, which scaffolded tasks cannot fake)
- Solo tasks (one per milestone, no gate, no titles, hints capped at rung 2), tracked for:
  - active minutes
  - unaided solve rate: no rung 2+ hint, no reveal, pasted + assisted characters under 120
  Both should improve milestone over milestone.
- Active minutes per milestone at fixed scope, and learner-visible model wait seconds per milestone. These replace 'tasks per hour', which mostly measured that tasks got 3x smaller.

SPEED
- Start to first keystroke in task 1: median 4 min or less (today about 10-15 min).
- Model wait on the critical path: 5 s or less median per task (today about 3-5 min).
- Concept block time p50 (today 4-6 min per lesson plus its check):
  - known concept: 30 s or less
  - misconception: 70 s or less
  - unknown concept: 120 s or less
- Words read per concept block: 60 or fewer. Escalation lessons are excluded and counted separately.
- Overhead per task (gate + pre-build atoms + what-ifs): median 90 s or less, falling across milestones as fading removes steps.
- Hint rungs 1-3 served from the prefetch: 70% or more.
- Placement: 14 items or fewer, 3 min or less, zero GradeSchema calls.

DEPTH AND DIAGNOSIS
- Information per task: median evidence bits per task (the sum of KL divergence from prior to posterior), reported instead of event counts. Low-information events such as pattern picks and spec greens count only for what they are worth.
- Misconception attribution:
  - coverage (share of wrong predictions matched to a mutant), reported next to precision (y-confirmation rate of belief checks, target 70% or more)
  - mutants below 30% precision after 5 asks are retired automatically
- False mastery: under 10% of delayed production audits fail. Audits are random, 1+ day after mastery, include inferred concepts, and do not depend on whether a task happened to use the concept.
- Refutation:
  - 70% or more of confirmed refutations are followed by a correct re-probe on a different surface
  - relapse within 7 days is 20% or less, measured by the delayed checks that keep running while a misconception is suppressed
- Retention, on fresh instances (never an exact repeat): 80% or more correct on sprint items for mastered concepts after 1+ day, and 70% or more after 7+ days.
- Calibration: non-guess accuracy is at least 30 points above guess-flagged accuracy. Flag usage (explicit + implicit) is tracked so the stat is never empty.
- The format-only answer rate falls over the first sessions.
- Traceback item accuracy rises, and the time from a persistent project error to the next progress event falls.

THE LEARNER DOES THE WORK
- Share of active time spent writing project code: 70% or more. Sprints and atoms together: 25% or less, with sprints alone at 15% or less.
- Pasted + assisted characters per task trend down. Reveal rate is 1 or fewer per 10 tasks.
- Own-code prediction accuracy rises across tasks. Conflict flags and overfit flags fall.

COST AND HEALTH
- Background calls: 4 or fewer per task and 20 or fewer per hour. At about 4 tasks per hour the design expects 14-16, including hints.
- Priority-1 deadline misses: 10% or less.
- Verification pass rate: 85% or more of model items. Seed instance validity: 95% or more.
- Prefetched content actually used: 60% or more.
- Skip/Esc rate per nudge kind: under 30%. A higher rate means the nudge interrupts too much and its scheduler limits should tighten.
- Tracked as regression signals:
  - learners who switch localExecution or proactiveHints to 'off'
  - learners who decline the inline-AI offer and then show high assisted counts


# V1-1: 1. Two-lane JobQueue, InteractionLock and generation tokens: background prep that never blocks the learner or writes stale results

## spec
GOAL:
- No learner action waits on, or is disabled by, a model call the learner did not explicitly wait for.
- No two modal flows overlap.
- No late result writes into the wrong task or project.
LANES:
- Foreground (fg): 1 call at a time, with a visible busy label. Used only for:
  - Ask the coach
  - Reveal
  - Teach on a concept with no seed and no cached or in-flight pack (mini atom, mechanism 5)
  - Check my work for tasks without a spec ladder
- Background (bg): deliberate.backgroundConcurrency concurrent jobs (default 2, max 3).
  - Bg calls run with fast = false (no service_tier=priority). Nobody waits on them, so they must not spend priority-tier plan usage.
  - Fg calls keep deliberate.codexFast.
JOB API: bg(spec), with spec = {key, priority, effort, label, scope, gen, neededBy?, run(signal)}.
- Priority: 0 needed-now, 1 needed-next, 2 speculative, 3 refill or opt-in enrichment.
- Dedupe: a job with an identical key returns the in-flight promise.
- Ordering: by priority, then earliest neededBy, then FIFO.
BUDGET (RollingBudget):
- Rolling 60-minute window, default 20 calls (deliberate.backgroundCallsPerHour).
- 4 of those calls are reserved for HintLadder jobs; all other jobs together may use 16.
- When a job type's share is full:
  - priority 2-3 jobs resolve to undefined and are dropped
  - priority 0-1 jobs wait
  - if a waiting priority-1 job's neededBy passes, the coach applies that job type's degraded path (listed in latencyStrategy). The job keeps waiting so its result can still attach later.
- Tier-aware: the first usage-limit error in a session halves the hourly budget (minimum 6) for the rest of the session.
- The tempo tooltip shows 'background: 7/20 this hour'.
USAGE LIMIT:
- LlmError gains kind: 'limit' | 'auth' | 'format' | 'other', set by every provider:
  - Codex: message 'Codex plan limit reached'
  - Anthropic: RateLimitError or HTTP 429
  - vscode-lm: LanguageModelError with code Blocked
- On kind 'limit':
  - the bg lane pauses for 15 min
  - queued priority >= 2 jobs are dropped
  - the tempo bar flashes 'Plan limit: background prep paused 15 min'
VSCODE-LM PROVIDER:
- sendRequest must follow a user action, so Start (a user action) makes one tiny consent request.
- Bg jobs call context.languageModelAccessInformation.canSendRequest(model) first. Unless it returns true, they resolve to undefined and log it.
CANCELLATION:
- cancel(key) and cancelWhere(pred) abort through AbortController.
- proc.killTree kills the whole process tree (mechanism 2).
- A task switch cancels the old task's task-scoped jobs.
GENERATION TOKENS (race rule):
- Every job captures gen = {projectCreatedAt, taskId, taskSwitch} when it is enqueued.
- Its apply() runs only if the current gen still matches for its scope:
  - 'global' (AtomCache writes): always
  - 'project' (plan, task batches): same projectCreatedAt
  - 'task' (task prep, hints, probes, grades, reviews): all three match
- Bg jobs never change task.phase and never push task-flow cards.
- Open-ended grades append one log card and Evidence, and only when gen matches.
- Project.taskSwitch increments on every startTask, newProject and resetProfile.
INTERACTIONLOCK (one modal flow at a time):
- Modal flows: the pad (placement, atom, sprint, skeleton), the gate QuickPicks, and the own-predict and what-if InputBoxes.
- Each calls lock.acquire(kind), which returns a release function, or undefined if the lock is held.
- When the lock is held, the requester enqueues a tempo action (mechanism 4) instead of opening.
- startTask, newProject and resetProfile first abort the active flow (recorded as Esc, no penalty) and run cancelWhere(task scope).
- hint() is single-flight per task: a second call while one is running returns the same promise.
COACH.RUN():
- run() becomes fg() and keeps the busy label for fg calls only.
- Remove the busy early returns at:
  - coach.ts:242 (answerDiagnostic, deleted)
  - coach.ts:322 (startTask: now guarded by the lock's abort)
  - coach.ts:844 (maybeRecall: replaced)
- At coach.ts:1011 (maybeOfferHelp), replace the busy check with 'a hint job for this task is in flight'.
- Pad, gate, sprint, spec runs and own-code probes never check busy; they check the InteractionLock.
WEBVIEW (media/main.js):
- Only actions that start fg calls are disabled while fg is busy: askCoach, reveal, checkWork without specs, and teach on a mini-atom miss.
- The busy bar shows:
  - the fg label
  - 'n preparing in background' when bg jobs are running
  - a 'Practice while you wait' button when sprint stock exists and the task is not building
EDGE CASES:
- A window reload drops in-flight jobs. On activation, reconcile() re-enqueues whatever is missing; keys make this idempotent:
  - the plan (mechanism 7)
  - TaskPrep for the current and next task
  - the next TaskBatch
  - stock refills
- An errored bg job logs to the output channel, never to the task feed.
- A dropped speculative job is silent.

## apis
vscode.workspace.getConfiguration, vscode.CancellationTokenSource, vscode.window.withProgress (ProgressLocation.Window, fg label only), vscode.window.setStatusBarMessage, vscode.window.createOutputChannel, vscode.ExtensionContext.languageModelAccessInformation (canSendRequest, onDidChange), vscode.LanguageModelError (code, LanguageModelError.Blocked)

## files
All paths relative to C:/ast.
- NEW src/jobs.ts (pure, no vscode import). Exports:
  - JobQueue {fg, bg, cancel, cancelWhere, pause, stats, onDidSettle}
  - RollingBudget, with the hint reserve and halving
  - JobSpec, Gen, genMatches()
- NEW src/lock.ts (pure): InteractionLock {acquire, abortActive, active, onDidRelease}.
- src/codex.ts:
  - exec() moves onto proc.spawnCapped (mechanism 2), with an AbortSignal.
  - runCodex(o, system, prompt, schema, signal?).
  - Bg calls pass fast = false.
- src/llm.ts: json(req, opts?: {signal?: AbortSignal; fast?: boolean}).
  - Codex path: passes both.
  - Anthropic path: passes {signal} as request options.
  - vscode-lm path: bridges the signal to a CancellationTokenSource, and checks canSendRequest for bg calls.
  - LlmError gains kind, set by each provider.
- src/coach.ts:
  - Constructor takes deps {jobs, lock, ...}.
  - run() becomes fg().
  - New helper bgAsk(key, priority, scope, prompt, schema, effort, apply, neededBy?).
  - Remove the busy early returns listed in the spec.
  - startTask, newProject and resetProfile call lock.abortActive() and bump taskSwitch.
- src/types.ts: Project.prefetch, Project.taskSwitch.
- src/extension.ts: build JobQueue and InteractionLock from settings; reconcile() on activation; dispose() cancels all jobs.
- media/main.js: busy semantics as in the spec.
- package.json settings:
  - deliberate.backgroundConcurrency (number, default 2, min 1, max 3)
  - deliberate.backgroundCallsPerHour (number, default 20)
- NEW test/jobs.test.ts:
  - dedupe
  - priority and neededBy order
  - the budget drops speculative jobs
  - the hint reserve stays available when other jobs fill their share
  - usage-limit pause and budget halving
  - cancel aborts
  - a stale gen makes apply a no-op
  - a simulated hour of 4 tasks, using the per-task job mix from latencyStrategy, asserts priority-1 queue wait <= 30 s at default settings
- NEW test/lock.test.ts: a second acquire is refused; abortActive releases the lock and reports Esc.
- test/flow.test.ts:
  - FakeLlm gains defer(schema), which returns a resolver so results can arrive out of order.
  - New tests: a pad answer is graded while PlanOutline is still pending; a TaskPrep result that lands after the learner switched task is ignored.

## schemas
No zod changes. Types:
- JobSpec<T> { key: string; priority: 0|1|2|3; effort: 'low'|'medium'|'high'; label: string; scope: 'global'|'project'|'task'; gen: Gen; neededBy?: number; run: (signal: AbortSignal) => Promise<T> }
- Gen { projectCreatedAt: number; taskId?: string; taskSwitch: number }
- LlmError adds kind: 'limit'|'auth'|'format'|'other'
- Project.prefetch: Record<string, { at: number; taskId?: string; contentHash?: string; value: unknown }>, capped at 50 entries LRU
- Project.taskSwitch: number

## prompts
No prompt text changes. llm.json gains an optional abort signal and a fast flag (false for every bg call).


# V1-2: 2. Local runner: sandboxed execution, batch runs, type-aware output comparison, consent and runtime adapters

## spec
RUNTIME DETECTION:
- Runs on every activation. The result is kept in memory only, never persisted, so a stale path is never trusted.
- Python candidates, in order:
  1. The Python extension's selected interpreter: getExtension('ms-python.python'), activate(), then exports.environments.resolveEnvironment(exports.environments.getActiveEnvironmentPath(folder)).executable.uri. Fallback: executeCommand('python.interpreterPath', {workspaceFolder}).
  2. Workspace .venv, venv or env (Scripts/python.exe on win32, bin/python elsewhere).
  3. deliberate.pythonPath, then python.defaultInterpreterPath.
  4. PATH: python, python3, py -3.
- Each Python candidate runs a hello-world with the exact argv later used for snippets. It must print 42 and sys.executable.
  - The absolute sys.executable is cached and spawned directly from then on.
  - This skips the WindowsApps alias (measured here: 205 ms per run through the alias vs 96 ms for the real exe) and a broken 'py -3'.
  - Never use --version.
- Node: the first node on PATH runs a hello-world with the exact snippet argv, including the permission flag. It prints 42, process.execPath and the version, and the absolute path is cached (this machine has Node 24.11.1 and 23.9.0 on PATH).
  - Permission flag by parsed version:
    - '--permission' for >= 22.13 or >= 23.5
    - '--experimental-permission' for 20.0-22.12 and 23.0-23.4
    - none below 20 (allowlist plus temp cwd only)
- TypeScript:
  - Spawn 'node -p process.features.typescript' with the system node, never the extension host's Node.
  - If it reports 'strip' or 'transform', use node, adding --experimental-strip-types on 22.6-23.5.
  - Otherwise use <workspace>/node_modules/.bin/tsx, then tsx on PATH.
  - The harness registers a module.register() resolve hook that maps extensionless and '.js' relative specifiers to an existing '.ts' file.
  - If nothing works: TS atoms run unverified, and TS spec ladders are applicable = false with a one-line reason card.
- Go, Java, Rust (RuntimeAdapter table):
  - Go: 'go version' plus a hello-world, and a background warm-up build (cold 'go run' measured 22 s here, vs 0.4-0.8 s warm).
  - Java: java >= 11 with javac.
  - Rust: rustc.
  - V1 uses them only for atom verification and completion grading.
- Anything else: neutral pseudocode items plus unverified model keys.
RUN PROFILES:
- Snippet profile (seed and model code):
  - Python flags '-s -B -X utf8', plus '-P' on 3.11+.
  - The env is built from scratch: PATH, SYSTEMROOT, TEMP, TMP, USERPROFILE/HOME, PYTHONHASHSEED=<pass seed>.
  - Critique note: the feasibility review suggested '-I'. But '-I' implies '-E', which ignores PYTHONHASHSEED, and the determinism check needs two different hash seeds to catch string set ordering. Because the env is constructed rather than inherited, '-E' adds no isolation here; '-B' fixes the bytecode problem the review found.
  - Node: the permission flag with --allow-fs-read=<run tmp>,<runner dir> --allow-fs-write=<run tmp>.
  - cwd: a mkdtemp under globalStorageUri/run. stdin 'ignore', windowsHide, 3 s per item, maxOut 20000.
- Learner-code profile (spec runs, own-code probes):
  - Python flags '-E -B -X utf8', without -I or -s, so user site-packages still load (pip's default on Windows non-admin installs).
  - The env adds APPDATA and LOCALAPPDATA.
  - The harness prepends the workspace folder and the module's folder to sys.path.
  - Node: --allow-fs-read=<workspace>,<harness dir>,<run tmp> --allow-fs-write=<run tmp>.
  - cwd is ALWAYS a fresh temp dir, never the workspace, so a save_todos() under test cannot overwrite the learner's todos.json.
  - Timeout 5 s, extended by measured import time (mechanism 11).
- Python audit hook, installed by the bundled prelude in both profiles with sys.addaudithook. It raises DeliberateSandbox on:
  - open() for writing or appending outside the run tmp
  - os.remove, rename, rmdir and mkdir outside tmp
  - shutil.*
  - subprocess.Popen, os.system, os.exec*
  - socket.connect
  - ctypes.dlopen
  The learner sees: 'your code tried to write a file or start a process while being checked: keep that in the main block'.
- Network: Node's --permission does NOT block network (checked: fetch() returned 200 under --permission on Node 24.11.1).
  - Model code is covered by the allowlist.
  - Learner code is documented as network-unblocked on Node, and blocked on Python by the audit hook.
BATCH RUNNER (one spawn per pack, placement batch or seed instantiation):
- Bundled media/runner/batch.py and batch.mjs read a JSON file of items {id, code, wantTrace}.
- They print one '@@DLB {json}' record per item: {id, stdout, values, exception, exitOk, timedOut, ms, constructs, trace?}.
- Python:
  - Each item is exec'd in a fresh dict namespace with stdout redirected.
  - print is wrapped to capture each argument's type and repr ('values').
  - faulthandler.dump_traceback_later(3, exit=True) guards each item. A timeout kills the process; the parent respawns for the remaining items and marks that one timedOut. Python threads cannot be killed, so there is no in-process watchdog.
  - constructs come from an ast walk; trace (when requested) from sys.settrace (mechanism 5).
- Node:
  - vm.runInNewContext per item, with the vm timeout option (stops synchronous loops) and a 2 s cap on pending promises.
  - console.log is replaced to capture structured values and to print util.inspect(x, {breakLength: Infinity}), so arrays never wrap.
  - constructs come from a token table.
- Compiled adapters: one compiler invocation per pack where possible:
  - Go: 'go build -o <dir>/ ./...' over one package per item
  - Java: javac over all items, then java -cp per item
  - Rust: rustc per item, 4 in parallel
- Measured base costs here: about 96 ms per Python spawn with the real exe, 80 ms for Node, 130 ms for Node with .ts. A 30-item pack is 1 spawn plus exec time, about 0.3-0.8 s; two hash-seed passes are 2 spawns.
PRELUDE (both languages): check(cond, msg) raises or throws an error whose message starts with 'CHECK ', which exits non-zero. This lets JS harnesses fail without require() or process, which the allowlist forbids.
ALLOWLIST (replaces the deny-only staticDeny for model and seed code; denied items are dropped, never run):
- Python imports allowed:
  - math, collections, itertools, functools, string, re, json, dataclasses, datetime (fixed values only), io (StringIO as a file stand-in), argparse (with an explicit argv list), typing, enum, statistics, fractions, decimal, heapq, bisect, copy, operator, textwrap
  - per-tag extras from tags.ts
  - for project concepts tagged 'other': third-party modules that importlib.util.find_spec finds in the detected runtime
- Python always denied: os, sys, subprocess, shutil, socket, pathlib, urllib, http, requests, ctypes, multiprocessing, threading, signal, open(, __import__, eval(, exec(, input(.
- JS/TS denied: require(, value imports (type-only imports are allowed), process., fetch(, child_process, Deno, Bun, globalThis[, eval(, Function(, Math.random, Date.now, new Date() with no arguments.
COMPAREOUTPUT(answer, recorded, lang, tagInfo) returns {verdict: 'correct' | 'format-only' | 'wrong' | 'dont-know', mutantId?, ambiguous?, note?}:
- Python:
  - A pure-TS Python-literal parser produces typed values for the answer. It handles int, float (including inf and nan), str with both quote styles and escapes, bytes, True/False/None, list, tuple, dict, set, frozenset and nesting.
  - The recorded side uses the captured typed values, never re-parsed text.
  - int differs from float (2 vs 2.0 is wrong), list differs from tuple, and set and dict compare order-free.
  - A top-level str prints bare, so it is compared as text after normalising CRLF and trailing whitespace.
  - There is no quote swapping, so strings containing apostrophes or the text 'None' stay intact.
- JS/TS:
  - The answer is parsed with a JSON5-style parser (unquoted keys, single quotes, trailing commas, undefined, NaN, Infinity, -0) and compared structurally with the captured values. Inspect spacing ({ a: 1 } vs {a:1}) and line wrapping do not matter.
  - Critique note: JS needs no int/float distinction, because 6/2 and 3.0 are the same number and console.log prints 3.
- If either side cannot be parsed: compare the text after collapsing whitespace.
- Multi-line outputs are compared line by line. Answers are split on separate answer lines or on ' | '.
- 'format-only': the answer matches only after one of these: removing quotes around a top-level string, converting between tuple and list, removing outer brackets, or mapping True/true and None/null.
  - It is downgraded to 'wrong' when the tag is type-sensitive, or when a mutant's output equals the answer under the strict comparison.
- Mutant matching is strict. There is no match on:
  - the bare answer 'error' (an exception name is required)
  - an answer within edit distance 1 of the actual output (a probable slip)
  - outputs marked ambiguous at verification
CONSENT:
- Setting deliberate.localExecution = 'ask' (default) | 'snippets' | 'all' | 'off', with scope 'machine', so a workspace .vscode/settings.json cannot switch execution on.
- deliberate.pythonPath and deliberate.codexPath are also 'machine' scope, so a cloned repo cannot point them at its own script.
- On first need, a modal: 'Deliberate grades practice instantly by running short snippets in a temp folder (3 s limit, no file, process or network modules) and, if you allow it, by calling your own functions with test inputs from a temp folder.'
  - Buttons: 'Snippets and my code' | 'Snippets only' | 'Not now'. The choice is saved in globalState.
- Execution also requires vscode.workspace.isTrusted. Re-check on onDidGrantWorkspaceTrust.
- When execution is off or the workspace is untrusted:
  - atoms use model keys flagged verified = false
  - spec ladders and own-code probes are disabled, and the Check my work path is used
SCRATCH ISOLATION:
- The pad and the rung-4 skeleton live on the in-memory 'deliberate-pad' scheme (mechanism 6).
- Monitor.isCode already accepts only 'file' and 'untitled'. So typing in the pad never counts as project progress, never enters touchedFiles or gatherCodeContext, and its diagnostics are ignored.
- context.ts also skips any task.files under globalStorageUri or the OS temp dir (defensive).
- No path-prefix exclusions are needed in Monitor.
NO RUNTIME: one status flash, 'No Python found: practice runs unverified (set deliberate.pythonPath)'. Grading falls back to unverified keys.

## apis
vscode.workspace.isTrusted, vscode.workspace.onDidGrantWorkspaceTrust, vscode.ExtensionContext.globalStorageUri, vscode.ExtensionContext.globalState (Memento.get/update), vscode.workspace.fs.createDirectory, vscode.extensions.getExtension('ms-python.python') (Extension.activate, exports), vscode.commands.executeCommand('python.interpreterPath', {workspaceFolder}), vscode.workspace.getConfiguration('python').get('defaultInterpreterPath'), vscode.window.showInformationMessage (modal: true), vscode.workspace.workspaceFolders

## files
- NEW src/proc.ts: spawnCapped(bin, args, {cwd, env, stdin, timeoutMs, signal, maxOut}) and killTree(). codex.ts uses it.
  - POSIX: spawn with detached: true, and kill the group with process.kill(-child.pid, 'SIGKILL').
  - win32: taskkill /pid <pid> /T /F for BOTH abort and timeout. Today's codex.ts timeout kills only cmd.exe when shell: true is used for .cmd shims.
- NEW src/runner.ts: detectRuntime, the snippet and learner profiles, runBatch, runLearnerCode, allowlist, parseException. No vscode import; paths are passed in.
- NEW src/compare.ts (pure): parsePyLiteral, parseJs5, compareOutput, answerSpaceG (mechanism 3), editDistance.
- NEW src/adapters.ts: RuntimeAdapter {lang, detect, wrapItem, buildBatch, runItem} for python, javascript, typescript, go, java, rust.
- NEW media/runner/prelude.py and prelude.mjs (check(), audit hook, print capture), batch.py, batch.mjs.
- src/monitor.ts: no runtime-detection duties (lastInterpreter is dropped). It still reads exitCode from the TerminalShellExecutionEndEvent, as today.
- src/context.ts: defensive skip of globalStorage and temp paths.
- src/extension.ts: create globalStorageUri; consent helper; runtime detection on activation, held in memory.
- package.json:
  - deliberate.localExecution (enum ask/snippets/all/off, default ask, scope machine)
  - NEW deliberate.pythonPath (string, scope machine)
  - deliberate.codexPath gains scope machine
- NEW test/compare.test.ts:
  - 2 vs 2.0 is wrong in Python
  - a string containing an apostrophe (it's)
  - 'None' inside a string
  - [ 'a', 'b' ] vs ['a','b'] is correct in JS
  - a 100-character array printed by Node
  - 'hi' vs hi is format-only
  - (1, 2) vs [1, 2] is format-only, but wrong under a type-sensitive tag
  - set order
  - an edit-distance-1 slip
- NEW test/runner.test.ts:
  - parseException on sample Python and Node traces
  - allowlist hits
  - real node and python runs (skipped if missing)
  - no __pycache__ appears in a fixture workspace after a learner-code run
  - the second hash-seed pass flags string set ordering
  - a parent that starts a sleeping grandchild leaves no grandchild after abort
  - the audit hook blocks a write outside tmp

## schemas
Types only:
- Runtime { lang: string; exe: string (absolute path); snippetArgv: string[]; learnerArgv: string[]; version: string; permissionFlag?: string; tsMode?: 'strip'|'transform'|'tsx' }, held in memory, not in Project
- RunResult { stdout: string; stderr: string; exitCode: number|null; timedOut: boolean; ms: number; exception?: string }
- BatchItem { id: string; code: string; wantTrace?: boolean }
- BatchRecord { id: string; stdout: string; values: {type: string; repr: string}[][]; exception?: string; exitOk: boolean; timedOut: boolean; ms: number; constructs: string[]; trace?: {line: number; text: string}[] }
- Verdict { verdict: 'correct'|'format-only'|'wrong'|'dont-know'; mutantId?: string; ambiguous?: boolean; note?: string }

## prompts
None: no model calls.


# V1-3: 3. Evidence model: a single recordEvidence() with capped likelihoods, production-gated mastery, a misconception lifecycle and multi-window-safe storage

## spec
SINGLE WRITER: every graded interaction calls recordEvidence(learner, ev), and nothing else writes ConceptState.mastery. mastery stores P(known), so stuckThreshold, weakest and the Progress bars keep working.
PERSISTENCE AND MULTI-WINDOW SAFETY:
- The source of truth is an append-only log, globalStorageUri/evidence-YYYY-MM.jsonl, with one Evidence per line.
- globalState holds only compact derived ConceptState summaries (no evidence arrays) plus learner stats. Each flush is tens of KB, not over 1 MB.
- Before each flush, Store re-reads globalState. If a concept's stored lastAt is newer than the in-memory copy (another window wrote it), Store rebuilds that concept from the log since its last checkpoint and merges, instead of last-write-wins.
- The AtomCache file merges by item id the same way.
UPDATE (src/evidence.ts, pure):
1. Base guess/slip (g/s) by kind:
   - predict, own-predict, what-if: g = answerSpaceG(recorded output), s .10. answerSpaceG:
     - boolean .5
     - an exception name .25
     - an integer with |n| < 20: .2
     - another single token of 3 characters or fewer: .12
     - anything else .06
     - 2-4 output lines .04
   - completion .10/.10; traceback .10/.10 (line and name both right)
   - spec .15/.10
   - which-pattern .25/.10; pattern-pick .30/.10; plan-pick .33/.10; contrast-pick .50/.10
   - task .30/.10; llm-grade .20/.20; passive .30/.30
2. Likelihood caps: no single update may move the odds by more than 6x. Model-written items of unknown difficulty are not proof.
   - For a correct answer, use g_eff = max(g, (1-s)/6).
   - For a wrong answer, use s_eff = max(s, (1-g)/6).
3. Confidence:
   - Guess-flagged: explicit (Ctrl+Shift+Enter), or implicit (latency < .3 x par_self, or the answer copies a literal of 5+ characters from the code).
     - Correct: counts as correct, but P is capped at .8 after the update and one interleaved sprint item is scheduled. It does NOT set Fragile, so honesty costs no time now.
     - Wrong: weight .5.
   - Don't know ('?'): wrong at weight .5, with no misconception update. An empty submit re-prompts and is never scored.
   - format-only verdict: no evidence.
   - Assisted answer (a pad insert the learner did not type): discarded.
4. Weights w, applied as P' = P + w(Pbayes - P):
   - 1 by default.
   - .5 for: '?'; guess-flagged wrong; llm-grade; hint-derived evidence (rungs 2-5); spec failure signatures; what-if answers not attributable to the operator; probes using other constructs the learner has not mastered (confounded).
   - .3 for: rung 1; lure picks; specs that turned green after more than 3 saves (tinkering); specs on functions marked assisted.
5. BKT posterior, using the capped g and s:
   - Correct: P(1-s) / (P(1-s) + (1-P)g).
   - Wrong: Ps / (Ps + (1-P)(1-g)).
6. Learning transition: P' += (1-P')T.
   - T = .05 whenever the item showed feedback.
   - T = .3 after a confirmed refutation followed by a correct contrast pick, after a worked example followed by a passing completion, or after an escalation lesson.
7. Evidence caps: P stays <= .8 until ALL of these hold:
   - correct non-guess answers from 2 or more sibling groups
   - 1 or more production items: a completion pass, or an unassisted spec on this concept turning green within 3 saves
   - coverage: the correct items together carried mutants for every taxonomy misconception of the tag with prior >= .2 for which the bank has a verified item. Missing ones are logged as content gaps and requested at priority 3.
8. Misconceptions (lifecycle: candidate -> active -> suppressed -> cleared):
   - Created as candidate on the first match, with p = the taxonomy prior, or .15.
   - Odds multipliers:
     - learner answered y to 'Did you think...?': x6
     - unconfirmed match (placement): x3 for curated seed mutants, x2 for model mutants
     - wrongFill match: x3
     - flawed plan pick: x2
     - attributable what-if: x3
     - spec failure signature: x1.5. This is passive: it can raise p but can never satisfy the 2-group rule on its own.
     - lure picks: never
   - 'n' to the belief check: no update; the mutant's rejections++.
   - active: p > .6 AND matches from 2 or more sibling groups.
   - suppressed: set by a correct non-guess re-probe right after a refutation (odds x.25). A suppressed misconception still schedules a check, still blocks mastery, and is named in prompts as 'recently corrected'.
   - cleared: needs 2 delayed hits. Each is a correct non-guess answer on an item carrying M's mutant. The first must come at least 10 min after the refutation, inside an interleaved sprint with a generic header; the second at least 1 day later. clearHits counts only these.
   - A match while suppressed or cleared sets it active again and counts a relapse.
9. Latency and par:
   - cps (characters per second) is measured by the first placement item (copy a short literal); default 2.5.
   - par_self = read (code lines x 1.5 s) + type (answer chars / cps) + think (clamp(parSec, 3, 8) x speedFactor). Used for Fragile, implicit guesses and outlier discard.
   - par_abs = the same with speedFactor 1. Used for Fluent and the Pace metrics. Fluent therefore means absolutely fast thinking, with typing speed factored out.
   - speedFactor: the running median of latency/par over the last 20 correct items, clamped to .7-2.0.
   - Latency is discarded if the window lost focus during the item (window.state.focused plus onDidChangeWindowState), or if it exceeded 60 s.
10. Fragile:
   - Set by a correct non-guess answer with latency > 2 x par_self. Never set during the learner's first 15 graded items.
   - Cleared by a later correct non-guess answer at <= 1.2 x par_self, given at least 1 h after the flag.
11. Graph propagation (cycle-checked, back-edges dropped, at most 3 hops):
   - Upward: a correct non-guess answer on a tested concept B adds B to supportFrom of each ancestor A.
     - Support from 2 or more tested descendants, at least one with production evidence: A becomes inferred-mastered, with P(A) = max(P(A), .9) and inferred = true.
     - Support from one descendant: P(A) = max(P(A), .75).
   - Downward:
     - One full-weight wrong answer leaving P(A) < .3 caps direct children only: P(D) = min(P(D), P(A) + .35).
     - Two such answers from different sibling groups cap descendants up to 3 hops at P(A) + .25.
     - Concepts with their own non-inferred evidence in the last 7 days are never lowered by propagation.
12. State chip, in priority order:
   - Misconception (active)
   - Fixing (suppressed)
   - Unknown (P < .5)
   - Fragile
   - Learning (.5 <= P, not mastered)
   - Solid (isMastered)
   - Fluent (Solid, and the median latency/par_abs of the last 3 correct answers over 2+ calendar days is <= 1.0)
   - plus an 'inferred' flag
13. isMastered requires all of:
   - P >= .85
   - no misconception that is active, suppressed, or a candidate with p >= .3
   - not fragile
   - either the evidence caps in step 7 are satisfied, or the concept is inferred-mastered
   allMastered() and viewModel (coach.ts:1071, today MASTERY_TARGET .8) both use it, so the Progress tab and the gate agree.
14. Delayed audit: every mastered concept, inferred ones first, gets one production item (a completion) in a sprint 1 or more days after it became mastered, in random order. A miss sets P = min(P, .6), revokes mastery, and is logged as a false-mastery event.
15. Scheduling by outcome:
   - misconception (active or suppressed): 10 min, then .25 day
   - fragile: 10 min, then 1 day
   - guess-flagged correct: one interleaved item within the session
   - solid: interval x 2.2 (min 1 day, cap 60 days)
   - fail: .25 day
16. Calibration: track right/total separately for guess-flagged and non-guess answers, shown as a visible stat in the tempo tooltip and Progress. If non-guess accuracy is below 70% over 30+ answers, every answerSpaceG is raised by .05 for this learner, because they guess without flagging.
17. Bits: each Evidence stores bits = KL(posterior || prior) over Bernoulli(P), for the metrics.
PASSIVE SOURCES:
(a) gotIt() after a hint, by the rung that unblocked the learner:
   - rung 1: wrong at weight .3 (a Socratic question can fix more than a slip)
   - rung 2: wrong at weight .5 on the diagnosed concepts
   - rung 3: wrong at weight .5 on the pseudo-concept 'decomposition'
   - rungs 4-5: both of the above, at weight .5
   - reveal: wrong at weight 1
(b) Paste and assisted inserts in project files.
   - Monitor keeps a shadow copy of each task file, so it can compute net-new non-whitespace characters per content change: n = nonWs(inserted text) - nonWs(replaced text).
   - Undo and redo (reason set) are ignored.
   - Paste: n >= 120, the text equals env.clipboard.readText(), and it is not a move (not equal to text deleted from a task file in the last 2 min). task.pastedChars += n.
   - Assisted: n >= 40, not the clipboard, and not a snippet we inserted. task.assistedChars += n, and the enclosing function (by document symbol range) is marked assisted for this task.
   - Critique note: the feasibility review proposed 12 characters for project files. IntelliSense accepts and auto-import lines routinely insert 12+ characters, so 12 applies only in the pad, where completion is off. Project files use 40 net-new characters, which also ignores formatter edits.
   - Never shown as a scolding message.
(c) recordSolve records kind 'task'.
   - Correct when maxRung <= 2, the task was not revealed, and pastedChars + assistedChars < 120. s = .2 when maxRung is 1-2.
   - Solo tasks (mechanism 8) also record 'task' evidence on 'decomposition' at weight 1.
(d) Specs: full weight only when the spec went green within 3 saves of first going red and its function is not assisted. Otherwise weight .3.
INLINE AI OFFER:
- Once per workspace, if a known inline-completion extension is active (GitHub.copilot, GitHub.copilot-chat, Codeium.codeium, TabNine.tabnine-vscode, supermaven.supermaven), show one notification: 'Turn off inline AI suggestions in this workspace while you do tasks? Your practice evidence stays accurate.' Buttons: [Turn off here] [Keep].
- 'Turn off here' sets editor.inlineSuggest.enabled = false at ConfigurationTarget.Workspace. resetProject restores it.
MISTAKE KEYS: recordMistake keys by misconceptionId when one is given; these are stable taxonomy ids, so entries merge across calls. Otherwise it falls back to slug(pattern).
CONCEPT ALIASES:
- When the plan lands, a plan concept with the same tag as a placement seed concept is merged into it. The seed id stays canonical and the plan id is stored in aliases.
- Many-to-one (several plan concepts for one tag): keep the plan concepts and add the seed concept as their prerequisite.
- concept() and slug lookups go through the alias map.

## apis
vscode.window.state (WindowState.focused), vscode.window.onDidChangeWindowState, vscode.env.clipboard.readText, vscode.workspace.onDidChangeTextDocument (TextDocumentChangeEvent.reason, contentChanges, TextDocumentChangeReason.Undo/Redo), vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri), vscode.extensions.getExtension (isActive), vscode.workspace.getConfiguration().update('editor.inlineSuggest.enabled', false, ConfigurationTarget.Workspace), vscode.ExtensionContext.globalState, vscode.ExtensionContext.globalStorageUri, vscode.workspace.fs.readFile / writeFile

## files
- NEW src/evidence.ts (pure): PARAMS, answerSpaceG (re-exported from compare.ts), effGS(), bkt(), applyEvidence(), caps(), updateMisconception(), propagate(), parSelf(), parAbs(), chip(), isMastered(), auditDue(), bits().
- src/learner.ts:
  - recordEvidence(learner, ev) appends to the log; updates the summary, calibration, speedFactor and cps; and calls schedule(c, outcome).
  - nudge() stays only as a deprecated wrapper that builds {kind: 'llm-grade'}.
  - setMastery is used only by migration.
  - recordSolve emits task evidence.
  - allMastered uses isMastered.
  - snapshot() lines look like: '- list-slicing (List slicing): P 0.62 [Learning, tested, 1 group]; misconception slice-end-inclusive p .71 active: thinks the slice end is included'.
  - recordMistake accepts misconceptionId.
  - concept() resolves aliases.
- src/store.ts:
  - JSONL evidence log (appended with fs.appendFile), compact summaries in globalState, merge-before-flush.
  - Migration on load. Concepts get: misconceptions {}, fluency [], fragile false, tested = attempts > 0, aliases [], supportFrom [], groupsCorrect [], production false. Learner gets: patternDeck [], calibration zeros, speedFactor 1, cps 2.5, keyUse {}.
- src/coach.ts:
  - Replace every nudge()/setMastery call.
  - hint() no longer applies -0.05.
  - answerDiagnostic, answerCheck and answerRecall are deleted.
  - viewModel uses isMastered() and chip().
- src/monitor.ts: shadow copies of task files; onInsert event {kind: 'paste'|'assisted', chars, uri, range}.
- src/extension.ts: the inline-AI offer (vscode.extensions.getExtension(...)?.isActive).
- media/main.js renderProgress:
  - per concept: chip, P%, inferred flag, beliefs of active or suppressed misconceptions, latency trend
  - header: calibration ('flagged guesses right 31% / sure answers right 88%') and audits passed
- NEW test/evidence.test.ts asserts these values (s .10, with T .05 included):
  - a correct structured predict takes P from .30 to .734 (g .06 raised to the cap .15)
  - a second correct predict from another group reaches the .8 cap
  - a passing completion then gives .962 and isMastered; one item never masters
  - a correct boolean predict (g .5) takes .30 to .464
  - a committed wrong structured predict takes .30 to .113
  - a don't-know and a guess-flagged wrong answer both take .30 to .224
  - a correct plan-pick takes .30 to .562
  - a misconception becomes active only after 2 sibling groups
  - an immediate correct re-probe makes it suppressed, not cleared; 2 delayed hits clear it; a later match relapses it
  - upward propagation needs 2 supporting descendants, one with production, for inferred-mastered
  - a single wrong answer caps only direct children
  - latency is discarded when unfocused
  - no Fragile during the first 15 items
- NEW test/store.test.ts: two simulated windows writing different concepts both survive a flush.

## schemas
src/types.ts:
- type ItemKind = 'predict'|'completion'|'traceback'|'own-predict'|'what-if'|'spec'|'which-pattern'|'pattern-pick'|'plan-pick'|'contrast-pick'|'task'|'llm-grade'|'passive'
- interface Evidence { id: string; at: number; conceptId: string; kind: ItemKind; itemId?: string; siblingGroup?: string; correct: boolean|null; verdict?: 'correct'|'format-only'|'wrong'|'dont-know'; guessFlag: boolean; implicitGuess?: boolean; latencyMs?: number; parSelfMs?: number; parAbsMs?: number; latencyValid: boolean; misconceptionId?: string; beliefConfirmed?: boolean; avoidedMisconceptionIds?: string[]; production?: boolean; source: 'atom'|'placement'|'sprint'|'gate'|'spec'|'own-code'|'hint'|'task'|'llm'|'passive'|'audit'; weight: number; learnT: number; bits: number; taskId?: string; window: string }
- ConceptState adds: tag?: string; aliases: string[]; tested: boolean; inferred: boolean; supportFrom: string[]; groupsCorrect: string[]; production: boolean; coveredMisconceptions: string[]; fragile: boolean; fragileSince?: number; masteredAt?: number; auditDueAt?: number; probeable: boolean; misconceptions: Record<string, { p: number; belief: string; status: 'candidate'|'active'|'suppressed'|'cleared'; groups: string[]; refutedAt?: number; delayedHits: number; relapses: number; lastAt: number }>; fluency: number[]; selfRating?: 'used'|'not-used'; selectionGap?: boolean; lastAt: number
- Learner adds: calibration: {sure: [number, number]; guess: [number, number]}; speedFactor: number; cps: number; keyUse: Record<string, number>; patternDeck: PatternCard[]; logCheckpoint: number
- PatternCard { conceptId: string; tag: string; kind: 'shape'|'semantics'; name: string; useWhen: string; template: string; rule: string; pitfall: string; useCases: string[]; useCaseSeenAt: Record<string, number>; lastRatio?: number; addedAt: number }
- Task adds: pastedChars: number; assistedChars: number; assistedFunctions: string[]
No zod changes.

## prompts
Append to SYSTEM in src/prompts.ts:
'The learner profile gives each concept as P(known) with a state: Unknown, Learning, Misconception (an active wrong belief, quoted), Fixing (a belief corrected recently that may come back), Fragile (right but slow), Solid or Fluent, and whether it was tested directly or only inferred. Target active and Fixing misconceptions by name and build on what is Solid; never re-teach Solid or Fluent concepts. Misconception ids are stable kebab-case ids: reuse the ones you are given.'


# V1-4: 4. Tempo bar, nudge scheduler and line annotations: one next action, pop-ups only at real pauses, one owner per line

## spec
PURPOSE:
- One status-bar item replaces today's timer text and is the single 'what next' surface.
- Every nudge from mechanisms 6-12 goes through one Scheduler, so nudges never pile up.
- Every in-editor annotation goes through one LineAnnotationManager, so lines never carry competing text.
SCHEDULER (pure): decide(now, input) returns {action?, pop}.
- Input: queued Actions, lastEditAt, lastPopAt, lastPause {kind, at}, stuckScore, sprintMsToday, activeMsToday, lockHeld, phase.
RULES:
(1) Blocking actions the learner started (atom, gate) open immediately when the InteractionLock is free. Otherwise they wait at the head of the queue.
(2) Nothing pops while the lock is held.
(3) Any other action may pop (warning background plus a one-line setStatusBarMessage flash) only when all of these hold:
    - no edit in the last 8 s
    - at least 30 s since the last pop
    - a pause in the last 20 s, which is one of:
      - a MANUAL save with 0 errors (TextDocumentSaveReason.Manual, read from onWillSaveTextDocument)
      - a spec going from red to green
      - a terminal command succeeding after a failure
      - 20 s idle with no errors
    - Auto-saves (AfterDelay, FocusOut) never count as pauses. With files.autoSave on, they would make every typing pause a 'pause'.
(4) Own-code predict offers pop at most once per 3 active minutes, and never while stuck score is between .5 and 1.0 (except as the pre-hint step).
(5) Sprint offers stop once sprint time exceeds 15% of active time today. Sprints never open automatically while the phase is building; they are only offered.
(6) Skip or Esc on any action is neutral evidence and pushes that action kind back 5 min.
(7) JIT atom offers (mechanism 11) replace the status text without a pop, at the moment their spec becomes the next red one.
STATUS TEXT (40 characters or fewer plus an icon), examples:
- '$(beaker) 3/5 · next: flag takes value'
- '$(mortar-board) next spec: dict counting · 60s?'
- '$(lightbulb) hint ready · cli.py:14'
- '$(zap) 4 due · 60s warm-up'
- '$(question) predict parse_args (15s)'
- '$(sync~spin) designing roadmap · placement 6/12'
- '$(sync~spin) running specs...' (slow imports)
- '$(check) slicing: fragile -> solid' (3 s flash)
TOOLTIP (MarkdownString):
- task title and time vs estimate
- stuck meter % and last progress reason
- background jobs: 'running 2 · queued 1 · 7/20 this hour'
- calibration %
- streak of correct-under-par answers (only when deliberate.showTimers is true)
- the line 'Alt+N does not reach Deliberate while the terminal has focus: click this item instead'
CLICK OR ALT+N (mac: ctrl+alt+n, since alt+n is a dead key there):
- Runs the current action. With no action queued, it opens the sidebar, as today.
- The status-bar click is the primary trigger from the terminal.
maybeOfferHelp(): no longer calls showInformationMessage. At stuck >= 1 it enqueues a priority-1 'hint-ready' action, and the sidebar gets a log card.
LINE ANNOTATION MANAGER (one owner for project-file annotations):
- At most one after-text per line, chosen by priority: hint > spec nudge > own-predict feedback > what-if. Lower-priority texts fold into that decoration's hover.
- After-text is capped at 52 characters. Longer hint text goes to a comment thread (mechanism 10), never a truncated line.
- Offers use a gutter icon decoration (gutterIconPath) plus the tempo bar, never a CodeLens, so code lines never jump while the learner works.
- An annotation clears when its anchored line text changes.
CONTEXT KEYS: deliberate.building (task phase is building) and deliberate.hasAction.

## apis
vscode.window.createStatusBarItem(id, StatusBarAlignment.Left, priority), StatusBarItem.text / tooltip (MarkdownString) / command / name / backgroundColor = new ThemeColor('statusBarItem.warningBackground'), vscode.window.setStatusBarMessage(text, hideAfterTimeout), vscode.commands.registerCommand, vscode.commands.executeCommand('setContext', key, value), vscode.workspace.onWillSaveTextDocument (TextDocumentWillSaveEvent.reason, TextDocumentSaveReason.Manual/AfterDelay/FocusOut), vscode.workspace.onDidSaveTextDocument, vscode.languages.onDidChangeDiagnostics, vscode.window.onDidEndTerminalShellExecution, vscode.window.onDidChangeWindowState, vscode.MarkdownString, vscode.window.createTextEditorDecorationType (gutterIconPath, after), TextEditor.setDecorations

## files
- NEW src/tempo.ts: pure Scheduler, Action, decide().
- NEW src/tempoBar.ts: owns the StatusBarItem 'deliberate.tempo' and replaces renderStatus in src/extension.ts.
- NEW src/annotations.ts: LineAnnotationManager {set(uri, line, source, text, hover), clear(source), onLineChanged}.
- src/monitor.ts:
  - New onPause event:
    - manual clean save: the save reason is recorded per document in onWillSaveTextDocument and consumed in onDidSaveTextDocument
    - terminal success after a failure
    - 20 s clean idle, detected from the 5 s tick
  - Exposes lastSaveReason for spec runs.
- src/coach.ts: enqueueAction(); maybeOfferHelp goes through the scheduler.
- package.json:
  - command deliberate.next ('Deliberate: Do the next thing'), keybinding alt+n (mac ctrl+alt+n), when '!inQuickOpen && !suggestWidgetVisible && !inSnippetMode'
  - setting deliberate.showTimers (boolean, default true)
  - media/gutter-*.svg icons
- NEW test/tempo.test.ts:
  - no pop during a typing burst
  - auto-saves are not pauses
  - 30 s spacing
  - nothing pops while the lock is held
  - 15% sprint cap
  - no sprint auto-open while building
  - blocking actions shown immediately
  - skip pushes the kind back
- NEW test/annotations.test.ts: priority per line; folding into the hover; the 52-character cap routes text to the comment thread.

## schemas
Action { id: string; kind: 'atom'|'jit-atom'|'gate'|'hint-ready'|'own-predict'|'what-if'|'sprint'|'warmup'|'review-ready'|'specs-ready'|'spec'|'placement'; label: string; priority: number; blocking: boolean; command: string; args?: unknown[]; createdAt: number; expiresAt?: number }
SchedulerInput { now: number; actions: Action[]; lastEditAt: number; lastPopAt: number; lastPause?: {kind: 'manual-save'|'spec-green'|'terminal-ok'|'idle'; at: number}; stuckScore: number; sprintMsToday: number; activeMsToday: number; lockHeld: boolean; phase: string }
Annotation { uri: string; line: number; source: 'hint'|'spec'|'own-predict'|'what-if'; text: string; hover: string }

## prompts
None.


# V1-5: 5. Atom content: parametric seed templates, self-verifying model packs and canonical tags

## spec
PURPOSE: the content layer that makes every practice item instant and trustworthy, without running out.
TWO SOURCES:
- Parametric seed templates (bundled) for the fundamentals. They give unlimited surface variants at no model cost, with curated misconception transforms whose belief labels are hand-written and therefore trusted.
- Model AtomPacks, only for tags with no seed template and for project concepts (tag 'other').
CACHE:
- Keyed per language by canonical tag (sub-tag for large tags), falling back to the concept id for 'other'. A concept learned in one project costs nothing in the next.
- Stored in globalStorageUri/atoms/<language>.json, loaded at activation, written debounced, and merged by item id before writing (mechanism 3).
- Per item: seenAt[], n, nCorrect, medianMs.
- Per mutant: matches, confirmations, rejections (its precision). A mutant with precision < .3 after 5 asks is retired.
- An exact item (template + slot values, or a model item id) is never shown to the same learner twice within 7 days.
- LRU cap of 60 items per concept.
TAXONOMY (src/atoms/tags.ts, loaded with the seeds). Per canonical tag:
- kind: 'shape' | 'semantics'
- patternName: canonical; every prompt must use it exactly, and it is renamed to locally on a mismatch
- parent?: for sub-atoms of large tags
- alternatives: tags that are valid alternatives (e.g. counting-with-dict and collections-counter)
- typeSensitive, stateTrace, allowedImports
- misconceptions: [{id, belief (12 words or fewer), prior}]
LARGE TAGS are split into 2-4 sub-atoms in the DAG:
- function-def-call -> function-return-vs-print -> function-params-defaults
- class-def-init -> instance-attributes -> methods-self-this
- recursion-base-case -> recursion-call-stack -> recursion-combine
- closure-capture -> closure-late-binding
- generator-yield -> generator-laziness
- promise-basics -> await-sequencing -> async-error-handling
- this-method-call -> this-arrow-vs-function
SEMANTICS TAGS (rules about how a program runs, not code shapes): alias-copy, scope-local-global, booleans-truthiness, identity-vs-equality, callbacks-event-loop, mutable-default-arg, closure-late-binding, str-vs-number, null-undefined, loose-vs-strict-equality.
- They get a Rule card (rule 12 words or fewer, howItRuns 20 words or fewer) instead of a template.
- In Python, their refutations show a state trace.
PARAMETRIC SEEDS (media/seed/<lang>.json for python, javascript and typescript; about 22 fundamentals each, plus traceback templates and the prerequisite DAG):
- A template is {id, tag, family, kind, code, slots, themes, transforms, parSec}:
  - kind: 'probe'|'example'|'completion'|'contrast'|'traceback'
  - code: with {{slot}} holes
  - slots: {name: generator spec}, e.g. an intList of length 4-6 with values 0-9, an int range, an index relative to a list, a word, a noun
  - themes: variable-name and noun sets such as scores, temperatures, cities
  - transforms: [{misconceptionId, find, replace, belief, refutation, rule}]
- Sibling group = family x theme.
- Instances are drawn with a seeded RNG and run on the learner's own runtime by the batch runner (two passes, mechanism 2). Recorded outputs are therefore always right for the installed Python or Node, whatever its version.
- An instance is valid only if every transform's output differs from the original under the strict comparison, and from every other transform's output. Invalid draws are discarded and redrawn.
- At activation, after runtime detection, the Instantiator makes 3 instances per placement-candidate template in one batch (about 1 s). After that, in the background and with no model call, it refills any concept that drops below 6 unseen instances.
- scripts/verify-seeds.ts (run with tsx, already a devDependency) instantiates 20 of each template on the dev machine. It fails 'npm run package' if fewer than 80% are valid, or if any transform never changes the output.
- media/seed/neutral.json: 3 language-neutral pseudocode tracing items, for languages with no runtime.
MODEL GENERATION (Prefetcher, through the JobQueue):
- Only for tags without seeds and for 'other' concepts; 1-2 concepts per call, at medium effort.
- Triggers:
  - TaskPrep for tasks 1-3 lands: their non-seed concepts with P < .85 (priority 1).
  - Task N enters building: task N+1's non-seed concepts (priority 1).
  - Low stock for a due, fragile, Fixing or misconception concept (priority 3).
- Teach with no seed and no cached or in-flight pack: a MINI ATOM in the foreground at low effort (pattern, 2 probes from 2 groups with mutants, and the completion), about 20-30 s including verification. The full pack is queued in the background.
- If a pack is already in flight, wait for it.
LOCAL VERIFICATION (src/atoms/verify.ts): one batch of all of the pack's code, two passes. About 1-2 s for Python/JS, 2-15 s for compiled adapters.
1. Allowlist check (mechanism 2). Denied items are dropped.
2. Probes:
   - Each must exit cleanly (or raise, for an intentionally raising probe whose answer is the exception name), print 1-4 lines of 200 characters or fewer in total, and give the same output in both passes.
   - compareOutput(model answer, real output) must be 'correct' under the strict comparison. Otherwise the probe goes to the repair list and is never silently overwritten: a model that mispredicted its own item wrote its mutants and refutation from a wrong mental model.
   - Type-sensitive tags must print repr()/type().__name__ (Python) or JSON.stringify/typeof (JS). A bare print of a str or number under such a tag goes to repair.
3. Mutants:
   - Each must differ from the original under the strict comparison.
   - Its 'prints' field (the model's own claim of the mutant's output) must match its real output; otherwise the mutant is dropped.
   - Its diff from the original must be a single line. The local line diff also sets diffLine.
   - Mutants whose outputs equal each other are both marked ambiguous: a match on them records wrong evidence with no misconceptionId.
   - A probe with no attributable mutant is kept with discriminating = false.
4. Refutation text may not contain digits or quoted text that do not appear in the probe code. If it does, it is replaced by '' and the UI shows the locally built line 'actual: X · you said: Y'. belief is cut to 12 words and refutation to 25.
5. Probe metadata, computed locally:
   - constructs (Python ast walk, JS token table)
   - answerSpaceG
   - for stateTrace tags in Python, a trace: per probe line, the values of names the probe defines after that line last ran. Each value's repr is cut to 40 characters, loop counts appear as 'x3', 'b is a' marks two names holding the same mutable object, and each line's text is at most 60 characters.
6. Example: must run cleanly; its output is recorded.
7. Completion:
   - The pattern code sits inside a function.
   - The harness calls it with at least 2 different inputs through check(...). A JS/TS harness without check( is rejected.
   - Each solution fill passes; with the blanks emptied, it fails.
   - Each wrongFill fails. A wrongFill that passes is dropped.
   - A constant fill (each expected value from the harness, written as a literal) must fail, or the completion is dropped.
8. Contrast: both snippets run and their outputs differ.
9. Acceptance:
   - An atom is accepted when at least 2 probes from at least 2 sibling groups survive (a full pack aims for 4 probes in 4 groups), and the example or the completion survives.
   - If more than 40% of a pack fails: one low-effort repair call. Items that still fail are dropped and logged to 'Deliberate: content'.
   - If a concept's pack fails entirely, ConceptState.probeable = false. Its fallback is which-pattern and contrast display items keyed by the model (verified = false, weight .3), plus the escalation lesson on demand. It is never retried in the foreground.
10. pattern.name is renamed to the taxonomy's canonical patternName for the tag. useCases must number at least 6; short lists go to repair.
11. With execution off or untrusted, or no runtime: atoms are stored with verified = false. Evidence uses slip .2 and guess +.1, and mutant matching is disabled because the outputs are only model-claimed.
COMPILED LANGUAGES (Go, Java, Rust):
- The AtomPack prompt asks for probes written as the body of main, with their imports listed.
- The adapter wraps them, compiles the whole pack in one invocation where the toolchain allows, and runs each item.
- Outputs are recorded at verification, so answer-time grading of predict items is instant. Completion grading shows 'running...' for 1-2 s.
UNMATCHED WRONG ANSWERS: optional enrichment, off by default (deliberate.nameNewMisconceptions).
- At most 2 per task, priority 3.
- A returned mutant that actually prints the learner's answer when run is added to the probe, with source 'model'.
ESCALATION LESSONS:
- Enqueued only when a RE-PROBE fails (mechanism 6), as a low-effort priority-0 job (about 10 s), while the learner works on a second sibling item.
- Stored in project.prefetch['lesson:<concept>:<misconceptionId>'].
- The lesson's example block is run. If its stated output does not match, the output line is removed before display, and the mismatch is logged.

## apis
vscode.ExtensionContext.globalStorageUri, vscode.ExtensionContext.extensionUri, vscode.Uri.joinPath, vscode.workspace.fs.readFile, vscode.workspace.fs.writeFile, vscode.workspace.fs.createDirectory, vscode.window.createOutputChannel('Deliberate: content')

## files
- NEW src/atoms/schema.ts: zod AtomPackSchema, MisconceptionGuessSchema, EscalationLessonSchema, plus the StoredAtom and SeedTemplate types.
- NEW src/atoms/tags.ts: CANONICAL_TAGS (about 70) and TAXONOMY as in the spec.
  - Shared tags: variables-assignment, numbers-int-float, integer-division-modulo, str-vs-number, string-indexing, string-methods, string-formatting, string-split-join, booleans-truthiness, comparison-equality, identity-vs-equality, conditionals, while-loop-termination, for-range-bounds, loop-accumulator, nested-loops, break-continue, print-placement-in-loops, list-indexing, list-slicing, list-mutation-methods, alias-copy, list-comprehension, tuple-unpacking, dict-access-missing-key, dict-iteration, counting-with-dict, collections-counter, set-membership, sorting-key, function-def-call, function-return-vs-print, function-params-defaults, mutable-default-arg, scope-local-global, closure-capture, closure-late-binding, recursion-base-case, recursion-call-stack, recursion-combine, exceptions-try-except, raising-errors, reading-tracebacks, class-def-init, instance-attributes, methods-self-this, generator-yield, generator-laziness, file-read-lines, json-parse-serialize, modules-imports, off-by-one.
  - JS/TS tags: null-undefined, loose-vs-strict-equality, let-const-var-scope, array-map-filter-reduce, object-property-access, promise-basics, await-sequencing, async-error-handling, callbacks-event-loop, this-method-call, this-arrow-vs-function, type-annotations.
  - Plus 'other'.
- NEW src/atoms/seeds.ts: Instantiator (seeded RNG, slot generators, theme renaming, transforms, validity rules), using runBatch.
- NEW src/atoms/verify.ts.
- NEW src/atoms/cache.ts: AtomCache {get, put, unseenProbes(key, n, excludeGroups, preferMisconception, allowedConstructs), markSeen, recordItemStat, recordMutantResponse, stock, merge}.
- NEW src/atoms/prefetch.ts.
- NEW media/seed/{python,javascript,typescript,neutral}.json.
- NEW scripts/verify-seeds.ts, plus a package.json script 'verify:seeds' (tsx scripts/verify-seeds.ts) that 'package' runs.
- src/schemas.ts: ConceptSchema gains tag; LessonSchema is replaced by EscalationLessonSchema.
- src/learner.ts: upsertConcepts stores tag, kind and aliases.
- package.json: deliberate.nameNewMisconceptions (boolean, default false).
- NEW test/verify.test.ts, with a fake runner:
  - a probe whose model answer differs from the real output goes to repair and is not overwritten
  - an equal-output mutant is dropped
  - two equal mutants become ambiguous
  - a mutant whose 'prints' claim is wrong is dropped
  - a mutant whose diff spans several lines is dropped
  - a completion that passes with empty blanks, or with a constant fill, is dropped
  - a JS harness without check( is rejected
  - a refutation quoting an output number is blanked
  - repair triggers at 40% failures
- NEW test/seeds.test.ts:
  - instances are deterministic for a seed
  - invalid draws are redrawn
  - sibling groups differ by family and theme
  - no exact repeat within 7 days

## schemas
const Mutant = z.object({ misconceptionId: z.string().describe('kebab-case; reuse a given taxonomy id when one fits'), belief: z.string().describe('the wrong belief in plain learner words, <= 12 words'), refutation: z.string().describe('<= 25 words, concrete, about this code; no output values'), code: z.string().describe('the probe code with ONE line changed so it prints what this belief predicts for the original'), prints: z.string().describe('exact output of this mutant code') });
const Probe = z.object({ id: z.string(), siblingGroup: z.string(), code: z.string().describe('<= 8 lines, prints 1-4 lines'), answer: z.string().describe('exact output, lines joined with a newline'), parSec: z.number().describe('thinking seconds, 3-8'), mutants: z.array(Mutant).describe('1-3') });
const Atom = z.object({ conceptId: z.string(), tag: z.string(), pattern: z.object({ kind: z.enum(['shape', 'semantics']), name: z.string(), useWhen: z.string(), template: z.string().describe('empty for semantics'), rule: z.string().describe('<= 12 words for semantics, else empty'), howItRuns: z.string().describe('<= 20 words for semantics, else empty'), pitfall: z.string(), useCases: z.array(z.string()).describe('6-8') }), probes: z.array(Probe).describe('4, one per sibling group'), example: z.object({ code: z.string(), subgoals: z.array(z.object({ line: z.number(), label: z.string() })) }), completion: z.object({ code: z.string().describe('pattern inside a function; blanks written [[1]], [[2]]'), solutions: z.array(z.string()), wrongFills: z.array(z.object({ blank: z.number(), fill: z.string(), misconceptionId: z.string() })), harness: z.string().describe('check(...) calls with >= 2 different inputs'), parSec: z.number() }), contrast: z.object({ wrong: z.string(), right: z.string(), misconceptionId: z.string(), rule: z.string() }) });
export const AtomPackSchema = z.object({ atoms: z.array(Atom) });
export const MisconceptionGuessSchema = z.object({ knownId: z.string(), newId: z.string(), belief: z.string(), refutation: z.string(), mutantCode: z.string(), slip: z.boolean() });
export const EscalationLessonSchema = z.object({ title: z.string(), explanation: z.string().describe('markdown, <= 120 words'), example: z.string().describe('fenced code, not their project'), rule: z.string().describe('<= 12 words') });
Stored types:
- StoredAtom = Atom & { lang; key; source: 'seed'|'model'; verified: boolean; createdAt }
- each probe adds { output; values; discriminating; answerSpaceG; constructs: string[]; trace?: {line; text}[]; mutants: (Mutant & { output; diffLine; source: 'curated'|'model'; ambiguous: boolean; matches; confirmations; rejections })[]; stats }
- example adds output; contrast adds wrongOutput and rightOutput
- SeedTemplate { id; tag; family; kind; code; slots: Record<string, SlotSpec>; themes: Record<string, Record<string, string>>; transforms: { misconceptionId; find; replace; belief; refutation; rule }[]; parSec }
ConceptSchema adds tag: z.string().describe('closest canonical tag from the list in the prompt, or other').
All fields are required (empty string or [] when unused), following the existing constrained-decoding convention.

## prompts
ATOMPACK (medium effort, background; only for tags without seeds and for project concepts):
'You write practice items for a coding coach. The coach grades the learner by RUNNING your code with ${runtime.version}, so it must be exact and deterministic.
Language: ${lang}. Concepts (id, tag, kind, canonical pattern name, description): ${list}.
Known misconception ids for these tags (reuse when one fits): ${taxonomy}.
The learner already knows these constructs; probes may use ONLY these plus the concept itself: ${allowedConstructs}.
Allowed imports: ${allowedImports}. No input(), files, network, randomness, clock, or dependence on set ordering.
Learner profile: ${snapshot(ids)}
Project domain for variety: ${project.summary}. Never write code that solves or mirrors these tasks: ${taskTitles}.
For EACH concept write one atom:
- pattern: kind shape or semantics as given. name: the canonical pattern name exactly. useWhen <= 12 words. For shape: template <= 3 lines using <holes>. For semantics: rule <= 12 words and howItRuns <= 20 words, template empty. pitfall <= 12 words. useCases: 6-8 different one-line problems (<= 12 words) where this pattern or rule decides the answer.
- probes: exactly 4 predict-the-output items, each in its own siblingGroup (a group is a surface: names, data, story; groups must look unrelated). Each is <= 8 lines and prints 1-4 lines, and its output hinges on the concept, so someone missing it predicts wrong. Prefer outputs that are lists, strings or several lines over a single small number. ${typeSensitive ? 'Print with repr() / type(x).__name__ (Python) or JSON.stringify / typeof (JS) so the type is visible.' : ''} answer: the exact output. parSec: thinking seconds for a competent learner (3-8).
- mutants: for each probe, 1-3 copies with exactly ONE line changed, so that running the copy prints what a learner holding one specific wrong belief would predict for the ORIGINAL code (for example, belief slice end is included: change xs[1:3] to xs[1:4]). Each must print something different from the original and from the other mutants. prints: the exact output of the mutant. belief: <= 12 words in plain learner words. refutation: <= 25 words, concrete, about this code, without quoting any output values.
- example: 5-8 lines applying the pattern on a new surface and printing its result; subgoals: a label of <= 6 words for each meaningful line (1-based).
- completion: 6-10 lines on another new surface; the pattern code sits inside a function; 1-2 blanks written [[1]], [[2]] exactly where the pattern lives; solutions: the exact text for each blank; wrongFills: 1-2 plausible wrong fills with misconceptionId; harness: lines appended after the code that call the function with at least 2 different inputs using check(condition, message) (check is predefined; do not use assert, require or process), print nothing, and pass only with correct fills.
- contrast: two snippets of <= 4 lines, identical except for the one feature that matters, with misconceptionId and a rule of <= 12 words.
${lang === 'typescript' ? 'Use only erasable TypeScript syntax: no enum, namespace or parameter properties.' : ''}${compiled ? 'Write each probe, example and contrast as the body of main only, listing imports at the top.' : ''}
Write for a beginner who reads at most 60 words per atom. Gloss any jargon in 3 words.'
MINI ATOM (foreground, low effort): the same prompt plus 'Write the pattern, 2 probes (in 2 sibling groups, with mutants) and the completion only; set the example and contrast fields to empty strings and empty arrays.'
PROBES-ONLY SEED VARIANT (languages without seeds, at placement, low effort): the same prompt plus 'Write the pattern and the probes (with mutants) only; set example, completion and contrast to empty strings and empty arrays.'
REPAIR (low effort): 'These items from your last pack failed when run locally with ${runtime}: ${failures: conceptId, item id, what failed (for a probe: your answer vs the real output), stderr tail <= 300 chars}. Return the same atoms with ONLY these items corrected. If your answer was wrong, rewrite the probe, its mutants and its refutation from scratch rather than adjusting the answer. Keep items that passed unchanged.'
MISCONCEPTION GUESS (low effort, opt-in): 'A learner predicted the output of this ${lang} code: ${code}. Actual output: ${actual}. Their answer: ${answer}. Known misconceptions for this concept: ${id: belief list}. If one known misconception explains their answer, return it as knownId. Otherwise propose newId (kebab-case), belief (the wrong belief in plain learner words, <= 12 words), refutation (<= 25 words, no output values) and mutantCode: the code with one line changed so that running it prints exactly their answer under that belief (empty string if impossible). Set slip true if the answer looks like a typo or careless slip rather than a belief.'
ESCALATION LESSON (low effort, fired when a re-probe fails): '${projectBrief}. Concept: ${c.id} - ${c.name}: ${c.description}. The learner confirmed holding this wrong belief: ${belief} (misconception ${M}). Evidence: ${items: code, their answer, actual output}. Write a lesson of at most 120 words that dislodges exactly this belief: (1) one sentence on why the belief seems reasonable, (2) the one fact that breaks it, shown with a 3-line example that is not their project code, with its real output, (3) a one-line rule they can apply. No check question, no headings, no general overview of the topic.'


# V1-6: 6. Atom Pad: the probe-first concept block in an in-memory editor tab

## spec
TRIGGERS:
- Teach me: sidebar button or command deliberate.teach
- hint rung 2 on a concept gap
- gate routing (mechanism 8)
- an accepted JIT offer (mechanism 11)
- a sprint item failed twice on one concept
- an offer the learner accepts from the tempo bar (a spec stuck on one failure signature, an own-code mismatch)
Cap before building: 2 atoms or 120 s per task. Other gaps become JIT offers.
SURFACE (in memory, invisible to language servers and AI completion):
- An in-memory FileSystemProvider is registered for scheme 'deliberate-pad' (isCaseSensitive).
  - The pad is deliberate-pad:/atom.dlbpy (or .dlbjs, .dlbts, .dlbgo, .dlbjava, .dlbrs).
- Custom language ids: deliberate-pad-python, -javascript, -typescript, -go, -java, -rust, mapped by those extensions (setTextDocumentLanguage as a fallback).
  - Each has a one-line TextMate grammar that includes source.python, source.js, source.ts, source.go, source.java or source.rust, so colouring works.
  - No language server, Run button, linter, diagnostics or hover provider attaches, because those select by language ('python' etc.) and scheme 'file'.
- configurationDefaults for each pad language:
  - editor.inlineSuggest.enabled false (blocks Copilot-style ghost text)
  - editor.quickSuggestions off for other, comments and strings
  - editor.suggestOnTriggerCharacters false
  - editor.wordBasedSuggestions 'off'
  - editor.parameterHints.enabled false
  - editor.insertSpaces true, editor.tabSize 4, editor.detectIndentation false
  - editor.formatOnSave false, editor.formatOnType false
  - All editor.* settings are language-overridable (checked in the installed build: the editor configuration node has the language-overridable scope).
  - Critique note: editor.hover.enabled is NOT disabled. The pad shows refutations in hovers, and the setting changed type from boolean in 1.93 to an enum ('on'/'off'/'onKeyboardModifier') in the installed 1.140 build, so one default value would be invalid on one of them. With no language server attached, no hover can leak the answer.
- Assisted-answer guard: a pad content change not made by the coach that inserts 12 or more non-whitespace characters at once marks the current item assisted. Its answer is discarded, with the after-text 'looked auto-inserted: not counted'.
- Opened with showTextDocument({viewColumn: Beside (or the active column when deliberate.padColumn = 'active'), preview: false, preserveFocus: false, selection: the answer position}).
  - preview: false stops an Explorer click from replacing the tab mid-atom.
- Each step replaces the content with TextEditor.edit (full range).
- Snippets (completion blanks, skeletons) are inserted with insertSnippet at (0,0) of the emptied document, built with 4-space indentation. insertSnippet in 1.93 has only undoStopBefore/After and re-indents to the insertion line.
- Context keys:
  - deliberate.atomFocused is true while the pad is the active editor
  - deliberate.padAwait is 'answer' | 'yn' | 'pick2' | 'pick3' | 'read'
- On activation, any leftover deliberate-pad tabs (from a reload) are closed.
PROBE LAYOUT (Python; JS/TS/Go/Java/Rust use '//'):
- line 1: '# what does this print?'
  - The header is generic: the concept is never named on probes, re-probes, final predicts, placement or sprint items, so the learner must decide which idea applies.
  - A key legend ('Ctrl+Enter submit · Ctrl+Shift+Enter guessing · ? no idea · | between lines') is appended until the learner has used each of those keys 3 times (Learner.keyUse).
- lines 2-9: the probe code.
- last line: '# -> ' with the cursor after it.
  - For multi-line outputs the learner adds more '# -> ' lines, or separates lines with ' | '. The pad never states how many lines are printed.
- Answer parsing: every line whose trimmed text starts with the comment token followed by '->', in order.
  - Empty answer: re-prompt ('type an answer, or ? for no idea'); never scored.
  - '?' means don't know.
KEYS (package.json, all scoped):
- ctrl+enter (mac cmd+enter): deliberate.atomSubmit, when 'deliberate.atomFocused && editorTextFocus && !suggestWidgetVisible'
- ctrl+shift+enter (mac cmd+shift+enter): deliberate.atomSubmitGuess, same when-clause
- y / n: deliberate.padYes / padNo, when 'deliberate.atomFocused && deliberate.padAwait == yn'
- 1 / 2 / 3: deliberate.padPick, when 'deliberate.atomFocused && deliberate.padAwait == pick2' (or pick3)
- Leaving:
  - a double Escape within 600 ms: deliberate.atomEscape counts presses, when 'deliberate.atomFocused && editorTextFocus && !suggestWidgetVisible && !inSnippetMode && !findWidgetVisible && !editorHoverVisible && !renameInputVisible && !inlineChatVisible && !notificationToastsVisible'. A single Esc that closes a hover or toast never aborts the atom.
  - the command 'Deliberate: Leave practice'
  - closing the tab
GRADING (src/atoms/grade.ts, pure):
- gradePredict: compareOutput (mechanism 2) against the recorded output, then against the mutants.
- gradeCompletion: runs the document text + newline + harness through the batch runner (under 1 s; 1-2 s compiled). It finds the failing line by the 'CHECK' marker in the error output, not by line arithmetic.
- gradeTraceback: parses 'line N, ExceptionName' and the 1/2/3 meaning pick.
FEEDBACK DECORATIONS (after-text 52 characters or fewer; full text in hoverMessage):
- Correct: 'ok 7s' (testing.iconPassed).
- Format-only: 'right idea; Python writes it as [2, 3]' (editorInfo.foreground).
- Wrong: 'actual: [2, 3]' (testing.iconFailed).
- Mutant match: the BELIEF-CHECK step (below). Afterwards the diff line gets diffEditor.removedLineBackground, with the refutation as after-text and hover.
- Subgoal labels: italic after-text, e.g. '<- start an empty accumulator' (editorCodeLens.foreground).
- Python trace (REVEAL step): after-text per probe line, e.g. '-> a=[1, 2]  b is a'.
STEP MACHINE: exactly as in conceptAtom (ROUTE, PROBE, PROBE2, BELIEF-CHECK, REFUTE with CONTRAST-PICK, REVEAL, RE-PROBE and SECOND SIBLING, UNKNOWN, ESCALATE).
- Evidence is recorded at every graded step through recordEvidence, source 'atom'.
- Item choice: AtomCache.unseenProbes(..., allowedConstructs = constructs with P >= .5 plus the target). Fallback: the probe with the fewest unmastered constructs, recorded at weight .5.
- UNKNOWN example step: header '# Pattern: <name> - <useWhen>', or '# Rule: <rule>' for semantics tags; subgoal after-texts; padAwait 'read'; Ctrl+Enter after reading. Large tags show a second example on another surface before the completion.
- Completion step:
  - Blanks are snippet tab stops (SnippetString.appendText plus appendPlaceholder('___', n)). Tab moves between them.
  - A failure shows the failing check as after-text on the blank's line.
  - The second failure reveals the fill as a highlighted line.
- ESCALATE: render project.prefetch['lesson:<concept>:<M>'] as a comment block above a fresh completion.
  - If the lesson has not landed, the header reads '# preparing a short lesson... (~10 s)' and the pad waits.
  - No sprint is ever nested inside an open atom.
- CAPS: 7 graded items or 150 s, then exit at the current state. The clock pauses during ESCALATE, which has its own 150 s limit.
LATENCY: measured from step render (window focused) to submit; invalid if focus was lost in between.
EXIT:
- document.save() (writes to memory: no save prompt, no revert juggling), then tabGroups.close(the pad tab).
- Restore the previous editor's uri, viewColumn and selection. setContext deliberate.atomFocused to false.
- Add or update the PatternCard in learner.patternDeck.
- setStatusBarMessage('<concept>: Unknown -> Learning (41s)', 3000). The concept is named only here and in the log card.
- Push one compact sidebar log card: concept, path, items, seconds, misconception status.
- When the task is building, call detector.markProgress(now, 'atom finished'), then return to resumePhase.
- Release the InteractionLock.
- The learner closing the tab themselves (tabGroups.onDidChangeTabs) counts as Esc.
COACH INTEGRATION:
- teach(conceptId) and teachInner() call pad.run(atom) when the cache has an atom (seed instances or a pack).
- If a pack job is in flight, or a mini atom is needed:
  - Not building, and no edit in the last 8 s: a sprint fills the pad until the content lands, then the atom starts. These run one after the other, never nested.
  - Building: the pad is not opened. The tempo bar shows 'preparing <concept> drill (~20 s)' and offers it when ready.
- The LessonSchema card and its check question are deleted.
- While the pad is open, task.phase = 'learning' (an overlay, with resumePhase as today). inputMode shows mode 'atom': 'Practice is open in the editor (Esc Esc to leave)'.
- Coach depends on an AtomRunner interface, so tests can inject a fake.

## apis
vscode.workspace.registerFileSystemProvider('deliberate-pad', provider, {isCaseSensitive: true}), vscode.FileSystemProvider (stat, readFile, writeFile, readDirectory, createDirectory, delete, rename, watch, onDidChangeFile), vscode.languages.setTextDocumentLanguage, vscode.workspace.openTextDocument(uri), vscode.window.showTextDocument (TextDocumentShowOptions.viewColumn = ViewColumn.Beside, preview: false, preserveFocus, selection), TextEditor.edit, TextEditor.insertSnippet (options: undoStopBefore/undoStopAfter only in 1.93), vscode.SnippetString (appendText, appendPlaceholder), vscode.window.createTextEditorDecorationType (isWholeLine, backgroundColor, after: contentText/color/margin/fontStyle), TextEditor.setDecorations (DecorationOptions.range, hoverMessage: MarkdownString, renderOptions), TextEditor.revealRange (TextEditorRevealType.InCenterIfOutsideViewport), TextDocument.save, vscode.ThemeColor, vscode.commands.registerCommand, vscode.commands.executeCommand('setContext', 'deliberate.atomFocused' | 'deliberate.padAwait', value), vscode.window.onDidChangeActiveTextEditor, vscode.window.tabGroups (all, close, onDidChangeTabs), vscode.TabInputText, vscode.window.state / onDidChangeWindowState, vscode.window.setStatusBarMessage, package.json contributes.languages, contributes.grammars, contributes.configurationDefaults ('[deliberate-pad-python]': {...})

## files
- NEW src/atoms/padfs.ts: in-memory FileSystemProvider for 'deliberate-pad'.
- NEW src/atoms/pad.ts: AtomPad implementing AtomRunner {run(atom, opts): Promise<AtomResult>}. Holds the step machine, decoration types, open/close, context keys, the assisted-insert guard and the key legend.
- NEW src/atoms/grade.ts (pure): gradePredict, gradeCompletion, gradeTraceback, parseAnswerLines, failingCheckLine.
- NEW src/atoms/render.ts (pure): builds the pad text and line indices for each step and comment token.
- NEW syntaxes/pad-{python,javascript,typescript,go,java,rust}.tmLanguage.json. Each has scopeName source.deliberate-pad-X and patterns [{include: 'source.X'}]. Plus language-configuration files with the right line comment.
- src/coach.ts:
  - teach/teachInner use the pad
  - answerCheck and pendingCheck deleted
  - inputMode gains the 'atom' mode
  - log card
- src/types.ts: remove Task.pendingCheck; add Task.atomRuns and Learner.keyUse.
- src/extension.ts:
  - register the FileSystemProvider
  - register the commands deliberate.atomSubmit, atomSubmitGuess, padYes, padNo, padPick, atomEscape and leavePractice
  - close leftover pad tabs
- package.json:
  - contributes.languages (ids, extensions, configuration) and contributes.grammars
  - configurationDefaults per pad language, as listed in the spec
  - the commands and keybindings, with the when-clauses in the spec
  - setting deliberate.padColumn (enum beside/active, default beside)
- media/main.js: MODE_LABELS adds atom: 'Practice open in the editor'; removes check.
- NEW test/pad.test.ts drives the step machine with a fake editor and runner through:
  - tested-out (2 groups)
  - belief y -> contrast -> re-probe -> fixed (suppressed)
  - belief n -> slip
  - re-probe fail -> second sibling -> escalate, with the lesson enqueued at the re-probe
  - unknown -> learned (a large tag with 2 examples)
  - format-only: no evidence, then continues
  - caps, with the clock paused in ESCALATE
  - double-Esc
  - an assisted insert discarding an answer
- NEW test/grade.test.ts.
- NEW test/render.test.ts: snippet text built with 4-space indentation inserts correctly under tab and 2-space user settings.

## schemas
Types:
- AtomResult { conceptId: string; path: 'tested-out'|'confirmed'|'fixed'|'learned'|'partial'|'escalated'|'aborted'; items: number; ms: number; misconceptionId?: string; misconceptionStatus?: string; stateBefore: string; stateAfter: string }
- AtomRunState { conceptKey: string; step: 'probe'|'probe2'|'belief-check'|'contrast-pick'|'reveal'|'reprobe'|'second-sibling'|'example'|'example2'|'completion'|'final-predict'|'escalate'; startedAt: number; pausedMs: number; groupsUsed: string[]; graded: { itemId: string; kind: ItemKind; shownAt: number; answer: string; verdict: string; guess: boolean; implicitGuess: boolean; assisted: boolean; latencyMs?: number; latencyValid: boolean; misconceptionId?: string; beliefConfirmed?: boolean }[]; retries: number }
- Task.atomRuns?: AtomResult[]
No zod changes: content comes from AtomPack and the seeds.

## prompts
No model call while an atom runs, except the escalation lesson, which is enqueued in the background the moment a re-probe fails. A concept with no seed and no cached atom uses the mechanism 5 MINI ATOM prompt at low effort (about 20-30 s with verification).


# V1-7: 7. Placement blitz during a split roadmap call

## spec
startProject(goal, background) no longer awaits the roadmap.
t = 0, LANGUAGE:
- Take the top workspace extension from workspaceLanguages(), or keywords in the goal or background:
  - python, py, django, flask, pandas: python
  - typescript, ts, angular, nest: typescript
  - javascript, js, node, react, express: javascript
  - go, golang: go
  - java, spring: java
  - rust, cargo: rust
- If there is no match, or a conflict: QuickPick 'Which language?' with Python, JavaScript, TypeScript, Go, Java, Rust, Other. Other opens an InputBox.
- The language is fixed input to every later prompt; the plan no longer returns one.
- Save a project shell immediately (goal, language, placement state). The sidebar shows 'Designing your roadmap (~1-2 min) - placement is open in the editor'.
ROADMAP, split so that no single call gates everything:
- PlanOutline: medium effort, bg priority 0, key 'plan', about 40-70 s.
  - Returns milestones, concepts with tags and prerequisites, and the full task list for milestone 1 only. Each task carries its interface (file + 1-3 signatures).
  - Wrapped in withProgress(ProgressLocation.Window, 'Deliberate: designing roadmap').
  - deliberate.planEffort can raise it to high.
- TaskBatch: medium, priority 1, key 'batch:<milestone>'.
  - Writes the tasks for milestone k+1, fired when milestone k starts.
  - Receives the current fade level (mechanism 8) and a summary of the code so far.
- FAILURE: if PlanOutline fails, times out or hits a usage limit, push a card 'Roadmap failed: <reason>' with a Retry button. Placement results are kept.
- RECONCILE on activation:
  - if project.placement.planPending and there are no milestones, enqueue 'plan' again
  - if the current milestone is the last one with tasks and the next has none, enqueue its TaskBatch
OPTIONAL PRIOR (8 s or less):
- QuickPick with canSelectMany: 'Tick what you have used before (Esc to skip)'.
- Lists the 8 most-depended-on seed fundamentals, each with a one-line example in detail.
- Ticked: P .7 and selfRating 'used'. Unticked: P .2. Esc: unchanged at .3.
BLITZ (pad in placement mode, generic headers, no teaching):
- Item 1 is a typing calibration: '# copy this exactly, then Ctrl+Enter' with a short literal like [3, 'a', True]. It measures cps for par (mechanism 3) and is not scored.
- Python, JS and TS draw parametric seed instances, verified on this machine at activation.
- Go, Java and Rust, and languages with no runtime, start with the 3 neutral items while a low-effort probes-only seed pack runs (about 15-60 s including compilation).
SELECTION (src/atoms/placement.ts, pure):
- Candidates: seed fundamentals, plus plan concepts once the plan lands (mapped by tag through aliases).
- score(c) = importance(c) x (1 - |P(c) - .5| x 2) + leafBonus.
  - importance = 1 + number of DAG descendants + 2 x [needed by tasks 1-3].
  - For ticked concepts, items start at the deepest ticked leaves (leafBonus 3), because a correct leaf supports all its ancestors (mechanism 3 propagation).
- Pick a predict item from an unseen sibling group, using constructs the learner is believed to know.
- The last 2 items are completion items on the two highest-importance concepts at P >= .7, to check production and not just reading.
FEEDBACK:
- Correct: 'ok 6s' for 600 ms.
- Wrong: 'actual: X' for 1.5 s.
- Format-only: 'right idea; written as X' for 1.5 s.
- A mutant match records a candidate misconception (unconfirmed odds, mechanism 3). The later atom starts from it (ROUTE goes to BELIEF-CHECK).
- Evidence source is 'placement'.
STOP RULE: stop on any of these:
- every concept needed by tasks 1-3 has P outside [.25, .8], or has had 2 items
- 14 items, 4 minutes, or Esc
- the EXPERIENCED FAST LANE: 3 correct leaf items in a row under par_self, including 1 completion. The fast lane ends placement, and every inferred-mastered ancestor skips gates.
If the plan is still pending at the stop:
- continue with up to 5 harder items on concepts at P .6-.85, labelled 'roadmap almost ready'
- if it is still pending after that, the pad closes and the tempo bar shows the wait, with a 'Practice while you wait' sprint offer
PLAN LANDS (at any point):
- upsertConcepts with tags; merge plan concepts into seed concepts by tag (aliases, mechanism 3).
- Build milestones and milestone-1 tasks. Mark the last task of every milestone solo (mechanism 8).
- Prefetcher enqueues:
  - TaskPrep for tasks 1-3, in one call, with neededBy = predicted placement end
  - AtomPacks for the non-seed tags of tasks 1-3, and nothing for seeded tags
- If placement is still running, it gains the project concepts as candidates.
FINISH:
- One sidebar card, e.g. 'Placement: 11 items, 2m10s. Solid: loops, lists, functions. Possible misconception: alias-copy (seen once). New: dict iteration (drilled when task 2 needs it)'.
- A status flash.
- Task 1 begins, with a gate only if its rules apply.
DELETED: buildDiagnostic, pushDiagnosticQuestion, answerDiagnostic, finishDiagnostic, DiagnosticSchema, Project.diagnostic, DiagnosticQuestion, the 'diagnostic' input mode, the diagnosticSkip command, and every GradeSchema call during placement.

## apis
vscode.window.createQuickPick (canSelectMany, items, selectedItems, onDidAccept, onDidHide, title, placeholder), vscode.window.showInputBox, vscode.window.withProgress (ProgressLocation.Window), vscode.ExtensionContext.extensionUri + vscode.workspace.fs.readFile (seed banks), vscode.workspace.findFiles (workspaceLanguages), Atom Pad APIs from mechanism 6

## files
- NEW src/atoms/placement.ts (pure): nextItem(state, cache, learner, dag), record(), shouldStop() (including the fast lane), summary().
- src/coach.ts:
  - startProject rewritten: project shell, bg PlanOutline, placement.run, a merge handler for when the plan arrives, and a Retry card.
  - A milestone-start hook enqueues the next TaskBatch.
  - reconcile().
  - Diagnostic code deleted.
  - finishPlacement() reuses the summary-card unshift onto the first task feed.
- src/types.ts:
  - Project.diagnostic becomes Project.placement { asked: string[]; startedAt: number; done: boolean; selfRated: boolean; planPending: boolean; planError?: string; calibrated: boolean }
  - Remove Diagnostic and DiagnosticQuestion.
  - Task gains interface, solo and fade.
- src/schemas.ts:
  - PlanSchema becomes PlanOutlineSchema.
  - NEW TaskBatchSchema.
  - Delete DiagnosticSchema.
  - ConceptSchema gains tag.
- src/view.ts: remove diagnosticSkip; add retryPlan.
- media/main.js:
  - Onboarding copy: 'I plan your roadmap (~1-2 min) while you answer ~10 quick predict-the-output checks in the editor. No essays.'
  - Remove the diagnostic mode.
- package.json: deliberate.planEffort (enum medium/high, default medium).
- test/flow.test.ts:
  - placement drives fake pad answers while PlanOutline is deferred
  - asserts zero GradeSchema calls
  - task 1 starts after the plan resolves
  - a failed plan shows Retry and keeps placement evidence
  - reconcile re-enqueues a pending plan
- NEW test/placement.test.ts: leaf-first for ticked concepts, the stop rule, the fast lane, propagation effects.

## schemas
const TaskOut = z.object({ title: z.string(), description: z.string(), acceptanceCriteria: z.array(z.string()), conceptIds: z.array(z.string()).describe('1-3'), estimatedMinutes: z.number(), interface: z.object({ file: z.string().describe('workspace-relative'), functions: z.array(z.object({ name: z.string(), signature: z.string(), purpose: z.string().describe('<= 12 words, behaviour only') })).describe('1-3') }) });
export const PlanOutlineSchema = z.object({ summary: z.string(), milestones: z.array(z.object({ title: z.string(), goal: z.string() })).describe('3-6'), concepts: z.array(ConceptSchema).describe('8-25, with tag'), milestone1Tasks: z.array(TaskOut).describe('3-6') });
export const TaskBatchSchema = z.object({ tasks: z.array(TaskOut).describe('3-6') });
Project.placement: as listed in files.
DiagnosticSchema removed. The old PlanSchema language field is gone (the language is fixed input).

## prompts
PLANOUTLINE (medium effort, background):
'Design a learning roadmap for this goal. The language is fixed: ${lang} (${runtime.version}); do not change it.
Goal: ${goal}. Background: ${background}. Learner profile: ${snapshot}.
- 3 to 6 milestones, each with a title and a one-sentence goal.
- List every concept the project needs, including the fundamentals the tasks rely on (8-25 concepts), with prerequisites. For each concept set tag to the closest canonical tag from this list, or other: ${CANONICAL_TAGS.join(', ')}. Reuse these concept ids exactly when the project needs the idea (they match the learner history): ${seedIdsWithTags}.
- For milestone 1 only, write 3 to 6 tasks. Each task is 5-15 minutes of building and ends with something that runs. The first is a 5-10 minute warm-up. Each builds on the code from the previous one.
- Put each task core logic in plain functions that take and return plain values (numbers, strings, lists, dicts). File, network, input and UI work goes in thin outer code under a main guard (if __name__ == '__main__' in Python, a guarded main() call in JS), so behaviour can be checked by fast local specs.
- interface: the one workspace-relative file and 1-3 function signatures the learner writes (name and signature only${isJs ? '; the functions are exported' : ''}). Reuse an existing file when a task extends it.
- Tag each task with the 1-3 concept ids it exercises most.
- Task descriptions say what to build and how to check it works, never how to implement it.'
TASKBATCH (medium effort, background): the same task rules plus 'Write the tasks for milestone ${k}: ${milestone}. Code so far: ${fileList with interface signatures}. Scaffolding level: ${fade}. At partial, tasks may be 10-20 minutes; at minimal, 20-30 minutes, and descriptions name only the behaviour and the interface.'
For languages without seeds, placement uses the mechanism 5 probes-only variant for 6 fundamentals.


# V1-8: 8. Task gate with fading scaffolds and solo tasks: pattern pick + 1-of-3 plan pick (replaces the approach essay)

## spec
beginTask(t) decides the gate, then sets phase 'gate' or 'building'.
FADE LEVEL: computed from P of the pseudo-concept 'decomposition' and stored on Task.fade at task start.
- full (P < .5): gate steps A and B when the gate runs; all spec titles visible.
- partial (.5 <= P < .8): step A only. Only the next red spec's title is shown; later titles appear as each one turns green.
- minimal (P >= .8): no gate. The learner sees the interface plus 'n of m behaviours pass', with no titles. TaskBatch asks for 20-30 minute tasks.
- solo: the last task of every milestone.
  - No gate, no spec titles, no JIT offers or signature nudges.
  - Hints capped at rung 2, and no Reveal.
  - Records 'task' evidence on 'decomposition' at weight 1.
  - It is the headline transfer measure (successMetrics).
WHEN THE GATE RUNS (otherwise it costs 0 s): all of these hold:
- the task brings in at least one concept that is not in any earlier task's conceptIds and is not mastered
- the task is not solo
- fade is not minimal
Consecutive tasks that reuse concepts skip it.
GATE PACK NOT CACHED (cache miss): start building at once with a one-line card 'Plan it in your head: which patterns, in what order?'. Never block.
READING BUDGET: the gate shows 50 words or fewer in total: names only, no detail lines.
STEP A, PATTERN PICK:
- createQuickPick with canSelectMany = true, ignoreFocusOut = true.
- title: 'Task 2 · Word counter: which patterns will you need?'
- placeholder: 'Space toggles · Enter submits'
- items: 5 pattern names (2-3 required, the rest near-miss lures), shuffled. label = the canonical name only, 4 words or fewer.
- buttons: [{iconPath: new ThemeIcon('edit'), tooltip: 'I'd do it differently'}].
- Grading, per pattern:
  - required and selected: correct (pattern-pick)
  - required and missed: wrong (pattern-pick)
  - lure selected: wrong at weight .3 on the required concept it competes with, and NO misconception. Valid alternatives such as collections.Counter vs dict.get are common, and an unverified model key must not plant a named belief.
- Feedback goes into the next title, not a separate picker:
  - step B's title becomes '2/3 patterns · missed: Count with dict · Which plan works?'
  - without step B, a 3 s flash
  - the missed items' useWhen and the lures' whyNot go to the sidebar log card
STEP B, PLAN PICK (fade full only):
- Single-select QuickPick with 3 items labelled '1 <plan>', '2 ...', '3 ...'. Each plan is 10 words or fewer, with no detail lines. Same 'I'd do it differently' button.
- Before use, the coach shuffles the plans and checks locally that their lengths are within ±20% of their mean, in characters. Otherwise the workable plan is often the longest. If the check fails, step B is dropped for that task.
- Workable pick: correct (plan-pick).
- Flawed pick: wrong on flawConceptId, with its misconceptionId at odds x2 (mechanism 3). The 'Go build' flash then shows whyFlawed (a question), and the sidebar card shows the workable plan.
'I'D DO IT DIFFERENTLY' (button on both steps):
- Closes the QuickPick, records nothing, and focuses the sidebar composer in 'explain' mode.
- On submit, the ExplanationReviewSchema review runs as a bg job and the phase moves to building at once.
- The verdict arrives as a card. 'gaps' enqueues an atom offer instead of blocking.
ROUTING:
- These each open an atom (mechanism 6):
  - a missed required pattern whose concept has P < .5
  - the concept behind a flawed plan pick
  - any task concept with a candidate misconception at p >= .3
- Cap: 2 atoms or 120 s. Deferred concepts become JIT offers on the spec that needs them (mechanism 11), not stuck-detector waits.
- Then flash 'Go build', set phase 'building', call monitor.startTask(), and executeCommand('workbench.action.focusActiveEditorGroup').
- Flawed plan picks in 3 tasks lower 'decomposition'. 2 flawed picks in one task show guideApproach() as a background-generated card.
PERSISTENCE: Task.gate {patterns, plans, result: {selected, missed, lures, planPicked, ms}}. The required patterns become the task's pending pattern list in the tempo tooltip.
TASKPREP: one call prepares the gate and the spec ladder for up to 3 tasks.
- Fired for tasks 1-3 when the plan lands.
- Fired for the next up-to-3 existing tasks when the second-to-last task of the current trio enters building, with neededBy = the predicted start of the first of them.
- The gate part is consumed here; the specs part by mechanism 11.

## apis
vscode.window.createQuickPick (canSelectMany, items, selectedItems, buttons, onDidTriggerButton, onDidAccept, onDidHide, title, placeholder, ignoreFocusOut), vscode.QuickPickItem (label, description), vscode.QuickInputButton, vscode.ThemeIcon, vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'), vscode.window.setStatusBarMessage

## files
- NEW src/gate.ts: GateUi {run(task, prep): Promise<GateResult>}. QuickPick construction, plus pure exported grading, the length check, and the fade and run rules.
- src/coach.ts:
  - beginTask uses the fade and gate rules.
  - New gateDone(result) for routing.
  - submitExplanation becomes a bg job, reachable only from the gate button or the composer.
  - skipExplain is removed.
  - noIdea opens the atom for the weakest concept.
  - Solo tasks cap hints at rung 2 and hide Reveal.
- src/atoms/prefetch.ts: TaskPrep jobs as in the spec. Follow-ups get their own TaskPrep when generated.
- src/types.ts:
  - Phase adds 'gate' (keep 'explain' only for the free-text path).
  - Task.gate, Task.fade ('full'|'partial'|'minimal'|'solo'), Task.solo.
- src/schemas.ts: TaskPrepSchema (gate part here, specs part in mechanism 11).
- media/main.js: MODE_LABELS gate: 'Answer in the popup (or explain your own plan)'.
- test/flow.test.ts:
  - a gate pass goes to building
  - a missed pattern runs a fake atom
  - a lure records no misconception
  - the gate is skipped when no new concept
  - a cache miss goes straight to building
  - zero ExplanationReviewSchema calls on the default path
  - solo tasks never gate
- NEW test/gate.test.ts: grading; the length check drops step B; fade thresholds.

## schemas
const GatePart = z.object({ patterns: z.array(z.object({ name: z.string().describe('canonical pattern name when one is given, else <= 4 words'), conceptId: z.string(), required: z.boolean(), competesWith: z.string().describe('for lures: the required conceptId it competes with; else empty'), useWhen: z.string().describe('<= 12 words'), whyNot: z.string().describe('<= 12 words for lures, else empty') })).describe('exactly 5'), plans: z.array(z.object({ text: z.string().describe('<= 10 words, no code'), workable: z.boolean(), flawConceptId: z.string(), misconceptionId: z.string(), whyFlawed: z.string().describe('<= 20 words, phrased as a question; empty for the workable plan') })).describe('exactly 3, similar length') });
export const TaskPrepSchema = z.object({ tasks: z.array(z.object({ taskTitle: z.string(), gate: GatePart, specs: SpecLadderPart /* defined in mechanism 11 */ })) });
Task.gate?: { patterns: ...; plans: ...; result?: { selected: string[]; missed: string[]; lures: string[]; planPicked: number; ms: number } }
Task.fade: 'full'|'partial'|'minimal'|'solo'

## prompts
TASKPREP (medium effort, background; one call for up to 3 tasks):
'Prepare the pre-coding gate and the behaviour specs for each task below. Both are graded locally from your answer key, so be exact.
Language: ${lang} (${runtime.version}). Tasks: ${tasks: title, description, acceptance criteria, conceptIds, interface}
Canonical pattern names (use exactly when they apply): ${taxonomy patternNames with conceptIds}
Learner profile: ${snapshot}
Files in the workspace now: ${fileList}; current content of each interface file that exists: ${contents}
For each task:
GATE
- patterns: exactly 5. 2-3 are required (the task cannot be done well without them); the rest are near-miss lures a beginner might wrongly choose. For each lure give competesWith (the required conceptId it would replace) and whyNot <= 12 words saying why it does not fit THIS task. Do not list a valid alternative approach as a lure. name: the canonical name, else <= 4 words.
- plans: exactly 3 plain-language plans of <= 10 words each, no code, of similar length. Exactly one is workable. Each of the other two hides one concept flaw that would actually bite; give flawConceptId, a misconceptionId (reuse a taxonomy id if one fits) and whyFlawed <= 20 words phrased as the question that exposes it. Do not make the flawed plans obviously silly or shorter.
SPECS
${SPEC_SECTION from mechanism 11}
Never give implementation code except in the private reference.'


# V1-9: 9. Never idle: wait-filling sprints, traceback items, warm-ups, async open-ended grading and leaner follow-ups

## spec
(a) SPRINT ENGINE (src/atoms/sprint.ts): Sprint.run({budgetMs = 90000, until?: Promise, maxItems = 6, reason}).
- All headers are generic ('# what does this print?'). The concept is named only in the result card.
- Selection order:
  1. delayed misconception checks: items carrying the mutant of a suppressed misconception whose next check is due (10 min, then 1 day), and different-group items for active ones
  2. mastery audits that are due: a completion, 1+ day after mastery, inferred-mastered concepts first
  3. guess-flagged and fragile concepts
  4. dueForReview
  5. confirmation items for inferred concepts with single support
  6. traceback items: 1 in every 5 items
  7. which-pattern items from the Pattern Deck: one of the pattern's 6+ useCases not seen in the last 7 days, then a QuickPick of 4 deck names whose 3 distractors come from tags not listed as alternatives of the right one
- Never two consecutive items on the same concept.
- Never an exact repeat within 7 days; fresh seed instances are used instead.
- Predict, completion and traceback items run in the pad; which-pattern items run in a QuickPick.
- Ends after the current item when 'until' settles (at most about 15 s extra), when the budget is spent, or on Esc.
- Interleaving signal: a concept answered correctly in an atom but wrong in a sprint gets ConceptState.selectionGap = true. Its later sprint items use which-pattern and contrast picks rather than more examples.
(b) WAIT FILLING: Coach.fgWithSprint(label, job). Applies when the job has not settled after 3 s, at least 2 items are in stock, and the 15% cap allows.
- The sprint opens automatically only when ALL of these hold:
  - the learner started the wait (Start, Teach on a cache miss, Reveal, Check my work)
  - the window is focused
  - the phase is NOT building
  - the InteractionLock is free
  - there was no edit in the last 8 s
- Otherwise a 'sprint' action is enqueued in the tempo bar. Check my work during building is always offer-only, so the learner can keep coding.
- When the job lands: flash 'Review ready'. Its card opens after the current item.
(c) WARM-UP: replaces the 20 s maybeRecall timer.
- On activation, when a project exists and at least 2 items are due, enqueue the action '$(zap) 4 due · 60 s warm-up'.
- It is never opened automatically.
(d) ASYNC OPEN-ENDED GRADING (bg, low effort; the learner moves on at once):
- answerExplainBack (only used when there is no runtime or probe)
- the optional free-text plan
Results arrive as a log card plus Evidence (llm-grade, weight .5), applied only when the gen token still matches (mechanism 1).
(e) CHECK MY WORK WITHOUT A SPEC LADDER:
- Runs through fgWithSprint at MEDIUM effort (was high), and is offer-only while building.
- On meetsCriteria, if the task is still current, mechanism 12's what-ifs start, or the bg-graded explain-back fallback.
(f) FOLLOW-UPS:
- generateFollowUp is enqueued as a bg job at priority 1 the moment criteria are met.
- Only when the weakest task concept has P < .6, or an active misconception exists on a task concept.
- maxFollowUps default drops from 4 to 2.
- Otherwise the next roadmap task starts at once and the concept goes to spaced sprints.
(g) SPRINT COMMAND: the Speed drill command becomes a 180 s sprint (deliberate.sprint, Ctrl+Alt+S).
- Interleaved due, fragile and audit items, plus completion items.
- Score = correct items per minute against the personal best, measured with par_abs and shown in the tempo bar.
- The old LLM-designed drill is removed.
(h) The 'Lock it in' explain-back after hints is removed. gotIt records rung evidence (mechanism 3) and resumes building.
(i) TRACEBACK ITEMS (kind 'traceback', graded locally):
- Built for free from raising mutants and traceback seed templates.
- The pad shows the code and the real trace: frames from the snippet only, renumbered to pad lines. Multi-frame traces through a helper function are preferred, because beginners pick the outermost frame.
- The answer line '# -> line ?, ?' takes the failing line and the exception name.
- Then a 1/2/3 pick of its meaning from a local table, with 2 distractor meanings. Python: IndexError, KeyError, TypeError, NameError, AttributeError, ValueError, ZeroDivisionError, RecursionError. JS: TypeError, ReferenceError, RangeError, SyntaxError.
- Tag 'reading-tracebacks'.

## apis
vscode.window.createQuickPick (which-pattern items), vscode.window.setStatusBarMessage, vscode.window.state (focused), vscode.commands.registerCommand('deliberate.sprint'), Atom Pad APIs from mechanism 6

## files
- NEW src/atoms/sprint.ts: Sprint class; selection is pure and exported for tests.
- NEW src/atoms/traceback.ts (pure): trace trimming and renumbering, the exception meaning table, gradeTraceback helpers.
- src/coach.ts:
  - fgWithSprint(), with the auto-open rule
  - checkWork without specs uses it at medium effort
  - answerExplainBack becomes a bg job, and completeTask is no longer awaited behind it
  - maybeRecall, maybeRecallInner, answerRecall, skipRecall and clearCardInput for recall are deleted
  - speedDrill() becomes sprint(180_000)
  - generateFollowUp is policy-gated and prefetched at criteria-met
  - gotIt no longer sets phase 'explain-back'
- src/extension.ts: delete setTimeout(maybeRecall, 20000); enqueue the warm-up action; register deliberate.sprint.
- src/view.ts: remove the answerRecall cardInput and skipRecall routing.
- media/main.js:
  - 'Practice while you wait' button on the busy bar, hidden while building
  - the Roadmap tab's 'Speed drill' becomes 'Sprint (3 min)'
- package.json:
  - maxFollowUps default 2
  - command deliberate.sprint with keybinding ctrl+alt+s
- src/schemas.ts: delete RecallSchema.
- src/types.ts: remove Project.pendingRecall.
- NEW test/sprint.test.ts:
  - selection order, with delayed misconception checks and audits first
  - no same-concept repeats
  - traceback 1 in 5
  - no exact repeat within 7 days
  - stop on until
  - no auto-open while building
  - the 15% cap is respected via the scheduler
- NEW test/traceback.test.ts.

## schemas
RecallSchema removed. FollowUpSchema unchanged.
Types:
- SprintOptions { budgetMs: number; until?: Promise<unknown>; maxItems: number; reason: 'wait'|'warmup'|'sprint'|'due' }
- SprintResult { items: number; correct: number; ms: number; auditsRun: number; delayedChecks: number }
- TracebackItem { id: string; code: string; trace: string; line: number; exception: string; meanings: string[]; correctMeaning: number; siblingGroup: string; conceptId: string }

## prompts
FOLLOW-UP, add to generateFollowUp:
'Weakest concept: ${c.id} (P ${p}, state ${chip})${activeMisconception ? ', active misconception: ' + belief : ''}. The follow-up must make that belief cause a visible failure if they still hold it. 5-15 minutes; core logic in plain functions with an interface (file and 1-3 signatures) so it can be checked by specs.'
CHECK MY WORK (no specs): effort changes from 'high' to 'medium'. Prompt text unchanged.
Background explain-back grading: the existing grade() prompt, unchanged, at low effort.


# V1-10: 10. Prefetched hint ladder anchored on the learner's line

## spec
SPECULATIVE PREFETCH:
- In onTick, when signals.score >= .6 and the task has no valid prefetch, enqueue a HintLadderSchema job: medium effort, priority 2, key 'hint:<taskId>', drawn from the 4/hour hint reserve (mechanism 1).
- The key is the task only. Validity is decided by the staleness rules, never by a hash of the prompt: gatherCodeContext embeds <<CURSOR>> and 'N min ago' notes, so a prompt hash changes whenever the cursor moves or a minute passes.
- contentHash = sha1 of the task files' text (CRLF normalised) plus the sorted error set. It is computed separately from prompt rendering, and used only to avoid re-firing for an identical state.
STALE RULES. Any one makes the prefetch invalid; re-fire only if the score is still >= .6 and contentHash differs from the last fired one:
- the anchor's lineText is no longer found in the file
- 20 or more lines changed since the prefetch (Monitor edit counter)
- the error set changed
- the task changed
CAPS:
- one hint job in flight per task
- stop after 2 unused prefetches in a task
- none when proactiveHints is 'off'
- at most 4 speculative hints per hour (the reserve)
POST-PARSE VALIDATION (zod refine is not enforced by constrained decoding, so this is checked after parsing): rung 1 and rung 2 text must end with '?' and contain no code fence. A failing rung is dropped and served on demand instead.
SERVING:
- At score >= 1 in 'offer' mode, a 'hint-ready' action is shown.
- In 'auto' mode, or on Ctrl+Alt+H / deliberate.hint, hint() serves the next rung from the prefetch immediately.
- On a miss: HintLadderSchema at LOW effort (was medium), about 10-15 s.
- Rungs 4-5 use HintSchema at low effort.
- Solo tasks: rungs above 2 and Reveal are unavailable.
RUNG 0 FOR ERRORS (local, no model):
- When a project-code error persists (the same exception in 2 terminal runs, or for 1+ min in diagnostics), the first help is 'Which line does the trace point at, and what does <ExceptionName> mean?' on the traced line. Uses parseException on the terminal tail (mechanism 2).
- Got it there records nothing; Next goes to rung 1.
DISPLAY (in the editor through the LineAnnotationManager, mechanism 4; the sidebar card stays as a log):
- Short rung text (52 characters or fewer):
  - after-text 'Hint 1: <text>' on the anchored line, italic, editorCodeLens.foreground
  - whole-line background editor.wordHighlightBackground
  - overview ruler mark: editorInfo.foreground, Right lane
- Longer text: a comment thread on the anchored line instead of truncated after-text.
  - createCommentController('deliberate.hints', 'Deliberate hints'), then createCommentThread(uri, range, [comment]).
  - Thread: canReply = false, collapsibleState Expanded, label 'Hint 2'.
  - Comment: body is a MarkdownString with isTrusted = {enabledCommands: ['deliberate.hint', 'deliberate.gotIt', 'deliberate.teach']} and the links '[Next hint](command:deliberate.hint) · [Got it](command:deliberate.gotIt)'; author {name: 'Deliberate'}; mode Preview.
  - The thread opens only when a hint is served, so the inline zone it inserts is learner-initiated.
- The anchor is re-resolved by searching for lineText (nearest match to the original line). If it is not found, the hint stays a sidebar card only.
- If the file is visible, revealRange(InCenterIfOutsideViewport) without taking focus. The tempo bar shows 'hint ready · cli.py:14'.
- Annotation and thread are disposed when the anchored line text changes, on Got it, or when a spec turns green.
RUNG MAPPING:
- Rung 1: Socratic question.
- Rung 2: if a verified atom exists for the diagnosed concept: 'Hint 2: this is <pattern name>. 60 s drill: Alt+N', and the 'atom' action is queued. The thread also shows the rung-2 text.
- Rung 3: plain-language steps.
- Rung 4: the skeleton opens in the pad in 'skeleton' mode, with header 'Skeleton for the stuck piece - fill the ___ here, then write it in your own file'. The ___ blanks are SnippetString placeholders. Ctrl+Enter closes the pad. Never inserted into project files.
- Rung 5: the smallest piece, shown in the thread and in a sidebar card with 'retype it'. Paste and assisted detection (mechanism 3) apply.
- gotIt(): records rung evidence (mechanism 3 weights), clears annotations, calls markProgress, and resumes building with no explain-back question.
PRE-HINT STEP: when an own-code probe is ready (mechanism 12) and this stuck episode has had no hint yet, the first help offered after rung 0 is 'Before a hint: predict one call (15 s)'. Its result is passed into the hint prompt.
KNOWN-GAP SHORTCUT: if the next red spec's concept is a gate-deferred gap and its JIT offer was skipped, the stuck threshold for this task is multiplied by .6.

## apis
vscode.window.createTextEditorDecorationType (isWholeLine, backgroundColor, overviewRulerColor, overviewRulerLane, after), vscode.OverviewRulerLane, TextEditor.setDecorations (DecorationOptions.hoverMessage, renderOptions), vscode.comments.createCommentController, CommentController.createCommentThread(uri, range, comments), CommentThread (canReply, collapsibleState, label, dispose), vscode.CommentThreadCollapsibleState.Expanded, vscode.CommentMode.Preview, vscode.MarkdownString (isTrusted: { enabledCommands }), TextEditor.revealRange (TextEditorRevealType.InCenterIfOutsideViewport), vscode.window.visibleTextEditors, vscode.workspace.onDidChangeTextDocument, vscode.languages.getDiagnostics, vscode.commands.registerCommand('deliberate.gotIt'), TextEditor.insertSnippet + SnippetString.appendPlaceholder (rung 4 in the pad), vscode.ThemeColor

## files
- NEW src/hints.ts: HintPrefetcher (staleness, contentHash and cap logic are pure and exported), anchor resolver, rung-0 detector, and display via the LineAnnotationManager and the comment controller.
- src/coach.ts:
  - hint() serves rung 0, then from project.prefetch, else makes the low-effort on-demand call. Single-flight per task.
  - onTick fires the prefetch at score >= .6.
  - maybeOfferHelp goes through the scheduler.
  - gotIt changes as described.
  - Solo caps.
- src/prompts.ts: HINT_RUNGS text rewritten (see prompts).
- src/schemas.ts: HintLadderSchema.
- src/extension.ts: register deliberate.gotIt (today only reachable from the webview); create the comment controller.
- src/monitor.ts: an edit counter of changed lines since a mark; a task-file content hash.
- src/types.ts: Task.hintPrefetch?: { key: string; contentHash: string; errorHash: string; at: number; anchor: { file: string; line: number; lineText: string }; rungs: string[]; used: boolean }.
- NEW test/hints.test.ts:
  - the key ignores cursor moves and minute ticks
  - staleness rules
  - the cap of 2 unused
  - '?' validation dropping a rung
  - serving from cache without an LLM call
  - rung 0 on a persistent exception
  - long text routes to a thread

## schemas
export const HintLadderSchema = z.object({ diagnosis: z.string(), stuckType: z.enum(['concept-gap', 'slip', 'approach', 'environment', 'not-stuck']), conceptIds: z.array(z.string()), misconceptionId: z.string(), mistakePattern: z.string(), anchor: z.object({ file: z.string().describe('workspace-relative path'), line: z.number().describe('1-based'), lineText: z.string().describe('exact text of that line') }), rungs: z.array(z.object({ rung: z.number(), text: z.string() })).describe('exactly 3: rungs 1, 2, 3') });
HintSchema is kept for rungs 4-5.

## prompts
HINTLADDER (medium effort when speculative, low on demand):
'${projectBrief}
${taskBrief}
Learner profile: ${learnerFor(t.conceptIds)}
Stuck signals: ${signals.reasons}
${ownProbe ? 'Before this they predicted ' + call + ' returns ' + pred + '; it actually returns ' + actual + '.' : ''}
Their code right now: ${codeSnapshot}
They have not asked yet; prepare help in advance. Diagnose what they are most likely stuck on, then write rungs 1-3 of the hint ladder, each building on the previous one:
- rung 1 (Nudge): one short question pointing at a line, value or assumption; aim for 50 characters or fewer so it fits on their line. Must end with a question mark. No code, and do not name the fix.
- rung 2 (Concept): name the missing concept in <= 25 words and ask how it applies to a specific line of theirs. Must end with a question mark. No code.
- rung 3 (Steps): 2-5 plain-language steps for just the stuck piece, using their names. No real code.
anchor: the workspace-relative file and 1-based line they should look at, plus that line exact text (lineText).
stuckType, conceptIds (reuse the given ids), misconceptionId (a taxonomy id or empty), mistakePattern as before. If it is an environment problem, put the direct fix in rung 1 and set stuckType environment. If they are not stuck, use not-stuck.'
HINT_RUNGS in src/prompts.ts:
- 1 Nudge: 'Ask one short question that directs attention to a line, value or assumption. End with a question mark. No code. Do not name the fix.'
- 2 Concept: 'Name the missing concept in at most 25 words and ask how it applies to a specific line of theirs. End with a question mark. No code.'
- 3 Steps: 'Plain-language steps for just the stuck piece, referencing their names. No real code.'
- 4 Skeleton and 5 Piece: unchanged text.


# V1-11: 11. Red-green spec ladder: sandboxed behaviour specs with fading titles and just-in-time drills

## spec
SCOPE:
- V1 covers Python, JavaScript and TypeScript tasks whose core logic is plain functions. It needs a detected runtime and consent 'all'.
- Anything else (UI, network, interactive, Go/Java/Rust in V1, other languages) falls back to Check my work through mechanism 9.
INTERFACE FIRST: each task's interface (file and 1-3 signatures) comes from PlanOutline or TaskBatch (mechanism 7), so it is known before the learner types. The specs part of TaskPrep (mechanism 8) must conform to it.
SPECS ARE DATA, NOT TEST CODE: each spec is {call expression with literal args, expected literal or expected error class}. Our bundled harness runs them; the model never writes test code.
CALL AND EXPECTED VALIDATION (before anything is stored, for visible and hidden specs alike):
- validateCall (pure TS, shared with mechanism 12) accepts exactly one call whose callee is a name in interface.functions and whose arguments are literals only:
  - Python keyword arguments name=literal are allowed
  - literals: numbers, strings, booleans, None/null/undefined, lists, tuples, dicts/objects of literals, unary minus
  - anything else is dropped
- expected is parsed only as a literal, never evaluated: the Python-literal parser or ast.literal_eval in the harness; JSON.parse in Node.
- Workspace content in the prompt therefore cannot inject code that runs on every save.
VERIFICATION AT PREFETCH TIME (learner-code sandbox, mechanism 2):
- Build a temp copy of the workspace's source files: language globs, excluding node_modules, .git, venv, .venv, dist, build and __pycache__; capped at 2 MB and 300 files. node_modules is linked in as a junction (win32) or symlink.
- Reference variant: every visible and hidden spec must pass.
  - If the interface file does not exist or defines none of the interface functions, write the reference as that file.
  - Otherwise replace each interface function's range (executeDocumentSymbolProvider on the learner's file, regex fallback) with the reference version, appending reference helpers.
- Stub variant: the learner's current file (or an empty one), with the interface functions replaced by stubs that raise NotImplementedError / throw. Every spec must fail cleanly: failed, not a harness crash.
- Delete the temp dirs at once.
- The reference is never stored in Project state, never logged, and never sent to another prompt or gatherCodeContext. This keeps 'never write their code' intact.
- On a verification failure: one low-effort repair call with the failing spec ids and actual values. Specs that still fail are dropped. Fewer than 3 left: applicable = false.
ATTACHING:
- At task start the card shows the interface ('Write in cli.py: parse_args(argv) -> dict'; JS adds 'export') whether or not specs have landed, plus the spec titles allowed by Task.fade.
- Specs that land while the task is building attach immediately. The tempo bar shows 'specs ready (5)' without a pop, and they run on the next save.
- If the learner's file already differs from the interface:
  - map each interface function to theirs by exact name, else by a unique function of the same arity in the interface file, and rewrite the spec calls to their names
  - if no mapping exists, mark the ladder not applicable, with the card 'Your design differs from the planned interface; Check my work will review it instead.'
  - never force a rename
- Done when all specs are green. acceptanceCriteria stay as the review fallback.
TRIGGERS:
- Manual save of any task file (TextDocumentSaveReason.Manual, from onWillSaveTextDocument): run at once (debounced 300 ms).
- Auto-save (AfterDelay or FocusOut): run only after 1.5 s without edits, and only when the file has no Error-severity diagnostics, so half-typed code does not flicker red.
- Learner-started runs from the Testing view, and continuous runs (request.continuous). When continuous mode is on, saves do not also trigger runs.
RUNS:
- Spec data JSON is written to globalStorageUri/specs/<taskId>.json, never into the workspace.
- runLearnerCode runs media/harness/harness.py or harness.mjs with the learner-code profile: cwd = a fresh temp dir, the workspace on the module path read-only, the audit hook (Python), permission flags (Node), stdin ignored, 5 s total timeout.
- The harness reports importMs. If the first run's import takes over 1 s (pandas, flask and similar), the timeout becomes 5 s + importMs and the tempo bar shows 'running specs...' during runs. A persistent per-task worker is in v2.
MODULE LOADING:
- Python:
  - The module is imported normally under a non-__main__ name ('dlb_<module>'). 'if __name__ == '__main__'' blocks do not run, while ordinary top-level assignments such as PATTERN = re.compile(...) or counts = Counter() do.
  - builtins.input is patched to raise DeliberateTopLevel. sys.argv is a sentinel list that raises it on any access beyond index 0. A top-level run longer than the timeout is reported the same way.
  - Any of these gives the teachable nudge 'top-level code runs on import: move it under if __name__ == '__main__''.
  - This replaces the earlier AST-strip loader, which deleted assignments with calls and contradicted the input() nudge.
- JS/TS:
  - Before importing, a top-level safety check. The file's top level may contain only imports, exports, declarations, function and class definitions, and const/let initialisers that call nothing except new Map/Set/RegExp/Array/Object, Object.freeze, Symbol, or arrow/function expressions.
  - If unsafe, the module is not imported, and the nudge is 'wrap the entry code in a main guard (if (require.main === module) or, on Node 24.2+, if (import.meta.main))'.
  - Then await import(pathToFileURL(file)), falling back to createRequire for CJS.
  - Interface names that are defined but not exported give the nudge 'parse_args is defined but not exported: add export'.
  - Promise results are awaited (2 s cap). Comparison: util.isDeepStrictEqual against JSON.parse(expected).
- TypeScript: Node type stripping with the resolve hook, or tsx (mechanism 2).
HARNESS PROTOCOL:
- Each spec prints '@@DLB_START <id>' before it runs and '@@DLB {json}' after, with {id, pass, actual (repr, 200 characters or fewer), error}.
- If a run times out, the spec that started last is reported as 'timeout (infinite loop?)' and the rest as not run.
REPORTING:
- Checked in the installed VS Code 1.140: testing.automaticallyOpenTestResults (formerly testing.openTesting) defaults to 'openOnTestStart', so a TestRun on every save would open Test Results over the learner's terminal. testing.automaticallyOpenPeekView defaults to 'never' there; its 1.93 default must be checked in a spike before the Testing view is relied on.
- Save-triggered runs never create a TestRun. Results go to a gutter icon per spec function (passed/failed), the LineAnnotationManager, the tempo bar ('3/5 · next: <title>') and the task card's ladder.
- Only the target spec (the first red one in ladder order) is reported as failed. Later red specs show as 'not yet', with no message or location, so the learner is never shown several failures on their def line at once.
- The TestController still lists the specs:
  - one root TestItem per task, one child per visible spec
  - uri and range = the function's def line, via executeDocumentSymbolProvider with a regex fallback
  - createRunProfile('Run specs', TestRunProfileKind.Run, handler, true, undefined, true)
- Its handler publishes TestRun results only for runs the learner starts, or continuous runs:
  - passed(item, ms)
  - failed for the target only, with TestMessage.diff(text, expected, actual) and location = the def line
  - skipped for later specs
  - errored with the stderr tail on a harness crash
- A failureSignature match on the target puts after-text on the learner's def line, e.g. 'spec 3: is -v a value or a flag?' (52 characters or fewer, full text in hover). Not shown in solo tasks.
FADING (Task.fade, mechanism 8):
- full: all titles.
- partial: the next title only; each later one is revealed as the previous turns green.
- minimal and solo: 'n of m behaviours pass', and for the failing target, the call and the learner's actual result (never the expected value).
JIT ATOM OFFERS:
- When the target spec changes and its conceptId has P < .5 or is a gate-deferred gap, the tempo text becomes 'next: <title> uses <pattern> · 60s drill? Alt+N' at that moment (no pop).
- It is offered once more on the first save that touches that spec's function.
- Not in solo tasks. Accepting opens the atom (mechanism 6).
EVIDENCE AND PROGRESS:
- The first time a spec turns green:
  - detector.markProgress(now, 'spec 3 green')
  - evidence kind 'spec' correct, production = true
  - full weight only within 3 saves since it went red and with the function not assisted; otherwise weight .3
  - latency = active ms since the previous green (or task start), against parSec
- Signature matches: passive misconception evidence (x1.5 odds, weight .5) and recordMistake(misconceptionId).
- A target spec still red past 2x par with the same signature twice queues an 'atom' offer for its concept.
ALL VISIBLE SPECS GREEN: run the hidden specs.
- Hidden pass: criteria met; flash; what-ifs (mechanism 12); completeTask. The polish review (WorkReviewSchema, medium, polish-only prompt) runs only when deliberate.polishReview is on (default off).
- Hidden fail:
  - card: 'Passes your checks but not count_words('a  b'): you return {'': 1, 'a': 1, 'b': 1}. What did you assume about the input?' It shows the call and their actual result, not the expected value.
  - records transfer evidence (wrong) on that spec's concept, and sets Task.spec.overfit = true
  - the task stays in building
NO SPECS, OR applicable = false: keep the manual Check my work button and the async review path.

## apis
vscode.tests.createTestController, TestController.createTestItem / items.replace / createRunProfile(label, TestRunProfileKind.Run, handler, isDefault, tag, supportsContinuousRun) / createTestRun, TestItem.uri / range / children, TestRun.started / passed / failed / skipped / errored / end, vscode.TestMessage.diff + TestMessage.location, vscode.Location, vscode.TestRunRequest (continuous), vscode.workspace.onWillSaveTextDocument (TextDocumentSaveReason), vscode.workspace.onDidSaveTextDocument, vscode.languages.getDiagnostics, vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri) -> DocumentSymbol[] (SymbolKind.Function/Method), vscode.window.createTextEditorDecorationType (gutterIconPath, after) + setDecorations, vscode.ExtensionContext.globalStorageUri, vscode.workspace.fs.writeFile / delete / copy

## files
- NEW src/specs.ts:
  - SpecController: TestController wrapper, save and continuous triggers, target-only reporting, gutter icons, signature nudges, fading, JIT offers
  - verifySpecLadder(): temp workspace copy, reference and stub variants
  - mapInterface()
  - parseHarnessOutput() (pure)
- NEW src/calls.ts (pure): validateCall, parseLiteral (shared with compare.ts), mutateLiteral (mechanism 12).
- NEW media/harness/harness.py and harness.mjs (both take <module file> <spec json path>), and loader.mjs (module.register resolve hook for TS).
- src/coach.ts:
  - beginTask shows the interface, and attaches specs when present or when they land.
  - onAllGreen leads to hidden specs, then what-ifs, then completeTask.
  - checkWork is used only when the task has no applicable spec.
- src/stuck.ts: unchanged API; markProgress is called by SpecController.
- src/schemas.ts: SpecLadderPart (inside TaskPrepSchema).
- src/types.ts: Task.spec, Task.interface.
- src/atoms/prefetch.ts: TaskPrep jobs carry the specs part.
- package.json: deliberate.polishReview (boolean, default false); media/gutter-pass.svg and gutter-fail.svg.
- NEW test/specs.test.ts:
  - parseHarnessOutput, including timeout and crash
  - validateCall rejects a call with a variable, two calls, an attribute access or an import
  - verification drops specs failing on the reference and requires clean failure on the stub (fake runner)
  - interface mapping by name and arity
  - target-only reporting
  - auto-save waits for idle and no errors
  - the green transition calls markProgress
  - 4+ saves give weight .3
- Integration tests (skipped when Python or Node is missing):
  - harness.py imports a module with Counter() at top level and an input() under a main guard
  - an input() at top level gives the nudge
  - a file write during a spec is blocked by the audit hook, and nothing appears in the fixture workspace

## schemas
const SpecItem = z.object({ id: z.string(), title: z.string().describe('<= 8 words, one behaviour'), conceptId: z.string(), call: z.string().describe('one call to an interface function with literal arguments only'), expected: z.string().describe('exact expected result as a literal; empty if expectError'), expectError: z.string().describe('exception class name or empty'), parSec: z.number(), failureSignatures: z.array(z.object({ match: z.enum(['equals', 'error']), value: z.string(), misconceptionId: z.string(), nudge: z.string().describe('<= 20 words, a question, no code') })) });
const SpecLadderPart = z.object({ applicable: z.boolean(), reason: z.string().describe('why not applicable, else empty'), specs: z.array(SpecItem).describe('3-6, simplest first'), hidden: z.array(SpecItem).describe('2'), reference: z.string().describe('private complete implementation of the interface functions, used only for verification') });
Task.interface: { file: string; functions: { name: string; signature: string; purpose: string }[]; mappedNames?: Record<string, string> }
Task.spec?: { specs: SpecItem[]; hidden: SpecItem[]; greenAt: Record<string, number>; firstRedAt: Record<string, number>; savesSinceRed: Record<string, number>; runs: number; importMs?: number; overfit?: boolean; verified: boolean; applicable: boolean; reason?: string }
The reference is not stored.

## prompts
SPEC SECTION of TASKPREP (mechanism 8):
'- applicable: false if the task is mainly UI, graphics, network, timing, interactive input or needs a running server; then give reason and leave the rest empty.
- The interface is fixed: ${interface}. Specs call only these functions.
- specs: 3-6 in the order a learner should build them, simplest first; title <= 8 words naming ONE behaviour; call is a single call with literal arguments only (no variables, no other code); expected is the exact result as a ${lang === 'python' ? 'Python literal' : 'JSON value'}, or set expectError to the exception class name; parSec = active seconds a competent learner needs after the previous spec; conceptId from the given ids.
- failureSignatures: 1-3 per spec: wrong results a learner with a specific misconception would produce (match equals with the wrong literal, or error with the exception name), its misconceptionId, and nudge: a question of <= 20 words that points at the cause, no code.
- hidden: 2 more specs with fresh inputs for the same behaviours, to catch hard-coded answers.
- reference: a complete, simple, idiomatic implementation of the interface functions (plus any helpers they need), consistent with the existing files shown; used only by the coach to verify the specs and never shown to the learner.${lang === 'typescript' ? ' Use only erasable TypeScript syntax.' : ''}
Do not assert incidental details (exact error message text, dict key order, float formatting).'
REPAIR (low effort): 'These specs failed against your reference or did not fail cleanly against an empty stub: ${id, reason, actual}. Return the ladder with only these specs fixed (or removed).'
POLISH-ONLY REVIEW (opt-in via deliberate.polishReview; added to checkWork when specs passed; medium effort, background): 'All behaviour specs pass, including hidden ones. Review only design, naming, structure and robustness the specs cannot see. meetsCriteria is true unless there is a blocker. At most 2 polish items. explainBackQuestion: empty string (the coach checks understanding with what-if questions on their code).'


# V1-12: 12. Own-code probes: predict your function and what-if mutants (replaces explain-back)

## spec
REQUIRES consent 'all' and a Python, JS or TS runtime.
PROBE INPUTS, in order of preference. The model writes only call expressions, never implementation code.
(1) Locally mutated spec inputs. Zero model cost.
    - Take a visible or hidden spec call and change one literal: a list or string to empty; an int to 0, -1 or a boundary such as len - 1; or a duplicated element.
    - Keep only mutations whose argument tuple differs from every visible spec's.
    - The expected value is never known in advance: the learner's own code is run to get it.
    - Spec calls themselves are never used. Visible titles and TestMessage.diff show their expected values, and hidden calls exist to catch hard-coding.
(2) Otherwise (no spec ladder), an OwnCodeProbeSchema job: low effort, bg priority 2.
    - Fired on save when the file's set of function symbols changed, at most once per 2 min, only during building.
    - Every callExpr goes through validateCall (mechanism 11).
(3) Local fallback inputs from parameter names: empty list or string, 0, -1, None/null.
FINDING FUNCTIONS: executeDocumentSymbolProvider (SymbolKind.Function and Method), with a fallback regex on def/function/const-arrow lines.
MODULE SAFETY: the same loader and top-level safety rules as mechanism 11 (Python: normal import under a non-main name, with the audit hook and the input/argv sentinels; JS: the top-level check). An unsafe module is skipped.
A. PREDICT YOUR FUNCTION:
- Offered through the tempo bar ('$(question) predict parse_row (15s)') and a gutter icon plus a hover command link on the def line. No CodeLens, so lines never jump.
- Shown only when the scheduler allows (a pause, at most once per 3 active min, never while stuck score is .5-1.0 except as the pre-hint step), or on Ctrl+Alt+P.
- Opens createInputBox:
  - title 'parse_row('a,,b') -> ?'
  - prompt 'Type the return value, or the error name. Enter submits'
  - validationMessage {message: 'Empty means no idea', severity: Info} while empty
  - ignoreFocusOut = true
  - buttons [{iconPath: ThemeIcon('history'), tooltip: 'Later'}]
  - Later or Esc is neutral.
- Accept runs the call against the CURRENT file text in about 300 ms (Python: probe.py with the source passed in; Node: dynamic import of a temp copy), then compares with compareOutput (mechanism 2) or the exception name.
- Feedback goes through the LineAnnotationManager on the def line: 'ok 9s' (green), or 'actual ['a', '', 'b'] · you said ['a', 'b']' (red). It clears on the next edit inside that function.
- Evidence: own-predict on the probe's concept, plus misconceptionIfWrong at x3 odds (unconfirmed).
- A mismatch whose concept has a cached atom queues an 'atom' offer.
- Pre-hint use: the result goes into the hint prompt. A match tells the model to look elsewhere; a mismatch is quoted word for word.
B. WHAT-IF MUTANTS:
- Run when criteria are met (spec ladder all green, or checkWork meetsCriteria). Skipped entirely when every task concept is Fluent.
- Pick 2 lines inside task functions that probe calls exercise. Prefer lines whose operator tag matches the task's weakest concept or a mistake already in the journal.
- Local operator table, with the misconception tag each maps to:
  - < <-> <=, > <-> >=: off-by-one
  - range bound or loop limit +/-1: for-range-bounds
  - drop 'return' on a return line: function-return-vs-print
  - and <-> or, && <-> ||: booleans-truthiness
  - .copy(), list(x), x[:], [...x] -> x: alias-copy
  - += -> =: loop-accumulator
  - remove await: await-sequencing
  - Python only, == -> is: identity-vs-equality
- Apply the operator to an in-memory copy and run the probe call.
  - Keep mutants whose result differs from the original; raising is a valid answer.
  - Drop mutants that fail to parse (py_compile or node --check).
- Display as decorations only; the file is never edited:
  - textDecoration 'line-through' on the changed token
  - after-text 'what if: range(len(prices) - 1)'
- InputBox (ignoreFocusOut = true, 'Later' button): 'With this change, total([4, 5, 6]) -> ?'.
- Grading and attribution:
  - A correct answer is own evidence: kind 'what-if', on the concept of the operator's tag.
  - A wrong answer counts toward the operator's misconception (x3) ONLY when it equals the unmutated output (the learner thinks the change does not matter), or the output under the specific alternative operator (computed locally).
  - Any other wrong answer is weight .5 wrong evidence on the concept, with no misconception, since tracing load or arithmetic can explain it.
- 2 what-ifs take about 30-60 s for a beginner. Then completeTask.
- CONFLICT FLAG: specs went green fast, but 2 or more own predictions were wrong in this task. Sets Task.notUnderstood = true:
  - what-ifs become 3
  - the next task's stuck threshold drops by 25%
  - one bg-graded explain question is added
  - Progress shows it neutrally
- FALLBACK when there is no runtime, consent or probe: the free-text explain-back, graded in the background (mechanism 9).

## apis
vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri), vscode.DocumentSymbol, vscode.SymbolKind.Function / Method, vscode.window.createInputBox (title, prompt, placeholder, validationMessage, ignoreFocusOut, buttons, onDidTriggerButton, onDidAccept, onDidHide), vscode.InputBoxValidationSeverity, vscode.QuickInputButton + vscode.ThemeIcon, vscode.window.createTextEditorDecorationType (textDecoration: 'line-through', after.contentText, gutterIconPath), TextEditor.setDecorations, vscode.MarkdownString (isTrusted: { enabledCommands: ['deliberate.predictOwn'] }), vscode.workspace.onDidSaveTextDocument, vscode.workspace.onDidChangeTextDocument, vscode.commands.registerCommand('deliberate.predictOwn')

## files
- NEW src/owncode.ts: PredictFlow (InputBox), WhatIfFlow, offer decorations, and a probe store keyed by function text hash.
- NEW src/mutants.ts (pure): operator table per language family, applyOperator(lineText, op), alternative-output computation, candidate selection, tag mapping.
- src/calls.ts (mechanism 11): mutateLiteral for spec-derived inputs.
- NEW media/harness/probe.py and probe.mjs: take a source path or stdin source plus a call expression, and print '@@DLB {json}'. They share the loader with harness.py and harness.mjs.
- src/coach.ts:
  - The criteria-met path runs whatIfs() before completeTask (skipped when all concepts are Fluent).
  - The pre-hint step happens in hint().
  - The hint prompt includes the prediction result.
- src/types.ts: Task.ownProbes, Task.whatIfs, Task.notUnderstood.
- src/schemas.ts: OwnCodeProbeSchema.
- package.json: command deliberate.predictOwn with keybinding ctrl+alt+p when 'deliberate.building && editorTextFocus'.
- NEW test/mutants.test.ts: each operator on sample lines, no-op detection, tag mapping, alternative-output attribution.
- NEW test/owncode.test.ts:
  - spec-derived inputs never equal a visible spec input
  - validateCall rejects code
  - a fake runner gives a match and a mismatch
  - Later is neutral

## schemas
export const OwnCodeProbeSchema = z.object({ probes: z.array(z.object({ file: z.string(), functionName: z.string(), callExpr: z.string().describe('one call with literal arguments only'), conceptId: z.string(), edgeCase: z.string().describe('<= 10 words'), misconceptionIfWrong: z.string() })).describe('at most 3') });
Task types:
- ownProbes: { fnName: string; fnHash: string; callExpr: string; source: 'spec-mutation'|'model'|'fallback'; conceptId: string; misconceptionIfWrong: string; result?: { predicted: string; actual: string; correct: boolean; ms: number } }[]
- whatIfs: { line: number; op: string; tag: string; callExpr: string; predicted?: string; actual: string; unmutated: string; alternative?: string; correct?: boolean; attributable?: boolean }[]

## prompts
OWNCODEPROBE (low effort, background; only when there is no spec ladder):
'Here is a file the learner just saved while working on the task below. Choose up to 3 calls to functions THEY wrote that test whether they understand what their own code does; favour edge cases tied to the task concepts (empty input, boundary index, missing key, duplicate values).
Rules: callExpr is a single expression calling one of their functions with LITERAL arguments only (numbers, strings, lists, dicts, tuples, booleans, None/null). No other code, no variables, no imports. Never write or change their implementation. Skip functions that read files, the network, the clock, randomness or input().
For each: file, functionName, callExpr, conceptId (from the given ids), edgeCase (<= 10 words), misconceptionIfWrong (kebab-case id or empty).
Task: ${taskBrief}
Concept ids: ${ids}
File ${path}: ${code}'
Addition to the hint prompts (mechanism 10) when a pre-hint prediction exists:
'Before this hint they predicted ${call} returns ${pred}; it actually returns ${actual}. ${match ? 'Their mental model of this function matches the code, so look for the problem elsewhere.' : 'Start from this mismatch.'}'
