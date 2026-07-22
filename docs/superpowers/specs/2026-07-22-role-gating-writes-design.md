# Role-Gating on Observation Write/Delete Routes (C4 fix) — Design

**Status:** Design (2026-07-22). A security fix for a defect found during live team-mode validation (mem `35981b8f`): observation write/delete routes enforce API-key **scope** but not the membership **role tier**, so a `viewer` holding a write-scoped key can write and delete team memory.

---

## Motivation

Identity Core (Spec #1) introduced the 4-tier role model (`owner > admin > member > viewer`) and the `requireRole` route guard, and applied it to the membership-management routes (`/v1/members`). But the **observation-mutating routes** were left on scope-only auth (`writeAuth`, which checks a verified API key + the `memories:write` scope). Scope and role are **two independent axes**: a key can hold the `memories:write` scope while its owning member is a `viewer`. Live validation confirmed the hole — a viewer's write-scoped key successfully created and could delete observations.

**The bug, precisely:** `POST /v1/memories` (and the other content-mutating routes) run `writeAuth` only. `writeAuth` never consults `authContext.role`. So role is unenforced on the write path. A `viewer` is supposed to be read-only; today it is not.

## Scope

**In:**
- A new guard `requireWriteRole` in `postgres-auth.ts` that enforces a `≥ member` role floor **with a back-compat rule for null-role (legacy/scope-only) keys**.
- Applying `requireWriteRole` to the 8 content-mutating routes currently on `writeAuth`-only.
- Tests: unit for the guard, a regression reproducing the exact C4 scenario, and a live re-validation.

**Out (explicitly, deferred to their own specs):**
- **Ownership-based deletion** ("a member may delete only content they created", via `metadata.createdByUserId` match). A separate authorization axis; deferred.
- **The legacy-owner backfill** (binding existing `createdByUserId: null` rows to the owner identity). Recorded as the enabling groundwork for the future ownership-delete spec — because the user is currently the sole owner, all null-owner rows are safely attributable to them, which removes the "legacy data has no owner" problem *for that future feature*. Not part of this fix.
- Role gating on non-content routes (read routes, `/v1/keys`, jobs) — out of scope; this fix targets only the write/delete content paths that were missed.
- Any change to `requireRole` itself or to `/v1/members` (already correct).

## Global Constraints

- **Fix the security hole; break no legacy key.** An explicit `viewer` must be denied writes/deletes. A **legacy/scope-only key** (whose resolved `role` is `null` because it has no `user_id`, or its user has no `team_members` row) must keep working **exactly as today** — no lockout.
- **Scope != role.** This fix adds the role axis on top of the existing scope check; it does not remove or weaken scope enforcement. A route now requires BOTH a write scope (via `writeAuth`) AND a satisfying role (via `requireWriteRole`).
- **Fail-safe = deny.** Absent `authContext` (guard misordered or auth failed) → deny, never allow. Never throw out of the middleware.
- **Null-role rule (the crux):** on the write/delete gate, `null` role is treated as **member-equivalent** (allowed). Denial happens ONLY for an explicit role strictly below `member` (i.e. `viewer`). Formally: `allow = (role == null) || roleSatisfies(role, 'member')`.
- **Reuse, don't rebuild.** Build on the existing `roleSatisfies` / `AuthContext.role` / `requireRole` machinery in `postgres-auth.ts`; mirror the `/v1/members` guard-composition idiom.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. **Never commit to main;** work on a branch. Nothing pushed.

---

## Architecture

```
request (Bearer API key)
   │
   ▼
writeAuth  = [ requirePostgresServerAuth(..., requiredScopes:['memories:write']) , ...writeGuards ]
   │   (verifies key + memories:write SCOPE; populates authContext incl. role)
   ▼
requireWriteRole            ← NEW, added after writeAuth on content-mutating routes
   │   allow = role == null || roleSatisfies(role,'member')
   │   deny (403) only when role != null && role below member  (explicit viewer)
   ▼
route handler (create / delete observation)
```

`requireWriteRole` runs AFTER `writeAuth` (which sets `authContext.role`), exactly as `requireRole('admin')` runs after `writeAuth` on `/v1/members`.

## Components

### 1. `requireWriteRole` — new guard (`src/server/middleware/postgres-auth.ts`)
```ts
// Write/delete content routes require a >= member role, BUT a null role
// (legacy/scope-only key: no user_id or no team_members row) is treated as
// member-equivalent so existing scope-only keys keep working. Only an explicit
// role strictly below member (viewer) is denied. Fail-safe: absent authContext → deny.
export function requireWriteRole(): RequestHandler {
  return (req, res, next) => {
    const ctx = req.authContext;
    if (!ctx) { res.status(403).json({ error: 'Forbidden', message: 'requires write role' }); return; }
    const role = ctx.role; // PostgresTeamRole | null
    const allow = role == null || roleSatisfies(role, 'member');
    if (allow) return next();
    res.status(403).json({ error: 'Forbidden', message: 'requires role member or higher' });
  };
}
```
- Placed beside `requireRole` / `roleSatisfies`. No change to those.
- No parameter needed — the floor is always `member` for content mutation (per the design decision). A parameterized variant is YAGNI here.

### 2. Apply to the 8 content-mutating routes (`src/server/routes/v1/ServerV1PostgresRoutes.ts`)
Insert `requireWriteRole()` into the middleware chain, after `writeAuth`, for:
| Route | Line (approx) |
|---|---|
| `POST /v1/memories` | 923 |
| `POST /v1/events` | 292 |
| `POST /v1/events/batch` | 370 |
| `POST /v1/record-intent` | 969 |
| `POST /v1/sessions/start` | 772 |
| `POST /v1/sessions/:id/end` | 869 |
| `DELETE /v1/memories/:id` | 1265 |
| `DELETE /v1/projects/:projectId/memory` | 1287 |

Composition mirrors `/v1/members` (`app.post('/v1/members', writeAuth, requireRole('admin'), handler)`) → e.g. `app.post('/v1/memories', writeAuth, requireWriteRole(), this.handleCreate(...))`. For routes built with `this.handleCreate(...)` or `this.asyncHandler(...)`, insert `requireWriteRole()` as a middleware argument between `writeAuth` and the handler (Express accepts the extra `RequestHandler`).

**Read routes are untouched** — a viewer must still be able to read (`/v1/search`, GET routes keep `readAuth`, no role gate).

## Data Flow

- **Viewer key (explicit role=viewer) → any write/delete:** `writeAuth` passes (has scope) → `requireWriteRole` sees `role='viewer'`, `roleSatisfies('viewer','member')=false`, `role != null` → **403**. Bug closed.
- **Legacy/scope-only key (role=null) → write:** `writeAuth` passes → `requireWriteRole` sees `role==null` → allow → **works as today**. No lockout.
- **Member/admin/owner key → write:** `role >= member` → allow. Unchanged.
- **Read (viewer or anyone) → `/v1/search`:** no `requireWriteRole` on read routes → unaffected.

## Error Handling & Failure Modes

| Situation | Behavior |
|---|---|
| Explicit viewer, write/delete | 403 (bug fixed) |
| Legacy null-role key, write/delete | Allowed (member-equivalent — no regression) |
| member/admin/owner, write/delete | Allowed |
| Absent authContext (misorder/auth fail) | 403 (fail-safe deny) |
| Any read route | Unaffected (no write-role gate) |

**Invariant:** an explicit `viewer` can never write or delete team content; a legacy scope-only key behaves exactly as before this change.

## Testing

1. **Unit — `requireWriteRole`:** table of `role → outcome`: `viewer` → 403; `null` → next(); `member`/`admin`/`owner` → next(); absent `authContext` → 403. Assert `res.status(403)` vs `next()` called.
2. **Regression — the exact C4 scenario (integration-style, injected authContext or a route-level harness):** a request whose `authContext.role='viewer'` (with write scope) to a write route → 403; the same route with `role=null` → passes the guard (200/201 path); with `role='member'` → passes.
3. **No read regression:** a `viewer` can still reach a read route (guard not applied there).
4. **Live re-validation (acceptance):** re-run the team-mode rig (2nd server + Docker pgvector PG) — mint a viewer key with write scope, confirm `POST /v1/memories` now returns **403**; confirm an owner/member key still writes (201); confirm a legacy null-role write-scoped key still writes (201). Then tear down.

## Acceptance Criteria

1. `requireWriteRole` denies an explicit `viewer` (role below member) and allows `null` role (legacy) + `member`/`admin`/`owner`; fail-safe denies when `authContext` is absent.
2. All 8 content-mutating routes (`/v1/memories`, `/v1/events`, `/v1/events/batch`, `/v1/record-intent`, `/v1/sessions/start`, `/v1/sessions/:id/end`, both DELETEs) enforce `requireWriteRole` after `writeAuth`.
3. Read routes are unaffected (a viewer can still read).
4. The C4 scenario is closed (viewer write → 403) and no legacy scope-only key is locked out (null-role write → still succeeds), both proven by test.
5. `src` typecheck clean; touched/added test files green; nothing pushed; work on a branch.

## Deferred (own specs)
- Ownership-based deletion (member deletes only own `createdByUserId` content) + the one-time legacy `createdByUserId: null` → owner backfill that enables it (safe now because the user is the sole owner).
- Role gating on any other routes if a future audit finds more scope-only-but-should-be-role-gated paths.
