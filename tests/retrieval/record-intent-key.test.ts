// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { computeContentIdempotencyKey } from '../../src/services/retrieval/record-intent-key.js';

const base = { teamId: 't1', projectId: 'p1', kind: 'user_note' };

describe('computeContentIdempotencyKey', () => {
  it('is deterministic for identical input', () => {
    const a = computeContentIdempotencyKey({ ...base, content: 'we chose postgres' });
    const b = computeContentIdempotencyKey({ ...base, content: 'we chose postgres' });
    expect(a).toBe(b);
    expect(a.startsWith('record-intent:v1:')).toBe(true);
  });
  it('normalizes trivial whitespace/case differences to the same key', () => {
    const a = computeContentIdempotencyKey({ ...base, content: 'We chose Postgres' });
    const b = computeContentIdempotencyKey({ ...base, content: '  we   chose   postgres ' });
    expect(a).toBe(b);
  });
  it('differs on team, project, kind, or meaningfully-different content', () => {
    const a = computeContentIdempotencyKey({ ...base, content: 'we chose postgres' });
    expect(computeContentIdempotencyKey({ ...base, teamId: 't2', content: 'we chose postgres' })).not.toBe(a);
    expect(computeContentIdempotencyKey({ ...base, projectId: 'p2', content: 'we chose postgres' })).not.toBe(a);
    expect(computeContentIdempotencyKey({ ...base, kind: 'observation', content: 'we chose postgres' })).not.toBe(a);
    expect(computeContentIdempotencyKey({ ...base, content: 'we chose sqlite' })).not.toBe(a);
  });
});
