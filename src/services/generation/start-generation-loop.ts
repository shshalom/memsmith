// SPDX-License-Identifier: Apache-2.0
//
// Task 6 — production wiring for the laptop-side generation loop in team
// mode. `runRuntimeForeground` (ServerService.ts) used to call
// `startServer(port, host)` for every non-local runtime, which requires
// Postgres + Redis (create-server-service.ts's createServerService hard-
// requires MEMSMITH_SERVER_DATABASE_URL / MEMSMITH_REDIS_URL) and therefore
// fails on a laptop that never runs those. Team mode now starts THIS loop
// instead: it drains Task 1's local queue (events awaiting generation)
// through Task 4's pool-free generateOne, and posts finished observations
// to the server via ServerClient.addObservation.
//
// This module composes the real dependencies drainGenerationQueue needs
// (local-generation-loop.ts is itself dependency-injected and has no
// filesystem/network/provider code of its own) and repeats the drain on an
// interval for as long as the process runs — mirroring how local-runtime.ts
// composes startLocalRuntime's real dependencies for the local-mode boot
// path.
//
// Never throws out of the loop: an uncaught rejection here would crash the
// whole foreground process over what is, worst case, a missed generation
// pass — the queue is durable and simply retries next tick.

import { logger } from '../../utils/logger.js';

const DEFAULT_INTERVAL_MS = 30_000;

export interface StartGenerationLoopOptions {
  /** Test seam / override. Defaults to MEMSMITH_GENERATION_LOOP_INTERVAL_MS
   *  or DEFAULT_INTERVAL_MS. */
  intervalMs?: number;
  /** Test seam: run exactly one pass and return instead of looping forever.
   *  Production omits this. */
  once?: boolean;
}

function resolveIntervalMs(): number {
  const raw = process.env.MEMSMITH_GENERATION_LOOP_INTERVAL_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

/**
 * Start the laptop-side generation loop and keep it running for the
 * lifetime of the foreground process (unless `options.once` is set).
 *
 * Each pass:
 *   1. Resolves the server runtime context (URL/key/projectId) the same way
 *      the observation hook does — via resolveRuntimeContext — so the loop
 *      posts to the same server/project the events were recorded against.
 *   2. Resolves a generation provider from settings/env (same resolution
 *      order create-server-service.ts uses for the server runtime: env >
 *      settings.json > 'ollama' default).
 *   3. Drains the queue via drainGenerationQueue, generating with
 *      generateOne and posting with ServerClient.addObservation.
 *
 * If no server context or no provider can be resolved, the pass logs and
 * skips — the queue is untouched and retried next interval, never dropped.
 */
export async function startGenerationLoop(options: StartGenerationLoopOptions = {}): Promise<void> {
  const intervalMs = options.intervalMs ?? resolveIntervalMs();

  const runPass = async (): Promise<void> => {
    try {
      await runOneDrainPass();
    } catch (error) {
      logger.warn(
        'SYSTEM',
        'generation loop: drain pass failed (non-fatal; retrying next interval)',
        {},
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };

  await runPass();
  if (options.once) return;

  // Foreground process lifetime: run forever on an interval. There is no
  // shutdown hook here because runRuntimeForeground's callers (start/daemon)
  // already install SIGTERM/SIGINT handlers for the process as a whole;
  // this loop simply stops when the process does.
  await new Promise<void>(() => {
    setInterval(() => {
      void runPass();
    }, intervalMs);
  });
}

async function runOneDrainPass(): Promise<void> {
  const { resolveRuntimeContext } = await import('../hooks/runtime-selector.js');
  const { readProjectMarker } = await import('../identity/project-identity.js');
  const { readGenerationQueue, writeGenerationQueue, clearGenerationQueue } = await import('./local-queue.js');
  const { drainGenerationQueue } = await import('./local-generation-loop.js');
  const { generateOneWithOutcome } = await import('./generate-one.js');

  const cwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
  const runtime = resolveRuntimeContext(cwd);
  if (runtime.runtime !== 'server') {
    // No reachable server context yet (e.g. cold boot before identity is
    // written). Nothing to drain against; try again next interval.
    return;
  }

  const marker = readProjectMarker(cwd);
  const teamId = marker?.teamId ?? '';
  const projectId = runtime.projectId;

  const provider = await resolveLaptopGenerationProvider();
  if (!provider) {
    logger.warn('SYSTEM', 'generation loop: no generation provider configured; skipping pass', {});
    return;
  }

  const result = await drainGenerationQueue({
    read: () => readGenerationQueue(),
    clear: () => clearGenerationQueue(),
    writeKept: (kept) => writeGenerationQueue(kept),
    // Use the outcome-aware variant so a deliberate `<skip_summary />` is
    // CONSUMED while an empty/garbled response is RETRIED. The bare-array
    // form cannot tell those apart, and conflating them either loses work or
    // loops forever.
    generate: (event) => generateOneWithOutcome({ provider, event, projectId, teamId }),
    // A fault — keep it queued, but say so. An empty response on every pass
    // means something real is wrong (wrong model, unreachable endpoint) and
    // would otherwise look identical to an idle queue.
    onEmptyGeneration: (event) => {
      logger.warn('SYSTEM', 'generation returned nothing usable; event kept queued for retry', {
        projectId: (event as { projectId?: string })?.projectId ?? projectId,
      });
    },
    // A verdict, not a fault — debug level, and the event is consumed.
    onSkippedGeneration: (event) => {
      logger.debug('SYSTEM', 'generation skipped this event as not worth recording', {
        projectId: (event as { projectId?: string })?.projectId ?? projectId,
      });
    },
    post: async (observation) => {
      await runtime.client.addObservation({
        projectId: observation.projectId ?? projectId,
        content: observation.content,
        obsType: observation.obsType,
        metadata: observation.metadata,
      });
    },
  });

  if (result.generated > 0 || result.failed > 0) {
    logger.debug('SYSTEM', 'generation loop: drain pass complete', result);
  }
}

/**
 * Resolve a generation provider the same way the server runtime does
 * (create-server-service.ts's buildServerGenerationProviderFromEnv):
 * env > settings.json > the registry default ('ollama'). Duplicated rather
 * than imported because that function is private to create-server-service.ts
 * and importing it would pull in the server's Postgres/Redis-heavy module
 * graph — exactly what this laptop-side loop must avoid.
 */
async function resolveLaptopGenerationProvider() {
  const { loadFromFileOnce } = await import('../../shared/hook-settings.js');
  const { resolveGenerationProviderName } = await import('../../server/runtime/resolve-generation-provider.js');
  const { instantiateServerGenerationProvider } = await import('../../server/runtime/create-server-service.js');

  let fileSettings: Record<string, unknown> = {};
  try {
    fileSettings = loadFromFileOnce() as unknown as Record<string, unknown>;
  } catch {
    // Defaults still apply if settings are unreadable.
  }

  const providerName = resolveGenerationProviderName(process.env, fileSettings);
  if (!providerName) return null;

  const model = providerName === 'ollama'
    ? (process.env.MEMSMITH_OLLAMA_MODEL ?? asNonEmptyString(fileSettings.MEMSMITH_OLLAMA_MODEL) ?? asNonEmptyString(fileSettings.MEMSMITH_SERVER_MODEL))
    : (process.env.MEMSMITH_SERVER_MODEL ?? asNonEmptyString(fileSettings.MEMSMITH_SERVER_MODEL));

  try {
    return instantiateServerGenerationProvider(providerName, model);
  } catch (error) {
    logger.warn(
      'SYSTEM',
      'generation loop: failed to construct generation provider; skipping pass',
      { provider: providerName },
      error instanceof Error ? error : new Error(String(error)),
    );
    return null;
  }
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
