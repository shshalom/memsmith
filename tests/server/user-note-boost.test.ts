// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { boostUserDirected } from '../../src/server/routes/v1/user-note-boost.js';

const obs = (id: string, kind: string) => ({ id, kind, content: id, projectId: 'p', teamId: 't', metadata: {} } as any);

describe('boostUserDirected', () => {
  it('strength>0 stable-reorders user_note ahead of ambient, preserving relative order within each group', () => {
    const ranked = [obs('a','observation'), obs('b','user_note'), obs('c','observation'), obs('d','user_note')];
    const out = boostUserDirected(ranked, 1).map(o => o.id);
    expect(out).toEqual(['b','d','a','c']); // notes first (b before d), ambient after (a before c)
  });
  it('strength=0 leaves order unchanged', () => {
    const ranked = [obs('a','observation'), obs('b','user_note')];
    expect(boostUserDirected(ranked, 0).map(o=>o.id)).toEqual(['a','b']);
  });
  it('only reorders within the given (already-relevant) set — never adds rows', () => {
    const ranked = [obs('a','observation'), obs('b','user_note')];
    expect(boostUserDirected(ranked, 1).length).toBe(2);
  });
});
