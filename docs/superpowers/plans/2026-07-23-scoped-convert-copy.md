# Scoped Convert Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Go Team convert copy only the current project (its data + lineage, re-stamped under the destination team), skip team-account tables, and verify with scoped counts — fixing the whole-store-copy leak.

**Architecture:** The scoping and `team_id` re-stamp live entirely in `buildConvertCopyDeps` (`ServerV1PostgresRoutes.ts`), which already owns the local/remote pools and now also receives `{ projectId, teamId }`. `copy-engine.ts` stays a pure walker over a reduced table list; `convert-service.ts` threads `projectId` through; `ConvertRoutes.ts` validates and forwards the client-supplied `projectId`. No schema changes.

**Tech Stack:** TypeScript, Express, node-postgres (`pg`), `bun test`.

## Global Constraints

- Branch from `38ce3ef7` (already on branch `scoped-convert-copy`). Never commit to `main`. Merge `--no-ff` recording a pre-merge rollback SHA. Nothing pushed (local only).
- Every commit ends with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Dogfood data must never be at risk (`:38879` local runtime — do not touch it; tests use fakes / disposable pools only).
- Team API key lives only in `CredentialStore`, never in the marker (unchanged — flip is sub-spec 1, out of scope here).
- No new schema / migration; no dependency changes.
- The re-stamp of `team_id` for direct-scoped tables happens in `buildConvertCopyDeps.readRows` (the scoping layer), NOT in `copy-engine.ts`. `copy-engine.ts` remains scope-agnostic so its existing fake-deps unit tests are unaffected.
- FK-safe copy order (parents before children): `projects` → `server_sessions` → `agent_events` → `observation_generation_jobs` → `observations` → `observation_sources` → `observation_generation_job_events`.
- Scope filters (exact):
  - `projects`: `WHERE id = $projectId`
  - `server_sessions` | `agent_events` | `observation_generation_jobs` | `observations`: `WHERE project_id = $projectId`
  - `observation_sources`: `WHERE observation_id IN (SELECT id FROM observations WHERE project_id = $projectId)`
  - `observation_generation_job_events`: `WHERE generation_job_id IN (SELECT id FROM observation_generation_jobs WHERE project_id = $projectId)`
- Direct-scoped tables (`projects`, `server_sessions`, `agent_events`, `observation_generation_jobs`, `observations`) get `team_id` set to the destination `teamId` on copy. `projects` also gets `team_id` re-stamped (its scope column is `id`, but it still carries `team_id`). Lineage tables carry no scope columns → copied verbatim.
- Team-account tables NEVER read/counted/inserted: `teams`, `team_members`, `api_keys`, `server_settings`.

---

## Pre-Flight Note (regression the plan must handle)

`tests/server/routes/v1/convert-routes.test.ts` currently calls `/v1/convert/migrate`
with bodies that have **no `projectId`** and expects success (lines ~39, ~65). Task 3
adds a `projectId` required-check, which will break those two happy-path assertions.
Task 3 reconciles them in the same task (add `projectId` to those bodies) and adds a new
"missing projectId → 400" assertion. This is the same reconciliation the per-project-runtime
sub-spec did when it added cwd/serverUrl/apiKey.

---

## File Structure

- `src/server/convert/copy-engine.ts` — reduce `COPY_TABLES` to the 7 copied tables (Task 1).
- `src/server/routes/v1/ServerV1PostgresRoutes.ts` — `buildConvertCopyDeps` gains `scope` arg; scoped `readRows`/`countRows` + `team_id` re-stamp; convert-route deps pass `input.projectId` + `input.teamId` into it (Task 2).
- `src/server/convert/convert-service.ts` — `runConvert` input gains `projectId`; passes it into the deps builder via the route (Task 2 wires the route; the service just carries `projectId` in its input type) (Task 2).
- `src/server/routes/v1/ConvertRoutes.ts` — `convert` input type gains `projectId`; route reads `req.body.projectId`, 400 if missing (Task 3).
- Tests: `tests/server/convert/copy-engine.test.ts` (Task 1), a new `tests/server/convert/scoped-copy-deps.test.ts` (Task 2), `tests/server/routes/v1/convert-routes.test.ts` (Task 3).

---

## Task 1: Reduce COPY_TABLES to copied tables only

**Files:**
- Modify: `src/server/convert/copy-engine.ts:15-27`
- Test: `tests/server/convert/copy-engine.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `COPY_TABLES` = the 7 copied tables in FK-safe order, consumed by `runCopy`/`verifyCopy` and by `buildConvertCopyDeps` (Task 2).

- [ ] **Step 1: Update the copy-engine test to assert the reduced list**

Add to `tests/server/convert/copy-engine.test.ts`:

```ts
it('COPY_TABLES excludes team-account tables and is FK-safe ordered', () => {
  expect(COPY_TABLES).toEqual([
    'projects',
    'server_sessions',
    'agent_events',
    'observation_generation_jobs',
    'observations',
    'observation_sources',
    'observation_generation_job_events',
  ]);
  for (const t of ['teams', 'team_members', 'api_keys', 'server_settings']) {
    expect(COPY_TABLES).not.toContain(t);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/server/convert/copy-engine.test.ts`
Expected: FAIL — current `COPY_TABLES` still contains `teams`, `api_keys`, etc.

- [ ] **Step 3: Reduce COPY_TABLES**

In `src/server/convert/copy-engine.ts`, replace the `COPY_TABLES` array:

```ts
// FK-safe order: parents before children. Team-account tables (teams,
// team_members, api_keys, server_settings) are intentionally NOT copied —
// the destination team already exists (see scoped-convert-copy spec, D2).
export const COPY_TABLES: string[] = [
  'projects',
  'server_sessions',
  'agent_events',
  'observation_generation_jobs',
  'observations',
  'observation_sources',
  'observation_generation_job_events',
];
```

- [ ] **Step 4: Run the full convert test dir to verify pass + no collateral break**

Run: `bun test tests/server/convert/`
Expected: PASS. (The `copy-engine` and `convert-service` fakes build their `local`/`remote` maps from `COPY_TABLES`, so they adapt automatically; the observation re-stamp + idempotency + verify tests still hold.)

- [ ] **Step 5: Commit**

```bash
git add src/server/convert/copy-engine.ts tests/server/convert/copy-engine.test.ts
git commit -m "feat(convert): drop team-account tables from COPY_TABLES

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Scoped + re-stamping CopyDeps in buildConvertCopyDeps

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts:1565-1585` (convert route deps) and `:1593-1637` (`buildConvertCopyDeps`)
- Modify: `src/server/convert/convert-service.ts:25-46` (`runConvert` input type gains `projectId`)
- Test: `tests/server/convert/scoped-copy-deps.test.ts` (new)

**Interfaces:**
- Consumes: reduced `COPY_TABLES` (Task 1); `runConvert` from `convert-service`.
- Produces:
  - `buildConvertCopyDeps(remoteUrl: string, scope: { projectId: string; teamId: string }): { deps: CopyDeps; dispose: () => Promise<void> }`
  - `runConvert` input type extended to `{ databaseUrl; ownerUserId; cwd; teamId; serverUrl; apiKey; projectId }` (Task 3 supplies `projectId` at the route).
  - A pure exported helper `buildScopedReadQuery(table: string, projectId: string): { text: string }` (unit-testable without a live PG) and `restampTeamId(table, rows, teamId)` — see Step 3. These are the seams Task 2's test exercises.

- [ ] **Step 1: Write the failing unit test for the scoping helpers**

Create `tests/server/convert/scoped-copy-deps.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import {
  buildScopedReadQuery,
  restampTeamId,
  DIRECT_SCOPED_TABLES,
} from '../../../src/server/routes/v1/convert-scope.js';

describe('buildScopedReadQuery', () => {
  it('scopes projects by id', () => {
    expect(buildScopedReadQuery('projects', 'p1').text)
      .toBe('SELECT * FROM projects WHERE id = $1');
  });
  it('scopes direct project tables by project_id', () => {
    for (const t of ['server_sessions', 'agent_events', 'observation_generation_jobs', 'observations']) {
      expect(buildScopedReadQuery(t, 'p1').text)
        .toBe(`SELECT * FROM ${t} WHERE project_id = $1`);
    }
  });
  it('scopes observation_sources via parent observations', () => {
    expect(buildScopedReadQuery('observation_sources', 'p1').text)
      .toBe('SELECT * FROM observation_sources WHERE observation_id IN (SELECT id FROM observations WHERE project_id = $1)');
  });
  it('scopes job events via parent jobs', () => {
    expect(buildScopedReadQuery('observation_generation_job_events', 'p1').text)
      .toBe('SELECT * FROM observation_generation_job_events WHERE generation_job_id IN (SELECT id FROM observation_generation_jobs WHERE project_id = $1)');
  });
});

describe('restampTeamId', () => {
  it('rewrites team_id on direct-scoped tables', () => {
    const out = restampTeamId('observations', [{ id: 'o1', team_id: 'local', project_id: 'p1' }], 'dest');
    expect(out[0]).toMatchObject({ id: 'o1', team_id: 'dest', project_id: 'p1' });
  });
  it('re-stamps projects team_id too', () => {
    const out = restampTeamId('projects', [{ id: 'p1', team_id: 'local' }], 'dest');
    expect(out[0]!.team_id).toBe('dest');
  });
  it('leaves lineage tables untouched (no team_id column)', () => {
    const row = { id: 's1', observation_id: 'o1' };
    const out = restampTeamId('observation_sources', [{ ...row }], 'dest');
    expect(out[0]).toEqual(row);
    expect(DIRECT_SCOPED_TABLES).not.toContain('observation_sources');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/server/convert/scoped-copy-deps.test.ts`
Expected: FAIL — `src/server/routes/v1/convert-scope.ts` does not exist.

- [ ] **Step 3: Create the scope helper module**

Create `src/server/routes/v1/convert-scope.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// Project-scoping for the Go Team convert copy. Filters each COPY_TABLES read
// to a single project's rows and re-stamps the destination team_id on the
// direct-scoped tables. See docs/superpowers/specs/2026-07-23-scoped-convert-copy-design.md.

// Tables that carry (project_id, team_id) directly and get team_id re-stamped
// on copy. `projects` carries team_id too (its scope column is `id`).
export const DIRECT_SCOPED_TABLES = new Set<string>([
  'projects',
  'server_sessions',
  'agent_events',
  'observation_generation_jobs',
  'observations',
]);

// Table name → local read query scoped to $1 = projectId. Table names come only
// from COPY_TABLES (a fixed safe list — never user input).
export function buildScopedReadQuery(table: string, _projectId: string): { text: string } {
  switch (table) {
    case 'projects':
      return { text: 'SELECT * FROM projects WHERE id = $1' };
    case 'server_sessions':
    case 'agent_events':
    case 'observation_generation_jobs':
    case 'observations':
      return { text: `SELECT * FROM ${table} WHERE project_id = $1` };
    case 'observation_sources':
      return { text: 'SELECT * FROM observation_sources WHERE observation_id IN (SELECT id FROM observations WHERE project_id = $1)' };
    case 'observation_generation_job_events':
      return { text: 'SELECT * FROM observation_generation_job_events WHERE generation_job_id IN (SELECT id FROM observation_generation_jobs WHERE project_id = $1)' };
    default:
      throw new Error(`convert-scope: unexpected table ${table}`);
  }
}

// Remote/local scoped count query. Direct-scoped tables count by project_id
// (+ team_id on the remote side, supplied as $2 when teamId !== null).
export function buildScopedCountQuery(
  table: string,
  which: 'local' | 'remote',
): { text: string; params: (v: { projectId: string; teamId: string }) => unknown[] } {
  if (table === 'projects') {
    return which === 'remote'
      ? { text: 'SELECT count(*) FROM projects WHERE id = $1 AND team_id = $2', params: (v) => [v.projectId, v.teamId] }
      : { text: 'SELECT count(*) FROM projects WHERE id = $1', params: (v) => [v.projectId] };
  }
  if (DIRECT_SCOPED_TABLES.has(table)) {
    return which === 'remote'
      ? { text: `SELECT count(*) FROM ${table} WHERE project_id = $1 AND team_id = $2`, params: (v) => [v.projectId, v.teamId] }
      : { text: `SELECT count(*) FROM ${table} WHERE project_id = $1`, params: (v) => [v.projectId] };
  }
  // Lineage tables: count via the parent subquery (identical local/remote text;
  // the remote parent is already team-scoped by the copy).
  const q = buildScopedReadQuery(table, '').text.replace('SELECT *', 'SELECT count(*)');
  return { text: q, params: (v) => [v.projectId] };
}

// Re-stamp team_id → destination on direct-scoped tables; return rows unchanged
// for lineage tables. Never mutates input rows.
export function restampTeamId(
  table: string,
  rows: Array<Record<string, unknown>>,
  teamId: string,
): Array<Record<string, unknown>> {
  if (!DIRECT_SCOPED_TABLES.has(table)) return rows;
  return rows.map((r) => ({ ...r, team_id: teamId }));
}
```

- [ ] **Step 4: Run the helper test to verify pass**

Run: `bun test tests/server/convert/scoped-copy-deps.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the helpers into buildConvertCopyDeps**

In `src/server/routes/v1/ServerV1PostgresRoutes.ts`:

1. Add the import near the other convert imports:

```ts
import { buildScopedReadQuery, buildScopedCountQuery, restampTeamId } from './convert-scope.js';
```

2. Change the signature and body of `buildConvertCopyDeps` (currently line 1593):

```ts
private buildConvertCopyDeps(
  remoteUrl: string,
  scope: { projectId: string; teamId: string },
): { deps: CopyDeps; dispose: () => Promise<void> } {
  const remoteConfig = parsePostgresConfig({ env: { MEMSMITH_SERVER_DATABASE_URL: remoteUrl } as NodeJS.ProcessEnv });
  if (!remoteConfig) throw new Error('invalid remote databaseUrl');
  const remotePool = createPostgresPool(remoteConfig);

  let bootstrapped = false;
  const ensureBootstrapped = async (): Promise<void> => {
    if (bootstrapped) return;
    await bootstrapServerPostgresSchema(remotePool);
    bootstrapped = true;
  };

  const localPool = this.options.pool;

  const deps: CopyDeps = {
    readRows: async (table: string) => {
      const { text } = buildScopedReadQuery(table, scope.projectId);
      const result = await localPool.query(text, [scope.projectId]);
      return restampTeamId(table, result.rows as Array<Record<string, unknown>>, scope.teamId);
    },
    upsertRows: async (table: string, rows: Array<Record<string, unknown>>) => {
      if (rows.length === 0) return;
      await ensureBootstrapped();
      const cols = Object.keys(rows[0]!);
      const colList = cols.map(c => `"${c}"`).join(', ');
      for (const row of rows) {
        const values = cols.map(c => row[c]);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        await remotePool.query(
          `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
          values,
        );
      }
    },
    countRows: async (which: 'local' | 'remote', table: string) => {
      const pool = which === 'local' ? localPool : remotePool;
      const { text, params } = buildScopedCountQuery(table, which);
      const result = await pool.query(text, params(scope));
      return Number((result.rows[0] as { count: string }).count);
    },
  };

  return { deps, dispose: () => remotePool.end() };
}
```

3. Update the convert route dep (currently line 1566) to pass scope:

```ts
convert: async (input) => {
  const { deps, dispose } = this.buildConvertCopyDeps(input.databaseUrl, {
    projectId: input.projectId,
    teamId: input.teamId,
  });
  try {
    return await runConvert(
      {
        copyDeps: deps,
        flip: (fi) => flipToTeam(
          {
            writeProjectRuntime,
            storeKeyForTeam: (teamId, key) => credStore.storeKeyForTeam(teamId, key),
          },
          { cwd: fi.cwd, teamId: fi.teamId, serverUrl: fi.serverUrl, apiKey: fi.apiKey },
        ),
      },
      input,
    );
  } finally {
    await dispose();
  }
},
```

- [ ] **Step 6: Add `projectId` to `runConvert`'s input type**

In `src/server/convert/convert-service.ts`, change the `runConvert` `input` param type (line 27) to include `projectId`:

```ts
  input: { databaseUrl: string; ownerUserId: string; cwd: string; teamId: string; serverUrl: string; apiKey: string; projectId: string },
```

(No body change needed in `runConvert` — `projectId` is consumed by the route's deps builder, not by the service loop.)

- [ ] **Step 7: Typecheck + run the convert test dir**

Run: `npx tsc --noEmit && bun test tests/server/convert/`
Expected: tsc clean (ignore the known false-positive `bun:test` / `.js`-import editor diagnostics if they appear only in the editor — the CLI `tsc` is the gate); convert tests PASS. Note: `convert-service.test.ts`'s `baseInput` lacks `projectId` — add `projectId: 'p1'` to its `baseInput` object so the extended input type is satisfied. Do this in this task since it is the type change that requires it.

- [ ] **Step 8: Commit**

```bash
git add src/server/routes/v1/convert-scope.ts src/server/routes/v1/ServerV1PostgresRoutes.ts src/server/convert/convert-service.ts tests/server/convert/scoped-copy-deps.test.ts tests/server/convert/convert-service.test.ts
git commit -m "feat(convert): project-scoped copy with destination team_id re-stamp

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Route accepts and requires client-supplied projectId

**Files:**
- Modify: `src/server/routes/v1/ConvertRoutes.ts:6-42`
- Test: `tests/server/routes/v1/convert-routes.test.ts`

**Interfaces:**
- Consumes: `runConvert` input type with `projectId` (Task 2).
- Produces: `ConvertRoutesDeps.convert` input includes `projectId: string`; `/v1/convert/migrate` reads `req.body.projectId` and returns `400 { error: 'projectId required' }` when absent.

- [ ] **Step 1: Update the route tests — reconcile happy path + add missing-projectId 400**

In `tests/server/routes/v1/convert-routes.test.ts`:

1. Add `projectId: 'p1'` to the two happy-path `/v1/convert/migrate` bodies (the "returns converted" test ~line 39 and the "surfaces convert error" test ~line 65), so they still reach `convert`.

2. Add a new assertion in the existing "returns 400 when required body fields are missing" test, after the databaseUrl check:

```ts
// Missing projectId (all else present) → 400
const r3 = res();
await routes['/v1/convert/migrate']({ body: { databaseUrl: 'postgres://x', cwd: '/proj', serverUrl: 'https://s', apiKey: 'k' }, authContext: { userId: 'u1', role: 'owner', teamId: 't1' } }, r3);
expect(r3.code).toBe(400);
expect(r3.body.error).toBe('projectId required');
```

3. If the "returns converted" test asserts on what `convert` was called with, add `projectId: 'p1'` to the expected input. (If it only asserts on the response body, no change beyond the body edit in (1).)

- [ ] **Step 2: Run to verify the new 400 test fails**

Run: `bun test tests/server/routes/v1/convert-routes.test.ts`
Expected: FAIL — the missing-projectId case currently reaches `convert` (which returns 200), so the `expect(r3.code).toBe(400)` fails.

- [ ] **Step 3: Add projectId to the route contract + validation**

In `src/server/routes/v1/ConvertRoutes.ts`:

1. Extend the `convert` input type (line 9):

```ts
  convert: (input: { databaseUrl: string; ownerUserId: string; cwd: string; teamId: string; serverUrl: string; apiKey: string; projectId: string }) => Promise<ConvertResult>;
```

2. In the `/v1/convert/migrate` handler, read and validate `projectId` (place the read with the others ~line 27, and the check after the `apiKey` check ~line 33):

```ts
    const projectId = String(req.body?.projectId ?? '');
```
```ts
    if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
```

3. Pass it into the convert call (line 37):

```ts
      res.json(await deps.convert({ databaseUrl: url, ownerUserId, cwd, teamId, serverUrl, apiKey, projectId }));
```

- [ ] **Step 4: Run route tests to verify pass**

Run: `bun test tests/server/routes/v1/convert-routes.test.ts`
Expected: PASS (happy paths reconciled, new 400 case green).

- [ ] **Step 5: Typecheck + full convert + route suites**

Run: `npx tsc --noEmit && bun test tests/server/convert/ tests/server/routes/v1/convert-routes.test.ts`
Expected: tsc clean; all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/v1/ConvertRoutes.ts tests/server/routes/v1/convert-routes.test.ts
git commit -m "feat(convert): require client-supplied projectId on migrate route

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Integration proof — two-project isolation against real Postgres

**Files:**
- Test: `tests/server/convert/scoped-convert-integration.test.ts` (new)

**Interfaces:**
- Consumes: `buildScopedReadQuery`/`buildScopedCountQuery`/`restampTeamId` (Task 2), `runCopy`/`verifyCopy` (Task 1).
- Produces: nothing (test-only).

**Note on environment:** the repo has 5 known pre-existing `tests/server/` failures that are environmental `ECONNREFUSED` when no live PG is present. This task's test MUST self-skip (not fail) when no test Postgres is reachable, matching how the other PG-backed tests gate. Use the same guard those tests use (inspect one PG-backed test in `tests/server/` for the exact skip idiom — e.g. a `MEMSMITH_TEST_DATABASE_URL` env check that `it.skipIf`/early-returns). Do NOT introduce a new always-on live-PG dependency.

- [ ] **Step 1: Write the integration test (self-skipping without a test PG)**

Create `tests/server/convert/scoped-convert-integration.test.ts`. Structure:

1. Guard: resolve a test DB URL from env (same idiom as existing PG-backed tests); `it.skipIf(!url)` for every case.
2. Setup: bootstrap schema into a single "local" pool; insert two projects `A` (`team_id='localA'`, `project_id='A'`) and `B` (`team_id='localB'`, `project_id='B'`) — each with: 1 `projects` row, 1 `server_session`, 1 `agent_event`, 1 `observation_generation_job`, 2 `observations`, and lineage rows (`observation_sources` for B's observations, `observation_generation_job_events` for B's job). Also seed a "destination" pool bootstrapped with a pre-existing team `dest` + a `team_members` row + an `api_keys` row (to prove Task/D2 leaves them alone).
3. Build deps via the same helper module (construct a `CopyDeps` using `buildScopedReadQuery`/`restampTeamId`/`buildScopedCountQuery` against the two pools — mirror `buildConvertCopyDeps`), with `scope = { projectId: 'B', teamId: 'dest' }`.
4. Run `runCopy(deps, 'owner-x', ...)` then `verifyCopy(deps)`.

Assertions:

```ts
// B's rows landed under dest, project_id unchanged
const obsB = await dest.query("SELECT * FROM observations WHERE project_id='B'");
expect(obsB.rows).toHaveLength(2);
expect(obsB.rows.every(r => r.team_id === 'dest')).toBe(true);

// A never leaked
const obsA = await dest.query("SELECT count(*) FROM observations WHERE project_id='A'");
expect(Number(obsA.rows[0].count)).toBe(0);
const projA = await dest.query("SELECT count(*) FROM projects WHERE id='A'");
expect(Number(projA.rows[0].count)).toBe(0);

// lineage followed B's parents
const srcB = await dest.query("SELECT count(*) FROM observation_sources WHERE observation_id IN (SELECT id FROM observations WHERE project_id='B')");
expect(Number(srcB.rows[0].count)).toBeGreaterThan(0);

// team-account tables untouched: the pre-seeded dest team_members/api_keys rows are unchanged, count still 1 each
expect(Number((await dest.query('SELECT count(*) FROM team_members')).rows[0].count)).toBe(1);
expect(Number((await dest.query('SELECT count(*) FROM api_keys')).rows[0].count)).toBe(1);

// scoped verify passes despite A present locally and unrelated dest rows
expect((await verifyCopy(deps)).ok).toBe(true);
```

Add an idempotency assertion: run `runCopy` a second time and re-assert `obsB` length is still 2.

- [ ] **Step 2: Run with a test PG available**

Run: `MEMSMITH_TEST_DATABASE_URL=<url> bun test tests/server/convert/scoped-convert-integration.test.ts`
Expected: PASS. (If no PG configured in this environment, the test self-skips — record in the report that it was skipped and why, and that the Task 2 unit test + Task 3 route test carry the behavioral proof.)

- [ ] **Step 3: Run without a test PG to confirm clean skip**

Run: `bun test tests/server/convert/scoped-convert-integration.test.ts`
Expected: SKIPPED (not failed), no `ECONNREFUSED` crash.

- [ ] **Step 4: Commit**

```bash
git add tests/server/convert/scoped-convert-integration.test.ts
git commit -m "test(convert): two-project isolation integration proof (self-skipping)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** D1 (client projectId) → Task 3. D2 (skip team-account) → Task 1 + verified in Task 4. D3 (projects re-stamp) → Task 2 (`restampTeamId` includes `projects`, `buildScopedReadQuery('projects')`). D4 (scoped filters + lineage subqueries) → Task 2 helpers + Task 4 proof. D5 (scoped verify) → Task 2 `buildScopedCountQuery` + Task 4 assertion. All five covered.
- **Placeholder scan:** filters, table lists, FK columns all concrete and match schema.ts. The one env-dependent detail (exact test-PG skip idiom) is explicitly delegated with instructions to copy the existing idiom — not a code placeholder.
- **Type consistency:** `buildConvertCopyDeps(remoteUrl, scope)`, `ConvertRoutesDeps.convert` input, and `runConvert` input all consistently gain `projectId`/`scope`; `restampTeamId`/`buildScopedReadQuery`/`buildScopedCountQuery`/`DIRECT_SCOPED_TABLES` names identical across Task 2 code and Task 2/4 tests.
- **Regression pre-empted:** the convert-routes happy-path bodies and `convert-service.test.ts` `baseInput` are reconciled in the same tasks that change their types (Task 3, Task 2 Step 7).
