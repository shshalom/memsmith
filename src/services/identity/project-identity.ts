import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { CredentialStore } from './credential-store.js';
import { createRawApiKey, hashApiKey, HOOK_API_KEY_SCOPES } from '../hooks/server-bootstrap.js';
import { logger } from '../../utils/logger.js';

export const MARKER_RELATIVE_PATH = '.memsmith/project.json';

// Actor id for identity-layer key minting (local variant of the hook bootstrap actor).
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
  await pool.query('INSERT INTO projects (id, team_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [projectId, teamId]);
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

/**
 * Return the team's base key: the cached plaintext if present, else mint a new
 * key (hash persisted to api_keys, plaintext cached in the store). Reuses the
 * existing better-auth key primitives (createRawApiKey, hashApiKey).
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
  if (cached) return cached;

  const rawKey = createRawApiKey();
  const keyHash = hashApiKey(rawKey);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO api_keys (id, key_hash, team_id, actor_id, scopes)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, keyHash, teamId, IDENTITY_ACTOR_ID, JSON.stringify([...HOOK_API_KEY_SCOPES])],
  );
  store.storeKeyForTeam(teamId, rawKey);
  logger.info('IDENTITY', 'minted base key', { teamId, projectId });
  return rawKey;
}
