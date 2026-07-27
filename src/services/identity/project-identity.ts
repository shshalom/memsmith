import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import { CredentialStore } from './credential-store.js';
import { createRawApiKey, hashApiKey } from '../hooks/server-bootstrap.js';
import { logger } from '../../utils/logger.js';
import { LOCAL_OWNER_USER_ID } from '../../server/identity/providers/local-provider.js';

export const MARKER_RELATIVE_PATH = '.memsmith/project.json';

// A local base key both captures (writes) and recalls (reads), so it needs the
// full read+write memory scopes — HOOK_API_KEY_SCOPES alone (no memories:read)
// would 403 every recall route. Matches the e2e "full" key scope set.
const IDENTITY_KEY_SCOPES = [
  'events:write', 'sessions:write', 'observations:read', 'jobs:read',
  'memories:read', 'memories:write',
] as const;

// Actor id for identity-layer key minting (local variant of the hook bootstrap actor).
// MUST match LOCAL_HOOK_ACTOR_ID in src/services/hooks/server-bootstrap.ts (not exported, so duplicated here).
const IDENTITY_ACTOR_ID = 'system:local-hook-bootstrap';

export interface ProjectMarker {
  projectId: string;
  teamId: string;
  note: string;
  runtime?: 'local' | 'server';
  serverUrl?: string;
  databaseName?: string;
}

const MARKER_NOTE =
  'Non-secret MemSmith identity pointer. The access credential lives in ~/.memsmith, never here.';

// Minimal shape of the pg pool we use. The real pool satisfies this.
// rowCount is number | null to match pg.QueryResult (pg returns null for non-SELECT statements).
interface QueryablePool { query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>; }

function readMarker(cwd: string): ProjectMarker | null {
  const p = join(cwd, MARKER_RELATIVE_PATH);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf-8')) as Partial<ProjectMarker>;
    if (m.teamId && m.projectId) {
      const out: ProjectMarker = { teamId: m.teamId, projectId: m.projectId, note: m.note ?? MARKER_NOTE };
      if (m.runtime === 'local' || m.runtime === 'server') out.runtime = m.runtime;
      if (typeof m.serverUrl === 'string' && m.serverUrl.length > 0) out.serverUrl = m.serverUrl;
      if (typeof m.databaseName === 'string' && m.databaseName.length > 0) out.databaseName = m.databaseName;
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

// Public reader (the internal readMarker stays private; expose a stable read for other modules).
export function readProjectMarker(cwd: string): ProjectMarker | null {
  return readMarker(cwd);
}

// Merge runtime fields into an EXISTING marker. Requires the identity marker to
// already exist (throws otherwise — never writes an identity-less partial).
// NEVER writes a key/secret: the team credential lives in CredentialStore.
export function writeProjectRuntime(
  cwd: string,
  runtime: { runtime: 'local' | 'server'; serverUrl?: string },
): void {
  const existing = readMarker(cwd);
  if (!existing) {
    throw new Error(`writeProjectRuntime: no project marker at ${join(cwd, MARKER_RELATIVE_PATH)} — mint identity first`);
  }
  const merged: ProjectMarker = {
    ...existing,
    runtime: runtime.runtime,
    ...(runtime.serverUrl ? { serverUrl: runtime.serverUrl } : {}),
  };
  writeMarker(cwd, merged);
}

// Merge databaseName into an EXISTING marker. Requires the identity marker to
// already exist (throws otherwise — never writes an identity-less partial).
// NEVER writes a key/secret: databaseName is a non-secret DB name only.
export function writeProjectDatabaseName(cwd: string, databaseName: string): void {
  const existing = readMarker(cwd);
  if (!existing) {
    throw new Error(`writeProjectDatabaseName: no project marker at ${join(cwd, MARKER_RELATIVE_PATH)} — mint identity first`);
  }
  writeMarker(cwd, { ...existing, databaseName });
}

function writeMarker(cwd: string, marker: ProjectMarker): void {
  const p = join(cwd, MARKER_RELATIVE_PATH);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(marker, null, 2), 'utf-8');
}

export async function upsertTeamAndProject(
  pool: QueryablePool,
  teamId: string,
  projectId: string,
  name?: string,
): Promise<void> {
  await pool.query('INSERT INTO teams (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [teamId]);
  // Name the project after its folder. The column was previously filled with
  // the projectId purely to satisfy NOT NULL, which left the project switcher
  // listing raw UUIDs. DO UPDATE (not DO NOTHING) so a project minted before
  // this change heals on its next session — but only when the stored name is
  // still the placeholder, so a name a user chose is never clobbered.
  const projectName = name?.trim() || projectId;
  await pool.query(
    `INSERT INTO projects (id, team_id, name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
     WHERE projects.name = projects.id`,
    [projectId, teamId, projectName],
  );
  // Establish the machine's user as this team's owner. Without a team_members
  // row (and a user_id on the key) authContext.role resolves to null for every
  // local project, so requireRole('owner') — which guards the Go Team wizard —
  // could never be satisfied on ANY local install. DO UPDATE so a team minted
  // before this change becomes owned on its next session instead of staying
  // ownerless forever, but only when the role is not already owner, so a real
  // owner set by team mode is never overwritten.
  await pool.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')
     ON CONFLICT (team_id, user_id) DO UPDATE SET role = 'owner'
     WHERE team_members.role <> 'owner'`,
    [teamId, LOCAL_OWNER_USER_ID],
  );
}

/**
 * Resolve the current project's durable identity. Recognizes an existing
 * committed marker; otherwise mints uuids + a marker. Always (idempotently)
 * upserts the PG teams/projects rows so a fresh DB / cloned repo self-heals.
 *
 * When a `store` is provided, this ALSO guarantees a resolvable base key for
 * the identity (via ensureBaseKey). This closes the "dark capture" hole: a
 * marker written without a corresponding key makes every hook fall back with
 * `missing_api_key` and silently drop observations. By folding the key
 * guarantee in here, no caller (cold-boot scope resolver, session-init, seed)
 * can leave a keyless marker behind. The store is optional so pool-less /
 * read-only callers still work — but any path that MINTS an identity should
 * pass one.
 */
export async function ensureProjectIdentity(
  pool: QueryablePool,
  cwd: string,
  store?: CredentialStore,
): Promise<{ teamId: string; projectId: string }> {
  const existing = readMarker(cwd);
  const teamId = existing?.teamId ?? randomUUID();
  const projectId = existing?.projectId ?? randomUUID();
  if (!existing) {
    writeMarker(cwd, { teamId, projectId, note: MARKER_NOTE });
    logger.info('IDENTITY', 'minted project identity', { teamId, projectId, cwd });
  }
  // basename of a path ending in a separator is '' — fall back to the id.
  await upsertTeamAndProject(pool, teamId, projectId, basename(cwd) || undefined);
  if (store) {
    // Guarantee a resolvable key for this identity. ensureBaseKey is idempotent:
    // it returns the cached key (repairing DB drift if needed) or mints one.
    await ensureBaseKey(pool, teamId, projectId, store);
  }
  return { teamId, projectId };
}

/** Insert (or idempotently re-insert) an api_key hash row. Used by both the
 * mint path and the cache/DB-drift repair path so both are guaranteed identical. */
async function insertApiKeyHash(
  pool: QueryablePool,
  keyHash: string,
  teamId: string,
  projectId: string,
): Promise<void> {
  const id = randomUUID();
  await pool.query(
    // project_id must be persisted, not just accepted as a parameter.
    // postgres-auth builds authContext.projectId from this column, and
    // resolveRequestDatabase 400s ("no project identity") without it — so a
    // NULL here authenticates fine but fails every dashboard and /v1 read.
    // user_id must be set too: authContext.role is resolved by joining
    // api_keys.user_id to team_members, so a NULL here leaves the role
    // unresolvable no matter what membership rows exist — which is what made
    // requireRole('owner') unsatisfiable on every local install.
    `INSERT INTO api_keys (id, key_hash, team_id, project_id, user_id, actor_id, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, keyHash, teamId, projectId, LOCAL_OWNER_USER_ID, IDENTITY_ACTOR_ID, JSON.stringify([...IDENTITY_KEY_SCOPES])],
  );
}

/**
 * Return the team's base key: the cached plaintext if present (and its hash
 * verified in PG), else mint a new key (hash persisted to api_keys, plaintext
 * cached in the store). Reuses the existing better-auth key primitives
 * (createRawApiKey, hashApiKey).
 *
 * Cache/DB-drift guard: if the cache holds a key but its hash is absent from
 * api_keys (e.g. DB was reset while the cache survived), the hash is
 * re-inserted so the server can validate it — the cached plaintext is returned
 * unchanged (no new key is minted).
 *
 * The INSERT is issued directly on the pool rather than through
 * PostgresAuthRepository.createApiKey so we can avoid the RETURNING clause
 * (which would fail on a fake/fresh pool) and the assertProjectOwnership guard
 * (which would throw before the projects row exists). The key is scoped to the
 * team; projectId is accepted for context/logging only.
 */
export async function ensureBaseKey(
  pool: QueryablePool,
  teamId: string,
  projectId: string,
  store: CredentialStore = new CredentialStore(),
): Promise<string> {
  const cached = store.resolveKeyForTeam(teamId);
  if (cached) {
    const keyHash = hashApiKey(cached);
    const existing = await pool.query(
      'SELECT 1 FROM api_keys WHERE key_hash = $1 AND team_id = $2 LIMIT 1',
      [keyHash, teamId],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      // The key is already stored, so the INSERT below never runs — which left
      // keys minted before owner establishment with user_id = NULL forever, and
      // a NULL user_id makes authContext.role unresolvable. Backfill it here so
      // an existing install becomes owned on its next session rather than
      // staying permanently unable to use owner-gated features like Go Team.
      await pool.query(
        'UPDATE api_keys SET user_id = $1 WHERE key_hash = $2 AND team_id = $3 AND user_id IS NULL',
        [LOCAL_OWNER_USER_ID, keyHash, teamId],
      );
      return cached;
    }
    // cache/DB drift: hash missing — re-insert it (do NOT mint a new key; reuse the cached one)
    await insertApiKeyHash(pool, keyHash, teamId, projectId);
    logger.info('IDENTITY', 'repaired cache/DB drift: re-inserted key hash', { teamId, projectId });
    return cached;
  }

  // no cached key: mint fresh
  const rawKey = createRawApiKey();
  const keyHash = hashApiKey(rawKey);
  await insertApiKeyHash(pool, keyHash, teamId, projectId);
  store.storeKeyForTeam(teamId, rawKey);
  logger.info('IDENTITY', 'minted base key', { teamId, projectId });
  return rawKey;
}
