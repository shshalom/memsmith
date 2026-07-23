# Authorization Finish + Tidy — Design

**Status:** Design (2026-07-22). Branches from `main` @ `942d3a1d` (dead-URL cleanup merge). A single coherent batch of four small changes: finish enforcing a role floor on the remaining unguarded mutating routes, and remove the duplication the ownership-delete work exposed.

---

## Motivation

The C4 fix and the ownership-delete feature gated the observation write/delete routes on role. But an audit (final ownership-delete review) surfaced that two other mutating route groups still carry only a **scope** check (`writeAuth`), not a **role** floor:

- `POST /v1/jobs/:id/retry` and `POST /v1/jobs/:id/cancel` — job control, `writeAuth`-only. A viewer holding a write-scoped key can drive job control.
- `POST /v1/keys` — API-key minting, `writeAuth`-only. Minting a credential is a privileged act that any write-scoped key can currently perform.

Separately, the ownership-delete review noted two deferrable minors now worth closing:
- The scoping predicate (project-scoped → id+team+project; team-scoped → id+team) is hand-duplicated across `getObservationForDelete` and `deleteObservationForScope` — a future-desync risk (the auth read could drift from the delete).
- The reusable backfill script's count→update→recount is not transactional — the reported figures can be inconsistent under concurrent writes when the script is reused on another project.

This batch finishes the "who can do what" story and tidies both.

## Scope

**In (four pieces):**
1. **Job-control role gate:** add `requireWriteRole()` after `writeAuth` on `POST /v1/jobs/:id/retry` and `POST /v1/jobs/:id/cancel`.
2. **Key-mint role gate:** add `requireRole('admin')` after `writeAuth` on `POST /v1/keys`.
3. **Scope-predicate extraction:** extract the duplicated scoping decision into one private helper `observationScope(id, teamId, projectScope)` used by both `getObservationForDelete` (SELECT) and `deleteObservationForScope`'s team branch (raw DELETE). Behavior-preserving.
4. **Backfill transaction:** wrap the backfill script's execute path (update + recount) in a `BEGIN/COMMIT` (`ROLLBACK` on error).

**Out (explicitly):**
- Any change to read routes (`GET /v1/jobs`, `/v1/jobs/:id` stay `readAuth`).
- Rerouting `deleteObservationForScope`'s **project** branch away from `PostgresDataDeletionRepository` — it already scopes by id+project+team internally; we do not change it, only align it by comment. (YAGNI — forcing both branches through one query would be over-engineering.)
- Broadening key scopes or changing what a minted key can do (minted keys stay `['memories:read']`).
- Ownership on generated observations for members (excluded by the prior spec, unchanged here).

## Global Constraints

- **Never commit to `main`;** work on a branch. `--no-ff` merge recording pre-merge rollback SHA `942d3a1d`. Nothing pushed (local only).
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **The role gates only *tighten*.** Job control: viewer denied, ≥member + null-role allowed (C4 contract). Key-mint: below-admin denied, admin/owner allowed; a null-role legacy key on key-mint — see the note below.
- **Null-role on the admin gate:** `requireRole('admin')` uses `roleSatisfies(role,'admin')`, which is `false` for `null`. So a legacy null-role key is DENIED key-mint. This is acceptable and intended: minting credentials is an operator act; a legacy scope-only key was never a human admin. (Contrast `requireWriteRole`, which deliberately allows null for back-compat on content writes. Key-mint is not content.)
- **Piece 3 must be behavior-preserving** — the existing `ownership-delete.test.ts` and `data-deletion.test.ts` are the regression net; both must stay green.
- **Reuse, don't rebuild:** `requireWriteRole`, `requireRole`, `roleSatisfies` all already imported into `ServerV1PostgresRoutes.ts`.

---

## Architecture

```
POST /v1/jobs/:id/retry   writeAuth → requireWriteRole()  [NEW] → handler   (>=member; viewer 403; null-role ok)
POST /v1/jobs/:id/cancel  writeAuth → requireWriteRole()  [NEW] → handler
POST /v1/keys             writeAuth → requireRole('admin') [NEW] → handleCreate(...)   (>=admin; member/viewer/null 403)

observationScope(id, teamId, projectScope) → { where, params }
   ├── getObservationForDelete: SELECT ... WHERE <where>       (was inline dup)
   └── deleteObservationForScope team branch: DELETE ... WHERE <where>   (was inline dup)
       (project branch unchanged — delegates to PostgresDataDeletionRepository)

backfill main() execute path: BEGIN → UPDATE → count(remaining) → COMMIT (ROLLBACK on error)
```

## Components

### 1. Job-control role gate (`ServerV1PostgresRoutes.ts` ~737, ~756)
```ts
app.post('/v1/jobs/:id/retry',  writeAuth, requireWriteRole(), this.asyncHandler(/* unchanged */));
app.post('/v1/jobs/:id/cancel', writeAuth, requireWriteRole(), this.asyncHandler(/* unchanged */));
```

### 2. Key-mint role gate (`ServerV1PostgresRoutes.ts` ~245)
```ts
app.post('/v1/keys', writeAuth, requireRole('admin'), this.handleCreate(/* unchanged */));
```
Verified: no internal client/CLI mints keys via this route (agents use the base key), so an admin floor does not break onboarding.

### 3. `observationScope` helper (`ServerV1PostgresRoutes.ts`, beside the two consumers)
```ts
// Single source of the scoped-observation predicate shared by the scoped delete
// and its authorization read: a project-scoped key is confined to its project;
// a team-scoped key spans the team. Returns a positional WHERE + params so both
// a SELECT and a DELETE can build on it identically.
private observationScope(
  id: string, teamId: string, projectScope: string | null,
): { where: string; params: unknown[] } {
  return projectScope != null
    ? { where: 'id = $1 AND team_id = $2 AND project_id = $3', params: [id, teamId, projectScope] }
    : { where: 'id = $1 AND team_id = $2', params: [id, teamId] };
}
```
- `getObservationForDelete`: `const { where, params } = this.observationScope(...)`, then `SELECT kind, metadata->>'createdByUserId' AS created_by_user_id FROM observations WHERE ${where}`.
- `deleteObservationForScope` team branch: `DELETE FROM observations WHERE ${where}` with the same params. Project branch: unchanged (repository), with a one-line comment noting it scopes id+project+team internally so the two stay aligned.

### 4. Backfill transaction (`scripts/backfill-attribution.mjs` `main()`)
```js
await client.query('BEGIN');
try {
  const res = await client.query(buildUpdateSql(hasProject), updateParams);
  const after = await client.query(buildCountSql(hasProject), countParams);
  await client.query('COMMIT');
  const remaining = after.rows.reduce((s, r) => s + r.n, 0);
  console.log(`[backfill] bound ${res.rowCount} rows to owner=${cfg.ownerUserId}; null-owner remaining: ${remaining}`);
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
}
```
Dry-run path (read-only) unchanged — no transaction.

## Wiring-test reconciliation (certain, not optional)

`tests/server/routes/v1/write-role-gating.test.ts` asserts the exact set of `requireWriteRole` routes (currently **7** after the purge 8→7). Piece 1 adds two → the count and list MUST grow **7 → 9**, adding `{ method:'post', path:'/v1/jobs/:id/retry' }` and `{ method:'post', path:'/v1/jobs/:id/cancel' }`. The `/v1/search` negative assertion is untouched. Piece 2 does NOT touch this test (`/v1/keys` was never a `requireWriteRole` route); its coverage is a new admin-gate test.

## Data Flow

| Caller | Route | Outcome |
|---|---|---|
| viewer (write scope) | `POST /v1/jobs/:id/retry|cancel` | 403 (requireWriteRole) |
| member/admin/owner | `POST /v1/jobs/:id/retry|cancel` | proceed |
| null-role legacy key | `POST /v1/jobs/:id/retry|cancel` | proceed (back-compat) |
| member (or viewer, or null-role) | `POST /v1/keys` | 403 (requireRole admin) |
| admin/owner | `POST /v1/keys` | 201 (mint key) |
| any | `GET /v1/jobs`, `/v1/jobs/:id` | unchanged (readAuth) |
| any delete caller | `DELETE /v1/memories/:id` | unchanged behavior; scoping now via observationScope |
| backfill --execute, concurrent write | script | consistent count/remaining (transaction) |

## Error Handling & Failure Modes

| Situation | Behavior |
|---|---|
| viewer drives job control | 403 |
| member mints key | 403 |
| null-role key mints key | 403 (intended — minting is not back-compat content write) |
| null-role key drives job control | allowed (back-compat, same as content writes) |
| observationScope refactor | identical results to pre-refactor (regression-tested) |
| backfill error mid-execute | ROLLBACK; no partial attribution written |

**Invariant:** every mutating route now carries BOTH a scope check and a role floor. Piece 3 changes no delete/auth behavior. The backfill either fully applies its scoped update or rolls back.

## Testing

1. **Job-control gate** — in `write-role-gating.test.ts`: add the two job routes to the asserted `requireWriteRole` set; update count 7→9 and the `it(...)` title. (This is the reconciliation.)
2. **Key-mint gate** — new `tests/server/routes/v1/keys-role-gating.test.ts` mirroring `purge-role-gating.test.ts`: fingerprint a `requireRole('admin')` guard on `POST /v1/keys` — probe denies member (403) AND allows admin (next).
3. **`observationScope` unit** — new `tests/server/routes/v1/observation-scope.test.ts` (or fold into an existing routes test): assert `{where, params}` for projectScope != null (`id=$1 AND team_id=$2 AND project_id=$3`, 3 params) and projectScope == null (`id=$1 AND team_id=$2`, 2 params). Since `observationScope` is private, expose it for test via the same pattern the repo already uses for testing private helpers, OR test it indirectly by asserting the two consumers still pass — prefer a minimal exported pure helper if the class makes private testing awkward; decide in the plan against the repo's existing convention.
4. **Backfill txn** — extend `backfill-attribution.test.ts` only for what's testable without a live DB: the pure builders are unchanged, so assert they still produce the expected SQL; the BEGIN/COMMIT wrapping in `main()` is verified by code review (it needs a live client). No false-DB test.
5. **Regression** — `ownership-delete.test.ts` (6) + `data-deletion.test.ts` stay green (piece 3 net). C4/purge assertions intact except the intended 7→9.
6. **Gate** — tsc clean; touched test set green; broader `tests/server/` green modulo the known 5 pre-existing `:55432` env failures.

## Acceptance Criteria

1. `POST /v1/jobs/:id/retry` and `/cancel` carry `requireWriteRole()` after `writeAuth`; a viewer is denied, ≥member and null-role allowed.
2. `POST /v1/keys` carries `requireRole('admin')` after `writeAuth`; member/viewer/null-role denied, admin/owner allowed; handler body + minted-key scopes unchanged.
3. `observationScope` is the single source of the scoped-observation predicate; `getObservationForDelete` and `deleteObservationForScope`'s team branch both build on it; delete/auth behavior is unchanged (regression tests green).
4. The backfill `--execute` path is wrapped in BEGIN/COMMIT with ROLLBACK on error; dry-run path unchanged.
5. `write-role-gating.test.ts` reconciled 7→9 (job routes added), `/v1/search` negative assertion intact; new key-mint + observationScope tests green.
6. `src` typecheck clean; touched tests green; branch; `--no-ff` merge w/ rollback SHA; nothing pushed.

## Deferred (unchanged / later)
- OIDC / Cognito identity provider (the horizon build).
- Email-invite membership (Spec #3).
- better-auth browser session e2e; wizard Convert-flip e2e.
- Attribution dashboard views (surface createdByUserId now that rows are attributed).
