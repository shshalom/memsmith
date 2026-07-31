// SPDX-License-Identifier: Apache-2.0
//
// The URL is authoritative for WHICH PROJECT you are viewing. The credential is
// authoritative for WHO YOU ARE. Those are different questions and were conflated.
//
// Before this change, api-key mode derived projectId solely from the api_keys row,
// so "which project am I looking at" was decided by WHICH KEY happened to be in
// the loopback cookie. Consequences observed live:
//   - A bare page load reissued the cookie with the SERVER's project key, so the
//     whole dashboard silently re-scoped mid-session. Sidebar said one project,
//     the Runtime tile showed another's runtime.
//   - The cookie is per-origin, not per-tab, so two tabs on different projects
//     cannot both be right — the last page load wins for both.
//   - The Go Team wizard converts whatever the request authenticates as, so a
//     bare reload before pressing GO TEAM aimed the convert at the wrong project.
//     That is the scope leak that once copied ~29,000 dogfood rows.
//
// The fix accepts ?projectId= in api-key mode — but ONLY after verifying the
// authenticated key is entitled to that project. Without that check the param is
// a scope-escalation vector: anyone with any valid key could read any project by
// appending a query string. THAT is the security-critical half, and it is what
// most of this file tests.
//
// Entitlement rule: a key may scope to a project when the key's own project_id
// matches it, OR the key is team-scoped (project_id IS NULL) and the project
// belongs to that key's team. A team-wide key legitimately spans its team's
// projects; it must never reach another team's.
import { describe, it, expect } from 'bun:test';
import { resolveRequestedProject } from '../../../src/server/middleware/resolve-requested-project.js';

/** Fake pool answering the entitlement probe. */
function pool(rows: Array<{ id: string; team_id: string }>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      // Honour BOTH bound params, exactly as the real SQL does. An earlier
      // version filtered on project id only, so the cross-tenant refusal test
      // passed a row through and reported the FIX as broken — the harness was
      // wrong, not the code. A fake that ignores a WHERE clause cannot test a
      // guard that depends on it.
      const wantedId = String(values[0] ?? '');
      const wantedTeam = String(values[1] ?? '');
      return { rows: rows.filter(r => r.id === wantedId && r.team_id === wantedTeam) };
    },
  };
}

const KEY_TEAM = 'team-a';

describe('resolveRequestedProject — no request scope', () => {
  it('falls back to the key\'s own project when nothing is requested', async () => {
    const p = pool([]);
    const out = await resolveRequestedProject(p as never, {
      requested: undefined, keyProjectId: 'proj-key', keyTeamId: KEY_TEAM,
    });
    expect(out).toEqual({ projectId: 'proj-key', source: 'key' });
    // No DB round-trip when there is nothing to verify.
    expect(p.calls).toHaveLength(0);
  });

  it('treats a blank or whitespace request as absent', async () => {
    for (const requested of ['', '   ']) {
      const out = await resolveRequestedProject(pool([]) as never, {
        requested, keyProjectId: 'proj-key', keyTeamId: KEY_TEAM,
      });
      expect(out.projectId).toBe('proj-key');
    }
  });
});

describe('resolveRequestedProject — entitled requests', () => {
  it('honors a request for the key\'s OWN project', async () => {
    const out = await resolveRequestedProject(pool([]) as never, {
      requested: 'proj-key', keyProjectId: 'proj-key', keyTeamId: KEY_TEAM,
    });
    expect(out).toEqual({ projectId: 'proj-key', source: 'request' });
  });

  it('honors a team-scoped key requesting a project in its OWN team', async () => {
    // project_id IS NULL means the key spans its team; that is legitimate.
    const p = pool([{ id: 'proj-b', team_id: KEY_TEAM }]);
    const out = await resolveRequestedProject(p as never, {
      requested: 'proj-b', keyProjectId: null, keyTeamId: KEY_TEAM,
    });
    expect(out).toEqual({ projectId: 'proj-b', source: 'request' });
  });
});

describe('resolveRequestedProject — REFUSALS (the security half)', () => {
  it('REFUSES a project-scoped key reaching for a DIFFERENT project', async () => {
    // Without this, appending ?projectId= to any request reads any project.
    const p = pool([{ id: 'proj-other', team_id: KEY_TEAM }]);
    const out = await resolveRequestedProject(p as never, {
      requested: 'proj-other', keyProjectId: 'proj-key', keyTeamId: KEY_TEAM,
    });
    expect(out.source).toBe('denied');
  });

  it('REFUSES a team-scoped key reaching into ANOTHER team\'s project', async () => {
    // Cross-tenant. The project exists, but not in this key's team.
    const p = pool([{ id: 'proj-x', team_id: 'team-OTHER' }]);
    const out = await resolveRequestedProject(p as never, {
      requested: 'proj-x', keyProjectId: null, keyTeamId: KEY_TEAM,
    });
    expect(out.source).toBe('denied');
  });

  it('REFUSES a project that does not exist', async () => {
    const out = await resolveRequestedProject(pool([]) as never, {
      requested: 'proj-ghost', keyProjectId: null, keyTeamId: KEY_TEAM,
    });
    expect(out.source).toBe('denied');
  });

  it('REFUSES when the key has no team at all', async () => {
    // A teamless key cannot be entitled to anything by team membership.
    const p = pool([{ id: 'proj-b', team_id: KEY_TEAM }]);
    const out = await resolveRequestedProject(p as never, {
      requested: 'proj-b', keyProjectId: null, keyTeamId: null,
    });
    expect(out.source).toBe('denied');
  });

  it('FAILS CLOSED when the entitlement probe throws', async () => {
    // A database error must never widen scope. Denying is the safe direction:
    // the caller keeps the key's own project.
    const broken = { async query() { throw new Error('pg down'); } };
    const out = await resolveRequestedProject(broken as never, {
      requested: 'proj-b', keyProjectId: 'proj-key', keyTeamId: KEY_TEAM,
    });
    expect(out.source).toBe('denied');
    expect(out.projectId).toBe('proj-key');
  });

  it('a denied request keeps the key\'s project, never null', async () => {
    // Returning null would 400 every read ("no project identity") — a denial
    // must degrade to the key's own scope, not to no scope.
    const p = pool([{ id: 'proj-other', team_id: KEY_TEAM }]);
    const out = await resolveRequestedProject(p as never, {
      requested: 'proj-other', keyProjectId: 'proj-key', keyTeamId: KEY_TEAM,
    });
    expect(out.projectId).toBe('proj-key');
  });

  it('scopes the entitlement query by BOTH project and team', async () => {
    // A probe on project id alone would confirm existence without ownership.
    const p = pool([{ id: 'proj-b', team_id: KEY_TEAM }]);
    await resolveRequestedProject(p as never, {
      requested: 'proj-b', keyProjectId: null, keyTeamId: KEY_TEAM,
    });
    expect(p.calls[0]!.values).toContain('proj-b');
    expect(p.calls[0]!.values).toContain(KEY_TEAM);
  });
});
