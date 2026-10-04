import * as vscode from 'vscode';
import type { Action, ActionKind, PauseKind, SchedulerDecision } from './contracts';
import { Emitter, describeJobs, type Event, type JobStats } from './jobs';
import { LIMIT_FLASH, STATE_FLASH_MS, decide, pushBack, status, statusText, tempoTooltip, type TempoInput } from './tempo';

export type { Action, ActionKind } from './contracts';

/** What every nudge source uses to reach the tempo bar (spec V1-4). Implemented by TempoBar. */
export interface ActionSink {
  /** Queue an action; returns its id. An action with the same id, or the same kind + command + args, is replaced in place. */
  enqueue(a: Omit<Action, 'id' | 'createdAt'> & { id?: string }): string;
  /** Remove by id, or every queued action of that kind. */
  remove(idOrKind: string): void;
  /** One-line setStatusBarMessage flash (default 3 s). */
  flash(text: string, ms?: number): void;
}

/** Snapshot the coach provides on every evaluation (no import of the coach). */
export interface TempoState {
  /** Task phase ('building', ...) or 'idle' without a task. */
  phase: string;
  stuckScore: number;
  /** Last edit of a code file (Monitor.lastEditAt). */
  lastEditAt: number;
  activeMsToday: number;
  sprintMsToday: number;
  /** Used when no lock is wired into the TempoBar. */
  lockHeld?: boolean;
  task?: { title: string; activeMin: number; estimateMin?: number };
  /** Monitor.detector.progressReason */
  progressReason?: string;
  /** Non-guess calibration 0..1 (learner.calibration.sure). */
  calibration?: number;
  /** Correct-under-par streak (shown only with deliberate.showTimers). */
  streak?: number;
  /** Status text when nothing is queued, e.g. status.specProgress(3, 5, title) or status.runningSpecs(). */
  idleText?: string;
}

/** What the controller draws; TempoBar maps it onto the StatusBarItem. */
export interface TempoRender {
  text: string;
  /** Markdown for a MarkdownString tooltip. */
  tooltip: string;
  /** statusBarItem.warningBackground (a pop). */
  warning: boolean;
}

export interface TempoView {
  render(r: TempoRender): void;
  flash(text: string, ms: number): void;
  setContext(key: string, value: boolean): void;
  execute(command: string, args: readonly unknown[]): Promise<unknown>;
}

export interface TempoControllerDeps {
  state: () => TempoState;
  view: TempoView;
  now?: () => number;
  /** JobQueue.stats() for the tooltip line and the busy text. */
  jobs?: { stats(): JobStats };
  /** InteractionLock.held; falls back to state().lockHeld. */
  lockHeld?: () => boolean;
  /** deliberate.showTimers (default true). */
  showTimers?: () => boolean;
  /** vscode.window.state.focused: pops wait until the window has focus. */
  focused?: () => boolean;
  log?: (line: string) => void;
  /** Run by deliberate.next with nothing queued. */
  fallbackCommand?: string;
  /** How long a pop keeps the warning background. */
  popHighlightMs?: number;
  /** process.platform, for the key label in the tooltip (tests pass one). */
  platform?: string;
  /** Timer for ending the warning background (tests pass a fake). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const NEXT_COMMAND = 'deliberate.next';
export const SKIP_COMMAND = 'deliberate.skipAction';
/** Commands the tempo tooltip may run (its trusted command links). */
export const TEMPO_TOOLTIP_COMMANDS: readonly string[] = [NEXT_COMMAND, SKIP_COMMAND];

/** The deliberate.next key as the learner presses it (alt+n is a dead key on macOS). */
export function nextKey(platform: string = process.platform): string {
  return platform === 'darwin' ? 'Ctrl+Alt+N' : 'Alt+N';
}

/** Tooltip links for the shown action: run it, or skip it (neutral; its kind is pushed back 5 minutes). */
export function actionLinks(platform?: string): string {
  return `[Do it (${nextKey(platform)})](command:${NEXT_COMMAND}) · [Not now](command:${SKIP_COMMAND})`;
}

/** Insert the action links right after the tooltip's 'Next: ...' paragraph (or first, when there is none). */
export function withActionLinks(tooltip: string, platform?: string): string {
  const parts = tooltip.split('\n\n');
  const at = parts.findIndex((p) => p.startsWith('Next: '));
  parts.splice(at + 1, 0, actionLinks(platform));
  return parts.join('\n\n');
}

export const POP_HIGHLIGHT_MS = 10_000;
export const POP_FLASH_MS = 5_000;
export const LIMIT_FLASH_MS = 8_000;
/** After opening a blocking action, nothing else opens for this long unless the command settles first (the flow takes the lock meanwhile). */
export const OPEN_GUARD_MS = 2_000;

const KIND_ICON: Record<ActionKind, string> = {
  atom: 'mortar-board',
  'jit-atom': 'mortar-board',
  gate: 'checklist',
  'hint-ready': 'lightbulb',
  'own-predict': 'question',
  'what-if': 'question',
  sprint: 'zap',
  warmup: 'zap',
  'review-ready': 'comment-discussion',
  'specs-ready': 'beaker',
  spec: 'beaker',
  placement: 'sync~spin',
  info: 'info',
};

/** An action's status text: its own '$(icon) text' or the kind's icon, text clipped to 40 characters. */
export function actionText(a: Pick<Action, 'kind' | 'label'>): string {
  const m = /^\$\(([^)]+)\)\s*(.*)$/s.exec(a.label.trim());
  return m ? statusText(m[1], m[2]) : statusText(KIND_ICON[a.kind] ?? 'circle-filled', a.label);
}

function stripIcons(text: string): string {
  return text.replace(/\$\([^)]+\)\s*/g, '').trim();
}

function sameArgs(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  try {
    return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  } catch {
    return false;
  }
}

/**
 * The tempo bar's logic, without vscode: the action queue, decide() on every trigger (monitor tick,
 * pause, enqueue, lock release), pops, opens, status text, tooltip, context keys and deliberate.next.
 */
export class TempoController implements ActionSink {
  private actions: Action[] = [];
  private lastPopAt = 0;
  private lastPopByKind: Record<string, number> = {};
  private activeAtPopByKind: Record<string, number> = {};
  private pushedBack: Record<string, number> = {};
  private lastPause: { kind: PauseKind; at: number } | undefined;
  private current: Action | undefined;
  private highlight: { id: string; until: number } | undefined;
  private highlightTimer: unknown;
  private openGuardUntil = 0;
  private opening = 0;
  private seq = 0;
  private readonly contextKeys = new Map<string, boolean>();
  private evaluating = false;
  private again = false;
  private lastRender = '';
  private disposed = false;
  private readonly now: () => number;
  private readonly skipEmitter = new Emitter<Action>();
  /**
   * An action was skipped (Not now, Esc). Neutral: record no evidence. The coach uses it for the
   * known-gap shortcut (a skipped JIT offer lowers that task's stuck threshold).
   */
  readonly onDidSkip = this.skipEmitter.event;

  constructor(private readonly deps: TempoControllerDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ---------------------------------------------------------------- ActionSink

  enqueue(a: Omit<Action, 'id' | 'createdAt'> & { id?: string }): string {
    const now = this.now();
    const same = a.id !== undefined
      ? this.actions.find((x) => x.id === a.id)
      : this.actions.find((x) => x.kind === a.kind && x.command === a.command && sameArgs(x.args, a.args));
    if (same) {
      // Replaced in place: id and createdAt stay, so an action that already popped does not pop again.
      Object.assign(same, { ...a, id: same.id, createdAt: same.createdAt });
      this.evaluate();
      return same.id;
    }
    const id = a.id ?? `${a.kind}-${(++this.seq).toString(36)}-${now.toString(36)}`;
    this.actions.push({ ...a, id, createdAt: now });
    this.evaluate();
    return id;
  }

  remove(idOrKind: string): void {
    const before = this.actions.length;
    this.actions = this.actions.some((x) => x.id === idOrKind)
      ? this.actions.filter((x) => x.id !== idOrKind)
      : this.actions.filter((x) => x.kind !== idOrKind);
    if (this.actions.length !== before) this.evaluate();
  }

  flash(text: string, ms = STATE_FLASH_MS): void {
    this.deps.view.flash(text, ms);
  }

  // ---------------------------------------------------------------- inputs

  /** A real pause (Monitor.onPause, or the spec controller's red -> green). */
  notePause(kind: PauseKind, at = this.now()): void {
    if (!this.lastPause || at >= this.lastPause.at) this.lastPause = { kind, at };
    this.evaluate();
  }

  /**
   * Skip or Esc on an action: neutral, and its kind is pushed back 5 minutes (rule 6).
   * A blocking action that was skipped is dropped from the queue.
   */
  skip(idOrKind: string): void {
    const byId = this.actions.find((x) => x.id === idOrKind);
    const kind = (byId?.kind ?? idOrKind) as ActionKind;
    const skipped = byId ? [byId] : this.actions.filter((x) => x.kind === kind);
    this.pushedBack = pushBack(this.pushedBack, kind, this.now());
    this.actions = this.actions.filter((x) => !(x.blocking && (byId ? x.id === byId.id : x.kind === kind)));
    for (const a of skipped) this.skipEmitter.fire(a);
    this.evaluate();
  }

  /** Not now (the tooltip link, deliberate.skipAction): skip the action shown right now. */
  skipCurrent(): Action | undefined {
    this.evaluate();
    const a = this.current;
    if (a) this.skip(a.id);
    return a;
  }

  /** The InteractionLock was released: a waiting blocking action may open now. */
  lockReleased(): void {
    this.openGuardUntil = 0;
    this.evaluate();
  }

  /** Queued actions, in queue order. */
  get queue(): readonly Action[] {
    return this.actions;
  }

  /** The action the status bar shows right now. */
  get shown(): Action | undefined {
    return this.current;
  }

  // ---------------------------------------------------------------- decide and draw

  /** Run decide() and apply it: open, pop, status text, tooltip, context keys. */
  evaluate(): SchedulerDecision {
    if (this.disposed) return { pop: false, open: false };
    if (this.evaluating) {
      this.again = true;
      return { action: this.current, pop: false, open: false };
    }
    this.evaluating = true;
    try {
      let d = this.decideOnce();
      for (let i = 0; this.again && i < 3; i++) {
        this.again = false;
        d = this.decideOnce();
      }
      return d;
    } finally {
      this.evaluating = false;
      this.again = false;
    }
  }

  private safeState(): TempoState {
    try {
      return this.deps.state();
    } catch (err) {
      this.deps.log?.(`tempo: state provider failed: ${err instanceof Error ? err.message : String(err)}`);
      return { phase: 'idle', stuckScore: 0, lastEditAt: 0, activeMsToday: 0, sprintMsToday: 0 };
    }
  }

  private decideOnce(): SchedulerDecision {
    const now = this.now();
    this.actions = this.actions.filter((a) => a.expiresAt === undefined || a.expiresAt > now);
    const st = this.safeState();
    const lockHeld = (this.deps.lockHeld?.() ?? st.lockHeld ?? false) || now < this.openGuardUntil;
    const input = (actions: Action[], held: boolean): TempoInput => ({
      now,
      actions,
      lastEditAt: st.lastEditAt,
      lastPopAt: this.lastPopAt,
      lastPause: this.lastPause,
      stuckScore: st.stuckScore,
      sprintMsToday: st.sprintMsToday,
      activeMsToday: st.activeMsToday,
      lockHeld: held,
      phase: st.phase,
      pushedBack: this.pushedBack,
      lastPopByKind: this.lastPopByKind,
      activeAtPopByKind: this.activeAtPopByKind,
    });
    let d = decide(input(this.actions, lockHeld));
    if (d.open && d.action) {
      const a = d.action;
      this.actions = this.actions.filter((x) => x.id !== a.id);
      this.run(a);
      // Show what is next while the flow takes the lock.
      d = { ...decide(input(this.actions, true)), open: false };
    }
    if (d.pop && d.action) {
      if (this.deps.focused && !this.deps.focused()) {
        d = { ...d, pop: false }; // pops wait for the window to have focus
      } else {
        const a = d.action;
        this.lastPopAt = now;
        this.lastPopByKind = { ...this.lastPopByKind, [a.kind]: now };
        this.activeAtPopByKind = { ...this.activeAtPopByKind, [a.kind]: st.activeMsToday };
        this.setHighlight(a.id, now);
        this.deps.view.flash(actionText(a), POP_FLASH_MS);
      }
    }
    this.current = d.action;
    this.draw(st, now);
    return d;
  }

  private setHighlight(id: string, now: number): void {
    const ms = this.deps.popHighlightMs ?? POP_HIGHLIGHT_MS;
    this.highlight = { id, until: now + ms };
    const set = this.deps.setTimer ?? ((fn: () => void, t: number) => setTimeout(fn, t));
    const clear = this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    if (this.highlightTimer !== undefined) clear(this.highlightTimer);
    this.highlightTimer = set(() => {
      this.highlightTimer = undefined;
      this.refresh();
    }, ms + 50);
  }

  /** Redraw the status and tooltip from the last decision (jobs changed, settings changed). */
  refresh(): void {
    if (this.disposed) return;
    this.draw(this.safeState(), this.now());
  }

  private idleText(st: TempoState, showTimers: boolean): string {
    let fg: string | undefined;
    try {
      fg = this.deps.jobs?.stats().fg;
    } catch {
      fg = undefined;
    }
    if (fg) return status.preparing(fg);
    if (st.idleText) return st.idleText.startsWith('$(') ? actionText({ kind: 'info', label: st.idleText }) : statusText('mortar-board', st.idleText);
    if (st.task) {
      const time = showTimers ? `${Math.floor(st.task.activeMin)}${st.task.estimateMin ? `/${st.task.estimateMin}` : ''}m · ` : '';
      return statusText('mortar-board', `${time}${st.task.title}`);
    }
    return '$(mortar-board) Deliberate';
  }

  private draw(st: TempoState, now: number): void {
    const showTimers = this.deps.showTimers?.() ?? true;
    const a = this.current;
    const text = a ? actionText(a) : this.idleText(st, showTimers);
    let jobs: string | undefined;
    try {
      jobs = this.deps.jobs ? describeJobs(this.deps.jobs.stats(), now) : undefined;
    } catch {
      jobs = undefined;
    }
    const base = tempoTooltip({
      taskTitle: st.task?.title,
      activeMin: st.task?.activeMin,
      estimateMin: st.task?.estimateMin,
      stuckScore: st.task ? st.stuckScore : undefined,
      progressReason: st.progressReason,
      jobs,
      calibration: st.calibration,
      streak: st.streak,
      showTimers,
      next: a ? stripIcons(a.label) : undefined,
    });
    const tooltip = a ? withActionLinks(base, this.deps.platform) : base;
    const warning = !!a && !!this.highlight && this.highlight.id === a.id && now < this.highlight.until;
    const key = `${text}\u0000${tooltip}\u0000${warning}`;
    if (key !== this.lastRender) {
      this.lastRender = key;
      this.deps.view.render({ text, tooltip, warning });
    }
    this.setContext('deliberate.hasAction', !!a);
    this.setContext('deliberate.building', st.phase === 'building');
  }

  private setContext(key: string, value: boolean): void {
    if (this.contextKeys.get(key) === value) return;
    this.contextKeys.set(key, value);
    this.deps.view.setContext(key, value);
  }

  private run(a: Action): void {
    if (!a.command) return;
    const token = ++this.opening;
    if (a.blocking) this.openGuardUntil = this.now() + OPEN_GUARD_MS;
    this.deps.view.execute(a.command, a.args ?? []).then(
      () => this.settle(token),
      (err) => {
        this.deps.log?.(`tempo: ${a.command} failed: ${err instanceof Error ? err.message : String(err)}`);
        this.settle(token);
      },
    );
  }

  private settle(token: number): void {
    if (token === this.opening) this.openGuardUntil = 0;
    this.evaluate();
  }

  /**
   * deliberate.next (Alt+N / ctrl+alt+n on mac, or a click on the item): run the current action,
   * or open the sidebar when nothing is queued.
   */
  async runNext(): Promise<void> {
    this.evaluate();
    const a = this.current;
    if (!a) {
      await this.deps.view.execute(this.deps.fallbackCommand ?? 'deliberate.open', []);
      return;
    }
    this.actions = this.actions.filter((x) => x.id !== a.id);
    if (!a.command) {
      this.evaluate();
      return;
    }
    const token = ++this.opening;
    if (a.blocking) this.openGuardUntil = this.now() + OPEN_GUARD_MS;
    this.evaluate();
    try {
      await this.deps.view.execute(a.command, a.args ?? []);
    } catch (err) {
      this.deps.log?.(`tempo: ${a.command} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.settle(token);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.highlightTimer !== undefined) (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.highlightTimer);
    this.highlightTimer = undefined;
    this.skipEmitter.dispose();
  }
}

// =====================================================================================
// TempoBar: the StatusBarItem 'deliberate.tempo'
// =====================================================================================

export interface TempoBarDeps {
  /** Coach snapshot callback (phase, stuckScore, lastEditAt, activeMsToday, sprintMsToday, lockHeld, task info). */
  state: () => TempoState;
  /** JobQueue: tooltip jobs line, busy text, redraw on change, and the usage-limit flash on pause. */
  jobs?: { stats(): JobStats; onDidChange?: Event<unknown>; onDidPause?: Event<{ reason: string }> };
  /** InteractionLock: lockHeld, and re-decide on release. */
  lock?: { readonly held: boolean; onDidRelease: Event<unknown> };
  /** Monitor: decide on each tick; pauses. Without it, a 5 s timer drives decide(). */
  monitor?: { onTick: vscode.Event<number>; onPause: vscode.Event<{ kind: PauseKind; at: number }> };
  log?: (line: string) => void;
  /** Register deliberate.next and deliberate.skipAction here (default true). */
  registerCommands?: boolean;
  /** Run by deliberate.next with nothing queued (default 'deliberate.open', the sidebar). */
  fallbackCommand?: string;
}

/**
 * Owns the status-bar item 'deliberate.tempo' (name 'Deliberate'), the single 'what next' surface.
 * Implements ActionSink. Registers deliberate.next (Alt+N, a click on the item) and
 * deliberate.skipAction (the tooltip's 'Not now'), and sets the context keys deliberate.hasAction
 * and deliberate.building.
 */
export class TempoBar implements ActionSink, vscode.Disposable {
  readonly controller: TempoController;
  /** Skip / Not now / Esc on an action (neutral: record no evidence). */
  readonly onDidSkip: Event<Action>;
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private flashed: vscode.Disposable | undefined;

  constructor(deps: TempoBarDeps) {
    const item = vscode.window.createStatusBarItem('deliberate.tempo', vscode.StatusBarAlignment.Left, 100);
    item.name = 'Deliberate';
    item.command = NEXT_COMMAND;
    this.item = item;
    const view: TempoView = {
      render: (r) => {
        item.text = r.text;
        const md = new vscode.MarkdownString(r.tooltip);
        md.supportThemeIcons = true;
        md.isTrusted = { enabledCommands: [...TEMPO_TOOLTIP_COMMANDS] };
        item.tooltip = md;
        item.backgroundColor = r.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      },
      flash: (text, ms) => {
        this.flashed?.dispose();
        this.flashed = vscode.window.setStatusBarMessage(text, ms);
      },
      setContext: (key, value) => void vscode.commands.executeCommand('setContext', key, value),
      execute: (command, args) => Promise.resolve(vscode.commands.executeCommand(command, ...args)),
    };
    this.controller = new TempoController({
      state: deps.state,
      view,
      jobs: deps.jobs,
      lockHeld: deps.lock ? () => deps.lock!.held : undefined,
      showTimers: () => vscode.workspace.getConfiguration('deliberate').get<boolean>('showTimers', true),
      focused: () => vscode.window.state.focused,
      log: deps.log,
      fallbackCommand: deps.fallbackCommand,
    });
    this.onDidSkip = this.controller.onDidSkip;

    const d = this.disposables;
    d.push(item);
    if (deps.monitor) {
      d.push(
        deps.monitor.onTick(() => this.controller.evaluate()),
        deps.monitor.onPause((e) => this.controller.notePause(e.kind, e.at)),
      );
    } else {
      const timer = setInterval(() => this.controller.evaluate(), 5000);
      d.push({ dispose: () => clearInterval(timer) });
    }
    if (deps.lock) d.push(deps.lock.onDidRelease(() => this.controller.lockReleased()));
    if (deps.jobs?.onDidChange) d.push(deps.jobs.onDidChange(() => this.controller.refresh()));
    if (deps.jobs?.onDidPause) {
      d.push(
        deps.jobs.onDidPause((e) => {
          if (e.reason === 'limit') this.controller.flash(LIMIT_FLASH, LIMIT_FLASH_MS);
        }),
      );
    }
    d.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('deliberate.showTimers')) this.controller.refresh();
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.controller.evaluate();
      }),
    );
    if (deps.registerCommands !== false) {
      d.push(
        vscode.commands.registerCommand(NEXT_COMMAND, () => this.controller.runNext()),
        vscode.commands.registerCommand(SKIP_COMMAND, () => void this.controller.skipCurrent()),
      );
    }
    this.controller.evaluate();
    item.show();
  }

  enqueue(a: Omit<Action, 'id' | 'createdAt'> & { id?: string }): string {
    return this.controller.enqueue(a);
  }

  remove(idOrKind: string): void {
    this.controller.remove(idOrKind);
  }

  flash(text: string, ms?: number): void {
    this.controller.flash(text, ms);
  }

  /** Skip / Esc / Later on an action: neutral, pushes its kind back 5 minutes. */
  skip(idOrKind: string): void {
    this.controller.skip(idOrKind);
  }

  /** deliberate.skipAction: skip the action shown now. */
  skipCurrent(): Action | undefined {
    return this.controller.skipCurrent();
  }

  /** The action the status bar shows right now. */
  get shown(): Action | undefined {
    return this.controller.shown;
  }

  /** A pause from outside the Monitor (prefer Monitor.notePause so every listener sees it). */
  notePause(kind: PauseKind, at?: number): void {
    this.controller.notePause(kind, at);
  }

  /** Re-run decide() now (e.g. after the coach's phase changed). */
  update(): void {
    this.controller.evaluate();
  }

  /** deliberate.next */
  runNext(): Promise<void> {
    return this.controller.runNext();
  }

  dispose(): void {
    this.controller.dispose();
    this.flashed?.dispose();
    for (const x of this.disposables) x.dispose();
  }
}
