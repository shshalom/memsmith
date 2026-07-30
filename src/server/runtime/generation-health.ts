// SPDX-License-Identifier: Apache-2.0
//
// Is memory actually being distilled right now?
//
// Generation silently stopped for ~15 hours (ollama died on a reboot and nothing
// restarted it) while 6,958 jobs piled up spanning two weeks. Nothing reported
// it. /v1/info reported queue plumbing — lane counts, boundary health — and
// reported it as FINE, because the queue itself was fine. The machinery looked
// wired up the entire time it was broken.
//
// So this asks the only question that matters, and answers it from OUTCOMES
// rather than from whether the wiring looks present:
//   - is work waiting?
//   - has anything actually completed recently?
//   - is the provider reachable at all?
//
// A memory product that silently stops remembering is its worst failure mode.

/**
 * How long a backlog may sit with no completion before it is called stalled.
 *
 * Generous: a real observation takes 20-60s on a local 14B model, and a slow
 * machine must not be reported as broken. Crying wolf would train the user to
 * ignore the indicator, which is how you end up back at fifteen silent hours.
 */
export const STALL_THRESHOLD_MINUTES = 15;

export type GenerationHealthStatus = 'healthy' | 'idle' | 'stalled' | 'unknown';

export interface GenerationHealth {
  status: GenerationHealthStatus;
  queued: number;
  processing: number;
  completedLastHour: number;
  lastCompletedMinutesAgo: number | null;
  providerReachable: boolean | null;
  /** Human-readable reasons, empty when nothing is wrong. */
  problems: string[];
}

export interface GenerationHealthDeps {
  now: () => Date;
  counts: () => Promise<{ queued: number; processing: number; completedLastHour: number }>;
  lastCompletedAt: () => Promise<Date | null>;
  providerReachable: () => Promise<boolean>;
}

const UNKNOWN: GenerationHealth = {
  status: 'unknown',
  queued: 0,
  processing: 0,
  completedLastHour: 0,
  lastCompletedMinutesAgo: null,
  providerReachable: null,
  problems: ['could not determine generation health'],
};

export async function assessGenerationHealth(
  deps: GenerationHealthDeps,
): Promise<GenerationHealth> {
  let counts: { queued: number; processing: number; completedLastHour: number };
  try {
    counts = await deps.counts();
  } catch {
    // Never claim health that has not been verified — reporting 'healthy' when
    // the probe failed is the exact failure being fixed here.
    return UNKNOWN;
  }

  let lastCompletedMinutesAgo: number | null = null;
  try {
    const last = await deps.lastCompletedAt();
    if (last) {
      lastCompletedMinutesAgo = Math.round((deps.now().getTime() - last.getTime()) / 60_000);
    }
  } catch {
    lastCompletedMinutesAgo = null;
  }

  let providerReachable: boolean | null = null;
  try {
    providerReachable = await deps.providerReachable();
  } catch {
    providerReachable = null;
  }

  const problems: string[] = [];

  // An unreachable provider is a failure NOW, even with an empty backlog —
  // waiting for one to build just delays the discovery.
  if (providerReachable === false) {
    problems.push('generation provider is unreachable — no observations can be produced');
  }

  const hasWork = counts.queued > 0 || counts.processing > 0;
  const stale = lastCompletedMinutesAgo === null
    ? true
    : lastCompletedMinutesAgo > STALL_THRESHOLD_MINUTES;

  // Work waiting + nothing completing = stalled. Either half alone is fine: a
  // moving backlog is merely slow, and an empty queue is merely quiet.
  if (hasWork && stale && counts.completedLastHour === 0) {
    problems.push(
      lastCompletedMinutesAgo === null
        ? `${counts.queued} jobs queued and no observation has ever completed`
        : `${counts.queued} jobs queued and nothing completed in ${lastCompletedMinutesAgo} minutes`,
    );
  }

  let status: GenerationHealthStatus;
  if (problems.length > 0) status = 'stalled';
  else if (!hasWork && counts.completedLastHour === 0) status = 'idle';
  else status = 'healthy';

  return {
    status,
    queued: counts.queued,
    processing: counts.processing,
    completedLastHour: counts.completedLastHour,
    lastCompletedMinutesAgo,
    providerReachable,
    problems,
  };
}
