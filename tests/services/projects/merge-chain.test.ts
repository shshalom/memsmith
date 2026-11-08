import { describe, it, expect } from 'bun:test';
import { MAX_MERGE_HOPS, resolveMergeChain } from '../../../src/services/projects/merge-chain.js';

function pool(projects: Record<string, { team: string; mergedInto?: string }>) {
  return {
    query: async (_sql: string, values?: unknown[]) => {
      const p = projects[String(values?.[0])];
      return { rows: p ? [{ team_id: p.team, merged_into: p.mergedInto ?? null }] : [] };
    },
  };
}

describe('resolveMergeChain', () => {
  it('leaves an active project alone', async () => {
    expect(await resolveMergeChain(pool({ a: { team: 'ta' } }), 'a')).toEqual({ kind: 'active' });
  });

  it('leaves a project the server does not know alone', async () => {
    expect(await resolveMergeChain(pool({}), 'x')).toEqual({ kind: 'active' });
  });

  it('follows a merge to the target and its team', async () => {
    expect(await resolveMergeChain(pool({ a: { team: 'ta', mergedInto: 'b' }, b: { team: 'tb' } }), 'a'))
      .toEqual({ kind: 'redirect', projectId: 'b', teamId: 'tb', via: ['a'] });
  });

  it('follows a chain of merges to the end', async () => {
    const chain = pool({ a: { team: 't', mergedInto: 'b' }, b: { team: 't', mergedInto: 'c' }, c: { team: 'tc' } });
    expect(await resolveMergeChain(chain, 'a')).toEqual({ kind: 'redirect', projectId: 'c', teamId: 'tc', via: ['a', 'b'] });
  });

  it('refuses a cycle', async () => {
    const cycle = pool({ a: { team: 't', mergedInto: 'b' }, b: { team: 't', mergedInto: 'a' } });
    expect(await resolveMergeChain(cycle, 'a')).toMatchObject({ kind: 'broken', reason: expect.stringContaining('cycle') });
  });

  it('refuses a chain longer than the cap', async () => {
    const projects: Record<string, { team: string; mergedInto?: string }> = {};
    for (let i = 0; i <= MAX_MERGE_HOPS + 1; i++) projects[`p${i}`] = { team: 't', mergedInto: `p${i + 1}` };
    projects[`p${MAX_MERGE_HOPS + 2}`] = { team: 't' };
    expect(await resolveMergeChain(pool(projects), 'p0')).toMatchObject({ kind: 'broken', reason: expect.stringContaining('more than') });
  });

  it('refuses a merge whose target no longer exists', async () => {
    expect(await resolveMergeChain(pool({ a: { team: 't', mergedInto: 'gone' } }), 'a'))
      .toMatchObject({ kind: 'broken', reason: expect.stringContaining('gone') });
  });
});
