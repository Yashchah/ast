import type { Action, ActionKind, PauseKind, SchedulerDecision, SchedulerInput } from './contracts';

/**
 * Nudge scheduler for the tempo bar (spec V1-4). Pure: every nudge from mechanisms 6-12 goes
 * through decide(), so nudges never pile up and pop-ups only happen at real pauses.
 *
 * Action.priority: lower numbers come first (0 = most urgent), as in the job queue.
 */

const SEC = 1000;
const MIN = 60 * SEC;
export const NO_EDIT_MS = 8 * SEC;
export const POP_SPACING_MS = 30 * SEC;
export const PAUSE_WINDOW_MS = 20 * SEC;
export const OWN_PREDICT_SPACING_MS = 3 * MIN;
export const SPRINT_SHARE = 0.15;
export const PUSH_BACK_MS = 5 * MIN;
export const STATUS_MAX = 40;

/** Pauses that may trigger a pop. Auto-saves (AfterDelay, FocusOut) are deliberately absent. */
const PAUSE_KINDS: ReadonlySet<string> = new Set<PauseKind>(['manual-save', 'spec-green', 'terminal-ok', 'idle']);
/** Status-only kinds: they replace the status text but never pop (rule 7 for jit-atom). */
const SILENT_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>(['jit-atom', 'specs-ready', 'spec', 'placement', 'info']);

export interface TempoInput extends SchedulerInput {
  /**
   * activeMsToday at the last pop of each kind. Rule 4 counts ACTIVE minutes; when this is
   * missing, wall-clock time since lastPopByKind is used instead (a looser bound).
   */
  activeAtPopByKind?: Record<string, number>;
}

/**
 * Rules:
 * (1) Blocking actions the learner started open immediately when the lock is free; otherwise
 *     they wait at the head of the queue.
 * (2) Nothing pops while the lock is held.
 * (3) Anything else pops only with no edit in 8 s, 30 s since the last pop, and a qualifying
 *     pause in the last 20 s (manual clean save, spec red->green, terminal ok after a failure, 20 s idle).
 * (4) Own-code predict offers pop at most once per 3 active minutes and are not offered while the
 *     stuck score is in [.5, 1) (at >= 1 they are the pre-hint step). They show only once allowed to pop.
 * (5) Sprint offers stop above 15% of active time today; sprints never auto-open while building
 *     (and warm-ups never auto-open).
 * (6) Skip/Esc pushes the kind back 5 min (see pushBack()).
 * (7) jit-atom (and other status-only kinds) replace the status text without a pop.
 * An action pops at most once.
 */
export function decide(input: TempoInput): SchedulerDecision {
  const windowOpen = popWindowOpen(input);
  for (const a of sortActions(input.actions)) {
    if (!eligible(a, input)) continue;
    if (a.blocking) {
      const open = !input.lockHeld && mayAutoOpen(a, input);
      // A sprint that may not auto-open is only an offer: it follows the pop rules below.
      if (open || !isSprint(a)) return { action: a, pop: false, open };
    }
    const pop = windowOpen && mayPop(a, input);
    // Own-code predict offers appear only when the scheduler lets them pop (then they stay).
    if (a.kind === 'own-predict' && !a.blocking && !pop && !hasPopped(a, input)) continue;
    return { action: a, pop, open: false };
  }
  return { pop: false, open: false };
}

/** Blocking first (they wait at the head), then priority, then oldest first. */
export function sortActions(actions: Action[]): Action[] {
  return [...actions].sort(
    (a, b) =>
      Number(b.blocking) - Number(a.blocking) ||
      a.priority - b.priority ||
      a.createdAt - b.createdAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function isSprint(a: Action): boolean {
  return a.kind === 'sprint' || a.kind === 'warmup';
}

/** Explicitly started flows (atom, gate, ...) are exempt from push-back and offer limits. */
function learnerStarted(a: Action): boolean {
  return a.blocking && !isSprint(a);
}

function eligible(a: Action, input: TempoInput): boolean {
  const { now } = input;
  if (a.expiresAt !== undefined && a.expiresAt <= now) return false;
  if (learnerStarted(a)) return true;
  if ((input.pushedBack?.[a.kind] ?? 0) > now) return false; // rule 6
  if (isSprint(a) && sprintCapReached(input)) return false; // rule 5
  if (a.kind === 'own-predict' && input.stuckScore >= 0.5 && input.stuckScore < 1) return false; // rule 4
  return true;
}

export function sprintCapReached(input: Pick<SchedulerInput, 'sprintMsToday' | 'activeMsToday'>): boolean {
  return input.sprintMsToday > SPRINT_SHARE * input.activeMsToday;
}

function mayAutoOpen(a: Action, input: TempoInput): boolean {
  if (a.kind === 'warmup') return false;
  if (a.kind === 'sprint') return input.phase !== 'building' && input.now - input.lastEditAt >= NO_EDIT_MS;
  return true;
}

/** Rules 2 and 3: is this a moment at which anything may pop? */
export function popWindowOpen(input: SchedulerInput): boolean {
  const { now, lastPause } = input;
  if (input.lockHeld) return false;
  if (now - input.lastEditAt < NO_EDIT_MS) return false;
  if (now - input.lastPopAt < POP_SPACING_MS) return false;
  if (!lastPause || !PAUSE_KINDS.has(lastPause.kind)) return false;
  return lastPause.at <= now && now - lastPause.at <= PAUSE_WINDOW_MS;
}

function mayPop(a: Action, input: TempoInput): boolean {
  if (SILENT_KINDS.has(a.kind)) return false;
  if (hasPopped(a, input)) return false;
  if (a.kind === 'own-predict') {
    const activeAt = input.activeAtPopByKind?.['own-predict'];
    // activeMsToday restarts every day: a value above today's total means "yesterday".
    if (activeAt !== undefined && activeAt <= input.activeMsToday) {
      return input.activeMsToday - activeAt >= OWN_PREDICT_SPACING_MS;
    }
    const at = input.lastPopByKind?.['own-predict'];
    if (activeAt === undefined && at !== undefined) return input.now - at >= OWN_PREDICT_SPACING_MS;
  }
  return true;
}

function hasPopped(a: Action, input: TempoInput): boolean {
  const at = input.lastPopByKind?.[a.kind];
  return at !== undefined && at >= a.createdAt;
}

/** Rule 6: Skip or Esc on an action pushes its kind back 5 minutes. Returns a new map. */
export function pushBack(pushed: Record<string, number> | undefined, kind: ActionKind, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, until] of Object.entries(pushed ?? {})) if (until > now) out[k] = until; // drop expired entries
  out[kind] = now + PUSH_BACK_MS;
  return out;
}

/**
 * Pause kind for a save, from TextDocumentWillSaveEvent.reason (Manual = 1, AfterDelay = 2,
 * FocusOut = 3) and the error count after the save. Only a manual save with 0 errors is a pause.
 */
export function savePause(reason: number, errorCount: number): PauseKind | undefined {
  return reason === 1 && errorCount === 0 ? 'manual-save' : undefined;
}

// ---------------------------------------------------------------- status text

/** Clip to `max` characters (code points) on a word boundary when one is close, with an ellipsis. */
export function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  if (chars.length <= max) return chars.join('');
  if (max <= 1) return chars.slice(0, max).join('');
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  const head = space >= Math.floor(max * 0.6) ? cut.slice(0, space) : cut;
  return head.replace(/[\s·,:;.-]+$/u, '') + '…';
}

function len(s: string): number {
  return [...s].length;
}

/** '$(icon) text', with the text at most 40 characters. The icon may be 'beaker' or '$(beaker)'. */
export function statusText(icon: string, text: string): string {
  const i = icon.startsWith('$(') ? icon : `$(${icon})`;
  return `${i} ${clip(text, STATUS_MAX)}`;
}

/** Fit prefix + variable + suffix into 40 characters, clipping only the variable part. */
function fit(icon: string, prefix: string, variable: string, suffix: string): string {
  const room = STATUS_MAX - len(prefix) - len(suffix);
  return statusText(icon, prefix + clip(variable, Math.max(4, room)) + suffix);
}

function basename(file: string): string {
  return file.split(/[\\/]/).pop() || file;
}

/** Status texts from the spec (each <= 40 characters plus the icon). */
export const status = {
  /** '$(beaker) 3/5 · next: flag takes value' */
  specProgress(green: number, total: number, nextTitle?: string): string {
    if (!nextTitle || green >= total) return statusText('beaker', `${green}/${total} specs green`);
    return fit('beaker', `${green}/${total} · next: `, nextTitle, '');
  },
  /** '$(mortar-board) next spec: dict counting · 60s?' (long form when it fits). */
  jitOffer(pattern: string, specTitle?: string): string {
    const long = specTitle ? `next: ${specTitle} uses ${pattern} · 60s drill?` : '';
    if (long && len(long) <= STATUS_MAX) return statusText('mortar-board', long);
    return fit('mortar-board', 'next spec: ', pattern, ' · 60s?');
  },
  /** '$(lightbulb) hint ready · cli.py:14' */
  hintReady(file: string, line: number): string {
    return fit('lightbulb', 'hint ready · ', basename(file), `:${line}`);
  },
  /** '$(zap) 4 due · 60s warm-up' */
  warmup(due: number, seconds = 60): string {
    return statusText('zap', `${due} due · ${seconds}s warm-up`);
  },
  /** '$(question) predict parse_args (15s)' */
  predictOwn(fnName: string, seconds = 15): string {
    return fit('question', 'predict ', fnName, ` (${seconds}s)`);
  },
  /** '$(sync~spin) designing roadmap · placement 6/12' */
  preparing(what: string, progress?: { label: string; done: number; total: number }): string {
    const tail = progress ? ` · ${progress.label} ${progress.done}/${progress.total}` : '';
    return fit('sync~spin', '', what, tail);
  },
  /** '$(sync~spin) running specs...' */
  runningSpecs(): string {
    return statusText('sync~spin', 'running specs...');
  },
  /** '$(beaker) specs ready (5)' (shown without a pop) */
  specsReady(n: number): string {
    return statusText('beaker', `specs ready (${n})`);
  },
  /** '$(check) slicing: fragile -> solid' (3 s flash) */
  stateChange(concept: string, from: string, to: string): string {
    return fit('check', '', concept, `: ${from.toLowerCase()} -> ${to.toLowerCase()}`);
  },
};

/** setStatusBarMessage flash on a usage-limit error. */
export const LIMIT_FLASH = 'Plan limit: background prep paused 15 min';
export const STATE_FLASH_MS = 3000;

// ---------------------------------------------------------------- tooltip

export interface TooltipInfo {
  taskTitle?: string;
  activeMin?: number;
  estimateMin?: number;
  /** 0..1+ */
  stuckScore?: number;
  progressReason?: string;
  /** describeJobs(stats) from jobs.ts: 'running 2 · queued 1 · 7/20 this hour'. */
  jobs?: string;
  /** Non-guess calibration, 0..1. */
  calibration?: number;
  streak?: number;
  /** deliberate.showTimers: gates the streak line. */
  showTimers: boolean;
  /** The current action's longer description, if any. */
  next?: string;
}

/** Markdown for the tempo item's tooltip (spec V1-4 TOOLTIP). Plain text values are escaped. */
export function tempoTooltip(t: TooltipInfo): string {
  const lines: string[] = [];
  if (t.taskTitle) {
    const time = t.activeMin !== undefined ? ` · ${Math.floor(t.activeMin)}${t.estimateMin ? `/${t.estimateMin}` : ''} min` : '';
    lines.push(`**${mdEscape(t.taskTitle)}**${time}`);
  }
  if (t.next) lines.push(`Next: ${mdEscape(t.next)}`);
  if (t.stuckScore !== undefined) {
    const pct = Math.round(Math.min(1, Math.max(0, t.stuckScore)) * 100);
    lines.push(`Stuck meter ${pct}%${t.progressReason ? ` · last progress: ${mdEscape(t.progressReason)}` : ''}`);
  }
  if (t.jobs) lines.push(`Background: ${mdEscape(t.jobs)}`);
  if (t.calibration !== undefined) lines.push(`Calibration ${Math.round(t.calibration * 100)}%`);
  if (t.showTimers && t.streak) lines.push(`Streak: ${t.streak} correct under par`);
  lines.push('Alt+N does not reach Deliberate while the terminal has focus: click this item instead');
  return lines.join('\n\n');
}

export function mdEscape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, (c) => `\\${c}`);
}
