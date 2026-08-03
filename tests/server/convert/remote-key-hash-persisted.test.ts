// SPDX-License-Identifier: Apache-2.0
//
// Convert must leave the team key VALIDATABLE ON THE REMOTE, or no teammate can
// ever join.
//
// The route resolved the key like this:
//
//   apiKey = credStore.resolveKeyForTeam(input.teamId)
//     ?? await ensureBaseKey(remotePool, input.teamId, input.projectId, credStore);
//
// `??` short-circuits. A local install ALWAYS has a cached key for its own team
// (local mode mints one at first boot), so the left side always won and
// ensureBaseKey — the only thing that writes the hash into the remote's
// api_keys — never ran against the destination.
//
// The owner never notices: the owner authenticates against their LOCAL base
// database, where the hash does exist. But runJoin validates the teammate's key
// on the REMOTE:
//
//   SELECT team_id, revoked_at, expires_at FROM api_keys WHERE key_hash = $1
//
// Zero rows, so every genuine invite was rejected with "that key is not valid
// for this workspace" — the join accept path could not succeed for anyone.
//
// MEASURED ON THE LIVE RIG after two successful converts:
//   projects      2 rows   (copied)
//   team_members  1 row    (owner)
//   api_keys      0 rows   <- the hole
//
// This is the same shape as remote-bootstrap-unconditional (schema creation
// gated on a credential-cache hit). That fix made bootstrap and upsert
// unconditional but left the key-hash insert behind the same `??`, because
// reusing the cached PLAINTEXT looked like the whole job. Reusing the plaintext
// is correct — minting a second key is the bug that comment warns about. What
// was missing is persisting the reused key's HASH where the remote can check it.
//
// ensureBaseKey already does exactly the right thing when called with a cached
// key present: its cache/DB-drift branch verifies the hash and re-inserts it via
// insertApiKeyHash if absent, returning the cached plaintext UNCHANGED. So
// calling it unconditionally is idempotent and mints nothing new.
import { describe, it, expect } from 'bun:test';

/**
 * The route's key-resolution shape, extracted so the contract can be asserted
 * without standing up Express plus two Postgres instances.
 *
 * `ensureBaseKey` here models the real function's contract: return the cached
 * plaintext when one exists (inserting its hash if the remote lacks it), else
 * mint. It must NEVER return a different key than the one already cached.
 */
async function resolveConvertKey(deps: {
  resolveCachedKey: () => string | null;
  /** Models ensureBaseKey(remotePool, ...) — the only writer of remote api_keys. */
  ensureBaseKey: () => Promise<string>;
}): Promise<string> {
  // Unconditional: a cached plaintext says nothing about whether the REMOTE can
  // validate its hash. ensureBaseKey reuses the cached key and only fills in the
  // missing hash, so this neither mints nor rotates.
  return deps.ensureBaseKey();
}

interface RemoteRow { key_hash: string; team_id: string }

/**
 * A remote whose api_keys starts EMPTY — the real post-convert rig state.
 * ensureBaseKey models the production function: reuse cached plaintext, insert
 * the hash only when absent.
 */
function harness(cachedKey: string | null) {
  const remoteApiKeys: RemoteRow[] = [];
  const log: string[] = [];
  let minted = 0;

  const hash = (k: string) => `sha256(${k})`;

  return {
    remoteApiKeys,
    log,
    mintCount: () => minted,
    deps: {
      resolveCachedKey: () => {
        log.push('resolve-cache');
        return cachedKey;
      },
      ensureBaseKey: async () => {
        log.push('ensureBaseKey');
        if (cachedKey) {
          // Drift guard: verify the hash on the remote, insert when missing.
          const present = remoteApiKeys.some(r => r.key_hash === hash(cachedKey));
          if (!present) {
            remoteApiKeys.push({ key_hash: hash(cachedKey), team_id: 'team-1' });
            log.push('insert-hash');
          }
          return cachedKey; // plaintext UNCHANGED — no rotation
        }
        minted += 1;
        const fresh = 'cmem_minted';
        remoteApiKeys.push({ key_hash: hash(fresh), team_id: 'team-1' });
        log.push('insert-hash');
        return fresh;
      },
    },
    hash,
  };
}

/** What runJoin does on the remote. Join succeeds only if this finds a row. */
function joinWouldAccept(rows: RemoteRow[], rawKey: string, hash: (k: string) => string): boolean {
  return rows.some(r => r.key_hash === hash(rawKey));
}

describe('convert persists the team key hash on the REMOTE', () => {
  it('inserts the hash even when the key is ALREADY cached locally', async () => {
    // THE REGRESSION. `??` skipped ensureBaseKey on a cache hit, so the remote
    // kept zero api_keys rows.
    const h = harness('cmem_already_cached');
    await resolveConvertKey(h.deps);
    expect(h.log).toContain('ensureBaseKey');
    expect(h.remoteApiKeys).toHaveLength(1);
  });

  it('a teammate pasting the invited key can actually join', async () => {
    // The end-to-end consequence, stated as the user-visible outcome rather
    // than an internal call. This is what was broken for every real invite.
    const h = harness('cmem_already_cached');
    const invited = await resolveConvertKey(h.deps);
    expect(joinWouldAccept(h.remoteApiKeys, invited, h.hash)).toBe(true);
  });

  it('returns the cached key UNCHANGED — reuse, never rotate', async () => {
    // Minting a second key for a team is the bug the route comment warns about:
    // orphan credentials whose plaintext is gone can be neither used nor
    // revoked. The fix must persist the hash WITHOUT rotating.
    const h = harness('cmem_already_cached');
    const key = await resolveConvertKey(h.deps);
    expect(key).toBe('cmem_already_cached');
    expect(h.mintCount()).toBe(0);
  });

  it('is idempotent — a second convert adds no duplicate row', async () => {
    // Retry and re-convert are both normal. ensureBaseKey checks before
    // inserting, so running it again must be a no-op.
    const h = harness('cmem_already_cached');
    await resolveConvertKey(h.deps);
    await resolveConvertKey(h.deps);
    expect(h.remoteApiKeys).toHaveLength(1);
    expect(h.log.filter(l => l === 'insert-hash')).toHaveLength(1);
  });

  it('still mints when nothing is cached (the original first-convert path)', async () => {
    const h = harness(null);
    const key = await resolveConvertKey(h.deps);
    expect(key).toBe('cmem_minted');
    expect(joinWouldAccept(h.remoteApiKeys, key, h.hash)).toBe(true);
    expect(h.mintCount()).toBe(1);
  });
});

describe('the route no longer short-circuits past ensureBaseKey', () => {
  // A source guard, because the unit test above models the shape rather than
  // importing the route (which needs Express + two live pools to construct).
  // If someone reintroduces `resolveKeyForTeam(...) ?? ensureBaseKey(...)`,
  // the behaviour tests keep passing while production breaks again — exactly
  // how this survived the previous fix in the same code block.
  const ROUTE = 'src/server/routes/v1/ServerV1PostgresRoutes.ts';

  it('does not gate ensureBaseKey behind a cached-credential lookup', async () => {
    const src = await Bun.file(ROUTE).text();
    // Strip comments: the explanation above the fix quotes the broken pattern,
    // and a naive scan flags the FIX as the bug (this has bitten 5 source
    // guards in this repo already).
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(l => l.replace(/\/\/.*$/, ''))
      .join('\n');
    // The exact broken shape: a cache read feeding `??` into ensureBaseKey.
    expect(code).not.toMatch(/resolveKeyForTeam\([^)]*\)\s*\r?\n?\s*\?\?\s*await\s+ensureBaseKey/);
  });

  it('still calls ensureBaseKey against the remote pool', async () => {
    const src = await Bun.file(ROUTE).text();
    expect(src).toContain('ensureBaseKey(remotePool');
  });
});
