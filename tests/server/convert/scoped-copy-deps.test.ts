import { describe, it, expect } from 'bun:test';
import {
  buildScopedReadQuery,
  restampTeamId,
  DIRECT_SCOPED_TABLES,
} from '../../../src/server/routes/v1/convert-scope.js';

describe('buildScopedReadQuery', () => {
  it('scopes projects by id', () => {
    expect(buildScopedReadQuery('projects', 'p1').text)
      .toBe('SELECT * FROM projects WHERE id = $1');
  });
  it('scopes direct project tables by project_id', () => {
    for (const t of ['server_sessions', 'agent_events', 'observation_generation_jobs', 'observations']) {
      expect(buildScopedReadQuery(t, 'p1').text)
        .toBe(`SELECT * FROM ${t} WHERE project_id = $1`);
    }
  });
  it('scopes observation_sources via parent observations', () => {
    expect(buildScopedReadQuery('observation_sources', 'p1').text)
      .toBe('SELECT * FROM observation_sources WHERE observation_id IN (SELECT id FROM observations WHERE project_id = $1)');
  });
  it('scopes job events via parent jobs', () => {
    expect(buildScopedReadQuery('observation_generation_job_events', 'p1').text)
      .toBe('SELECT * FROM observation_generation_job_events WHERE generation_job_id IN (SELECT id FROM observation_generation_jobs WHERE project_id = $1)');
  });
});

describe('restampTeamId', () => {
  it('rewrites team_id on direct-scoped tables', () => {
    const out = restampTeamId('observations', [{ id: 'o1', team_id: 'local', project_id: 'p1' }], 'dest');
    expect(out[0]).toMatchObject({ id: 'o1', team_id: 'dest', project_id: 'p1' });
  });
  it('re-stamps projects team_id too', () => {
    const out = restampTeamId('projects', [{ id: 'p1', team_id: 'local' }], 'dest');
    expect(out[0]!.team_id).toBe('dest');
  });
  it('leaves lineage tables untouched (no team_id column)', () => {
    const row = { id: 's1', observation_id: 'o1' };
    const out = restampTeamId('observation_sources', [{ ...row }], 'dest');
    expect(out[0]).toEqual(row);
    expect(DIRECT_SCOPED_TABLES).not.toContain('observation_sources');
  });
});
