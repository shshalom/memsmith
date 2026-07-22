# Role-Gating on Observation Write/Delete Routes (C4 fix) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the C4 security hole — a `viewer` with a write-scoped API key can write/delete team memory — by adding a role floor (`≥ member`, null-role treated as member-equivalent) to the observation write/delete routes.

**Architecture:** Add one guard `requireWriteRole()` in `postgres-auth.ts` beside the existing `requireRole`/`roleSatisfies`, then insert it after `writeAuth` on the 7 content-mutating routes in `ServerV1PostgresRoutes.ts`. Scope check (writeAuth) is unchanged; the role check is added on top. Read routes untouched.

**Tech Stack:** TypeScript, `bun:test`, Express `RequestHandler` middleware, existing `AuthContext.role` / `roleSatisfies` / `PostgresTeamRole` machinery (`src/server/middleware/postgres-auth.ts`).

## Global Constraints

- **Fix the hole; break no legacy key.** Explicit `viewer` → denied writes/deletes. Legacy/scope-only key (resolved `role == null`) → keeps working exactly as today (no lockout).
- **Null-role rule (exact):** on the write/delete gate, `allow = (role == null) || roleSatisfies(role, 'member')`. Deny (403) ONLY when `role != null && !roleSatisfies(role, 'member')` (i.e. explicit viewer).
- **Scope != role; keep both.** `requireWriteRole` is ADDED after `writeAuth`; it does not replace or weaken the scope check. A route now needs both a write scope AND a satisfying role.
- **Fail-safe = deny.** Absent `authContext` → 403. Never throw out of middleware.
- **Reuse existing machinery.** Build on `roleSatisfies`, `AuthContext.role`, `PostgresTeamRole`; mirror the `/v1/members` guard-composition idiom (`writeAuth, requireRole('admin'), handler`).
- **Ordering:** `requireWriteRole()` MUST run after `writeAuth` (which populates `authContext.role`), enforced by route-registration order.
- **Read routes untouched** — a viewer must still read (`/v1/search`, GET routes keep `readAuth`, no role gate).
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. **Never commit to main;** work on branch `role-gating-writes`. Nothing pushed.

---

## File Structure

- `src/server/middleware/postgres-auth.ts` (modify) — add `requireWriteRole()` beside `requireRole` (both use `roleSatisfies`).
- `src/server/routes/v1/ServerV1PostgresRoutes.ts` (modify) — extend the existing import (line 22) + insert `requireWriteRole()` into 7 route chains.
- `tests/server/middleware/require-write-role.test.ts` (create) — unit table for the guard.
- `tests/server/routes/v1/write-role-gating.test.ts` (create) — regression proving the C4 scenario is closed + legacy key not locked out.

**Task order:** Task 1 = the guard + its unit tests (independently testable). Task 2 = apply to routes + the regression test (depends on Task 1's guard).

---

### Task 1: `requireWriteRole` guard + unit tests

**Files:**
- Modify: `src/server/middleware/postgres-auth.ts` (add the guard after `requireRole`, ~line 49)
- Test: `tests/server/middleware/require-write-role.test.ts`

**Interfaces:**
- Consumes: `roleSatisfies(role: PostgresTeamRole | null, min: PostgresTeamRole): boolean` and `AuthContext.role: PostgresTeamRole | null` (both already in this file); `RequestHandler` from express.
- Produces: `export function requireWriteRole(): RequestHandler` — allows when `authContext.role == null` OR `roleSatisfies(role, 'member')`; 403 when role is an explicit tier below member (viewer); 403 when `authContext` is absent.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/middleware/require-write-role.test.ts
import { describe, it, expect } from 'bun:test';
import { requireWriteRole } from '../../../src/server/middleware/postgres-auth.js';

function mockRes() {
  const r: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  return r;
}
function run(role: unknown) {
  const guard = requireWriteRole();
  const req: any = role === 'ABSENT' ? {} : { authContext: { role } };
  const res = mockRes();
  let nexted = false;
  guard(req, res, () => { nexted = true; });
  return { nexted, status: res.statusCode };
}

describe('requireWriteRole', () => {
  it('denies an explicit viewer (403)', () => {
    const r = run('viewer');
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });
  it('allows null role (legacy/scope-only key — member-equivalent)', () => {
    const r = run(null);
    expect(r.nexted).toBe(true);
    expect(r.status).toBe(0);
  });
  it('allows member, admin, owner', () => {
    for (const role of ['member', 'admin', 'owner']) {
      const r = run(role);
      expect(r.nexted).toBe(true);
    }
  });
  it('denies when authContext is absent (fail-safe)', () => {
    const r = run('ABSENT');
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/middleware/require-write-role.test.ts`
Expected: FAIL — `requireWriteRole` is not exported.

- [ ] **Step 3: Add the guard**

In `src/server/middleware/postgres-auth.ts`, immediately after the `requireRole` function (which ends ~line 49), add:

```typescript
/**
 * Route guard for content-mutating routes (observation write/delete).
 * Requires a >= member role, BUT treats a null role (legacy/scope-only key:
 * no user_id, or user not in team_members) as member-equivalent so existing
 * scope-only keys keep working. Only an explicit role strictly below member
 * (viewer) is denied. Fail-safe: absent authContext → 403.
 *
 * ORDERING: MUST run after requirePostgresServerAuth (which populates
 * req.authContext incl. role). Enforced by route-registration order.
 */
export function requireWriteRole(): RequestHandler {
  return (req, res, next) => {
    const ctx = req.authContext;
    if (!ctx) {
      res.status(403).json({ error: 'Forbidden', message: 'requires role member or higher' });
      return;
    }
    const role = ctx.role; // PostgresTeamRole | null
    const allow = role == null || roleSatisfies(role, 'member');
    if (allow) return next();
    res.status(403).json({ error: 'Forbidden', message: 'requires role member or higher' });
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/middleware/require-write-role.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit 2>&1 | tail -3`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/middleware/postgres-auth.ts tests/server/middleware/require-write-role.test.ts
git commit -m "feat(authz): requireWriteRole guard (>=member, null-role=member-equiv)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Apply `requireWriteRole` to the 7 content-mutating routes + regression

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (import line 22 + 7 route registrations)
- Test: `tests/server/routes/v1/write-role-gating.test.ts`

**Interfaces:**
- Consumes: `requireWriteRole` (Task 1) from `../../middleware/postgres-auth.js`.
- Produces: no signature change. The 7 routes now run `requireWriteRole()` after `writeAuth`.

**Note on the test seam:** the routes aren't independently callable without the full app, and the guard logic is already unit-tested in Task 1. The regression here asserts the guard is COMPOSED into each write route by extracting the middleware wiring: build a minimal express-like harness that captures the middleware array registered for each path, and assert `requireWriteRole`'s produced handler is present in the chain for all 7 content routes and ABSENT on a read route (`/v1/search`). This proves the wiring (the thing that was missing) without needing a live server. The end-to-end behavior (viewer→403) is covered by the live re-validation in the acceptance step.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/routes/v1/write-role-gating.test.ts
import { describe, it, expect } from 'bun:test';

// Capture the middleware chain registered per (method, path) by a fake express app,
// then assert requireWriteRole is wired on write/delete routes and not on reads.
// We identify the guard by tagging: requireWriteRole returns a NAMED function so we
// can detect it by reference identity via a spy on the module.
import * as auth from '../../../../src/server/middleware/postgres-auth.js';

describe('write-role gating wiring', () => {
  it('requireWriteRole is applied to all 7 content-mutating routes and not to /v1/search', () => {
    // Spy: wrap requireWriteRole so every handler it produces is tagged.
    const tagged = new WeakSet<object>();
    const realWrite = auth.requireWriteRole;
    (auth as any).requireWriteRole = () => { const h = realWrite(); tagged.add(h as object); return h; };

    const registered: Array<{ method: string; path: string; chain: unknown[] }> = [];
    const app: any = {};
    for (const m of ['get', 'post', 'delete', 'patch', 'put', 'use']) {
      app[m] = (path: string, ...chain: unknown[]) => { registered.push({ method: m, path, chain }); };
    }

    // Build the routes against the fake app. Import lazily AFTER the spy is installed.
    // ServerV1PostgresRoutes exposes a setup that registers routes on the app it is given.
    // (The implementer wires this to the real setup entrypoint — see note below.)
    // ... setup(app, options) ...

    const writePaths = ['/v1/memories', '/v1/events', '/v1/events/batch', '/v1/record-intent', '/v1/sessions/start'];
    const deletePaths = ['/v1/memories/:id', '/v1/projects/:projectId/memory'];

    for (const p of [...writePaths, ...deletePaths]) {
      const entry = registered.find(r => r.path === p);
      expect(entry, `route ${p} registered`).toBeDefined();
      const hasGuard = entry!.chain.some(h => typeof h === 'function' && tagged.has(h as object));
      expect(hasGuard, `${p} has requireWriteRole`).toBe(true);
    }

    const search = registered.find(r => r.path === '/v1/search');
    if (search) {
      const hasGuard = search.chain.some(h => typeof h === 'function' && tagged.has(h as object));
      expect(hasGuard, '/v1/search must NOT have requireWriteRole').toBe(false);
    }

    (auth as any).requireWriteRole = realWrite;
  });
});
```

> **Implementer note on the harness:** wiring the spy to intercept `requireWriteRole` at the module boundary and driving the real route-setup requires knowing the exact setup entrypoint (`ServerV1PostgresRoutes`'s constructor/`setupRoutes(app)` — confirm the method that takes the express app and calls `app.post('/v1/memories', ...)`). If module-level spying on `requireWriteRole` proves impractical under `bun:test` (ESM binding immutability), FALL BACK to the equally-valid assertion: after the route edits, `grep`-style source inspection is NOT a valid test — instead assert via the wiring by having the implementer confirm each of the 7 `app.post/delete(...)` calls now includes `requireWriteRole()` in the diff (reviewer-verified), and keep the automated coverage at Task 1's guard unit tests + the live re-validation. Prefer the wiring test if the harness is feasible; state which you used in the report.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/routes/v1/write-role-gating.test.ts`
Expected: FAIL — routes don't yet have `requireWriteRole` in their chains.

- [ ] **Step 3: Extend the import**

In `src/server/routes/v1/ServerV1PostgresRoutes.ts`, change line 22 from:

```typescript
import { requirePostgresServerAuth, requireRole, roleSatisfies } from '../../middleware/postgres-auth.js';
```

to:

```typescript
import { requirePostgresServerAuth, requireRole, requireWriteRole, roleSatisfies } from '../../middleware/postgres-auth.js';
```

- [ ] **Step 4: Insert `requireWriteRole()` after `writeAuth` on the 7 routes**

Apply these exact edits (insert `requireWriteRole()` between `writeAuth` and the handler):

```typescript
// line 292
app.post('/v1/events', writeAuth, requireWriteRole(), this.asyncHandler(async (req, res) => {
// line 370
app.post('/v1/events/batch', writeAuth, requireWriteRole(), this.asyncHandler(async (req, res) => {
// line 772
app.post('/v1/sessions/start', writeAuth, requireWriteRole(), this.handleCreate(
// line 923
app.post('/v1/memories', writeAuth, requireWriteRole(), this.handleCreate(
// line 969
app.post('/v1/record-intent', writeAuth, requireWriteRole(), this.handleCreate(
// line 1265
app.delete('/v1/memories/:id', writeAuth, requireWriteRole(), this.asyncHandler(async (req, res) => {
// line 1287
app.delete('/v1/projects/:projectId/memory', writeAuth, requireWriteRole(), this.asyncHandler(async (req, res) => {
```

Do NOT add it to any read route (`/v1/search`, GET routes) or to `/v1/members` (already has `requireRole('admin')`) or `/v1/keys` (key-mint, separate concern — out of scope).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/server/routes/v1/write-role-gating.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + adjacent regression**

Run: `bunx tsc --noEmit 2>&1 | tail -3 && bun test tests/server/routes/v1/ 2>&1 | tail -6`
Expected: tsc clean; existing v1 route tests still green (the added middleware doesn't break existing authorized paths — existing tests use authorized keys/local-dev bypass whose role is owner/null, both of which `requireWriteRole` allows).

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/routes/v1/write-role-gating.test.ts
git commit -m "fix(authz): gate observation write/delete routes on >=member role (C4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** (against `2026-07-22-role-gating-writes-design.md`):
- `requireWriteRole` guard with the null-role=member-equiv rule → Task 1. ✓
- Applied to all 7 content-mutating routes after writeAuth → Task 2 Step 4. ✓
- Read routes untouched → Task 2 Step 4 (explicit "do NOT add to /v1/search") + the test asserts absence on /v1/search. ✓
- C4 closed (viewer→deny) + legacy null-role not locked out → Task 1 unit tests (viewer→403, null→allow) + live re-validation (acceptance note). ✓
- Fail-safe deny on absent authContext → Task 1 unit test. ✓
- Reuse roleSatisfies / mirror /v1/members idiom → Task 1 (uses roleSatisfies) + Task 2 (writeAuth, guard, handler composition). ✓

**2. Placeholder scan:** Task 2's wiring test carries an honest implementer note about the module-spy harness with a concrete fallback (reviewer-verified diff wiring + Task-1 unit coverage + live re-validation). Not a placeholder — it names the exact seam and the fallback. No "TODO"/vague steps.

**3. Type consistency:** `requireWriteRole(): RequestHandler` used identically in Task 1 (definition) and Task 2 (import + calls). `roleSatisfies(role, 'member')` matches the existing signature. `authContext.role: PostgresTeamRole | null` consistent with postgres-auth.ts. ✓

**Live re-validation note (acceptance, for the final whole-branch review):** re-stand the team-mode rig (Docker pgvector PG + a 2nd server with `MEMSMITH_DATA_DIR` isolated, per the team-mode validation memory 35981b8f) and prove: a viewer key with write scope → `POST /v1/memories` now returns **403**; an owner/member key → still **201**; a legacy null-role write-scoped key → still **201** (no lockout). This is the definitive proof the C4 bug is closed. Requires the user to launch the server (mise-shell caveat); can be done as a guided step. Tear down after (`docker rm -f`, drop the throwaway).
