// SPDX-License-Identifier: Apache-2.0
import type { Application, Request, Response } from 'express';
import type { SettingsResolver } from '../../settings/SettingsResolver.js';
import type { SettingsStore } from '../../settings/SettingsStore.js';
import { SETTING_KEYS, getSettingKey, validateSettingValue } from '../../settings/settingKeys.js';

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
