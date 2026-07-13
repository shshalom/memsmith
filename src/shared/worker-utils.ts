import path from "path";
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { SettingsDefaultsManager, type SettingsDefaults } from "./SettingsDefaultsManager.js";
import { DATA_DIR } from "./paths.js";
import { loadFromFileOnce } from "./hook-settings.js";
import { emitBlockingError } from "./hook-io.js";
import { captureCliEvent } from "../services/telemetry/cli-telemetry.js";

// Worker retirement (dead-route sweep) — the worker HTTP/spawn/lifecycle half of
// this module (workerHttpRequest, buildWorkerUrl, ensureWorkerRunning + all its
// health/readiness/recycle/spawn helpers, executeWithWorkerFallback + the
// WorkerFallback brand, resolveWorkerScriptPath) was deleted once every consumer
// was repointed off the deleted worker `/api/*` routes onto the runtime-selector
// + ServerClient `/v1/*` path. The orphaned `worker-spawn-gate.ts` was deleted
// with it (its only importer was ensureWorkerRunning). What remains here is the
// still-live surface:
//   - fetchWithTimeout        — the transport primitive ServerClient uses.
//   - getWorkerPort/getWorkerHost/getWorkerApiRequestTimeoutMs/clearPortCache
//     — the port/host settings resolution still used for display URLs (context
//       + user-message hooks) and the installers.
//   - recordWorkerUnreachable/setActiveHookType/getActiveHookType — the
//       fail-loud telemetry helpers used by hook-command.ts.

const API_REQUEST_TIMEOUT_BOUNDS = { min: 500, max: 300000 } as const;

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  try {
    // AbortSignal.timeout (Node 18+) replaces the manual setTimeout/clearTimeout
    // race. On expiry it aborts with a TimeoutError DOMException.
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err: unknown) {
    // Preserve the historical timeout-error message ("...timed out...") that
    // callers match on (server-client.ts) — the DOMException text is
    // runtime-dependent, so normalize it here.
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

let cachedPort: number | null = null;
let cachedHost: string | null = null;
let cachedSettings: SettingsDefaults | null = null;
let cachedApiRequestTimeoutMs: number | null = null;

function getWorkerSettingsPath(): string {
  return path.join(SettingsDefaultsManager.get('MEMSMITH_DATA_DIR'), 'settings.json');
}

function getWorkerSettings(): SettingsDefaults {
  if (cachedSettings !== null) {
    return cachedSettings;
  }

  cachedSettings = SettingsDefaultsManager.loadFromFile(getWorkerSettingsPath());
  return cachedSettings;
}

function parseBoundedTimeout(
  rawValue: string | undefined,
  bounds: { min: number; max: number }
): number | null {
  if (!rawValue) return null;
  const parsed = parseInt(rawValue, 10);
  if (Number.isFinite(parsed) && parsed >= bounds.min && parsed <= bounds.max) {
    return parsed;
  }
  return null;
}

function readSettingsBackedTimeout(
  settingName: keyof SettingsDefaults,
  defaultValue: number,
  bounds: { min: number; max: number }
): number {
  const envVal = process.env[settingName];
  if (envVal !== undefined) {
    const parsed = parseBoundedTimeout(envVal, bounds);
    if (parsed !== null) {
      return parsed;
    }
    logger.warn('SYSTEM', `Invalid ${settingName}, using default`, {
      value: envVal, min: bounds.min, max: bounds.max
    });
    return defaultValue;
  }

  const settingsValue = getWorkerSettings()[settingName];
  const parsed = parseBoundedTimeout(settingsValue, bounds);
  if (parsed !== null) {
    return parsed;
  }

  logger.warn('SYSTEM', `Invalid ${settingName} in settings.json, using default`, {
    value: settingsValue, min: bounds.min, max: bounds.max
  });
  return defaultValue;
}

export function getWorkerPort(): number {
  if (cachedPort !== null) {
    return cachedPort;
  }

  const settings = getWorkerSettings();
  cachedPort = parseInt(settings.MEMSMITH_WORKER_PORT, 10);
  return cachedPort;
}

export function getWorkerHost(): string {
  if (cachedHost !== null) {
    return cachedHost;
  }

  const settings = getWorkerSettings();
  cachedHost = settings.MEMSMITH_WORKER_HOST;
  return cachedHost;
}

export function getWorkerApiRequestTimeoutMs(): number {
  if (cachedApiRequestTimeoutMs !== null) {
    return cachedApiRequestTimeoutMs;
  }

  cachedApiRequestTimeoutMs = readSettingsBackedTimeout(
    'MEMSMITH_API_TIMEOUT_MS',
    getTimeout(HOOK_TIMEOUTS.API_REQUEST),
    API_REQUEST_TIMEOUT_BOUNDS
  );
  return cachedApiRequestTimeoutMs;
}

export function clearPortCache(): void {
  cachedPort = null;
  cachedHost = null;
  cachedSettings = null;
  cachedApiRequestTimeoutMs = null;
}

interface HookFailureState {
  consecutiveFailures: number;
  lastFailureAt: number;
}

const FAIL_LOUD_DEFAULT_THRESHOLD = 3;

function getStateDir(): string {
  return path.join(DATA_DIR, 'state');
}

function getHookFailuresPath(): string {
  return path.join(getStateDir(), 'hook-failures.json');
}

function parseHookFailureState(raw: string): HookFailureState {
  const parsed = JSON.parse(raw) as Partial<HookFailureState>;
  return {
    consecutiveFailures: typeof parsed.consecutiveFailures === 'number' && Number.isFinite(parsed.consecutiveFailures)
      ? Math.max(0, Math.floor(parsed.consecutiveFailures))
      : 0,
    lastFailureAt: typeof parsed.lastFailureAt === 'number' && Number.isFinite(parsed.lastFailureAt)
      ? parsed.lastFailureAt
      : 0,
  };
}

function readHookFailureState(): HookFailureState {
  try {
    return parseHookFailureState(readFileSync(getHookFailuresPath(), 'utf-8'));
  } catch {
    // [ANTI-PATTERN IGNORED]: the failure-counter state file is optional and
    // absent (ENOENT) on every hook run until the first worker failure, so
    // logging here would fire on effectively every healthy invocation; the
    // recovery is the zeroed default state below.
    return { consecutiveFailures: 0, lastFailureAt: 0 };
  }
}

function writeHookFailureStateAtomic(state: HookFailureState): void {
  const stateDir = getStateDir();
  const dest = getHookFailuresPath();
  const tmp = `${dest}.tmp`;
  try {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    renameSync(tmp, dest);
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Failed to persist hook-failure counter', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getFailLoudThreshold(): number {
  try {
    const settings = loadFromFileOnce();
    const raw = settings.MEMSMITH_HOOK_FAIL_LOUD_THRESHOLD;
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  } catch {
    // settings unreadable — fall through to default
  }
  return FAIL_LOUD_DEFAULT_THRESHOLD;
}

/**
 * Closed enum of hook handler names allowed as the `hook_type` telemetry
 * property. Mirrors the scrub whitelist comment (scrub.ts), the CLI
 * disclosure (npx-cli/commands/telemetry.ts), and docs/public/telemetry.mdx —
 * never widen one without the others. Events outside this set (user-message,
 * file-edit) simply omit hook_type.
 */
const TELEMETRY_HOOK_TYPES = ['context', 'session-init', 'observation', 'summarize', 'file-context'] as const;
export type TelemetryHookType = (typeof TELEMETRY_HOOK_TYPES)[number];

let activeHookType: TelemetryHookType | null = null;

/**
 * Record which hook event this short-lived hook process is executing, so the
 * fail-loud counter can tag its threshold-gated hook_failed telemetry.
 * Called once at hookCommand entry; values outside the closed enum are
 * dropped (never free text).
 */
export function setActiveHookType(event: string): void {
  activeHookType = (TELEMETRY_HOOK_TYPES as readonly string[]).includes(event)
    ? (event as TelemetryHookType)
    : null;
}

export function getActiveHookType(): TelemetryHookType | null {
  return activeHookType;
}

export async function recordWorkerUnreachable(): Promise<number> {
  const state = readHookFailureState();
  const next: HookFailureState = {
    consecutiveFailures: state.consecutiveFailures + 1,
    lastFailureAt: Date.now(),
  };
  writeHookFailureStateAtomic(next);

  const threshold = getFailLoudThreshold();
  if (next.consecutiveFailures >= threshold) {
    // hook_failed distress signal. Gated to the failure that JUST reached the
    // threshold (`===`, not `>=`): the stderr warning below repeats on every
    // failure past the threshold, but telemetry emits once per failure streak
    // to bound volume. MUST be awaited BEFORE emitBlockingError — it calls
    // process.exit(2) immediately, which would kill a fire-and-forget POST
    // mid-flight. captureCliEvent never throws and is hard-capped at 2s, so
    // this cannot hang the fail-loud path. Closed-enum/count props only —
    // never error text. Transport is the direct CLI POST, never the worker
    // API (the defining failure here IS "worker unreachable").
    if (next.consecutiveFailures === threshold) {
      await captureCliEvent('hook_failed', {
        ...(activeHookType !== null ? { hook_type: activeHookType } : {}),
        error_mode: 'worker_unavailable',
        consecutive_failures: next.consecutiveFailures,
        threshold_tripped: true,
      });
    }
    // #2292 fix: BLOCKING_FEEDBACK. emitBlockingError flushes the Phase 2
    // stderr buffer (so preceding logger.warn lines also surface) and writes
    // via the bypass channel + exits 2. Previously this raw process.stderr.write
    // was swallowed by hookCommand's blanket no-op, so the user/model never saw it.
    emitBlockingError(
      `memsmith worker unreachable for ${next.consecutiveFailures} consecutive hooks.`
    );
  }
  return next.consecutiveFailures;
}
