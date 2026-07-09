// SPDX-License-Identifier: Apache-2.0
import { describe, test, expect } from 'bun:test';
import { ObservationStream } from '../../src/server/routes/v1/ObservationStream.js';

describe('ObservationStream', () => {
  test('publish writes SSE-framed data to subscribers; unsubscribe stops delivery', () => {
    const s = new ObservationStream();
    const writes: string[] = [];
    const fakeRes: any = { write: (chunk: string) => writes.push(chunk), writableEnded: false };
    const unsub = s.subscribe(fakeRes);
    s.publish({ type: 'new_observation', observation: { id: 'o1' } });
    expect(writes.some(w => w.startsWith('data: ') && w.includes('o1') && w.endsWith('\n\n'))).toBe(true);
    unsub();
    writes.length = 0;
    s.publish({ type: 'new_observation', observation: { id: 'o2' } });
    expect(writes.length).toBe(0); // no delivery after unsubscribe
  });
  test('publish never throws if a subscriber write fails', () => {
    const s = new ObservationStream();
    s.subscribe({ write: () => { throw new Error('broken pipe'); }, writableEnded: false } as any);
    expect(() => s.publish({ type: 'new_observation', observation: { id: 'x' } })).not.toThrow();
  });
});
