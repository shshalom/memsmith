// tests/cli/handlers/record-intent-hook.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { recordIntentHandler } from '../../../src/cli/handlers/record-intent.js';

describe('recordIntentHandler', () => {
  it('returns a continue result and never throws when no runtime', async () => {
    const res = await recordIntentHandler.execute({ sessionId: 's', cwd: '/tmp', prompt: 'remember X' } as any);
    expect(res.continue).toBe(true);
  });
  it('empty prompt → clean skip', async () => {
    const res = await recordIntentHandler.execute({ sessionId: 's', cwd: '/tmp', prompt: '' } as any);
    expect(res.continue).toBe(true);
  });
});
