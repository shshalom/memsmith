// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, mock, beforeEach, afterAll } from 'bun:test';
import { tmpdir } from 'os';

// Snapshot real modules BEFORE mock.module mutates the live namespace, then
// re-register in afterAll. bun's mock.module is process-global and survives
// mock.restore(), so these would otherwise leak into later test files.
import * as realHookSettings from '../../src/shared/hook-settings.js';
import * as realLogger from '../../src/utils/logger.js';
const realHookSettingsSnapshot = { ...realHookSettings };
const realLoggerSnapshot = { ...realLogger };

let mockSettings: Record<string, string> = {};

mock.module('../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ ...mockSettings }),
}));

const warnLogs: Array<{ msg: string; details?: unknown }> = [];
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    warn: (_component: string, msg: string, details?: unknown) => {
      warnLogs.push({ msg, details });
    },
    info: () => {},
    debug: () => {},
    error: () => {},
    failure: () => {},
    dataIn: () => {},
    formatTool: () => '',
  },
}));

afterAll(() => {
  mock.module('../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../src/utils/logger.js', () => realLoggerSnapshot);
});

import {
  resolveRuntimeContext,
  selectRuntime,
  buildServerContext,
  logServerFallback,
} from '../../src/services/hooks/runtime-selector.js';
import { ServerClient } from '../../src/services/hooks/server-client.js';

describe('runtime-selector', () => {
  beforeEach(() => {
    mockSettings = {
      MEMSMITH_RUNTIME: 'local',
      MEMSMITH_SERVER_URL: '',
      MEMSMITH_SERVER_API_KEY: '',
      MEMSMITH_SERVER_PROJECT_ID: '',
      MEMSMITH_SERVER_BETA_URL: '',
      MEMSMITH_SERVER_BETA_API_KEY: '',
      MEMSMITH_SERVER_BETA_PROJECT_ID: '',
    };
    warnLogs.length = 0;
  });

  it('selectRuntime defaults to local', () => {
    expect(selectRuntime()).toBe('local');
  });

  it("selectRuntime returns 'server' when MEMSMITH_RUNTIME='server' (canonical)", () => {
    mockSettings.MEMSMITH_RUNTIME = 'server';
    expect(selectRuntime()).toBe('server');
  });

  it("selectRuntime returns 'server' when MEMSMITH_RUNTIME='server-beta' (legacy back-compat)", () => {
    mockSettings.MEMSMITH_RUNTIME = 'server-beta';
    expect(selectRuntime()).toBe('server');
  });

  it('selectRuntime returns local for unknown values', () => {
    mockSettings.MEMSMITH_RUNTIME = 'something-else';
    expect(selectRuntime()).toBe('local');
  });

  it('selectRuntime accepts mixed case / whitespace', () => {
    mockSettings.MEMSMITH_RUNTIME = '  SERVER  ';
    expect(selectRuntime()).toBe('server');
    mockSettings.MEMSMITH_RUNTIME = '  Server-Beta  ';
    expect(selectRuntime()).toBe('server');
  });

  it('resolveRuntimeContext returns local skip context when runtime=local (no server config)', () => {
    // MEMSMITH_RUNTIME='local' with no server URL/key/project -> local skip context.
    // The worker fallback no longer exists; hooks skip cleanly via 'local'.
    const ctx = resolveRuntimeContext();
    expect(ctx.runtime).toBe('local');
    if (ctx.runtime === 'local') {
      expect(ctx.reason).toBe('server_context_unavailable');
    }
  });

  it('resolveRuntimeContext returns local skip context when api key is missing', () => {
    mockSettings.MEMSMITH_RUNTIME = 'server';
    mockSettings.MEMSMITH_SERVER_URL = 'http://localhost:1234';
    mockSettings.MEMSMITH_SERVER_PROJECT_ID = 'p1';
    // Missing api key -> buildServerContext returns null -> local skip context.
    const ctx = resolveRuntimeContext();
    expect(ctx.runtime).toBe('local');
    if (ctx.runtime === 'local') {
      expect(ctx.reason).toBe('server_context_unavailable');
    }
    expect(warnLogs.some(l => l.msg.includes('missing_api_key'))).toBe(true);
  });

  it("resolveRuntimeContext returns 'server' context when canonical keys are configured", () => {
    mockSettings.MEMSMITH_RUNTIME = 'server';
    mockSettings.MEMSMITH_SERVER_URL = 'http://localhost:1234';
    mockSettings.MEMSMITH_SERVER_API_KEY = 'cmem_xyz';
    mockSettings.MEMSMITH_SERVER_PROJECT_ID = 'project-uuid';
    const ctx = resolveRuntimeContext();
    expect(ctx.runtime).toBe('server');
    if (ctx.runtime === 'server') {
      expect(ctx.projectId).toBe('project-uuid');
      expect(ctx.serverBaseUrl).toBe('http://localhost:1234');
    }
  });

  it("resolveRuntimeContext returns 'server' context when legacy MEMSMITH_RUNTIME='server-beta' + legacy *_BETA_* keys are configured", () => {
    // Simulates an existing installed settings.json from before the rename.
    mockSettings.MEMSMITH_RUNTIME = 'server-beta';
    mockSettings.MEMSMITH_SERVER_BETA_URL = 'http://legacy.example:9999';
    mockSettings.MEMSMITH_SERVER_BETA_API_KEY = 'legacy_key';
    mockSettings.MEMSMITH_SERVER_BETA_PROJECT_ID = 'legacy-project';
    const ctx = resolveRuntimeContext();
    // Canonical runtime literal is `'server'` even for legacy input.
    expect(ctx.runtime).toBe('server');
    if (ctx.runtime === 'server') {
      expect(ctx.projectId).toBe('legacy-project');
      expect(ctx.serverBaseUrl).toBe('http://legacy.example:9999');
    }
  });

  it('buildServerContext prefers new keys when both are set', () => {
    mockSettings.MEMSMITH_SERVER_URL = 'http://new.example:1111';
    mockSettings.MEMSMITH_SERVER_API_KEY = 'new_key';
    mockSettings.MEMSMITH_SERVER_PROJECT_ID = 'new-project';
    mockSettings.MEMSMITH_SERVER_BETA_URL = 'http://old.example:9999';
    mockSettings.MEMSMITH_SERVER_BETA_API_KEY = 'old_key';
    mockSettings.MEMSMITH_SERVER_BETA_PROJECT_ID = 'old-project';
    const ctx = buildServerContext();
    expect(ctx).not.toBeNull();
    if (ctx) {
      expect(ctx.serverBaseUrl).toBe('http://new.example:1111');
      expect(ctx.projectId).toBe('new-project');
    }
  });

  it('buildServerContext falls back to legacy *_BETA_* keys when new keys are unset', () => {
    // No MEMSMITH_SERVER_* keys set, but legacy ones are.
    mockSettings.MEMSMITH_SERVER_BETA_URL = 'http://legacy.example:9999';
    mockSettings.MEMSMITH_SERVER_BETA_API_KEY = 'legacy_key';
    mockSettings.MEMSMITH_SERVER_BETA_PROJECT_ID = 'legacy-project';
    const ctx = buildServerContext();
    expect(ctx).not.toBeNull();
    if (ctx) {
      expect(ctx.serverBaseUrl).toBe('http://legacy.example:9999');
      expect(ctx.projectId).toBe('legacy-project');
      expect(ctx.runtime).toBe('server');
    }
  });

  it('buildServerContext returns null when project id missing on both new and legacy keys', () => {
    mockSettings.MEMSMITH_RUNTIME = 'server';
    mockSettings.MEMSMITH_SERVER_URL = 'http://localhost:1234';
    mockSettings.MEMSMITH_SERVER_API_KEY = 'cmem_xyz';
    expect(buildServerContext()).toBeNull();
    expect(warnLogs.some(l => l.msg.includes('missing_project_id'))).toBe(true);
  });

  // Task 2 — team mode ('server' runtime) must delegate generation to the
  // local machine: the client buildServerContext returns should record events
  // WITHOUT enqueuing server-side generation. Local mode must be unaffected.
  it('buildServerContext yields a client that sends generate=false in team (server) mode', async () => {
    mockSettings.MEMSMITH_RUNTIME = 'server';
    mockSettings.MEMSMITH_SERVER_URL = 'http://localhost:1234';
    mockSettings.MEMSMITH_SERVER_API_KEY = 'cmem_xyz';
    mockSettings.MEMSMITH_SERVER_PROJECT_ID = 'project-uuid';

    // A cwd with no .memsmith/project.json marker so selectRuntime falls
    // through to MEMSMITH_RUNTIME above rather than a per-project marker.
    const cwd = tmpdir();
    const ctx = buildServerContext({ cwd });
    expect(ctx).not.toBeNull();
    if (!ctx) return;

    const calls: string[] = [];
    const fn = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ event: { id: 'e1' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    // Rebuild a client with the same delegateGeneration behavior but an
    // injected fetchImpl so we can observe the request path without a
    // real network call.
    const client = new ServerClient({
      serverBaseUrl: ctx.serverBaseUrl,
      apiKey: 'cmem_xyz',
      delegateGeneration: true,
      fetchImpl: fn,
    });
    await client.recordEvent({
      projectId: ctx.projectId,
      sourceType: 'hook',
      eventType: 'PostToolUse',
      occurredAtEpoch: 0,
    });
    expect(calls[0]).toContain('generate=false');
  });

  it('buildServerContext yields a client that does NOT send generate=false in local mode', async () => {
    mockSettings.MEMSMITH_RUNTIME = 'local';
    mockSettings.MEMSMITH_SERVER_URL = 'http://localhost:1234';
    mockSettings.MEMSMITH_SERVER_API_KEY = 'cmem_xyz';
    mockSettings.MEMSMITH_SERVER_PROJECT_ID = 'project-uuid';

    const cwd = tmpdir();
    const ctx = buildServerContext({ cwd });
    expect(ctx).not.toBeNull();
    if (!ctx) return;

    const calls: string[] = [];
    const fn = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ event: { id: 'e1' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const client = new ServerClient({
      serverBaseUrl: ctx.serverBaseUrl,
      apiKey: 'cmem_xyz',
      delegateGeneration: false,
      fetchImpl: fn,
    });
    await client.recordEvent({
      projectId: ctx.projectId,
      sourceType: 'hook',
      eventType: 'PostToolUse',
      occurredAtEpoch: 0,
    });
    expect(calls[0]).not.toContain('generate=false');
  });

  it('logServerFallback emits a stable WARN code', () => {
    logServerFallback('transport', { route: '/v1/events' });
    const matched = warnLogs.find(l => l.msg.includes('[server-fallback]'));
    expect(matched).toBeDefined();
    expect(matched?.msg).toContain('reason=transport');
  });

  // #2564 — switching MEMSMITH_RUNTIME flips which runtime hooks dispatch to
  // WITHOUT a reinstall. The selector reads the setting on every call (via
  // loadFromFileOnce), so flipping the setting and re-resolving must change the
  // resolved runtime. This proves the no-reinstall switch end-to-end at the
  // dispatch boundary the hooks use (resolveRuntimeContext).
  // Phase 1d: the persisted literal `'server-beta'` is still accepted in
  // settings, but the selector normalizes it to the canonical `'server'`.
  it('flips local <-> server when the setting changes (no reinstall)', () => {
    // Start on local (default). No server config -> local skip context.
    mockSettings.MEMSMITH_RUNTIME = 'local';
    const localCtx = resolveRuntimeContext();
    expect(localCtx.runtime).toBe('local');

    // Flip to server-beta (fully configured) — hooks now resolve the server runtime.
    // Persisted setting may still be `'server-beta'`; selector normalizes to `'server'`.
    mockSettings.MEMSMITH_RUNTIME = 'server-beta';
    mockSettings.MEMSMITH_SERVER_BETA_URL = 'http://localhost:9999';
    mockSettings.MEMSMITH_SERVER_BETA_API_KEY = 'cmem_flip';
    mockSettings.MEMSMITH_SERVER_BETA_PROJECT_ID = 'proj-flip';
    const flipped = resolveRuntimeContext();
    expect(flipped.runtime).toBe('server');
    if (flipped.runtime === 'server') {
      expect(flipped.serverBaseUrl).toBe('http://localhost:9999');
    }

    // Flip back to local — hooks resolve the local skip context (no worker fallback).
    mockSettings.MEMSMITH_RUNTIME = 'local';
    mockSettings.MEMSMITH_SERVER_BETA_URL = '';
    mockSettings.MEMSMITH_SERVER_BETA_API_KEY = '';
    mockSettings.MEMSMITH_SERVER_BETA_PROJECT_ID = '';
    expect(resolveRuntimeContext().runtime).toBe('local');
  });
});
