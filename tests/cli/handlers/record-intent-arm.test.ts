// tests/cli/handlers/record-intent-arm.test.ts
import { describe, it, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordIntentHandler } from '../../../src/cli/handlers/record-intent';
import { RecordArmedStore } from '../../../src/services/retrieval/record-armed-store';

// The handler writes the stash to ~/.memsmith/sessions by default. To assert
// without touching the real home dir, this test reads via a RecordArmedStore
// pointed at the same default location using the same sessionId, and uses a
// unique sessionId per run to avoid collisions.
describe('recordIntentHandler arming', () => {
  it('writes armed=true for a record prompt', async () => {
    const sessionId = `arm-test-${process.pid}-${Math.trunc(performance.now())}`;
    await recordIntentHandler.execute({ sessionId, cwd: '/tmp', prompt: 'remember that the port is 55433' } as any);
    const rec = new RecordArmedStore(sessionId).read();
    expect(rec?.armed).toBe(true);
  });
  it('writes armed=false for a non-record prompt', async () => {
    const sessionId = `arm-test-${process.pid}-${Math.trunc(performance.now())}-b`;
    await recordIntentHandler.execute({ sessionId, cwd: '/tmp', prompt: 'what did we decide?' } as any);
    const rec = new RecordArmedStore(sessionId).read();
    expect(rec?.armed).toBe(false);
  });
});
