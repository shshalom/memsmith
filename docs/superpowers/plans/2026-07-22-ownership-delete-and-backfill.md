# Ownership-Based Delete + Legacy-Owner Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce that team members may self-delete only their own `user_note`s (generated observations are admin/owner-only), bump the bulk project-purge to ≥admin, and ship a reusable parameterized script that backfills null-owner rows to a target owner.

**Architecture:** A pure row-level authorization helper (`authorizeObservationDelete`) is applied in the `DELETE /v1/memories/:id` handler body after the existing `writeAuth` + `requireWriteRole()` gates, on a row fetched before deletion. The bulk-purge route swaps its role gate to `requireRole('admin')`. A standalone `scripts/backfill-attribution.mjs` (mirroring `reclassify-lifecycle.mjs`) binds null-owner rows to an owner, dry-run by default.

**Tech Stack:** TypeScript, Express, Postgres (JSONB metadata), `bun test`, `pg` module, Bun script runtime.

## Global Constraints

- **Never commit to `main`;** work on branch `ownership-delete-and-backfill` (already created; spec committed @ `98286168`). Rollback point: `main` @ `fc0dd9a1`.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Nothing pushed** (local only). Final merge is `--no-ff` recording the pre-merge rollback SHA.
- **The rule only *tightens* explicit members.** `role == null` (legacy scope-only key) and `role >= admin` are unaffected — mirror `requireWriteRole`'s null-role contract exactly.
- **Fail-safe = deny** for an explicit member failing the ownership check (403); **fail-open (allow) for null-role**.
- **Reuse, don't rebuild:** build on `AuthContext.role`/`userId`, `roleSatisfies`, the existing delete handler; `requireRole` is already imported into `ServerV1PostgresRoutes.ts` (line 22).
- **Backfill must be parameterized & reusable** (a larger project is migrated with the same script later): `OWNER_USER_ID` + `TEAM_ID` required, `PROJECT_ID` optional; dry-run by default; idempotent; never overwrites an existing owner (`createdByUserId IS NULL` guard only).
- **Test runner:** `bun test <path>`. Tests live under `tests/`, not `src/`.

---

### Task 1: `authorizeObservationDelete` pure helper

**Files:**
- Create: `src/server/routes/v1/delete-authorization.ts`
- Test: `tests/server/routes/v1/delete-authorization.test.ts`

**Interfaces:**
- Consumes: `AuthContext` (`role: PostgresTeamRole | null`, `userId: string | null`) and `roleSatisfies(role, min)` from `src/server/middleware/postgres-auth.js`.
- Produces:
  - `interface DeletableRow { kind: string; createdByUserId: string | null }`
  - `type DeleteDecision = { allow: true } | { allow: false; reason: 'wrong_kind' | 'wrong_owner' }`
  - `function authorizeObservationDelete(authContext: Pick<AuthContext,'role'|'userId'>, row: DeletableRow): DeleteDecision`

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/routes/v1/delete-authorization.test.ts
import { describe, it, expect } from 'bun:test';
import { authorizeObservationDelete } from '../../../../src/server/routes/v1/delete-authorization.js';

const note = (owner: string | null) => ({ kind: 'user_note', createdByUserId: owner });
const obs = (owner: string | null) => ({ kind: 'observation', createdByUserId: owner });

describe('authorizeObservationDelete', () => {
  it('member may delete own user_note', () => {
    expect(authorizeObservationDelete({ role: 'member', userId: 'u1' }, note('u1'))).toEqual({ allow: true });
  });
  it("member may NOT delete another member's note (wrong_owner)", () => {
    expect(authorizeObservationDelete({ role: 'member', userId: 'u1' }, note('u2'))).toEqual({ allow: false, reason: 'wrong_owner' });
  });
  it('member may NOT delete a null-owner note (wrong_owner)', () => {
    expect(authorizeObservationDelete({ role: 'member', userId: 'u1' }, note(null))).toEqual({ allow: false, reason: 'wrong_owner' });
  });
  it('member may NOT delete a generated observation (wrong_kind)', () => {
    expect(authorizeObservationDelete({ role: 'member', userId: 'u1' }, obs('u1'))).toEqual({ allow: false, reason: 'wrong_kind' });
  });
  it('admin may delete any kind / any owner', () => {
    expect(authorizeObservationDelete({ role: 'admin', userId: 'a1' }, note('u2'))).toEqual({ allow: true });
    expect(authorizeObservationDelete({ role: 'admin', userId: 'a1' }, obs('u2'))).toEqual({ allow: true });
  });
  it('owner may delete any kind / any owner', () => {
    expect(authorizeObservationDelete({ role: 'owner', userId: 'o1' }, obs('u2'))).toEqual({ allow: true });
  });
  it('null role (legacy scope-only key) may delete anything (back-compat)', () => {
    expect(authorizeObservationDelete({ role: null, userId: null }, obs(null))).toEqual({ allow: true });
    expect(authorizeObservationDelete({ role: null, userId: null }, note('u2'))).toEqual({ allow: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/routes/v1/delete-authorization.test.ts`
Expected: FAIL — cannot find module `delete-authorization.js` / `authorizeObservationDelete is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/routes/v1/delete-authorization.ts
// SPDX-License-Identifier: Apache-2.0
import type { AuthContext } from '../../middleware/postgres-auth.js';
import { roleSatisfies } from '../../middleware/postgres-auth.js';

export interface DeletableRow {
  kind: string;
  createdByUserId: string | null;
}

export type DeleteDecision =
  | { allow: true }
  | { allow: false; reason: 'wrong_kind' | 'wrong_owner' };

/**
 * Row-level authorization for DELETE /v1/memories/:id, applied AFTER writeAuth +
 * requireWriteRole. Only *tightens* an explicit member; null-role (legacy
 * scope-only key) and admin+ are unaffected.
 *
 *   - role >= admin (admin | owner) → allow (moderation authority, any kind)
 *   - role == null (legacy key)     → allow (back-compat; matches requireWriteRole)
 *   - role == member:
 *        allow only when kind === 'user_note' AND createdByUserId === userId
 *        deny 'wrong_kind'  when kind !== 'user_note'
 *        deny 'wrong_owner' otherwise
 *   - viewer never reaches here (requireWriteRole already 403'd).
 */
export function authorizeObservationDelete(
  authContext: Pick<AuthContext, 'role' | 'userId'>,
  row: DeletableRow,
): DeleteDecision {
  const { role, userId } = authContext;
  if (roleSatisfies(role, 'admin')) return { allow: true };
  if (role == null) return { allow: true };
  if (row.kind !== 'user_note') return { allow: false, reason: 'wrong_kind' };
  if (!userId || row.createdByUserId !== userId) return { allow: false, reason: 'wrong_owner' };
  return { allow: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/routes/v1/delete-authorization.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/v1/delete-authorization.ts tests/server/routes/v1/delete-authorization.test.ts
git commit -m "feat(v1): authorizeObservationDelete row-level delete authorization helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `getObservationForDelete` scoped row fetch

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (add private method beside `deleteObservationForScope`, ~line 1897)
- Test: covered by Task 3's route test (this method is exercised through the route); no standalone test needed — it is a thin scoped SELECT mirroring `deleteObservationForScope`'s existing scoping, which is already covered.

**Interfaces:**
- Consumes: `this.options.pool`, the same `(id, teamId, projectScope)` scoping contract as `deleteObservationForScope`.
- Produces: `private async getObservationForDelete(id: string, teamId: string, projectScope: string | null): Promise<{ kind: string; createdByUserId: string | null } | null>`

- [ ] **Step 1: Read the existing `deleteObservationForScope` to mirror its scoping**

Run: `grep -n "deleteObservationForScope" src/server/routes/v1/ServerV1PostgresRoutes.ts`
Read lines ~1896–1915. Note the two-branch scoping: project-scoped key (`projectScope != null`) restricts to that project; team-scoped key (`projectScope == null`) restricts to the team. `getObservationForDelete` MUST mirror this exact scoping so authorization sees only rows the caller could delete.

- [ ] **Step 2: Add the method**

Insert immediately above (or below) `deleteObservationForScope`:

```ts
  // Scoped row fetch for DELETE /v1/memories/:id authorization: returns the
  // row's kind + createdByUserId within the caller's scope, or null if absent.
  // Mirrors deleteObservationForScope's scoping exactly (project-scoped key
  // restricted to its project; team-scoped key to the team) so authorization
  // never sees a row the caller couldn't target.
  private async getObservationForDelete(
    id: string,
    teamId: string,
    projectScope: string | null,
  ): Promise<{ kind: string; createdByUserId: string | null } | null> {
    const sql = projectScope != null
      ? `SELECT kind, metadata->>'createdByUserId' AS created_by_user_id
           FROM observations WHERE id = $1 AND team_id = $2 AND project_id = $3`
      : `SELECT kind, metadata->>'createdByUserId' AS created_by_user_id
           FROM observations WHERE id = $1 AND team_id = $2`;
    const params = projectScope != null ? [id, teamId, projectScope] : [id, teamId];
    const result = await this.options.pool.query(sql, params);
    const row = result.rows[0] as { kind: string; created_by_user_id: string | null } | undefined;
    if (!row) return null;
    return { kind: row.kind, createdByUserId: row.created_by_user_id };
  }
```

(If `deleteObservationForScope` uses a repository rather than raw pool SQL for the project-scoped branch, match whichever the existing code uses — confirm during Step 1. The team-scoped branch there is raw SQL `DELETE FROM observations WHERE id = $1 AND team_id = $2`; the SELECT above is its read twin.)

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json` (or the project's `src` typecheck script)
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts
git commit -m "feat(v1): getObservationForDelete scoped row fetch for delete authorization

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire the ownership rule into `DELETE /v1/memories/:id`

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (import at line 22; handler at ~1265)
- Test: `tests/server/routes/v1/ownership-delete.test.ts`

**Interfaces:**
- Consumes: `authorizeObservationDelete` (Task 1), `getObservationForDelete` (Task 2), existing `writeAuth`, `requireWriteRole()`, `this.deleteObservationForScope`, `this.auditWrite`, `this.requireTeamId`.
- Produces: the modified route (fetch → authorize → delete), reachable via `setupRoutes()`.

- [ ] **Step 1: Write the failing route test (harness mirrors write-role-gating.test.ts)**

The existing `tests/server/routes/v1/write-role-gating.test.ts` drives `setupRoutes()` against a fake express app that records middleware chains, then invokes handlers with synthetic req/res. Mirror that. Here the DELETE handler is the LAST element of the recorded chain for `('delete', '/v1/memories/:id')`. Stub the pool so `getObservationForDelete`'s SELECT returns a chosen row.

```ts
// tests/server/routes/v1/ownership-delete.test.ts
import { describe, it, expect } from 'bun:test';
import { ServerV1PostgresRoutes } from '../../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import type { RequestHandler } from 'express';

interface Registered { method: string; path: string; chain: RequestHandler[] }
function makeFakeApp() {
  const registered: Registered[] = [];
  const app: Record<string, unknown> = {};
  for (const m of ['get', 'post', 'delete', 'patch', 'put']) {
    app[m] = (path: string, ...args: unknown[]) => {
      const chain: RequestHandler[] = [];
      for (const a of args) { if (Array.isArray(a)) chain.push(...(a as RequestHandler[])); else if (typeof a === 'function') chain.push(a as RequestHandler); }
      registered.push({ method: m, path, chain });
    };
  }
  app['use'] = () => {}; app['set'] = () => {};
  return { app, registered };
}

// Pool stub: SELECT (getObservationForDelete) returns `row`; DELETE returns rowCount 1.
function makePool(row: { kind: string; created_by_user_id: string | null } | null) {
  return {
    query: async (sql: string) => {
      if (/^\s*SELECT/i.test(sql)) return { rows: row ? [row] : [] };
      return { rows: [], rowCount: row ? 1 : 0 };
    },
    connect: async () => ({}),
  } as unknown as import('../../../../src/storage/postgres/pool.js').PostgresPool;
}
function makeQueue() { return { getQueue: () => null, resolveQueue: () => null } as unknown as import('../../../../src/server/runtime/types.js').ServerQueueManager; }

function deleteHandler(row: { kind: string; created_by_user_id: string | null } | null) {
  const { app, registered } = makeFakeApp();
  const routes = new ServerV1PostgresRoutes({ pool: makePool(row), queueManager: makeQueue() } as any);
  routes.setupRoutes(app as any);
  const reg = registered.find(r => r.method === 'delete' && r.path === '/v1/memories/:id')!;
  return reg.chain[reg.chain.length - 1]; // the async handler is last
}

function invoke(handler: RequestHandler, authContext: unknown) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const req: any = { params: { id: 'obs1' }, authContext, requestId: 't' };
    const res: any = {
      statusCode: 0, body: null,
      status(c: number) { this.statusCode = c; return this; },
      json(b: unknown) { this.body = b; resolve({ status: this.statusCode || 200, body: b }); return this; },
    };
    Promise.resolve((handler as any)(req, res, () => {}));
  });
}

const ctx = (role: unknown, userId: string | null, teamId = 'team1') => ({ role, userId, teamId, projectId: null });

describe('DELETE /v1/memories/:id ownership rule', () => {
  it('member deleting own note → 200', async () => {
    const res = await invoke(deleteHandler({ kind: 'user_note', created_by_user_id: 'u1' }), ctx('member', 'u1'));
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
  it('member deleting a generated observation → 403 wrong_kind', async () => {
    const res = await invoke(deleteHandler({ kind: 'observation', created_by_user_id: 'u1' }), ctx('member', 'u1'));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/generated observation requires admin/);
  });
  it("member deleting another's note → 403 wrong_owner", async () => {
    const res = await invoke(deleteHandler({ kind: 'user_note', created_by_user_id: 'u2' }), ctx('member', 'u1'));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/belongs to another member/);
  });
  it('admin deleting a member note → 200', async () => {
    const res = await invoke(deleteHandler({ kind: 'user_note', created_by_user_id: 'u2' }), ctx('admin', 'a1'));
    expect(res.status).toBe(200);
  });
  it('null-role legacy key deleting anything → 200', async () => {
    const res = await invoke(deleteHandler({ kind: 'observation', created_by_user_id: null }), ctx(null, null));
    expect(res.status).toBe(200);
  });
  it('nonexistent row → 404', async () => {
    const res = await invoke(deleteHandler(null), ctx('member', 'u1'));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/routes/v1/ownership-delete.test.ts`
Expected: FAIL — current handler deletes without fetch/authorize, so `wrong_kind`/`wrong_owner`/`admin` cases won't behave as asserted (e.g. member deleting an observation returns 200, not 403).

- [ ] **Step 3: Add the import and rewrite the handler**

Extend the import at line 22:
```ts
import { authorizeObservationDelete } from './delete-authorization.js';
```
(Add as its own import line near the other `./` imports; do not disturb the `postgres-auth.js` import.)

Replace the `DELETE /v1/memories/:id` handler body (~1265) with:
```ts
    app.delete('/v1/memories/:id', writeAuth, requireWriteRole(), this.asyncHandler(async (req, res) => {
      const teamId = this.requireTeamId(req, res);
      if (!teamId) return;
      const id = String(req.params.id);
      const projectScope = req.authContext?.projectId ?? null;
      try {
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/server/routes/v1/ownership-delete.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the C4 wiring regression to confirm no regression**

Run: `bun test tests/server/routes/v1/write-role-gating.test.ts`
Expected: PASS (unchanged — `writeAuth` + `requireWriteRole()` still front the route).

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/routes/v1/ownership-delete.test.ts
git commit -m "feat(v1): enforce ownership on DELETE /v1/memories/:id (members delete own notes only)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Bump bulk-purge to ≥admin

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (route at ~1287)
- Test: `tests/server/routes/v1/purge-role-gating.test.ts`

**Interfaces:**
- Consumes: `requireRole` (already imported at line 22), the fake-app harness idiom.
- Produces: the purge route gated by `requireRole('admin')` instead of `requireWriteRole()`.

- [ ] **Step 1: Write the failing test (fingerprint the guard on the purge route)**

```ts
// tests/server/routes/v1/purge-role-gating.test.ts
import { describe, it, expect } from 'bun:test';
import { ServerV1PostgresRoutes } from '../../../../src/server/routes/v1/ServerV1PostgresRoutes.js';
import type { RequestHandler, Request, Response } from 'express';

interface Registered { method: string; path: string; chain: RequestHandler[] }
function makeFakeApp() {
  const registered: Registered[] = [];
  const app: Record<string, unknown> = {};
  for (const m of ['get', 'post', 'delete', 'patch', 'put']) {
    app[m] = (path: string, ...args: unknown[]) => {
      const chain: RequestHandler[] = [];
      for (const a of args) { if (Array.isArray(a)) chain.push(...(a as RequestHandler[])); else if (typeof a === 'function') chain.push(a as RequestHandler); }
      registered.push({ method: m, path, chain });
    };
  }
  app['use'] = () => {}; app['set'] = () => {};
  return { app, registered };
}
function pool() { return { query: async () => ({ rows: [] }), connect: async () => ({}) } as any; }
function queue() { return { getQueue: () => null, resolveQueue: () => null } as any; }

// A requireRole('admin') guard: denies member (403), allows admin (next).
function probeRole(fn: RequestHandler) {
  let deniedMember = false, allowedAdmin = false;
  const memReq = { authContext: { role: 'member' } } as unknown as Request;
  const memRes = { status(c: number) { if (c === 403) deniedMember = true; return this; }, json() { return this; } } as unknown as Response;
  fn(memReq, memRes, () => {});
  const admReq = { authContext: { role: 'admin' } } as unknown as Request;
  const admRes = { status() { return this; }, json() { return this; } } as unknown as Response;
  fn(admReq, admRes, () => { allowedAdmin = true; });
  return { deniedMember, allowedAdmin };
}

describe('bulk purge role gating', () => {
  it('DELETE /v1/projects/:projectId/memory requires >=admin (member denied, admin allowed)', () => {
    const { app, registered } = makeFakeApp();
    const routes = new ServerV1PostgresRoutes({ pool: pool(), queueManager: queue() } as any);
    routes.setupRoutes(app as any);
    const reg = registered.find(r => r.method === 'delete' && r.path === '/v1/projects/:projectId/memory')!;
    // The role guard is the middleware whose probe denies member + allows admin.
    const results = reg.chain.map(probeRole);
    const hasAdminGate = results.some(r => r.deniedMember && r.allowedAdmin);
    expect(hasAdminGate).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/routes/v1/purge-role-gating.test.ts`
Expected: FAIL — the current gate is `requireWriteRole()`, which ALLOWS member (member is ≥member), so no middleware denies member + allows admin → `hasAdminGate` is false.

- [ ] **Step 3: Swap the guard**

At ~1287 change only the middleware:
```ts
    app.delete('/v1/projects/:projectId/memory', writeAuth, requireRole('admin'), this.asyncHandler(async (req, res) => {
```
(body unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/server/routes/v1/purge-role-gating.test.ts`
Expected: PASS.

- [ ] **Step 5: Reconcile the C4 wiring test (REQUIRED — it WILL break otherwise)**

The C4 test `tests/server/routes/v1/write-role-gating.test.ts` asserts `requireWriteRole` is applied to **8 content-mutating routes**, and its route list **includes** `{ method: 'delete', path: '/v1/projects/:projectId/memory' }` (verified at line ~109). Bumping that route to `requireRole('admin')` removes `requireWriteRole` from it, so this assertion will fail. This is an intentional, expected reconciliation — the purge route is now gated *more* strongly (admin still denies viewer, preserving the security intent).

Update that test:
- Change the count from **8 → 7** content-mutating routes (in the assertion and the `it(...)` title/comment referencing "8 content-mutating routes").
- Remove the `{ method: 'delete', path: '/v1/projects/:projectId/memory' }` entry from the `requireWriteRole` route list.
- Do NOT weaken any other assertion; the other 7 routes keep `requireWriteRole`.

Run: `bun test tests/server/routes/v1/write-role-gating.test.ts`
Expected: PASS (now asserting 7 routes). Document the 8→7 reconciliation in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts \
        tests/server/routes/v1/purge-role-gating.test.ts \
        tests/server/routes/v1/write-role-gating.test.ts
git commit -m "feat(v1): gate project-memory purge on >=admin (mass-destructive op)

Reconciles the C4 wiring test 8->7 content-mutating routes: the purge route
now carries requireRole('admin') (strictly stronger than requireWriteRole).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Reusable null-owner backfill script

**Files:**
- Create: `scripts/backfill-attribution.mjs`
- Test: `tests/scripts/backfill-attribution.test.ts`

**Interfaces:**
- Consumes: `pg` module; env `OWNER_USER_ID`, `TEAM_ID`, `PROJECT_ID?`, `PG_URL`; arg `--execute`.
- Produces: an executable script; and an exported pure function for the row-selection/update SQL so it can be unit-tested without a live DB.

**Design note:** to keep the script testable without a running Postgres, factor the SQL builders into pure exported functions and unit-test those; the script's `main()` wires them to a real client. This mirrors how other scripts keep a thin `main()` over testable pieces.

- [ ] **Step 1: Write the failing test (pure SQL-builder assertions)**

```ts
// tests/scripts/backfill-attribution.test.ts
import { describe, it, expect } from 'bun:test';
import { buildCountSql, buildUpdateSql, parseConfig } from '../../scripts/backfill-attribution.mjs';

describe('backfill-attribution config + SQL', () => {
  it('requires OWNER_USER_ID and TEAM_ID', () => {
    expect(() => parseConfig({ TEAM_ID: 't' }, [])).toThrow(/OWNER_USER_ID/);
    expect(() => parseConfig({ OWNER_USER_ID: 'o' }, [])).toThrow(/TEAM_ID/);
  });
  it('defaults to dry-run; --execute flips it', () => {
    expect(parseConfig({ OWNER_USER_ID: 'o', TEAM_ID: 't' }, []).execute).toBe(false);
    expect(parseConfig({ OWNER_USER_ID: 'o', TEAM_ID: 't' }, ['--execute']).execute).toBe(true);
  });
  it('count SQL scopes to team; adds project clause only when PROJECT_ID set', () => {
    const teamOnly = buildCountSql(false);
    expect(teamOnly).toMatch(/team_id = \$1/);
    expect(teamOnly).not.toMatch(/project_id/);
    const withProj = buildCountSql(true);
    expect(withProj).toMatch(/project_id = \$2/);
  });
  it("update SQL only touches null-owner rows and never overwrites an existing owner", () => {
    const sql = buildUpdateSql(false);
    expect(sql).toMatch(/metadata->>'createdByUserId' IS NULL/);
    expect(sql).toMatch(/jsonb_set/);
    expect(sql).not.toMatch(/DELETE/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/scripts/backfill-attribution.test.ts`
Expected: FAIL — module `scripts/backfill-attribution.mjs` does not exist.

- [ ] **Step 3: Write the script**

```js
// scripts/backfill-attribution.mjs
// SPDX-License-Identifier: Apache-2.0
// Bind null-owner observations (metadata.createdByUserId IS NULL) to a target
// owner userId. One-time, idempotent, REUSABLE across projects.
//
// PRECONDITION (operator's judgment — NOT checked by this script): binding all
// null-owner rows to a single owner is correct ONLY when that owner is the sole
// author of the scoped history. True for the dogfood project now; confirm true
// for any other project before running it there.
//
// Usage (run under bun, against the target runtime's PG):
//   bun scripts/backfill-attribution.mjs            # DRY-RUN: count + sample, NO write
//   bun scripts/backfill-attribution.mjs --execute  # bind null-owner rows to OWNER_USER_ID
//
// Env:
//   OWNER_USER_ID  (required)  userId to bind null-owner rows to
//   TEAM_ID        (required)  scope to one team
//   PROJECT_ID     (optional)  further scope to one project; omit = whole team
//   PG_URL         default postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres
import pg from 'pg';

export function parseConfig(env, argv) {
  const OWNER_USER_ID = env.OWNER_USER_ID;
  const TEAM_ID = env.TEAM_ID;
  if (!OWNER_USER_ID) throw new Error('OWNER_USER_ID is required');
  if (!TEAM_ID) throw new Error('TEAM_ID is required');
  return {
    ownerUserId: OWNER_USER_ID,
    teamId: TEAM_ID,
    projectId: env.PROJECT_ID || null,
    pgUrl: env.PG_URL || 'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres',
    execute: argv.includes('--execute'),
  };
}

// $1 team_id [, $2 project_id]
export function buildCountSql(hasProject) {
  return hasProject
    ? `SELECT kind, count(*)::int AS n FROM observations
         WHERE team_id = $1 AND project_id = $2 AND metadata->>'createdByUserId' IS NULL
         GROUP BY kind`
    : `SELECT kind, count(*)::int AS n FROM observations
         WHERE team_id = $1 AND metadata->>'createdByUserId' IS NULL
         GROUP BY kind`;
}

// $1 owner_user_id, $2 team_id [, $3 project_id]
export function buildUpdateSql(hasProject) {
  return hasProject
    ? `UPDATE observations
          SET metadata = jsonb_set(metadata, '{createdByUserId}', to_jsonb($1::text), true),
              updated_at = now()
        WHERE team_id = $2 AND project_id = $3 AND metadata->>'createdByUserId' IS NULL`
    : `UPDATE observations
          SET metadata = jsonb_set(metadata, '{createdByUserId}', to_jsonb($1::text), true),
              updated_at = now()
        WHERE team_id = $2 AND metadata->>'createdByUserId' IS NULL`;
}

async function main() {
  const cfg = parseConfig(process.env, process.argv.slice(2));
  const hasProject = cfg.projectId != null;
  const client = new pg.Client({ connectionString: cfg.pgUrl });
  await client.connect();
  try {
    const countParams = hasProject ? [cfg.teamId, cfg.projectId] : [cfg.teamId];
    const before = await client.query(buildCountSql(hasProject), countParams);
    const total = before.rows.reduce((s, r) => s + r.n, 0);
    console.log(`[backfill] scope team=${cfg.teamId}${hasProject ? ` project=${cfg.projectId}` : ''}`);
    console.log(`[backfill] null-owner rows: ${total}`, JSON.stringify(before.rows));

    // Sample up to 5 for eyeballing.
    const sample = await client.query(
      hasProject
        ? `SELECT id, kind, left(content, 80) AS preview FROM observations
             WHERE team_id = $1 AND project_id = $2 AND metadata->>'createdByUserId' IS NULL LIMIT 5`
        : `SELECT id, kind, left(content, 80) AS preview FROM observations
             WHERE team_id = $1 AND metadata->>'createdByUserId' IS NULL LIMIT 5`,
      countParams,
    );
    for (const r of sample.rows) console.log(`  - ${r.id} [${r.kind}] ${r.preview}`);

    if (!cfg.execute) {
      console.log('[backfill] DRY-RUN — no rows written. Re-run with --execute to apply.');
      return;
    }
    const updateParams = hasProject ? [cfg.ownerUserId, cfg.teamId, cfg.projectId] : [cfg.ownerUserId, cfg.teamId];
    const res = await client.query(buildUpdateSql(hasProject), updateParams);
    const after = await client.query(buildCountSql(hasProject), countParams);
    const remaining = after.rows.reduce((s, r) => s + r.n, 0);
    console.log(`[backfill] bound ${res.rowCount} rows to owner=${cfg.ownerUserId}; null-owner remaining: ${remaining}`);
  } finally {
    await client.end();
  }
}

// Only run main() when invoked directly (not when imported by the test).
if (import.meta.main) {
  main().catch((e) => { console.error('[backfill] ERROR', e.message); process.exit(1); });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/scripts/backfill-attribution.test.ts`
Expected: PASS (4 tests). `import.meta.main` guard ensures importing the module for the test does not execute `main()`.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-attribution.mjs tests/scripts/backfill-attribution.test.ts
git commit -m "feat(scripts): reusable null-owner attribution backfill (dry-run default, idempotent)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Full-suite check + branch typecheck

**Files:** none (verification task)

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json` (or the repo's `src` typecheck script if different — check `package.json`)
Expected: no errors.

- [ ] **Step 2: Run the touched test set**

Run:
```bash
bun test tests/server/routes/v1/delete-authorization.test.ts \
         tests/server/routes/v1/ownership-delete.test.ts \
         tests/server/routes/v1/purge-role-gating.test.ts \
         tests/server/routes/v1/write-role-gating.test.ts \
         tests/scripts/backfill-attribution.test.ts \
         tests/server/data-deletion.test.ts
```
Expected: all green.

- [ ] **Step 3: Run the broader server suite to catch regressions**

Run: `bun test tests/server/`
Expected: green (or pre-existing failures unrelated to this branch — record any in the ledger for the final review).

- [ ] **Step 4: No commit** — this is a gate. If anything fails, return to the owning task.

---

## Self-Review

**Spec coverage:**
- Ownership rule (member own-notes-only, admin+ any, null-role allow, viewer denied upstream) → Task 1 (helper) + Task 3 (wiring). ✅
- Distinct 403 reasons (`wrong_kind` / `wrong_owner`) → Task 1 + Task 3 messages/tests. ✅
- Fetch-before-delete (404 if absent) → Task 2 + Task 3. ✅
- Bulk-purge ≥admin → Task 4. ✅
- Reusable parameterized backfill (dry-run default, idempotent, IS NULL guard, counts by kind, owner+team required, project optional) → Task 5. ✅
- No read/search regression → Task 6 broad suite; reads untouched by design. ✅
- Branch / trailer / no-push / rollback → Global Constraints. ✅

**Placeholder scan:** all steps carry concrete code, SQL, commands, and expected output. No TBD/TODO. ✅

**Type consistency:** `DeletableRow`/`DeleteDecision`/`authorizeObservationDelete` signatures identical in Task 1 and consumed unchanged in Task 3. `getObservationForDelete` return type `{ kind; createdByUserId }` matches `DeletableRow`. Script exports (`parseConfig`, `buildCountSql`, `buildUpdateSql`) match Task 5 test imports. ✅

**Known reconciliation flagged (not a placeholder):** Task 4 Step 5 explicitly calls out that the C4 wiring test (`write-role-gating.test.ts`) may assert `requireWriteRole` on the purge route; if so its expectation must be updated to reflect the intentional bump to `requireRole('admin')`. The implementer is told exactly what to check and how to reconcile.
