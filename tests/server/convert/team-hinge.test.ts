// SPDX-License-Identifier: Apache-2.0
//
// The Go Team convert crashed on a fresh remote database:
//
//   insert or update on table "projects" violates foreign key
//   constraint "projects_team_id_fkey"
//
// copy-engine.ts deliberately excludes teams/team_members from COPY_TABLES with
// the note "the destination team already exists (see scoped-convert-copy spec,
// D2)". That holds for the case the spec had in mind — an admin who provisioned
// a team on the remote first, then converts a project into it. It is false for
// the case the wizard actually presents: "here is an empty Postgres, go team".
// `projects` is the first table copied, its team_id FK has nothing to point at,
// and the whole convert dies before a single row lands.
//
// The fix is NOT to add teams to COPY_TABLES — that would also drag in
// team_members, api_keys and server_settings, copying local account state onto a
// remote that may legitimately own its own. Instead the team row is treated as
// what it is: a HINGE the project rows depend on, ensured to exist immediately
// after the schema bootstrap and before any copy.
import { describe, it, expect } from 'bun:test';
import { ensureRemoteTeamHinge } from '../../../src/server/convert/team-hinge.js';

type Call = { text: string; values: unknown[] };

function fakePool(opts: { existingTeamIds?: string[] } = {}) {
  const calls: Call[] = [];
  const existing = new Set(opts.existingTeamIds ?? []);
  return {
    calls,
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (/SELECT[\s\S]*FROM teams/i.test(text)) {
        const id = String(values[0]);
        return { rows: existing.has(id) ? [{ id }] : [] };
      }
      return { rows: [] };
    },
  };
}

describe('ensureRemoteTeamHinge', () => {
  it('inserts the team row when the remote has no such team', async () => {
    const pool = fakePool();
    await ensureRemoteTeamHinge(pool as any, { teamId: 'team-1', teamName: 'my-project' });

    const insert = pool.calls.find(c => /INSERT INTO teams/i.test(c.text));
    expect(insert).toBeDefined();
    expect(insert!.values).toContain('team-1');
  });

  it('is idempotent — a second run does not fail or duplicate', async () => {
    // Convert is explicitly retryable (the card offers Retry), so this runs
    // again on every attempt.
    const pool = fakePool({ existingTeamIds: ['team-1'] });
    await ensureRemoteTeamHinge(pool as any, { teamId: 'team-1', teamName: 'my-project' });

    const insert = pool.calls.find(c => /INSERT INTO teams/i.test(c.text));
    // Either it skipped the insert, or the insert is conflict-guarded. Both are
    // acceptable; silently overwriting the remote team is not.
    if (insert) expect(insert.text).toMatch(/ON CONFLICT/i);
  });

  it('never overwrites an existing remote team row', async () => {
    // A remote team may be owned by someone else and carry its own name and
    // settings. Converting a project INTO it must not rename or reset it.
    const pool = fakePool({ existingTeamIds: ['team-1'] });
    await ensureRemoteTeamHinge(pool as any, { teamId: 'team-1', teamName: 'local-name' });

    for (const c of pool.calls) {
      expect(c.text).not.toMatch(/^\s*UPDATE\s+teams/i);
      if (/INSERT INTO teams/i.test(c.text)) {
        expect(c.text).not.toMatch(/DO UPDATE/i);
      }
    }
  });

  it('falls back to the team id as the name when none is supplied', async () => {
    const pool = fakePool();
    await ensureRemoteTeamHinge(pool as any, { teamId: 'team-2' });

    const insert = pool.calls.find(c => /INSERT INTO teams/i.test(c.text));
    expect(insert).toBeDefined();
    expect(insert!.values).toContain('team-2');
  });

  it('rejects an empty team id rather than writing a bogus hinge', async () => {
    const pool = fakePool();
    await expect(
      ensureRemoteTeamHinge(pool as any, { teamId: '', teamName: 'x' }),
    ).rejects.toThrow();
    expect(pool.calls.find(c => /INSERT INTO teams/i.test(c.text))).toBeUndefined();
  });

  it('parameterizes the team id instead of interpolating it', async () => {
    // The id reaches here from a project marker; it must never be concatenated
    // into SQL.
    const pool = fakePool();
    await ensureRemoteTeamHinge(pool as any, { teamId: "team'; DROP TABLE teams;--", teamName: 'x' });

    for (const c of pool.calls) {
      expect(c.text).not.toContain('DROP TABLE');
    }
  });
});
