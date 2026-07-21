# Identity Core — Design

**Status:** Design (2026-07-20). Spec #1 of the team-mode phase (sequenced ahead of the Go Team wizard, Spec #2). The buildable, dogfoodable foundation the wizard's Sign-in/Invite steps will consume.

---

## Motivation

MemSmith's server auth today is **key → team/project scope**: a verified API key yields `authContext.{teamId, projectId, apiKeyId}`, and `authContext.userId` is **always null** — there is no concept of *which person* a request is. Access is by **key-possession only**; there is no per-identity membership, no roles, no way to offboard one person without rotating the shared key, and no attribution of *who* created an observation.

The identity core adds the **user/authorization layer** that team mode requires, behind a **pluggable authentication seam** so a deployment can choose its identity source (built-in self-hosted, or — later — an external IdP like Cognito/Google) without the rest of MemSmith knowing which. It owns **authorization** (teams, members, roles, access); it delegates **authentication** to a swappable provider.

This is the front edge that makes "a team" real: individual members under a team's base capability, granted/revoked per identity (the user's standing offboarding model), with attribution of who/what created each memory.

## Scope

**In:**
- The `IdentityProvider` seam (authn abstraction) + provider selection by config.
- Two adapters: **`local`** (solo, implicit owner, no login — preserves today's UX) and **`better-auth`** (self-hosted accounts/sessions, wrapping the already-wired better-auth `organization`+`apiKey` plugins).
- **Principal resolution + authz:** populate the dormant `authContext.userId` + a new `role`; map `team_members (team_id, user_id) → role`; a `requireRole` route guard over the standard 4-tier `owner/admin/member/viewer`.
- **API keys gain an owning `user_id`** (nullable column; back-compat preserved).
- **Membership management** routes (`/v1/members`): owner/admin add/remove members + assign roles; remove revokes the member's keys (per-identity offboarding).
- **Attribution stamp on write:** in team mode, stamp `metadata.createdByUserId` (the "who") + keep existing `platformSource` (the "what") onto each observation. Local mode stamps the implicit owner.
- Config: `MEMSMITH_IDENTITY_PROVIDER` setting (default `local`) + resolver getter.

**Out (explicitly, own specs):**
- **OIDC / Cognito / Google adapter** — the seam is shaped for it (a third adapter implementing `IdentityProvider`), but the OIDC redirect/JWKS flow is deferred.
- **The Go Team wizard UI + Convert data-move** (Spec #2) — consumes this core.
- **The "machine/where" attribution dimension** and the **dashboard attribution VIEWS** ("what's blocked, on whom?") — later.
- **Invite links / JIT domain provisioning** — this spec is invite-only (admin adds members explicitly).
- Billing, quotas, multi-org.

## Global Constraints

- **Authorization is MemSmith's; authentication is pluggable.** The seam resolves *who* (authn); MemSmith always decides *what they can do* (authz via `team_members`/role).
- **No local-mode regression.** Solo local mode stays zero-ceremony: implicit owner, no login, byte-identical UX. Existing local + local-dev-bypass tests must stay green.
- **Back-compat for existing keys.** The `api_keys.user_id` column is nullable; a null-owner (legacy) key behaves exactly as today (team/project scoped, treated as member-equivalent) — no forced migration, no lockout. Attribution for such rows reads "unknown user" until the key is re-issued.
- **Invite-only.** Authenticating gets a Principal, NOT team access. A user with no `team_members` row is denied on scoped routes — never auto-joined.
- **Fail-safe = deny, never crash.** Any provider error / unresolved identity → 401/403 with a logged SYSTEM warning; the server never crashes on an auth path.
- **Local-dev bypass unchanged and loopback-only.** The `local` adapter is only active under the existing loopback + `MEMSMITH_AUTH_MODE=local-dev` + `MEMSMITH_ALLOW_LOCAL_DEV_BYPASS=1` conditions; never in a production/Docker request.
- **Reuse, don't rebuild.** Use the existing `better-auth` (`auth.ts`), `team_members` upsert/get (`teams.ts`), `api_keys`/`createApiKey`, and `observations.create({metadata})`. Add columns/routes; don't reinvent minting/hashing/membership storage.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. **Never commit to main;** work on a branch. Nothing pushed.

---

## Architecture

```
request  (API key  OR  human session cookie)
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  authenticatePostgresRequest  (postgres-auth.ts — extended)  │
│    1. existing: verify API key → teamId, projectId, apiKeyId │
│       (+ NEW: key row's owning user_id)                       │
│    2. OR: IdentityProvider.authenticate(req) → userId         │
│           (adapter: local | better-auth)                      │
│    3. resolve role: team_members(teamId, userId) → role       │
│    4. populate AuthContext { userId, teamId, projectId,       │
│                              role, apiKeyId, mode }            │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
  requireRole(minRole)  route guard   →  allow / 403
      │
      ▼
  handler  →  (on write) stamp metadata.createdByUserId + platformSource
```

`Principal` is the normalized identity carried on `AuthContext`. Both credential types (agent API key, human session) converge to it; authz and attribution are written once against it.

## Components

### 1. `IdentityProvider` seam — new (`src/server/identity/identity-provider.ts`)
```ts
export type ProviderId = 'local' | 'better-auth'; // 'oidc' later
export interface AuthnResult { userId: string; email?: string; displayName?: string }
export interface IdentityProvider {
  readonly id: ProviderId;
  // Authn ONLY: resolve who this request is, or null if it can't. Never decides access.
  authenticate(req: Request): Promise<AuthnResult | null>;
}
// Selected by config; factory resolveIdentityProvider(env) → IdentityProvider (default 'local').
```
Mirrors the `resolveKeyForTeam` seam idiom. `Principal` (the resolved identity + authz) is represented on the existing `AuthContext` (which already has `userId`, `organizationId`, `teamId`, `projectId`, `apiKeyId`, `mode`) plus a new `role` field.

### 2. `local` adapter — new (`src/server/identity/providers/local-provider.ts`)
- `authenticate` returns a stable implicit owner: `{ userId: 'local-owner' }`. Only reached under the existing loopback + local-dev bypass gate. No login, no membership surface. Preserves today's solo UX exactly.

### 3. `better-auth` adapter — new (`src/server/identity/providers/better-auth-provider.ts`)
- Wraps the already-configured better-auth instance (`src/server/auth/auth.ts`, `organization` + `apiKey` plugins). `authenticate` validates the better-auth session (cookie) → real `userId`/email. Powers dashboard login + accounts, self-hosted, no external service.

### 4. Principal resolution + authz — modify (`src/server/middleware/postgres-auth.ts`)
- Add `role: PostgresTeamRole | null` to `AuthContext`.
- After key-verify (or a provider session), resolve `userId`, then `team_members(teamId, userId) → role` (reuse the existing get-member query in `teams.ts`). Populate `authContext.userId` + `authContext.role`.
- New `requireRole(min: PostgresTeamRole)` middleware; ordering `viewer < member < admin < owner`. Apply: writes ≥ `member`; `/v1/members` mgmt ≥ `admin`; team-config/delete = `owner`.
- Invite-only: authenticated but no member row → `role = null` → scoped routes 403.
- Local-dev bypass branch: resolves the implicit owner (role `owner`), unchanged behavior otherwise.

### 5. `api_keys.user_id` — migration + read (`src/storage/postgres/auth.ts` + schema/migration)
- Add nullable `user_id TEXT` to `api_keys`; `createApiKey` accepts an optional owning user; key verify returns it. Null → legacy behavior (back-compat).

### 6. Membership management — new routes (`/v1/members`) + reuse `teams.ts`
- `GET /v1/members` (≥member: list), `POST /v1/members` (≥admin: add existing user w/ role), `DELETE /v1/members/:userId` (≥admin: remove + revoke their keys), `PATCH /v1/members/:userId` (≥admin: change role, not above self). Reuse the `team_members` `INSERT…ON CONFLICT` upsert + a delete + key-revoke.

### 7. Attribution stamp — modify observation-write path
- In team mode, set `metadata.createdByUserId = authContext.userId` and preserve `platformSource` on `observations.create({ metadata })`. Local mode stamps `'local-owner'`. No new column (uses existing `metadata: JsonObject`). No machine dimension, no views.

### 8. Config — `MEMSMITH_IDENTITY_PROVIDER` in the settings registry (default `local`) + `SettingsResolver` getter.

## Data Flow

- **Solo local:** bypass → `local` adapter → owner Principal → full access → writes stamped `local-owner`. (Unchanged UX.)
- **Agent/CLI (team):** Bearer key → verify (returns owning `user_id`) → role → `requireRole` → write stamped with the key's user.
- **Human (team):** session cookie → `better-auth` adapter → userId → role → member-mgmt routes gated by `requireRole`.

## Error Handling & Failure Modes

| Situation | Behavior |
|---|---|
| Provider returns null (can't resolve) | 401, no Principal |
| Authenticated, no member row (invite-only) | 403 on scoped routes; never auto-join |
| Insufficient role | 403 via `requireRole` |
| Legacy key (null `user_id`) | Today's behavior: team/project scope, `userId=null`, member-equiv — no lockout |
| Provider misconfigured/unreachable | SYSTEM warn + deny; never crash |
| Local mode | Bypass path unchanged; implicit owner |

**Invariant:** an auth failure denies (401/403); it never crashes the server and never silently grants access.

## Testing

1. **Seam:** provider selection by config; unknown → default `local`; `local` → implicit owner; `better-auth` → user from session.
2. **Authz:** key→Principal with owning user + role; `requireRole` correctly allows/denies each tier (viewer no-write, member no-manage, admin no-delete-team, owner all).
3. **Invite-only:** authenticated non-member → 403, no auto-join; after add → access with assigned role.
4. **Membership:** add/remove/role-change via `/v1/members`; remove revokes the member's keys.
5. **Attribution:** team-mode write stamps `createdByUserId` + `platformSource`; local write stamps `local-owner`.
6. **Back-compat (critical):** legacy null-owner key reads/writes exactly as today; solo-local UX byte-identical (existing local + local-dev-bypass tests stay green).
7. **Live acceptance:** dogfood on the local runtime (no regression) + a team-shaped test (two keys, two users, one team) proving per-user attribution, role gating, and offboarding (remove member → their key denied).

## Acceptance Criteria

1. An `IdentityProvider` seam exists; provider chosen by `MEMSMITH_IDENTITY_PROVIDER` (default `local`); `local` + `better-auth` adapters implemented.
2. `authContext.userId` + `role` are populated from the resolved identity + `team_members`; `requireRole` gates routes across the 4 tiers.
3. API keys carry an optional owning `user_id`; legacy null-owner keys behave exactly as today (verified by test).
4. `/v1/members` lets owner/admin add/remove/re-role members; removal revokes their keys.
5. Invite-only enforced: authenticating never grants team access without a member row.
6. Team-mode observation writes are stamped with `createdByUserId` + `platformSource`; local writes stamp the implicit owner.
7. No local-mode regression (existing tests green); fail-safe deny on all error paths.
8. `src` typecheck clean; touched/added test files green; nothing pushed; work on a branch.

## Deferred (own specs)
- OIDC/Cognito/Google adapter (the seam's third implementation).
- Go Team wizard UI + Convert data-move (Spec #2, consumes this core).
- Machine/"where" attribution + attribution dashboard views ("blocked on whom").
- Invite links / JIT domain provisioning; billing/quotas/multi-org.
