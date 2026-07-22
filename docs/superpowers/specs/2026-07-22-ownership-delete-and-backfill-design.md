# Ownership-Based Delete + Legacy-Owner Backfill — Design

**Status:** Design (2026-07-22). Branches from `main` @ `fc0dd9a1` (the C4 role-gating merge). Two decoupled deliverables that share the `createdByUserId` attribution concept: (A) a row-level **ownership-delete authorization** rule on the single-observation delete route, and (B) a one-time, reusable, parameterized **legacy-owner backfill** script.

---

## Motivation

Identity Core stamps `createdByUserId` into `observations.metadata` at write time (`stampAttribution`, `src/server/routes/v1/attribution.ts`) — but **only when `authContext.userId` is set**. Legacy/local writes (no user) leave it absent. Today that attribution is **write-only: it is never read back or enforced** (verified — zero read sites). So:

- **No one is constrained by authorship on delete.** After the C4 fix, `DELETE /v1/memories/:id` is gated on key scope (`writeAuth`) and role tier (`requireWriteRole` = ≥member). A member can delete *anything* in scope — including generated observations and other members' notes.
- **Historical rows have no owner.** Everything captured before attribution existed (and everything captured in local/no-user mode) has `createdByUserId` absent, so any future ownership rule has nothing to match against for that history.

This spec adds the missing authorization axis (authorship/ownership) on the single-delete path, and provides the data migration that gives historical rows an owner — safely, because the user is currently the sole owner.

## The user/notes distinction (the crux)

MemSmith's data model already separates two kinds of memory via the `kind` column:

- **`kind = 'user_note'`** — content the user *explicitly authored* ("remember that…"). Set deterministically by `record-intent-intercept` (not dependent on the agent choosing `note_add`).
- **`kind = 'observation'`** (default) — content *machine-generated* by the pipeline from tool activity (Reads/Edits/Bash → compressed → summarized).

"Ownership" means different things for each. A user *wrote* their notes (clear, intentional authorship). A generated observation was *produced from* their activity but authored by the model — "ownership" is fuzzier. The design honors this: **members self-delete only what they wrote (their notes); pruning system-generated memory is a moderation action reserved to admin/owner.**

## Scope

**In:**
- **(A) Ownership-delete rule** on `DELETE /v1/memories/:id`: a row-level authorization (`authorizeObservationDelete`) applied in the handler body after the existing `writeAuth` + `requireWriteRole()` gates.
- **Role bump on the bulk purge** `DELETE /v1/projects/:projectId/memory`: from ≥member (`requireWriteRole()`) to ≥admin (`requireRole('admin')`) — a mass-destructive op belongs to admin/owner. (No per-row ownership on a bulk op; that is nonsensical.)
- **(B) Backfill script** `scripts/backfill-attribution.mjs`: idempotent, dry-run-by-default, parameterized (owner userId + team + optional project), binds null-owner rows to a target owner. Reusable across projects.
- Tests: unit for `authorizeObservationDelete`; integration/regression for the delete route across (role × kind × owner); a dry-run assertion for the script's row-selection SQL.

**Out (explicitly):**
- **Ownership on generated observations for members.** Deliberately excluded — members never self-delete `kind='observation'`; that is admin/owner-only.
- **Edit/update ownership** (only delete is in scope; there is no observation-content edit route to gate).
- **A backfill API endpoint / auto-run-at-boot.** The backfill is a deliberately-run script, not an automatic migration (auto-mutating attribution on every deploy is riskier and can't be gated to the sole-user precondition).
- **Ownership on the bulk purge** beyond the role bump. Purge is all-or-nothing by role, not by row.
- Any change to `requireRole`, `requireWriteRole`, `roleSatisfies`, or the C4 route set.

## Global Constraints

- **Never commit to `main`;** work on a branch. `--no-ff` merge recording a pre-merge rollback SHA. Nothing pushed (local only).
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **The rule only *tightens* explicit members.** A legacy scope-only key (`role == null`) keeps behaving exactly as today — no lockout. Mirror `requireWriteRole`'s null-role rule precisely.
- **Fail-safe = deny** for an explicit member who fails the ownership check (403), but **fail-open for null-role** (allow), consistent with the C4 back-compat contract.
- **Reuse, don't rebuild.** Build on `AuthContext.role` / `AuthContext.userId` / `roleSatisfies` / the existing delete handler. Mirror `scripts/reclassify-lifecycle.mjs`'s shape for the backfill (SPDX header, usage/env doc block, `--execute` dry-run gate, `pg` module).
- **The backfill must be parameterized and reusable** — a second, larger project will be migrated with the *same* script. Nothing dogfood-specific hardcoded.
- **Never overwrite an existing owner.** The backfill touches only `createdByUserId IS NULL` rows.
- **Dogfood data must never be at risk.** The backfill defaults to dry-run; it writes only with `--execute` and requires explicit owner+team env.

---

## Architecture

```
DELETE /v1/memories/:id
   │
   ▼
writeAuth              (key + memories:write scope; populates authContext incl. role, userId)
   │
   ▼
requireWriteRole()     (≥member OR null-role; explicit viewer → 403)   [existing, C4]
   │
   ▼
handler body:
   1. fetch row {kind, createdByUserId} by (id, teamId)  → absent? 404
   2. authorizeObservationDelete(authContext, row)       → denied? 403 (explicit reason)
   3. delete (existing scoped delete)                    → 200

DELETE /v1/projects/:projectId/memory
   │
   ▼
writeAuth → requireRole('admin')   [CHANGED from requireWriteRole()]
   ▼
handler body (unchanged: project-belongs-to-team check + purge)
```

The two pieces are decoupled: the rule is correct whether or not the backfill ran; the backfill is safe whether or not the rule shipped. The backfill only *enriches* what the rule can act on (null-owner rows become member-deletable when they are that member's notes).

## Components

### 1. `authorizeObservationDelete` — new pure helper (`src/server/routes/v1/delete-authorization.ts`)

```ts
// SPDX-License-Identifier: Apache-2.0
import type { AuthContext } from '../../middleware/postgres-auth.js';
import { roleSatisfies } from '../../middleware/postgres-auth.js';

export interface DeletableRow {
  kind: string;                       // 'user_note' | 'observation' | ...
  createdByUserId: string | null;     // metadata.createdByUserId, or null
}

export type DeleteDecision =
  | { allow: true }
  | { allow: false; reason: 'wrong_kind' | 'wrong_owner' };

/**
 * Row-level authorization for DELETE /v1/memories/:id, applied AFTER writeAuth +
 * requireWriteRole. Only *tightens* an explicit member; null-role (legacy
 * scope-only) and admin+ are unaffected.
 *
 *  - role >= admin (admin | owner)   → allow (moderation authority over any kind)
 *  - role == null  (legacy key)      → allow (back-compat; identical to requireWriteRole)
 *  - role == member:
 *       allow only when kind === 'user_note' AND createdByUserId === authContext.userId
 *       deny 'wrong_kind'  when kind !== 'user_note'  (generated observation → needs admin)
 *       deny 'wrong_owner' when kind === 'user_note' but owner mismatches
 *  - viewer never reaches here (requireWriteRole already 403'd)
 */
export function authorizeObservationDelete(
  authContext: Pick<AuthContext, 'role' | 'userId'>,
  row: DeletableRow,
): DeleteDecision {
  const { role, userId } = authContext;

  // admin/owner: full moderation authority.
  if (roleSatisfies(role, 'admin')) return { allow: true };

  // legacy scope-only key: unchanged behavior (no ownership tightening).
  if (role == null) return { allow: true };

  // explicit member (roleSatisfies(role,'admin') false, role not null → member).
  if (row.kind !== 'user_note') return { allow: false, reason: 'wrong_kind' };
  if (!userId || row.createdByUserId !== userId) return { allow: false, reason: 'wrong_owner' };
  return { allow: true };
}
```

Notes:
- `roleSatisfies(role,'admin')` is true for admin+owner and false for member/viewer/null — reused, not reinvented.
- The `role == null` branch is reached only for legacy keys (viewer already 403'd upstream), so treating null as allow matches the C4 contract exactly.
- Pure and total; no DB, no throw — fully unit-testable.

### 2. `DELETE /v1/memories/:id` handler change (`src/server/routes/v1/ServerV1PostgresRoutes.ts`, ~1265)

Fetch-before-delete, then authorize:

```ts
app.delete('/v1/memories/:id', writeAuth, requireWriteRole(), this.asyncHandler(async (req, res) => {
  const teamId = this.requireTeamId(req, res);
  if (!teamId) return;
  const id = String(req.params.id);
  const projectScope = req.authContext?.projectId ?? null;
  try {
    // Fetch the row first so we can authorize by kind + owner (row-level auth).
    const row = await this.getObservationForDelete(id, teamId, projectScope);
    if (!row) { res.status(404).json({ error: 'not_found' }); return; }

    const decision = authorizeObservationDelete(
      req.authContext ?? { role: null, userId: null },
      row,
    );
    if (!decision.allow) {
      const message = decision.reason === 'wrong_kind'
        ? 'members may delete only their own notes; deleting a generated observation requires admin'
        : 'members may delete only their own notes; this note belongs to another member';
      res.status(403).json({ error: 'Forbidden', message });
      return;
    }

    const deleted = await this.deleteObservationForScope(id, teamId, projectScope);
    if (!deleted) { res.status(404).json({ error: 'not_found' }); return; }
    await this.auditWrite(req, 'observation.deleted', id, projectScope, { via: 'api' });
    res.status(200).json({ deleted: true, id });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', 'observation.delete failed', { requestId: req.requestId ?? null }, err);
    this.handleDbError(err, res, 'observation.delete');
  }
}));
```

New private `getObservationForDelete(id, teamId, projectScope)` — mirrors `deleteObservationForScope`'s scoping (project-scoped key restricted to its project; team-scoped key to the team) but SELECTs `kind, metadata->>'createdByUserId' AS created_by_user_id` instead of deleting. Returns `{ kind, createdByUserId } | null`. Placed beside `deleteObservationForScope` (~1897).

### 3. Bulk-purge role bump (`ServerV1PostgresRoutes.ts`, ~1287)

Change the gate only:
```ts
// before: app.delete('/v1/projects/:projectId/memory', writeAuth, requireWriteRole(), ...)
app.delete('/v1/projects/:projectId/memory', writeAuth, requireRole('admin'), this.asyncHandler(async (req, res) => { /* body unchanged */ }));
```
`requireRole` is already imported (used by `/v1/members`). No body change.

### 4. `scripts/backfill-attribution.mjs` — the reusable migration

Mirrors `reclassify-lifecycle.mjs`. Dry-run by default; writes only with `--execute`.

```
Usage:
  bun scripts/backfill-attribution.mjs                 # dry-run: count + sample, NO write
  bun scripts/backfill-attribution.mjs --execute       # bind null-owner rows to OWNER_USER_ID

Env:
  OWNER_USER_ID  (required)  userId to bind null-owner rows to
  TEAM_ID        (required)  scope to one team
  PROJECT_ID     (optional)  further scope to one project; omit = whole team
  PG_URL         default postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres
```

Behavior:
1. Refuse (exit 1, loud) if `OWNER_USER_ID` or `TEAM_ID` is missing.
2. Report null-owner count (total + by `kind`) within scope, and print a small sample.
3. Dry-run: stop here.
4. `--execute`: run the guarded `UPDATE`, then re-count null-owner remaining (expect 0 in scope) and report rows updated.

The write (never overwrites an existing owner — `IS NULL` guard):
```sql
UPDATE observations
   SET metadata = jsonb_set(metadata, '{createdByUserId}', to_jsonb($1::text), true),
       updated_at = now()
 WHERE team_id = $2
   AND ($3::text IS NULL OR project_id = $3)
   AND metadata->>'createdByUserId' IS NULL;
```

**Reuse precondition (stated loudly in the script header):** binding all null-owner rows to a single owner is correct ONLY when that owner is the sole author of the scoped history (true for the dogfood project now, and to be confirmed true for the larger project before running it there). The script does not verify sole-user-ness; that judgment is the operator's at run time.

## Data Flow

| Caller | Target | Outcome |
|---|---|---|
| member, own `user_note` (`createdByUserId==me`) | `DELETE /v1/memories/:id` | 200 deleted |
| member, another member's `user_note` | `DELETE /v1/memories/:id` | 403 `wrong_owner` |
| member, any `kind='observation'` | `DELETE /v1/memories/:id` | 403 `wrong_kind` |
| admin/owner, any row (either kind) | `DELETE /v1/memories/:id` | 200 deleted (moderation) |
| legacy null-role key, any row | `DELETE /v1/memories/:id` | 200 deleted (back-compat) |
| viewer, any row | `DELETE /v1/memories/:id` | 403 (from `requireWriteRole`, before the rule) |
| nonexistent / cross-team id | `DELETE /v1/memories/:id` | 404 (fetch returns null) |
| member | `DELETE /v1/projects/:projectId/memory` | 403 (now ≥admin) |
| admin/owner | `DELETE /v1/projects/:projectId/memory` | 200 purged |
| backfill (dry-run) | script | counts + sample, no write |
| backfill (`--execute`) | script | null-owner rows in scope → owner; re-run → 0 changes |

## Error Handling & Failure Modes

| Situation | Behavior |
|---|---|
| Member deletes own note | 200 |
| Member deletes generated observation | 403 `wrong_kind` |
| Member deletes another's note | 403 `wrong_owner` |
| Admin/owner deletes anything | 200 |
| Null-role legacy key deletes anything | 200 (unchanged) |
| Viewer | 403 (upstream, unchanged) |
| Row absent / cross-team | 404 (fetch-before-delete) |
| `authContext` absent | treated as `{role:null,userId:null}` → null-role allow (but writeAuth would already have rejected an unauthenticated caller) |
| Member on bulk purge | 403 (role bump) |
| Backfill missing OWNER_USER_ID/TEAM_ID | exit 1, loud, no write |
| Backfill re-run after execute | 0 rows changed (idempotent) |
| Backfill row already owned | never touched (`IS NULL` guard) |

**Invariants:**
- An explicit member can delete only their own `user_note`; never a generated observation, never another member's note.
- A legacy scope-only key behaves exactly as before this change.
- The backfill never overwrites an existing owner and is safely re-runnable.

## Testing

1. **Unit — `authorizeObservationDelete`** (`delete-authorization.test.ts`): table over (role × kind × owner):
   - member + `user_note` + own → allow
   - member + `user_note` + other owner → deny `wrong_owner`
   - member + `user_note` + `createdByUserId=null` → deny `wrong_owner`
   - member + `observation` (any owner) → deny `wrong_kind`
   - admin + anything → allow; owner + anything → allow
   - null role + anything → allow
2. **Integration/regression — the delete route** (inject `authContext`, or a route-level harness with a real row):
   - member deleting own note → 200; member deleting a generated observation → 403 `wrong_kind`; member deleting another's note → 403 `wrong_owner`; admin deleting a member's note → 200; null-role key deleting a note → 200; nonexistent id → 404.
3. **Bulk-purge role** — member → 403; admin → 200 (guard swapped to `requireRole('admin')`).
4. **Backfill row-selection** — against a throwaway/seed dataset with mixed null-owner and owned rows: dry-run reports the correct null-owner count and writes nothing; `--execute` binds exactly the null-owner rows in scope and leaves owned rows untouched; a second `--execute` changes 0 rows.
5. **No read/search regression** — a member/viewer can still *read* rows they cannot delete (reads are unchanged).

## Acceptance Criteria

1. `authorizeObservationDelete` implements the (role × kind × owner) matrix above: member self-deletes only own `user_note`; admin/owner delete any; null-role allowed; deny reasons distinguish `wrong_kind` vs `wrong_owner`.
2. `DELETE /v1/memories/:id` fetches the row, 404s if absent, applies the rule (403 with the correct message on denial), and deletes only on allow — with `writeAuth` + `requireWriteRole()` still in front.
3. `DELETE /v1/projects/:projectId/memory` is gated ≥admin (`requireRole('admin')`); a member gets 403, admin/owner 200; body unchanged.
4. `scripts/backfill-attribution.mjs` is parameterized (OWNER_USER_ID + TEAM_ID required, PROJECT_ID optional), dry-run by default, idempotent, never overwrites an existing owner, and reports counts (total + by kind).
5. Reads/search are unaffected (a caller can still read rows it cannot delete).
6. `src` typecheck clean; touched/added test files green; work on a branch; `--no-ff` merge with recorded rollback SHA; nothing pushed.

## Deferred (own specs / later)

- **OIDC / Cognito identity provider** — the big networked build; intentionally after this.
- **Ownership on generated observations for members** — if a future need arises to let members prune their own machine-generated memory, revisit; excluded here by design.
- **A backfill API / auto-migration** — only if a multi-user, non-sole-owner attribution need emerges.
