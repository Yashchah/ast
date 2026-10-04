# Stage 3: live Codex test report

Tests passing at the end of this run: True.

## Summary

The model side works end to end on the user's Codex plan (gpt-6.1-sol, Codex CLI 0.159.2) after five root-cause fixes plus prompt hardening; npm test passes 807/807 (804 + 3 new). 12 live calls: 10 returned output, 2 failed (old 180 s timeout, extractJson format bug); one was a tiny diagnostic. A scratch script (scratchpad\live\live.ts, run with npx tsx --tsconfig test/tsconfig.json) drives the real Prefetcher with the real Llm/Codex provider, JobQueue, LocalRunner (Python 3.14), verifySpecLadder, verifyPack, hint accept and verifyLesson, and can replay saved outputs (--replay) so re-checks cost no calls. Results: (1) PlanOutline: 23/23 tags exact canonical-or-'other' (2 'other'), 13 seed ids reused, 4/4 milestone-1 tasks with valid one-file interfaces. (2) TaskPrep, 2 tasks, empty workspace: 13/14 specs survived before the fix and 14/14 after, 0 repair calls both times; gates well formed. (3) AtomPack: before the fix collections-counter was accepted with 4/4 probes but only 2/4 mutants diagnostic and 0/1 contrast; after, a 2-concept pack (collections-counter + 'other' command-line-arguments) accepted 2/2 atoms with 8/8 probes, 8/8 diagnostic mutants, 2/2 contrasts, 2/2 completions, 2/2 examples, no repair. (4) HintLadder on a buggy count_words fixture: 3/3 rungs passed the '?' rule both times, rung 1 at 42 chars, anchor on the bug line, no fix named; misconceptionId went from empty to 'assign-one-each-time'. EscalationLesson first failed to parse; after the fix its stated output matched when run, and after the prompt fix it has a title and no id leak.

## Calls made

- FAILED — PlanOutline medium, standard tier, via Prefetcher/JobQueue/Llm (word-frequency CLI goal) (181.9 s): Killed by the old 180 s Codex timeout; quota spent, nothing returned. Root cause fixed (codexTimeoutMs).
- OK — Tiny diagnostic codex exec (low effort, 'reply ok', production flags + --json) (0 s): Duration not captured (bc missing). Returned promptly; showed about 17.5k input tokens of Codex agent preamble even for a trivial call.
- OK — PlanOutline medium, same saved prompt sent directly with timestamped --json events (99.5 s): 3,143 output tokens (291 reasoning), 18,140 input; about 30 output tokens/s on the standard tier. Output replayed for the rest of the pipeline.
- OK — TaskPrep medium, 2 tasks, then verifySpecLadder through LocalRunner (empty workspace) (128.5 s): 13/14 specs survived; normalize-3 dropped for raw TAB/NEWLINE in the call literal. 0 repair calls. Gates 48 and 50 words. 1 of 10 distinct misconception ids from the taxonomy.
- OK — AtomPack medium, 1 concept (collections-counter) + verifyPack (92.5 s): Accepted with no repair: 4/4 probes, but only 2/4 mutants diagnostic (one-character output differences) and 0/1 contrast (neither snippet printed).
- OK — HintLadder low, on demand (priority tier), buggy count_words fixture with stuck context and own-probe mismatch (10.4 s): 3/3 rungs passed the '?' rule; anchor on line 8; misconceptionId left empty (prompt listed no taxonomy ids).
- FAILED — EscalationLesson low + verifyLesson (14.1 s): 'did not match the expected format': extractJson grabbed the fenced example inside the JSON string and returned {}. Root cause fixed in src/llm.ts.
- OK — TaskPrep medium, 2 tasks, after the prompt fixes (134.7 s): 14/14 specs survived, 0 repairs, no raw control characters; taxonomy reuse rose to 3 distinct ids; task 1 gate at 51 words (plan pick would be skipped), so the 50-word budget line was added (not re-verified live).
- OK — AtomPack medium, 2 concepts (collections-counter + 'other' command-line-arguments), after the prompt fix (172.5 s): 2/2 atoms accepted, 8/8 probes, 8/8 mutants diagnostic, 2/2 contrasts, 2/2 completions, 2/2 examples, no repair. 7.5 s from the old 180 s cap.
- OK — HintLadder low, on demand, after the taxonomy-ids fix (9.3 s): 3/3 rungs kept; misconceptionId now 'assign-one-each-time'; anchor correct.
- OK — EscalationLesson low, after the extractJson fix (15.7 s): Parsed; verifyLesson confirmed the stated output by running it. Empty title, and the text quoted the internal id 'assign-one-each-time' to the learner.
- OK — EscalationLesson low, after the lesson prompt fix (10.1 s): Title 'Assignment replaces the old value', no id mentioned, clearer example; stated output confirmed by running it.

## Fixes already applied (in the working tree)

- src/codex.ts + src/llm.ts: new codexTimeoutMs(effort, fast). Standard-tier calls (all background calls) get 480 s (600 s at high); priority-tier calls keep 180/300 s. The flat 180 s limit killed a live PlanOutline after it used quota, and a 2-concept AtomPack took 172.5 s. Test added in test/codex.test.ts.
- src/llm.ts: extractJson (now exported) parses the whole reply as JSON first and falls back to a ```json fence, the outer braces, then any fence. It used to search for a fence first, so any Codex answer with fenced code inside a string became {} and failed the schema: every EscalationLesson, and likely Reveal, rung 4/5 skeleton hints and Ask answers with code. Test added in test/codex.test.ts.
- src/atoms/prompts.ts ATOMPACK: mutants must differ from the original output by more than one character, because a one-character difference counts as a typo and the mutant can never name its belief (2/4 non-diagnostic became 8/8 diagnostic live). Contrast snippets must each print their result, since the model wrote non-printing snippets and the contrast was rejected (0/1 became 2/2).
- src/prompts.ts TaskPrep: call, expected and failure values must write newlines/tabs inside string literals as escapes (one live spec was dropped for raw control characters). New optional misconceptions input lists the known ids for the tasks' tags, and failureSignatures/plans are told to reuse them (taxonomy reuse 1 to 3 distinct ids). The GATE line now states the 50-word budget for names plus plans, aiming for about 8-word plans (one live gate hit 51 words, which skips the plan pick).
- src/atoms/prefetch.ts: prepPrompt passes taxonomyFor(task tags, runLang) into the TaskPrep prompt. Test added in test/prefetch.test.ts.
- src/hints.ts + src/coach.ts: hintLadderPrompt takes optional misconceptions, and Coach.hintContext passes the task tags' taxonomy, so misconceptionId reuses taxonomy ids (empty before, 'assign-one-each-time' after). Assertions added in test/hints.test.ts.
- src/atoms/prompts.ts escalation lesson: asks for a title of 6 words or fewer and forbids mentioning the misconception id (live: empty title, id quoted to the learner). Assertion added in test/atom-prompts.test.ts.
- package.json: deliberate.planEffort description changed from 'about 40-70 s' to 'about 1.5-3 min on the Codex plan' (measured 100 s and over 180 s).

## Open issues (NOT fixed)

- Latency vs. placement: on the Codex standard tier PlanOutline takes about 100-180+ s and TaskPrep about 130 s for 2 tasks (3 tasks likely 180-200 s), while COACH.placementExpectedMs is 3 min. Task 1's gate and specs will usually miss neededBy and take the degraded path. Options: TaskPrep task 1 alone first, run PlanOutline on the priority tier, or longer placement. docs/redesign-spec.md still says 40-70 s.
- Fixed cost per Codex call: about 17.5k uncached input tokens of agent preamble, even for a one-word reply. Codex also loads ~/.codex/skills despite --ignore-user-config (stderr shows 'failed to load skill frontend-design').
- The 50-word gate budget prompt line is not verified live (unit test only); 1 of 4 live gates was at 51 words.
- Spec validation drops (an unparseable call or expected value) are never sent to the repair call; only run failures are. One such drop left a live ladder at exactly the 3-spec minimum.
- Content quality: atoms for 'other' concepts drift into library trivia (argparse's exact format_usage() text, the '--' terminator). They are correct but low teaching value, and local checks cannot judge relevance.
- Content quality: even with the known-id list, 7 of 10 distinct misconception ids in TaskPrep were invented, which splits evidence away from the beliefs atom mutants track. Failure-signature values are never run, so they are unchecked claims.
- Content quality: mutant refutations are terse or vague ('Each repeated symbol contributes.'); a hint rung had a typo ('a a total'); the plan summary leaked coach instructions ('use brief checks to diagnose gaps before teaching'); warm-up ladders are thin (6 specs for text.lower()).
- The PlanOutline canonical-tag list offers JS-only tags (null-undefined, let-const-var-scope, ...) to Python projects, as the spec text does. It caused no problem here, but a JS-only tag on a Python concept would get no pack and no seeds.
- test/e2e/runE2E.ts was created mid-session by another process and fails tsc ('Cannot find name PassThrough'). Not touched; npm test does not run it, but 'npm run typecheck' and 'npm run package' would fail.
