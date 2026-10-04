# Deliberate: learn by building

A VS Code coach for learning a language by building a real project. You write every line of your project. Deliberate keeps you in a fast loop inside the editor:

- it checks what you know with quick questions;
- it fixes the one belief that is wrong;
- behaviour specs turn green as you save;
- when you are stuck, it points at your own line.

The model works one step ahead in the background. You do not wait on it.

## The fast loop

1. **Start.** Describe what you want to build. The language comes from your workspace, your goal, or a one-key pick. The roadmap is designed in the background (about 1-2 min).

2. **Placement while it plans.** Meanwhile you answer about 10 quick *predict-the-output* checks in a practice tab beside your code. There are no essays.
   - Each check is graded in a fraction of a second against output recorded by actually running the code on your machine.
   - Placement stops as soon as the concepts your first tasks need are clear.

3. **Task card.** Each task is 5-15 minutes. Its card has 2-4 lines:
   - what to build;
   - the interface: the file and function signatures you write;
   - the behaviour specs your scaffolding level shows.

   When a task brings in a new concept, a 20-second check in a popup asks which patterns you need. Early on it also asks you to pick 1 of 3 short plans. **I'd do it differently** skips it with no penalty.

4. **Quick checks, 1-minute fixes.** Practice on a concept always starts with a question, never a lecture.
   - Know it already? You are through in about 25 s.
   - A wrong answer that matches a known misconception asks *"Did you think ...? y/n"*. If yes, it runs a one-key contrast pick, then a reveal, then a re-check on a different surface.
   - A new concept gets a short worked example, a fill-in-the-blank, and one more check.
   - The practice tab is in memory. No autocomplete, AI suggestion or language server can see it.

5. **Specs turn green as you build.** Saving a task file runs its behaviour specs in a sandboxed temp folder, usually in well under a second.
   - Only the next red spec is reported: a gutter icon, the status bar and the task card.
   - A known wrong result puts a one-line question on your function's `def` line.
   - When the next spec needs a concept you are shaky on, the status bar offers a 60-second drill.

6. **Stuck? Help on your own line.** Hints are prepared before you ask. A persistent error first gets a local question about the traceback. Then:
   1. **Nudge:** a question on the line to look at
   2. **Concept:** names the idea, with a drill offer
   3. **Steps:** plain-language steps for the stuck piece
   4. **Skeleton:** opens in the practice tab, never in your project
   5. **Smallest piece:** you retype it

   Sometimes you are first asked to predict what one of your own functions returns.

7. **Done.** When every visible spec passes, hidden specs check that the code works beyond the visible examples. Then two *what-if* questions ask what your function would return if one line were different. The next task starts at once.
   - The last task of each milestone is a **solo task**: no plan check, no spec titles, and hints only up to rung 2.

8. **Never idle.** While the coach prepares something, short sprints keep earlier concepts fast.
   - Sprints mix delayed misconception re-checks, mastery audits, traceback-reading items and *which pattern fits?* picks from your Pattern Deck.
   - A 60-second warm-up is offered at session start. It never opens on its own while you are building.

The **status bar item** always shows the single next thing to do (Alt+N or click). It only pops at real pauses: a clean manual save, a spec turning green, a terminal command succeeding after a failure, or 20 s idle with no errors.

The sidebar is a compact log of what happened, plus the Roadmap and the **Progress** tab, which shows:

- each concept's state: Unknown, Learning, Misconception, Fixing, Fragile, Solid or Fluent;
- the beliefs being fixed;
- your Pattern Deck;
- calibration (sure answers vs flagged guesses) and mastery audits;
- a **Pace** section: start to first keystroke, concept block times, model wait per task, and solo-task minutes and unaided rate.

## Keys

| Key | Where | What |
|---|---|---|
| `Alt+N` (mac `Ctrl+Alt+N`) | anywhere but the terminal | Do the next thing in the status bar (click it from the terminal) |
| `Ctrl+Enter` | practice tab | Submit your answer (also continues after reading) |
| `Ctrl+Shift+Enter` | practice tab | Submit, flagged as a guess (honesty never costs time) |
| `?` as the answer | practice tab | I don't know |
| `y` / `n` | practice tab | Answer *"Did you think ...?"* |
| `1` `2` `3` | practice tab | Pick an option |
| `Esc` `Esc` | practice tab | Leave practice (what you answered still counts) |
| `Ctrl+Alt+H` | anywhere | I'm stuck: next hint |
| `Ctrl+Alt+P` | your code, while building | Predict what your function returns |
| `Ctrl+Alt+Enter` | anywhere | Check my work / run my specs |
| `Ctrl+Alt+S` | anywhere | 3-minute sprint |

Answer lines in the practice tab start with `# -> ` (Python) or `// -> ` (JS/TS). For output with several lines, add more answer lines or separate the lines with ` | `.

## Setup

1. Install the `.vsix`: Extensions view → `…` → *Install from VSIX…* → `deliberate-coach-0.2.0.vsix`.
2. Sign in to Codex. By default the coach runs on your **ChatGPT/Codex plan limits**, not an API key. If you are already signed in to the Codex app or CLI, there is nothing to do. Otherwise run **Deliberate: Sign in to Codex**.
   - The extension uses the newest Codex CLI on your machine. To use a specific binary, set `deliberate.codexPath`.
   - Alternatives: set `deliberate.provider` to `anthropic` (Claude API key) or `vscode-lm` (for example Copilot).
3. Have Python 3.8+ or Node.js (20+ recommended, for its permission model) installed for instant, verified grading. TypeScript needs a Node that can strip types (22.6+), or `tsx`. Without a runtime, practice still works with unverified answer keys.
4. Open the Deliberate icon in the Activity Bar and describe what you want to build.

Terminal monitoring needs shell integration, which is on by default in VS Code's integrated terminal for bash, zsh, fish and PowerShell.

## Settings

| Setting | Default | |
|---|---|---|
| `deliberate.provider` | `codex` | `codex` (ChatGPT plan), `anthropic` or `vscode-lm` |
| `deliberate.codexModel` | `gpt-6.1-sol` | Model for the Codex provider |
| `deliberate.codexFast` | `true` | Fast tier for calls you wait on (Ask, Reveal, Check my work). Background calls never use it. |
| `deliberate.codexPath` | (auto) | Codex binary. Machine scope. |
| `deliberate.model` | `claude-opus-5-5` | Claude model id (`anthropic` provider) |
| `deliberate.vscodeLmFamily` | (first) | Model family for `vscode-lm` |
| `deliberate.localExecution` | `ask` | `ask`, `snippets`, `all` or `off`. What may run locally (see Privacy). Machine scope. |
| `deliberate.pythonPath` | (auto) | Python interpreter. Machine scope. |
| `deliberate.stuckThresholdMinutes` | `7` | Base minutes of progress-free active work before help is offered. Scaled per concept. |
| `deliberate.proactiveHints` | `offer` | `offer` (status bar), `auto` (next hint automatically), `off` (only on request; no hint prefetch) |
| `deliberate.maxFollowUps` | `2` | Longest follow-up chain on one concept. Follow-ups only come when the weakest concept is below P 0.6 or has an active misconception. |
| `deliberate.planEffort` | `medium` | Effort of the background roadmap call |
| `deliberate.backgroundConcurrency` | `2` | Background calls at once (1-3) |
| `deliberate.backgroundCallsPerHour` | `20` | Rolling hourly budget for background calls (4 reserved for hints). Halved for the session after a usage-limit error. |
| `deliberate.padColumn` | `beside` | Practice tab beside your code, or over it (`active`) |
| `deliberate.showTimers` | `true` | Task timer in the status bar and the streak in its tooltip |
| `deliberate.polishReview` | `false` | Background design/naming review after all specs pass |
| `deliberate.nameNewMisconceptions` | `false` | Opt-in: ask the model to name the belief behind an unmatched wrong answer |

## Commands

The main commands (all under **Deliberate:** in the Command Palette):

- Open Coach
- Start a New Goal
- Do the next thing
- Not Now
- I'm Stuck: Give Me a Hint
- Got It
- Teach Me the Concept
- Check My Work
- Reveal the Stuck Piece
- Predict My Function
- Sprint (3 min)
- Warm-up (60 s of due items)
- Practice While You Wait
- Retry the Roadmap
- Ask the Coach
- Help Me Understand This Code (editor context menu on a selection)
- Leave Practice
- Choose What Practice May Run Locally
- Show Log
- Sign in to Codex
- Set Anthropic API Key
- Erase Learner Profile

## Privacy

### What goes to the model

The model provider you chose (by default OpenAI, through Codex) receives:

- the goal and background you typed;
- a summary of your learner profile (concept estimates and named misconceptions);
- the list of source files in the workspace;
- the content of the files the current task works on, when preparing specs, hints and checks;
- current error diagnostics and the tail of your last failing terminal command, when you are stuck;
- your answers to open questions (Ask, your own plan, the explain-back fallback).

Background calls prepare the next steps one ahead (roadmap, task specs, practice packs for concepts with no bundled items, hint ladders). They run at most 20 times an hour by default, without the priority tier.

Each Codex call is a one-off, read-only `codex exec` in an empty temp folder. Codex is not given your workspace.

### What runs on your machine

Deliberate grades practice by running code locally, but only with your consent and only in a **trusted** workspace. The first time something needs to run, a prompt offers:

- **Snippets and my code**
- **Snippets only**
- **Not now**

Your answer is remembered on this machine. Change it with **Deliberate: Choose What Practice May Run Locally** or the `deliberate.localExecution` setting. That setting has machine scope, so a workspace's `.vscode/settings.json` cannot switch execution on. `deliberate.pythonPath` and `deliberate.codexPath` are machine scope for the same reason.

- **Snippets** are practice items: bundled templates, or model-written items verified before use. They run in a fresh temp folder under VS Code's global storage, with a 3 s limit per item. The environment is built from scratch, and an allowlist rejects file, process, network, `eval` and similar modules before anything runs.
  - Python runs with `-s -B` and an audit hook. The hook blocks writing outside the temp folder, starting processes, sockets and `ctypes`.
  - Node runs with its permission model: it can read only the runner files and the temp folder, and write only the temp folder.
- **Your code** (with *Snippets and my code*) is called with literal test inputs by a bundled harness. This covers behaviour specs, predict-your-function and what-ifs.
  - The working directory is always a fresh temp folder, never your workspace. A function under test that saves a file cannot overwrite your data.
  - On Python, the audit hook blocks writes outside the temp folder, processes and sockets. Top-level `input()` and `sys.argv` use are reported, not run.
  - On Node, file writes outside the temp folder are denied. Network access is **not** blocked for your own code on Node.
  - Code under an `if __name__ == '__main__'` guard (or a JS main guard) never runs.
- In an untrusted workspace nothing runs, and interpreters inside the workspace are never used for runtime discovery. Trusting the workspace later turns execution on without a reload.
- With execution off, practice uses unverified answer keys, and Check my work reviews your tasks instead of specs.

Deliberate never inserts code into your project files. Rung-4 skeletons and every practice item live in an in-memory tab.

### What stays local

- Your learner profile is kept in VS Code's global state.
- Every graded answer is appended to `evidence-YYYY-MM.jsonl` in the extension's global storage.
- The Pace metrics are computed from that log and never sent anywhere.

**Erase Learner Profile** deletes both.

### Inline AI suggestions

If GitHub Copilot, Codeium, Tabnine or Supermaven is active, Deliberate asks once per workspace whether to turn off inline suggestions there while you do tasks. That keeps your practice evidence accurate. **Start a New Goal** turns them back on.

Pasted text and assisted inserts in task files are counted silently. They lower the weight of the evidence; you never get a message about them.

## Development

```
npm install
npm run build                    # bundle to dist/ (esbuild)
npm run typecheck                # tsc --noEmit
npm test                         # node:test via tsx (unit, flow, integration and activation tests)
npm run verify:seeds -- python   # instantiate 20 of every seed template on this machine (also javascript, typescript)
npm run package                  # typecheck + test + verify:seeds for all three + production build + .vsix
```

Press F5 in VS Code with this folder open to launch an Extension Development Host. Some tests run real Python and Node; they skip themselves when a runtime is missing. `DELIBERATE_PYTHON=<path>` pins the interpreter for `verify:seeds`.

Source layout:

| Path | Purpose |
|---|---|
| `src/extension.ts`, `src/shell.ts` | Activation and wiring; consent, runtime discovery, caches and stock, commands (`shell.ts` is the pure, tested part) |
| `src/coach.ts` | The coaching flow: start, placement, tasks, gate, building, hints, completion, sprints |
| `src/view.ts`, `media/main.js`, `media/main.css` | Sidebar webview |
| `src/jobs.ts`, `src/lock.ts` | Two-lane job queue (background budget, generation tokens) and the one-modal-flow lock |
| `src/tempo.ts`, `src/tempoBar.ts` | Nudge scheduler and the status-bar item |
| `src/annotations.ts`, `src/annotationModel.ts`, `src/hints.ts` | Line annotations, comment threads, hint prefetch and display |
| `src/monitor.ts`, `src/stuck.ts` | Edits, saves, diagnostics, terminal, pauses, paste/assist detection, stuck detection |
| `src/evidence.ts`, `src/learner.ts`, `src/store.ts` | Bayesian learner model, evidence log, multi-window-safe storage |
| `src/runner.ts`, `src/proc.ts`, `src/runtimeDiscovery.ts`, `media/runner/` | Sandboxed local execution and runtime detection |
| `src/compare.ts`, `src/calls.ts` | Type-aware output comparison, literal call validation |
| `src/atoms/` | Practice content and the practice tab: tags, seeds, verification, cache, stock, pad, placement, sprints, prefetch |
| `src/specs.ts`, `src/specsCore.ts`, `media/harness/` | Behaviour spec ladder and harness |
| `src/owncode.ts`, `src/mutants.ts` | Predict-your-function and what-if mutants |
| `src/gate.ts`, `src/gateCore.ts` | Pattern and plan pick before a task |
| `src/llm.ts`, `src/codex.ts`, `src/prompts.ts`, `src/schemas.ts` | Providers, prompts and output schemas |
| `media/seed/`, `syntaxes/` | Bundled seed templates; practice-tab languages |
