// tests/scripts/rig/rescope.test.ts
import { describe, it, expect } from 'bun:test';
import { rescopeRow, rescopeRows } from '../../../scripts/rig/snapshot-and-rescope.mjs';

const DOGFOOD = { team_id: 'ab8e1f17-020e-4794-bae3-e59885e7df05', project_id: '5fc024f0-0994-4f1d-baed-300d9b4d3416' };
const TARGET = { teamId: 'temp-team-uuid', projectId: 'temp-proj-uuid' };

describe('rescopeRow', () => {
  it('rewrites team_id and project_id to the target identity', () => {
    const out = rescopeRow({ ...DOGFOOD, id: 'o1', content: 'hi', kind: 'observation' }, TARGET);
    expect(out.team_id).toBe('temp-team-uuid');
    expect(out.project_id).toBe('temp-proj-uuid');
  });
  it('never leaves the source (dogfood) identity on the row', () => {
    const out = rescopeRow({ ...DOGFOOD, id: 'o1', content: 'hi' }, TARGET);
    expect(out.team_id).not.toBe(DOGFOOD.team_id);
    expect(out.project_id).not.toBe(DOGFOOD.project_id);
  });
  it('preserves all other fields (content, kind, id, metadata)', () => {
    const src = { ...DOGFOOD, id: 'o1', content: 'decision X', kind: 'user_note', metadata: { a: 1 } };
    const out = rescopeRow(src, TARGET);
    expect(out.id).toBe('o1'); expect(out.content).toBe('decision X');
    expect(out.kind).toBe('user_note'); expect(out.metadata).toEqual({ a: 1 });
  });
  it('rescopeRows maps every row', () => {
    const out = rescopeRows([{ ...DOGFOOD, id: 'a' }, { ...DOGFOOD, id: 'b' }], TARGET);
    expect(out.every(r => r.team_id === 'temp-team-uuid' && r.project_id === 'temp-proj-uuid')).toBe(true);
  });
});
