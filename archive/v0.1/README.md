# Deliberate: learn by building

A VS Code coach that watches you build a real project. It notices when you're stuck, works out which concept you're missing, and teaches that concept. It doesn't write your code for you.

## The loop

1. **Goal.** Say what you want to build. Deliberate turns it into a roadmap of milestones and small tasks (15–45 min each), and tags each task with the concepts it needs.
2. **5-minute placement.** It asks 6–8 short applied questions about the fundamentals your project depends on. "I don't know" is a fine answer. If you miss a prerequisite, the concepts that build on it are capped too, so the coach traces gaps back to their root.
3. **Explain first.** Before you code a task, you describe your approach in your own words.
   - Workable plan: go build.
   - Concept gap: a micro-lesson (under 3 minutes) on exactly that concept, tied to this task, then a check question that makes you apply it.
   - No idea: first a lesson, then a guided step-by-step walkthrough that you restate in your own words.
4. **Build while it watches.** The monitor tracks *active* time since your last progress. Fixing errors, a failing command starting to pass, or steady error-free writing all count as progress. Time away from the editor doesn't count. It also looks for:
   - the same error persisting
   - repeated failing runs in the terminal (through shell integration)
   - writing and deleting the same code
   - staring at an error
5. **Hint ladder.** When you're stuck (or press `Ctrl+Alt+H`), you get the smallest hint that helps:
   1. **Nudge**: a Socratic question about where to look
   2. **Concept**: names the missing idea, with a generic example
   3. **Approach**: pseudocode for the stuck piece
   4. **Skeleton**: code with `___` blanks for you to fill
   5. **Piece**: the exact few lines, which you retype rather than paste

   After a hint, **I got it** asks you to explain why the fix works, so it sticks. **Reveal** is a last resort. It costs mastery and adds a challenge to rebuild the piece from memory.
6. **Check my work** (`Ctrl+Alt+Enter`) reviews your code against the acceptance criteria. Issues come back as questions, not corrected code. When it passes, you explain one key decision back.
7. **Follow-ups until it's easy.** Each solved task produces a follow-up that extends *your* project and uses your weakest concept again:
   - If you struggled, the follow-up stays close to the same idea.
   - If you were slow but unaided, it keeps the same difficulty for fluency.
   - If you were fast, it gets harder.

   Follow-ups continue until the concepts reach the mastery target (or you hit `maxFollowUps`), then the roadmap moves on.
8. **Nothing forgotten.**
   - Mistake patterns go into a journal, and the coach calls them out when they come back.
   - Concepts come back as spaced recall questions (one minute each).
   - **Speed drills** are timed, from-scratch rewrites of things you already know, to build fluency.

The **Progress** tab shows mastery per concept (weakest first), hints per task, solve-time trend per concept (whether you're getting faster), and the mistake journal. Your learner profile is kept across projects, so a new project skips what you've already mastered.

## Setup

1. Install the `.vsix`: Extensions view → `…` → *Install from VSIX…* → `deliberate-coach-0.1.0.vsix`.
2. Sign in to Codex. By default the coach runs on your **ChatGPT/Codex plan limits**, not an API key, using `gpt-6.1-sol` on the Fast tier. If you're already signed in to the Codex app or CLI, there's nothing to do. Otherwise run **Deliberate: Sign in to Codex**.
   - The extension automatically uses the newest Codex CLI on your machine. The Codex desktop app's bundled CLI is usually newer than a global npm install, and new models like `gpt-6.1-sol` need a recent client. To use a specific binary, set `deliberate.codexPath`.
   - Each coach call is a one-off, read-only `codex exec` in an empty temp folder with a JSON output schema. Codex isn't given your workspace; it only sees the context the coach sends it.
   - Alternatives: set `deliberate.provider` to `anthropic` (Claude API key) or `vscode-lm` (e.g. Copilot).
3. Open the graduation-cap icon in the Activity Bar and describe what you want to build.

Terminal monitoring needs shell integration, which is on by default in VS Code's integrated terminal for bash, zsh, fish and PowerShell.

## Settings

| Setting | Default | |
|---|---|---|
| `deliberate.provider` | `codex` | `codex` (ChatGPT plan), `anthropic` or `vscode-lm` |
| `deliberate.codexModel` | `gpt-6.1-sol` | Model for the Codex provider |
| `deliberate.codexFast` | `true` | Fast service tier (about 1.5x speed, uses more plan limits) |
| `deliberate.codexPath` | (auto) | Codex binary to use; empty means auto-detect the newest |
| `deliberate.model` | `claude-opus-5-5` | Claude model id (`anthropic` provider) |
| `deliberate.stuckThresholdMinutes` | `7` | Base minutes of progress-free active work before help is offered. Scaled per concept: weak concepts get help sooner, strong ones get more room. Each hint shortens the wait for the next one. |
| `deliberate.proactiveHints` | `offer` | `offer` (ask first), `auto` (give the next hint), `off` (only on request) |
| `deliberate.maxFollowUps` | `4` | Longest follow-up chain on one concept |

## Commands

- Deliberate: Open Coach
- Deliberate: Start a New Goal
- Deliberate: I'm Stuck — Give Me a Hint
- Deliberate: Teach Me the Concept
- Deliberate: Check My Work
- Deliberate: Ask the Coach
- Deliberate: Help Me Understand This Code (editor context menu on a selection)
- Deliberate: Start a Speed Drill
- Deliberate: Sign in to Codex
- Deliberate: Set Anthropic API Key
- Deliberate: Erase Learner Profile

## Privacy

When the coach needs context, it sends these to the model provider you chose (by default OpenAI, through Codex):

- the active file
- other files you edited during the current task
- current error diagnostics
- the output of your last failing terminal command

Nothing is sent while you just type. Calls happen only on coach actions: explaining, a hint, a check, a lesson or a question.

## Development

```
npm install
npm run build        # bundle to dist/ (esbuild)
npm run typecheck
npm test             # stuck detector, learner model, full coach-loop simulation
npm run package      # typecheck + test + .vsix
```

Press F5 in VS Code with this folder open to launch an Extension Development Host.

Source layout:

| File | Purpose |
|---|---|
| `src/coach.ts` | Coaching state machine (explain → learning → building → explain-back → done, follow-ups, recall) |
| `src/stuck.ts` | Pure stuck-detection logic (unit tested) |
| `src/monitor.ts` | VS Code wiring: edits, diagnostics, terminal shell integration, focus |
| `src/learner.ts` | Mastery model, spaced repetition, mistake journal |
| `src/llm.ts`, `src/codex.ts` | Providers: Codex CLI (default), Claude API, or VS Code LM |
| `src/prompts.ts`, `src/schemas.ts` | Coach persona, hint-ladder rules, output schemas |
| `src/view.ts`, `media/` | Sidebar webview |
