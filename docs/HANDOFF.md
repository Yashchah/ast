# Handoff: Deliberate v0.2

This document is for an AI coding agent picking up this project mid-way. Read all of it before you change anything. Last updated 2026-10-04, when the previous agent was paused partway through fixing stage 3 review findings.

## 1. What this project is

Deliberate is a VS Code extension, written in TypeScript, that coaches a learner while they build a real project of their own. The learner wants to learn to program very fast. Starting from fundamentals is fine, but there should be no hours of refreshers, and coding is treated as patterns to learn. The core rule is that **the coach never writes the learner's project code.** It diagnoses knowledge gaps, teaches only what the current task needs, and nudges.

- **v0.1** (shipped, installed on the user's machine as `deliberate-coach-0.1.0.vsix`) was a sidebar chat coach. Its source is archived in [archive/v0.1/](../archive/v0.1/).
- **v0.2** (in progress, this tree) is a redesign. Learning happens inside the editor as fast "predict the output" loops graded locally in under 300 ms, with almost no reading. The full design is in [docs/redesign-spec.md](redesign-spec.md), the output of a five-designer judge panel plus critique.

The v0.2 loop, briefly:

1. **Placement blitz.** The learner states a goal. While the roadmap is planned in the background (PlanOutline), they answer about 10 predict-the-output items in an in-memory `deliberate-pad` editor tab. Each answer is compared with output recorded by actually running the snippet locally.
2. **Task.** Each task gets an interface (a file plus function signatures) and a ladder of behaviour specs that run in a sandboxed temp dir on every save and turn green one by one. Hidden specs catch hard-coded answers.
3. **Gate.** When a task brings in a new concept, a 15-second "which patterns will you need?" QuickPick runs first.
4. **Atoms.** A gap opens a probe-first concept block in the pad (20–120 s). A wrong answer that matches a "misconception mutant" (a copy of the code that behaves the way one wrong belief predicts) leads to "Did you think X? y/n", then a contrast pick, a reveal and a re-probe.
5. **Stuck.** Hints are prefetched in the background and anchored on the learner's line (rung 0 local, rungs 1–3 prefetched, 4 is a skeleton in the pad, 5 is the smallest piece).
6. **Done.** Two "what if this line changed?" predictions on the learner's own code, then the next task. Follow-up tasks come only when the learner model says a concept is weak.
7. **Spacing.** Interleaved review sprints, fed by an evidence-based learner model (BKT with capped likelihoods, a misconception lifecycle and production-gated mastery).

Model calls go through the user's **Codex CLI on their ChatGPT plan**, not an API key. The default model is `gpt-6.1-sol` on the Fast (`priority`) tier. Background calls use the standard tier. Claude API and VS Code LM are optional providers.

## 2. Current state (exact)

| Check | State |
|---|---|
| `npx tsc --noEmit` | **2 errors**, both in `src/coach.ts` at lines 1051 and 1270: `Argument of type '"resume"' is not assignable to parameter of type '"review" \| "specs"'`. They come from a half-applied fix (see §4.1). |
| `npm test` | 807/807 pass. tsx does not typecheck, so this passes despite the errors above. |
| `npx tsx scripts/verify-seeds.ts python\|javascript\|typescript` | Passed at the end of stage 2. Not re-run since. |
| `deliberate-coach-0.2.0.vsix` in the repo root | **Stale.** Built at the end of stage 2, before any stage 3 fix. Do not ship it. |
| Real VS Code (e2e) | **Never executed.** Blocked by a pending VS Code update (see §4.4). |
| Git | **Not a git repository.** There is no version control. v0.1 is archived in `archive/v0.1/`. Before making large changes, ask the user whether to `git init` and commit a baseline. |

## 3. Where everything is

**Design and history (read in this order):**
1. [docs/redesign-spec.md](redesign-spec.md): the full v0.2 spec. "# coreLoop", "# conceptAtom" and "# latencyStrategy" are the heart of it; "# V1-1" to "# V1-12" define each mechanism.
2. [src/contracts.ts](../src/contracts.ts): the shared types every module builds against.
3. [docs/stage1-notes.md](stage1-notes.md): how to wire each core module (runner, compare, evidence, jobs, seeds, atoms, cores, harness). These are authoritative conventions, especially the evidence-recording rules.
4. [docs/stage2-reports.md](stage2-reports.md): the pad, surfaces, build-loop, coach and shell reports, with known gaps and deviations.
5. [docs/stage3-findings.md](stage3-findings.md): **the work list.** 49 confirmed review findings with file:line, failure scenario, evidence and suggested fix.
6. [docs/stage3-live-codex.md](stage3-live-codex.md): the live Codex run, with timings, the 8 fixes already applied and 9 open issues.
7. [docs/stage3-vscode-e2e.md](stage3-vscode-e2e.md): the e2e harness that was built and why it never ran.
8. [docs/stage1-reports.md](stage1-reports.md): per-module deviations from the spec, for when you need detail.

**Source map:**

| Area | Files |
|---|---|
| Orchestration | `src/coach.ts` (about 2,800 lines: the state machine), `src/atoms/prefetch.ts` (background model jobs), `src/extension.ts` (wiring, consent, commands) |
| Model access | `src/llm.ts`, `src/codex.ts`, `src/jobs.ts` (JobQueue: fg/bg lanes, budget, gen tokens), `src/lock.ts` (InteractionLock) |
| Local execution | `src/runner.ts`, `src/proc.ts`, `src/runtimeDiscovery.ts`, `media/runner/{prelude,batch}.{py,mjs}` (sandboxed snippet runner) |
| Grading | `src/compare.ts` (typed Python/JS literal comparison), `src/calls.ts` (literal-only call validation) |
| Learner model | `src/evidence.ts` (pure BKT plus lifecycle), `src/learner.ts`, `src/store.ts` (JSONL evidence log plus globalState, multi-window merge) |
| Content | `src/atoms/tags.ts` (canonical tags plus misconception taxonomy), `src/atoms/seeds.ts` (parametric seed instantiation), `media/seed/{python,javascript,typescript,neutral}.json`, `src/atoms/verify.ts` (local verification of model packs), `src/atoms/cache.ts`, `src/atoms/prompts.ts` |
| Pad (practice tab) | `src/atoms/pad.ts`, `src/atoms/padfs.ts` (FileSystemProvider plus VS Code editor), `src/atoms/stepMachine.ts` (pure reducer), `src/atoms/render.ts`, `src/atoms/grade.ts`, `src/atoms/placementRun.ts`, `src/atoms/sprint.ts`, `src/atoms/stock.ts`, `syntaxes/*` |
| Build loop | `src/specs.ts` (SpecController), `src/specsCore.ts`, `media/harness/{harness,probe,loader}.*`, `src/owncode.ts` (predict-your-function plus what-ifs), `src/mutants.ts`, `src/gate.ts`, `src/gateCore.ts` |
| Surfaces | `src/tempoBar.ts` (status bar "next action"), `src/tempo.ts` (pure scheduler), `src/annotations.ts`, `src/annotationModel.ts`, `src/hints.ts`, `src/monitor.ts`, `src/stuck.ts` |
| Sidebar | `src/view.ts`, `media/main.js`, `media/main.css` |
| Tests | `test/*.test.ts` (node:test via tsx, with `vscode` mapped to `test/vscode-stub.ts` by `test/tsconfig.json`), `test/integration.test.ts` (real Python/Node), `test/activation.test.ts` (Proxy-stub activation smoke test), `test/e2e/` (real VS Code, not run yet) |

## 4. What remains, in order

### 4.1 Restore a clean typecheck

The review fixer was interrupted. It had touched these files between 12:46 and 12:57 local time: `src/jobs.ts`, `src/atoms/prefetch.ts`, `src/specsCore.ts` and `src/coach.ts`. The two errors show it was adding a `'resume'` value to a function whose parameter type allows only `'review' | 'specs'`.

1. Read those call sites.
2. Either finish the change (extend the union and handle `'resume'` where it is consumed) or revert just that edit.
3. Do not discard the other edits in those files without checking what they fix. The user's global rules forbid discarding uncommitted work without asking.

Which findings the fixer finished is **unknown**. Treat every finding in §4.2 as open and check it against the current code.

### 4.2 Fix the 49 confirmed findings

All of them are in [docs/stage3-findings.md](stage3-findings.md). None are critical; the major ones come first.

| Group | Major finding ids |
|---|---|
| Flow | flow-1, flow-2, flow-3, flow-5 |
| Pad / editor UX | pad-1, pad-2, pad-3, pad-4 |
| Security | security-1 (vm escape via computed `constructor` access in the model-code allowlist), security-2 (native writers such as sqlite bypass the Python write sandbox; own-code probes run with the real `__file__`) |
| Learner model | evidence-1 through evidence-5 |
| Concurrency | concurrency-1, concurrency-2 |
| Spec drift | spec-2 (Go/Java/Rust are offered but fall back to the v0.1 loop), spec-4 |

Several findings share a root cause. Fix each root cause once:
- flow-3 and concurrency-1: Retry during a usage-limit pause applies the plan twice.
- flow-1 and concurrency-2: criteriaMet but never completed.
- pad-1, flow-7 and flow-8: the rung-4 skeleton holds the lock.
- pad-3 and concurrency-6: abortActive releases the lock early.
- flow-9, spec-3 and concurrency-10: completeTask waits on the follow-up.

For each fix, add a test that would have caught it.

### 4.3 Live Codex open issues

These are from [docs/stage3-live-codex.md](stage3-live-codex.md), most important first:

- **Latency versus placement.** On the standard tier, PlanOutline takes 100–180 s or more, and TaskPrep about 130 s for 2 tasks. Placement is about 3 minutes, so task 1's gate and specs usually miss `neededBy` and take the degraded path. Options:
  - prep task 1 alone first;
  - run PlanOutline on the priority tier, since the learner is effectively waiting;
  - extend placement.

  The spec's "40–70 s" figures are wrong for Codex.
- **Model-invented misconception ids.** 7 of 10 in TaskPrep were invented despite the known-id list, which splits evidence away from the seeded mutants. Consider mapping new ids to taxonomy ids locally, or rejecting them.
- **Unchecked failure-signature values.** They are never run, so they remain unverified claims.
- **Validation-dropped specs never reach the repair call.** A spec dropped because its call or expected value doesn't parse is never sent to repair; only run failures are.
- **Content quality.**
  - 'other' concepts drift into library trivia.
  - Refutations are terse.
  - The plan summary leaked coach instructions.
  - Warm-up ladders are thin.
- **Codex call overhead.** Each call carries about 17.5k input tokens of agent preamble, and `~/.codex/skills` still loads despite `--ignore-user-config`.
- **JS-only tags offered to Python plans.** The canonical-tag list in PlanOutline includes JS-only tags even for Python projects.

### 4.4 Run the extension in a real VS Code

`npm run test:e2e` (in `test/e2e/runE2E.ts`) launches the installed `Code.exe` with a throwaway `--user-data-dir`, `--extensions-dir` and a fixture workspace, and uses a fake codex that cannot make model calls. **It has never executed.** VS Code refused a second instance because a staged update to 1.140.0 holds the `vscode-updating` mutex until the user's running VS Code restarts.

1. Ask the user to choose "Restart to Update" in VS Code.
2. Then run `npm run test:e2e` and fix what breaks. Expect to adjust timings on the first run.

These cannot be automated and need a human check in an F5 Extension Development Host:
- real key presses through the when-clauses (Ctrl+Enter, y/n, 1–3, Esc Esc)
- the consent modal
- comment-thread hints
- the inline-AI offer
- theming

### 4.5 Release

Run these, in order:

```
npx tsc --noEmit
npm test
npx tsx scripts/verify-seeds.ts python
npx tsx scripts/verify-seeds.ts javascript
npx tsx scripts/verify-seeds.ts typescript
npm run package            # typecheck + test + verify:seeds + production build + vsce -> deliberate-coach-0.2.0.vsix
SMOKE_BUNDLE=dist/extension.js npx tsx --tsconfig test/tsconfig.json --test test/activation.test.ts
npm run test:e2e           # once VS Code allows a second instance
```

Then ask the user to install with `code --install-extension deliberate-coach-0.2.0.vsix --force` and give it a real session. Before that, send the user a short "how it works" walkthrough of v0.2; they asked for one.

## 5. Conventions and gotchas

**Environment:**
- **Windows 10.** Python 3.14 is at `C:\Users\yashc\AppData\Local\Python\pythoncore-3.14-64\python.exe`. The `py` launcher is **broken**; never rely on it. Node is 24.11.1 (`C:\Program Files\nodejs\node.exe`, with TS type-stripping); Node 23.9 is also on PATH. VS Code is at `C:\Users\yashc\AppData\Local\Programs\Microsoft VS Code\Code.exe`.
- **Codex.** The global npm `codex` (0.147) is too old for `gpt-6.1-sol` (the server rejects it). `src/codex.ts` auto-picks the newest binary, normally the Codex desktop app's bundled CLI under `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`. Live calls spend the user's ChatGPT plan, so keep test calls few.

**Writing files:**
- Use real file-editing tools. Bash heredocs on this machine mangle backslash escapes (`\n` arrives as a real newline).
- Keep LF line endings. Python's `pathlib.write_text()` converts to CRLF; use `open(..., newline='\n')`.

**Tests:**
- `test/tsconfig.json` maps `vscode` to `test/vscode-stub.ts`. Keep VS Code wrappers thin and put logic in pure, testable modules; that pattern runs through the whole codebase.

**Design rules:**
- Never insert code into the learner's project files. The rung-4 skeleton lives in the pad, and the private spec "reference" implementation is used only for verification and is never stored, logged or shown.
- Every learner-model update goes through `recordEvidence()`, following the conventions in `docs/stage1-notes.md` (evidence section).
- Model calls in the background use `JobQueue.bg` with generation tokens. Only Ask, Reveal, mini-atom Teach and spec-less Check run in the foreground lane.

**Dependencies:** don't add npm dependencies casually. `@vscode/test-electron` was added for e2e only.

**User preferences:**
- Terse chat replies.
- Fast learning over long explanations.
- The Codex plan rather than API keys.
- Their global rules: never run `git checkout -- <path>`, `git restore`, `git reset --hard`, `git clean -fd` or similar, or overwrite unread files, without asking first. Snapshot files before bulk rewrites. Ask before outward-facing actions.
