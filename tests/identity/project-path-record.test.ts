// SPDX-License-Identifier: Apache-2.0
//
// Nothing on this machine records WHERE a project lives. The server's
// projects.metadata is {} for every row, the browser never receives a path, and
// server_sessions has no cwd column. That gap is why the Go Team convert could
// not complete the flip itself: the only party that knows the directory is the
// session hook, which runs in it.
//
// ensureProjectIdentity already receives the full cwd and throws away everything
// but basename(cwd) for the project's display name (project-identity.ts:160).
// Recording the path there costs nothing extra and is what lets a later convert
// resolve the right marker WITHOUT the server guessing — the guess being the bug
// that copied one project's memory into another's remote.
//
// The path is NOT a secret (the marker it points at is explicitly non-secret),
// but it is also not authoritative: a project can move. Consumers must verify the
// marker at that path still belongs to the project before acting on it, which is
// what applyConvertJoin already enforces.
import { describe, it, expect } from 'bun:test';
import { upsertTeamAndProject, PROJECT_PATH_KEY } from '../../src/services/identity/project-identity.js';

type Call = { text: string; values: unknown[] };

function fakePool() {
  const calls: Call[] = [];
  return {
    calls,
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
  };
}

function projectUpsert(calls: Call[]): Call | undefined {
  return calls.find(c => /INSERT INTO projects/i.test(c.text));
}

describe('upsertTeamAndProject records the project path', () => {
  it('persists the cwd so a later convert can find the right marker', async () => {
    const pool = fakePool();
    await upsertTeamAndProject(pool as any, 'team-a', 'proj-a', 'ms-p3-fresh', '/private/tmp/ms-p3-fresh');
    const call = projectUpsert(pool.calls)!;
    expect(JSON.stringify(call.values)).toContain('/private/tmp/ms-p3-fresh');
    expect(call.text).toMatch(/metadata/i);
  });

  it('namespaces the key so it cannot collide with other metadata', async () => {
    const pool = fakePool();
    await upsertTeamAndProject(pool as any, 'team-a', 'proj-a', 'n', '/p/a');
    expect(JSON.stringify(pool.calls)).toContain(PROJECT_PATH_KEY);
  });

  it('MERGES metadata rather than replacing it', async () => {
    // A pending team-join note lives in this same jsonb column. Replacing the
    // object would silently discard it and strand a conversion.
    const pool = fakePool();
    await upsertTeamAndProject(pool as any, 'team-a', 'proj-a', 'n', '/p/a');
    const call = projectUpsert(pool.calls)!;
    expect(call.text).toMatch(/\|\|/); // jsonb merge operator
  });

  it('updates the path when a project moves', async () => {
    // Unlike `name` (which is only healed while still a placeholder), the path
    // must always reflect reality — a stale path points at another project's
    // marker, or none.
    const pool = fakePool();
    await upsertTeamAndProject(pool as any, 'team-a', 'proj-a', 'n', '/new/location');
    const call = projectUpsert(pool.calls)!;
    expect(call.text).toMatch(/DO UPDATE/i);
    expect(JSON.stringify(call.values)).toContain('/new/location');
  });

  it('still works when no path is supplied (callers that lack one)', async () => {
    const pool = fakePool();
    await upsertTeamAndProject(pool as any, 'team-a', 'proj-a', 'n');
    const call = projectUpsert(pool.calls);
    expect(call).toBeDefined();
    expect(JSON.stringify(call!.values)).not.toContain(PROJECT_PATH_KEY);
  });

  it('ignores a blank path rather than recording an empty string', async () => {
    const pool = fakePool();
    await upsertTeamAndProject(pool as any, 'team-a', 'proj-a', 'n', '   ');
    expect(JSON.stringify(pool.calls)).not.toContain(PROJECT_PATH_KEY);
  });

  it('does not disturb the existing team, name, or owner behaviour', async () => {
    // Regression guard: this function also establishes the team and the local
    // owner (commit 0b03d814), both of which gate the Go Team wizard.
    const pool = fakePool();
    await upsertTeamAndProject(pool as any, 'team-a', 'proj-a', 'ms-p3-fresh', '/p/a');
    const all = JSON.stringify(pool.calls);
    expect(all).toContain('INSERT INTO teams');
    expect(all).toContain('team_members');
    expect(all).toContain('owner');
    expect(projectUpsert(pool.calls)!.values).toContain('ms-p3-fresh');
  });
});
