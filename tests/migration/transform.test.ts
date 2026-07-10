// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { transform, type SourceRow } from '../../scripts/migrate-claude-mem.js';

const TEAM = 'team-x';
const PROJ = 'proj-x';

function src(overrides: Partial<SourceRow>): SourceRow {
  return {
    id: 1, type: 'feature', title: 'T', subtitle: 'S', text: null,
    facts: '["a","b"]', narrative: null, concepts: '["c"]',
    files_read: null, files_modified: null, prompt_number: 3,
    discovery_tokens: 100, memory_session_id: 'sess-1',
    agent_type: null, agent_id: null, metadata: null,
    created_at: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('claude-mem → MemSmith transform', () => {
  it('preserves obs_type, resolves lifecycle, packs metadata, stable id', () => {
    const t = transform(src({}), TEAM, PROJ);
    expect(t.id).toBe('cmem-1');
    expect(t.team_id).toBe(TEAM);
    expect(t.project_id).toBe(PROJ);
    expect(t.kind).toBe('observation');
    expect(t.obs_type).toBe('feature');
    expect(t.lifecycle_state).toBe('resolved');
    expect(t.metadata.facts).toEqual(['a', 'b']);
    expect(t.metadata.concepts).toEqual(['c']);
    expect(t.metadata.source).toBe('claude-mem-migration');
    expect(t.metadata.source_id).toBe(1);
  });

  it('decisions stay active', () => {
    expect(transform(src({ type: 'decision' }), TEAM, PROJ).lifecycle_state).toBe('active');
  });

  it('content falls back to title+subtitle when text and narrative are null', () => {
    const t = transform(src({ text: null, narrative: null, title: 'Title', subtitle: 'Sub' }), TEAM, PROJ);
    expect(t.content).toBe('Title — Sub');
  });

  it('prefers text, then narrative', () => {
    expect(transform(src({ text: 'BODY', narrative: 'N' }), TEAM, PROJ).content).toBe('BODY');
    expect(transform(src({ text: null, narrative: 'N' }), TEAM, PROJ).content).toBe('N');
  });

  it('never throws on malformed facts JSON — wraps raw', () => {
    const t = transform(src({ facts: 'not json[' }), TEAM, PROJ);
    expect(t.metadata.facts).toEqual(['not json[']);
  });

  it('handles all-null optional fields without throwing', () => {
    const t = transform(src({ title: null, subtitle: null, text: null, narrative: null, facts: null, concepts: null }), TEAM, PROJ);
    expect(t.content).toBe('(no content)');
    expect(t.metadata.facts).toEqual([]);
  });
});
