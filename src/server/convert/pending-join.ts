// SPDX-License-Identifier: Apache-2.0
//
// The handoff between the two processes involved in a Go Team convert.
//
// The server copies the data — it is the only party that knows the remote URL —
// but must NOT write the project's marker. Letting it do so is what allowed a
// convert of one project to flip another's marker, because a shared server can
// only ever guess at project directories.
//
// The project's own session hook writes the marker (it genuinely runs in that
// directory), but it has no idea a conversion happened. So the server leaves a
// note ON THE DESTINATION DATABASE, in that project's own `projects.metadata`
// row. The hook already authenticates against that database with this team's key,
// so on its next run it can claim its own note and apply it locally.
//
// THE NOTE CARRIES NO CREDENTIAL. The hook resolves the team key from
// CredentialStore by teamId (runtime-selector.ts:118-127), and the convert's mint
// already cached it there (project-identity.ts:246). Putting an api key in a
// database row would store a secret that nothing reads.
//
// Every read is fail-safe: a malformed, half-written, or unreachable note returns
// null rather than throwing, because this runs on session start and must never
// break a session.

export interface PendingJoinQueryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** metadata key holding the note. Namespaced to avoid colliding with anything else. */
export const PENDING_JOIN_KEY = 'memsmith_pending_team_join';

export interface PendingJoin {
  teamId: string;
  serverUrl: string;
}

export interface RecordPendingJoinInput {
  projectId: string;
  teamId: string;
  serverUrl: string;
}

export async function recordPendingJoin(
  pool: PendingJoinQueryable,
  input: RecordPendingJoinInput,
): Promise<void> {
  const projectId = (input.projectId ?? '').trim();
  const teamId = (input.teamId ?? '').trim();
  const serverUrl = (input.serverUrl ?? '').trim();
  if (!projectId) throw new Error('recordPendingJoin: projectId is required');
  if (!teamId) throw new Error('recordPendingJoin: teamId is required');
  if (!serverUrl) throw new Error('recordPendingJoin: serverUrl is required');

  // Note deliberately contains ONLY teamId + serverUrl — never a key.
  const note: PendingJoin = { teamId, serverUrl };
  // `||` merges at the top level, preserving any other metadata keys.
  await pool.query(
    `UPDATE projects SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [JSON.stringify({ [PENDING_JOIN_KEY]: note }), projectId],
  );
}

export async function readPendingJoin(
  pool: PendingJoinQueryable,
  projectId: string,
): Promise<PendingJoin | null> {
  try {
    const result = await pool.query('SELECT metadata FROM projects WHERE id = $1', [projectId]);
    const row = result.rows[0] as { metadata?: unknown } | undefined;
    if (!row) return null;
    const metadata = row.metadata;
    if (!metadata || typeof metadata !== 'object') return null;
    const note = (metadata as Record<string, unknown>)[PENDING_JOIN_KEY];
    if (!note || typeof note !== 'object') return null;
    const { teamId, serverUrl } = note as Record<string, unknown>;
    // Both fields are required; a partial note is not actionable.
    if (typeof teamId !== 'string' || !teamId.trim()) return null;
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) return null;
    return { teamId, serverUrl };
  } catch {
    // Session start must survive an unreachable or broken remote.
    return null;
  }
}

/** Remove the note so it is applied exactly once. */
export async function clearPendingJoin(
  pool: PendingJoinQueryable,
  projectId: string,
): Promise<void> {
  try {
    await pool.query(
      `UPDATE projects SET metadata = COALESCE(metadata, '{}'::jsonb) - $1
        WHERE id = $2`,
      [PENDING_JOIN_KEY, projectId],
    );
  } catch {
    // Best-effort: a note that fails to clear is re-applied next session, and
    // applyConvertJoin is idempotent (same marker, same key).
  }
}
