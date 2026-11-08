import { describe, it, expect } from 'bun:test';
import { scrubEventPayload } from '../../../../src/server/services/event-payload-scrub.js';

describe('sessions/start metadata private strip', () => {
  it('scrubs <private> from the session metadata (project + prompt shape)', () => {
    const metadata = { project: 'MemSmith', prompt: 'working on <private>secret-plan-X</private> today' };
    const scrubbed = scrubEventPayload(metadata) as typeof metadata;
    expect(JSON.stringify(scrubbed)).not.toContain('secret-plan-X');
    expect(scrubbed.project).toBe('MemSmith');       // non-private field preserved
    expect(scrubbed.prompt).toContain('working on');  // non-private text survives
    expect(scrubbed.prompt).toContain('today');
  });

  it('leaves tag-free metadata semantically unchanged', () => {
    const metadata = { project: 'MemSmith', prompt: 'plain prompt' };
    expect(scrubEventPayload(metadata)).toEqual({ project: 'MemSmith', prompt: 'plain prompt' });
  });
});

describe('sessions/start metadata secret redaction', () => {
  it('redacts a secret in the raw prompt the client sends as metadata', () => {
    const fakeKey = 'sk-ant-api03-' + 'FAKE0test9'.repeat(4);
    expect(scrubEventPayload({ project: 'MemSmith', prompt: `why does ${fakeKey} fail?` }))
      .toEqual({ project: 'MemSmith', prompt: 'why does [REDACTED:anthropic_key] fail?' });
  });
});
