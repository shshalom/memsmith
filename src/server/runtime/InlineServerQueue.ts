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
export class InlineServerQueue<TPayload extends object = object> {
  private readonly waiting: InlineJob<TPayload>[] = [];
  private active = 0;
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

  start(processor: InlineProcessor<TPayload>): void {
    if (this.started) throw new Error(`InlineServerQueue ${this.name} is already started`);
    this.processor = processor;
    this.started = true;
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    if (!this.processor || this.closed) return;
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      this.active += 1;
      const startedAt = Date.now();
      void this.processor(job)
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
          if (this.waiting.length > 0) queueMicrotask(() => this.drain());
        });
    }
  }

  async getCounts(): Promise<ServerJobCounts> {
    return { waiting: this.waiting.length, active: this.active, delayed: 0, failed: this.failed, completed: this.completed };
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
