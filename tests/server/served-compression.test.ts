// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { recordServedCompression } from '../../src/server/retrieval/recordServedCompression.js';

describe('recordServedCompression', () => {
  it('records a compression event when tiering shrinks the served rows', async () => {
    const recorded: any[] = [];
    const usage = { record: async (e: any) => { recorded.push(e); } } as any;
    const rows = [
      { content: 'X'.repeat(4000), metadata: { title: 'T', facts: ['f'], why: 'W' } },
    ];
    process.env.MEMSMITH_USAGE_METERING = '1';
    await recordServedCompression({ usage, teamId: 't', projectId: 'p', rows, maxChars: 200, maxItems: 1 });
    delete process.env.MEMSMITH_USAGE_METERING;
    expect(recorded.length).toBe(1);
    expect(recorded[0].kind).toBe('compression');
    expect(recorded[0].quantity).toBeGreaterThan(0);
  });

  it('records nothing when metering is disabled', async () => {
    const recorded: any[] = [];
    const usage = { record: async (e: any) => { recorded.push(e); } } as any;
    delete process.env.MEMSMITH_USAGE_METERING;
    await recordServedCompression({ usage, teamId: 't', projectId: 'p', rows: [{ content: 'X'.repeat(4000), metadata: { title: 'T', facts: ['f'], why: 'W' } }], maxChars: 200, maxItems: 1 });
    expect(recorded.length).toBe(0);
  });

  it('never throws on a bad usage repo', async () => {
    const usage = { record: async () => { throw new Error('db down'); } } as any;
    process.env.MEMSMITH_USAGE_METERING = '1';
    await recordServedCompression({ usage, teamId: 't', projectId: 'p', rows: [{ content: 'X'.repeat(4000), metadata: { title: 'T', facts: ['f'], why: 'W' } }], maxChars: 200, maxItems: 1 });
    delete process.env.MEMSMITH_USAGE_METERING;
    expect(true).toBe(true); // reached here without throwing
  });
});
