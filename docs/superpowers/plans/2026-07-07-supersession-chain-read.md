# Supersession-Chain Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the stored-but-unread `supersedes` column behavior-bearing — collapse superseded observations to their current head on context injection, annotate them on explicit search, and render supersession lineage in the dashboard decision-log.

**Architecture:** One new module `src/server/retrieval/supersession.ts` exposes a forward chain-walk primitive (`resolveSupersessionHead`) and a batch memoizing form (`resolveHeads`). The two retrieval surfaces already funnel through `ServerV1PostgresRoutes.resolveSearchResults`; a new `mode: 'search' | 'context'` param there applies collapse (context) or annotate (search) as a post-ranking transform. The dashboard `decisionLog()` gains chain grouping.

**Tech Stack:** TypeScript, Postgres (pg), bun:test. No new dependencies. No schema change.

## Global Constraints

- No schema migration — uses existing `supersedes TEXT REFERENCES observations(id) ON DELETE SET NULL` (schema.ts:375).
- Every supersession query MUST be team/project-scoped; a chain can never cross a tenant boundary.
- `MAX_CHAIN_DEPTH` default 16, overridable via `CLAUDE_MEM_SUPERSEDE_MAX_DEPTH` (clamp 1–256).
- Retrieval MUST NOT 500 because of supersession: any resolution error returns the un-resolved ranked results unchanged.
- Tests are Postgres-gated (test container on port **55432**, never 5432); one schema per test via `poolForSchema`. Skip cleanly when `CLAUDE_MEM_TEST_POSTGRES_URL` is unset.
- After any src change that lands in a bundle, `npm run build` and commit regenerated `.cjs` (this feature touches only server runtime code, which is bundled into `server-service.cjs`).
- `supersededBy` is a response-only field, never stored.

---

## Task 1: Core chain-walk primitive + batch resolver

**Files:**
- Create: `src/server/retrieval/supersession.ts`
- Test: `tests/server/retrieval/supersession.test.ts`

**Test-harness note (verified):** Postgres isolation helpers are exported from
`tests/sdk/pg-isolation.ts` — import as
`import { createIsolatedSchema, dropSchema, poolForSchema, quoteIdentifier } from '../../sdk/pg-isolation.js';`.
Schema bootstrap uses `bootstrapServerPostgresSchema` from
`src/storage/postgres/index.js`. Guard every DB test with
`if (!process.env.CLAUDE_MEM_TEST_POSTGRES_URL) { it.skip(...); return; }` exactly as
`tests/server/dashboard/queries.test.ts` does. Match that file's setup verbatim for
pool creation and schema bootstrap; do not invent a `helpers/pg-pool.js`.

**Interfaces:**
- Consumes: `PostgresQueryable` from `src/storage/postgres/utils.js` (has `.query(sql, args)`).
- Produces:
  - `resolveSupersessionHead(db: PostgresQueryable, startId: string, scope: SupersedeScope): Promise<string>`
  - `resolveHeads(db: PostgresQueryable, ids: string[], scope: SupersedeScope): Promise<Map<string, string>>`
  - `type SupersedeScope = { teamId: string; projectId?: string }`
  - `maxChainDepth(): number`

- [ ] **Step 1: Write the failing test (linear chain, already-head, fork, cycle, depth cap, scope)**

Create `tests/server/retrieval/supersession.test.ts`. Follow the existing Postgres test harness pattern (see `tests/storage/postgres/*.test.ts` for `poolForSchema`, schema bootstrap, and the `CLAUDE_MEM_TEST_POSTGRES_URL` skip guard). Insert observations directly with `pool.query` using the real `observations` columns (`id, project_id, team_id, kind, content, obs_type, lifecycle_state, supersedes, created_at`).

```ts
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { poolForSchema } from '../../helpers/pg-pool.js'; // match the exact helper other pg tests import
import { resolveSupersessionHead, resolveHeads, maxChainDepth } from '../../../src/server/retrieval/supersession.js';

const TEAM = '11111111-1111-1111-1111-111111111111';
const PROJ = '22222222-2222-2222-2222-222222222222';

// helper: insert an observation; `sup` is the id this row supersedes (or null)
async function insertObs(db: any, id: string, sup: string | null, createdIso: string) {
  await db.query(
    `INSERT INTO observations (id, project_id, team_id, kind, content, obs_type, lifecycle_state, supersedes, created_at, updated_at)
     VALUES ($1,$2,$3,'observation',$4,'decision','open',$5,$6,$6)`,
    [id, PROJ, TEAM, `obs ${id}`, sup, createdIso],
  );
}

describe('supersession chain walk', () => {
  let pool: any;
  beforeAll(async () => { pool = await poolForSchema('supersession_core'); });
  afterAll(async () => { await pool?.end(); });

  test('linear chain resolves to head (X<-Y<-Z)', async () => {
    // Z supersedes Y supersedes X; starting from X, head is Z
    await insertObs(pool, 'x', null, '2026-01-01T00:00:00Z');
    await insertObs(pool, 'y', 'x', '2026-01-02T00:00:00Z');
    await insertObs(pool, 'z', 'y', '2026-01-03T00:00:00Z');
    expect(await resolveSupersessionHead(pool, 'x', { teamId: TEAM, projectId: PROJ })).toBe('z');
  });

  test('already-head returns itself', async () => {
    expect(await resolveSupersessionHead(pool, 'z', { teamId: TEAM, projectId: PROJ })).toBe('z');
  });

  test('fork: newest created_at wins', async () => {
    // both f1 and f2 supersede base; f2 is newer -> head is f2
    await insertObs(pool, 'base', null, '2026-02-01T00:00:00Z');
    await insertObs(pool, 'f1', 'base', '2026-02-02T00:00:00Z');
    await insertObs(pool, 'f2', 'base', '2026-02-03T00:00:00Z');
    expect(await resolveSupersessionHead(pool, 'base', { teamId: TEAM, projectId: PROJ })).toBe('f2');
  });

  test('cycle guard terminates (a<->b)', async () => {
    await insertObs(pool, 'ca', null, '2026-03-01T00:00:00Z');
    await insertObs(pool, 'cb', 'ca', '2026-03-02T00:00:00Z');
    await pool.query(`UPDATE observations SET supersedes='cb' WHERE id='ca'`);
    // walk must not hang; returns a valid node in the cycle
    const head = await resolveSupersessionHead(pool, 'ca', { teamId: TEAM, projectId: PROJ });
    expect(['ca', 'cb']).toContain(head);
  });

  test('scope isolation: successor in another team is not followed', async () => {
    const OTHER = '99999999-9999-9999-9999-999999999999';
    await insertObs(pool, 'sc', null, '2026-04-01T00:00:00Z');
    await pool.query(
      `INSERT INTO observations (id, project_id, team_id, kind, content, obs_type, lifecycle_state, supersedes, created_at, updated_at)
       VALUES ('scx',$1,$2,'observation','x','decision','open','sc','2026-04-02T00:00:00Z','2026-04-02T00:00:00Z')`,
      [PROJ, OTHER],
    );
    expect(await resolveSupersessionHead(pool, 'sc', { teamId: TEAM, projectId: PROJ })).toBe('sc');
  });

  test('resolveHeads batch returns head for every input id', async () => {
    const m = await resolveHeads(pool, ['x', 'y', 'z', 'base'], { teamId: TEAM, projectId: PROJ });
    expect(m.get('x')).toBe('z');
    expect(m.get('y')).toBe('z');
    expect(m.get('z')).toBe('z');
    expect(m.get('base')).toBe('f2');
  });

  test('maxChainDepth honors env clamp', () => {
    const prev = process.env.CLAUDE_MEM_SUPERSEDE_MAX_DEPTH;
    process.env.CLAUDE_MEM_SUPERSEDE_MAX_DEPTH = '500';
    expect(maxChainDepth()).toBe(256); // clamped
    process.env.CLAUDE_MEM_SUPERSEDE_MAX_DEPTH = '0';
    expect(maxChainDepth()).toBe(1);   // clamped
    if (prev === undefined) delete process.env.CLAUDE_MEM_SUPERSEDE_MAX_DEPTH; else process.env.CLAUDE_MEM_SUPERSEDE_MAX_DEPTH = prev;
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://postgres:postgres@localhost:55432/tam_test"; ~/.bun/bin/bun test tests/server/retrieval/supersession.test.ts`
Expected: FAIL — `Cannot find module '.../supersession.js'`.

- [ ] **Step 3: Implement the module**

Create `src/server/retrieval/supersession.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// Supersession-chain read. The `supersedes` column points backward (a newer row
// names the older row it replaced), so finding the CURRENT decision from an old
// one means walking FORWARD: repeatedly ask "who supersedes the one I hold?".
// Scoped so a chain never crosses a team/project boundary; bounded by a depth cap
// and a visited-set so a malformed cycle can never hang the walk.
import type { PostgresQueryable } from '../../storage/postgres/utils.js';

export type SupersedeScope = { teamId: string; projectId?: string };

const DEFAULT_MAX_DEPTH = 16;
export function maxChainDepth(): number {
  const raw = Number(process.env.CLAUDE_MEM_SUPERSEDE_MAX_DEPTH ?? DEFAULT_MAX_DEPTH);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_DEPTH;
  return Math.max(1, Math.min(256, Math.trunc(raw)));
}

// One step forward: the newest row that supersedes `id`, within scope. null = head.
async function successorOf(db: PostgresQueryable, id: string, scope: SupersedeScope): Promise<string | null> {
  const args: unknown[] = [id, scope.teamId];
  let projClause = '';
  if (scope.projectId) { projClause = ' AND project_id = $3'; args.push(scope.projectId); }
  const { rows } = await db.query(
    `SELECT id FROM observations
      WHERE supersedes = $1 AND team_id = $2${projClause}
      ORDER BY created_at DESC LIMIT 1`,
    args,
  );
  return rows.length ? String(rows[0].id) : null;
}

export async function resolveSupersessionHead(
  db: PostgresQueryable, startId: string, scope: SupersedeScope,
): Promise<string> {
  let current = startId;
  const visited = new Set<string>([startId]);
  const cap = maxChainDepth();
  for (let depth = 0; depth < cap; depth++) {
    const next = await successorOf(db, current, scope);
    if (next === null) break;
    if (visited.has(next)) { // cycle
      // eslint-disable-next-line no-console
      console.warn(`[supersession] cycle detected walking from ${startId} at ${next}`);
      break;
    }
    visited.add(next);
    current = next;
  }
  return current;
}

// Batch: resolve many ids, memoizing so shared tails are walked once.
export async function resolveHeads(
  db: PostgresQueryable, ids: string[], scope: SupersedeScope,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const memo = new Map<string, string>(); // id seen mid-walk -> its head
  for (const id of ids) {
    if (out.has(id)) continue;
    if (memo.has(id)) { out.set(id, memo.get(id)!); continue; }
    // walk, recording the path so every node on it maps to the same head
    const path: string[] = [id];
    let current = id;
    const visited = new Set<string>([id]);
    const cap = maxChainDepth();
    let hitMemo: string | null = null;
    for (let depth = 0; depth < cap; depth++) {
      if (memo.has(current)) { hitMemo = memo.get(current)!; break; }
      const next = await successorOf(db, current, scope);
      if (next === null) break;
      if (visited.has(next)) { console.warn(`[supersession] cycle detected walking from ${id} at ${next}`); break; }
      visited.add(next); path.push(next); current = next;
    }
    const head = hitMemo ?? current;
    for (const node of path) { memo.set(node, head); }
    out.set(id, head);
  }
  return out;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://postgres:postgres@localhost:55432/tam_test"; ~/.bun/bin/bun test tests/server/retrieval/supersession.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/retrieval/supersession.ts tests/server/retrieval/supersession.test.ts
git commit -m "feat(server): supersession chain-walk primitive + batch resolver"
```

---

## Task 2: Apply collapse (context) / annotate (search) in resolveSearchResults

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (`resolveSearchResults` ~1274-1285; call sites 926, 972, 1029, 1039; `serializeObservation` ~1982)
- Test: `tests/server/v1-supersession-recall.test.ts`

**Test-harness note (verified):** v1 route tests live directly under `tests/server/`
(e.g. `tests/server/v1-routes.test.ts`, `tests/server/runtime/server-mcp-routes.test.ts`)
— there is NO `tests/server/routes/v1/` directory. Copy the app boot + Bearer-key
seeding from `tests/server/v1-routes.test.ts`. Use the same `CLAUDE_MEM_TEST_POSTGRES_URL`
skip guard.

**Interfaces:**
- Consumes: `resolveHeads` from `../../retrieval/supersession.js`; `PostgresObservation` (has `id`, `content`, and now an optional `supersededBy`).
- Produces: `resolveSearchResults(input & { mode: 'search' | 'context' })` — context collapses hits to heads (deduped); search annotates hits with `supersededBy` and appends missing heads.

- [ ] **Step 1: Write the failing test**

Create `tests/server/v1-supersession-recall.test.ts`. Boot the routes/app the way the existing v1 route tests do (reuse their app-factory helper and auth-key seeding — match an existing `tests/server/routes/v1/*.test.ts`). Seed a superseded chain where ONLY the old observation matches the query terms, then assert:

```ts
// context mode: the superseded old hit is REPLACED by its head; old id absent, head id present
// search mode:  the old hit is PRESENT with supersededBy = headId; head id also present
```

Write two tests (`/v1/context` collapses`, `/v1/search annotates`) plus a dedupe test (head already in results appears once). Use the real HTTP path (supertest-style or the app.handle harness the other tests use) with a valid Bearer key scoped to TEAM/PROJ.

- [ ] **Step 2: Run the test, verify it fails**

Run: `export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://postgres:postgres@localhost:55432/tam_test"; ~/.bun/bin/bun test tests/server/v1-supersession-recall.test.ts`
Expected: FAIL — context returns the superseded row; search has no `supersededBy`.

- [ ] **Step 3: Add `supersededBy` to the observation type + serializer**

In `src/storage/postgres/observations.ts`, add to the `PostgresObservation` interface (near line 34/65): `supersededBy?: string | null;` (response-only; `mapObservationRow` leaves it undefined).

In `ServerV1PostgresRoutes.ts` `serializeObservation` (~1982), extend the param type with `supersededBy?: string | null;` and add to the returned object: `...(observation.supersededBy ? { supersededBy: observation.supersededBy } : {})`.

- [ ] **Step 4: Implement collapse/annotate in resolveSearchResults**

Change the signature to accept `mode`, resolve heads after ranking, and apply the transform. Wrap resolution in try/catch that returns the un-resolved `ranked` on error (never throw). Add a private helper `applySupersession(ranked, mode, scope)`:

```ts
private async resolveSearchResults(input: {
  projectId: string; teamId: string; query: string; limit: number;
  platformSource: string | null; mode: 'search' | 'context';
}): Promise<PostgresObservation[]> {
  const repo = new PostgresObservationRepository(this.options.pool);
  const ranked = this.searchHybridEnabled() ? await repo.hybridSearch(input) : await repo.search(input);
  try {
    return await this.applySupersession(ranked, input.mode, { teamId: input.teamId, projectId: input.projectId });
  } catch (err) {
    logger.warn('SYSTEM', 'supersession resolution failed; returning ranked results', {}, err instanceof Error ? err : new Error(String(err)));
    return ranked;
  }
}

private async applySupersession(
  ranked: PostgresObservation[], mode: 'search' | 'context', scope: { teamId: string; projectId?: string },
): Promise<PostgresObservation[]> {
  if (ranked.length === 0) return ranked;
  const heads = await resolveHeads(this.options.pool, ranked.map(r => r.id), scope);
  const byId = new Map(ranked.map(r => [r.id, r]));
  const needHead = new Set<string>();
  for (const r of ranked) { const h = heads.get(r.id)!; if (h !== r.id && !byId.has(h)) needHead.add(h); }
  const fetched = await this.fetchObservationsByIds([...needHead], scope); // scoped WHERE id = ANY($1)
  for (const f of fetched) byId.set(f.id, f);

  if (mode === 'context') {
    const seen = new Set<string>(); const out: PostgresObservation[] = [];
    for (const r of ranked) {
      const head = byId.get(heads.get(r.id)!) ?? r;
      if (seen.has(head.id)) continue;
      seen.add(head.id); out.push(head);
    }
    return out;
  }
  // search: annotate + append missing heads right after their child
  const out: PostgresObservation[] = []; const emitted = new Set<string>();
  for (const r of ranked) {
    const headId = heads.get(r.id)!;
    const item = headId !== r.id ? { ...r, supersededBy: headId } : r;
    if (!emitted.has(item.id)) { out.push(item); emitted.add(item.id); }
    if (headId !== r.id && !emitted.has(headId)) { const h = byId.get(headId); if (h) { out.push(h); emitted.add(headId); } }
  }
  return out;
}
```

Add `fetchObservationsByIds(ids, scope)` (scoped `SELECT * FROM observations WHERE id = ANY($1) AND team_id = $2 [AND project_id = $3]`, mapped via the repo's row mapper; returns `[]` for empty input). Update the four call sites to pass `mode: 'search'` (search, MCP search at 1029) and `mode: 'context'` (context, MCP context at 1039). Add `import { resolveHeads } from '../../retrieval/supersession.js';`.

- [ ] **Step 5: Run the test, verify it passes**

Run: `export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://postgres:postgres@localhost:55432/tam_test"; ~/.bun/bin/bun test tests/server/v1-supersession-recall.test.ts`
Expected: PASS.

- [ ] **Step 6: Rebuild bundle + commit**

```bash
npm run build
git add src/server/retrieval/supersession.ts src/server/routes/v1/ServerV1PostgresRoutes.ts src/storage/postgres/observations.ts tests/server/v1-supersession-recall.test.ts plugin/scripts/server-service.cjs
git commit -m "feat(server): collapse superseded on /v1/context, annotate on /v1/search"
```

---

## Task 3: Dashboard decision-log chain grouping

**Files:**
- Modify: `src/server/dashboard/queries.ts` (`decisionLog` ~16-20)
- Test: `tests/server/dashboard/decision-log-chain.test.ts`

**Interfaces:**
- Consumes: `resolveHeads` from `../retrieval/supersession.js`.
- Produces: `decisionLog(db, scope)` returns `Array<{ head: Row; history: Row[] }>` ordered by head `created_at` desc; `history` oldest→newest, excludes head. Unchained decisions are singleton chains (`history: []`).

- [ ] **Step 1: Write the failing test**

Create `tests/server/dashboard/decision-log-chain.test.ts`. Seed 3 chained decisions (X←Y←Z) and 1 standalone decision W. Assert `decisionLog` returns two entries: `{ head: Z, history: [X, Y] }` and `{ head: W, history: [] }`.

- [ ] **Step 2: Run, verify it fails**

Run: `export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://postgres:postgres@localhost:55432/tam_test"; ~/.bun/bin/bun test tests/server/dashboard/decision-log-chain.test.ts`
Expected: FAIL — current `decisionLog` returns a flat array.

- [ ] **Step 3: Implement chain grouping**

Rewrite `decisionLog` to fetch all `obs_type='decision'` rows in scope, group by head via `resolveHeads`, and shape into `{ head, history }[]`:

```ts
import { resolveHeads } from '../retrieval/supersession.js';

export async function decisionLog(db: PostgresQueryable, s: Scope) {
  const w = scopeWhere(s);
  const { rows } = await db.query(`SELECT * FROM observations WHERE ${w.sql} AND obs_type='decision' ORDER BY created_at ASC`, w.args);
  const parse = (r: any) => ({ ...r, metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata });
  const rowsById = new Map<string, any>(rows.map((r: any) => [r.id, parse(r)]));
  const heads = await resolveHeads(db, rows.map((r: any) => r.id), s);
  const chains = new Map<string, any[]>();
  for (const r of rows) { const h = heads.get(r.id)!; (chains.get(h) ?? chains.set(h, []).get(h)!).push(rowsById.get(r.id)); }
  const out = [];
  for (const [headId, members] of chains) {
    const head = rowsById.get(headId); if (!head) continue;
    const history = members.filter((m: any) => m.id !== headId); // rows already created_at ASC
    out.push({ head, history });
  }
  out.sort((a, b) => new Date(b.head.created_at).getTime() - new Date(a.head.created_at).getTime());
  return out;
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://postgres:postgres@localhost:55432/tam_test"; ~/.bun/bin/bun test tests/server/dashboard/decision-log-chain.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the dashboard UI renderer + rebuild + commit**

In `src/server/dashboard/ui.html`, update the decision-log render to consume `{ head, history }[]`: show `head` prominently; render `history` as a collapsed "superseded (N)" trail under it. (Match the existing render style in the file — the decision-log section.) Then:

```bash
npm run build
git add src/server/dashboard/queries.ts src/server/dashboard/ui.html tests/server/dashboard/decision-log-chain.test.ts plugin/scripts/server-service.cjs
git commit -m "feat(dashboard): decision-log renders supersession chains (head + history)"
```

---

## Task 4: Docs — env var + capability status

**Files:**
- Modify: `docs/deploy/aws.md` (env-var table)
- Modify: `/Users/shwaits/Workspace/team-agent-memory/PROJECT-STATE.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Document `CLAUDE_MEM_SUPERSEDE_MAX_DEPTH`**

Add a row to the env-var table in `docs/deploy/aws.md`: `CLAUDE_MEM_SUPERSEDE_MAX_DEPTH | 16 | Max supersession-chain walk depth (clamp 1–256); guards malformed cycles.`

- [ ] **Step 2: Update PROJECT-STATE.md**

Mark grab-spec #8 (supersedes chain) as SHIPPED with the behavior summary (collapse-on-context, annotate-on-search, dashboard lineage) and the new module path.

- [ ] **Step 3: Commit**

```bash
git add docs/deploy/aws.md /Users/shwaits/Workspace/team-agent-memory/PROJECT-STATE.md
git commit -m "docs: supersession-chain read env var + capability status"
```

---

## Self-Review

**1. Spec coverage:**
- Collapse-on-context → Task 2 ✅ · Annotate-on-search → Task 2 ✅ · Dashboard lineage → Task 3 ✅
- Core primitive + batch + cycle/depth/scope guards → Task 1 ✅
- `CLAUDE_MEM_SUPERSEDE_MAX_DEPTH` → Task 1 (impl) + Task 4 (docs) ✅
- Degrade-on-error (no 500) → Task 2 try/catch ✅
- All 11 spec test cases mapped: chain/head/fork/cycle/depth/scope/batch → Task 1 (7); context-collapse/search-annotate/dedupe → Task 2; decisionLog grouping → Task 3; degrade-on-error → Task 2. ✅
- No schema change, response-only `supersededBy`, scoped queries → Global Constraints ✅

**2. Placeholder scan:** No TBD/TODO. Test bodies for Tasks 2–3 describe seed+assert precisely and point at the concrete existing harness to copy (the exact app-factory/pool helper import must be matched by the implementer to the sibling test files — flagged as an interface note, not a placeholder in logic).

**3. Type consistency:** `SupersedeScope`/`{teamId, projectId?}` used consistently across Tasks 1–3. `resolveHeads(db, ids, scope) → Map<string,string>` signature identical at all three call sites. `supersededBy?: string | null` added in Task 2 to both the interface and serializer. `mode: 'search'|'context'` consistent across the four call sites.
