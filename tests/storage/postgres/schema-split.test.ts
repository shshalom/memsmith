// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import { ACCOUNT_SCHEMA_SQL, PROJECT_SCHEMA_SQL, HINGE_SCHEMA_SQL } from '../../../src/storage/postgres/schema.js';

const ACCOUNT = ['api_keys', 'team_members', 'usage_events', 'audit_log', 'rate_limit_counters'];
const DATA = ['observations', 'observation_sources', 'agent_events', 'server_sessions', 'observation_generation_jobs', 'observation_generation_job_events'];
const HINGE = ['teams', 'projects', 'server_beta_schema_migrations'];

const creates = (sql: string) => [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map(m => m[1]);

describe('schema split', () => {
  it('hinge SQL creates exactly the hinge tables', () => {
    expect(creates(HINGE_SCHEMA_SQL).sort()).toEqual([...HINGE].sort());
  });
  it('account SQL creates account tables and NO data tables', () => {
    const t = creates(ACCOUNT_SCHEMA_SQL);
    for (const a of ACCOUNT) expect(t).toContain(a);
    for (const d of DATA) expect(t).not.toContain(d);
  });
  it('project SQL creates data tables and NO account tables', () => {
    const t = creates(PROJECT_SCHEMA_SQL);
    for (const d of DATA) expect(t).toContain(d);
    for (const a of ACCOUNT) expect(t).not.toContain(a);
  });
  it('every data table keeps its projects/teams FK (hinge anchor preserved)', () => {
    // The composite FK to projects(id, team_id) must survive the split.
    expect(PROJECT_SCHEMA_SQL).toContain('REFERENCES projects(id, team_id)');
    expect(PROJECT_SCHEMA_SQL).toContain('REFERENCES teams(id)');
  });
  it('no CREATE TABLE is lost: full = hinge + account + project (union)', () => {
    const union = new Set([...creates(HINGE_SCHEMA_SQL), ...creates(ACCOUNT_SCHEMA_SQL), ...creates(PROJECT_SCHEMA_SQL)]);
    for (const t of [...ACCOUNT, ...DATA, ...HINGE]) expect(union.has(t)).toBe(true);
  });
});
