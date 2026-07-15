import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';

interface QueryablePool { query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>; }

function envScope(): { teamId: string; projectId: string } | null {
  const t = (process.env.MEMSMITH_LOCAL_DEV_TEAM_ID ?? '').trim();
  const p = (process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID ?? '').trim();
  return t && p ? { teamId: t, projectId: p } : null;
}

function markerScope(cwd: string): { teamId: string; projectId: string } | null {
  const path = join(cwd, '.memsmith', 'project.json');
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, 'utf-8')) as { teamId?: string; projectId?: string };
    return m.teamId && m.projectId ? { teamId: m.teamId, projectId: m.projectId } : null;
  } catch { return null; }
}

// Sync best-effort for callers without a pool: env > marker (no minting).
export function readLocalScopeFromMarkerOrEnv(cwd: string): { teamId: string; projectId: string } | null {
  return envScope() ?? markerScope(cwd);
}

// Full resolution: env > marker > mint. Minting requires a pool.
export async function resolveLocalScope(
  opts: { cwd: string; pool?: QueryablePool },
): Promise<{ teamId: string; projectId: string }> {
  const fromEnvOrMarker = readLocalScopeFromMarkerOrEnv(opts.cwd);
  if (fromEnvOrMarker) return fromEnvOrMarker;

  if (opts.pool) {
    // Pass a CredentialStore so the mint ALSO guarantees a resolvable base key.
    // Without this, cold-boot could write a keyless marker and every hook would
    // fall back with `missing_api_key`, dropping observations (the "dark
    // capture" regression). ensureProjectIdentity is idempotent on re-runs.
    const { ensureProjectIdentity } = await import('../../services/identity/project-identity.js');
    const { CredentialStore } = await import('../../services/identity/credential-store.js');
    return ensureProjectIdentity(opts.pool as any, opts.cwd, new CredentialStore());
  }

  // Last resort (no pool, no env, no marker): preserve legacy 'local' behavior.
  logger.warn('SYSTEM', 'resolveLocalScope: no env/marker and no pool to mint; falling back to local/local');
  return { teamId: 'local', projectId: 'local' };
}
