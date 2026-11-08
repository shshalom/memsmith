import { afterEach, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Data-dir tripwire (Phase 6, worker-restart plan): no test may ever touch the
 * real ~/.memsmith. src/shared/paths.ts freezes DATA_DIR at first evaluation
 * (env MEMSMITH_DATA_DIR wins), and module-level consts like ProcessManager's
 * PID_FILE inherit that frozen value — so the env var must point at a safe
 * directory BEFORE any module loads. This preload runs first (bunfig.toml
 * [test].preload), so when the env var is unset we pin it to a fresh per-run
 * temp dir. Tests that want tighter isolation still override it per-file /
 * per-test; this only fills the default so nothing can fall through to the
 * real data dir. The leaked temp dir per run is deliberate: correctness over
 * cleanup (an afterAll here could rip the dir out from under frozen module
 * constants while later test files still run).
 */
if (!process.env.MEMSMITH_DATA_DIR) {
  process.env.MEMSMITH_DATA_DIR = mkdtempSync(join(tmpdir(), 'memsmith-test-run-'));
}

/**
 * Database tripwire: no test may reach the developer's real embedded Postgres.
 * A temp MEMSMITH_DATA_DIR does not isolate it. The session-init and context
 * hooks mint a project identity through resolveLocalBaseDatabaseUrl, which uses
 * MEMSMITH_SERVER_DATABASE_URL or else 127.0.0.1:MEMSMITH_LOCAL_PG_PORT
 * (default 55433, the dogfood database). One hook-process test that ran those
 * hooks left seven projects, teams, and API keys in it.
 *
 * Both variables point at a closed port unless the run chose another database;
 * a value that names the real one, even from the developer's shell, is
 * replaced. Spawned hooks and servers inherit the guard through process.env.
 * Opt-in integration tests set their own non-55433 values inside the test.
 */
const UNREACHABLE_DATABASE_URL = 'postgres://memsmith:unreachable@127.0.0.1:1/memsmith_test_guard';
const UNREACHABLE_PG_PORT = '1';
const REAL_LOCAL_PG_PORT = '55433';

// An empty host or a socket directory means a local connection too.
function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '' || h.startsWith('/') || ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'].includes(h);
}

// Accepts both connection-string forms libpq takes: a postgres:// URL and
// key=value pairs such as `host=127.0.0.1 port=55433`.
function namesRealLocalPostgres(dsn: string | undefined): boolean {
  const value = (dsn ?? '').trim();
  if (!value) return false;
  if (/^postgres(ql)?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      const port = parsed.port || parsed.searchParams.get('port') || '';
      return port === REAL_LOCAL_PG_PORT && isLocalHost(parsed.searchParams.get('host') ?? parsed.hostname);
    } catch {
      return false;
    }
  }
  const pairs = new Map<string, string>();
  for (const m of value.matchAll(/(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|\S+)/g)) {
    pairs.set(m[1].toLowerCase(), m[2].replace(/^'(.*)'$/, '$1'));
  }
  return pairs.get('port') === REAL_LOCAL_PG_PORT && isLocalHost(pairs.get('host') ?? pairs.get('hostaddr') ?? '');
}

function guardDatabaseEnv(): string[] {
  const replaced: string[] = [];
  const url = process.env.MEMSMITH_SERVER_DATABASE_URL;
  if (!url || namesRealLocalPostgres(url)) {
    if (url) replaced.push('MEMSMITH_SERVER_DATABASE_URL');
    process.env.MEMSMITH_SERVER_DATABASE_URL = UNREACHABLE_DATABASE_URL;
  }
  const port = process.env.MEMSMITH_LOCAL_PG_PORT;
  if (!port || port.trim() === REAL_LOCAL_PG_PORT) {
    if (port) replaced.push('MEMSMITH_LOCAL_PG_PORT');
    process.env.MEMSMITH_LOCAL_PG_PORT = UNREACHABLE_PG_PORT;
  }
  return replaced;
}

guardDatabaseEnv();

// Embedded Postgres downloads its binaries into ~/.memsmith/pg-binaries by
// default. Opt-in integration tests that reuse those binaries pass the path
// explicitly.
if (!process.env.MEMSMITH_PG_BINARIES_DIR) {
  process.env.MEMSMITH_PG_BINARIES_DIR = mkdtempSync(join(tmpdir(), 'memsmith-test-pg-binaries-'));
}

// A test that leaves either variable on the real database would hand it to
// every later file in the same process. Fail that test and restore the guard.
afterEach(() => {
  const replaced = guardDatabaseEnv();
  if (replaced.length > 0) {
    throw new Error(`This test left ${replaced.join(' and ')} pointing at the real local Postgres on port ${REAL_LOCAL_PG_PORT}. Restore it when the test ends.`);
  }
});

/**
 * Global posthog-node mock, registered via bunfig.toml [test].preload BEFORE
 * any test file or src module loads. It must be global, not per-file:
 *
 *  1. telemetry.ts imports PostHog at module top level, and many src modules
 *     (ResponseProcessor, SessionRoutes, SearchRoutes, worker-service, ...)
 *     transitively import telemetry.ts. The whole suite runs in one bun
 *     process, so a per-file mock.module registers too late once any earlier
 *     test file has touched those modules — the cached telemetry module keeps
 *     the real PostHog binding.
 *  2. Telemetry consent is default-on and the publishable key ships in the
 *     code, so without this mock a full-suite run constructs a REAL PostHog
 *     client and can flush fabricated test events into production analytics
 *     (flushAt: 20 / flushInterval: 10s vs a ~25s suite).
 *
 * Tests assert against these recorded calls — see
 * tests/telemetry/telemetry-client.test.ts.
 */
export type PostHogConstructorCall = { apiKey: string; options: Record<string, unknown> };
export const postHogConstructorCalls: PostHogConstructorCall[] = [];
export const postHogCaptureCalls: Array<Record<string, unknown>> = [];
/**
 * Records captureException(error, distinctId, additionalProperties) calls so
 * Phase 3 error-capture tests can assert on the $exception payload (redacted
 * message/stack, $process_person_profile:false, occurrence_count) without a
 * real client. Mirrors postHogCaptureCalls. Reset per-file like the others.
 */
export type PostHogExceptionCall = {
  error: unknown;
  distinctId?: string;
  additionalProperties?: Record<string | number, unknown>;
};
export const postHogExceptionCalls: PostHogExceptionCall[] = [];

/**
 * Behavior knob for the mock below. When `emitErrorOnShutdown` is set, the
 * next shutdown() call emits it through every handler registered via
 * on('error', ...) before resolving — simulating posthog-node's real
 * delivery-failure surface (shutdown() swallows fetch errors internally; the
 * public error emitter is the only failure signal). Tests that set it MUST
 * reset it to null afterwards.
 */
export const postHogMockBehavior: { emitErrorOnShutdown: unknown | null } = {
  emitErrorOnShutdown: null,
};

mock.module('posthog-node', () => ({
  PostHog: class {
    private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    constructor(apiKey: string, options: Record<string, unknown>) {
      postHogConstructorCalls.push({ apiKey, options });
    }
    capture(payload: Record<string, unknown>): void {
      postHogCaptureCalls.push(payload);
    }
    captureException(
      error: unknown,
      distinctId?: string,
      additionalProperties?: Record<string | number, unknown>
    ): void {
      postHogExceptionCalls.push({ error, distinctId, additionalProperties });
    }
    on(event: string, handler: (...args: unknown[]) => void): () => void {
      (this.handlers[event] ??= []).push(handler);
      return () => {};
    }
    /** Test-only trigger mirroring the real SDK's internal emitter. */
    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers[event] ?? []) handler(...args);
    }
    async flush(): Promise<void> {}
    async shutdown(): Promise<void> {
      if (postHogMockBehavior.emitErrorOnShutdown !== null) {
        this.emit('error', postHogMockBehavior.emitErrorOnShutdown);
      }
    }
  },
}));
