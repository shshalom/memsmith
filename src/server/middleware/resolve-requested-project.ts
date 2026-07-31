// SPDX-License-Identifier: Apache-2.0
//
// Which project is this request about?
//
// The URL is authoritative for WHICH PROJECT you are viewing. The credential is
// authoritative for WHO YOU ARE. Those are different questions, and api-key mode
// conflated them: projectId came solely from the api_keys row, so "which project
// am I looking at" was decided by WHICH KEY happened to be in the loopback
// cookie.
//
// That made scope a property of a credential, with three consequences seen live:
//   - A bare page load reissues the cookie with the SERVER's project key, so the
//     dashboard silently re-scoped mid-session. The sidebar named one project
//     while the Runtime tile showed another's runtime.
//   - The cookie is per-ORIGIN, not per-tab, so two tabs on different projects
//     cannot both be correct; the last page load wins for both.
//   - The Go Team wizard converts whatever the request authenticates as, so a
//     bare reload before pressing GO TEAM aimed the convert at the wrong
//     project — the scope leak that once copied ~29,000 dogfood rows.
//
// Accepting a project from the request fixes that, but ONLY with an entitlement
// check. Without one, `?projectId=` is a scope-escalation vector: any valid key
// could read any project by appending a query string. So the request may only
// NARROW to something the key already reaches.
//
// ENTITLEMENT RULE — a key may scope to a project when either:
//   - the key's own project_id equals it (exact match, no query needed), or
//   - the key is TEAM-SCOPED (project_id IS NULL) and the project belongs to
//     that key's team. A team-wide key legitimately spans its team's projects;
//     it must never reach another team's.
//
// Everything else is denied, and a denial degrades to the key's own project
// rather than to null — returning null would 400 every read with "no project
// identity", trading a scoping bug for a hard failure.

export interface ProjectScopeQueryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ResolveRequestedProjectInput {
  /** Project asked for by the request (query param or body). */
  requested: string | undefined | null;
  /** project_id on the authenticated key. NULL means team-scoped. */
  keyProjectId: string | null;
  /** team_id on the authenticated key. */
  keyTeamId: string | null;
}

export interface ResolvedProjectScope {
  /** The project every read and write must use. Never widened by a request. */
  projectId: string | null;
  /**
   * Where it came from.
   *  'key'     — nothing requested; the key's own project.
   *  'request' — requested AND entitled.
   *  'denied'  — requested but NOT entitled; fell back to the key's project.
   *              Callers may log this; it is an authorization event.
   */
  source: 'key' | 'request' | 'denied';
}

/**
 * Resolve the project scope for a request, refusing any request that would widen
 * what the key already reaches.
 *
 * Never throws: a failed entitlement probe denies rather than propagating, so a
 * database blip cannot widen scope and cannot 500 the middleware.
 */
export async function resolveRequestedProject(
  pool: ProjectScopeQueryable,
  input: ResolveRequestedProjectInput,
): Promise<ResolvedProjectScope> {
  const requested = typeof input.requested === 'string' ? input.requested.trim() : '';

  // Nothing asked for — the key's own project stands. No DB round-trip.
  if (!requested) return { projectId: input.keyProjectId, source: 'key' };

  // Asked for exactly what the key already is. No probe needed, and this is the
  // common case for a project-scoped key on its own dashboard.
  if (input.keyProjectId && requested === input.keyProjectId) {
    return { projectId: requested, source: 'request' };
  }

  // A project-scoped key may not reach a DIFFERENT project, whatever the request
  // says. Denied without a query: the key's scope already answers it.
  if (input.keyProjectId) {
    return { projectId: input.keyProjectId, source: 'denied' };
  }

  // Team-scoped key (project_id IS NULL). Legitimate for its OWN team only, so
  // the probe filters on BOTH ids — matching on project alone would confirm the
  // project exists without confirming who owns it.
  if (!input.keyTeamId) {
    return { projectId: input.keyProjectId, source: 'denied' };
  }
  try {
    const result = await pool.query(
      'SELECT id FROM projects WHERE id = $1 AND team_id = $2 LIMIT 1',
      [requested, input.keyTeamId],
    );
    if (result.rows.length > 0) return { projectId: requested, source: 'request' };
    return { projectId: input.keyProjectId, source: 'denied' };
  } catch {
    // Fail closed. A DB error must never grant scope.
    return { projectId: input.keyProjectId, source: 'denied' };
  }
}
