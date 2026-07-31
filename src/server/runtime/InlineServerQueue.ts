// SPDX-License-Identifier: Apache-2.0
import { logger } from '../../utils/logger.js';
import type {
  ServerJobCounts,
  ServerJobLifecycleCounters,
  ServerJobObservedListener,
} from '../jobs/ServerJobQueue.js';

type InlineJob<TPayload> = { id: string; data: TPayload; attemptsMade: number };
type InlineProcessor<TPayload> = (job: InlineJob<TPayload>) => Promise<unknown>;

// In-process, in-memory queue. Local runtime only (single process, single
// user). No durability: jobs are lost on process death — acceptable because
// generation is best-effort and re-derivable from the raw session.
//
// TWO LANES, STRICT PRIORITY. Live capture (`add`) is the product: an
// observation from the session the user is in right now. Recovery
// (`addRecovery`) is backlog replay — background, best-effort, unbounded in
// time.
//
// They used to share one waiting[] and one worker pool. Once the continuous
// drain loaded a 500-job batch, a brand-new observation queued behind it and
// competed for the same slots; measured on the live install, throughput on the
// user's own work fell from 368/hr to 35/hr while old jobs drained. The drain
// itself was a correct fix for stranding (6,958 jobs sat queued for two weeks);
// putting it in the same lane as foreground work was not.
//
// Recovery now: never runs while live work is pending or in flight, never
// occupies the last slot, and always loses a race to a live job. It still
// drains to completion whenever the system is idle, so yielding does not become
// starvation.
export class InlineServerQueue<TPayload extends object = object> {
  private readonly waiting: InlineJob<TPayload>[] = [];
  /** Backlog lane. Only ever drained when the live lane is completely clear. */
  private readonly waitingRecovery: InlineJob<TPayload>[] = [];
  private active = 0;
  /** How many of `active` are recovery jobs, so live capacity is knowable. */
  private activeRecovery = 0;
  private completed = 0;
  private failed = 0;
  private started = false;
  private closed = false;
  private processor: InlineProcessor<TPayload> | null = null;
  private readonly listeners: ServerJobObservedListener[] = [];
  private readonly counters: ServerJobLifecycleCounters = { stalled: 0, errored: 0 };

  constructor(readonly name: string, private readonly concurrency: number = 1) {}

  async add(jobId: string, payload: TPayload): Promise<void> {
    if (this.closed) throw new Error(`InlineServerQueue ${this.name} is closed`);
    this.waiting.push({ id: jobId, data: payload, attemptsMade: 0 });
    queueMicrotask(() => this.drain());
  }

  /**
   * Enqueue a backlog job. Same processor, strictly lower priority.
   *
   * Separate method rather than a flag on `add` so the choice is explicit at
   * every call site: a caller that does not know it is doing recovery gets
   * foreground priority, which is the safe default.
   */
  async addRecovery(jobId: string, payload: TPayload): Promise<void> {
    if (this.closed) throw new Error(`InlineServerQueue ${this.name} is closed`);
    this.waitingRecovery.push({ id: jobId, data: payload, attemptsMade: 0 });
    queueMicrotask(() => this.drain());
  }

  /**
   * Slots recovery may use.
   *
   * One below the pool so a live job never has to wait for a recovery job to
   * finish — with concurrency 4 recovery gets 3. At concurrency 1 the reserve
   * would leave 0 and the backlog could never clear, so the floor is 1: a
   * single-slot install still recovers, it just interleaves.
   */
  private recoveryBudget(): number {
    return Math.max(1, this.concurrency - 1);
  }

  start(processor: InlineProcessor<TPayload>): void {
    if (this.started) throw new Error(`InlineServerQueue ${this.name} is already started`);
    this.processor = processor;
    this.started = true;
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    if (!this.processor || this.closed) return;

    // LIVE LANE FIRST, and to exhaustion. A live job may use any slot, including
    // one a recovery job would otherwise have taken.
    while (this.active < this.concurrency && this.waiting.length > 0) {
      this.run(this.waiting.shift()!, false);
    }

    // RECOVERY LANE: only when the foreground is completely clear. `active`
    // counts live jobs still running (activeRecovery are ours), so a recovery
    // job cannot start while the user's work is mid-flight — that is what turned
    // a backlog replay into a latency problem for the current session.
    const liveActive = this.active - this.activeRecovery;
    if (this.waiting.length > 0 || liveActive > 0) return;

    const budget = this.recoveryBudget();
    while (
      this.active < this.concurrency
      && this.activeRecovery < budget
      && this.waitingRecovery.length > 0
    ) {
      this.run(this.waitingRecovery.shift()!, true);
    }
  }

  /** Execute one job, tracking which lane it came from. */
  private run(job: InlineJob<TPayload>, isRecovery: boolean): void {
    this.active += 1;
    if (isRecovery) this.activeRecovery += 1;
    const startedAt = Date.now();
    void this.processor!(job)
      .then((returnvalue) => {
        this.completed += 1;
        const durationMs = Date.now() - startedAt;
        for (const l of this.listeners) {
          try { l.onCompleted?.(job.id, durationMs, returnvalue); } catch { /* isolate */ }
        }
      })
      .catch((error: unknown) => {
        this.failed += 1;
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn('QUEUE', `[inline] job=${job.id} failed`, { queue: this.name, reason });
        for (const l of this.listeners) {
          try { l.onFailed?.(job.id, job.attemptsMade, reason); } catch { /* isolate */ }
        }
      })
      .finally(() => {
        this.active -= 1;
        if (isRecovery) this.activeRecovery -= 1;
        // Re-drain on ANY completion, not only when the live lane is non-empty:
        // a finishing live job is exactly the moment recovery becomes eligible,
        // and the old condition would have left the backlog parked forever.
        if (this.waiting.length > 0 || this.waitingRecovery.length > 0) {
          queueMicrotask(() => this.drain());
        }
      });
  }

  /**
   * Waiting depth, synchronously.
   *
   * The continuous drain checks this on every iteration to decide whether to
   * refill, and must not await — getCounts() is async and would make the hot
   * loop needlessly asynchronous. Without a real reading here the drain would
   * always see 0 and over-feed a slow local model, which is the original
   * stranding bug at a larger scale.
   */
  getWaitingCount(): number {
    return this.waiting.length;
  }

  /** Backlog depth, separate from live. The continuous drain reads this to
   *  decide whether it still has work, without conflating it with the user's. */
  getRecoveryWaitingCount(): number {
    return this.waitingRecovery.length;
  }

  async getCounts(): Promise<ServerJobCounts> {
    return {
      // `waiting` stays LIVE-only so existing readers keep their meaning: a
      // blended number was part of the problem — 500 "queued" gave no way to
      // tell the user's own work from two-week-old backlog.
      waiting: this.waiting.length,
      waitingRecovery: this.waitingRecovery.length,
      active: this.active,
      activeRecovery: this.activeRecovery,
      delayed: 0,
      failed: this.failed,
      completed: this.completed,
    };
  }

  observe(listener: ServerJobObservedListener): void { this.listeners.push(listener); }
  getLifecycleCounters(): ServerJobLifecycleCounters { return { ...this.counters }; }
  isStarted(): boolean { return this.started; }

  async close(): Promise<void> {
    this.closed = true;
    this.waiting.length = 0;
    this.processor = null;
    this.started = false;
  }
}
