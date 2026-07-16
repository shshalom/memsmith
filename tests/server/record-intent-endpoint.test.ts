// tests/server/record-intent-endpoint.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { classifyAndComposeRecordIntent } from '../../src/server/routes/v1/record-intent.js';

// Unit-test the pure classify/parse + write-decision logic with injected deps.
describe('classifyAndComposeRecordIntent', () => {
  const writes: any[] = [];
  const deps = (reply: string | null) => ({
    complete: async () => reply,
    write: async (o: any) => { writes.push(o); return { id: 'x' }; },
    teamId: 't', projectId: 'p',
  });
  it('RECORD: reply writes a marked user_note with an idempotency key', async () => {
    writes.length = 0;
    const r = await classifyAndComposeRecordIntent('remember we chose postgres', deps('RECORD: We chose Postgres for concurrent writers.') as any);
    expect(r.recorded).toBe(true);
    expect(writes.length).toBe(1);
    expect(writes[0].kind).toBe('user_note');
    expect(writes[0].metadata.userDirected).toBe(true);
    expect(typeof writes[0].idempotencyKey).toBe('string');
    expect(writes[0].content).toContain('Postgres');
  });
  it('NONE reply records nothing', async () => {
    writes.length = 0;
    const r = await classifyAndComposeRecordIntent('what is the weather', deps('NONE') as any);
    expect(r.recorded).toBe(false);
    expect(writes.length).toBe(0);
  });
  it('null completion (provider failed) records nothing, no throw', async () => {
    writes.length = 0;
    const r = await classifyAndComposeRecordIntent('remember x', deps(null) as any);
    expect(r.recorded).toBe(false);
    expect(writes.length).toBe(0);
  });

  // Regression test for idempotency-key derivation: the key must be PROMPT-derived,
  // not content-derived. A nondeterministic LLM composer returns different wording
  // each call for the same prompt — if the key tracked content, those would be
  // distinct keys → duplicate rows. Both writes below must share the same key.
  it('idempotency key is PROMPT-derived (not content-derived): same prompt, different composed wording → same key', async () => {
    const prompt = 'remember we chose postgres';

    // First call: stub returns one phrasing
    const writes1: any[] = [];
    const deps1 = {
      complete: async () => 'RECORD: We chose Postgres for concurrent write workloads.',
      write: async (o: any) => { writes1.push(o); return { id: 'a' }; },
      teamId: 't', projectId: 'p',
    };
    await classifyAndComposeRecordIntent(prompt, deps1);

    // Second call: same prompt, but stub returns DIFFERENT composed wording (simulates nondeterministic LLM)
    const writes2: any[] = [];
    const deps2 = {
      complete: async () => 'RECORD: Postgres was selected due to high concurrency requirements.',
      write: async (o: any) => { writes2.push(o); return { id: 'b' }; },
      teamId: 't', projectId: 'p',
    };
    await classifyAndComposeRecordIntent(prompt, deps2);

    expect(writes1.length).toBe(1);
    expect(writes2.length).toBe(1);
    // Content MUST differ (the composed text changed) — proves the stub is wired correctly
    expect(writes1[0].content).not.toBe(writes2[0].content);
    // Idempotency keys MUST be equal — proves the key does NOT track content
    expect(writes1[0].idempotencyKey).toBe(writes2[0].idempotencyKey);
  });
});
