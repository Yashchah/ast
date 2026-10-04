import { Emitter } from './jobs';

/**
 * One modal flow at a time (spec V1-1). Modal flows: the pad (placement, atom, sprint, skeleton),
 * the gate QuickPicks, and the own-predict and what-if InputBoxes. A flow that finds the lock held
 * enqueues a tempo action instead of opening. Pure: no vscode import.
 */
export type LockKind =
  | 'placement' | 'atom' | 'sprint' | 'warmup' | 'skeleton' | 'gate' | 'own-predict' | 'what-if'
  | (string & {});

/** 'esc' = aborted through abortActive(): record it as Esc (neutral, no penalty). */
export type ReleaseReason = 'done' | 'esc';

export interface LockReleased {
  kind: LockKind;
  reason: ReleaseReason;
  /** How long the flow held the lock. */
  ms: number;
}

interface Holder {
  kind: LockKind;
  token: number;
  since: number;
  onAbort?: (reason: 'esc') => void;
  aborting: boolean;
}

export class InteractionLock {
  private holder: Holder | undefined;
  private tokens = 0;
  private readonly releaseEmitter = new Emitter<LockReleased>();
  /** Fires after every release, so a queued blocking action can open. */
  readonly onDidRelease = this.releaseEmitter.event;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Take the lock for a modal flow. Returns its release function, or undefined when another
   * flow holds it. `onAbort` is how abortActive() closes this flow (pad tab, QuickPick, InputBox).
   * The release function is idempotent and never releases a later holder's lock.
   */
  acquire(kind: LockKind, onAbort?: (reason: 'esc') => void): (() => void) | undefined {
    if (this.holder) return undefined;
    const token = ++this.tokens;
    this.holder = { kind, token, since: this.now(), onAbort, aborting: false };
    return () => void this.release(token, 'done');
  }

  /** Kind of the flow holding the lock, if any. */
  get active(): LockKind | undefined {
    return this.holder?.kind;
  }

  get held(): boolean {
    return this.holder !== undefined;
  }

  /**
   * Abort the active flow (startTask, newProject, resetProfile do this first). The flow's abort
   * callback runs before the lock is released, so its UI is closed before anything else can open.
   * Returns the release record (reason 'esc'), or undefined when nothing was active.
   */
  abortActive(): LockReleased | undefined {
    const h = this.holder;
    if (!h) return undefined;
    h.aborting = true;
    try {
      h.onAbort?.('esc');
    } catch (err) {
      console.error('[deliberate]', err);
    }
    // The callback may already have released through its own release function (reported as Esc too).
    return this.release(h.token, 'esc') ?? { kind: h.kind, reason: 'esc', ms: this.now() - h.since };
  }

  dispose(): void {
    this.releaseEmitter.dispose();
  }

  private release(token: number, reason: ReleaseReason): LockReleased | undefined {
    const h = this.holder;
    if (!h || h.token !== token) return undefined; // stale lease
    this.holder = undefined;
    const e: LockReleased = { kind: h.kind, reason: h.aborting ? 'esc' : reason, ms: this.now() - h.since };
    this.releaseEmitter.fire(e);
    return e;
  }
}
