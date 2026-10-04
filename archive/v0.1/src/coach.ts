import * as vscode from 'vscode';
import { z } from 'zod';
import { Store } from './store';
import { Llm, LlmError, Effort } from './llm';
import { Monitor } from './monitor';
import { gatherCodeContext } from './context';
import {
  allMastered, concept, dueForReview, MASTERY_TARGET, nudge, recordMistake, recordSolve,
  schedule, setMastery, slug, snapshot, stuckThreshold, upsertConcepts, weakest,
} from './learner';
import { HINT_RUNGS, MAX_RUNG, projectBrief, SYSTEM, taskBrief } from './prompts';
import {
  AnswerSchema, DiagnosticSchema, ExplanationReviewSchema, FollowUp, FollowUpSchema, GradeSchema,
  HintSchema, LessonSchema, PlanSchema, RecallSchema, RevealSchema, WorkReviewSchema,
} from './schemas';
import { Card, Phase, Project, StuckSignals, Task } from './types';
import { codeBlock, escapeHtml, md, uid } from './util';

export interface InputMode {
  mode: string;
  placeholder: string;
  submitLabel: string;
  extras: { label: string; command: string; arg?: string }[];
}

function cfg() {
  const c = vscode.workspace.getConfiguration('deliberate');
  return {
    stuckMinutes: c.get<number>('stuckThresholdMinutes', 7),
    proactive: c.get<'offer' | 'auto' | 'off'>('proactiveHints', 'offer'),
    maxFollowUps: c.get<number>('maxFollowUps', 4),
  };
}

/**
 * The coaching state machine. Each task moves through:
 *   explain -> (learning -> explain)* -> building -> (hints / lessons / explain-back)* -> explain-back -> done
 * and completion spawns follow-ups until the task's concepts are mastered.
 */
export class Coach implements vscode.Disposable {
  busy: string | undefined;
  signals: StuckSignals | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly statusEmitter = new vscode.EventEmitter<void>();
  readonly onChange = this.changeEmitter.event;
  readonly onStatus = this.statusEmitter.event;
  private disposables: vscode.Disposable[] = [];
  private ticksSinceSave = 0;

  constructor(
    private readonly store: Store,
    private readonly llm: Llm,
    private readonly monitor: Monitor,
  ) {
    this.disposables.push(this.changeEmitter, this.statusEmitter, monitor.onTick((ms) => this.onTick(ms)));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  get project(): Project | undefined {
    return this.store.project;
  }

  get task(): Task | undefined {
    const p = this.project;
    return p?.currentTaskId ? p.tasks[p.currentTaskId] : undefined;
  }

  private get learner() {
    return this.store.learner;
  }

  // ---------------------------------------------------------------- plumbing

  /** Re-render after external state changes (reset, new project). */
  refresh(): void {
    this.signals = undefined;
    this.changed();
  }

  private changed(): void {
    this.store.save();
    this.changeEmitter.fire();
  }

  private feed(): Card[] {
    return this.task?.feed ?? this.project?.feed ?? [];
  }

  private push(card: Omit<Card, 'id' | 'at'>, feed = this.feed()): Card {
    const full: Card = { id: uid('card'), at: Date.now(), ...card };
    feed.push(full);
    if (feed.length > 200) feed.splice(0, feed.length - 200);
    return full;
  }

  private ask<S extends z.ZodType>(prompt: string, schema: S, effort: Effort = 'medium'): Promise<z.infer<S>> {
    return this.llm.json({ system: SYSTEM, prompt, schema, effort });
  }

  /** Serialize coach work: one model call at a time, with a visible busy label and error card. */
  private async run(label: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy) {
      void vscode.window.showInformationMessage(`Deliberate is busy: ${this.busy}`);
      return;
    }
    this.busy = label;
    this.changeEmitter.fire();
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof LlmError || err instanceof Error ? err.message : String(err);
      this.push({ kind: 'error', title: 'Coach error', html: `<p>${escapeHtml(msg)}</p>` });
      if (!(err instanceof LlmError)) console.error('[deliberate]', err);
    } finally {
      this.busy = undefined;
      this.changed();
    }
  }

  /** Fresh snapshot of the learner's code. Always re-read at call time, never cached. */
  private codeSnapshot(): Promise<string> {
    const t = this.task;
    if (t) this.recordTouchedFiles(t);
    return gatherCodeContext(this.monitor, t?.files ?? []);
  }

  private recordTouchedFiles(t: Task): void {
    t.files ??= [];
    for (const u of this.monitor.touchedFiles) if (!t.files.includes(u)) t.files.push(u);
  }

  private learnerFor(ids: string[]): string {
    const withPrereqs = new Set(ids.map(slug));
    for (const id of ids) for (const pr of concept(this.learner, id)?.prerequisites ?? []) withPrereqs.add(pr);
    return snapshot(this.learner, [...withPrereqs]);
  }

  // ---------------------------------------------------------------- project setup

  async startProject(goal: string, background: string): Promise<void> {
    await this.run('Designing your roadmap (takes a minute or two)', async () => {
      const langs = await workspaceLanguages();
      const plan = await this.ask(
        [
          `The learner wants to build: ${goal}`,
          `Their background, in their words: ${background || '(not given)'}`,
          `Files already in the workspace: ${langs || '(empty workspace)'}`,
          `Learner profile from earlier projects:\n${snapshot(this.learner)}`,
          '',
          'Design a build roadmap that gets them from where they are to the finished project, learning the required concepts along the way.',
          '- 3 to 6 milestones, each with 2 to 5 tasks. Each task is 15-45 minutes and ends with something that runs or can be seen.',
          '- The first task is a 10-15 minute warm-up. Each task builds on the code from the previous one.',
          '- List every concept the project needs, including the fundamentals the tasks rely on (8-25 concepts), with prerequisites, so gaps can be traced back to their root.',
          '- Tag each task with the 1-3 concept ids it exercises most.',
          '- Task descriptions say what to build and how to check it works, never how to implement it.',
        ].join('\n'),
        PlanSchema,
        'high',
      );
      upsertConcepts(this.learner, plan.concepts);
      const project: Project = {
        goal,
        title: plan.title,
        summary: plan.summary,
        language: plan.language,
        createdAt: Date.now(),
        conceptIds: plan.concepts.map((c) => slug(c.id || c.name)),
        milestones: [],
        tasks: {},
        feed: [],
      };
      for (const m of plan.milestones) {
        const ids: string[] = [];
        for (const t of m.tasks) {
          const task = newTask({ ...t, conceptIds: t.conceptIds.map(slug) }, 'roadmap');
          project.tasks[task.id] = task;
          ids.push(task.id);
        }
        project.milestones.push({ title: m.title, taskIds: ids });
      }
      this.store.project = project;
      this.push({
        kind: 'info',
        title: plan.title,
        html: md(
          `${plan.summary}\n\n**${project.milestones.length} milestones, ${Object.keys(project.tasks).length} tasks, ${plan.concepts.length} concepts.**\n\n` +
            'First, a quick placement check (about 5 minutes) so I skip what you already know and only teach what you actually need.',
        ),
      });
      await this.buildDiagnostic();
    });
  }

  private async buildDiagnostic(): Promise<void> {
    const p = this.project!;
    const firstTasks = p.milestones.flatMap((m) => m.taskIds).slice(0, 4).map((id) => p.tasks[id]);
    const result = await this.ask(
      [
        projectBrief(p),
        `Concepts (id: name — prerequisites):\n${p.conceptIds
          .map((id) => concept(this.learner, id))
          .filter(Boolean)
          .map((c) => `- ${c!.id}: ${c!.name} — ${c!.prerequisites.join(', ') || 'none'}`)
          .join('\n')}`,
        `First tasks: ${firstTasks.map((t) => `${t.title} [${t.conceptIds.join(', ')}]`).join('; ')}`,
        `Learner profile:\n${snapshot(this.learner, p.conceptIds)}`,
        '',
        'Write a fast placement check: 6-8 questions, each answerable in under 2 minutes, that best reveal which of these concepts the learner already has.',
        'Prioritize fundamentals that many other concepts depend on and the concepts the first tasks need. Skip concepts the profile already shows as mastered.',
        `Mix formats (predict-output, spot-the-bug, explain, write-snippet of at most 5 lines). Use ${p.language}. Order from foundational to advanced.`,
        'Questions must test applied understanding, not definitions.',
      ].join('\n'),
      DiagnosticSchema,
    );
    p.diagnostic = {
      questions: result.questions.map((q) => ({ ...q, conceptId: slug(q.conceptId) })),
      index: 0,
      done: result.questions.length === 0,
    };
    if (p.diagnostic.done) return this.finishDiagnostic();
    this.pushDiagnosticQuestion();
  }

  private pushDiagnosticQuestion(): void {
    const d = this.project!.diagnostic!;
    const q = d.questions[d.index];
    const c = concept(this.learner, q.conceptId);
    this.push({
      kind: 'question',
      title: `Placement ${d.index + 1}/${d.questions.length} · ${c?.name ?? q.conceptId}`,
      html: md(`${q.question}\n\n${codeBlock(q.code)}`),
    });
  }

  async answerDiagnostic(answer: string | null): Promise<void> {
    const p = this.project;
    const d = p?.diagnostic;
    if (!p || !d || d.done) return;
    if (this.busy) return;
    const q = d.questions[d.index];
    this.push({ kind: 'you', title: 'You', html: md(answer ?? "_I don't know_") });

    const apply = (correct: boolean, score: number) => {
      q.correct = correct;
      const current = concept(this.learner, q.conceptId)?.mastery ?? 0.3;
      if (correct) setMastery(this.learner, q.conceptId, Math.max(current, 0.5 + 0.3 * score));
      else {
        setMastery(this.learner, q.conceptId, Math.min(current, 0.15));
        // A missing fundamental caps everything built on it.
        for (const c of Object.values(this.learner.concepts)) {
          if (c.prerequisites.includes(q.conceptId)) c.mastery = Math.min(c.mastery, 0.3);
        }
      }
    };

    const advance = async () => {
      d.index++;
      if (d.index < d.questions.length) this.pushDiagnosticQuestion();
      else await this.finishDiagnostic();
    };

    if (answer === null) {
      apply(false, 0);
      q.answer = '';
      this.changed();
      await advance();
      this.changed();
      return;
    }
    await this.run('Checking your answer', async () => {
      q.answer = answer;
      const grade = await this.grade(`${q.question}\n${codeBlock(q.code)}`, '', answer);
      apply(grade.correct, grade.score);
      q.feedback = grade.feedback;
      this.push({ kind: 'feedback', title: grade.correct ? 'Correct' : 'Not quite', html: md(grade.feedback) });
      await advance();
    });
  }

  private async finishDiagnostic(): Promise<void> {
    const p = this.project!;
    if (p.diagnostic) p.diagnostic.done = true;
    const cs = p.conceptIds.map((id) => concept(this.learner, id)).filter(Boolean) as NonNullable<ReturnType<typeof concept>>[];
    const strong = cs.filter((c) => c.mastery >= 0.5).map((c) => c.name);
    const weak = cs.filter((c) => c.mastery < 0.3).map((c) => c.name);
    this.push({
      kind: 'info',
      title: 'Placement done',
      html: md(
        (strong.length ? `**Solid:** ${strong.join(', ')}\n\n` : '') +
          (weak.length ? `**Will teach when a task needs it:** ${weak.join(', ')}\n\n` : '') +
          'No upfront course. You start building now, and I teach each missing idea at the moment a task needs it.',
      ),
    });
    const first = this.nextRoadmapTask();
    if (first) {
      // Keep the placement summary visible at the top of the first task.
      const summary = p.feed[p.feed.length - 1];
      this.beginTask(first);
      first.feed.unshift(summary);
    }
  }

  // ---------------------------------------------------------------- task lifecycle

  nextRoadmapTask(): Task | undefined {
    const p = this.project;
    if (!p) return;
    for (const m of p.milestones) {
      for (const id of m.taskIds) {
        const t = p.tasks[id];
        if (t && t.status === 'todo' && t.kind === 'roadmap') return t;
      }
    }
  }

  startTask(id: string): void {
    const t = this.project?.tasks[id];
    if (!t || this.busy) return;
    this.beginTask(t);
    this.changed();
  }

  private beginTask(t: Task): void {
    const p = this.project!;
    p.currentTaskId = t.id;
    this.monitor.startTask();
    if (t.status !== 'todo') return; // revisiting: keep its state
    t.status = 'active';
    t.startedAt = Date.now();
    const crit = t.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n');
    this.push(
      {
        kind: 'task',
        title: `${t.kind === 'followup' ? 'Follow-up' : t.kind === 'drill' ? 'Speed drill' : 'Task'}: ${t.title}`,
        html: md(`${t.description}\n\n**Done when:**\n${crit}\n\n_Target: ~${t.estimatedMinutes} min_`),
      },
      t.feed,
    );
    if (t.kind === 'drill') {
      t.phase = 'building';
      this.push({ kind: 'info', title: 'Go', html: md('Timed drill: write it from scratch, no hints offered until the target time passes. Click **Check my work** when done.') }, t.feed);
      return;
    }
    t.phase = 'explain';
    this.push(
      {
        kind: 'question',
        title: 'Before you code: explain your approach',
        html: md(
          'In your own words: what pieces will you build, in what order, and which data structures / APIs will you use? Rough is fine. Writing the plan first is what turns this from copying into learning.',
        ),
      },
      t.feed,
    );
  }

  skipExplain(): void {
    const t = this.task;
    if (!t || t.phase !== 'explain') return;
    t.phase = 'building';
    this.monitor.startTask();
    this.push({ kind: 'info', title: 'Building', html: md("Skipped the plan. I'm watching and will step in if you stall.") });
    this.changed();
  }

  async submitExplanation(text: string): Promise<void> {
    const t = this.task;
    const p = this.project;
    if (!t || !p) return;
    this.push({ kind: 'you', title: 'Your approach', html: md(text) });
    t.explainAttempts++;
    await this.run('Reviewing your approach', async () => {
      const r = await this.ask(
        [
          projectBrief(p),
          taskBrief({ ...t, explanation: undefined }),
          `Learner profile:\n${this.learnerFor(t.conceptIds)}`,
          `Attempt #${t.explainAttempts} at explaining the approach. Their explanation:\n"""${text}"""`,
          '',
          'Judge whether this approach would work and whether they understand the concepts it depends on.',
          '- verdict "ready" if the approach is workable. It does not have to be complete: small issues they will discover while coding are good for learning; raise at most one as a heads-up question.',
          '- verdict "gaps" if a missing or wrong concept would block them. List each gap with its concept id.',
          '- verdict "lost" if there is no workable approach yet.',
          'Do not hand them the approach. In feedback say concretely what is right, and phrase what is missing as questions.',
        ].join('\n'),
        ExplanationReviewSchema,
      );
      this.push({
        kind: 'feedback',
        title: r.verdict === 'ready' ? 'Plan looks workable' : r.verdict === 'gaps' ? 'Some gaps first' : "Let's build the idea together",
        html: md(r.feedback + (r.probingQuestion ? `\n\n> ${r.probingQuestion}` : '')),
      });

      if (r.verdict === 'ready') {
        t.explanation = text;
        nudge(this.learner, t.conceptIds, 0.05);
        t.phase = 'building';
        this.monitor.startTask();
        this.push({ kind: 'info', title: 'Go build it', html: md("I'm watching your editor, errors and terminal. If you stall I'll offer the smallest useful hint, never the whole answer. **Check my work** when you think it's done.") });
        return;
      }
      if (r.verdict === 'gaps' && r.gaps.length) {
        const gapIds = r.gaps.map((g) => slug(g.conceptId));
        upsertConcepts(this.learner, gapIds.filter((id) => !concept(this.learner, id)).map((id) => ({ id, name: id.replace(/-/g, ' '), description: '', prerequisites: [] })));
        nudge(this.learner, gapIds, -0.1);
        await this.teachInner(gapIds[0], r.gaps[0].issue, 'explain');
        return;
      }
      // Lost: first teach the weakest underlying concept; if still lost, walk through the approach.
      if (t.explainAttempts >= 2) {
        await this.guideApproach();
      } else {
        const w = weakest(this.learner, t.conceptIds);
        await this.teachInner(w?.id ?? t.conceptIds[0], 'They could not form an approach for the task.', 'explain');
      }
    });
  }

  async noIdea(): Promise<void> {
    const t = this.task;
    if (!t) return;
    this.push({ kind: 'you', title: 'You', html: md("_I don't know how to approach this yet._") });
    t.explainAttempts++;
    await this.run('Preparing a walkthrough', async () => {
      if (t.explainAttempts >= 2) return this.guideApproach();
      const w = weakest(this.learner, t.conceptIds);
      await this.teachInner(w?.id ?? t.conceptIds[0], 'They have no idea how to approach the task yet.', 'explain');
    });
  }

  private async guideApproach(): Promise<void> {
    const t = this.task!;
    const r = await this.ask(
      [
        projectBrief(this.project!),
        taskBrief(t),
        `Learner profile:\n${this.learnerFor(t.conceptIds)}`,
        'They have tried to explain an approach and could not. Walk them through how to think about this task: break it into steps in plain language (no code), and for each step say why it is needed and which concept it uses.',
        'End by asking them to restate the plan in their own words so they own it.',
      ].join('\n'),
      AnswerSchema,
    );
    this.push({ kind: 'lesson', title: 'How to think about this task', html: md(r.answer) });
    t.phase = 'explain';
  }

  // ---------------------------------------------------------------- teaching

  async teach(conceptId?: string): Promise<void> {
    const t = this.task;
    if (!t) return;
    const id = conceptId ?? weakest(this.learner, t.conceptIds)?.id ?? t.conceptIds[0];
    await this.run('Writing a micro-lesson', () =>
      this.teachInner(id, 'Learner asked to be taught this concept.', t.phase === 'learning' ? t.resumePhase ?? 'building' : t.phase),
    );
  }

  private async teachInner(conceptId: string, why: string, resume: Phase): Promise<void> {
    const t = this.task!;
    const c = concept(this.learner, conceptId);
    const code = t.phase === 'building' ? `\nWhat they have written so far:\n${await this.codeSnapshot()}` : '';
    const lesson = await this.ask(
      [
        projectBrief(this.project!),
        taskBrief(t),
        `Concept to teach: ${c ? `${c.id} — ${c.name}: ${c.description}` : conceptId} (mastery ${c?.mastery.toFixed(2) ?? 'unknown'}, lessons already seen ${c?.lessonsSeen ?? 0})`,
        `Why now: ${why}`,
        `Learner profile:\n${this.learnerFor([conceptId])}`,
        code,
        '',
        'Write a micro-lesson (under 3 minutes to read) that fills exactly this gap for this task.',
        'Start from intuition (what problem the idea solves), then one small example that is not the task solution, then the key points.',
        c && c.lessonsSeen > 0 ? 'They have seen a lesson on this before and still struggle: use a different angle or analogy than a textbook definition.' : '',
        'Finish with one check question that makes them apply the idea (predict output, explain why, or fix a 3-line snippet), not recite a definition.',
      ].join('\n'),
      LessonSchema,
    );
    if (c) c.lessonsSeen++;
    this.push({
      kind: 'lesson',
      title: lesson.title,
      html: md(`${lesson.explanation}\n\n${lesson.example}\n\n**Key points**\n${lesson.keyPoints.map((k) => `- ${k}`).join('\n')}`),
    });
    this.push({ kind: 'question', title: 'Check', html: md(lesson.checkQuestion) });
    t.pendingCheck = { conceptId, question: lesson.checkQuestion, expected: lesson.checkExpected, attempts: 0 };
    t.resumePhase = resume;
    t.phase = 'learning';
  }

  async answerCheck(answer: string): Promise<void> {
    const t = this.task;
    const pc = t?.pendingCheck;
    if (!t || !pc) return;
    this.push({ kind: 'you', title: 'You', html: md(answer) });
    await this.run('Checking your answer', async () => {
      pc.attempts++;
      const g = await this.grade(pc.question, pc.expected, answer);
      this.push({ kind: 'feedback', title: g.correct ? 'Correct' : 'Not quite', html: md(g.feedback) });
      if (g.correct) {
        nudge(this.learner, [pc.conceptId], 0.1);
      } else {
        nudge(this.learner, [pc.conceptId], -0.05);
        if (g.misconception) {
          recordMistake(this.learner, { pattern: g.misconception, detail: `Check question: ${pc.question}`, conceptIds: [pc.conceptId], taskId: t.id });
        }
        if (pc.attempts < 2) {
          this.push({ kind: 'info', title: 'Try once more', html: md('Use the feedback above and answer the check again.') });
          return;
        }
        const c = concept(this.learner, pc.conceptId);
        if (c) schedule(c, false); // bring it back for review soon
        this.push({ kind: 'info', title: 'Moving on', html: md(`A correct answer would cover: ${pc.expected}\n\nThis concept is queued for a quick review later.`) });
      }
      t.pendingCheck = undefined;
      t.phase = t.resumePhase ?? 'building';
      t.resumePhase = undefined;
      if (t.phase === 'explain') {
        this.push({ kind: 'question', title: 'Now, your approach', html: md('With that idea in hand, explain your approach to the task again.') });
      } else if (t.phase === 'building') {
        this.monitor.detector.markProgress(Date.now(), 'lesson finished');
        this.push({ kind: 'info', title: 'Back to building', html: md('Apply it to your code.') });
      }
    });
  }

  // ---------------------------------------------------------------- hints

  async hint(proactive = false): Promise<void> {
    const t = this.task;
    const p = this.project;
    if (!t || !p) return;
    if (t.hints.length >= MAX_RUNG) {
      this.push({ kind: 'info', title: 'Hint ladder exhausted', html: md('You have every hint for this piece. Use **Teach me** for the concept, or **Reveal** as a last resort (it costs mastery and adds a rebuild-from-memory challenge).') });
      this.changed();
      return;
    }
    const rung = t.hints.length + 1;
    const r = HINT_RUNGS[rung];
    const signals = this.signals;
    await this.run(`Preparing hint ${rung}/${MAX_RUNG}`, async () => {
      const res = await this.ask(
        [
          projectBrief(p),
          taskBrief(t),
          `Learner profile:\n${this.learnerFor(t.conceptIds)}`,
          `Stuck signals: ${signals?.reasons.join('; ') || (proactive ? 'stalled' : 'learner asked for a hint')}`,
          t.hints.length ? `Hints already given (do not repeat; build on them):\n${t.hints.map((h) => `${h.rung}. ${h.diagnosis}`).join('\n')}` : '',
          `Their code right now:\n${await this.codeSnapshot()}`,
          '',
          `First diagnose what they are stuck on. Then give a rung ${rung} hint ("${r.name}"): ${r.rule}`,
          'If it is an environment/tooling problem, just tell them how to fix it directly whatever the rung. If they are not actually stuck (the code meets the criteria), say so with stuckType "not-stuck".',
          'If it is a slip or a recurring mistake from their profile, name the pattern in mistakePattern.',
        ]
          .filter(Boolean)
          .join('\n'),
        HintSchema,
      );
      const conceptIds = res.conceptIds.map(slug).filter((id) => concept(this.learner, id));
      t.hints.push({ rung, at: Date.now(), diagnosis: res.diagnosis, html: md(res.hint) });
      t.offeredRung = Math.max(t.offeredRung, rung);
      if (res.stuckType === 'concept-gap') nudge(this.learner, conceptIds, -0.05);
      if (res.mistakePattern && (res.stuckType === 'slip' || res.stuckType === 'concept-gap')) {
        const m = recordMistake(this.learner, { pattern: res.mistakePattern, detail: res.diagnosis, conceptIds, taskId: t.id });
        if (m.count > 1) {
          this.push({ kind: 'info', title: `Recurring mistake ×${m.count}`, html: md(`**${m.pattern}** — you've hit this before. Worth a mental checklist item.`) });
        }
      }
      const actions = [
        { label: 'I got it', command: 'gotIt', primary: true },
        ...(rung < MAX_RUNG ? [{ label: `Next hint (${HINT_RUNGS[rung + 1].name})`, command: 'hint' }] : [{ label: 'Reveal…', command: 'reveal' }]),
        ...(res.stuckType === 'concept-gap' && conceptIds[0]
          ? [{ label: `Teach me ${concept(this.learner, conceptIds[0])?.name ?? conceptIds[0]}`, command: 'teach', arg: conceptIds[0] }]
          : []),
      ];
      this.push({ kind: 'hint', title: `Hint ${rung}/${MAX_RUNG} · ${r.name}`, html: md(res.hint), actions });
      // Give them time to apply it before nudging again.
      this.monitor.detector.markProgress(Date.now(), `hint ${rung}`);
    });
  }

  /** Learner says the hint unblocked them: make them explain the fix to lock it in. */
  gotIt(): void {
    const t = this.task;
    if (!t) return;
    t.phase = 'explain-back';
    t.resumePhase = 'building';
    t.explainBackQuestion = 'In one or two sentences: what was the problem, and why does your fix work?';
    this.push({ kind: 'question', title: 'Lock it in', html: md(t.explainBackQuestion) });
    this.changed();
  }

  imFine(): void {
    const t = this.task;
    // Re-arm the offer: it comes back only after another full stuck threshold.
    if (t) t.offeredRung = t.hints.length;
    this.monitor.detector.markProgress(Date.now(), 'learner declined help');
    this.changed();
  }

  async reveal(): Promise<void> {
    const t = this.task;
    if (!t) return;
    const ok = await vscode.window.showWarningMessage(
      'Reveal the code for the piece you are stuck on? It lowers mastery for these concepts and adds a rebuild-from-memory challenge.',
      { modal: true },
      'Reveal',
    );
    if (ok !== 'Reveal') return;
    await this.run('Revealing the stuck piece', async () => {
      const r = await this.ask(
        [
          projectBrief(this.project!),
          taskBrief(t),
          `Hints already given: ${t.hints.map((h) => h.diagnosis).join(' | ') || 'none'}`,
          `Their code:\n${await this.codeSnapshot()}`,
          '',
          'They asked to see the solution for the piece they are stuck on. Show only the smallest piece of code that unblocks them, with a walkthrough of the reasoning.',
          'Then set a rebuild challenge: a closely related mini-task they must do from memory without looking.',
        ].join('\n'),
        RevealSchema,
      );
      t.revealed = true;
      this.push({
        kind: 'hint',
        title: 'Revealed',
        html: md(`${r.explanation}\n\n${r.code}\n\n**Retype it — don't paste.**\n\n**Rebuild challenge (from memory, later):** ${r.rebuildChallenge}`),
        actions: [{ label: 'I got it', command: 'gotIt', primary: true }],
      });
      this.monitor.detector.markProgress(Date.now(), 'revealed');
    });
  }

  // ---------------------------------------------------------------- completion

  async checkWork(): Promise<void> {
    const t = this.task;
    const p = this.project;
    if (!t || !p) return;
    await this.run('Reviewing your work', async () => {
      const prev = t.lastReview;
      const r = await this.ask(
        [
          projectBrief(p),
          taskBrief(t),
          `Learner profile:\n${this.learnerFor(t.conceptIds)}`,
          `Their code:\n${await this.codeSnapshot()}`,
          prev
            ? `This is a RE-CHECK. Your previous review (${Math.round((Date.now() - prev.at) / 60000)} min ago) said: ${prev.summary}\n` +
              `Issues raised then:\n${prev.issues.map((i) => `- ${i}`).join('\n') || '- none'}\n` +
              'The learner has changed the code since. Judge ONLY the current code above: for each earlier issue, check whether the current code fixed it and say so explicitly in the summary; never repeat an issue the current code no longer has. Terminal output older than the latest edit is not evidence.'
            : '',
          '',
          'Review their work against the acceptance criteria. meetsCriteria is true only if every criterion is satisfied and there is no blocker.',
          'For each issue, give a Socratic question or pointer to the line, never the corrected code. Mention at most 2 polish items.',
          'mistakePatterns: genuine, reusable mistake patterns present in their code (empty if none).',
          'explainBackQuestion: ask them to explain one key decision in their solution, the one most likely to reveal whether they really understand it.',
        ].join('\n'),
        WorkReviewSchema,
        'high',
      );
      t.lastReview = { at: Date.now(), summary: r.summary, issues: r.issues.map((i) => `${i.severity}: ${i.prompt}`) };
      for (const m of r.mistakePatterns) {
        recordMistake(this.learner, { ...m, conceptIds: m.conceptIds.map(slug), taskId: t.id });
      }
      const issues = r.issues.map((i) => `- **${i.severity}** — ${i.prompt}`).join('\n');
      if (!r.meetsCriteria) {
        this.push({ kind: 'review', title: 'Not done yet', html: md(`${r.summary}\n\n${issues}`) });
        return;
      }
      this.push({ kind: 'review', title: 'Criteria met', html: md(`${r.summary}${issues ? `\n\n${issues}` : ''}`) });
      t.phase = 'explain-back';
      t.resumePhase = undefined;
      t.explainBackQuestion = r.explainBackQuestion;
      this.push({ kind: 'question', title: 'Explain it back', html: md(r.explainBackQuestion) });
    });
  }

  async answerExplainBack(answer: string): Promise<void> {
    const t = this.task;
    if (!t || !t.explainBackQuestion) return;
    this.push({ kind: 'you', title: 'You', html: md(answer) });
    await this.run('Checking your explanation', async () => {
      const g = await this.grade(
        t.explainBackQuestion!,
        '',
        answer,
        `Context — the task and their code:\n${taskBrief(t)}\n${await this.codeSnapshot()}`,
      );
      this.push({ kind: 'feedback', title: g.correct ? 'Clear understanding' : 'Partly there', html: md(g.feedback) });
      nudge(this.learner, t.conceptIds, g.correct ? 0.05 : -0.05);
      if (!g.correct && g.misconception) {
        recordMistake(this.learner, { pattern: g.misconception, detail: `Explaining: ${t.explainBackQuestion}`, conceptIds: t.conceptIds, taskId: t.id });
      }
      t.explainBackQuestion = undefined;
      if (t.resumePhase === 'building') {
        t.phase = 'building';
        t.resumePhase = undefined;
        this.monitor.detector.markProgress(Date.now(), 'unblocked');
        return;
      }
      await this.completeTask();
    });
  }

  private async completeTask(): Promise<void> {
    const t = this.task!;
    const p = this.project!;
    const before = Object.fromEntries(t.conceptIds.map((id) => [id, concept(this.learner, id)?.mastery ?? 0]));
    t.status = 'done';
    t.phase = 'done';
    t.completedAt = Date.now();
    recordSolve(this.learner, t);
    const mins = Math.round(t.activeMs / 60000);
    const deltas = t.conceptIds
      .map((id) => {
        const c = concept(this.learner, id);
        if (!c) return '';
        const d = c.mastery - before[id];
        return `- ${c.name}: ${(c.mastery * 100).toFixed(0)}% (${d >= 0 ? '+' : ''}${(d * 100).toFixed(0)})`;
      })
      .filter(Boolean)
      .join('\n');
    this.push({
      kind: 'info',
      title: 'Task complete',
      html: md(`**${mins} min** active (target ${t.estimatedMinutes}) · **${t.hints.length}** hints${t.revealed ? ' · revealed' : ''}\n\n${deltas}`),
    });

    // Drills are for fluency on known concepts; they never spawn follow-up chains.
    const needsMore = t.kind !== 'drill' && (t.revealed || !allMastered(this.learner, t.conceptIds));
    const roots = rootOf(p, t);
    const next = this.nextRoadmapTask();
    if (needsMore && t.followUpDepth < cfg().maxFollowUps) {
      const fu = await this.generateFollowUp(t);
      const task = newTask(fu, 'followup', t.id, t.followUpDepth + 1);
      insertAfter(p, roots, task);
      this.push({
        kind: 'task',
        title: 'Next: follow-up on the same idea',
        html: md(`**${fu.title}** — ${fu.why}`),
        actions: [
          { label: 'Start follow-up', command: 'startTask', arg: task.id, primary: true },
          ...(next ? [{ label: `Skip to: ${next.title}`, command: 'startTask', arg: next.id }] : []),
        ],
      });
    } else {
      this.push({
        kind: 'task',
        title: next ? 'Concepts solid — next roadmap task' : 'Roadmap complete',
        html: md(next ? `**${next.title}**` : 'You built the whole project. Run a speed drill to keep the concepts fast, or start a new goal.'),
        actions: [
          ...(next ? [{ label: `Start: ${next.title}`, command: 'startTask', arg: next.id, primary: true }] : []),
          { label: 'Speed drill', command: 'speedDrill' },
        ],
      });
    }
    await this.maybeRecallInner();
  }

  private async generateFollowUp(t: Task): Promise<FollowUp> {
    const p = this.project!;
    const upcoming = p.milestones.flatMap((m) => m.taskIds).map((id) => p.tasks[id]).filter((x) => x.status === 'todo').slice(0, 4);
    const fu = await this.ask(
      [
        projectBrief(p),
        `Just completed: ${taskBrief(t)}`,
        `How it went: ${Math.round(t.activeMs / 60000)} min active vs ${t.estimatedMinutes} estimated; ${t.hints.length} hints${t.hints.length ? ` (${t.hints.map((h) => h.diagnosis).join(' | ')})` : ''}; ${t.revealed ? 'needed the solution revealed' : 'no reveal'}; follow-up depth ${t.followUpDepth}.`,
        `Learner profile:\n${this.learnerFor(t.conceptIds)}`,
        `Upcoming roadmap tasks (do not duplicate): ${upcoming.map((x) => x.title).join('; ') || 'none'}`,
        '',
        'Design the next follow-up task. It extends their actual project code (not a toy exercise) and makes them apply the weakest concept again in a slightly new situation.',
        '- If they struggled a lot or needed a reveal: stay close to the original idea in a new context, small scope.',
        '- If they solved it unaided but slowly: similar difficulty, aim for fluency and speed.',
        '- If they solved it fast and unaided: raise the difficulty one step.',
        'Under 30 minutes. Describe what to build, not how.',
      ].join('\n'),
      FollowUpSchema,
    );
    const ids = fu.conceptIds.map(slug).filter((id) => concept(this.learner, id));
    return { ...fu, conceptIds: ids.length ? ids : t.conceptIds };
  }

  async speedDrill(): Promise<void> {
    const p = this.project;
    if (!p) return;
    await this.run('Designing a speed drill', async () => {
      const known = Object.values(this.learner.concepts)
        .filter((c) => c.mastery >= 0.5 && p.conceptIds.includes(c.id))
        .sort((a, b) => avg(b.solveTimesMin) - avg(a.solveTimesMin))
        .slice(0, 3);
      const ids = known.length ? known.map((c) => c.id) : p.conceptIds.slice(0, 2);
      const fu = await this.ask(
        [
          projectBrief(p),
          `Learner profile:\n${this.learnerFor(ids)}`,
          `Concepts to drill: ${ids.join(', ')}`,
          '',
          'Design a timed speed drill: a 5-10 minute task they already know how to do, to be written from scratch as fast as possible, in the context of their project.',
          'The point is fluency (fewer lookups, fewer errors, faster typing of idiomatic code), so it must be unambiguous and need no new concepts.',
        ].join('\n'),
        FollowUpSchema,
        'low',
      );
      const task = newTask({ ...fu, conceptIds: ids }, 'drill');
      p.tasks[task.id] = task;
      const last = p.milestones[p.milestones.length - 1];
      last.taskIds.push(task.id);
      this.beginTask(task);
    });
  }

  // ---------------------------------------------------------------- free questions & recall

  async askCoach(question: string): Promise<void> {
    const t = this.task;
    const p = this.project;
    this.push({ kind: 'you', title: 'You asked', html: md(question) });
    await this.run('Thinking', async () => {
      const r = await this.ask(
        [
          p ? projectBrief(p) : '',
          t ? taskBrief(t) : '',
          `Learner profile:\n${t ? this.learnerFor(t.conceptIds) : snapshot(this.learner)}`,
          t && t.phase === 'building' ? `Their code:\n${await this.codeSnapshot()}` : '',
          `Their question: """${question}"""`,
          '',
          'Answer as their coach. Conceptual questions: explain clearly with a small example. Tooling/setup questions: answer directly.',
          'If the question asks for the solution to their current task, do not hand it over: answer at the level of a concept explanation or approach hint and point them at where to look.',
          'conceptIds: concepts the question touches.',
        ]
          .filter(Boolean)
          .join('\n'),
        AnswerSchema,
      );
      this.push({ kind: 'answer', title: 'Coach', html: md(r.answer) });
    });
  }

  async maybeRecall(): Promise<void> {
    if (!this.project || this.project.pendingRecall || this.busy) return;
    if (!dueForReview(this.learner, 1).length) return;
    await this.run('Preparing a quick recall question', () => this.maybeRecallInner());
  }

  private async maybeRecallInner(): Promise<void> {
    const p = this.project;
    if (!p || p.pendingRecall) return;
    const [c] = dueForReview(this.learner, 1);
    if (!c) return;
    const r = await this.ask(
      [
        `Stack: ${p.language}`,
        `Concept due for spaced review: ${c.id} — ${c.name}: ${c.description} (mastery ${c.mastery.toFixed(2)})`,
        `Recurring mistakes on it:\n${this.learner.mistakes.filter((m) => m.conceptIds.includes(c.id)).map((m) => `- ${m.pattern}`).join('\n') || '- none'}`,
        'Write one retrieval question answerable in under a minute that requires applying the concept (predict output, spot the bug, or explain why). Target a recurring mistake if there is one.',
      ].join('\n'),
      RecallSchema,
      'low',
    );
    p.pendingRecall = { conceptId: c.id, question: r.question, code: r.code, expected: r.expected };
    // Recall cards live in the project feed and are pinned above whatever task is open.
    this.push({
      kind: 'review',
      title: `Quick recall · ${c.name}`,
      html: md(`${r.question}\n\n${codeBlock(r.code)}`),
      input: { command: 'answerRecall', placeholder: 'Answer from memory…' },
      actions: [{ label: 'Skip', command: 'skipRecall' }],
    }, p.feed);
  }

  async answerRecall(answer: string, cardId?: string): Promise<void> {
    const p = this.project;
    const rc = p?.pendingRecall;
    if (!p || !rc) return;
    this.clearCardInput(cardId);
    this.push({ kind: 'you', title: 'You', html: md(answer) });
    await this.run('Checking recall', async () => {
      const g = await this.grade(`${rc.question}\n${codeBlock(rc.code)}`, rc.expected, answer);
      const c = concept(this.learner, rc.conceptId);
      if (c) {
        schedule(c, g.correct);
        nudge(this.learner, [c.id], g.correct ? 0.05 : -0.1);
      }
      p.pendingRecall = undefined;
      this.push({ kind: 'feedback', title: g.correct ? 'Remembered' : 'Review again soon', html: md(g.feedback) });
    });
  }

  skipRecall(cardId?: string): void {
    const p = this.project;
    if (!p?.pendingRecall) return;
    const c = concept(this.learner, p.pendingRecall.conceptId);
    if (c) schedule(c, false);
    p.pendingRecall = undefined;
    this.clearCardInput(cardId);
    this.changed();
  }

  private clearCardInput(cardId?: string): void {
    const all = [...(this.project?.feed ?? []), ...Object.values(this.project?.tasks ?? {}).flatMap((t) => t.feed)];
    for (const c of all) {
      if ((cardId && c.id === cardId) || (!cardId && c.input?.command === 'answerRecall')) {
        c.input = undefined;
        c.actions = undefined;
      }
    }
  }

  private grade(question: string, expected: string, answer: string, extra = '') {
    return this.ask(
      [
        `Question:\n${question}`,
        expected ? `A correct answer must contain: ${expected}` : '',
        extra,
        `Learner's answer:\n"""${answer}"""`,
        '',
        'Grade it. Accept informal wording that shows the right understanding; reject answers vague enough to hide a misconception.',
        'feedback: if wrong, explain the correct idea briefly and concretely; if right, add one sentence that deepens it. misconception: the underlying wrong belief, if any.',
      ]
        .filter(Boolean)
        .join('\n'),
      GradeSchema,
      'low',
    );
  }

  // ---------------------------------------------------------------- input routing

  /** Main input box submit: meaning depends on where the learner is. */
  async submit(text: string): Promise<void> {
    const p = this.project;
    const t = this.task;
    if (!p) return;
    if (p.diagnostic && !p.diagnostic.done) return this.answerDiagnostic(text);
    if (!t) return this.askCoach(text);
    switch (t.phase) {
      case 'explain':
        return this.submitExplanation(text);
      case 'learning':
        return t.pendingCheck ? this.answerCheck(text) : this.askCoach(text);
      case 'explain-back':
        return this.answerExplainBack(text);
      default:
        return this.askCoach(text);
    }
  }

  inputMode(): InputMode {
    const p = this.project;
    const t = this.task;
    if (!p) return { mode: 'none', placeholder: '', submitLabel: '', extras: [] };
    if (p.diagnostic && !p.diagnostic.done) {
      return { mode: 'diagnostic', placeholder: 'Your answer…', submitLabel: 'Answer', extras: [{ label: "I don't know", command: 'diagnosticSkip' }] };
    }
    if (!t || t.phase === 'done') {
      return { mode: 'ask', placeholder: 'Ask the coach anything…', submitLabel: 'Ask', extras: [] };
    }
    switch (t.phase) {
      case 'explain': {
        const extras = [{ label: 'I have no idea', command: 'noIdea' }];
        if (allMastered(this.learner, t.conceptIds)) extras.push({ label: 'Skip — I know this', command: 'skipExplain' });
        return { mode: 'explain', placeholder: 'Steps, data structures, APIs you plan to use…', submitLabel: 'Submit approach', extras };
      }
      case 'learning':
        return { mode: 'check', placeholder: 'Answer the check question…', submitLabel: 'Answer', extras: [] };
      case 'explain-back':
        return { mode: 'explain-back', placeholder: 'Explain in your own words…', submitLabel: 'Submit', extras: [] };
      default:
        return {
          mode: 'building',
          placeholder: "Ask the coach (it won't hand you the solution)…",
          submitLabel: 'Ask',
          extras: [
            { label: t.hints.length ? `Hint ${Math.min(t.hints.length + 1, MAX_RUNG)}/${MAX_RUNG}` : "I'm stuck", command: 'hint' },
            { label: 'Teach me', command: 'teach' },
            { label: 'Check my work', command: 'checkWork' },
          ],
        };
    }
  }

  // ---------------------------------------------------------------- monitoring

  private onTick(addedMs: number): void {
    const t = this.task;
    if (!t || t.status !== 'active') return;
    t.activeMs += addedMs;
    this.recordTouchedFiles(t);
    if (t.phase === 'building') {
      const threshold = t.kind === 'drill' ? t.estimatedMinutes * 1.5 : stuckThreshold(this.learner, t, cfg().stuckMinutes);
      this.signals = this.monitor.detector.signals(Date.now(), threshold);
      if (this.signals.score >= 1) t.stuckMs += addedMs;
      this.maybeOfferHelp(t);
    } else {
      this.signals = undefined;
    }
    if (++this.ticksSinceSave >= 6) {
      this.ticksSinceSave = 0;
      this.store.save();
    }
    this.statusEmitter.fire();
  }

  private maybeOfferHelp(t: Task): void {
    const s = this.signals;
    const nextRung = t.hints.length + 1;
    if (!s || s.score < 1 || this.busy || nextRung > MAX_RUNG || t.offeredRung >= nextRung) return;
    const mode = cfg().proactive;
    if (mode === 'off') return;
    t.offeredRung = nextRung;
    if (mode === 'auto') {
      void this.hint(true);
      return;
    }
    const why = s.reasons.join(', ') || 'no progress for a while';
    this.push({
      kind: 'info',
      title: 'Looks like you might be stuck',
      html: md(`_${why}_\n\nWant the smallest nudge that gets you moving? (Hint ${nextRung}/${MAX_RUNG}: ${HINT_RUNGS[nextRung].name})`),
      actions: [
        { label: 'Give me a hint', command: 'hint', primary: true },
        { label: "I'm fine", command: 'imFine' },
      ],
    });
    this.changed();
    void vscode.window
      .showInformationMessage(`Deliberate: stuck? (${why})`, 'Give me a hint', "I'm fine")
      .then((choice) => {
        if (choice === 'Give me a hint') void this.hint(true);
        else if (choice === "I'm fine") this.imFine();
      });
  }

  statusInfo() {
    const t = this.task;
    return {
      busy: this.busy,
      taskTitle: t?.title,
      phase: t?.phase,
      activeMin: t ? t.activeMs / 60000 : 0,
      estimate: t?.estimatedMinutes ?? 0,
      hints: t?.hints.length ?? 0,
      stuck: this.signals
        ? {
            score: this.signals.score,
            minutes: this.signals.minutesSinceProgress,
            threshold: this.signals.thresholdMinutes,
            reasons: this.signals.reasons,
            since: this.monitor.detector.progressReason,
          }
        : undefined,
    };
  }

  viewModel() {
    const p = this.project;
    const t = this.task;
    const conceptStates = Object.values(this.learner.concepts)
      .filter((c) => !p || p.conceptIds.includes(c.id) || c.attempts > 0)
      .sort((a, b) => a.mastery - b.mastery)
      .map((c) => ({
        id: c.id,
        name: c.name,
        mastery: c.mastery,
        attempts: c.attempts,
        hints: c.hintsUsed,
        mastered: c.mastery >= MASTERY_TARGET,
        avgMin: c.solveTimesMin.length ? avg(c.solveTimesMin) : null,
        trend: speedTrend(c.solveTimesMin),
        due: c.nextReview > 0 && c.nextReview <= Date.now(),
      }));
    return {
      hasProject: !!p,
      project: p && {
        title: p.title,
        goal: p.goal,
        milestones: p.milestones.map((m) => ({
          title: m.title,
          tasks: m.taskIds
            .map((id) => p.tasks[id])
            .filter(Boolean)
            .map((x) => ({ id: x.id, title: x.title, status: x.status, kind: x.kind, current: x.id === p.currentTaskId, depth: x.followUpDepth })),
        })),
      },
      task: t && { id: t.id, title: t.title, phase: t.phase, kind: t.kind },
      feed: (t ? [...(p?.pendingRecall ? p.feed.filter((c) => c.input) : []), ...t.feed] : p?.feed ?? []).slice(-80),
      input: this.inputMode(),
      status: this.statusInfo(),
      progress: {
        concepts: conceptStates,
        mistakes: [...this.learner.mistakes].sort((a, b) => b.count - a.count || b.at - a.at).slice(0, 10),
        totals: this.learner.totals,
      },
    };
  }
}

// ---------------------------------------------------------------- helpers

function newTask(
  t: { title: string; description: string; acceptanceCriteria: string[]; conceptIds: string[]; estimatedMinutes: number; why?: string },
  kind: Task['kind'],
  parentId?: string,
  depth = 0,
): Task {
  return {
    id: uid('task'),
    title: t.title,
    description: t.why ? `${t.description}\n\n_Why: ${t.why}_` : t.description,
    acceptanceCriteria: t.acceptanceCriteria,
    conceptIds: t.conceptIds,
    estimatedMinutes: Math.max(3, Math.round(t.estimatedMinutes || 20)),
    kind,
    parentId,
    followUpDepth: depth,
    status: 'todo',
    phase: 'explain',
    activeMs: 0,
    stuckMs: 0,
    explainAttempts: 0,
    hints: [],
    revealed: false,
    offeredRung: 0,
    feed: [],
  };
}

function rootOf(p: Project, t: Task): Task {
  let cur = t;
  while (cur.parentId && p.tasks[cur.parentId]) cur = p.tasks[cur.parentId];
  return cur;
}

/** Insert a follow-up after the last task in its chain, inside the root task's milestone. */
function insertAfter(p: Project, root: Task, task: Task): void {
  p.tasks[task.id] = task;
  const m = p.milestones.find((x) => x.taskIds.includes(root.id)) ?? p.milestones[p.milestones.length - 1];
  let idx = m.taskIds.indexOf(root.id);
  while (idx + 1 < m.taskIds.length && rootOf(p, p.tasks[m.taskIds[idx + 1]]).id === root.id) idx++;
  m.taskIds.splice(idx + 1, 0, task.id);
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Negative = getting faster. Compares the latest 3 solves with the earlier ones. */
function speedTrend(xs: number[]): number | null {
  if (xs.length < 4) return null;
  const recent = avg(xs.slice(-3));
  const earlier = avg(xs.slice(0, -3));
  return earlier > 0 ? (recent - earlier) / earlier : null;
}

async function workspaceLanguages(): Promise<string> {
  const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out,build,.venv,venv,__pycache__,target}/**', 300);
  const counts = new Map<string, number>();
  for (const f of files) {
    const ext = f.path.split('.').pop();
    if (ext && ext.length <= 6 && !f.path.endsWith('/' + ext)) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([e, n]) => `.${e} x${n}`)
    .join(', ');
}
