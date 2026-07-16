// SPDX-License-Identifier: Apache-2.0
import type { SettingsStore } from './SettingsStore.js';
import { getSettingKey, coerceEnvValue, validateSettingValue, SETTING_KEYS } from './settingKeys.js';

export interface ResolvedSetting {
  value: unknown;
  source: 'user' | 'team' | 'env' | 'default';
}

interface CacheEntry { overrides: Record<string, unknown>; expiresAt: number; }

export class SettingsResolver {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly store: SettingsStore,
    opts?: { ttlMs?: number; now?: () => number },
  ) {
    this.ttlMs = opts?.ttlMs ?? 2000;
    // Injectable clock for tests; Date.now is fine in production.
    this.now = opts?.now ?? (() => Date.now());
  }

  private async overrides(teamId: string): Promise<Record<string, unknown>> {
    const hit = this.cache.get(teamId);
    if (hit && hit.expiresAt > this.now()) return hit.overrides;
    const overrides = await this.store.getTeamOverrides(teamId);
    this.cache.set(teamId, { overrides, expiresAt: this.now() + this.ttlMs });
    return overrides;
  }

  invalidate(teamId: string): void {
    this.cache.delete(teamId);
  }

  async resolve(teamId: string, key: string): Promise<ResolvedSetting> {
    const spec = getSettingKey(key);
    if (!spec) return { value: undefined, source: 'default' };

    // user tier: no identity yet — skip.

    const team = await this.overrides(teamId);
    if (Object.prototype.hasOwnProperty.call(team, key)) {
      const v = validateSettingValue(spec, team[key]);
      if (v.ok) return { value: v.value, source: 'team' };
      // malformed stored value → fall through
    }

    const raw = process.env[spec.env];
    if (raw !== undefined && raw !== '') {
      const coerced = coerceEnvValue(spec, raw);
      const v = validateSettingValue(spec, coerced);
      if (v.ok) return { value: v.value, source: 'env' };
    }

    return { value: spec.default, source: 'default' };
  }

  async resolveAll(teamId: string): Promise<Record<string, ResolvedSetting>> {
    const out: Record<string, ResolvedSetting> = {};
    for (const k of SETTING_KEYS) out[k.key] = await this.resolve(teamId, k.key);
    return out;
  }

  private async num(teamId: string, key: string): Promise<number> {
    return Number((await this.resolve(teamId, key)).value);
  }
  private async bool(teamId: string, key: string): Promise<boolean> {
    return Boolean((await this.resolve(teamId, key)).value);
  }
  private async str(teamId: string, key: string): Promise<string> {
    return String((await this.resolve(teamId, key)).value);
  }

  provider(teamId: string) { return this.str(teamId, 'provider'); }
  model(teamId: string) { return this.str(teamId, 'model'); }
  tieringEnabled(teamId: string) { return this.bool(teamId, 'tiering'); }
  searchHybridEnabled(teamId: string) { return this.bool(teamId, 'searchHybrid'); }
  async weights(teamId: string) {
    return { fts: await this.num(teamId, 'ftsWeight'), vec: await this.num(teamId, 'vecWeight') };
  }
  rrfK(teamId: string) { return this.num(teamId, 'rrfK'); }
  supersedeMaxDepth(teamId: string) { return this.num(teamId, 'supersedeMaxDepth'); }
  qualityFloor(teamId: string) { return this.num(teamId, 'qualityFloor'); }
  reformatRetries(teamId: string) { return this.num(teamId, 'reformatRetries'); }
  inputRatePerMtok(teamId: string) { return this.num(teamId, 'inputRatePerMtok'); }
  userNoteBoost(teamId: string) { return this.num(teamId, 'userNoteBoost'); }
}
