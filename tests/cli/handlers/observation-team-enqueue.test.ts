// SPDX-License-Identifier: Apache-2.0
//
// Task 6 — team mode must enqueue every observation event to the LOCAL
// generation queue (src/services/generation/local-queue.ts), in addition to
// posting the raw event to the server with `generate=false` (Task 2 makes
// that flag automatic via ServerClient's delegateGeneration).
//
// The enqueue must not depend on the POST succeeding: a server outage must
// not cost the observation. That is the whole point of Task 1's durable
// local queue existing — it MUST be reachable from the failure branch, not
// just the happy path.
//
// Mocking pattern follows tests/cli/handlers/summarize-tag-stripping.test.ts:
// runtime-selector.js is mocked wholesale via bun's mock.module so the
// handler's real `resolveRuntimeContext(cwd)` call resolves to a fake
// server/local RuntimeContext without touching ~/.memsmith settings or a
// real project marker file.

import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Snapshot real exports before mock.module mutates the live namespace, then
// re-register them in afterAll — bun's mock.module is process-global and
// mock.restore() does NOT undo it, so a leaked mock here would break every
// later test file that imports runtime-selector.js or server-client.js.
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
import * as realServerClient from '../../../src/services/hooks/server-client.js';
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };
const realServerClientSnapshot = { ...realServerClient };

const { ServerClientError, isServerClientError } = realServerClient;

// A real per-test-tmp-dir generation queue file, exercised through the real
// local-queue.ts primitives (not mocked) — the assertion in every test below
// is "the file on disk has N lines", which is the actual durability contract
// Task 1 built. Only the runtime/server plumbing above it is faked.
let queueDir: string;
let queuePath: string;

function readQueue(): unknown[] {
  return realLocalQueue.readGenerationQueue(queuePath);
}

import * as realLocalQueue from '../../../src/services/generation/local-queue.js';

interface RecordedEvent {
  projectId: string;
  eventType: string;
  payload: Record<string, unknown>;
}
let recordedEvents: RecordedEvent[] = [];
let recordEventShouldThrow: (() => never) | null = null;

function makeMockServerClient() {
  return {
    recordEvent: async (req: any) => {
      if (recordEventShouldThrow) {
        recordEventShouldThrow();
      }
      recordedEvents.push({ projectId: req.projectId, eventType: req.eventType, payload: req.payload as Record<string, unknown> });
      return { event: { id: 'mock-event-id', projectId: req.projectId, serverSessionId: null } };
    },
  };
}

function makeServerRuntimeContext() {
  return {
    runtime: 'server' as const,
    client: makeMockServerClient() as any,
    projectId: 'test-proj',
    serverBaseUrl: 'http://mock-server',
  };
}

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  queueDir = mkdtempSync(join(tmpdir(), 'memsmith-gen-queue-'));
  queuePath = join(queueDir, 'generation-queue.jsonl');
  recordedEvents = [];
  recordEventShouldThrow = null;
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];

  // Point the handler's enqueue at this test's tmp queue file rather than the
  // real ~/.memsmith/generation-queue.jsonl. observation.ts calls
  // enqueueForGeneration(event) — no path arg — in production, so the
  // handler must resolve generationQueuePath() itself; we redirect that
  // resolution by mocking local-queue.js's generationQueuePath export while
  // keeping every other export (enqueueForGeneration, readGenerationQueue,
  // etc.) real, so the actual durability code under test still runs.
  mock.module('../../../src/services/generation/local-queue.js', () => ({
    ...realLocalQueue,
    generationQueuePath: () => queuePath,
  }));
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  rmSync(queueDir, { recursive: true, force: true });
});

afterAll(() => {
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
  mock.module('../../../src/services/hooks/server-client.js', () => realServerClientSnapshot);
  mock.module('../../../src/services/generation/local-queue.js', () => realLocalQueue);
});

const baseInput = {
  sessionId: 'sess-team-enqueue',
  cwd: '/tmp',
  platform: 'claude-code' as const,
  toolName: 'Read',
  toolInput: { file_path: '/tmp/foo.ts' },
  toolResponse: { content: 'hello' },
};

describe('observationHandler — team-mode local generation enqueue (Task 6)', () => {
  it('team mode enqueues the event locally', async () => {
    mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
      ...realRuntimeSelectorSnapshot,
      resolveRuntimeContext: () => makeServerRuntimeContext(),
      logServerFallback: () => {},
    }));

    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(baseInput as any);

    expect(result.continue).toBe(true);
    // The POST succeeded, so the raw event also reached the server.
    expect(recordedEvents).toHaveLength(1);
    // AND it was enqueued locally for generation — this is the behavior
    // under test, not a byproduct of the POST.
    expect(readQueue()).toHaveLength(1);
  });

  it('team mode still enqueues when the POST fails', async () => {
    // Prove this is a GENUINE fallback-eligible failure, not a fixture that
    // can't distinguish pass from fail:
    //   1. recordEvent throws a real ServerClientError('transport', ...) —
    //      the same error class and 'transport' kind the real ServerClient
    //      throws on a network failure (fetch rejecting), not a plain Error
    //      or a made-up shape.
    //   2. isFallbackEligible() is asserted true on that exact error BEFORE
    //      exercising the handler, independently confirming the fixture
    //      exercises the "server outage" branch the handler's own
    //      `isServerClientError(error) && error.isFallbackEligible()` check
    //      requires (observation.ts:113) — not the "non-recoverable" else
    //      branch, which returns early and would never reach an enqueue call
    //      placed after the try/catch either way.
    const transportError = new ServerClientError('transport', 'simulated network outage: ECONNREFUSED');
    expect(isServerClientError(transportError)).toBe(true);
    expect(transportError.isFallbackEligible()).toBe(true);

    recordEventShouldThrow = () => { throw transportError; };

    mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
      ...realRuntimeSelectorSnapshot,
      resolveRuntimeContext: () => makeServerRuntimeContext(),
      logServerFallback: () => {},
    }));

    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(baseInput as any);

    expect(result.continue).toBe(true);
    // The POST never landed.
    expect(recordedEvents).toHaveLength(0);
    // But the observation must not be lost: it is still enqueued locally.
    // If enqueue were placed INSIDE the try block (after the awaited
    // recordEvent call, sharing its exception path), the thrown error would
    // skip straight to the catch block and this assertion would fail with
    // queue length 0 — which is exactly the regression this test guards
    // against.
    expect(readQueue()).toHaveLength(1);
  });

  it('local mode does NOT enqueue (unchanged behavior)', async () => {
    mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
      ...realRuntimeSelectorSnapshot,
      resolveRuntimeContext: () => ({ runtime: 'local' as const, reason: 'server_context_unavailable' as const }),
      logServerFallback: () => {},
    }));

    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(baseInput as any);

    expect(result.continue).toBe(true);
    expect(recordedEvents).toHaveLength(0);
    // Local mode generates in-process; it must not also enqueue for a
    // separate local-generation drain loop.
    expect(readQueue()).toHaveLength(0);
  });
});
