// SPDX-License-Identifier: Apache-2.0
//
// Project-scoping for the Go Team convert copy. Filters each COPY_TABLES read
// to a single project's rows and re-stamps the destination team_id on the
// direct-scoped tables. See docs/superpowers/specs/2026-07-23-scoped-convert-copy-design.md.

// Tables that carry (project_id, team_id) directly and get team_id re-stamped
// on copy. `projects` carries team_id too (its scope column is `id`).
export const DIRECT_SCOPED_TABLES = new Set<string>([
  'projects',
  'server_sessions',
  'agent_events',
  'observation_generation_jobs',
  'observations',
]);

// Table name → local read query scoped to $1 = projectId. Table names come only
// from COPY_TABLES (a fixed safe list — never user input).
export function buildScopedReadQuery(table: string, _projectId: string): { text: string } {
  switch (table) {
    case 'projects':
      return { text: 'SELECT * FROM projects WHERE id = $1' };
    case 'server_sessions':
    case 'agent_events':
    case 'observation_generation_jobs':
    case 'observations':
      return { text: `SELECT * FROM ${table} WHERE project_id = $1` };
    case 'observation_sources':
      return { text: 'SELECT * FROM observation_sources WHERE observation_id IN (SELECT id FROM observations WHERE project_id = $1)' };
    case 'observation_generation_job_events':
      return { text: 'SELECT * FROM observation_generation_job_events WHERE generation_job_id IN (SELECT id FROM observation_generation_jobs WHERE project_id = $1)' };
    default:
      throw new Error(`convert-scope: unexpected table ${table}`);
  }
}

// Remote/local scoped count query. Direct-scoped tables count by project_id
// (+ team_id on the remote side, supplied as $2 when teamId !== null).
export function buildScopedCountQuery(
  table: string,
  which: 'local' | 'remote',
): { text: string; params: (v: { projectId: string; teamId: string }) => unknown[] } {
  if (table === 'projects') {
    return which === 'remote'
      ? { text: 'SELECT count(*) FROM projects WHERE id = $1 AND team_id = $2', params: (v) => [v.projectId, v.teamId] }
      : { text: 'SELECT count(*) FROM projects WHERE id = $1', params: (v) => [v.projectId] };
  }
  if (DIRECT_SCOPED_TABLES.has(table)) {
    return which === 'remote'
      ? { text: `SELECT count(*) FROM ${table} WHERE project_id = $1 AND team_id = $2`, params: (v) => [v.projectId, v.teamId] }
      : { text: `SELECT count(*) FROM ${table} WHERE project_id = $1`, params: (v) => [v.projectId] };
  }
  // Lineage tables: count via the parent subquery (identical local/remote text;
  // the remote parent is already team-scoped by the copy).
  const q = buildScopedReadQuery(table, '').text.replace('SELECT *', 'SELECT count(*)');
  return { text: q, params: (v) => [v.projectId] };
}

// Re-stamp team_id → destination on direct-scoped tables; return rows unchanged
// for lineage tables. Never mutates input rows.
export function restampTeamId(
  table: string,
  rows: Array<Record<string, unknown>>,
  teamId: string,
): Array<Record<string, unknown>> {
  if (!DIRECT_SCOPED_TABLES.has(table)) return rows;
  return rows.map((r) => ({ ...r, team_id: teamId }));
}
