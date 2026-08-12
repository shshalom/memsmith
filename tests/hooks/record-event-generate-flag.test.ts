// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import { ServerClient } from '../../src/services/hooks/server-client.js';

function captureFetch() {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ event: { id: 'e1' } }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fn: fn as unknown as typeof fetch };
}

const base = { projectId: 'p1', sourceType: 'hook' as const, eventType: 'PostToolUse', occurredAtEpoch: 0 };

describe('recordEvent generate flag', () => {
  it('sends generate=false when the client delegates generation', async () => {
    const { calls, fn } = captureFetch();
    const c = new ServerClient({ serverBaseUrl: 'http://x', apiKey: 'k', delegateGeneration: true, fetchImpl: fn });
    await c.recordEvent(base);
    expect(calls[0]).toContain('generate=false');
  });

  it('does NOT send generate=false by default (local mode unchanged)', async () => {
    const { calls, fn } = captureFetch();
    const c = new ServerClient({ serverBaseUrl: 'http://x', apiKey: 'k', fetchImpl: fn });
    await c.recordEvent(base);
    expect(calls[0]).not.toContain('generate=false');
  });

  it('an explicit generate:false still wins when not delegating', async () => {
    const { calls, fn } = captureFetch();
    const c = new ServerClient({ serverBaseUrl: 'http://x', apiKey: 'k', fetchImpl: fn });
    await c.recordEvent({ ...base, generate: false });
    expect(calls[0]).toContain('generate=false');
  });

  it('an explicit generate:true overrides delegation', async () => {
    const { calls, fn } = captureFetch();
    const c = new ServerClient({ serverBaseUrl: 'http://x', apiKey: 'k', delegateGeneration: true, fetchImpl: fn });
    await c.recordEvent({ ...base, generate: true });
    expect(calls[0]).not.toContain('generate=false');
  });
});
