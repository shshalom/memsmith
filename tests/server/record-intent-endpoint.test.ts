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
});
