# Identity Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MemSmith's user/authorization layer — a pluggable `IdentityProvider` seam (local + better-auth adapters), Principal resolution filling `authContext.userId`+`role`, `team_members` role gating, per-key owning user, `/v1/members` management, and who/what attribution stamping — without regressing local mode.

**Architecture:** A request (API key OR human session) resolves through the seam to a Principal on the existing `AuthContext`; `team_members(teamId,userId)→role` drives a `requireRole` route guard; writes stamp `metadata.createdByUserId`. Reuses better-auth (`auth.ts`), `PostgresTeamsRepository`, `api_keys`/`createApiKey`, and `observations.create({metadata})`.

**Tech Stack:** TypeScript, Bun test runner, Express (server routes), Postgres (embedded local + remote), the already-wired better-auth (`organization`+`apiKey` plugins).

## Global Constraints

- Authorization is MemSmith's; authentication is pluggable (the seam resolves *who*; MemSmith decides *what they can do* via team_members/role).
- **No local-mode regression:** solo local stays zero-ceremony (implicit owner, no login). Existing local + local-dev-bypass tests MUST stay green.
- **Back-compat for existing keys:** `api_keys.user_id` is NULLABLE; a null-owner (legacy) key behaves exactly as today (team/project scoped, member-equivalent) — no forced migration, no lockout.
- **Invite-only:** authenticating yields a Principal, NOT team access; no `team_members` row → denied on scoped routes; never auto-join.
- **Fail-safe = deny, never crash:** any provider error / unresolved identity → 401/403 + SYSTEM warn; never crash an auth path.
- **Local-dev bypass unchanged, loopback-only:** the `local` adapter only activates under the existing loopback + `MEMSMITH_AUTH_MODE=local-dev` + `MEMSMITH_ALLOW_LOCAL_DEV_BYPASS=1` gate; never prod/Docker.
- **Reuse, don't rebuild:** better-auth, `PostgresTeamsRepository`, `api_keys`/`createApiKey`, `observations.create({metadata})`.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Never commit to main. Branch `identity-core` (already created). Nothing pushed.
- Verify with `npx tsc --noEmit` (exit 0; root tsconfig excludes tests/). Editor bun:test/.js diagnostics are noise. Single test file: `~/.bun/bin/bun test <path>`.

**Grounding facts (verified against current main):**
- `AuthContext` (`src/server/middleware/postgres-auth.ts`) already has: `userId, organizationId, teamId, projectId, scopes, apiKeyId, mode` — `userId` is currently always null. This plan adds `role` and populates `userId`.
- `PostgresTeamRole = 'owner'|'admin'|'member'|'viewer'` (`src/storage/postgres/teams.ts`).
- `team_members` upsert idiom already exists: `INSERT INTO team_members (team_id,user_id,role,metadata) … ON CONFLICT (team_id,user_id) DO UPDATE SET role=excluded.role …`.
- `api_keys` columns today: `id, key_hash, team_id, project_id, actor_id, scopes, expires_at` — NO `user_id`.
- Migrations live in `applyPhase1Migration` (`src/storage/postgres/schema.ts`) using `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (idempotent).
- Routes register in `ServerV1PostgresRoutes.setupRoutes(app)` with `readAuth`/`writeAuth` guard arrays; pattern `app.post('/v1/…', writeAuth, this.handle…)`.
- `observations.create` takes `{ …, metadata: JsonObject, … }`.
- better-auth configured in `src/server/auth/auth.ts` (`apiKey()` + `organization()` plugins), served via `BetterAuthRoutes` catch-all `/api/auth/*`.

---

### Task 1: IdentityProvider seam interface + factory

**Files:**
- Create: `src/server/identity/identity-provider.ts`
- Test: `tests/server/identity/identity-provider.test.ts`

**Interfaces:**
- Produces: `type ProviderId`, `interface AuthnResult`, `interface IdentityProvider`, `resolveIdentityProviderId(env): ProviderId`.

- [ ] **Step 1: Write the failing test**
```ts
// tests/server/identity/identity-provider.test.ts
import { describe, it, expect } from 'bun:test';
import { resolveIdentityProviderId } from '../../../src/server/identity/identity-provider';

describe('resolveIdentityProviderId', () => {
  it("defaults to 'local' when unset", () => {
    expect(resolveIdentityProviderId({})).toBe('local');
  });
  it("returns 'better-auth' when configured", () => {
    expect(resolveIdentityProviderId({ MEMSMITH_IDENTITY_PROVIDER: 'better-auth' })).toBe('better-auth');
  });
  it("falls back to 'local' on unknown value", () => {
    expect(resolveIdentityProviderId({ MEMSMITH_IDENTITY_PROVIDER: 'mystery' })).toBe('local');
  });
});
```

- [ ] **Step 2: Run test → FAIL** (`~/.bun/bin/bun test tests/server/identity/identity-provider.test.ts`) — module missing.

- [ ] **Step 3: Implement**
```ts
// src/server/identity/identity-provider.ts
// SPDX-License-Identifier: Apache-2.0
import type { Request } from 'express';

export type ProviderId = 'local' | 'better-auth'; // 'oidc' added by a later spec

export interface AuthnResult {
  userId: string;
  email?: string;
  displayName?: string;
}

// Authn ONLY: resolve who this request is, or null. NEVER decides access.
export interface IdentityProvider {
  readonly id: ProviderId;
  authenticate(req: Request): Promise<AuthnResult | null>;
}

const KNOWN: ProviderId[] = ['local', 'better-auth'];

export function resolveIdentityProviderId(env: NodeJS.ProcessEnv | Record<string, string | undefined>): ProviderId {
  const v = (env.MEMSMITH_IDENTITY_PROVIDER ?? '').trim();
  return (KNOWN as string[]).includes(v) ? (v as ProviderId) : 'local';
}
```

- [ ] **Step 4: Run test → PASS.**
- [ ] **Step 5: `npx tsc --noEmit` → exit 0.**
- [ ] **Step 6: Commit**
```bash
git add src/server/identity/identity-provider.ts tests/server/identity/identity-provider.test.ts
git commit -m "feat(identity): IdentityProvider seam interface + provider-id resolver

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `local` adapter (implicit owner)

**Files:**
- Create: `src/server/identity/providers/local-provider.ts`
- Test: `tests/server/identity/local-provider.test.ts`

**Interfaces:**
- Consumes: `IdentityProvider`, `AuthnResult` (Task 1).
- Produces: `LOCAL_OWNER_USER_ID = 'local-owner'` (const), `localProvider: IdentityProvider`.

- [ ] **Step 1: Write the failing test**
```ts
// tests/server/identity/local-provider.test.ts
import { describe, it, expect } from 'bun:test';
import { localProvider, LOCAL_OWNER_USER_ID } from '../../../src/server/identity/providers/local-provider';

describe('localProvider', () => {
  it("id is 'local'", () => { expect(localProvider.id).toBe('local'); });
  it('resolves the stable implicit owner', async () => {
    const r = await localProvider.authenticate({} as any);
    expect(r).toEqual({ userId: LOCAL_OWNER_USER_ID });
  });
  it('exports a stable owner id', () => { expect(LOCAL_OWNER_USER_ID).toBe('local-owner'); });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
```ts
// src/server/identity/providers/local-provider.ts
// SPDX-License-Identifier: Apache-2.0
import type { IdentityProvider, AuthnResult } from '../identity-provider.js';

export const LOCAL_OWNER_USER_ID = 'local-owner';

// Solo local mode: one implicit owner, no login. Only reached under the existing
// loopback + local-dev bypass gate (enforced by the middleware, not here).
export const localProvider: IdentityProvider = {
  id: 'local',
  async authenticate(): Promise<AuthnResult | null> {
    return { userId: LOCAL_OWNER_USER_ID };
  },
};
```

- [ ] **Step 4: Run → PASS. Step 5: tsc 0. Step 6: Commit**
```bash
git add src/server/identity/providers/local-provider.ts tests/server/identity/local-provider.test.ts
git commit -m "feat(identity): local adapter (implicit owner, no login)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `api_keys.user_id` column (nullable, back-compat)

**Files:**
- Modify: `src/storage/postgres/schema.ts` (add `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id TEXT` in `applyPhase1Migration`, alongside the existing `ADD COLUMN IF NOT EXISTS` statements)
- Modify: `src/storage/postgres/auth.ts` (`PostgresApiKey` interface + row mapping gain `userId: string | null`; `createApiKey` accepts optional `userId`; the `SELECT * … WHERE key_hash` verify maps it)
- Test: `tests/storage/postgres/api-key-user-id.test.ts` (pg-gated, like sibling pg tests)

**Interfaces:**
- Produces: `PostgresApiKey.userId: string | null`; `createApiKey(input: { …, userId?: string | null })`; verify result carries `userId`.

- [ ] **Step 1: Write the failing test** (pg-gated — skips without `MEMSMITH_TEST_POSTGRES_URL`)
```ts
// tests/storage/postgres/api-key-user-id.test.ts
import { describe, it, expect } from 'bun:test';
const PG = process.env.MEMSMITH_TEST_POSTGRES_URL;
describe.if(!!PG)('api_keys.user_id', () => {
  it('createApiKey persists userId and verify returns it; null default for legacy', async () => {
    // Arrange a client against PG, run bootstrapServerPostgresSchema, then:
    //  - createApiKey({... userId:'u1'}) → verify(rawKey) → result.userId === 'u1'
    //  - createApiKey({...}) (no userId) → verify → result.userId === null
    // (Use the same client/isolated-schema pattern as tests/storage/postgres/observation-idempotency.test.ts)
    expect(true).toBe(true); // replace with the real assertions per the pattern in that sibling test
  });
});
```
> The implementer MUST replace the placeholder body with real assertions following the exact client/isolated-schema setup in `tests/storage/postgres/observation-idempotency.test.ts` (bootstrap schema, create key, verify). The two assertions to prove: userId round-trips; absent userId → null.

- [ ] **Step 2: Run with PG → FAIL** (`MEMSMITH_TEST_POSTGRES_URL=postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres ~/.bun/bin/bun test tests/storage/postgres/api-key-user-id.test.ts`) — column missing / userId undefined.

- [ ] **Step 3: Implement**
- In `schema.ts` `applyPhase1Migration`, add near the other `ALTER TABLE … ADD COLUMN IF NOT EXISTS`:
  ```ts
  await client.query(`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id TEXT`);
  ```
- In `auth.ts`: add `user_id: string | null` to `ApiKeyRow`, `userId: string | null` to `PostgresApiKey`, map it in row→object; add `userId?: string | null` to `createApiKey`'s input and include it in the INSERT column list + values (`INSERT INTO api_keys (id, key_hash, team_id, project_id, actor_id, scopes, expires_at, user_id) …`); the verify SELECT already does `SELECT *` so it returns `user_id` — just map it.

- [ ] **Step 4: Run with PG → PASS. Step 5: tsc 0. Step 6: Commit**
```bash
git add src/storage/postgres/schema.ts src/storage/postgres/auth.ts tests/storage/postgres/api-key-user-id.test.ts
git commit -m "feat(identity): api_keys.user_id (nullable, back-compat) + create/verify wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Principal resolution + `role` on AuthContext + requireRole

**Files:**
- Modify: `src/server/middleware/postgres-auth.ts` (add `role` to `AuthContext`; populate `userId`+`role`; add `requireRole`)
- Modify: `src/storage/postgres/teams.ts` (ensure a `getMemberRole(teamId, userId): Promise<PostgresTeamRole | null>` exists on `PostgresTeamsRepository` — the get-member query already exists; expose a role-only helper if not present)
- Test: `tests/server/identity/require-role.test.ts` (unit — pure role-ordering + guard logic with a fake req)

**Interfaces:**
- Consumes: `PostgresTeamRole`, the key-verify result's `userId` (Task 3), the local adapter (Task 2).
- Produces: `AuthContext.role: PostgresTeamRole | null`; `requireRole(min: PostgresTeamRole): RequestHandler`; `ROLE_ORDER` mapping.

- [ ] **Step 1: Write the failing test**
```ts
// tests/server/identity/require-role.test.ts
import { describe, it, expect } from 'bun:test';
import { requireRole, roleSatisfies } from '../../../src/server/middleware/postgres-auth';

describe('role ordering', () => {
  it('viewer<member<admin<owner', () => {
    expect(roleSatisfies('owner', 'member')).toBe(true);
    expect(roleSatisfies('member', 'member')).toBe(true);
    expect(roleSatisfies('viewer', 'member')).toBe(false);
    expect(roleSatisfies('admin', 'owner')).toBe(false);
    expect(roleSatisfies(null, 'viewer')).toBe(false); // no membership → denied
  });
});
describe('requireRole middleware', () => {
  function run(role: any) {
    let status = 0; const res: any = { status: (c: number) => { status = c; return res; }, json: () => res };
    let nexted = false;
    requireRole('member')({ authContext: { role } } as any, res, () => { nexted = true; });
    return { status, nexted };
  }
  it('allows when role satisfies', () => { expect(run('admin').nexted).toBe(true); });
  it('403s when insufficient', () => { const r = run('viewer'); expect(r.nexted).toBe(false); expect(r.status).toBe(403); });
  it('403s when no membership (null)', () => { expect(run(null).status).toBe(403); });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**
- Add to `AuthContext`: `role: PostgresTeamRole | null;`
- Add:
  ```ts
  const ROLE_ORDER: Record<PostgresTeamRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
  export function roleSatisfies(role: PostgresTeamRole | null, min: PostgresTeamRole): boolean {
    return role != null && ROLE_ORDER[role] >= ROLE_ORDER[min];
  }
  export function requireRole(min: PostgresTeamRole): RequestHandler {
    return (req, res, next) => {
      if (roleSatisfies(req.authContext?.role ?? null, min)) return next();
      res.status(403).json({ error: 'Forbidden', message: `requires role ${min}` });
    };
  }
  ```
- In `authenticatePostgresRequest`: after the key path, set `userId = verified.userId` and resolve `role = await teamsRepo.getMemberRole(teamId, userId)` (null if no membership or no userId). In the local-dev bypass branch, set `userId = LOCAL_OWNER_USER_ID`, `role = 'owner'`. Populate both on the `AuthContext`. Wrap role resolution so a DB error → `role = null` (fail-safe deny), never throw.
- In `teams.ts`: add `getMemberRole(teamId, userId): Promise<PostgresTeamRole | null>` reusing the existing member SELECT (return `row?.role ?? null`).

- [ ] **Step 4: Run → PASS. Step 5: tsc 0. Step 6: Commit**
```bash
git add src/server/middleware/postgres-auth.ts src/storage/postgres/teams.ts tests/server/identity/require-role.test.ts
git commit -m "feat(identity): Principal role on AuthContext + requireRole guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `better-auth` adapter

**Files:**
- Create: `src/server/identity/providers/better-auth-provider.ts`
- Test: `tests/server/identity/better-auth-provider.test.ts`

**Interfaces:**
- Consumes: `IdentityProvider`, `AuthnResult`; the better-auth instance from `src/server/auth/auth.ts`.
- Produces: `betterAuthProvider: IdentityProvider` — `authenticate(req)` validates the better-auth session and returns `{ userId, email?, displayName? }` or null.

- [ ] **Step 1: Write the failing test** (inject a fake session-validator to avoid a live better-auth)
```ts
// tests/server/identity/better-auth-provider.test.ts
import { describe, it, expect } from 'bun:test';
import { makeBetterAuthProvider } from '../../../src/server/identity/providers/better-auth-provider';

describe('betterAuthProvider', () => {
  it('returns the user when the session validates', async () => {
    const p = makeBetterAuthProvider({ getSession: async () => ({ user: { id: 'u1', email: 'dana@x.com', name: 'Dana' } }) } as any);
    expect(await p.authenticate({ headers: {} } as any)).toEqual({ userId: 'u1', email: 'dana@x.com', displayName: 'Dana' });
  });
  it('returns null when there is no session', async () => {
    const p = makeBetterAuthProvider({ getSession: async () => null } as any);
    expect(await p.authenticate({ headers: {} } as any)).toBeNull();
  });
  it('returns null (never throws) when the validator throws', async () => {
    const p = makeBetterAuthProvider({ getSession: async () => { throw new Error('boom'); } } as any);
    expect(await p.authenticate({ headers: {} } as any)).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — `makeBetterAuthProvider(auth)` returns an `IdentityProvider` whose `authenticate` calls `auth.getSession({ headers })` (the real better-auth API — the implementer confirms the exact call from `auth.ts`/better-auth docs), maps `session.user → AuthnResult`, and wraps in try/catch → null. Export a default `betterAuthProvider` bound to the real instance.
> The implementer MUST confirm the exact better-auth session-read call from `src/server/auth/auth.ts` and the better-auth `apiKey`/`organization` API; the injected `getSession` seam keeps the unit test independent of that.

- [ ] **Step 4: Run → PASS. Step 5: tsc 0. Step 6: Commit**
```bash
git add src/server/identity/providers/better-auth-provider.ts tests/server/identity/better-auth-provider.test.ts
git commit -m "feat(identity): better-auth adapter (session → Principal, never throws)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `/v1/members` management routes

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (register `/v1/members` routes in `setupRoutes`, guarded by `requireRole`)
- Modify: `src/storage/postgres/teams.ts` (`listMembers`, `removeMember`, `setMemberRole` on `PostgresTeamsRepository`; reuse the existing upsert for add/role)
- Modify: revoke-keys-on-remove — reuse the existing key-revoke path (`PostgresAuthRepository` — the `DELETE`/revoke used by `/v1/keys`)
- Test: `tests/server/members-routes.test.ts` (pg-gated integration, mirroring the dashboard-routes test pattern)

**Interfaces:**
- Consumes: `requireRole` (Task 4), `PostgresTeamsRepository`, the key-revoke path.
- Produces: `GET /v1/members` (≥member), `POST /v1/members {userId, role}` (≥admin), `PATCH /v1/members/:userId {role}` (≥admin), `DELETE /v1/members/:userId` (≥admin, also revokes that user's keys).

- [ ] **Step 1: Write the failing test** — pg-gated; boot the routes like the dashboard-routes test; seed a team + owner; assert: owner can add a member (row appears with role); a `viewer`-scoped caller gets 403 on POST; DELETE removes the row AND revokes that user's keys (a subsequent verify of their key fails). Follow the exact harness in `tests/server/local-dev-team-scope.test.ts` / the dashboard routes test.
> Implementer writes the real assertions per that harness; the four behaviors above are the contract.

- [ ] **Step 2: Run with PG → FAIL.**
- [ ] **Step 3: Implement** — add the four routes in `setupRoutes` using `readAuth`+`requireRole('member')` for GET and `writeAuth`+`requireRole('admin')` for POST/PATCH/DELETE; scope every query to `req.authContext.teamId`; forbid setting a role above the caller's own and forbid removing the last owner. Add `listMembers`/`removeMember`/`setMemberRole` to `PostgresTeamsRepository` (reuse the upsert for add + role-change). On DELETE, call the existing key-revoke for that user's keys (`WHERE team_id=$team AND user_id=$user`).

- [ ] **Step 4: Run with PG → PASS. Step 5: tsc 0. Step 6: Commit**
```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts src/storage/postgres/teams.ts tests/server/members-routes.test.ts
git commit -m "feat(identity): /v1/members management (add/remove/role, revoke-on-remove)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Attribution stamp on write

**Files:**
- Modify: the observation-write handler(s) in `ServerV1PostgresRoutes.ts` (`/v1/memories` + the record-intent write closure) to stamp `metadata.createdByUserId` from `req.authContext.userId`
- Test: `tests/server/attribution-stamp.test.ts`

**Interfaces:**
- Consumes: `req.authContext.userId` (Task 4).
- Produces: observations written in team/local mode carry `metadata.createdByUserId`; existing `platformSource` handling unchanged.

- [ ] **Step 1: Write the failing test** — call the write path (pure helper or handler) with an `authContext.userId='u1'` and assert the `createInput.metadata.createdByUserId === 'u1'`; with `userId=null` (legacy key), assert `createdByUserId` is omitted (or null) and the write still succeeds. If a pure metadata-merge helper is cleanest, add `stampAttribution(metadata, authContext)` and unit-test it directly.
```ts
// tests/server/attribution-stamp.test.ts
import { describe, it, expect } from 'bun:test';
import { stampAttribution } from '../../src/server/routes/v1/attribution';

describe('stampAttribution', () => {
  it('adds createdByUserId when a user is present', () => {
    expect(stampAttribution({ a: 1 }, { userId: 'u1' } as any)).toEqual({ a: 1, createdByUserId: 'u1' });
  });
  it('leaves metadata unchanged when userId is null (legacy key)', () => {
    expect(stampAttribution({ a: 1 }, { userId: null } as any)).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — create `src/server/routes/v1/attribution.ts` with `stampAttribution(metadata, authContext)` (returns metadata + `createdByUserId` when `authContext.userId` is a non-empty string; unchanged otherwise). Call it in the `/v1/memories` and `/v1/record-intent` write paths before `repo.create`, merging into the metadata already assembled. `platformSource` stays as-is.

- [ ] **Step 4: Run → PASS. Step 5: tsc 0. Step 6: Commit**
```bash
git add src/server/routes/v1/attribution.ts src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/attribution-stamp.test.ts
git commit -m "feat(identity): stamp createdByUserId attribution on write

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Wire the provider into the middleware + config

**Files:**
- Modify: `src/server/middleware/postgres-auth.ts` (use the configured provider for the non-key/session path)
- Modify: `src/server/settings/settingKeys.ts` (register `MEMSMITH_IDENTITY_PROVIDER`, default `local`, enum `local|better-auth`) + `SettingsResolver` getter + `SettingsDefaultsManager` default
- Modify: the provider factory `resolveIdentityProvider(env)` (returns local/better-auth instance) — add to `identity-provider.ts` or a small `provider-factory.ts`
- Test: `tests/server/identity/provider-factory.test.ts`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: `resolveIdentityProvider(env): IdentityProvider`; the middleware resolves a human session via the configured provider when there's no API key; `MEMSMITH_IDENTITY_PROVIDER` setting present in the registry.

- [ ] **Step 1: Write the failing test** — `resolveIdentityProvider({})` → `localProvider`; `resolveIdentityProvider({MEMSMITH_IDENTITY_PROVIDER:'better-auth'})` → the better-auth provider (id `'better-auth'`); unknown → local.

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — factory maps id→instance (Task 2/5 providers). In the middleware: if no Bearer key present AND not the local-dev bypass, call `provider.authenticate(req)`; on a resolved user, resolve role and populate AuthContext; null → 401. Register the setting (enum, default `local`) matching the adjacent enum-setting shape; add the resolver getter + defaults entry.

- [ ] **Step 4: Run → PASS. Step 5: tsc 0. Step 6: Commit**
```bash
git add src/server/identity/ src/server/middleware/postgres-auth.ts src/server/settings/settingKeys.ts src/server/settings/SettingsResolver.ts src/shared/SettingsDefaultsManager.ts tests/server/identity/provider-factory.test.ts
git commit -m "feat(identity): provider factory + middleware wiring + MEMSMITH_IDENTITY_PROVIDER setting

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Build + live acceptance

**Files:** none (verification).

- [ ] **Step 1: Build + sync** — `npm run build-and-sync` → `Sync complete!`.
- [ ] **Step 2: Full touched-feature tests** (with PG for the gated ones):
  `MEMSMITH_TEST_POSTGRES_URL=postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres ~/.bun/bin/bun test tests/server/identity/ tests/storage/postgres/api-key-user-id.test.ts tests/server/members-routes.test.ts tests/server/attribution-stamp.test.ts` → all pass.
- [ ] **Step 3: tsc** — `npx tsc --noEmit` → 0.
- [ ] **Step 4: No-regression (critical)** — run the existing local + local-dev-bypass suites (`tests/server/local-dev-team-scope.test.ts` + the record-intent/dashboard tests) → still green; boot the local runtime and confirm solo capture/recall works unchanged (implicit owner).
- [ ] **Step 5: Team-shaped live acceptance** — against the local PG: create a team + two users + two keys (one member, one viewer); prove (a) member key can write + its observations carry `createdByUserId`; (b) viewer key gets 403 on write; (c) owner adds/removes a member via `/v1/members` and removal revokes that user's key (subsequent call 401); (d) a legacy null-owner key still reads/writes as today. Record the outcome to MemSmith memory via note_add; clean throwaway rows.

---

## Self-Review

**1. Spec coverage:**
- IdentityProvider seam + provider selection → Task 1, 8. ✅
- local adapter → Task 2. ✅
- better-auth adapter → Task 5. ✅
- Principal resolution + role + requireRole → Task 4. ✅
- api_keys owning user_id (back-compat) → Task 3. ✅
- /v1/members management + revoke-on-remove → Task 6. ✅
- Attribution stamp (who + platformSource) → Task 7. ✅
- Config MEMSMITH_IDENTITY_PROVIDER → Task 8. ✅
- Invite-only (null role → 403) → Task 4 (requireRole) + Task 6. ✅
- No local regression / back-compat / fail-safe → Global Constraints + Task 9 Steps 4–5. ✅
- Live acceptance (dogfood + team-shaped) → Task 9. ✅
- OIDC / wizard / attribution views → deferred, not planned. ✅

**2. Placeholder scan:** Code steps carry real code. Three tasks (3, 6, and Task-9 acceptance) intentionally instruct the implementer to write pg-gated integration assertions *following a named existing harness* rather than inlining full DB fixtures — because those fixtures are large and the canonical pattern lives in a cited sibling test; the contract (exact behaviors to assert) is spelled out. This is a deliberate, bounded instruction, not a vague placeholder.

**3. Type consistency:** `AuthnResult{userId,email?,displayName?}`, `IdentityProvider{id,authenticate}`, `ProviderId`, `AuthContext.role: PostgresTeamRole|null`, `roleSatisfies/requireRole`, `PostgresApiKey.userId`, `createApiKey({userId?})`, `stampAttribution(metadata,authContext)`, `resolveIdentityProvider(env)` — used consistently across tasks. `LOCAL_OWNER_USER_ID='local-owner'` shared by Task 2 + Task 4's bypass branch. ✅
