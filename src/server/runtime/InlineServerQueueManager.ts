// SPDX-License-Identifier: Apache-2.0
import { InlineServerQueue } from './InlineServerQueue.js';
import {
  SERVER_JOB_QUEUE_NAMES,
  type ServerGenerationJobKind,
  type ServerGenerationJobPayload,
} from '../jobs/types.js';
import type {
  ServerBoundaryHealth,
  ServerGenerationQueueManager,
  ServerQueueLaneMetric,
} from './types.js';

const QUEUE_KINDS: ServerGenerationJobKind[] = ['event', 'summary'];

export class InlineServerQueueManager implements ServerGenerationQueueManager {
  readonly kind = 'queue-manager' as const;
  private readonly queues: Map<ServerGenerationJobKind, InlineServerQueue<ServerGenerationJobPayload>>;
  private closed = false;

  constructor() {
    this.queues = new Map();
    for (const k of QUEUE_KINDS) {
      this.queues.set(k, new InlineServerQueue<ServerGenerationJobPayload>(SERVER_JOB_QUEUE_NAMES[k]));
    }
  }

  getQueue(kind: ServerGenerationJobKind): InlineServerQueue<ServerGenerationJobPayload> {
    const q = this.queues.get(kind);
    if (!q) throw new Error(`unknown server generation job kind: ${kind}`);
    return q;
  }

  // test alias to keep the test explicit; getQueue already returns the queue.
  getQueueForTest(kind: ServerGenerationJobKind): InlineServerQueue<ServerGenerationJobPayload> {
    return this.getQueue(kind);
  }

  start(
    kind: ServerGenerationJobKind,
    processor: (job: { id: string; data: ServerGenerationJobPayload; attemptsMade: number }) => Promise<unknown>,
  ): void {
    this.getQueue(kind).start(processor);
  }

  getHealth(): ServerBoundaryHealth {
    if (this.closed) return { status: 'errored', reason: 'queue-manager closed' };
    return {
      status: 'active',
      reason: 'in-process inline queue (local runtime)',
      details: {
        engine: 'inline',
        mode: 'in-process',
        lanes: QUEUE_KINDS.map((k) => ({ kind: k, name: SERVER_JOB_QUEUE_NAMES[k] })),
      },
    };
  }

  async getLaneMetrics(): Promise<ServerQueueLaneMetric[]> {
    const out: ServerQueueLaneMetric[] = [];
    for (const kind of QUEUE_KINDS) {
      const q = this.queues.get(kind);
      if (!q) continue;
      const c = await q.getCounts();
      out.push({
        kind,
        name: SERVER_JOB_QUEUE_NAMES[kind],
        waiting: c.waiting,
        active: c.active,
        completed: c.completed,
        failed: c.failed,
        delayed: c.delayed,
        stalled: 0,
        unavailable: false,
      });
    }
    return out;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const q of this.queues.values()) await q.close();
  }
}
