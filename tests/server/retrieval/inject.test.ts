import { describe, it, expect } from 'bun:test';
import { buildInjectionBlock } from '../../../src/server/retrieval/inject.js';

const fakeDeps = (rows: any[]) => ({ hybridSearch: async () => rows });

describe('buildInjectionBlock', () => {
  it('builds a labelled block from retrieved memory', async () => {
    const block = await buildInjectionBlock(
      fakeDeps([{ content: 'auth uses JWT', metadata: {} }, { content: 'payments retry on 500', metadata: {} }]),
      { projectId: 'p1', teamId: 'tm1', query: 'auth' }
    );
    expect(block).toContain('Relevant team memory');
    expect(block).toContain('auth uses JWT');
  });
  it('excludes observations flagged private', async () => {
    const block = await buildInjectionBlock(
      fakeDeps([{ content: 'SECRET internal', metadata: { private: true } }, { content: 'public note', metadata: {} }]),
      { projectId: 'p1', teamId: 'tm1', query: 'x' }
    );
    expect(block).not.toContain('SECRET internal');
    expect(block).toContain('public note');
  });
  it('returns empty string when nothing relevant', async () => {
    expect(await buildInjectionBlock(fakeDeps([]), { projectId: 'p1', teamId: 'tm1', query: 'x' })).toBe('');
  });
});
