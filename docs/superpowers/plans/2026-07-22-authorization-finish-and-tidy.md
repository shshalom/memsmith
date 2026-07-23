# Authorization Finish + Tidy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Role-gate the two remaining unguarded mutating route groups (job control → ≥member, key-mint → ≥admin), extract the duplicated observation-scope predicate into one helper, and wrap the backfill's execute path in a transaction.

**Architecture:** Two middleware additions on existing routes (mirroring the C4 / purge idioms), one behavior-preserving private-helper extraction with its consumers rewired, and one transaction wrap in a standalone script. All local-buildable, no new runtime deps.

**Tech Stack:** TypeScript, Express, Postgres, `bun test`, `pg` module.

## Global Constraints

- **Never commit to `main`;** work on branch `authorization-finish-and-tidy` (already created; spec committed @ `d6e3abf4`). Rollback point: `main` @ `942d3a1d`.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Nothing pushed** (local only). Final merge `--no-ff` recording the rollback SHA.
- `requireWriteRole`, `requireRole`, `roleSatisfies` are ALL already imported into `ServerV1PostgresRoutes.ts` (line 22). Do not re-import.
- **Null-role rule (intended asymmetry):** job control allows null-role (C4 back-compat via `requireWriteRole`); key-mint DENIES null-role (`requireRole('admin')` → `roleSatisfies(null,'admin')` is false). Both are correct per spec.
- **Piece 3 is behavior-preserving.** `ownership-delete.test.ts` (6) + `data-deletion.test.ts` must stay green.
- **Private-helper test idiom:** reach private methods via `(routes as any).method(...)` — the repo's existing convention (see `ownership-delete.test.ts`). Do NOT change method visibility or export it.
- **Test runner:** `bun test <path>`. Known-benign: `bun:test`/`.js`/`.mjs`/`declared-but-never-read`/`ZodTypeAny` TS editor diagnostics are false-positives; the passing `bun test` run is authoritative. 5 pre-existing `tests/server/` failures are environmental (`ECONNREFUSED :55432`, no live PG) — not this branch's concern.

---

### Task 1: Job-control role gate + wiring-test reconciliation

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (routes ~737, ~756)
- Modify: `tests/server/routes/v1/write-role-gating.test.ts` (count 7→9, add 2 routes)

**Interfaces:**
- Consumes: `writeAuth`, `requireWriteRole()` (already imported/used).
- Produces: `/v1/jobs/:id/retry` and `/v1/jobs/:id/cancel` each carrying `requireWriteRole()` after `writeAuth`.

- [ ] **Step 1: Update the C4 wiring test to expect the 2 new routes (failing first)**

In `tests/server/routes/v1/write-role-gating.test.ts`:
- Change the header comment and `it(...)` title from "7 content-mutating routes" to "9 content-mutating routes".
- Add to the `writePaths` array:
```ts
      { method: 'post', path: '/v1/jobs/:id/retry' },
      { method: 'post', path: '/v1/jobs/:id/cancel' },
```
- Leave the `/v1/search` negative assertion untouched.

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `bun test tests/server/routes/v1/write-role-gating.test.ts`
Expected: FAIL — the two job routes do not yet carry `requireWriteRole` (they are `writeAuth`-only), so the fingerprint (deny viewer / allow null) won't match on them.

- [ ] **Step 3: Add the guard to both job routes**

In `ServerV1PostgresRoutes.ts`, insert `requireWriteRole()` between `writeAuth` and the handler:
```ts
app.post('/v1/jobs/:id/retry',  writeAuth, requireWriteRole(), this.asyncHandler(/* body unchanged */));
app.post('/v1/jobs/:id/cancel', writeAuth, requireWriteRole(), this.asyncHandler(/* body unchanged */));
```
Do not alter the handler bodies.

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `bun test tests/server/routes/v1/write-role-gating.test.ts`
Expected: PASS (now asserting 9 routes).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/routes/v1/write-role-gating.test.ts
git commit -m "feat(v1): gate job control (retry/cancel) on >=member; reconcile wiring test 7->9

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Key-mint admin gate

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (route ~245)
- Test: `tests/server/routes/v1/keys-role-gating.test.ts`

**Interfaces:**
- Consumes: `writeAuth`, `requireRole('admin')` (already imported), the fake-app harness idiom from `purge-role-gating.test.ts`.
- Produces: `POST /v1/keys` gated by `requireRole('admin')` after `writeAuth`.

- [ ] **Step 1: Write the failing test (mirror purge-role-gating.test.ts)**

```ts
// tests/server/routes/v1/keys-role-gating.test.ts
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

// requireRole('admin'): denies member (403), allows admin (next).
function probeAdmin(fn: RequestHandler) {
  let deniedMember = false, allowedAdmin = false;
  const memReq = { authContext: { role: 'member' } } as unknown as Request;
  const memRes = { status(c: number) { if (c === 403) deniedMember = true; return this; }, json() { return this; } } as unknown as Response;
  fn(memReq, memRes, () => {});
  const admReq = { authContext: { role: 'admin' } } as unknown as Request;
  const admRes = { status() { return this; }, json() { return this; } } as unknown as Response;
  fn(admReq, admRes, () => { allowedAdmin = true; });
  return { deniedMember, allowedAdmin };
}

describe('key-mint role gating', () => {
  it('POST /v1/keys requires >=admin (member denied, admin allowed)', () => {
    const { app, registered } = makeFakeApp();
    const routes = new ServerV1PostgresRoutes({ pool: pool(), queueManager: queue() } as any);
    routes.setupRoutes(app as any);
    const reg = registered.find(r => r.method === 'post' && r.path === '/v1/keys')!;
    const hasAdminGate = reg.chain.map(probeAdmin).some(r => r.deniedMember && r.allowedAdmin);
    expect(hasAdminGate).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `bun test tests/server/routes/v1/keys-role-gating.test.ts`
Expected: FAIL — the route currently has `writeAuth` only (allows member), so no middleware denies member + allows admin.

- [ ] **Step 3: Add the guard**

In `ServerV1PostgresRoutes.ts` at `POST /v1/keys` (~245):
```ts
app.post('/v1/keys', writeAuth, requireRole('admin'), this.handleCreate(/* unchanged */));
```
Insert `requireRole('admin')` between `writeAuth` and `this.handleCreate(...)`. Handler body unchanged.

- [ ] **Step 4: Run the test to verify it PASSES**

Run: `bun test tests/server/routes/v1/keys-role-gating.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/routes/v1/keys-role-gating.test.ts
git commit -m "feat(v1): gate key minting (POST /v1/keys) on >=admin

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Extract `observationScope` predicate (behavior-preserving)

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (`getObservationForDelete` ~1914, `deleteObservationForScope` ~1934, new helper beside them)
- Test: `tests/server/routes/v1/observation-scope.test.ts`

**Interfaces:**
- Produces: `private observationScope(id: string, teamId: string, projectScope: string | null): { where: string; params: unknown[] }`
- Consumed by: `getObservationForDelete` (SELECT) and `deleteObservationForScope` team branch (raw DELETE).

- [ ] **Step 1: Write the failing unit test (private via `as any`)**

```ts
// tests/server/routes/v1/observation-scope.test.ts
import { describe, it, expect } from 'bun:test';
import { ServerV1PostgresRoutes } from '../../../../src/server/routes/v1/ServerV1PostgresRoutes.js';

function routes() {
  return new ServerV1PostgresRoutes({
    pool: { query: async () => ({ rows: [] }), connect: async () => ({}) },
    queueManager: { getQueue: () => null, resolveQueue: () => null },
  } as any);
}

describe('observationScope predicate', () => {
  it('project-scoped: id + team + project, 3 params', () => {
    const r = (routes() as any).observationScope('obs1', 'team1', 'proj1');
    expect(r.where).toBe('id = $1 AND team_id = $2 AND project_id = $3');
    expect(r.params).toEqual(['obs1', 'team1', 'proj1']);
  });
  it('team-scoped (null project): id + team, 2 params', () => {
    const r = (routes() as any).observationScope('obs1', 'team1', null);
    expect(r.where).toBe('id = $1 AND team_id = $2');
    expect(r.params).toEqual(['obs1', 'team1']);
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `bun test tests/server/routes/v1/observation-scope.test.ts`
Expected: FAIL — `observationScope` is not a function yet.

- [ ] **Step 3: Add the helper and rewire both consumers**

Add the helper beside `getObservationForDelete`:
```ts
// Single source of the scoped-observation predicate shared by the scoped delete
// and its authorization read: a project-scoped key is confined to its project;
// a team-scoped key spans the team. Positional WHERE + params so a SELECT and a
// DELETE build on it identically.
private observationScope(
  id: string, teamId: string, projectScope: string | null,
): { where: string; params: unknown[] } {
  return projectScope != null
    ? { where: 'id = $1 AND team_id = $2 AND project_id = $3', params: [id, teamId, projectScope] }
    : { where: 'id = $1 AND team_id = $2', params: [id, teamId] };
}
```

Rewrite `getObservationForDelete` to use it:
```ts
private async getObservationForDelete(
  id: string, teamId: string, projectScope: string | null,
): Promise<{ kind: string; createdByUserId: string | null } | null> {
  const { where, params } = this.observationScope(id, teamId, projectScope);
  const result = await this.options.pool.query(
    `SELECT kind, metadata->>'createdByUserId' AS created_by_user_id FROM observations WHERE ${where}`,
    params,
  );
  const row = result.rows[0] as { kind: string; created_by_user_id: string | null } | undefined;
  if (!row) return null;
  return { kind: row.kind, createdByUserId: row.created_by_user_id };
}
```

Rewrite `deleteObservationForScope`'s TEAM branch to use it (project branch unchanged — it delegates to the repository which scopes id+project+team internally; add the one-line comment):
```ts
private async deleteObservationForScope(
  id: string, teamId: string, projectScope: string | null,
): Promise<boolean> {
  const deletion = new PostgresDataDeletionRepository(this.options.pool);
  if (projectScope) {
    // project branch scopes id + project + team inside the repository — aligned
    // with observationScope's project case by construction.
    return deletion.deleteObservation({ id, projectId: projectScope, teamId });
  }
  const { where, params } = this.observationScope(id, teamId, null);
  const byTeam = await this.options.pool.query(`DELETE FROM observations WHERE ${where}`, params);
  return (byTeam.rowCount ?? 0) > 0;
}
```

- [ ] **Step 4: Run the unit test to verify it PASSES**

Run: `bun test tests/server/routes/v1/observation-scope.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the regression net (behavior unchanged)**

Run: `bun test tests/server/routes/v1/ownership-delete.test.ts tests/server/data-deletion.test.ts`
Expected: ownership-delete PASS (6). data-deletion: PASS, OR its pre-existing `:55432`-env failures unchanged from baseline (record which, do not "fix"). The point: no NEW failures vs. before this task.

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/routes/v1/observation-scope.test.ts
git commit -m "refactor(v1): extract observationScope predicate shared by scoped delete + auth read

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Backfill transaction

**Files:**
- Modify: `scripts/backfill-attribution.mjs` (`main()` execute path)
- Test: `tests/scripts/backfill-attribution.test.ts` (unchanged pure builders still asserted; no live-DB test)

**Interfaces:**
- No exported-signature change. `buildCountSql`, `buildUpdateSql`, `parseConfig` unchanged.

- [ ] **Step 1: Confirm the existing test still passes (baseline)**

Run: `bun test tests/scripts/backfill-attribution.test.ts`
Expected: PASS (4). The transaction lives in `main()` (not the pure builders), so these tests are unaffected — they are the guardrail that the refactor doesn't touch the builders.

- [ ] **Step 2: Wrap the execute path in a transaction**

In `main()`, replace the current execute block:
```js
    const updateParams = hasProject ? [cfg.ownerUserId, cfg.teamId, cfg.projectId] : [cfg.ownerUserId, cfg.teamId];
    const res = await client.query(buildUpdateSql(hasProject), updateParams);
    const after = await client.query(buildCountSql(hasProject), countParams);
    const remaining = after.rows.reduce((s, r) => s + r.n, 0);
    console.log(`[backfill] bound ${res.rowCount} rows to owner=${cfg.ownerUserId}; null-owner remaining: ${remaining}`);
```
with:
```js
    const updateParams = hasProject ? [cfg.ownerUserId, cfg.teamId, cfg.projectId] : [cfg.ownerUserId, cfg.teamId];
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
The dry-run early-return above this block is unchanged (read-only, no transaction).

- [ ] **Step 3: Run the test to confirm no builder regression**

Run: `bun test tests/scripts/backfill-attribution.test.ts`
Expected: PASS (4) — builders untouched.

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-attribution.mjs
git commit -m "fix(scripts): wrap backfill execute path in a transaction (consistent count/remaining)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Gate — typecheck + full touched suite

**Files:** none (verification).

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 2: Touched test set**

Run:
```bash
bun test tests/server/routes/v1/write-role-gating.test.ts \
         tests/server/routes/v1/keys-role-gating.test.ts \
         tests/server/routes/v1/observation-scope.test.ts \
         tests/server/routes/v1/ownership-delete.test.ts \
         tests/server/routes/v1/purge-role-gating.test.ts \
         tests/server/routes/v1/delete-authorization.test.ts \
         tests/scripts/backfill-attribution.test.ts
```
Expected: all green.

- [ ] **Step 3: Broader server suite (regression)**

Run: `bun test tests/server/`
Expected: green modulo the known 5 pre-existing `:55432` env failures (EmbeddedPostgresManager lifecycle ×2, costPanel real savings, SettingsStore, /v1/settings). Any NEW failure → return to the owning task.

- [ ] **Step 4: No commit** — gate only.

---

## Self-Review

**Spec coverage:**
- Job-control ≥member gate → Task 1. ✅
- Key-mint ≥admin gate → Task 2. ✅
- observationScope extraction (behavior-preserving) → Task 3. ✅
- Backfill transaction → Task 4. ✅
- Wiring reconciliation 7→9 → Task 1 (Steps 1–4). ✅
- Gate → Task 5. ✅

**Placeholder scan:** every step has concrete code, commands, expected output. No TBD. The "body unchanged" notes refer to existing handler bodies the implementer must not touch — explicit, not a placeholder.

**Type consistency:** `observationScope` signature `{ where: string; params: unknown[] }` is identical in the helper, its two consumers, and the unit test. `getObservationForDelete`'s return type `{ kind; createdByUserId } | null` is unchanged from its current definition. Guard names (`requireWriteRole()`, `requireRole('admin')`) match their imports.

**Ordering note:** Task 1 both adds guards AND reconciles the wiring test in the same task (they must land together or the suite breaks) — correct per the skill's task-right-sizing (a reviewer can't approve one without the other).
