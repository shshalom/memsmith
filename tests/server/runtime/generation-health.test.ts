// SPDX-License-Identifier: Apache-2.0
//
// THE FAILURE THIS EXISTS TO CATCH: generation silently stopped for ~15 hours
// (ollama died on a reboot and nothing restarted it) while 6,958 jobs piled up
// spanning two weeks. Nothing anywhere reported it. The user only discovered it
// because I happened to query a table by hand.
//
// /v1/info already reported queue PLUMBING (lane counts, boundary health) — and
// reported it as fine, because the queue itself was fine. What nothing answered
// was the only question that matters: "is memory actually being distilled right
// now?" A memory product that silently stops remembering is its worst failure
// mode, so that question needs a real answer.
//
// The status is deliberately computed from OUTCOMES (is the backlog growing? is
// the provider reachable? when did a job last complete?) rather than from whether
// the machinery looks wired up — the machinery looked wired up the entire time it
// was broken.
import { describe, it, expect } from 'bun:test';
import { assessGenerationHealth, STALL_THRESHOLD_MINUTES } from '../../../src/server/runtime/generation-health.js';

const NOW = new Date('2026-07-30T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('assessGenerationHealth', () => {
  it('reports healthy when jobs are completing and the provider is reachable', async () => {
    const h = await assessGenerationHealth({
      now: () => NOW,
      counts: async () => ({ queued: 3, processing: 1, completedLastHour: 40 }),
      lastCompletedAt: async () => minsAgo(1),
      providerReachable: async () => true,
    });
    expect(h.status).toBe('healthy');
    expect(h.problems).toEqual([]);
  });

  it('reports STALLED when work is queued but nothing has completed recently', async () => {
    // The exact 15-hour shape: a backlog, and no completion for hours.
    const h = await assessGenerationHealth({
      now: () => NOW,
      counts: async () => ({ queued: 6958, processing: 0, completedLastHour: 0 }),
      lastCompletedAt: async () => minsAgo(900),
      providerReachable: async () => true,
    });
    expect(h.status).toBe('stalled');
    expect(h.problems.join(' ')).toMatch(/queued/i);
  });

  it('reports STALLED when the provider is unreachable, even with an empty backlog', async () => {
    // An unreachable provider is a failure NOW even if nothing is waiting yet —
    // reporting healthy would just delay the discovery until a backlog builds.
    const h = await assessGenerationHealth({
      now: () => NOW,
      counts: async () => ({ queued: 0, processing: 0, completedLastHour: 0 }),
      lastCompletedAt: async () => minsAgo(2),
      providerReachable: async () => false,
    });
    expect(h.status).toBe('stalled');
    expect(h.problems.join(' ')).toMatch(/provider/i);
  });

  it('is NOT stalled when idle with nothing to do', async () => {
    // No queue and no recent completions is a quiet machine, not a broken one.
    // Crying wolf here would train the user to ignore the indicator.
    const h = await assessGenerationHealth({
      now: () => NOW,
      counts: async () => ({ queued: 0, processing: 0, completedLastHour: 0 }),
      lastCompletedAt: async () => minsAgo(5000),
      providerReachable: async () => true,
    });
    expect(h.status).toBe('idle');
    expect(h.problems).toEqual([]);
  });

  it('is NOT stalled when a backlog is actively draining', async () => {
    // A large queue is fine so long as it is moving — that is a slow machine,
    // not a stalled one.
    const h = await assessGenerationHealth({
      now: () => NOW,
      counts: async () => ({ queued: 6000, processing: 4, completedLastHour: 180 }),
      lastCompletedAt: async () => minsAgo(1),
      providerReachable: async () => true,
    });
    expect(h.status).toBe('healthy');
  });

  it('uses the documented stall threshold', async () => {
    const justUnder = await assessGenerationHealth({
      now: () => NOW,
      counts: async () => ({ queued: 10, processing: 0, completedLastHour: 1 }),
      lastCompletedAt: async () => minsAgo(STALL_THRESHOLD_MINUTES - 1),
      providerReachable: async () => true,
    });
    expect(justUnder.status).toBe('healthy');

    const justOver = await assessGenerationHealth({
      now: () => NOW,
      counts: async () => ({ queued: 10, processing: 0, completedLastHour: 0 }),
      lastCompletedAt: async () => minsAgo(STALL_THRESHOLD_MINUTES + 1),
      providerReachable: async () => true,
    });
    expect(justOver.status).toBe('stalled');
  });

  it('surfaces the backlog size so the user knows the scale', async () => {
    const h = await assessGenerationHealth({
      now: () => NOW,
      counts: async () => ({ queued: 6958, processing: 0, completedLastHour: 0 }),
      lastCompletedAt: async () => minsAgo(900),
      providerReachable: async () => true,
    });
    expect(h.queued).toBe(6958);
    expect(h.lastCompletedMinutesAgo).toBe(900);
  });

  it('reports unknown rather than healthy when it cannot tell', async () => {
    // Never claim health you have not verified — that is the failure being fixed.
    const h = await assessGenerationHealth({
      now: () => NOW,
      counts: async () => { throw new Error('pg down'); },
      lastCompletedAt: async () => null,
      providerReachable: async () => true,
    });
    expect(h.status).toBe('unknown');
  });

  it('never throws, whatever the probes do', async () => {
    const h = await assessGenerationHealth({
      now: () => NOW,
      counts: async () => { throw new Error('a'); },
      lastCompletedAt: async () => { throw new Error('b'); },
      providerReachable: async () => { throw new Error('c'); },
    });
    expect(h.status).toBe('unknown');
  });

  it('treats a never-completed install with a backlog as stalled', async () => {
    // Fresh install where generation never worked once: lastCompletedAt is null
    // and work is waiting. That is broken, not idle.
    const h = await assessGenerationHealth({
      now: () => NOW,
      counts: async () => ({ queued: 27, processing: 0, completedLastHour: 0 }),
      lastCompletedAt: async () => null,
      providerReachable: async () => true,
    });
    expect(h.status).toBe('stalled');
  });
});

// A team server under local generation (shipped 2026-08-12) has generation
// DISABLED on purpose: the laptops generate and POST finished observations, and
// the server only stores and embeds. It therefore has no reachable provider —
// which the original logic reported as `stalled` with "generation provider is
// unreachable".
//
// That is a healthy configuration described as a fault. Reporting a correct
// steady state as broken trains operators to ignore the indicator, which is the
// EXACT failure generation-health.ts was built to prevent (its header documents
// 15 silent hours and 6,958 piled-up jobs). Observed live on the deployed AWS
// server, which reported `stalled` while working perfectly.
describe('assessGenerationHealth — delegated generation is not a fault', () => {
  const base = {
    now: () => new Date('2026-08-13T00:00:00Z'),
    counts: async () => ({ queued: 0, processing: 0, completedLastHour: 0 }),
    lastCompletedAt: async () => null,
    providerReachable: async () => false,
  };

  it('reports `delegated`, not `stalled`, when generation is delegated', async () => {
    const h = await assessGenerationHealth({ ...base, generationDelegated: true } as never);
    expect(h.status).toBe('delegated');
    expect(h.problems).toEqual([]);
  });

  it('still reports `stalled` when NOT delegated (the original 15-hour case)', async () => {
    const h = await assessGenerationHealth(base as never);
    expect(h.status).toBe('stalled');
    expect(h.problems.join(' ')).toContain('unreachable');
  });

  it('a delegated server with a real backlog is still NOT stalled', async () => {
    // Queued rows on a delegated server are not evidence of a fault: nothing
    // server-side is meant to drain them.
    const h = await assessGenerationHealth({
      ...base,
      counts: async () => ({ queued: 42, processing: 0, completedLastHour: 0 }),
      generationDelegated: true,
    } as never);
    expect(h.status).toBe('delegated');
    expect(h.problems).toEqual([]);
  });
});
