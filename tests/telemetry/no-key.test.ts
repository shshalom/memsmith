import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { postHogConstructorCalls, postHogCaptureCalls } from '../preload';
import { captureEvent, __resetTelemetryForTests } from '../../src/services/telemetry/telemetry';
import { captureCliEvent } from '../../src/services/telemetry/cli-telemetry';
import { getTelemetryApiKey } from '../../src/services/telemetry/common';

// MemSmith ships no telemetry key, so an install that never configured one
// must send nothing, even with consent recorded as on.
const ENV_KEYS = ['MEMSMITH_DATA_DIR', 'MEMSMITH_TELEMETRY', 'MEMSMITH_TELEMETRY_DEBUG', 'MEMSMITH_TELEMETRY_KEY', 'DO_NOT_TRACK'];
const savedEnv: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;
let tempDir: string;
let fetchCalls: number;

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tempDir = mkdtempSync(join(tmpdir(), 'memsmith-telemetry-nokey-'));
  process.env.MEMSMITH_DATA_DIR = tempDir;
  process.env.MEMSMITH_TELEMETRY = '1';
  delete process.env.MEMSMITH_TELEMETRY_DEBUG;
  delete process.env.MEMSMITH_TELEMETRY_KEY;
  delete process.env.DO_NOT_TRACK;
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  __resetTelemetryForTests();
  postHogConstructorCalls.length = 0;
  postHogCaptureCalls.length = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tempDir, { recursive: true, force: true });
  __resetTelemetryForTests();
});

describe('telemetry without a configured key', () => {
  it('the worker client is never built and captures nothing', () => {
    captureEvent('install_completed');
    expect(postHogConstructorCalls.length).toBe(0);
    expect(postHogCaptureCalls.length).toBe(0);
  });

  it('the CLI transport makes no network request', async () => {
    await captureCliEvent('install_completed');
    expect(fetchCalls).toBe(0);
  });

  it('a key in settings.json enables the CLI transport', async () => {
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify({ MEMSMITH_TELEMETRY_KEY: 'phc_from_settings' }));
    expect(getTelemetryApiKey()).toBe('phc_from_settings');
    await captureCliEvent('install_completed');
    expect(fetchCalls).toBe(1);
  });
});
