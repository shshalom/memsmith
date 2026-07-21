// tests/server/routes/v1/record-intent-strip.test.ts
import { describe, it, expect } from 'bun:test';
import { classifyAndComposeRecordIntent } from '../../../../src/server/routes/v1/record-intent.js';
import { stripMemoryTags } from '../../../../src/utils/tag-stripping.js';

describe('record-intent private strip (3-sink property)', () => {
  it('a stripped prompt leaks no <private> content to the LLM, the hash, or the stored content', async () => {
    const raw = 'remember that my key is <private>sk-SECRET-123</private> ok';
    const stripped = stripMemoryTags(raw); // what the route will pass

    let sentToLLM = '';
    let storedContent = '';
    let storedKey = '';
    const deps = {
      complete: async (_system: string, user: string) => { sentToLLM = user; return `RECORD: ${user}`; },
      write: async (o: { content: string; idempotencyKey: string; projectId: string; teamId: string; kind: string; metadata: Record<string, unknown> }) => {
        storedContent = o.content; storedKey = o.idempotencyKey; return { id: 'note-1' };
      },
      teamId: 't1',
      projectId: 'p1',
    };

    const result = await classifyAndComposeRecordIntent(stripped, deps as never);
    expect(result.recorded).toBe(true);
    // Sink 1: LLM never saw the secret
    expect(sentToLLM).not.toContain('sk-SECRET-123');
    // Sink 3: stored content never holds the secret
    expect(storedContent).not.toContain('sk-SECRET-123');
    // Sink 2: the idempotency key is derived from the stripped prompt — proven by
    // the fact that a DIFFERENT secret with the same non-private text yields the SAME key.
    let key2 = '';
    const deps2 = { ...deps, write: async (o: { idempotencyKey: string }) => { key2 = o.idempotencyKey; return { id: 'note-2' }; } } as never;
    await classifyAndComposeRecordIntent(stripMemoryTags('remember that my key is <private>sk-DIFFERENT-999</private> ok'), deps2);
    expect(storedKey).toBe(key2); // same stripped prompt → same key regardless of the private fragment
    // and the non-private text survived
    expect(storedContent).toContain('remember that my key is');
  });
});
