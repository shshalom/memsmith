// tests/retrieval/broker-integration.test.ts
// Skips gracefully if the embedded PG / server is not up.
import { describe, it, expect } from 'bun:test';
import { RetrievalBroker } from '../../src/services/retrieval/broker.js';
import { ServerClient } from '../../src/services/hooks/server-client.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const TEAM = 'ab8e1f17-020e-4794-bae3-e59885e7df05';
const PROJ = '5fc024f0-0994-4f1d-baed-300d9b4d3416';

function key(): string | null {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.memsmith', 'credentials.json'), 'utf-8'));
    return j.keys?.[TEAM] ?? null;
  } catch { return null; }
}

describe('RetrievalBroker (live)', () => {
  it('returns real ranked memory for a decision query', async () => {
    const k = key();
    if (!k) { console.log('skip: no dogfood key'); return; }
    const client = new ServerClient({ serverBaseUrl: 'http://127.0.0.1:38879', apiKey: k });
    let reachable = true;
    try { await client.contextObservations({ projectId: PROJ, query: 'ping', limit: 1 }); } catch { reachable = false; }
    if (!reachable) { console.log('skip: server not reachable'); return; }
    const broker = new RetrievalBroker({
      runtime: { runtime: 'server', client, projectId: PROJ, serverBaseUrl: 'http://127.0.0.1:38879' } as any,
      settings: { MEMSMITH_RETRIEVAL_MIN_HITS: '1', MEMSMITH_RETRIEVAL_TIMEOUT_MS: '5000', MEMSMITH_SEMANTIC_INJECT_LIMIT: '3', MEMSMITH_RETRIEVAL_ENFORCEMENT: 'soft' },
      sessionId: 'itest', nowIso: new Date().toISOString(),
    });
    const r = await broker.forPrompt('why did observation capture go dark');
    // There IS memory about this (from this session's debugging).
    expect(r.hitCount).toBeGreaterThan(0);
    expect(r.additionalContext.length).toBeGreaterThan(0);
  });
});
