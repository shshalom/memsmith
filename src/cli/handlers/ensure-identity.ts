// SPDX-License-Identifier: Apache-2.0
//
// Shared, idempotent project-identity mint for the hook processes.
//
// WHY THIS EXISTS: the mint used to live only in sessionInitHandler, which runs on
// UserPromptSubmit — i.e. when the user sends their FIRST MESSAGE. But the
// dashboard link is composed by contextHandler on SessionStart, strictly earlier.
// So on the first session of a brand-new project the marker did not exist yet and
// the link came out unscoped (a bare host with no ?project=). Only the SECOND
// session showed the right link.
//
// That is not cosmetic: one server serves every local project, so an unscoped
// link lands on whichever project the SERVER booted from — a link into a
// different project's memory, and a Go Team wizard opened from there would act on
// that other project.
//
// Extracted rather than copied because the DSN step below is load-bearing and
// must not fork between two call sites.

interface MintedIds { teamId: string; projectId: string }

export interface EnsureIdentityDeps {
  /**
   * The local embedded-PG base DSN.
   *
   * MEMSMITH_SERVER_DATABASE_URL is set by local-runtime inside the SERVER
   * process and never written to a file, so a hook — a separate short-lived
   * process — never inherits it. Without deriving it here the pool throws and
   * minting is skipped forever, leaving a fresh project with no marker, no
   * database, and no memory.
   */
  resolveLocalBaseDatabaseUrl: () => string;
  /** The process-wide base-account pool. Never a per-project connection. */
  getPool: () => unknown;
  ensureProjectIdentity: (pool: unknown, cwd: string, store: unknown) => Promise<MintedIds>;
  credentialStore?: () => unknown;
}

/**
 * Ensure this project has an identity, returning it so the caller can scope a
 * dashboard link. Idempotent: safe to call on every session start.
 *
 * Never throws. This runs on the session-start path, so a failure must degrade to
 * an unscoped link rather than break the session.
 */
export async function ensureProjectIdentityForHook(
  cwd: string,
  deps: EnsureIdentityDeps,
): Promise<MintedIds | null> {
  if (!cwd || !cwd.trim()) return null;
  try {
    // Order matters: the DSN must be in place before the pool is constructed.
    process.env.MEMSMITH_SERVER_DATABASE_URL = deps.resolveLocalBaseDatabaseUrl();
    const pool = deps.getPool();
    const store = deps.credentialStore ? deps.credentialStore() : undefined;
    return await deps.ensureProjectIdentity(pool, cwd, store);
  } catch {
    return null;
  }
}

/** Production deps, wired to the real modules. */
export async function realEnsureIdentityDeps(): Promise<EnsureIdentityDeps> {
  const [{ resolveLocalBaseDatabaseUrl }, { getSharedPostgresPool }, identity, { CredentialStore }] =
    await Promise.all([
      import('../../services/identity/local-base-dsn.js'),
      import('../../storage/postgres/pool.js'),
      import('../../services/identity/project-identity.js'),
      import('../../services/identity/credential-store.js'),
    ]);
  return {
    resolveLocalBaseDatabaseUrl: () => resolveLocalBaseDatabaseUrl(),
    getPool: () => getSharedPostgresPool({ requireDatabaseUrl: true }),
    ensureProjectIdentity: (pool, cwd, store) =>
      identity.ensureProjectIdentity(pool as never, cwd, store as never),
    credentialStore: () => new CredentialStore(),
  };
}
