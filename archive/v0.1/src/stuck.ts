import { StuckSignals } from './types';

const MIN = 60_000;
const IDLE_CUTOFF = 5 * MIN;      // after this long without any activity, stop the clock (learner is away)
const EDIT_WINDOW = 5 * MIN;

interface EditEvent { at: number; inserted: number; deleted: number }
export interface TermEvent { at: number; command: string; exitCode: number | undefined; output: string }

/**
 * Pure stuck-detection logic (no vscode dependency so it can be unit tested).
 *
 * The clock that matters is *active* time since the last sign of progress:
 * time only accumulates while the window is focused and the learner did
 * something in the last few minutes, so walking away never counts as "stuck".
 */
export class StuckDetector {
  activeMsSinceProgress = 0;
  totalActiveMs = 0;
  private lastActivityAt: number;
  private lastTickAt: number;
  private edits: EditEvent[] = [];
  private errorsFirstSeen = new Map<string, { first: number; message: string }>();
  private lastErrorCount = 0;
  private terminal: TermEvent[] = [];
  private insertedSinceProgress = 0;
  private lastProgressReason = 'task started';

  constructor(now = Date.now()) {
    this.lastActivityAt = now;
    this.lastTickAt = now;
  }

  reset(now = Date.now(), reason = 'reset'): void {
    this.activeMsSinceProgress = 0;
    this.insertedSinceProgress = 0;
    this.lastActivityAt = now;
    this.lastProgressReason = reason;
    this.terminal = [];
  }

  get progressReason(): string {
    return this.lastProgressReason;
  }

  markProgress(now: number, reason: string): void {
    this.activeMsSinceProgress = 0;
    this.insertedSinceProgress = 0;
    this.lastProgressReason = reason;
    this.lastActivityAt = now;
  }

  activity(now: number): void {
    this.lastActivityAt = now;
  }

  onEdit(now: number, inserted: number, deleted: number): void {
    this.activity(now);
    this.edits.push({ at: now, inserted, deleted });
    this.edits = this.edits.filter((e) => now - e.at <= EDIT_WINDOW);
    this.insertedSinceProgress += inserted;
    // Steady net-new code with a clean error list counts as forward motion.
    if (this.insertedSinceProgress > 400 && this.lastErrorCount === 0 && this.churn(now) < 0.4) {
      this.markProgress(now, 'writing new code without errors');
    }
  }

  /** errors: current error-severity diagnostic messages across the workspace. */
  onDiagnostics(now: number, errors: string[]): void {
    const current = new Map(errors.map((e) => [normalizeError(e), e] as const));
    for (const key of [...this.errorsFirstSeen.keys()]) {
      if (!current.has(key)) this.errorsFirstSeen.delete(key);
    }
    for (const [key, message] of current) {
      if (!this.errorsFirstSeen.has(key)) this.errorsFirstSeen.set(key, { first: now, message });
    }
    if (current.size < this.lastErrorCount) {
      this.markProgress(now, `fixed ${this.lastErrorCount - current.size} error(s)`);
    }
    this.lastErrorCount = current.size;
  }

  onTerminal(now: number, command: string, exitCode: number | undefined, output: string): void {
    this.activity(now);
    const prevFailedSame = this.terminal.some((t) => t.command === command && t.exitCode !== 0);
    this.terminal.push({ at: now, command, exitCode, output });
    if (this.terminal.length > 30) this.terminal.shift();
    if (exitCode === 0 && prevFailedSame) {
      this.markProgress(now, `\`${command}\` now succeeds`);
    }
  }

  /** Advance clocks. Call every few seconds. Returns ms of active time added. */
  tick(now: number, focused: boolean): number {
    const dt = Math.max(0, Math.min(now - this.lastTickAt, 30_000));
    this.lastTickAt = now;
    const active = focused && now - this.lastActivityAt < IDLE_CUTOFF;
    if (!active) return 0;
    this.activeMsSinceProgress += dt;
    this.totalActiveMs += dt;
    return dt;
  }

  churn(now: number): number {
    const recent = this.edits.filter((e) => now - e.at <= EDIT_WINDOW);
    const ins = recent.reduce((s, e) => s + e.inserted, 0);
    const del = recent.reduce((s, e) => s + e.deleted, 0);
    return ins + del < 80 ? 0 : del / (ins + del);
  }

  /** Most recent run of each distinct command, newest first. A later success hides an earlier failure. */
  latestRuns(limit = 3): TermEvent[] {
    const seen = new Set<string>();
    const out: TermEvent[] = [];
    for (let i = this.terminal.length - 1; i >= 0 && out.length < limit; i--) {
      const t = this.terminal[i];
      if (seen.has(t.command)) continue;
      seen.add(t.command);
      out.push(t);
    }
    return out;
  }

  recentTerminalFailures(): TermEvent[] {
    return this.terminal.filter((t) => t.exitCode !== undefined && t.exitCode !== 0);
  }

  signals(now: number, thresholdMinutes: number): StuckSignals {
    const minutesSinceProgress = this.activeMsSinceProgress / MIN;
    let persistentError: string | undefined;
    let persistentErrorMinutes = 0;
    for (const { first, message } of this.errorsFirstSeen.values()) {
      const m = (now - first) / MIN;
      if (m > persistentErrorMinutes) {
        persistentErrorMinutes = m;
        persistentError = message;
      }
    }
    // Consecutive failures at the tail of the terminal history.
    let repeatedTerminalFailures = 0;
    for (let i = this.terminal.length - 1; i >= 0; i--) {
      const t = this.terminal[i];
      if (t.exitCode === 0) break;
      if (t.exitCode !== undefined) repeatedTerminalFailures++;
    }
    const lastFail = this.recentTerminalFailures().at(-1);
    const churn = this.churn(now);
    const idleMinutes = (now - this.lastActivityAt) / MIN;
    const idleWithErrorsMinutes = this.lastErrorCount > 0 && idleMinutes < IDLE_CUTOFF / MIN ? idleMinutes : 0;

    const reasons: string[] = [];
    let score = minutesSinceProgress / thresholdMinutes;
    if (minutesSinceProgress >= thresholdMinutes * 0.5) {
      reasons.push(`${minutesSinceProgress.toFixed(0)} min without visible progress`);
    }
    if (persistentError && persistentErrorMinutes >= thresholdMinutes * 0.5) {
      score += 0.2;
      reasons.push(`same error for ${persistentErrorMinutes.toFixed(0)} min`);
    }
    if (repeatedTerminalFailures >= 3) {
      score += 0.25;
      reasons.push(`${repeatedTerminalFailures} failing runs in a row`);
    }
    if (churn > 0.6) {
      score += 0.15;
      reasons.push('writing and deleting the same code');
    }
    if (idleWithErrorsMinutes >= 3) {
      score += 0.15;
      reasons.push('staring at an error');
    }
    // Never call it "stuck" in the first 90 seconds of active work.
    if (minutesSinceProgress < 1.5) score = Math.min(score, 0.3);

    return {
      minutesSinceProgress,
      thresholdMinutes,
      persistentError,
      persistentErrorMinutes,
      repeatedTerminalFailures,
      lastTerminalError: lastFail ? `$ ${lastFail.command}\n${lastFail.output}` : undefined,
      churn,
      idleWithErrorsMinutes,
      score,
      reasons,
    };
  }
}

function normalizeError(msg: string): string {
  // Collapse line/column numbers so the "same" error moving lines is still the same error.
  return msg.replace(/\d+/g, '#').trim().slice(0, 300);
}
