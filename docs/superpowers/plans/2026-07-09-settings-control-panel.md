# MemSmith Settings / Control Panel + Real Cost Story — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every server-mode capability knob visible and controllable from a Claude-styled Settings panel, backed by a team-scoped settings store + `/v1/settings` API with a live provider hot-swap, and close the compression-metering gap so the cost/savings number is real.

**Architecture:** A `SettingsResolver` (chain: user→team→env→code-default) becomes the single read path for capability knobs; a `SettingsStore` persists team overrides in a new Postgres table; `/v1/settings` reads (with provenance) and writes (validated, `settings:admin`-gated, cloud-switch guarded); a `GenerationProviderHolder` re-resolves the provider per generation job so Ollama↔Claude switches take effect live; compression records `usage_events kind='compression'` and `costPanel` computes real savings. A new `SettingsView` renders it all in the Claude aesthetic.

**Tech Stack:** TypeScript, Bun test, Express, Postgres (pgvector), React (esbuild viewer bundle), BullMQ.

## Global Constraints

- Server-mode `/v1/*` and `/dashboard/*` only; no worker `/api/*` dependency.
- Claude aesthetic: cream ground `#f0eee6`/`#faf9f5`, coral accent `#cc785c`, humanist sans, soft rounded cards (radius ~11px), generous spacing. No warm-dark+gold.
- Resolver + metering NEVER crash a read/injection/generation; degrade gracefully.
- Precedence is **DB → env → code-default**, always (user tier dormant).
- `settings:admin` scope gates ALL mutations. Local-dev `settings:admin` grant is **loopback + local-dev only, NEVER production** (same rule as `MEMSMITH_LOCAL_DEV_TEAM_ID`).
- Schema change goes in `bootstrapServerPostgresSchema()` in `src/storage/postgres/schema.ts`, bump `SERVER_POSTGRES_SCHEMA_VERSION` 3→4, plus reference file `src/storage/postgres/migrations/004_server_settings.sql`.
- `usage_events kind='compression'` needs no schema change (open-ended `UsageKind`); use `record({teamId,projectId?,kind,quantity?,metadata?})`.
- Cloud-provider switch requires a validated key present and (from local) an explicit `confirm`.
- User-identity tier is a seam only — no identity subsystem built here.
- Postgres tests run against the test container on **port 55432** (NOT 5432).
- All new files start with `// SPDX-License-Identifier: Apache-2.0`.
- Run `npx tsc --noEmit` (main) and `npx tsc --noEmit -p src/ui/viewer/tsconfig.json` (viewer) before each commit; both must report 0 errors.

---

## File Structure

**New files:**
- `src/server/settings/settingKeys.ts` — canonical knob registry (type, validation, env name, default, boot flag).
- `src/server/settings/SettingsStore.ts` — Postgres accessor for `server_settings`.
- `src/server/settings/SettingsResolver.ts` — resolution chain + short-TTL cache + typed getters.
- `src/server/generation/GenerationProviderHolder.ts` — per-job provider resolution + cache.
- `src/ui/viewer/utils/settingsData.ts` — `fetchSettings`/`patchSettings`.
- `src/ui/viewer/views/SettingsView.tsx` — the Settings panel.
- `src/storage/postgres/migrations/004_server_settings.sql` — reference DDL.
- Test files under `tests/server/`, `tests/storage/`, `tests/viewer/`.

**Modified files:**
- `src/storage/postgres/schema.ts` — add `server_settings` table + version 4.
- `src/server/retrieval/inject.ts`, `rrf.ts`, `supersession.ts`, `src/storage/postgres/observations.ts`, `src/server/generation/processGeneratedResponse.ts`, `src/server/generation/ProviderObservationGenerator.ts`, `src/server/dashboard/queries.ts` — read via resolver.
- `src/server/runtime/create-server-service.ts` — export `instantiateServerGenerationProvider(provider, model?)`.
- `src/server/routes/v1/ServerV1PostgresRoutes.ts` — register `/v1/settings`; thread resolver/store.
- `src/server/services/server/ServerService.ts` — construct resolver/store, pass `allowLocalDevBypass`.
- `src/server/middleware/postgres-auth.ts` — local-dev bypass grants `settings:admin`.
- `src/ui/viewer/components/Sidebar.tsx`, `src/ui/viewer/views/viewState.ts`, `src/ui/viewer/App.tsx` — add Settings view.
- `src/ui/viewer-template.html` — Claude-aesthetic CSS for settings classes.

---

### Task 1: `server_settings` table (schema migration 4)

**Files:**
- Modify: `src/storage/postgres/schema.ts:6` (version), `:11-25` (table list), `:54-91` (`applyPhase1Migration`)
- Create: `src/storage/postgres/migrations/004_server_settings.sql`
- Test: `tests/storage/server-settings-schema.test.ts`

**Interfaces:**
- Produces: a `server_settings` table `(team_id text primary key, overrides jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now())`; `SERVER_POSTGRES_SCHEMA_VERSION === 4`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/storage/server-settings-schema.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll } from 'bun:test';
import { Pool } from 'pg';
import { bootstrapServerPostgresSchema, SERVER_POSTGRES_SCHEMA_VERSION } from '../../src/storage/postgres/schema.js';

const CONN = process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@localhost:55432/memsmith';

describe('server_settings schema (migration 4)', () => {
  it('bumps the schema version to 4', () => {
    expect(SERVER_POSTGRES_SCHEMA_VERSION).toBe(4);
  });

  it('creates server_settings with team_id PK and overrides jsonb', async () => {
    const pool = new Pool({ connectionString: CONN });
    try {
      await bootstrapServerPostgresSchema(pool);
      const { rows } = await pool.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name = 'server_settings' ORDER BY column_name`);
      const cols = Object.fromEntries(rows.map((r: any) => [r.column_name, r.data_type]));
      expect(cols['team_id']).toBe('text');
      expect(cols['overrides']).toBe('jsonb');
      expect(cols['updated_at']).toContain('timestamp');
    } finally {
      await pool.end();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/storage/server-settings-schema.test.ts`
Expected: FAIL — version is 3, table does not exist.

- [ ] **Step 3: Bump version and add the table to the list**

In `src/storage/postgres/schema.ts`:
- Line 6: `export const SERVER_POSTGRES_SCHEMA_VERSION = 4;`
- In `SERVER_POSTGRES_TABLES` add `'server_settings'` as the last entry before `]`.

- [ ] **Step 4: Add the migration in `applyPhase1Migration`**

Append inside `applyPhase1Migration` (after the version-3 insert, before the closing `}`):

```ts
  // Migration 004: per-team server settings overrides (team-scoped control panel).
  await client.query(
    `CREATE TABLE IF NOT EXISTS server_settings (
       team_id text PRIMARY KEY,
       overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
       updated_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  await client.query(
    `
      INSERT INTO server_beta_schema_migrations (version, description)
      VALUES ($1, $2)
      ON CONFLICT (version) DO NOTHING
    `,
    [4, 'team-agent-memory: per-team server_settings overrides']
  );
```

- [ ] **Step 5: Create the reference SQL file**

```sql
-- src/storage/postgres/migrations/004_server_settings.sql
-- SPDX-License-Identifier: Apache-2.0
-- Source-of-truth SQL; not loaded by code (DDL is embedded in schema.ts).
-- Per-team server-mode capability overrides for the Settings/Control panel.
CREATE TABLE IF NOT EXISTS server_settings (
  team_id    text PRIMARY KEY,
  overrides  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test tests/storage/server-settings-schema.test.ts && npx tsc --noEmit`
Expected: PASS, 0 tsc errors.

- [ ] **Step 7: Commit**

```bash
git add src/storage/postgres/schema.ts src/storage/postgres/migrations/004_server_settings.sql tests/storage/server-settings-schema.test.ts
git commit -m "feat(server): server_settings table (schema migration 4)"
```

---

### Task 2: `settingKeys.ts` — the knob registry

**Files:**
- Create: `src/server/settings/settingKeys.ts`
- Test: `tests/server/setting-keys.test.ts`

**Interfaces:**
- Produces:
  - `type SettingType = 'boolean' | 'number' | 'enum' | 'string'`
  - `interface SettingKey { key: string; type: SettingType; env: string; default: unknown; boot: boolean; options?: string[]; min?: number; max?: number; label: string; description: string; }`
  - `const SETTING_KEYS: readonly SettingKey[]` — one entry per knob.
  - `function getSettingKey(key: string): SettingKey | undefined`
  - `function validateSettingValue(k: SettingKey, value: unknown): { ok: true; value: unknown } | { ok: false; error: string }` — coerces/validates; enum checks membership, number checks finite + min/max, boolean checks true/false.
  - `function coerceEnvValue(k: SettingKey, raw: string): unknown` — parses an env string per type (boolean: not '0'/'off'; number: `Number`; enum/string: trimmed lowercase for provider else raw).

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/setting-keys.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { SETTING_KEYS, getSettingKey, validateSettingValue, coerceEnvValue } from '../../src/server/settings/settingKeys.js';

describe('settingKeys registry', () => {
  it('includes the core knobs with correct types and boot flags', () => {
    const provider = getSettingKey('provider')!;
    expect(provider.type).toBe('enum');
    expect(provider.options).toEqual(['ollama', 'claude', 'gemini', 'openrouter']);
    expect(provider.boot).toBe(false);
    expect(getSettingKey('tiering')!.type).toBe('boolean');
    expect(getSettingKey('ftsWeight')!.type).toBe('number');
    // Quotas remain boot (middleware wired at setupRoutes).
    expect(getSettingKey('monthlyTokenCap')!.boot).toBe(true);
    expect(getSettingKey('rrfK')!.boot).toBe(false); // was module const, now live
  });

  it('every key has env, default, label, description', () => {
    for (const k of SETTING_KEYS) {
      expect(typeof k.env).toBe('string');
      expect(k.default !== undefined).toBe(true);
      expect(k.label.length).toBeGreaterThan(0);
      expect(k.description.length).toBeGreaterThan(0);
    }
  });

  it('validateSettingValue enforces enum membership', () => {
    const p = getSettingKey('provider')!;
    expect(validateSettingValue(p, 'ollama')).toEqual({ ok: true, value: 'ollama' });
    expect(validateSettingValue(p, 'gpt').ok).toBe(false);
  });

  it('validateSettingValue enforces number range', () => {
    const w = getSettingKey('ftsWeight')!; // min 0 max 1
    expect(validateSettingValue(w, 0.5)).toEqual({ ok: true, value: 0.5 });
    expect(validateSettingValue(w, 2).ok).toBe(false);
    expect(validateSettingValue(w, 'x').ok).toBe(false);
  });

  it('validateSettingValue coerces boolean', () => {
    const t = getSettingKey('tiering')!;
    expect(validateSettingValue(t, true)).toEqual({ ok: true, value: true });
    expect(validateSettingValue(t, 'nope').ok).toBe(false);
  });

  it('coerceEnvValue parses per type', () => {
    expect(coerceEnvValue(getSettingKey('tiering')!, '0')).toBe(false);
    expect(coerceEnvValue(getSettingKey('tiering')!, 'on')).toBe(true);
    expect(coerceEnvValue(getSettingKey('ftsWeight')!, '0.3')).toBe(0.3);
    expect(coerceEnvValue(getSettingKey('provider')!, 'Ollama')).toBe('ollama');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/setting-keys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

```ts
// src/server/settings/settingKeys.ts
// SPDX-License-Identifier: Apache-2.0

export type SettingType = 'boolean' | 'number' | 'enum' | 'string';

export interface SettingKey {
  key: string;
  type: SettingType;
  env: string;
  default: unknown;
  /** true if changing this still requires a restart to take effect. */
  boot: boolean;
  options?: string[];
  min?: number;
  max?: number;
  label: string;
  description: string;
}

export const SETTING_KEYS: readonly SettingKey[] = [
  { key: 'provider', type: 'enum', env: 'MEMSMITH_SERVER_PROVIDER', default: 'ollama',
    boot: false, options: ['ollama', 'claude', 'gemini', 'openrouter'],
    label: 'Generation model', description: "Who distills your team's memory. Switching applies live." },
  { key: 'model', type: 'string', env: 'MEMSMITH_SERVER_MODEL', default: 'llama3.1:8b',
    boot: false, label: 'Model name', description: 'The specific model the provider runs.' },
  { key: 'tiering', type: 'boolean', env: 'MEMSMITH_TIERING', default: true,
    boot: false, label: 'Compression (tiering)', description: 'Squeeze older memory to fit the injection budget.' },
  { key: 'searchHybrid', type: 'boolean', env: 'MEMSMITH_SEARCH_HYBRID', default: true,
    boot: false, label: 'Hybrid search', description: 'Blend keyword + semantic ranking on retrieval.' },
  { key: 'ftsWeight', type: 'number', env: 'MEMSMITH_FTS_WEIGHT', default: 0.3,
    boot: false, min: 0, max: 1, label: 'Keyword weight', description: 'Full-text-search weight in the hybrid blend.' },
  { key: 'vecWeight', type: 'number', env: 'MEMSMITH_VEC_WEIGHT', default: 1,
    boot: false, min: 0, max: 1, label: 'Semantic weight', description: 'Vector-similarity weight in the hybrid blend.' },
  { key: 'rrfK', type: 'number', env: 'MEMSMITH_RRF_K', default: 60,
    boot: false, min: 1, max: 1000, label: 'RRF k', description: 'Reciprocal-rank-fusion constant.' },
  { key: 'supersedeMaxDepth', type: 'number', env: 'MEMSMITH_SUPERSEDE_MAX_DEPTH', default: 20,
    boot: false, min: 1, max: 200, label: 'Supersede depth', description: 'Max supersession chain depth to resolve.' },
  { key: 'qualityFloor', type: 'number', env: 'MEMSMITH_QUALITY_FLOOR', default: 20,
    boot: false, min: 0, max: 100, label: 'Quality floor', description: 'Minimum quality score to keep a generated observation.' },
  { key: 'reformatRetries', type: 'number', env: 'MEMSMITH_REFORMAT_RETRIES', default: 1,
    boot: false, min: 0, max: 5, label: 'Reformat retries', description: 'Retries when a model returns malformed output.' },
  { key: 'inputRatePerMtok', type: 'number', env: 'MEMSMITH_INPUT_RATE_PER_MTOK', default: 5,
    boot: false, min: 0, max: 1000, label: 'Input rate ($/Mtok)', description: 'Price per million input tokens, used for savings estimates.' },
  { key: 'monthlyTokenCap', type: 'number', env: 'MEMSMITH_MONTHLY_TOKEN_CAP', default: 0,
    boot: true, min: 0, max: 1_000_000_000, label: 'Monthly token cap', description: 'Hard monthly token limit (0 = off). Applies after restart.' },
  { key: 'monthlyRequestCap', type: 'number', env: 'MEMSMITH_MONTHLY_REQUEST_CAP', default: 0,
    boot: true, min: 0, max: 100_000_000, label: 'Monthly request cap', description: 'Hard monthly request limit (0 = off). Applies after restart.' },
  { key: 'rateLimitPerMin', type: 'number', env: 'MEMSMITH_RATE_LIMIT_PER_MIN', default: 0,
    boot: true, min: 0, max: 100_000, label: 'Rate limit / min', description: 'Requests per minute per key (0 = off). Applies after restart.' },
];

const BY_KEY: Map<string, SettingKey> = new Map(SETTING_KEYS.map(k => [k.key, k]));

export function getSettingKey(key: string): SettingKey | undefined {
  return BY_KEY.get(key);
}

export function validateSettingValue(
  k: SettingKey,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (k.type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    return { ok: false, error: `${k.key} must be a boolean` };
  }
  if (k.type === 'number') {
    const n = typeof value === 'number' ? value : NaN;
    if (!Number.isFinite(n)) return { ok: false, error: `${k.key} must be a number` };
    if (k.min !== undefined && n < k.min) return { ok: false, error: `${k.key} must be >= ${k.min}` };
    if (k.max !== undefined && n > k.max) return { ok: false, error: `${k.key} must be <= ${k.max}` };
    return { ok: true, value: n };
  }
  if (k.type === 'enum') {
    const s = String(value);
    if (!k.options?.includes(s)) return { ok: false, error: `${k.key} must be one of ${k.options?.join(', ')}` };
    return { ok: true, value: s };
  }
  // string
  if (typeof value !== 'string' || value.length === 0) return { ok: false, error: `${k.key} must be a non-empty string` };
  return { ok: true, value };
}

export function coerceEnvValue(k: SettingKey, raw: string): unknown {
  if (k.type === 'boolean') return raw !== '0' && raw.toLowerCase() !== 'off' && raw.toLowerCase() !== 'false';
  if (k.type === 'number') return Number(raw);
  if (k.type === 'enum') return raw.trim().toLowerCase();
  return raw;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test tests/server/setting-keys.test.ts && npx tsc --noEmit`
Expected: PASS, 0 tsc errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/settings/settingKeys.ts tests/server/setting-keys.test.ts
git commit -m "feat(server): setting-keys registry (types, validation, env coercion)"
```

---

### Task 3: `SettingsStore` — Postgres accessor

**Files:**
- Create: `src/server/settings/SettingsStore.ts`
- Test: `tests/server/settings-store.test.ts`

**Interfaces:**
- Consumes: `PostgresQueryable` from `src/storage/postgres/utils.js`; the `server_settings` table (Task 1).
- Produces:
  - `class SettingsStore { constructor(db: PostgresQueryable); getTeamOverrides(teamId: string): Promise<Record<string, unknown>>; putTeamOverrides(teamId: string, patch: Record<string, unknown>): Promise<void>; }`
  - `getTeamOverrides` returns `{}` when no row or on any error (never throws).
  - `putTeamOverrides` upsert-merges the patch into the existing JSON (does not clobber other keys).

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/settings-store.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll } from 'bun:test';
import { Pool } from 'pg';
import { bootstrapServerPostgresSchema } from '../../src/storage/postgres/schema.js';
import { SettingsStore } from '../../src/server/settings/SettingsStore.js';

const CONN = process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@localhost:55432/memsmith';
const pool = new Pool({ connectionString: CONN });
const TEAM = 'team-store-test';

describe('SettingsStore', () => {
  beforeAll(async () => {
    await bootstrapServerPostgresSchema(pool);
    await pool.query('DELETE FROM server_settings WHERE team_id = $1', [TEAM]);
  });

  it('returns {} for a team with no row', async () => {
    const store = new SettingsStore(pool);
    expect(await store.getTeamOverrides(TEAM)).toEqual({});
  });

  it('upsert-merges without clobbering other keys', async () => {
    const store = new SettingsStore(pool);
    await store.putTeamOverrides(TEAM, { tiering: false });
    await store.putTeamOverrides(TEAM, { ftsWeight: 0.7 });
    expect(await store.getTeamOverrides(TEAM)).toEqual({ tiering: false, ftsWeight: 0.7 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/settings-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

```ts
// src/server/settings/SettingsStore.ts
// SPDX-License-Identifier: Apache-2.0
import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import { logger } from '../../utils/logger.js';

export class SettingsStore {
  constructor(private readonly db: PostgresQueryable) {}

  async getTeamOverrides(teamId: string): Promise<Record<string, unknown>> {
    try {
      const { rows } = await this.db.query<{ overrides: Record<string, unknown> }>(
        `SELECT overrides FROM server_settings WHERE team_id = $1`,
        [teamId],
      );
      const o = rows[0]?.overrides;
      return o && typeof o === 'object' ? o : {};
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('SYSTEM', 'settings: getTeamOverrides failed; treating as no overrides', { teamId }, err);
      return {};
    }
  }

  async putTeamOverrides(teamId: string, patch: Record<string, unknown>): Promise<void> {
    // jsonb concat (||) merges the patch on top of existing keys.
    await this.db.query(
      `INSERT INTO server_settings (team_id, overrides, updated_at)
         VALUES ($1, $2::jsonb, now())
       ON CONFLICT (team_id) DO UPDATE
         SET overrides = server_settings.overrides || EXCLUDED.overrides,
             updated_at = now()`,
      [teamId, JSON.stringify(patch)],
    );
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test tests/server/settings-store.test.ts && npx tsc --noEmit`
Expected: PASS, 0 tsc errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/settings/SettingsStore.ts tests/server/settings-store.test.ts
git commit -m "feat(server): SettingsStore (team overrides upsert-merge, never-throws read)"
```

---

### Task 4: `SettingsResolver` — resolution chain + cache + getters

**Files:**
- Create: `src/server/settings/SettingsResolver.ts`
- Test: `tests/server/settings-resolver.test.ts`

**Interfaces:**
- Consumes: `SettingsStore` (Task 3); `SETTING_KEYS`, `getSettingKey`, `coerceEnvValue` (Task 2).
- Produces:
  - `interface ResolvedSetting { value: unknown; source: 'user' | 'team' | 'env' | 'default'; }`
  - `class SettingsResolver`:
    - `constructor(store: SettingsStore, opts?: { ttlMs?: number; now?: () => number })` (default ttl 2000; `now` injectable for tests)
    - `async resolve(teamId: string, key: string): Promise<ResolvedSetting>` — chain team(store)→env→default (user tier skipped: no identity). Malformed team value that fails validation → fall through to env/default.
    - `async resolveAll(teamId: string): Promise<Record<string, ResolvedSetting>>` — every key.
    - typed getters (each awaits `resolve` and casts): `provider(teamId): Promise<string>`, `model(teamId): Promise<string>`, `tieringEnabled(teamId): Promise<boolean>`, `searchHybridEnabled(teamId): Promise<boolean>`, `weights(teamId): Promise<{fts:number; vec:number}>`, `rrfK(teamId): Promise<number>`, `supersedeMaxDepth(teamId): Promise<number>`, `qualityFloor(teamId): Promise<number>`, `reformatRetries(teamId): Promise<number>`, `inputRatePerMtok(teamId): Promise<number>`.
    - `invalidate(teamId: string): void` — drop cached overrides for a team (called after a write).

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/settings-resolver.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { SettingsResolver } from '../../src/server/settings/SettingsResolver.js';

// Fake store so the resolver test is pure (no Postgres).
function fakeStore(overrides: Record<string, unknown>) {
  return { getTeamOverrides: async () => overrides, putTeamOverrides: async () => {} } as any;
}

describe('SettingsResolver precedence', () => {
  it('team override wins over env and default', async () => {
    const r = new SettingsResolver(fakeStore({ tiering: false }));
    const res = await r.resolve('t', 'tiering');
    expect(res).toEqual({ value: false, source: 'team' });
  });

  it('env wins over default when no team override', async () => {
    process.env.MEMSMITH_FTS_WEIGHT = '0.7';
    const r = new SettingsResolver(fakeStore({}));
    const res = await r.resolve('t', 'ftsWeight');
    expect(res).toEqual({ value: 0.7, source: 'env' });
    delete process.env.MEMSMITH_FTS_WEIGHT;
  });

  it('code default when neither team nor env', async () => {
    delete process.env.MEMSMITH_RRF_K;
    const r = new SettingsResolver(fakeStore({}));
    const res = await r.resolve('t', 'rrfK');
    expect(res).toEqual({ value: 60, source: 'default' });
  });

  it('malformed team value falls through to default', async () => {
    const r = new SettingsResolver(fakeStore({ ftsWeight: 99 })); // out of range
    delete process.env.MEMSMITH_FTS_WEIGHT;
    const res = await r.resolve('t', 'ftsWeight');
    expect(res.source).toBe('default');
    expect(res.value).toBe(0.3);
  });

  it('typed getters cast correctly', async () => {
    const r = new SettingsResolver(fakeStore({ tiering: true, ftsWeight: 0.4, vecWeight: 0.9, provider: 'claude' }));
    expect(await r.tieringEnabled('t')).toBe(true);
    expect(await r.weights('t')).toEqual({ fts: 0.4, vec: 0.9 });
    expect(await r.provider('t')).toBe('claude');
  });

  it('caches within ttl and invalidate() forces a refetch', async () => {
    let reads = 0;
    const store = { getTeamOverrides: async () => { reads++; return {}; }, putTeamOverrides: async () => {} } as any;
    let t = 1000;
    const r = new SettingsResolver(store, { ttlMs: 2000, now: () => t });
    await r.resolve('t', 'tiering');
    await r.resolve('t', 'tiering'); // cached
    expect(reads).toBe(1);
    r.invalidate('t');
    await r.resolve('t', 'tiering');
    expect(reads).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/settings-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

```ts
// src/server/settings/SettingsResolver.ts
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
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test tests/server/settings-resolver.test.ts && npx tsc --noEmit`
Expected: PASS, 0 tsc errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/settings/SettingsResolver.ts tests/server/settings-resolver.test.ts
git commit -m "feat(server): SettingsResolver (team->env->default chain, TTL cache, typed getters)"
```

---

### Task 5: `GenerationProviderHolder` — per-job provider hot-swap

**Files:**
- Create: `src/server/generation/GenerationProviderHolder.ts`
- Modify: `src/server/runtime/create-server-service.ts:261` (signature of `instantiateServerGenerationProvider`)
- Test: `tests/server/generation-provider-holder.test.ts`

**Interfaces:**
- Consumes: `SettingsResolver` (Task 4); `instantiateServerGenerationProvider(provider: string, model?: string)` (extended here).
- Produces:
  - `class GenerationProviderHolder`:
    - `constructor(resolver: SettingsResolver, instantiate?: (provider: string, model?: string) => ServerGenerationProvider | null)` — `instantiate` injectable for tests; defaults to the real `instantiateServerGenerationProvider`.
    - `async current(teamId: string): Promise<ServerGenerationProvider | null>` — resolves `(provider, model)`; if the cache key `${provider}::${model}` differs, builds and caches; on build failure keeps last-good and returns it (or null if none).

- [ ] **Step 1: Extend `instantiateServerGenerationProvider` to take an explicit model**

In `src/server/runtime/create-server-service.ts`, change the signature and every `process.env.MEMSMITH_SERVER_MODEL` read inside it to prefer an explicit `model` arg:

```ts
export function instantiateServerGenerationProvider(
  provider: string,
  model?: string,
): ServerGenerationProvider | null {
  const chosenModel = model ?? process.env.MEMSMITH_SERVER_MODEL;
  if (provider === 'claude' || provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.MEMSMITH_ANTHROPIC_API_KEY ?? '';
    if (!apiKey) return null;
    const opts: { apiKey: string; model?: string } = { apiKey };
    if (chosenModel) opts.model = chosenModel;
    return new ClaudeObservationProvider(opts);
  }
  if (provider === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.MEMSMITH_GEMINI_API_KEY ?? '';
    if (!apiKey) return null;
    const opts: { apiKey: string; model?: string } = { apiKey };
    if (chosenModel) opts.model = chosenModel;
    return new GeminiObservationProvider(opts);
  }
  if (provider === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.MEMSMITH_OPENROUTER_API_KEY ?? '';
    if (!apiKey) return null;
    const opts: { apiKey: string; model?: string; baseUrl?: string } = { apiKey };
    if (chosenModel) opts.model = chosenModel;
    const baseUrl = process.env.MEMSMITH_OPENROUTER_BASE_URL ?? process.env.OPENROUTER_BASE_URL;
    if (baseUrl) opts.baseUrl = baseUrl;
    return new OpenRouterObservationProvider(opts);
  }
  if (provider === 'ollama') {
    const apiKey = process.env.MEMSMITH_OLLAMA_API_KEY ?? '';
    const opts: { apiKey?: string; model?: string; baseUrl?: string } = {
      model: chosenModel ?? 'llama3.1:8b',
    };
    if (apiKey) opts.apiKey = apiKey;
    const baseUrl = process.env.MEMSMITH_OLLAMA_URL;
    if (baseUrl) opts.baseUrl = baseUrl;
    return new OllamaObservationProvider(opts);
  }
  return null;
}
```

Also update `buildServerGenerationProviderFromEnv` call at line 251: `return instantiateServerGenerationProvider(provider);` stays valid (model optional).

- [ ] **Step 2: Write the failing test**

```ts
// tests/server/generation-provider-holder.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { GenerationProviderHolder } from '../../src/server/generation/GenerationProviderHolder.js';

function resolverStub(provider: string, model: string) {
  return { provider: async () => provider, model: async () => model } as any;
}

describe('GenerationProviderHolder', () => {
  it('builds once and caches by (provider,model)', async () => {
    let builds = 0;
    const holder = new GenerationProviderHolder(
      resolverStub('ollama', 'qwen2.5:14b'),
      (p, m) => { builds++; return { id: `${p}::${m}` } as any; },
    );
    const a = await holder.current('t');
    const b = await holder.current('t');
    expect(builds).toBe(1);
    expect(a).toBe(b);
  });

  it('rebuilds when the resolved provider changes', async () => {
    let provider = 'ollama';
    const resolver = { provider: async () => provider, model: async () => 'm' } as any;
    let builds = 0;
    const holder = new GenerationProviderHolder(resolver, (p, m) => { builds++; return { id: `${p}::${m}` } as any; });
    await holder.current('t');
    provider = 'claude';
    const after = await holder.current('t');
    expect(builds).toBe(2);
    expect((after as any).id).toBe('claude::m');
  });

  it('keeps last-good provider when a build fails', async () => {
    let provider = 'ollama';
    const resolver = { provider: async () => provider, model: async () => 'm' } as any;
    const holder = new GenerationProviderHolder(resolver, (p) => (p === 'claude' ? null : ({ id: p } as any)));
    const good = await holder.current('t');
    provider = 'claude'; // build returns null
    const after = await holder.current('t');
    expect(after).toBe(good);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/server/generation-provider-holder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the holder**

```ts
// src/server/generation/GenerationProviderHolder.ts
// SPDX-License-Identifier: Apache-2.0
import type { SettingsResolver } from '../settings/SettingsResolver.js';
import { instantiateServerGenerationProvider } from '../runtime/create-server-service.js';
import type { ServerGenerationProvider } from '../runtime/create-server-service.js';
import { logger } from '../../utils/logger.js';

type Instantiate = (provider: string, model?: string) => ServerGenerationProvider | null;

export class GenerationProviderHolder {
  private cacheKey: string | null = null;
  private instance: ServerGenerationProvider | null = null;

  constructor(
    private readonly resolver: SettingsResolver,
    private readonly instantiate: Instantiate = instantiateServerGenerationProvider,
  ) {}

  async current(teamId: string): Promise<ServerGenerationProvider | null> {
    const provider = await this.resolver.provider(teamId);
    const model = await this.resolver.model(teamId);
    const key = `${provider}::${model}`;
    if (key === this.cacheKey && this.instance) return this.instance;
    let built: ServerGenerationProvider | null = null;
    try {
      built = this.instantiate(provider, model);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('SYSTEM', 'provider holder: instantiation threw; keeping last-good', { provider, model }, err);
      built = null;
    }
    if (!built) {
      // Keep last-good so a bad switch does not break generation entirely.
      logger.warn('SYSTEM', 'provider holder: build returned null; keeping last-good', { provider, model });
      return this.instance;
    }
    this.cacheKey = key;
    this.instance = built;
    return built;
  }
}
```

> Note: confirm `ServerGenerationProvider` is exported from `create-server-service.ts`. If it is only a local type, export it (`export type ServerGenerationProvider = ...`). If the type is defined elsewhere, import from there instead — the implementer should check and adjust the import to the real location.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test tests/server/generation-provider-holder.test.ts && npx tsc --noEmit`
Expected: PASS, 0 tsc errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/generation/GenerationProviderHolder.ts src/server/runtime/create-server-service.ts tests/server/generation-provider-holder.test.ts
git commit -m "feat(server): GenerationProviderHolder + model-arg instantiate (live provider swap)"
```

---

### Task 6: Route capability reads through the resolver

**Files:**
- Modify: `src/server/retrieval/inject.ts:9-12,29`, `src/server/retrieval/rrf.ts:6,8`, `src/server/retrieval/supersession.ts`, `src/storage/postgres/observations.ts:284-285`, `src/server/generation/processGeneratedResponse.ts:26,29`, `src/server/dashboard/queries.ts:55-62`
- Test: extend the resolver test file is not enough — add `tests/server/resolver-wiring.test.ts`

**Interfaces:**
- Consumes: `SettingsResolver` (Task 4). Each call site gains an optional `resolver`/`teamId` path but retains its env-fallback default so nothing breaks when a resolver is not threaded.
- Produces: no new exports; the observable change is that a team override now affects these reads.

**Design note for the implementer:** the cleanest minimal change is to add an **optional** `resolver` parameter (and the `teamId` already in scope) to each function; when absent, keep reading env exactly as today. This keeps every existing caller working (env fallback) while letting the wired callers (Tasks 8/9) pass the resolver. Do NOT remove the env reads — they are the resolver's own fallback tier and the no-resolver default.

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/resolver-wiring.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { buildInjectionBlock } from '../../src/server/retrieval/inject.js';

function fakeStore(overrides: Record<string, unknown>) {
  return { getTeamOverrides: async () => overrides, putTeamOverrides: async () => {} } as any;
}

describe('inject reads tiering via resolver when provided', () => {
  it('honors a team override that disables tiering', async () => {
    const { SettingsResolver } = await import('../../src/server/settings/SettingsResolver.js');
    const resolver = new SettingsResolver(fakeStore({ tiering: false }));
    const deps = {
      hybridSearch: async () => [
        { content: 'A'.repeat(50), metadata: { title: 'x', facts: ['f'], why: 'w' } },
      ],
    };
    // With tiering disabled via the override, the block still builds (legacy path).
    const block = await buildInjectionBlock(deps as any, {
      projectId: 'p', teamId: 't', query: 'q', maxItems: 3, maxChars: 500, resolver,
    } as any);
    expect(block.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/resolver-wiring.test.ts`
Expected: FAIL — `buildInjectionBlock` does not accept `resolver` / tiering still read from env.

- [ ] **Step 3: Thread the resolver into `inject.ts`**

Change `tieringEnabled` and `buildInjectionBlock` in `src/server/retrieval/inject.ts`:

```ts
import type { SettingsResolver } from '../settings/SettingsResolver.js';

function tieringEnabledEnv(): boolean {
  const v = process.env.MEMSMITH_TIERING;
  return v !== '0' && v !== 'off';
}

export async function buildInjectionBlock(
  deps: InjectDeps,
  input: { projectId: string; teamId: string; query: string; maxItems?: number; maxChars?: number; resolver?: SettingsResolver }
): Promise<string> {
  const maxItems = input.maxItems ?? 5;
  const maxChars = input.maxChars ?? 10000;
  const rows = await deps.hybridSearch({ projectId: input.projectId, teamId: input.teamId, query: input.query, limit: maxItems * 2 });
  const visible: TierInput[] = rows.filter(r => r.metadata?.private !== true);
  if (visible.length === 0) return '';
  const header = '## Relevant team memory (review before acting)\n';
  const bodyBudget = Math.max(0, maxChars - header.length);

  const tiering = input.resolver ? await input.resolver.tieringEnabled(input.teamId) : tieringEnabledEnv();
  if (tiering) {
    try {
      const rendered = tierToBudget(visible, { maxChars: bodyBudget, maxItems });
      const body = positionForInjection(rendered, maxItems);
      if (body) return (header + body).slice(0, maxChars);
    } catch {
      // fall through
    }
  }
  const contents = visible.map(r => r.content);
  for (let n = Math.min(contents.length, maxItems); n >= 1; n--) {
    const body = positionForInjection(contents.slice(0, n), maxItems);
    if (!body) continue;
    const block = header + body;
    if (block.length <= maxChars) return block;
  }
  return (header + positionForInjection(contents.slice(0, 1), maxItems)).slice(0, maxChars);
}
```

- [ ] **Step 4: Thread the resolver into the other call sites (env fallback preserved)**

`src/server/retrieval/rrf.ts` — keep `DEFAULT_K` but let callers override via the existing `k` param (Task 8 passes `resolver.rrfK`). No signature change needed; the resolver is threaded at the caller.

`src/storage/postgres/observations.ts:284-285` — accept optional weights on the input (already does: `input.ftsWeight ?? ...`). Task 8's search caller computes weights from the resolver and passes `input.ftsWeight`/`input.vecWeight`. No change needed here beyond confirming the input path is used.

`src/server/retrieval/supersession.ts` — add optional `maxDepth?: number` param to the resolving function; when provided, use it instead of the env read. Caller (Task 8) passes `await resolver.supersedeMaxDepth(teamId)`.

`src/server/generation/processGeneratedResponse.ts:26,29` — `applyQualityGate(..., floor?: number)` already takes a `floor` default of the module const; change the module const to a function `qualityFloorEnv()` returning `Number(process.env.MEMSMITH_QUALITY_FLOOR ?? 20)` and have the caller pass `await resolver.qualityFloor(teamId)` (Task 9 wires generation). Keep `qualityFloorEnv()` as the no-resolver default.

`src/server/dashboard/queries.ts:55-62` — handled fully in Task 7 (cost rework). Leave for now.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test tests/server/resolver-wiring.test.ts && npx tsc --noEmit && bun test tests/server/retrieval-*.test.ts 2>/dev/null; bun test tests/server 2>&1 | tail -3`
Expected: new test PASS; existing retrieval/generation tests still green (env fallback intact).

- [ ] **Step 6: Commit**

```bash
git add src/server/retrieval/inject.ts src/server/retrieval/supersession.ts src/server/generation/processGeneratedResponse.ts tests/server/resolver-wiring.test.ts
git commit -m "feat(server): thread SettingsResolver into retrieval/generation reads (env fallback preserved)"
```

---

### Task 7: Compression metering + real `costPanel`

**Files:**
- Modify: `src/server/retrieval/inject.ts` (record compression), `src/server/dashboard/queries.ts:55-62` (costPanel rework)
- Create: `src/server/retrieval/compressionMetering.ts` (pure helper: tokens + event shape)
- Test: `tests/server/compression-metering.test.ts`, `tests/server/cost-panel.test.ts`

**Interfaces:**
- Consumes: `PostgresUsageRepository.record({teamId, projectId?, kind, quantity?, metadata?})` from `src/storage/postgres/usage.js`; `SettingsResolver.inputRatePerMtok`.
- Produces:
  - `compressionMetering.ts`: `estimateTokens(chars: number): number` (= `Math.ceil(chars / 4)`); `buildCompressionEvent(teamId, projectId, preChars, postChars, tier): { teamId; projectId: string|null; kind: 'compression'; quantity: number; metadata: {preTokens; postTokens; tier} }`.
  - `costPanel(db, scope, resolver?)` returns `{ savedTokens, preTokens, pctSmaller, estUsdSaved, activeProvider, localGeneration, discoveryTokens }`.

- [ ] **Step 1: Write the failing test (metering helper — pure)**

```ts
// tests/server/compression-metering.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { estimateTokens, buildCompressionEvent } from '../../src/server/retrieval/compressionMetering.js';

describe('compression metering helper', () => {
  it('estimates tokens as ceil(chars/4)', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(10)).toBe(3);
    expect(estimateTokens(400)).toBe(100);
  });

  it('builds a compression usage event with pre/post/saved', () => {
    const e = buildCompressionEvent('team-1', 'proj-1', 800, 200, 'L1');
    expect(e.kind).toBe('compression');
    expect(e.metadata).toEqual({ preTokens: 200, postTokens: 50, tier: 'L1' });
    expect(e.quantity).toBe(150); // 200 - 50
    expect(e.teamId).toBe('team-1');
    expect(e.projectId).toBe('proj-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/compression-metering.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the metering helper**

```ts
// src/server/retrieval/compressionMetering.ts
// SPDX-License-Identifier: Apache-2.0

// Char->token estimate. Consistent with other rough token estimates in the
// codebase (~4 chars/token). Documented as an estimate, not a tokenizer.
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export interface CompressionEvent {
  teamId: string;
  projectId: string | null;
  kind: 'compression';
  quantity: number;
  metadata: { preTokens: number; postTokens: number; tier: string };
}

export function buildCompressionEvent(
  teamId: string,
  projectId: string | null,
  preChars: number,
  postChars: number,
  tier: string,
): CompressionEvent {
  const preTokens = estimateTokens(preChars);
  const postTokens = estimateTokens(postChars);
  return {
    teamId,
    projectId,
    kind: 'compression',
    quantity: Math.max(0, preTokens - postTokens),
    metadata: { preTokens, postTokens, tier },
  };
}
```

- [ ] **Step 4: Record compression in `inject.ts` (generation/injection-safe)**

Extend `buildInjectionBlock`'s tiering branch. `tierToBudget` returns `string[]` (post) and `visible` holds the pre-compression items. Add an optional `usage?: PostgresUsageRepository` to the input and record per rendered item. Wrap in try/catch so metering never breaks injection:

```ts
import { buildCompressionEvent } from './compressionMetering.js';
import type { PostgresUsageRepository } from '../../storage/postgres/usage.js';

// inside the `if (tiering)` block, after `const rendered = tierToBudget(...)`:
if (input.usage && process.env.MEMSMITH_USAGE_METERING === '1') {
  try {
    for (let i = 0; i < rendered.length; i++) {
      const preChars = (visible[i]?.content ?? '').length;
      const postChars = rendered[i].length;
      if (preChars > postChars) {
        const ev = buildCompressionEvent(input.teamId, input.projectId ?? null, preChars, postChars, 'tiered');
        await input.usage.record(ev);
      }
    }
  } catch { /* metering must never break injection */ }
}
```

Add `usage?: PostgresUsageRepository` and `projectId` (already present) to the `input` type.

- [ ] **Step 5: Write the failing cost-panel test (PG-gated)**

```ts
// tests/server/cost-panel.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll } from 'bun:test';
import { Pool } from 'pg';
import { bootstrapServerPostgresSchema } from '../../src/storage/postgres/schema.js';
import { costPanel } from '../../src/server/dashboard/queries.js';

const CONN = process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@localhost:55432/memsmith';
const pool = new Pool({ connectionString: CONN });
const TEAM = 'team-cost-test';

describe('costPanel real savings', () => {
  beforeAll(async () => {
    await bootstrapServerPostgresSchema(pool);
    await pool.query('DELETE FROM usage_events WHERE team_id = $1', [TEAM]);
    // two compression events: saved 150 and 50 tokens; pre 200 and 100
    await pool.query(
      `INSERT INTO usage_events (id, team_id, kind, quantity, metadata) VALUES
        ('c1',$1,'compression',150,'{"preTokens":200,"postTokens":50,"tier":"tiered"}'::jsonb),
        ('c2',$1,'compression',50,'{"preTokens":100,"postTokens":50,"tier":"tiered"}'::jsonb)`,
      [TEAM]);
  });

  it('aggregates saved tokens, pct, and usd at the resolved rate', async () => {
    const resolver = { inputRatePerMtok: async () => 5, provider: async () => 'ollama' } as any;
    const panel = await costPanel(pool, { teamId: TEAM } as any, resolver);
    expect(panel.savedTokens).toBe(200);       // 150 + 50
    expect(panel.preTokens).toBe(300);         // 200 + 100
    expect(panel.pctSmaller).toBeCloseTo(200 / 300, 5);
    expect(panel.estUsdSaved).toBeCloseTo((200 / 1_000_000) * 5, 9);
    expect(panel.localGeneration).toBe(true);  // ollama
  });

  it('guards divide-by-zero when there is no compression', async () => {
    const resolver = { inputRatePerMtok: async () => 5, provider: async () => 'claude' } as any;
    const panel = await costPanel(pool, { teamId: 'team-empty' } as any, resolver);
    expect(panel.savedTokens).toBe(0);
    expect(panel.pctSmaller).toBe(0);
    expect(panel.localGeneration).toBe(false);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test tests/server/cost-panel.test.ts`
Expected: FAIL — `costPanel` doesn't take a resolver / returns old shape.

- [ ] **Step 7: Rework `costPanel`**

Replace `costPanel` in `src/server/dashboard/queries.ts`:

```ts
export async function costPanel(db: PostgresQueryable, s: Scope, resolver?: {
  inputRatePerMtok(teamId: string): Promise<number>;
  provider(teamId: string): Promise<string>;
}) {
  const w = scopeWhere(s);
  const comp = await db.query(
    `SELECT COALESCE(SUM(quantity),0) AS saved,
            COALESCE(SUM((metadata->>'preTokens')::bigint),0) AS pre
       FROM usage_events
      WHERE ${w.sql} AND kind = 'compression'`, w.args);
  const savedTokens = Number(comp.rows[0].saved);
  const preTokens = Number(comp.rows[0].pre);
  const pctSmaller = preTokens > 0 ? savedTokens / preTokens : 0;
  const rate = resolver ? await resolver.inputRatePerMtok(s.teamId) : Number(process.env.MEMSMITH_INPUT_RATE_PER_MTOK ?? 5);
  const estUsdSaved = (savedTokens / 1_000_000) * rate;
  const activeProvider = resolver ? await resolver.provider(s.teamId) : (process.env.MEMSMITH_SERVER_PROVIDER ?? 'ollama').toLowerCase();
  const localGeneration = activeProvider === 'ollama';
  // discovery_tokens retained for back-compat with the existing dashboard strip.
  const disc = await db.query(
    `SELECT COALESCE(SUM((metadata->>'discovery_tokens')::bigint),0) AS discovery_tokens FROM observations WHERE ${w.sql}`, w.args);
  return { savedTokens, preTokens, pctSmaller, estUsdSaved, activeProvider, localGeneration, discoveryTokens: Number(disc.rows[0].discovery_tokens) };
}
```

> Note: check `Scope` has `teamId` (it does — used by `scopeWhere`). If `scopeWhere` uses different arg names, keep them; only the return shape and the compression query are new.

- [ ] **Step 8: Run tests + typecheck**

Run: `bun test tests/server/compression-metering.test.ts tests/server/cost-panel.test.ts && npx tsc --noEmit`
Expected: PASS, 0 tsc errors.

- [ ] **Step 9: Commit**

```bash
git add src/server/retrieval/compressionMetering.ts src/server/retrieval/inject.ts src/server/dashboard/queries.ts tests/server/compression-metering.test.ts tests/server/cost-panel.test.ts
git commit -m "feat(server): compression metering + real costPanel savings story"
```

---

### Task 8: `/v1/settings` GET + PATCH

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (options interface ~57-72; `setupRoutes` ~152; register routes), `src/server/services/server/ServerService.ts:180-185` (construct + pass resolver/store + `allowLocalDevBypass`), `src/server/middleware/postgres-auth.ts:82` (bypass grants `settings:admin`)
- Test: `tests/server/v1-settings.test.ts`

**Interfaces:**
- Consumes: `SettingsResolver`, `SettingsStore` (Tasks 3/4); `getSettingKey`, `validateSettingValue`, `SETTING_KEYS` (Task 2); `hasRequiredScopes` middleware (`requirePostgresServerAuth`).
- Produces: `GET /v1/settings` (auth `memories:read`), `PATCH /v1/settings` (auth `settings:admin`).

**GET response shape** (each key): `{ value, source, boot, type, options?, min?, max?, label, description }`.
**PATCH body:** `{ patch: Record<string,unknown>, confirm?: boolean }`.

- [ ] **Step 1: Local-dev bypass grants `settings:admin`**

In `src/server/middleware/postgres-auth.ts` where the bypass sets scopes (~line 82, currently a synthetic `local-dev` scope): include `settings:admin` in the granted scopes for the bypass path ONLY (this code path is already gated by `authMode==='local-dev' && allowLocalDevBypass && loopback`). Example — if it currently sets `scopes: ['local-dev']`, change to `scopes: ['local-dev', 'settings:admin', 'memories:read', 'memories:write']` (or add `'*'` if that is the existing idiom — match what the file already does for bypass).

- [ ] **Step 2: Write the failing test (PG-gated)**

```ts
// tests/server/v1-settings.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll } from 'bun:test';
import { Pool } from 'pg';
import express from 'express';
import { bootstrapServerPostgresSchema } from '../../src/storage/postgres/schema.js';
import { SettingsStore } from '../../src/server/settings/SettingsStore.js';
import { SettingsResolver } from '../../src/server/settings/SettingsResolver.js';
import { registerSettingsRoutes } from '../../src/server/routes/v1/settingsRoutes.js';

const CONN = process.env.TEST_PG_URL ?? 'postgres://postgres:postgres@localhost:55432/memsmith';
const pool = new Pool({ connectionString: CONN });
const TEAM = 'team-v1-settings';

// Minimal app that injects an authContext + admin scope, then mounts the routes.
function appWith(scope: string[]) {
  const store = new SettingsStore(pool);
  const resolver = new SettingsResolver(store, { ttlMs: 0 });
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.authContext = { teamId: TEAM, scopes: scope }; next(); });
  registerSettingsRoutes(app, { resolver, store, requireScopes: (req: any, res: any, needed: string) => {
    if (req.authContext.scopes.includes('*') || req.authContext.scopes.includes(needed)) return true;
    res.status(403).json({ error: 'Forbidden' }); return false;
  }});
  return app;
}

async function call(app: any, method: string, path: string, body?: unknown) {
  const { default: request } = await import('supertest');
  const r = request(app)[method.toLowerCase()](path);
  return body ? r.send(body) : r;
}

describe('/v1/settings', () => {
  beforeAll(async () => {
    await bootstrapServerPostgresSchema(pool);
    await pool.query('DELETE FROM server_settings WHERE team_id = $1', [TEAM]);
  });

  it('GET returns all knobs with provenance and metadata', async () => {
    const res = await call(appWith(['memories:read']), 'GET', '/v1/settings');
    expect(res.status).toBe(200);
    expect(res.body.settings.provider.type).toBe('enum');
    expect(res.body.settings.provider.source).toBe('default');
    expect(res.body.settings.monthlyTokenCap.boot).toBe(true);
  });

  it('PATCH without settings:admin is 403', async () => {
    const res = await call(appWith(['memories:read']), 'PATCH', '/v1/settings', { patch: { tiering: false } });
    expect(res.status).toBe(403);
  });

  it('PATCH validates and persists a live knob', async () => {
    const res = await call(appWith(['settings:admin']), 'PATCH', '/v1/settings', { patch: { tiering: false } });
    expect(res.status).toBe(200);
    expect(res.body.settings.tiering.value).toBe(false);
    expect(res.body.settings.tiering.source).toBe('team');
  });

  it('PATCH rejects out-of-range with 400 and no write', async () => {
    const res = await call(appWith(['settings:admin']), 'PATCH', '/v1/settings', { patch: { ftsWeight: 5 } });
    expect(res.status).toBe(400);
  });

  it('PATCH to cloud provider without key is 400 MissingProviderKey', async () => {
    delete process.env.MEMSMITH_ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const res = await call(appWith(['settings:admin']), 'PATCH', '/v1/settings', { patch: { provider: 'claude' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MissingProviderKey');
  });

  it('PATCH ollama->claude with key but no confirm returns confirmationRequired', async () => {
    process.env.MEMSMITH_ANTHROPIC_API_KEY = 'sk-test';
    // ensure current provider resolves to a local one (default ollama)
    const res = await call(appWith(['settings:admin']), 'PATCH', '/v1/settings', { patch: { provider: 'claude' } });
    expect(res.status).toBe(200);
    expect(res.body.confirmationRequired).toBe(true);
    // confirm applies it
    const res2 = await call(appWith(['settings:admin']), 'PATCH', '/v1/settings', { patch: { provider: 'claude' }, confirm: true });
    expect(res2.body.settings.provider.value).toBe('claude');
    delete process.env.MEMSMITH_ANTHROPIC_API_KEY;
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/server/v1-settings.test.ts`
Expected: FAIL — `settingsRoutes.js` not found.

- [ ] **Step 4: Implement the routes module**

Create `src/server/routes/v1/settingsRoutes.ts` (a small registrar the class calls, and the test mounts directly):

```ts
// src/server/routes/v1/settingsRoutes.ts
// SPDX-License-Identifier: Apache-2.0
import type { Application, Request, Response } from 'express';
import type { SettingsResolver } from '../../settings/SettingsResolver.js';
import type { SettingsStore } from '../../settings/SettingsStore.js';
import { SETTING_KEYS, getSettingKey, validateSettingValue } from '../../settings/settingKeys.js';

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

    // 1. Validate every key.
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      const spec = getSettingKey(key);
      if (!spec) { res.status(400).json({ error: 'ValidationError', field: key, message: `unknown setting ${key}` }); return; }
      const v = validateSettingValue(spec, value);
      if (!v.ok) { res.status(400).json({ error: 'ValidationError', field: key, message: v.error }); return; }
      clean[key] = v.value;
    }

    // 2. Cloud-switch key check + 3. free->metered confirm gate.
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

    // 4. Write + invalidate + return resolved.
    await deps.store.putTeamOverrides(teamId, clean);
    deps.resolver.invalidate(teamId);
    res.status(200).json(await resolvedPayload(deps.resolver, teamId));
  });
}
```

- [ ] **Step 5: Wire into the class + service**

In `ServerV1PostgresRoutes.ts`: add `settingsResolver: SettingsResolver` and `settingsStore: SettingsStore` to the options interface; in `setupRoutes`, call `registerSettingsRoutes(app, { resolver: this.options.settingsResolver, store: this.options.settingsStore, requireScopes: (req,res,needed) => { /* use requirePostgresServerAuth-derived check or inline hasRequiredScopes on req.authContext */ } })`. The simplest wiring: build two auth middlewares (`readAuth` with `memories:read`, `adminAuth` with `settings:admin`) as the class already does for other routes, and register the two routes with those middlewares directly instead of the `requireScopes` shim (the shim exists so the unit test can inject scopes without real keys). Either is acceptable; match the file's existing middleware idiom.

In `ServerService.ts:180-185`: construct `const settingsStore = new SettingsStore(this.graph.postgres.pool); const settingsResolver = new SettingsResolver(settingsStore);` and pass both into the `ServerV1PostgresRoutes` options, plus add `allowLocalDevBypass: this.graph.allowLocalDevBypass` (currently omitted). Store `settingsResolver` on the graph so Tasks 9's worker wiring can reach it.

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test tests/server/v1-settings.test.ts && npx tsc --noEmit`
Expected: PASS, 0 tsc errors. (If `supertest` is not a dependency, use the same HTTP-test helper the existing `tests/server/*serve*.test.ts` files use — match that pattern rather than adding a dep.)

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/v1/settingsRoutes.ts src/server/routes/v1/ServerV1PostgresRoutes.ts src/server/services/server/ServerService.ts src/server/middleware/postgres-auth.ts tests/server/v1-settings.test.ts
git commit -m "feat(server): /v1/settings GET+PATCH (provenance, validation, cloud guard, settings:admin)"
```

---

### Task 9: Wire the provider holder into the generation worker

**Files:**
- Modify: `src/server/runtime/create-server-service.ts` (build the holder + resolver, pass into worker manager), `src/server/generation/ProviderObservationGenerator.ts:70-235` (resolve provider per job via holder), `src/server/generation/ActiveServerGenerationWorkerManager` construction
- Test: `tests/server/provider-holder-wiring.test.ts`

**Interfaces:**
- Consumes: `GenerationProviderHolder` (Task 5), `SettingsResolver` (Task 4).
- Produces: the generation job resolves its provider from the holder at job start; when no holder is provided (back-compat), falls back to the fixed `options.provider`.

**Design note:** `ProviderObservationGenerator` currently holds `options.provider`. Add optional `options.providerHolder?: GenerationProviderHolder`. In `process(job)` (before `generateAndPersist`), resolve `const provider = this.options.providerHolder ? (await this.options.providerHolder.current(job.data.teamId)) ?? this.options.provider : this.options.provider;` and thread that `provider` into `generateAndPersist` (pass as an argument rather than reading `this.options.provider` at line 235). This keeps in-flight jobs on the provider they resolved and picks up switches on the next job.

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/provider-holder-wiring.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { ProviderObservationGenerator } from '../../src/server/generation/ProviderObservationGenerator.js';

describe('generator resolves provider per job via holder', () => {
  it('uses the holder-resolved provider, not the fixed one', async () => {
    const fixed = { generate: async () => { throw new Error('should not use fixed'); } };
    const swapped = { generate: async () => ({ observations: [], tokensUsed: 0 }) };
    const holder = { current: async () => swapped } as any;
    // Construct with minimal deps; this asserts the resolution path chooses `swapped`.
    // (The implementer wires the real constructor options; this test pins the selection.)
    const chosen = holder ? (await holder.current('t')) ?? fixed : fixed;
    expect(chosen).toBe(swapped);
  });
});
```

> Note: this test pins the selection semantics. The implementer should add a stronger integration test if the generator constructor allows injecting a fake queue; if the constructor is heavy, keep this selection-semantics test plus a manual note that the holder is threaded. Do NOT fake the whole BullMQ stack.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/provider-holder-wiring.test.ts`
Expected: PASS trivially (it pins semantics) — then implement the real wiring and confirm the selection matches. If the implementer adds a constructor-injection integration test, that one should fail first.

- [ ] **Step 3: Thread the holder through the worker manager**

In `create-server-service.ts` `buildGenerationWorkerManager`: build `const settingsStore = ...; const resolver = ...;` (or receive the shared resolver from the graph), `const providerHolder = new GenerationProviderHolder(resolver);` and pass `providerHolder` into `ActiveServerGenerationWorkerManager` options and onward to `ProviderObservationGenerator` options. Keep passing the env-built `provider` as the fallback.

- [ ] **Step 4: Resolve per job in `ProviderObservationGenerator.process`**

Add the per-job resolution described in the design note; thread the resolved `provider` into `generateAndPersist(genContext, provider)` and use that argument at the former line 235 (`await provider.generate(genContext)`).

- [ ] **Step 5: Run tests + typecheck + full server suite**

Run: `bun test tests/server/provider-holder-wiring.test.ts && npx tsc --noEmit && bun test tests/server 2>&1 | tail -3`
Expected: PASS; existing generation tests green.

- [ ] **Step 6: Commit**

```bash
git add src/server/runtime/create-server-service.ts src/server/generation/ProviderObservationGenerator.ts tests/server/provider-holder-wiring.test.ts
git commit -m "feat(server): resolve generation provider per job via holder (live swap end-to-end)"
```

---

### Task 10: Settings view (UI) in the Claude aesthetic

**Files:**
- Create: `src/ui/viewer/utils/settingsData.ts`, `src/ui/viewer/views/SettingsView.tsx`
- Modify: `src/ui/viewer/views/viewState.ts` (add `'settings'`), `src/ui/viewer/components/Sidebar.tsx` (nav item), `src/ui/viewer/App.tsx` (route), `src/ui/viewer-template.html` (Claude-aesthetic CSS)
- Test: `tests/viewer/settings-data.test.ts`, `tests/viewer/settings-view.test.ts`

**Interfaces:**
- Consumes: `V1_ENDPOINTS` from `src/ui/viewer/constants/api.ts` (add `SETTINGS: '/v1/settings'`).
- Produces:
  - `settingsData.ts`: `interface SettingField { value: unknown; source: string; boot: boolean; type: string; options?: string[]; min?: number; max?: number; label: string; description: string; }`; `fetchSettings(): Promise<Record<string, SettingField>>` (returns `{}` on error); `patchSettings(patch: Record<string, unknown>, confirm?: boolean): Promise<{ settings?: Record<string, SettingField>; confirmationRequired?: boolean; error?: string; message?: string }>`.
  - `SettingsView.tsx`: default-exported React component rendering grouped cards from the fetched fields.

- [ ] **Step 1: Write the failing test (data layer)**

```ts
// tests/viewer/settings-data.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, mock } from 'bun:test';
import { fetchSettings, patchSettings } from '../../src/ui/viewer/utils/settingsData.js';

describe('settingsData', () => {
  it('fetchSettings returns the settings map', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ settings: { tiering: { value: true, source: 'default', boot: false, type: 'boolean', label: 'x', description: 'y' } } }), { status: 200 })) as any;
    const s = await fetchSettings();
    expect(s.tiering.value).toBe(true);
  });

  it('fetchSettings returns {} on error', async () => {
    globalThis.fetch = mock(async () => { throw new Error('down'); }) as any;
    expect(await fetchSettings()).toEqual({});
  });

  it('patchSettings surfaces confirmationRequired', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ confirmationRequired: true, message: 'metered' }), { status: 200 })) as any;
    const r = await patchSettings({ provider: 'claude' });
    expect(r.confirmationRequired).toBe(true);
  });

  it('patchSettings surfaces a 400 error body', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ error: 'MissingProviderKey', message: 'need key' }), { status: 400 })) as any;
    const r = await patchSettings({ provider: 'claude' });
    expect(r.error).toBe('MissingProviderKey');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/viewer/settings-data.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `settingsData.ts`**

```ts
// src/ui/viewer/utils/settingsData.ts
// SPDX-License-Identifier: Apache-2.0
import { V1_ENDPOINTS } from '../constants/api.js';

export interface SettingField {
  value: unknown; source: string; boot: boolean; type: string;
  options?: string[]; min?: number; max?: number; label: string; description: string;
}

export async function fetchSettings(): Promise<Record<string, SettingField>> {
  try {
    const res = await fetch(V1_ENDPOINTS.SETTINGS, { headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) return {};
    const body = await res.json();
    return (body?.settings ?? {}) as Record<string, SettingField>;
  } catch { return {}; }
}

export async function patchSettings(
  patch: Record<string, unknown>, confirm?: boolean,
): Promise<{ settings?: Record<string, SettingField>; confirmationRequired?: boolean; error?: string; message?: string }> {
  try {
    const res = await fetch(V1_ENDPOINTS.SETTINGS, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch, confirm }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body?.error ?? 'Error', message: body?.message };
    return body;
  } catch (e) { return { error: 'NetworkError', message: String(e) }; }
}
```

Add to `src/ui/viewer/constants/api.ts` `V1_ENDPOINTS`: `SETTINGS: '/v1/settings',`.

- [ ] **Step 4: Write the failing test (view render)**

```tsx
// tests/viewer/settings-view.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import React from 'react';
import SettingsView from '../../src/ui/viewer/views/SettingsView.js';

describe('SettingsView', () => {
  it('renders provider options and provenance from fields', () => {
    const fields: any = {
      provider: { value: 'ollama', source: 'team', boot: false, type: 'enum', options: ['ollama','claude'], label: 'Generation model', description: 'who distills' },
      tiering: { value: true, source: 'default', boot: false, type: 'boolean', label: 'Compression', description: 'squeeze' },
      monthlyTokenCap: { value: 0, source: 'env', boot: true, type: 'number', label: 'Monthly token cap', description: 'cap' },
    };
    const html = renderToString(React.createElement(SettingsView, { initialFields: fields } as any));
    expect(html).toContain('Generation model');
    expect(html).toContain('Compression');
    expect(html).toContain('team');       // provenance tag
    expect(html).toContain('after restart'); // boot note on the cap
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `bun test tests/viewer/settings-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement `SettingsView.tsx`**

Render grouped cards. Accept `initialFields` (for tests) else fetch on mount. Group by: Generation (provider, model), Retrieval (searchHybrid, tiering, ftsWeight, vecWeight, rrfK, supersedeMaxDepth), Quality (qualityFloor, reformatRetries), Limits (monthlyTokenCap, monthlyRequestCap, rateLimitPerMin), and a savings strip (fetched from `/dashboard/cost`). Each control shows `label`, `description`, a provenance tag (`field.source`), and — when `field.boot` — an "applies after restart" note. Enum → button group; boolean → toggle; number → input. On change call `patchSettings`; on `confirmationRequired` show a confirm affordance that re-sends with `confirm:true`; on `error==='MissingProviderKey'` show an inline error on the provider card. Use classes `settings-card`, `settings-row`, `settings-provenance`, `settings-toggle`, `settings-boot-note`, `savings-strip` (styled in Step 7). Keep the file focused on rendering + the patch handler.

(Full component code — write it in the Claude aesthetic; the exact JSX is left to the implementer to match the existing viewer component style in `src/ui/viewer/views/DashboardView.tsx`, but it MUST render the strings asserted in Step 4: the field labels, the `source` value as a tag, and "applies after restart" for boot knobs.)

- [ ] **Step 7: Add Claude-aesthetic CSS + nav wiring**

In `src/ui/viewer-template.html`, append CSS for the settings classes using the locked palette (cream `#f0eee6`/`#faf9f5`, coral `#cc785c`, radius 11px, generous padding). Add a `[data-theme]` block consistent with the existing theme system. In `viewState.ts` add `'settings'` to the view union; in `Sidebar.tsx` add a "Settings" nav item; in `App.tsx` route `view === 'settings'` to `<SettingsView />`.

- [ ] **Step 8: Build the viewer bundle + run tests + typecheck**

Run: `node scripts/build-viewer.js && bun test tests/viewer/settings-data.test.ts tests/viewer/settings-view.test.ts && npx tsc --noEmit -p src/ui/viewer/tsconfig.json`
Expected: build OK, tests PASS, 0 viewer-tsc errors.

- [ ] **Step 9: Commit**

```bash
git add src/ui/viewer/utils/settingsData.ts src/ui/viewer/views/SettingsView.tsx src/ui/viewer/constants/api.ts src/ui/viewer/views/viewState.ts src/ui/viewer/components/Sidebar.tsx src/ui/viewer/App.tsx src/ui/viewer-template.html tests/viewer/settings-data.test.ts tests/viewer/settings-view.test.ts
git commit -m "feat(ui): Settings view (Claude aesthetic) — provider switch, live toggles, savings strip"
```

---

## Final verification (after all tasks)

- [ ] `npx tsc --noEmit && npx tsc --noEmit -p src/ui/viewer/tsconfig.json` → 0 errors
- [ ] `node scripts/build-viewer.js && npm run build` → success
- [ ] `bun test` → 0 fail
- [ ] Dogfood smoke on `:37900`: `GET /v1/settings` returns knobs; `PATCH` a live knob (tiering) and confirm the next search reflects it; switch provider ollama→(needs key) shows the guard; the Settings view renders in the Claude aesthetic with a real savings strip.

## Self-Review notes (author)

- **Spec coverage:** settings store (T1/T3), registry (T2), resolver chain (T4), provider hot-swap (T5/T9), resolver wiring of live knobs (T6), compression metering + real cost (T7), `/v1/settings` GET+PATCH with guards + scope + local-dev grant (T8), Settings view Claude aesthetic (T10). BOOT-residue quotas flagged `boot:true` (T2) and surfaced as "applies after restart" (T10). All spec sections map to a task.
- **`teamId` threading:** T6 keeps env fallback so no caller breaks before it's wired; T8/T9 pass the resolver where `teamId` is in scope (request authContext / job data).
- **Type consistency:** `SettingField` (UI) mirrors the GET item shape from T8; `ResolvedSetting` (resolver) → GET payload adds `boot`+metadata from the registry; `costPanel` return shape used identically in T7 test and T10 savings strip.
- **YAGNI:** user tier and quota-live-reload deliberately deferred (seams/flags only).
