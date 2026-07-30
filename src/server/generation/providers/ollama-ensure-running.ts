// SPDX-License-Identifier: Apache-2.0
//
// Make sure ollama is running, at the moment a job needs it.
//
// Ollama died on a machine reboot and nothing restarted it. Generation stopped
// for ~15 hours while 6,958 jobs piled up, and nothing reported it. The
// generation health check catches that within 15 minutes — but detection is not
// recovery, and 15 minutes of silence is still 15 minutes.
//
// Checking at the POINT OF USE is strictly better: the check runs exactly when a
// job needs ollama, so a dead provider is noticed immediately, restarted, and the
// work resumes. No timer to tune, no polling on an idle machine, and no window
// where the outage is real but unreported.
//
// Two hazards this must not create, either of which is worse than the original
// bug:
//   - STAMPEDE: with concurrency 4, four jobs can each try to start ollama at
//     once. Single-flight, or you get four servers fighting over a port.
//   - HOT LOOP: if ollama cannot start at all, retrying on every job turns one
//     broken install into a spawn loop. Back off, and fail cleanly.

/** How long to wait after a failed start before trying to spawn again. */
export const RESTART_BACKOFF_MS = 60_000;

export interface EnsureRunningState {
  /** In-flight start, shared so concurrent callers await the same attempt. */
  starting?: Promise<boolean>;
  /** When the last spawn was attempted, for backoff. */
  lastAttemptAt?: number;
}

export interface EnsureRunningDeps {
  /** Cheap liveness probe (GET /api/tags). */
  probe: () => Promise<boolean>;
  /** Start the ollama server and resolve once it is (probably) listening. */
  spawn: () => Promise<void>;
  now: () => number;
  /** Defaults true; set false to report-only and never spawn. */
  autostart?: boolean;
  /** Module-level by default; injectable so tests are isolated. */
  state?: EnsureRunningState;
}

const sharedState: EnsureRunningState = {};

/**
 * Returns true when ollama is reachable (already, or after being started).
 *
 * Never throws — this sits in the hot path of every generation call. A false
 * return lets the caller fail the job as transient so it retries, rather than
 * losing the work.
 */
export async function ensureOllamaRunning(deps: EnsureRunningDeps): Promise<boolean> {
  const state = deps.state ?? sharedState;

  try {
    if (await deps.probe()) return true;
  } catch {
    // A probe that throws is the same as down.
  }

  // Report-only mode: spawning a process is a real side effect, so it stays
  // opt-outable.
  if (deps.autostart === false) return false;

  // Single-flight: concurrent callers await the SAME start attempt.
  if (state.starting) return state.starting;

  // Backoff: do not respawn on every job when ollama cannot start at all.
  const last = state.lastAttemptAt;
  if (last !== undefined && deps.now() - last < RESTART_BACKOFF_MS) return false;

  state.lastAttemptAt = deps.now();
  const attempt = (async () => {
    try {
      await deps.spawn();
    } catch {
      return false;
    }
    try {
      return await deps.probe();
    } catch {
      return false;
    }
  })();

  state.starting = attempt;
  try {
    return await attempt;
  } finally {
    state.starting = undefined;
  }
}

/**
 * Whether a down ollama should be started automatically.
 *
 * Defaults ON: ollama is a local, keyless provider whose only failure mode here
 * is "not running", and the whole point is that a user should never have to
 * notice. Off is available for anyone managing the process themselves.
 */
export function resolveAutostartEnabled(env: Record<string, string | undefined>): boolean {
  const raw = (env.MEMSMITH_OLLAMA_AUTOSTART ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  return true;
}
