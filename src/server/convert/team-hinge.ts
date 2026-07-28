// SPDX-License-Identifier: Apache-2.0
//
// The `teams` row is a HINGE for the Go Team conversion: five of the seven
// COPY_TABLES carry a team_id FK back to it (projects, server_sessions,
// agent_events, observation_generation_jobs, observations). Without it the very
// first copied table fails and the convert dies before any row lands:
//
//   insert or update on table "projects" violates foreign key
//   constraint "projects_team_id_fkey"
//
// copy-engine.ts deliberately leaves teams out of COPY_TABLES, and that is
// right: teams sits alongside team_members, api_keys and server_settings as
// ACCOUNT state, which a remote may legitimately own for itself. Copying the
// whole account group would push local keys and settings onto someone else's
// server. So the row is ensured here instead — the minimum needed to satisfy the
// FK, and nothing more.
//
// Invariant: this NEVER modifies an existing remote team. A remote team may
// belong to another owner and carry its own name; converting a project into it
// must not rename or reset it.

export interface TeamHingeQueryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface TeamHingeInput {
  teamId: string;
  /** Display name used only when creating the row; defaults to the id. */
  teamName?: string;
}

export async function ensureRemoteTeamHinge(
  pool: TeamHingeQueryable,
  input: TeamHingeInput,
): Promise<{ created: boolean }> {
  const teamId = (input.teamId ?? '').trim();
  if (!teamId) {
    // Fail loudly rather than writing a hinge that satisfies no real FK.
    throw new Error('ensureRemoteTeamHinge: teamId is required');
  }

  const existing = await pool.query('SELECT id FROM teams WHERE id = $1', [teamId]);
  if (existing.rows.length > 0) return { created: false };

  // DO NOTHING, not DO UPDATE: a concurrent or racing convert may have inserted
  // it between the check and here, and the existing row wins either way.
  await pool.query(
    `INSERT INTO teams (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [teamId, (input.teamName ?? '').trim() || teamId],
  );
  return { created: true };
}
