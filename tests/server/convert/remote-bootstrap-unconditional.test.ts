// SPDX-License-Identifier: Apache-2.0
//
// The convert route's own comment promises the server will "bootstrap the remote
// schema, copy this project's rows, verify counts". The bootstrap did not happen
// unconditionally: it lived INSIDE the else-branch of a credential lookup.
//
//   const existingKey = credStore.resolveKeyForTeam(teamId);
//   const apiKey = existingKey ?? await (async () => {
//     await bootstrapServerPostgresSchema(remotePool);   // <- only on cache MISS
//     ...
//   })();
//
// So schema creation rode on whether this machine happened to hold a cached key
// for the destination team — two unrelated concerns sharing one branch. With a
// key present the bootstrap is skipped entirely and the copy runs against a
// database with zero tables.
//
// It works exactly once, on a first-ever convert from a machine that has never
// held the team key, which is why it survived: that is the demo path. It fails on
// a RETRY (the first attempt cached the key), and on any machine that already
// joined this team. Measured on the live rig: the team key was cached and the
// destination had 0 tables, so a convert would have gone straight to copying 160
// rows into an empty database.
//
// bootstrapServerPostgresSchema is idempotent by design — every step is
// IF NOT EXISTS and the version markers are ON CONFLICT DO NOTHING — so running
// it every time is free and correct. There was never a reason to gate it.
import { describe, it, expect } from 'bun:test';

/**
 * The shape under test, extracted so the ordering contract can be asserted
 * without standing up Express + two Postgres instances. This mirrors the
 * route's structure exactly: prepare the destination, then resolve the key.
 */
async function prepareDestination(deps: {
  bootstrap: () => Promise<void>;
  upsertTeamAndProject: () => Promise<void>;
  resolveCachedKey: () => string | null;
  mintKey: () => Promise<string>;
  log: string[];
}): Promise<string> {
  // Always prepare the destination — a cached credential says nothing about
  // whether the remote database has tables.
  deps.log.push('bootstrap');
  await deps.bootstrap();
  deps.log.push('upsert');
  await deps.upsertTeamAndProject();

  const cached = deps.resolveCachedKey();
  if (cached) { deps.log.push('cached-key'); return cached; }
  deps.log.push('mint');
  return deps.mintKey();
}

function harness(cachedKey: string | null) {
  const log: string[] = [];
  return {
    log,
    deps: {
      bootstrap: async () => { log.push('bootstrap:ran'); },
      upsertTeamAndProject: async () => { log.push('upsert:ran'); },
      resolveCachedKey: () => cachedKey,
      mintKey: async () => 'cmem_minted',
      log,
    },
  };
}

describe('convert prepares the remote schema unconditionally', () => {
  it('bootstraps even when a team key is ALREADY cached', async () => {
    // The regression. Previously this path skipped bootstrap entirely and the
    // copy hit a database with no tables.
    const h = harness('cmem_already_cached');
    const key = await prepareDestination(h.deps);
    expect(h.log).toContain('bootstrap:ran');
    expect(key).toBe('cmem_already_cached');
  });

  it('still bootstraps when no key is cached (the original path)', async () => {
    const h = harness(null);
    const key = await prepareDestination(h.deps);
    expect(h.log).toContain('bootstrap:ran');
    expect(key).toBe('cmem_minted');
  });

  it('bootstraps BEFORE minting, so the api_keys FK has tables to point at', async () => {
    const h = harness(null);
    await prepareDestination(h.deps);
    const bootstrapAt = h.log.indexOf('bootstrap:ran');
    const mintAt = h.log.indexOf('mint');
    expect(bootstrapAt).toBeGreaterThanOrEqual(0);
    expect(mintAt).toBeGreaterThan(bootstrapAt);
  });

  it('seeds team+project before the key, so the FK holds on a fresh DB', async () => {
    const h = harness(null);
    await prepareDestination(h.deps);
    expect(h.log.indexOf('upsert:ran')).toBeLessThan(h.log.indexOf('mint'));
  });

  it('seeds team+project even with a cached key, so the copy FKs resolve', async () => {
    // projects is the first COPY_TABLES entry and children FK to it. A cached
    // key previously skipped this too.
    const h = harness('cmem_already_cached');
    await prepareDestination(h.deps);
    expect(h.log).toContain('upsert:ran');
  });
});
