// SPDX-License-Identifier: Apache-2.0
import type { Application, Request, Response } from 'express';
import type { SettingsResolver } from '../../settings/SettingsResolver.js';
import type { SettingsStore } from '../../settings/SettingsStore.js';
import { SETTING_KEYS, getSettingKey, validateSettingValue } from '../../settings/settingKeys.js';
import { buildIdentityPayload } from './identity-payload.js';
import { resolveProjectRuntime } from './project-runtime.js';
import { CredentialStore } from '../../../services/identity/credential-store.js';
import { readFileSync, existsSync } from 'fs';
import { basename, join } from 'path';
import {
  isLocalhost,
  hasLoopbackHostHeader,
  hasForwardedClientHeaders,
} from '../../middleware/request-auth-helpers.js';
import type { ProjectMarker } from '../../../services/identity/project-identity.js';

/** Minimal shape of the pg pool the projects route needs (base DB only —
 * `projects`/`teams` are ACCOUNT tables, never per-project). */
interface ProjectsQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Matches the signature of ServerV1PostgresRoutes.auditWrite for injection. */
export type AuditFn = (
  req: Request,
  action: string,
  targetId: string | null,
  projectId: string | null,
  details?: Record<string, unknown>,
) => Promise<void>;

const CLOUD = new Set(['claude', 'anthropic', 'gemini', 'openrouter']);
const LOCAL = new Set(['ollama']);

function providerKeyPresent(provider: string): boolean {
  if (provider === 'claude' || provider === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY || process.env.MEMSMITH_ANTHROPIC_API_KEY);
  if (provider === 'gemini') return Boolean(process.env.GEMINI_API_KEY || process.env.MEMSMITH_GEMINI_API_KEY);
  if (provider === 'openrouter') return Boolean(process.env.OPENROUTER_API_KEY || process.env.MEMSMITH_OPENROUTER_API_KEY);
  return true; // ollama keyless
}

async function resolvedPayload(resolver: SettingsResolver, teamId: string) {
  const all = await resolver.resolveAll(teamId);
  const settings: Record<string, unknown> = {};
  for (const spec of SETTING_KEYS) {
    const r = all[spec.key];
    settings[spec.key] = {
      value: r.value, source: r.source, boot: spec.boot, type: spec.type,
      options: spec.options, min: spec.min, max: spec.max, label: spec.label, description: spec.description,
      help: spec.help,
    };
  }
  return { settings };
}

export interface SettingsRouteDeps {
  resolver: SettingsResolver;
  store: SettingsStore;
  // Returns true if allowed; else writes a 403 and returns false.
  requireScopes: (req: Request, res: Response, needed: string) => boolean;
  // Optional audit writer injected by the production wiring layer.
  // Called only on a successful write; never called on 400/confirmation paths.
  auditFn?: AuditFn;
}

// ── Identity route ────────────────────────────────────────────────────────────

const MARKER_RELATIVE_PATH = '.memsmith/project.json';

function readProjectMarker(cwd: string): { teamId: string; projectId: string } | null {
  const p = join(cwd, MARKER_RELATIVE_PATH);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf-8')) as Partial<{ teamId: string; projectId: string }>;
    if (m.teamId && m.projectId) return { teamId: m.teamId, projectId: m.projectId };
    return null;
  } catch {
    return null;
  }
}

export interface IdentityRouteDeps {
  credentialStore?: CredentialStore;
  requireScopes: (req: Request, res: Response, needed: string) => boolean;
  /**
   * Resolve a project's runtime from its OWN marker. Optional so existing
   * callers (and unit tests) keep working; absent means 'local'.
   */
  resolveRuntime?: (projectId: string) => Promise<'local' | 'team'> | 'local' | 'team';
}

export function registerIdentityRoutes(app: Application, deps: IdentityRouteDeps): void {
  app.get('/v1/identity', async (req: Request, res: Response) => {
    if (!deps.requireScopes(req, res, 'memories:read')) return;
    // Report the REQUEST's project, not the server's cwd. One server serves
    // every local project, so falling back to the server's own marker always
    // showed the dogfood's identity regardless of which project's dashboard
    // was open. The Go Team wizard lives in Settings and converts
    // req.authContext.projectId — so Settings must display the SAME project
    // or a user could convert one project while believing they converted
    // another. Only fall back to the marker when authContext carries no
    // project (e.g. no auth middleware wired, as in unit tests).
    const ctxTeam = (req as any).authContext?.teamId;
    const ctxProject = (req as any).authContext?.projectId;
    const cwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
    const ids = (ctxTeam && ctxProject)
      ? { teamId: ctxTeam, projectId: ctxProject }
      : readProjectMarker(cwd);
    if (!ids) {
      res.status(404).json({ error: 'NotFound', message: 'no project marker found' });
      return;
    }
    const store = deps.credentialStore ?? new CredentialStore();
    // reveal is only honored for loopback requests — same trust boundary as the local dashboard
    const revealParam = req.query.reveal === 'true';
    const reveal = revealParam && isLocalhost(req);
    // Report the role the auth middleware already resolved (postgres-auth.ts
    // sets it for both the api-key path and the loopback local-dev owner), so
    // this costs no extra query. The Go Team wizard uses it to decide whether it
    // must ask for a sign-in at all: the owner of a single-user local install
    // has nobody else to be. Only a role that reports exactly 'owner' counts —
    // a null role (what a session yields today) keeps the sign-in step.
    const ctxRole = (req as any).authContext?.role ?? null;
    // Report THIS project's runtime so Settings can hide the GO TEAM button on a
    // project already in team mode. Resolved from the project's own marker via
    // its recorded path — never from the server's cwd, which would report the
    // server's own project's runtime for every project.
    const runtime = deps.resolveRuntime
      ? await deps.resolveRuntime(ids.projectId)
      : 'local';
    const payload = buildIdentityPayload(ids, store, { reveal, role: ctxRole, runtime });
    res.status(200).json(payload);
  });
}

// ── Projects route (Item 3 — project switcher) ────────────────────────────────

export interface ProjectListEntry {
  projectId: string;
  teamId: string;
  name: string;
  runtime: 'local' | 'team';
  isCurrent: boolean;
}

export interface ProjectsRouteDeps {
  pool: ProjectsQueryable;
  credentialStore?: CredentialStore;
}

/**
 * GET /v1/projects — used by the dashboard's project switcher.
 *
 * Loopback-gated by the SAME three-part check already shipped for the viewer
 * cookie (isLocalhost && hasLoopbackHostHeader && !hasForwardedClientHeaders):
 * this mirrors the cookie rule exactly, so the switcher can never list a
 * project it could not actually open.
 *
 * Lists only projects this machine holds a key for (DB `projects` joined
 * against CredentialStore) — never every project in the database.
 *
 * `name` — `projects.name` is the folder basename, stamped at mint time.
 * Rows minted before that change hold the projectId as a NOT NULL placeholder
 * and heal on their next session; those are shortened rather than shown as a
 * full uuid.
 *
 * `runtime` — resolved per project from ITS OWN marker, located via the path
 * recorded in `projects.metadata` (see resolveProjectRuntime). This previously
 * derived from the SERVER's marker, which meant only the project the server was
 * launched from could ever report "team" — so a converted project displayed
 * "Local" forever and the GO TEAM button never went away. Projects with no
 * recorded path report "local" until their next session records one; the path is
 * never guessed from the server's cwd.
 */
export function registerProjectsRoutes(app: Application, deps: ProjectsRouteDeps): void {
  app.get('/v1/projects', async (req: Request, res: Response) => {
    if (!(isLocalhost(req) && hasLoopbackHostHeader(req) && !hasForwardedClientHeaders(req))) {
      res.status(403).json({ error: 'Forbidden', message: 'loopback only' });
      return;
    }

    const store = deps.credentialStore ?? new CredentialStore();
    const teamIds = store.listTeamIdsWithKeys();
    if (teamIds.length === 0) {
      res.status(200).json([]);
      return;
    }

    const rows = await deps.pool.query(
      'SELECT id, team_id, name, metadata FROM projects WHERE team_id = ANY($1::text[]) ORDER BY name',
      [teamIds],
    );

    const cwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
    const currentMarker = readServerProjectMarker(cwd);
    const currentProjectId = (req as any).authContext?.projectId ?? null;

    const projects: ProjectListEntry[] = (rows.rows as {
      id: string; team_id: string; name: string; metadata: Record<string, unknown> | null;
    }[]).map((row) => {
      const isServerProject = currentMarker !== null && currentMarker.projectId === row.id;
      // Each project's runtime comes from ITS OWN marker, located via the path
      // recorded in projects.metadata. This previously derived from the SERVER's
      // marker, so only the project the server launched from could ever report
      // "team" — a converted project kept showing "Local" forever.
      const runtime = resolveProjectRuntime(
        { projectId: row.id, metadata: row.metadata },
        readServerProjectMarker,
      );
      // Projects are named after their folder at mint time. Older rows were
      // stamped with the projectId as a NOT NULL placeholder and heal on their
      // next session, so treat name === id as "unnamed" and shorten it rather
      // than showing a full uuid. The server's own project can always fall
      // back to its cwd basename.
      const stored = row.name && row.name !== row.id ? row.name : null;
      const name = stored ?? (isServerProject ? basename(cwd) : row.id.slice(0, 8));
      return {
        projectId: row.id,
        teamId: row.team_id,
        name,
        runtime,
        isCurrent: currentProjectId === row.id,
      };
    });

    res.status(200).json(projects);
  });
}

function readServerProjectMarker(cwd: string): ProjectMarker | null {
  const p = join(cwd, MARKER_RELATIVE_PATH);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf-8')) as Partial<ProjectMarker>;
    if (m.teamId && m.projectId) {
      return {
        teamId: m.teamId,
        projectId: m.projectId,
        note: m.note ?? '',
        ...(m.runtime ? { runtime: m.runtime } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Settings routes ───────────────────────────────────────────────────────────

export function registerSettingsRoutes(app: Application, deps: SettingsRouteDeps): void {
  app.get('/v1/settings', async (req: Request, res: Response) => {
    if (!deps.requireScopes(req, res, 'memories:read')) return;
    const teamId = (req as any).authContext?.teamId;
    if (!teamId) { res.status(400).json({ error: 'ValidationError', message: 'no team scope' }); return; }
    res.status(200).json(await resolvedPayload(deps.resolver, teamId));
  });

  app.patch('/v1/settings', async (req: Request, res: Response) => {
    if (!deps.requireScopes(req, res, 'settings:admin')) return;
    const teamId = (req as any).authContext?.teamId;
    if (!teamId) { res.status(400).json({ error: 'ValidationError', message: 'no team scope' }); return; }
    const patch = (req.body?.patch ?? {}) as Record<string, unknown>;
    const confirm = req.body?.confirm === true;

    // 1. Validate every key before writing any (atomic validation).
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      const spec = getSettingKey(key);
      if (!spec) { res.status(400).json({ error: 'ValidationError', field: key, message: `unknown setting ${key}` }); return; }
      const v = validateSettingValue(spec, value);
      if (!v.ok) { res.status(400).json({ error: 'ValidationError', field: key, message: v.error }); return; }
      clean[key] = v.value;
    }

    // 2. Cloud-switch key check + 3. local->cloud confirm gate.
    if (typeof clean.provider === 'string' && CLOUD.has(clean.provider)) {
      if (!providerKeyPresent(clean.provider)) {
        res.status(400).json({ error: 'MissingProviderKey', message: `${clean.provider} requires an API key` });
        return;
      }
      const currentProvider = await deps.resolver.provider(teamId);
      if (LOCAL.has(currentProvider) && !confirm) {
        res.status(200).json({ confirmationRequired: true, message: `Switching to ${clean.provider} starts metered usage.` });
        return;
      }
    }

    // 4. Write + invalidate + audit + return resolved.
    await deps.store.putTeamOverrides(teamId, clean);
    deps.resolver.invalidate(teamId);
    if (deps.auditFn) {
      await deps.auditFn(req, 'settings.update', null, null, { keys: Object.keys(clean) });
    }
    res.status(200).json(await resolvedPayload(deps.resolver, teamId));
  });
}
