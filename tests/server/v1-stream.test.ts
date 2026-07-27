// SPDX-License-Identifier: Apache-2.0
//
// Framing / lifecycle behaviour of the SSE fan-out. Subscriptions are scoped to
// a project (observation-stream-scoping.test.ts covers the isolation
// guarantees themselves), so these cases publish within a single project.
import { describe, test, expect } from 'bun:test';
import { ObservationStream } from '../../src/server/routes/v1/ObservationStream.js';

const SCOPE = { teamId: 't1', projectId: 'p1' };

describe('ObservationStream', () => {
  test('publish writes SSE-framed data to subscribers; unsubscribe stops delivery', () => {
    const s = new ObservationStream();
    const writes: string[] = [];
    const fakeRes: any = { write: (chunk: string) => writes.push(chunk), writableEnded: false };
    const unsub = s.subscribe(fakeRes, SCOPE);
    s.publish({ type: 'new_observation', observation: { id: 'o1', ...SCOPE } });
    expect(writes.some(w => w.startsWith('data: ') && w.includes('o1') && w.endsWith('\n\n'))).toBe(true);
    unsub();
    writes.length = 0;
    s.publish({ type: 'new_observation', observation: { id: 'o2', ...SCOPE } });
    expect(writes.length).toBe(0); // no delivery after unsubscribe
  });
  test('publish never throws if a subscriber write fails', () => {
    const s = new ObservationStream();
    s.subscribe({ write: () => { throw new Error('broken pipe'); }, writableEnded: false } as any, SCOPE);
    expect(() => s.publish({ type: 'new_observation', observation: { id: 'x', ...SCOPE } })).not.toThrow();
  });
});
