// SPDX-License-Identifier: Apache-2.0
//
// A fresh machine must NOT mint a key for a team it has not logged into.
//
// ensureProjectIdentity called ensureBaseKey unconditionally, which is right for
// a LOCAL project — a keyless marker makes every hook fall back to
// missing_api_key and silently drop observations, so the key guarantee exists to
// close that hole.
//
// It is wrong for an ADOPTED TEAM marker. A teammate clones a converted project,
// the marker says `runtime: 'server'`, and the first session minted a key for
// that team on this machine. The project then looked JOINED — team badge on, Join
// button off — while the user had joined nothing and no observation had ever
// reached the team. Verified live: api_keys.actor_id for the minted key was
// `system:local-hook-bootstrap`, i.e. self-issued, not team-issued.
//
// The product rule: a project with an identity but no access is LOCAL until the
// user logs in. Minting is for a project that has no identity yet, not for one
// whose identity says it belongs to a team this machine cannot reach.
//
// The local case must keep working exactly as before — that guarantee is what
// prevents dark capture.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureProjectIdentity } from '../../../src/services/identity/project-identity.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ms-nomint-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeMarker(m: Record<string, unknown>): void {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify(m), 'utf-8');
}

/** Pool that satisfies the upserts without a database. */
function fakePool() {
  return { query: async () => ({ rows: [], rowCount: 0 }) };
}

/** Records whether a key was minted, without touching the real store. */
function spyStore() {
  const stored: string[] = [];
  return {
    stored,
    resolveKeyForTeam: () => null,
    storeKeyForTeam: (teamId: string) => { stored.push(teamId); },
    storeKeyIfAbsent: (teamId: string, key: string) => { stored.push(teamId); return key; },
  };
}

describe('ensureProjectIdentity key minting', () => {
  it('does NOT mint for an adopted TEAM marker with no key held', async () => {
    // THE REGRESSION. This is the fresh-clone case: identity present, access
    // absent. Minting here is what made the project report as joined.
    writeMarker({ teamId: 'team-a', projectId: 'proj-a', runtime: 'server', serverUrl: 'https://x' });
    const store = spyStore();
    const ids = await ensureProjectIdentity(fakePool() as never, dir, store as never);

    expect(ids.projectId).toBe('proj-a');   // identity still adopted
    expect(store.stored).toEqual([]);       // but nothing minted
  });

  it('does not mint for a legacy server-beta team marker either', async () => {
    writeMarker({ teamId: 'team-a', projectId: 'proj-a', runtime: 'server-beta' });
    const store = spyStore();
    await ensureProjectIdentity(fakePool() as never, dir, store as never);
    expect(store.stored).toEqual([]);
  });

  it('DOES mint for a local project — dark capture must stay closed', async () => {
    // The guarantee ensureBaseKey exists for: a keyless local marker makes every
    // hook fall back to missing_api_key and drop observations silently.
    writeMarker({ teamId: 'team-local', projectId: 'proj-local' });
    const store = spyStore();
    await ensureProjectIdentity(fakePool() as never, dir, store as never);
    expect(store.stored).toEqual(['team-local']);
  });

  it('DOES mint for a marker explicitly on the local runtime', async () => {
    writeMarker({ teamId: 'team-local', projectId: 'proj-local', runtime: 'local' });
    const store = spyStore();
    await ensureProjectIdentity(fakePool() as never, dir, store as never);
    expect(store.stored).toEqual(['team-local']);
  });

  it('DOES mint for a brand-new project with no marker at all', async () => {
    // No identity yet: this is exactly what minting is for.
    const store = spyStore();
    const ids = await ensureProjectIdentity(fakePool() as never, dir, store as never);
    expect(store.stored).toEqual([ids.teamId]);
  });

  it('leaves an ALREADY-JOINED team project alone (key present, none minted)', async () => {
    // Once logged in, the cached team key resolves and ensureBaseKey has nothing
    // to do. Asserting it does not mint a second one.
    writeMarker({ teamId: 'team-a', projectId: 'proj-a', runtime: 'server' });
    const store = { ...spyStore(), resolveKeyForTeam: () => 'cmem_team_issued' };
    await ensureProjectIdentity(fakePool() as never, dir, store as never);
    expect(store.stored).toEqual([]);
  });
});
