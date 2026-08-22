// SPDX-License-Identifier: Apache-2.0
//
// REGRESSION: convert must land rows under the SOURCE project, not the key's project.
//
// Found by a real two-server convert, not by a unit test. applyImportBatch overwrote
// project_id with the AUTHENTICATED key's project — correct for a generic ingest route,
// wrong for a migration. Source rig-proj-A + a destination key scoped to dest-proj put
// all 3 observations under dest-proj. Convert still reported:
//     {"status":"converted","copiedByTable":{"observations":3}}
// while the intended project had ZERO rows.
//
// The fix cannot be "trust the row" either: that would let an authenticated caller write
// into a project it cannot reach. So the source projectId is VALIDATED against the key's
// entitlement — the same rule resolve-requested-project uses — and rejected otherwise.

import { describe, expect, it } from 'bun:test';
import { resolveImportProject } from '../../../src/server/convert/import-apply.js';

function poolWith(projectBelongsToTeam: boolean) {
  return {
    query: async (text: string) => {
      if (/SELECT id FROM projects/i.test(text)) {
        return { rows: projectBelongsToTeam ? [{ id: 'rig-proj-A' }] : [] };
      }
      return { rows: [] };
    },
  };
}

describe('resolveImportProject', () => {
  it('accepts the source project when the key is scoped to exactly it', async () => {
    const r = await resolveImportProject(poolWith(true), {
      requested: 'rig-proj-A', keyProjectId: 'rig-proj-A', keyTeamId: 't1',
    });
    expect(r).toEqual({ ok: true, projectId: 'rig-proj-A' });
  });

  it('accepts a source project that belongs to a TEAM-SCOPED key’s team', async () => {
    // A team-scoped key legitimately spans its team's projects, which is what an owner
    // converting into a shared team database holds.
    const r = await resolveImportProject(poolWith(true), {
      requested: 'rig-proj-A', keyProjectId: null, keyTeamId: 't1',
    });
    expect(r).toEqual({ ok: true, projectId: 'rig-proj-A' });
  });

  it('REJECTS a project the key cannot reach', async () => {
    // The security half: without this, the body field would be a write-anywhere lever.
    const r = await resolveImportProject(poolWith(false), {
      requested: 'someone-elses-project', keyProjectId: null, keyTeamId: 't1',
    });
    expect(r.ok).toBe(false);
  });

  it('REJECTS a different project when the key is scoped to one project', async () => {
    const r = await resolveImportProject(poolWith(true), {
      requested: 'other-proj', keyProjectId: 'rig-proj-A', keyTeamId: 't1',
    });
    expect(r.ok).toBe(false);
  });

  it('falls back to the key’s project when none is requested', async () => {
    // Back-compat: a caller that sends no projectId keeps today's behaviour.
    const r = await resolveImportProject(poolWith(true), {
      requested: undefined, keyProjectId: 'rig-proj-A', keyTeamId: 't1',
    });
    expect(r).toEqual({ ok: true, projectId: 'rig-proj-A' });
  });

  it('fails closed when the entitlement probe throws', async () => {
    const throwing = { query: async () => { throw new Error('db down'); } };
    const r = await resolveImportProject(throwing, {
      requested: 'rig-proj-A', keyProjectId: null, keyTeamId: 't1',
    });
    // A database error must never grant scope.
    expect(r.ok).toBe(false);
  });
});
