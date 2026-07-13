import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { CredentialStore } from './credential-store.js';
import { createRawApiKey, hashApiKey } from '../hooks/server-bootstrap.js';
import { logger } from '../../utils/logger.js';

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

interface ProjectMarker { projectId: string; teamId: string; note: string; }

const MARKER_NOTE =
  'Non-secret MemSmith identity pointer. The access credential lives in ~/.memsmith, never here.';

// Minimal shape of the pg pool we use. The real pool satisfies this.
interface QueryablePool { query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>; }

function readMarker(cwd: string): ProjectMarker | null {
  const p = join(cwd, MARKER_RELATIVE_PATH);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf-8')) as Partial<ProjectMarker>;
    if (m.teamId && m.projectId) return { teamId: m.teamId, projectId: m.projectId, note: m.note ?? MARKER_NOTE };
    return null;
  } catch {
    return null;
  }
}

function writeMarker(cwd: string, marker: ProjectMarker): void {
  const p = join(cwd, MARKER_RELATIVE_PATH);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(marker, null, 2), 'utf-8');
}

async function upsertTeamAndProject(pool: QueryablePool, teamId: string, projectId: string): Promise<void> {
  await pool.query('INSERT INTO teams (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [teamId]);
  await pool.query('INSERT INTO projects (id, team_id, name) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING', [projectId, teamId]);
}

/**
 * Resolve the current project's durable identity. Recognizes an existing
 * committed marker; otherwise mints uuids + a marker. Always (idempotently)
 * upserts the PG teams/projects rows so a fresh DB / cloned repo self-heals.
 */
export async function ensureProjectIdentity(
  pool: QueryablePool,
  cwd: string,
): Promise<{ teamId: string; projectId: string }> {
  const existing = readMarker(cwd);
  const teamId = existing?.teamId ?? randomUUID();
  const projectId = existing?.projectId ?? randomUUID();
  if (!existing) {
    writeMarker(cwd, { teamId, projectId, note: MARKER_NOTE });
    logger.info('IDENTITY', 'minted project identity', { teamId, projectId, cwd });
  }
  await upsertTeamAndProject(pool, teamId, projectId);
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
    `INSERT INTO api_keys (id, key_hash, team_id, actor_id, scopes)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, keyHash, teamId, IDENTITY_ACTOR_ID, JSON.stringify([...IDENTITY_KEY_SCOPES])],
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
    if (existing.rowCount && existing.rowCount > 0) return cached;
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
