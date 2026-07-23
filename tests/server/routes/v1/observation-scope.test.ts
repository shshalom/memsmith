// tests/server/routes/v1/observation-scope.test.ts
import { describe, it, expect } from 'bun:test';
import { ServerV1PostgresRoutes } from '../../../../src/server/routes/v1/ServerV1PostgresRoutes.js';

function routes() {
  return new ServerV1PostgresRoutes({
    pool: { query: async () => ({ rows: [] }), connect: async () => ({}) },
    queueManager: { getQueue: () => null, resolveQueue: () => null },
  } as any);
}

describe('observationScope predicate', () => {
  it('project-scoped: id + team + project, 3 params', () => {
    const r = (routes() as any).observationScope('obs1', 'team1', 'proj1');
    expect(r.where).toBe('id = $1 AND team_id = $2 AND project_id = $3');
    expect(r.params).toEqual(['obs1', 'team1', 'proj1']);
  });
  it('team-scoped (null project): id + team, 2 params', () => {
    const r = (routes() as any).observationScope('obs1', 'team1', null);
    expect(r.where).toBe('id = $1 AND team_id = $2');
    expect(r.params).toEqual(['obs1', 'team1']);
  });
});
