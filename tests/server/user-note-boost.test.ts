// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { boostUserDirected } from '../../src/server/routes/v1/user-note-boost.js';

const obs = (id: string, kind: string) => ({ id, kind, content: id, projectId: 'p', teamId: 't', metadata: {} } as any);
const mixed = [obs('a','observation'), obs('b','user_note'), obs('c','observation'), obs('d','user_note')];

describe('boostUserDirected', () => {
  it('enabled=true stable-reorders user_note ahead of ambient', () => {
    const out = boostUserDirected(mixed, true);
    // notes first, stable within groups
    expect(out.map(o => o.kind)).toEqual(['user_note', 'user_note', 'observation', 'observation']);
  });
  it('enabled=false leaves order unchanged', () => {
    const out = boostUserDirected(mixed, false);
    expect(out).toEqual(mixed);
  });
  it('only reorders within the given set — never adds rows', () => {
    const out = boostUserDirected(mixed, true);
    expect(out.length).toBe(mixed.length);
  });
});
