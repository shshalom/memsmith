# Deterministic Record-Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user expresses intent to save something ("remember/record/log/park/mark this…" in natural language), MemSmith reliably writes it as an embedded, user-directed observation — with a two-layer detector (agent + server-provider backstop), content-idempotent capture, and full search + dashboard usefulness (filter, boost, Notes panel, My-notes chip).

**Architecture:** Capture = a directive (MemSmith code, hook-delivered) instructing the agent to compose + `observation_add` with `kind:'user_note'` and an idempotency key, PLUS a server-provider backstop (`UserPromptSubmit` → `POST /v1/record-intent` → generation provider classifies+composes → same write) that always runs. Manual writes gain content-idempotency so the two layers + retries collapse to one row. Search gains a `userDirected` filter and a post-rank boost transform at the existing `resolveSearchResults` seam. Dashboard gains a Notes panel; Observations gains a My-notes filter chip.

**Tech Stack:** TypeScript, Bun (`bun test`), Postgres + pgvector, Express routes, the local Ollama/Claude generation provider (chat-completions shape), the existing `resolveSearchResults` ranking chokepoint.

## Global Constraints

- **Two-layer detection, machinery backstop:** agent (Layer 1) + always-runs server-provider classification (Layer 2). The backstop is the determinism guarantee the earlier agent-only draft lacked.
- **Manual-write content-idempotency REQUIRED:** manual `/v1/memories` writes carry a deterministic key = `hash(teamId, projectId, kind, normalized-content)` so agent+backstop+retries collapse to ONE row. (Postgres allows one `ON CONFLICT` per INSERT and the existing one targets `generation_key`; this plan uses a dedicated `idempotency_key` column + a separate conflict target on the manual path — Task 2 resolves the exact SQL.)
- **Directive lives in MemSmith code, NOT CLAUDE.md.** Delivered by existing injection hooks.
- **Write failures LOUD, read failures QUIET (fail-open):** a requested save that fails is surfaced; a boost/filter/backstop error degrades silently to normal behavior.
- **The user-directed mark (`kind`/`metadata`) MUST survive ranking into result rows** — basis for filter, boost, and both UI surfaces.
- **Reuse existing seams:** `observation_add`/`/v1/memories` (embeds via the shipped embed-on-write fix), `resolveSearchResults` (single ranking chokepoint), the `obsType`/`lifecycle_state` optional-filter idiom in `repo.search`, the decision-log panel + query pattern, the Observations filter-chip UI, `GenerationProviderHolder` for provider access.
- **Backstop must NOT overload obs-XML `generate()`:** the provider's only method (`generate(context: ServerGenerationContext)`) is built for observation XML. The backstop does its OWN minimal chat-completion (reusing the resolved provider's endpoint/credentials via a small helper), NOT a synthetic generation job. Task 5 details this.
- **Commit trailer:** end every commit with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. **Branch `record-intent` (already checked out); never main. Nothing pushed.**
- **Tests:** DB-gated tests read `MEMSMITH_TEST_POSTGRES_URL` + isolated schema (existing pattern in `tests/storage/postgres/observation-embedding.test.ts`); skip cleanly when absent. Do NOT boot the runtime on port 55433 in tests.

---

## File Structure

- **Modify** `src/storage/postgres/schema.ts` — add `idempotency_key TEXT` column to `observations` + a partial unique index (`WHERE idempotency_key IS NOT NULL`).
- **Create** `src/storage/postgres/migrations/00X_observation_idempotency.sql` — the migration adding the column + index.
- **Modify** `src/storage/postgres/observations.ts` — `create()` accepts `idempotencyKey`; a manual-insert path (or the same insert) does `ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`; add `computeContentIdempotencyKey(...)` helper; add `userDirected` filter to `search`/`hybridSearch`.
- **Create** `src/services/retrieval/record-intent-key.ts` — the shared deterministic key hash (used by MCP add path + backstop, so both layers compute the same key).
- **Modify** `src/servers/mcp-server.ts` — `observation_add` accepts `idempotencyKey`; threads it into the request.
- **Modify** `src/services/hooks/server-client.ts` — `ServerAddObservationRequest` gains `idempotencyKey?`.
- **Modify** `src/server/routes/v1/ServerV1PostgresRoutes.ts` — `/v1/memories` accepts + passes `idempotencyKey`; `/v1/search`+`/v1/context` accept `userDirected`; `resolveSearchResults` applies a `userDirectedBoost` post-rank transform.
- **Create** `src/server/generation/provider-complete.ts` — a minimal `providerComplete(provider, systemPrompt, userText)` helper doing a plain chat-completion via the resolved provider (backstop's classify+compose), NOT obs-XML.
- **Create** `src/server/routes/v1/record-intent.ts` (or a handler within the v1 routes) — `POST /v1/record-intent`: classify+compose via `providerComplete`, write on yes.
- **Modify** `src/cli/handlers/` — add a `record-intent` hook handler (UserPromptSubmit → POST /v1/record-intent) + register in `index.ts`.
- **Modify** `plugin/hooks/hooks.json` — add the `record-intent` UserPromptSubmit hook (alongside existing).
- **Modify** `src/services/retrieval/directive.ts` — add the record-intent directive constant + include it in the injected directive.
- **Modify** `src/server/dashboard/queries.ts` — add `userNotes(db, scope)`; **Modify** `src/server/dashboard/routes.ts` — add `GET /dashboard/notes`.
- **Modify** `src/ui/viewer/views/DashboardView.tsx` — add a Notes panel; **Modify** `src/ui/viewer/views/ObservationsView.tsx` — add a "My notes" filter chip.
- **Modify** `src/shared/SettingsDefaultsManager.ts` + `src/server/settings/settingKeys.ts` — add `MEMSMITH_USER_NOTE_BOOST`, `MEMSMITH_RECORD_INTENT_BACKSTOP`.

**Interfaces reference (verbatim from current code):**
- `PostgresObservationRepository.create(input: {..., kind?, content, metadata?, embeddingVec?, generationKey?})` — add `idempotencyKey?: string | null`.
- `repo.search`/`hybridSearch(input: { projectId, teamId, query, limit?, obsType?, lifecycleState?, platformSource?, ... })` — optional-filter idiom `AND ($N::text IS NULL OR col = $N)`.
- `resolveSearchResults(input: { projectId, teamId, query, limit, platformSource, mode })` → ranks then `applySupersession` in try/catch (the post-rank seam).
- `GenerationProviderHolder.current(teamId): Promise<ServerGenerationProvider | null>`.
- Ollama provider hits chat-completions: `POST <base>/v1/chat/completions`, reads `data.choices[0].message.content`.
- `ObservationAddArgs { projectId?, serverSessionId?, kind?, content, metadata? }` + `ServerAddObservationRequest { projectId, serverSessionId?, kind?, content, metadata? }`.
- Dashboard route idiom: `app.get('/dashboard/<name>', ...mw, asyncHandler(async (req,res) => {...}))`; query idiom: `SELECT ... FROM observations WHERE ${scope.sql} AND <pred> ORDER BY ...`.
- `MEMORY_FIRST_DIRECTIVE` in `directive.ts` (the injected directive string, delivered by SessionStart/UserPromptSubmit hooks).

---

### Task 1: The shared content-idempotency key

**Files:**
- Create: `src/services/retrieval/record-intent-key.ts`
- Test: `tests/retrieval/record-intent-key.test.ts`

**Interfaces:**
- Produces: `export function computeContentIdempotencyKey(input: { teamId: string; projectId: string; kind: string; content: string }): string` — deterministic; normalizes content (trim, collapse internal whitespace, lowercase) before hashing so trivial variations collapse; returns a stable `record-intent:v1:<sha256hex>` string.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/retrieval/record-intent-key.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { computeContentIdempotencyKey } from '../../src/services/retrieval/record-intent-key.js';

const base = { teamId: 't1', projectId: 'p1', kind: 'user_note' };

describe('computeContentIdempotencyKey', () => {
  it('is deterministic for identical input', () => {
    const a = computeContentIdempotencyKey({ ...base, content: 'we chose postgres' });
    const b = computeContentIdempotencyKey({ ...base, content: 'we chose postgres' });
    expect(a).toBe(b);
    expect(a.startsWith('record-intent:v1:')).toBe(true);
  });
  it('normalizes trivial whitespace/case differences to the same key', () => {
    const a = computeContentIdempotencyKey({ ...base, content: 'We chose Postgres' });
    const b = computeContentIdempotencyKey({ ...base, content: '  we   chose   postgres ' });
    expect(a).toBe(b);
  });
  it('differs on team, project, kind, or meaningfully-different content', () => {
    const a = computeContentIdempotencyKey({ ...base, content: 'we chose postgres' });
    expect(computeContentIdempotencyKey({ ...base, teamId: 't2', content: 'we chose postgres' })).not.toBe(a);
    expect(computeContentIdempotencyKey({ ...base, projectId: 'p2', content: 'we chose postgres' })).not.toBe(a);
    expect(computeContentIdempotencyKey({ ...base, kind: 'observation', content: 'we chose postgres' })).not.toBe(a);
    expect(computeContentIdempotencyKey({ ...base, content: 'we chose sqlite' })).not.toBe(a);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/retrieval/record-intent-key.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/services/retrieval/record-intent-key.ts
// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'crypto';

// Deterministic content-idempotency key for manual record-intent writes. Both
// detection layers (agent + server-provider backstop) and any retry compute the
// SAME key for the same note, so the DB insert collapses them to one row.
// Content is normalized (trim, collapse whitespace, lowercase) so trivial
// re-phrasings of the identical note still dedup.
export function computeContentIdempotencyKey(input: {
  teamId: string;
  projectId: string;
  kind: string;
  content: string;
}): string {
  const normalized = input.content.trim().replace(/\s+/g, ' ').toLowerCase();
  const h = createHash('sha256')
    .update(`${input.teamId} ${input.projectId} ${input.kind} ${normalized}`)
    .digest('hex');
  return `record-intent:v1:${h}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/retrieval/record-intent-key.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/retrieval/record-intent-key.ts tests/retrieval/record-intent-key.test.ts
git commit -m "feat(record-intent): deterministic content-idempotency key

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Schema + repo — idempotency column and idempotent manual write

**Files:**
- Modify: `src/storage/postgres/schema.ts` (observations table + index)
- Create: `src/storage/postgres/migrations/00X_observation_idempotency.sql` (use the next migration number; check existing files in that dir)
- Modify: `src/storage/postgres/observations.ts` (`create()` accepts + writes `idempotencyKey`; manual conflict path)
- Test: `tests/storage/postgres/observation-idempotency.test.ts`

**Interfaces:**
- Consumes: `computeContentIdempotencyKey` (Task 1).
- Produces: `repo.create({..., idempotencyKey?: string | null})` — when `idempotencyKey` is set and a row with that key already exists (same team/project), the insert is a no-op returning the existing row (or the create is fronted by an idempotent path). `ObservationRow`/`PostgresObservation` gain `idempotencyKey: string | null`.

**Implementation note on the ON CONFLICT constraint:** the existing INSERT has `ON CONFLICT (team_id, project_id, generation_key) WHERE generation_key IS NOT NULL`. Postgres allows only one `ON CONFLICT` per statement. Resolve by: for manual writes (generation_key null, idempotency_key set), do a **guarded upsert** — attempt `INSERT ... ON CONFLICT (team_id, project_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`, and if it returns no row (conflict), `SELECT` the existing row by (team_id, project_id, idempotency_key). Keep the generation path's existing conflict clause unchanged by branching: if `input.idempotencyKey` is set use the idempotency-conflict INSERT variant; else use the current generation_key variant. Add BOTH partial unique indexes (they don't collide — different partial predicates).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/storage/postgres/observation-idempotency.test.ts
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';
import { computeContentIdempotencyKey } from '../../../src/services/retrieval/record-intent-key.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('observation content-idempotency (manual record-intent writes)', () => {
  if (!testDatabaseUrl) { it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {}); return; }
  let pool: pg.Pool; let client: any; let schemaName: string;
  let teamId: string; let projectId: string; let repo: PostgresObservationRepository;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
    client = await pool.connect();
    schemaName = `cm_idem_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`);
    await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 't' });
    const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id; projectId = project.id;
    repo = new PostgresObservationRepository(client);
  });
  afterEach(async () => {
    await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(() => {});
    client.release(); await pool.end();
  });

  it('two inserts with the same idempotency key produce exactly ONE row', async () => {
    const content = 'Decision: use embedded Postgres for the local runtime.';
    const key = computeContentIdempotencyKey({ teamId, projectId, kind: 'user_note', content });
    await repo.create({ projectId, teamId, kind: 'user_note', content, idempotencyKey: key });
    await repo.create({ projectId, teamId, kind: 'user_note', content, idempotencyKey: key });
    const { rows } = await client.query(
      `SELECT count(*)::int n FROM observations WHERE team_id=$1 AND project_id=$2 AND idempotency_key=$3`,
      [teamId, projectId, key],
    );
    expect(rows[0].n).toBe(1);
  });

  it('inserts WITHOUT an idempotency key are not deduped (independent rows)', async () => {
    await repo.create({ projectId, teamId, kind: 'user_note', content: 'same text' });
    await repo.create({ projectId, teamId, kind: 'user_note', content: 'same text' });
    const { rows } = await client.query(
      `SELECT count(*)::int n FROM observations WHERE team_id=$1 AND project_id=$2 AND kind='user_note'`,
      [teamId, projectId],
    );
    expect(rows[0].n).toBe(2); // no key → no dedup (preserves existing behavior)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" MEMSMITH_TEST_POSTGRES_URL="postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres" ~/.bun/bin/bun test tests/storage/postgres/observation-idempotency.test.ts`
Expected: FAIL — `idempotency_key` column doesn't exist / `idempotencyKey` not accepted (first test would see 2 rows).

- [ ] **Step 3: Add the column + index in schema.ts and a migration**

In `src/storage/postgres/schema.ts`, in the `observations` table definition, add:
```sql
  idempotency_key TEXT,
```
and after the table, add a partial unique index (mirror the existing generation_key partial-unique pattern):
```sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_observations_idempotency
  ON observations (team_id, project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```
Create `src/storage/postgres/migrations/00X_observation_idempotency.sql` (next number; inspect the dir) with the `ALTER TABLE observations ADD COLUMN IF NOT EXISTS idempotency_key TEXT;` + the same `CREATE UNIQUE INDEX IF NOT EXISTS`.

- [ ] **Step 4: Thread `idempotencyKey` through `create()`**

In `src/storage/postgres/observations.ts`:
- Add `idempotencyKey?: string | null` to `create`'s input type and to `ObservationRow`/`PostgresObservation` + `mapObservationRow` (`idempotencyKey: row.idempotency_key`).
- Add `idempotency_key` to the INSERT column list and a `$N` value (`input.idempotencyKey ?? null`).
- Branch the conflict handling: when `input.idempotencyKey` is set, use `ON CONFLICT (team_id, project_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`, and when that returns no row, `SELECT * FROM observations WHERE team_id=$ AND project_id=$ AND idempotency_key=$` and return it. When `idempotencyKey` is null, keep the existing generation_key conflict INSERT exactly as-is.
- Add `export function computeContentIdempotencyKey` re-export is NOT needed — it lives in `record-intent-key.ts`; import it where the write path composes the key (Task 4/5), not in the repo.

- [ ] **Step 5: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" MEMSMITH_TEST_POSTGRES_URL="postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres" ~/.bun/bin/bun test tests/storage/postgres/observation-idempotency.test.ts`
Expected: PASS (2 tests). Also run the existing embedding test to confirm no regression: `... bun test tests/storage/postgres/observation-embedding.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/storage/postgres/schema.ts src/storage/postgres/migrations/ src/storage/postgres/observations.ts tests/storage/postgres/observation-idempotency.test.ts
git commit -m "feat(record-intent): idempotency_key column + idempotent manual write path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Thread `idempotencyKey` through the write API (MCP + client + route)

**Files:**
- Modify: `src/services/hooks/server-client.ts` (`ServerAddObservationRequest`)
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (`/v1/memories` schema + handler)
- Modify: `src/servers/mcp-server.ts` (`ObservationAddArgs` + handler)
- Test: extend `tests/storage/postgres/observation-idempotency.test.ts` OR a route-level test if one exists; if not, a focused unit test asserting the schema accepts + forwards the field.

**Interfaces:**
- Consumes: Task 2's `repo.create({idempotencyKey})`.
- Produces: `ServerAddObservationRequest` gains `idempotencyKey?: string | null`; `/v1/memories` body schema accepts `idempotencyKey?`; `observation_add` MCP tool accepts `idempotencyKey?` and forwards it.

- [ ] **Step 1: Write the failing test**

```typescript
// Append to tests/storage/postgres/observation-idempotency.test.ts
  it('the /v1/memories create input shape carries idempotencyKey to repo.create', async () => {
    // Exercise the same create path the route uses, asserting the key reaches storage.
    const content = 'Route-path note';
    const key = computeContentIdempotencyKey({ teamId, projectId, kind: 'user_note', content });
    const obs = await repo.create({ projectId, teamId, kind: 'user_note', content, idempotencyKey: key });
    expect((obs as any).idempotencyKey).toBe(key);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" MEMSMITH_TEST_POSTGRES_URL="postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres" ~/.bun/bin/bun test tests/storage/postgres/observation-idempotency.test.ts -t "carries idempotencyKey"`
Expected: FAIL — `obs.idempotencyKey` undefined (mapObservationRow not returning it yet, if Task 2 didn't add it) OR PASS if Task 2 already mapped it (in which case this documents the contract). If it passes immediately because Task 2 mapped the field, that is acceptable — it locks the contract.

- [ ] **Step 3: Add `idempotencyKey` to the client request type**

In `src/services/hooks/server-client.ts`, add to `ServerAddObservationRequest`:
```typescript
  idempotencyKey?: string | null;
```
and in `buildAddObservationPayload` (or wherever the payload is built), include `...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {})`.

- [ ] **Step 4: Accept it on the `/v1/memories` route**

In `src/server/routes/v1/ServerV1PostgresRoutes.ts` `POST /v1/memories` zod schema, add `idempotencyKey: z.string().min(1).optional()`, and in `createInput` add `idempotencyKey: body.idempotencyKey ?? null`.

- [ ] **Step 5: Accept it on the MCP `observation_add` tool**

In `src/servers/mcp-server.ts`, add `idempotencyKey?: string` to `ObservationAddArgs`, and in the request build add `...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {})`. Add `idempotencyKey` to the tool's JSON input schema (optional string).

- [ ] **Step 6: Run + typecheck**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -viE "bun:test|node_modules|tests/" | head || echo clean`
Then the idempotency test: `... MEMSMITH_TEST_POSTGRES_URL=... bun test tests/storage/postgres/observation-idempotency.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/hooks/server-client.ts src/server/routes/v1/ServerV1PostgresRoutes.ts src/servers/mcp-server.ts tests/storage/postgres/observation-idempotency.test.ts
git commit -m "feat(record-intent): thread idempotencyKey through observation_add/​/v1/memories

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `userDirected` search filter (repo + routes)

**Files:**
- Modify: `src/storage/postgres/observations.ts` (`search` + `hybridSearch` accept `userDirected`)
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (`/v1/search` + `/v1/context` schemas + `resolveSearchResults` pass-through)
- Test: `tests/storage/postgres/user-directed-filter.test.ts`

**Interfaces:**
- Produces: `search`/`hybridSearch` accept `userDirected?: boolean`; when true, restrict to `kind='user_note'`. `/v1/search` + `/v1/context` accept `userDirected?: boolean`. `resolveSearchResults` gains `userDirected?: boolean` in its input and forwards it.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/storage/postgres/user-directed-filter.test.ts
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"', '""')}"`;

describe('userDirected search filter', () => {
  if (!testDatabaseUrl) { it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {}); return; }
  let pool: pg.Pool; let client: any; let schemaName: string;
  let teamId: string; let projectId: string; let repo: PostgresObservationRepository;
  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
    client = await pool.connect();
    schemaName = `cm_ud_${randomUUID().replaceAll('-', '_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`); await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 't' }); const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id; projectId = project.id; repo = new PostgresObservationRepository(client);
    await repo.create({ projectId, teamId, kind: 'user_note', content: 'auth uses JWT tokens for sessions' });
    await repo.create({ projectId, teamId, kind: 'observation', content: 'auth middleware validates JWT tokens' });
  });
  afterEach(async () => { await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(()=>{}); client.release(); await pool.end(); });

  it('userDirected:true returns ONLY user_note rows', async () => {
    const hits = await repo.search({ projectId, teamId, query: 'auth JWT', userDirected: true });
    expect(hits.length).toBe(1);
    expect(hits[0].kind).toBe('user_note');
  });
  it('unfiltered returns both', async () => {
    const hits = await repo.search({ projectId, teamId, query: 'auth JWT' });
    expect(hits.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" MEMSMITH_TEST_POSTGRES_URL="postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres" ~/.bun/bin/bun test tests/storage/postgres/user-directed-filter.test.ts`
Expected: FAIL — `userDirected` not a valid input / both rows returned.

- [ ] **Step 3: Add the filter to `search` (and `hybridSearch` forwards it to its FTS arm via `search`)**

In `src/storage/postgres/observations.ts` `search(input)`: add `userDirected?: boolean` to the input type. Add a parameterized predicate following the existing `obsType` idiom (line ~178). Because the existing filters bind `$5`/`$6`, add a new parameter (next index) and clause:
```sql
          AND ($N::boolean IS NOT TRUE OR kind = 'user_note')
```
bound to `input.userDirected ?? null`. In `hybridSearch`, thread `userDirected` into the `this.search({...})` call for its FTS arm AND filter the vector arm results by `kind==='user_note'` when `userDirected` is true (the vector arm returns full rows; filter in JS after fetch, or add the same predicate to `multiVectorSearch`'s query — prefer the JS filter on the fused result for simplicity: after fusion, `if (input.userDirected) results = results.filter(o => o.kind === 'user_note')`).

- [ ] **Step 4: Accept `userDirected` on the routes**

In `ServerV1PostgresRoutes.ts`, add `userDirected: z.boolean().optional()` to the `/v1/search` and `/v1/context` body schemas, and add `userDirected?: boolean` to `resolveSearchResults`'s input, forwarding it into `searchInput` so both `repo.search` and `repo.hybridSearch` receive it.

- [ ] **Step 5: Run + typecheck**

Run: `... MEMSMITH_TEST_POSTGRES_URL=... bun test tests/storage/postgres/user-directed-filter.test.ts` → PASS (2).
Run: `... bunx tsc --noEmit 2>&1 | grep "error TS" | grep -viE "bun:test|node_modules|tests/" || echo clean` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/storage/postgres/observations.ts src/server/routes/v1/ServerV1PostgresRoutes.ts tests/storage/postgres/user-directed-filter.test.ts
git commit -m "feat(record-intent): userDirected search filter (repo + /v1/search + /v1/context)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `userDirected` boost transform (post-rank, tunable) + settings

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts` + `src/server/settings/settingKeys.ts` (`MEMSMITH_USER_NOTE_BOOST`)
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (`resolveSearchResults` post-rank boost)
- Test: `tests/server/user-note-boost.test.ts` (pure reorder unit) + an integration assertion in the filter test file.

**Interfaces:**
- Produces: a pure `boostUserDirected(ranked: PostgresObservation[], strength: number): PostgresObservation[]` reorder (stable; moves `kind==='user_note'` ahead of ambient within the already-ranked list; `strength===0` → unchanged), applied in `resolveSearchResults` after ranking (and composable with supersession). Setting `MEMSMITH_USER_NOTE_BOOST` (default conservative, e.g. `'1'`; `'0'` = off).

- [ ] **Step 1: Write the failing test (pure reorder)**

```typescript
// tests/server/user-note-boost.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { boostUserDirected } from '../../src/server/routes/v1/user-note-boost.js';

const obs = (id: string, kind: string) => ({ id, kind, content: id, projectId: 'p', teamId: 't', metadata: {} } as any);

describe('boostUserDirected', () => {
  it('strength>0 stable-reorders user_note ahead of ambient, preserving relative order within each group', () => {
    const ranked = [obs('a','observation'), obs('b','user_note'), obs('c','observation'), obs('d','user_note')];
    const out = boostUserDirected(ranked, 1).map(o => o.id);
    expect(out).toEqual(['b','d','a','c']); // notes first (b before d), ambient after (a before c)
  });
  it('strength=0 leaves order unchanged', () => {
    const ranked = [obs('a','observation'), obs('b','user_note')];
    expect(boostUserDirected(ranked, 0).map(o=>o.id)).toEqual(['a','b']);
  });
  it('only reorders within the given (already-relevant) set — never adds rows', () => {
    const ranked = [obs('a','observation'), obs('b','user_note')];
    expect(boostUserDirected(ranked, 1).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/server/user-note-boost.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure reorder**

```typescript
// src/server/routes/v1/user-note-boost.ts
// SPDX-License-Identifier: Apache-2.0
import type { PostgresObservation } from '../../../storage/postgres/observations.js';

// Post-ranking reorder: float user-directed notes ahead of ambient observations
// WITHIN the already-relevant ranked set (never adds/removes rows). Stable —
// preserves relative order inside each group. strength<=0 is a no-op. This is
// "boost-within-relevant": a note irrelevant to the query is not in `ranked`, so
// it is never surfaced by this transform. Fail-safe: returns input on any issue.
export function boostUserDirected(ranked: PostgresObservation[], strength: number): PostgresObservation[] {
  if (!Array.isArray(ranked) || strength <= 0 || ranked.length < 2) return ranked;
  const notes: PostgresObservation[] = [];
  const rest: PostgresObservation[] = [];
  for (const o of ranked) (o.kind === 'user_note' ? notes : rest).push(o);
  if (notes.length === 0 || rest.length === 0) return ranked;
  return [...notes, ...rest];
}
```
(Note: `strength` is currently a boolean-ish gate; the value is reserved for a future graded blend. Documented as such — a `>0` boost floats notes to the top of the relevant set. This is the conservative default behavior; a future graded version can interleave by rank×strength without changing the signature.)

- [ ] **Step 4: Wire into `resolveSearchResults` + add the setting**

In `SettingsDefaultsManager.ts` add interface field `MEMSMITH_USER_NOTE_BOOST: string;` and default `MEMSMITH_USER_NOTE_BOOST: '1',` (near the other retrieval knobs). Add a `settingKeys.ts` entry (mirror `ftsWeight`): `{ key: 'userNoteBoost', type: 'number', env: 'MEMSMITH_USER_NOTE_BOOST', default: 1, boot: false, min: 0, max: 10, label: 'User-note boost', description: 'How strongly explicitly-saved notes are floated up in recall (0 = off).', help: '...' }`.
In `ServerV1PostgresRoutes.ts` `resolveSearchResults`, after `const ranked = ...` and BEFORE `applySupersession`, apply the boost:
```typescript
    const boost = Number(process.env.MEMSMITH_USER_NOTE_BOOST ?? '1'); // resolver-aware if a resolver getter is added; env fallback for now
    let boosted = ranked;
    try { boosted = boostUserDirected(ranked, boost); } catch { boosted = ranked; }  // fail-open
```
then pass `boosted` (not `ranked`) into `applySupersession`. Import `boostUserDirected`. (If a `settingsResolver.userNoteBoost(teamId)` getter is trivially addable following the existing weights/rrfK getters, prefer it; otherwise the env read is acceptable and matches the pattern used before resolver-threading — note which you did.)

- [ ] **Step 5: Run + typecheck**

Run: `... bun test tests/server/user-note-boost.test.ts` → PASS (3). `... bunx tsc --noEmit | grep "error TS" | grep -viE "bun:test|node_modules|tests/" || echo clean` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/v1/user-note-boost.ts src/server/routes/v1/ServerV1PostgresRoutes.ts src/shared/SettingsDefaultsManager.ts src/server/settings/settingKeys.ts tests/server/user-note-boost.test.ts
git commit -m "feat(record-intent): userDirected post-rank boost + MEMSMITH_USER_NOTE_BOOST knob

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: The record-intent directive (Layer 1 — agent detection)

**Files:**
- Modify: `src/services/retrieval/directive.ts` (add the record-intent directive; include in the injected text)
- Test: `tests/retrieval/record-intent-directive.test.ts`

**Interfaces:**
- Produces: `export const RECORD_INTENT_DIRECTIVE: string`; the module's injected directive (whatever the SessionStart/UserPromptSubmit handlers read) now includes it.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/retrieval/record-intent-directive.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { RECORD_INTENT_DIRECTIVE } from '../../src/services/retrieval/directive.js';

describe('RECORD_INTENT_DIRECTIVE', () => {
  it('names the record verbs and the enforced write', () => {
    const t = RECORD_INTENT_DIRECTIVE.toLowerCase();
    expect(t).toMatch(/remember|record|log|park|mark|save/);
    expect(t).toContain('observation_add');
    expect(t).toMatch(/user_note/);
  });
  it('instructs self-contained composition + confirmation + surface-on-failure', () => {
    const t = RECORD_INTENT_DIRECTIVE.toLowerCase();
    expect(t).toMatch(/self-contained|standalone|compose/);
    expect(t).toMatch(/confirm|recorded/);
    expect(t).toMatch(/fail|couldn't|could not|surface/);
  });
  it('is MemSmith-native (no claude-mem)', () => {
    expect(RECORD_INTENT_DIRECTIVE.toLowerCase()).not.toContain('claude-mem');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/retrieval/record-intent-directive.test.ts`
Expected: FAIL — `RECORD_INTENT_DIRECTIVE` not exported.

- [ ] **Step 3: Implement**

In `src/services/retrieval/directive.ts`, add:
```typescript
export const RECORD_INTENT_DIRECTIVE = [
  'RECORD-INTENT (MemSmith core behavior):',
  'When the user asks you to record/remember/log/park/mark/save something to memory —',
  'in any natural phrasing — you MUST capture it: compose a SELF-CONTAINED observation',
  'from the conversation (resolve "that"/"it" into a standalone note), then call the',
  'observation_add tool with kind:"user_note" and metadata.userDirected:true. Then echo',
  'a one-line confirmation: "📝 Recorded to memory: <summary>". If the write fails,',
  'say so plainly ("⚠ Couldn\'t record to memory — say it again / I\'ll retry"); never',
  'record the note to a file (TODO.md, CLAUDE.md, etc.) unless the user explicitly asks',
  'for a file. Memory is the record.',
].join('\n');
```
Then ensure it is part of the directive the hooks inject. Find where `MEMORY_FIRST_DIRECTIVE` is consumed by the SessionStart/UserPromptSubmit handlers and append `RECORD_INTENT_DIRECTIVE` alongside it (e.g. export a combined `INJECTED_DIRECTIVES = [MEMORY_FIRST_DIRECTIVE, RECORD_INTENT_DIRECTIVE].join('\n\n')` and have the handlers use that, OR add the constant to each injection site). Do this at the single point the handlers read, to avoid drift.

- [ ] **Step 4: Run to verify it passes**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/retrieval/record-intent-directive.test.ts`
Expected: PASS (3).

- [ ] **Step 5: Commit**

```bash
git add src/services/retrieval/directive.ts tests/retrieval/record-intent-directive.test.ts
git commit -m "feat(record-intent): agent-layer directive (Layer 1 detection)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Provider completion helper (for the backstop's classify+compose)

**Files:**
- Create: `src/server/generation/provider-complete.ts`
- Test: `tests/server/generation/provider-complete.test.ts`

**Interfaces:**
- Produces: `export async function providerComplete(input: { provider: ServerGenerationProvider; system: string; user: string }): Promise<string | null>` — does a plain chat-completion using the provider's configured endpoint/model, returns the text (or null on any failure — never throws). MUST NOT build a `ServerGenerationContext` / obs-XML.

**Design note:** The `ServerGenerationProvider` interface only exposes `generate(context, ...)` for obs-XML. Rather than fabricate a job context, `providerComplete` performs its own minimal chat-completion. For Ollama that is `POST <base>/v1/chat/completions` with `{ model, messages:[{role:'system',content:system},{role:'user',content:user}], stream:false }` reading `data.choices[0].message.content` — the exact shape `OllamaObservationProvider` already uses. Implement for the Ollama provider first (the local dogfood default); other providers can be added when needed (return null / fall through for providers not yet supported, which fail-open to Layer-1-only). Read the provider's base URL/model the same way `OllamaObservationProvider` does (constructor options / env `OLLAMA_URL`, `MEMSMITH_SERVER_MODEL`). Keep it small and dependency-injectable (accept a `fetchImpl` param defaulting to global fetch) so the test stubs the HTTP.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/generation/provider-complete.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { providerComplete } from '../../../src/server/generation/provider-complete.js';

const ollamaProvider = { providerLabel: 'ollama' } as any;

describe('providerComplete', () => {
  it('returns the completion text for a chat-completions response', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'YES: composed note' } }] }), { status: 200 });
    const out = await providerComplete({ provider: ollamaProvider, system: 's', user: 'u' }, { fetchImpl } as any);
    expect(out).toBe('YES: composed note');
  });
  it('returns null on HTTP error, never throws', async () => {
    const fetchImpl = async () => new Response('nope', { status: 500 });
    const out = await providerComplete({ provider: ollamaProvider, system: 's', user: 'u' }, { fetchImpl } as any);
    expect(out).toBeNull();
  });
  it('returns null when fetch throws, never throws', async () => {
    const fetchImpl = async () => { throw new Error('down'); };
    let threw = false; let out: string | null = 'x';
    try { out = await providerComplete({ provider: ollamaProvider, system: 's', user: 'u' }, { fetchImpl } as any); } catch { threw = true; }
    expect(threw).toBe(false); expect(out).toBeNull();
  });
  it('returns null for a provider it does not support (fail-open to Layer 1)', async () => {
    const out = await providerComplete({ provider: { providerLabel: 'gemini' } as any, system: 's', user: 'u' }, {} as any);
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/server/generation/provider-complete.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/server/generation/provider-complete.ts
// SPDX-License-Identifier: Apache-2.0
import type { ServerGenerationProvider } from './providers/shared/types.js';
import { logger } from '../../utils/logger.js';

interface Deps { fetchImpl?: typeof fetch }

// Minimal plain chat-completion using the resolved provider — for the record-
// intent backstop's classify+compose. Deliberately NOT the obs-XML generate()
// path. Never throws; returns null on any failure (fail-open → Layer-1-only).
// Ollama first (local dogfood default); unsupported providers return null.
export async function providerComplete(
  input: { provider: ServerGenerationProvider; system: string; user: string },
  deps: Deps = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    if (input.provider.providerLabel !== 'ollama') return null; // extend later
    const base = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');
    const url = base.endsWith('/v1/chat/completions') ? base : `${base}/v1/chat/completions`;
    const model = process.env.MEMSMITH_SERVER_MODEL ?? 'llama3.1:8b';
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ] }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch (error) {
    logger.debug('SYSTEM', 'providerComplete failed (fail-open)', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/server/generation/provider-complete.test.ts`
Expected: PASS (4).

- [ ] **Step 5: Commit**

```bash
git add src/server/generation/provider-complete.ts tests/server/generation/provider-complete.test.ts
git commit -m "feat(record-intent): minimal provider chat-completion helper (backstop brain)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: `POST /v1/record-intent` endpoint (Layer 2 — server backstop)

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (register `POST /v1/record-intent`)
- Test: `tests/server/record-intent-endpoint.test.ts` (handler logic with a stubbed provider-complete + fake repo)

**Interfaces:**
- Consumes: `providerComplete` (Task 7), `GenerationProviderHolder.current` (existing), `repo.create({idempotencyKey})` (Task 2), `computeContentIdempotencyKey` (Task 1).
- Produces: `POST /v1/record-intent { prompt: string, projectId? }` → asks the provider "is this record-intent? if so compose the note" → on yes, writes a marked observation with the deterministic idempotency key → returns `{ recorded: boolean, content?: string }`. Fail-open: provider null/no → `{ recorded: false }`, 200. Gated by `MEMSMITH_RECORD_INTENT_BACKSTOP` (Task 9 adds the setting; the endpoint itself always exists — the hook decides whether to call it).

**Classify+compose prompt contract:** the system prompt instructs the provider to reply with either `NONE` (not a record request) or `RECORD: <self-contained note>`. The handler parses: if the reply starts with `RECORD:`, take the remainder as content and write it; else no-op. This keeps parsing trivial and deterministic.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/record-intent-endpoint.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { classifyAndComposeRecordIntent } from '../../src/server/routes/v1/record-intent.js';

// Unit-test the pure classify/parse + write-decision logic with injected deps.
describe('classifyAndComposeRecordIntent', () => {
  const writes: any[] = [];
  const deps = (reply: string | null) => ({
    complete: async () => reply,
    write: async (o: any) => { writes.push(o); return { id: 'x' }; },
    teamId: 't', projectId: 'p',
  });
  it('RECORD: reply writes a marked user_note with an idempotency key', async () => {
    writes.length = 0;
    const r = await classifyAndComposeRecordIntent('remember we chose postgres', deps('RECORD: We chose Postgres for concurrent writers.') as any);
    expect(r.recorded).toBe(true);
    expect(writes.length).toBe(1);
    expect(writes[0].kind).toBe('user_note');
    expect(writes[0].metadata.userDirected).toBe(true);
    expect(typeof writes[0].idempotencyKey).toBe('string');
    expect(writes[0].content).toContain('Postgres');
  });
  it('NONE reply records nothing', async () => {
    writes.length = 0;
    const r = await classifyAndComposeRecordIntent('what is the weather', deps('NONE') as any);
    expect(r.recorded).toBe(false);
    expect(writes.length).toBe(0);
  });
  it('null completion (provider failed) records nothing, no throw', async () => {
    writes.length = 0;
    const r = await classifyAndComposeRecordIntent('remember x', deps(null) as any);
    expect(r.recorded).toBe(false);
    expect(writes.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/server/record-intent-endpoint.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure logic module**

```typescript
// src/server/routes/v1/record-intent.ts
// SPDX-License-Identifier: Apache-2.0
import { computeContentIdempotencyKey } from '../../../services/retrieval/record-intent-key.js';

export const RECORD_INTENT_SYSTEM = [
  'You decide whether the user is asking to SAVE/RECORD something to memory',
  '(remember, record, log, park, mark, save, note for later, etc. — any phrasing).',
  'If YES, reply exactly "RECORD: " followed by a self-contained one-paragraph note',
  'capturing what to remember (resolve pronouns; make it standalone).',
  'If NO, reply exactly "NONE". Reply with nothing else.',
].join(' ');

export interface RecordIntentDeps {
  complete: (system: string, user: string) => Promise<string | null>;
  write: (o: { projectId: string; teamId: string; kind: string; content: string; metadata: Record<string, unknown>; idempotencyKey: string }) => Promise<{ id: string }>;
  teamId: string;
  projectId: string;
}

export async function classifyAndComposeRecordIntent(prompt: string, deps: RecordIntentDeps): Promise<{ recorded: boolean; content?: string }> {
  const reply = await deps.complete(RECORD_INTENT_SYSTEM, prompt);
  if (!reply) return { recorded: false };
  const m = reply.trim().match(/^RECORD:\s*([\s\S]+)$/i);
  if (!m) return { recorded: false };
  const content = m[1].trim();
  if (!content) return { recorded: false };
  const idempotencyKey = computeContentIdempotencyKey({ teamId: deps.teamId, projectId: deps.projectId, kind: 'user_note', content });
  await deps.write({ projectId: deps.projectId, teamId: deps.teamId, kind: 'user_note', content, metadata: { userDirected: true }, idempotencyKey });
  return { recorded: true, content };
}
```

- [ ] **Step 4: Register the route (wiring the pure logic to provider + repo)**

In `ServerV1PostgresRoutes.ts`, register `app.post('/v1/record-intent', writeAuth, this.handleCreate(z.object({ prompt: z.string().min(1), projectId: z.string().min(1).optional() }), async (req, res, body) => {...}))`. In the handler: resolve teamId/projectId (scope), get the provider via the holder, build `deps` with `complete: (s,u) => providerComplete({ provider, system:s, user:u })` and `write: (o) => new PostgresObservationRepository(this.options.pool).create(o)`, call `classifyAndComposeRecordIntent(body.prompt, deps)`, and `res.json(result)`. Wrap in try/catch → on error `res.json({ recorded: false })` (fail-open, never 500 the hot path).

- [ ] **Step 5: Run + typecheck**

Run: `... bun test tests/server/record-intent-endpoint.test.ts` → PASS (3). `... bunx tsc --noEmit | grep "error TS" | grep -viE "bun:test|node_modules|tests/" || echo clean` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/v1/record-intent.ts src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/record-intent-endpoint.test.ts
git commit -m "feat(record-intent): POST /v1/record-intent backstop endpoint (Layer 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: The `record-intent` hook (UserPromptSubmit → backstop) + setting + hooks.json

**Files:**
- Create: `src/cli/handlers/record-intent.ts`
- Modify: `src/cli/handlers/index.ts` (register `record-intent`)
- Modify: `src/shared/SettingsDefaultsManager.ts` (`MEMSMITH_RECORD_INTENT_BACKSTOP`)
- Modify: `plugin/hooks/hooks.json` (UserPromptSubmit → record-intent)
- Test: `tests/cli/handlers/record-intent-hook.test.ts` + `tests/plugin/hooks-record-intent.test.ts`

**Interfaces:**
- Consumes: `resolveRuntimeContext`, `loadFromFileOnce`, the `/v1/record-intent` endpoint (Task 8).
- Produces: `recordIntentHandler: EventHandler` (registry key `'record-intent'`); it POSTs the prompt to `/v1/record-intent` when the backstop is enabled; fail-open (never blocks the prompt). Setting `MEMSMITH_RECORD_INTENT_BACKSTOP` (default `'true'`).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/cli/handlers/record-intent-hook.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { recordIntentHandler } from '../../../src/cli/handlers/record-intent.js';

describe('recordIntentHandler', () => {
  it('returns a continue result and never throws when no runtime', async () => {
    const res = await recordIntentHandler.execute({ sessionId: 's', cwd: '/tmp', prompt: 'remember X' } as any);
    expect(res.continue).toBe(true);
  });
  it('empty prompt → clean skip', async () => {
    const res = await recordIntentHandler.execute({ sessionId: 's', cwd: '/tmp', prompt: '' } as any);
    expect(res.continue).toBe(true);
  });
});
```
```typescript
// tests/plugin/hooks-record-intent.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs'; import { join } from 'path';
const hooks = JSON.parse(readFileSync(join(process.cwd(), 'plugin/hooks/hooks.json'), 'utf-8'));
const cmds = (ev: string) => (hooks.hooks[ev] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command as string));
describe('record-intent hook wired', () => {
  it('UserPromptSubmit runs record-intent', () => {
    expect(cmds('UserPromptSubmit').some(c => c.includes('hook claude-code record-intent'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/cli/handlers/record-intent-hook.test.ts tests/plugin/hooks-record-intent.test.ts`
Expected: FAIL — module not found + command absent.

- [ ] **Step 3: Implement the handler**

```typescript
// src/cli/handlers/record-intent.ts
// SPDX-License-Identifier: Apache-2.0
import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';

const CONTINUE: HookResult = { continue: true, suppressOutput: true };

// Layer-2 backstop trigger: POST the prompt to /v1/record-intent so the server
// provider can classify+compose+capture a record request the agent may have
// missed. Fail-open: never blocks the prompt; any error → continue.
export const recordIntentHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const prompt = (input.prompt ?? '').trim();
    if (!prompt) return CONTINUE;
    try {
      const settings = loadFromFileOnce();
      if (settings.MEMSMITH_RECORD_INTENT_BACKSTOP !== 'true') return CONTINUE;
      const runtime = resolveRuntimeContext();
      if (runtime.runtime !== 'server') return CONTINUE;
      // Best-effort fire; the server writes on a positive classification.
      await runtime.client.recordIntent({ projectId: runtime.projectId, prompt });
    } catch (err) {
      logger.debug('HOOK', 'record-intent backstop failed (fail-open)', { error: err instanceof Error ? err.message : String(err) });
    }
    return CONTINUE;
  },
};
```
Add a `recordIntent(input: { projectId: string; prompt: string }): Promise<{ recorded: boolean; content?: string }>` method to `ServerClient` (`src/services/hooks/server-client.ts`) that POSTs `/v1/record-intent`. Register `record-intent` in `src/cli/handlers/index.ts` (import, `| 'record-intent'` in EventType, map entry, re-export) — the same 4-edit pattern as prior handlers.

- [ ] **Step 4: Add the setting**

In `SettingsDefaultsManager.ts`: interface `MEMSMITH_RECORD_INTENT_BACKSTOP: string;` + default `MEMSMITH_RECORD_INTENT_BACKSTOP: 'true',`.

- [ ] **Step 5: Wire hooks.json**

In `plugin/hooks/hooks.json`, add a UserPromptSubmit hook group whose command ends `hook claude-code record-intent` — COPY the exact command scaffold (PATH resolver + bun-runner + server-service.cjs) verbatim from the existing UserPromptSubmit entry (e.g. session-init or prompt-injection), changing only the trailing event name. Do NOT hand-write the resolver.

- [ ] **Step 6: Run + JSON-valid + typecheck**

Run: `... bun test tests/cli/handlers/record-intent-hook.test.ts tests/plugin/hooks-record-intent.test.ts` → PASS.
Run: `node -e "JSON.parse(require('fs').readFileSync('plugin/hooks/hooks.json','utf-8')); console.log('valid json')"` → `valid json`.
Run: `... bunx tsc --noEmit | grep "error TS" | grep -viE "bun:test|node_modules|tests/" || echo clean` → clean.

- [ ] **Step 7: Commit**

```bash
git add src/cli/handlers/record-intent.ts src/cli/handlers/index.ts src/services/hooks/server-client.ts src/shared/SettingsDefaultsManager.ts plugin/hooks/hooks.json tests/cli/handlers/record-intent-hook.test.ts tests/plugin/hooks-record-intent.test.ts
git commit -m "feat(record-intent): UserPromptSubmit backstop hook + client method + wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Dashboard "Notes" panel + Observations "My notes" filter

**Files:**
- Modify: `src/server/dashboard/queries.ts` (`userNotes`)
- Modify: `src/server/dashboard/routes.ts` (`GET /dashboard/notes`)
- Modify: `src/ui/viewer/views/DashboardView.tsx` (Notes panel)
- Modify: `src/ui/viewer/views/ObservationsView.tsx` (My-notes chip → `userDirected` filter)
- Test: `tests/server/dashboard/user-notes-query.test.ts`

**Interfaces:**
- Consumes: the `kind='user_note'` mark; the `userDirected` filter (Task 4) for the Observations chip.
- Produces: `userNotes(db, scope): Promise<Array<{id,content,created_at,...}>>`; `GET /dashboard/notes`; a Notes card in the dashboard; a My-notes chip in Observations.

- [ ] **Step 1: Write the failing test (the query — the load-bearing server piece)**

```typescript
// tests/server/dashboard/user-notes-query.test.ts
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { bootstrapServerPostgresSchema, createPostgresStorageRepositories } from '../../../src/storage/postgres/index.js';
import { PostgresObservationRepository } from '../../../src/storage/postgres/observations.js';
import { userNotes } from '../../../src/server/dashboard/queries.js';

const testDatabaseUrl = process.env.MEMSMITH_TEST_POSTGRES_URL;
const q = (n: string) => `"${n.replaceAll('"','""')}"`;

describe('userNotes dashboard query', () => {
  if (!testDatabaseUrl) { it.skip('requires MEMSMITH_TEST_POSTGRES_URL', () => {}); return; }
  let pool: pg.Pool; let client: any; let schemaName: string; let teamId: string; let projectId: string;
  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 }); client = await pool.connect();
    schemaName = `cm_notes_${randomUUID().replaceAll('-','_')}`;
    await client.query(`CREATE SCHEMA ${q(schemaName)}`); await client.query(`SET search_path TO ${q(schemaName)}`);
    await bootstrapServerPostgresSchema(client);
    const storage = createPostgresStorageRepositories(client);
    const team = await storage.teams.create({ name: 't' }); const project = await storage.projects.create({ teamId: team.id, name: 'p' });
    teamId = team.id; projectId = project.id;
    const repo = new PostgresObservationRepository(client);
    await repo.create({ projectId, teamId, kind: 'user_note', content: 'my saved note' });
    await repo.create({ projectId, teamId, kind: 'observation', content: 'ambient obs' });
  });
  afterEach(async () => { await client.query(`DROP SCHEMA ${q(schemaName)} CASCADE`).catch(()=>{}); client.release(); await pool.end(); });

  it('returns only user_note rows for the scope', async () => {
    const notes = await userNotes(client, { teamId, projectId });
    expect(notes.length).toBe(1);
    expect(notes[0].content).toContain('my saved note');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" MEMSMITH_TEST_POSTGRES_URL="postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres" ~/.bun/bin/bun test tests/server/dashboard/user-notes-query.test.ts`
Expected: FAIL — `userNotes` not exported.

- [ ] **Step 3: Implement the query (mirror the decision-log query)**

In `src/server/dashboard/queries.ts`, add (matching the scope-where + shape of the existing `decisionLog`/board queries — note the real types: `db: PostgresQueryable`, `s: Scope` where `Scope = { teamId: string; projectId?: string }` and `scopeWhere(s)` is the file's existing helper):
```typescript
export async function userNotes(db: PostgresQueryable, scope: Scope): Promise<Array<{ id: string; content: string; created_at: string; obs_type: string | null; lifecycle_state: string | null }>> {
  const w = scopeWhere(scope);
  const { rows } = await db.query(
    `SELECT id, content, created_at, obs_type, lifecycle_state
       FROM observations WHERE ${w.sql} AND kind = 'user_note'
       ORDER BY created_at DESC LIMIT 100`, w.args);
  return rows as any;
}
```
(Match the exact `scopeWhere`/`DbLike`/`Scope` types used by the sibling queries in that file.)

- [ ] **Step 4: Register the route (mirror /dashboard/decisions)**

In `src/server/dashboard/routes.ts`, add:
```typescript
  app.get('/dashboard/notes', ...mw, asyncHandler(async (req, res) => {
    const scope = buildScope(req);   // the file's existing scope helper — dashboard routes scope by teamId query param + optional projectId (NOT the /v1/search explicit-projectId convention). Copy the exact call the sibling /dashboard/decisions route uses.
    res.json({ notes: await userNotes(db, scope) });
  }));
```
(Copy the scope-resolution [`buildScope(req)` or whatever the sibling route names it], `...mw`, and `asyncHandler` shape verbatim from the adjacent `/dashboard/decisions` route. GOTCHA from memory: dashboard scoping ≠ /v1/search scoping — dashboard uses a teamId query param via buildScope; do not import the /v1 projectId-required convention here.)

- [ ] **Step 5: Add the Dashboard Notes panel + Observations chip (viewer)**

In `DashboardView.tsx`: add a "Notes" card (mirror the Decision-log panel component) that fetches `/dashboard/notes` and renders each note's content + relative time. Add the endpoint to `V1_ENDPOINTS`/the dashboard fetch set if the view batches fetches.
In `ObservationsView.tsx`: add a "My notes" filter chip alongside the existing type/lifecycle chips; when active, pass `userDirected: true` into `fetchObservations` (which already posts to `/v1/search` — thread the flag through the same way the type/lifecycle chips are threaded).

- [ ] **Step 6: Run + typecheck + viewer build**

Run: `... MEMSMITH_TEST_POSTGRES_URL=... bun test tests/server/dashboard/user-notes-query.test.ts` → PASS.
Run: `... bunx tsc --noEmit | grep "error TS" | grep -viE "bun:test|node_modules|tests/" || echo clean` → clean.
Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" node scripts/build-viewer.js 2>&1 | tail -3` → builds the viewer bundle without error.

- [ ] **Step 7: Commit**

```bash
git add src/server/dashboard/queries.ts src/server/dashboard/routes.ts src/ui/viewer/views/DashboardView.tsx src/ui/viewer/views/ObservationsView.tsx tests/server/dashboard/user-notes-query.test.ts
git commit -m "feat(record-intent): dashboard Notes panel + Observations My-notes filter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Full gate + live acceptance

**Files:** none (verification only).

- [ ] **Step 1: Typecheck (src)**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -viE "bun:test|node_modules|tests/" | head || echo "clean"`
Expected: `clean`.

- [ ] **Step 2: Run all record-intent test files**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" MEMSMITH_TEST_POSTGRES_URL="postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres" ~/.bun/bin/bun test tests/retrieval/record-intent-key.test.ts tests/retrieval/record-intent-directive.test.ts tests/storage/postgres/observation-idempotency.test.ts tests/storage/postgres/user-directed-filter.test.ts tests/server/user-note-boost.test.ts tests/server/generation/provider-complete.test.ts tests/server/record-intent-endpoint.test.ts tests/cli/handlers/record-intent-hook.test.ts tests/plugin/hooks-record-intent.test.ts tests/server/dashboard/user-notes-query.test.ts 2>&1 | tail -6`
Expected: all PASS.

- [ ] **Step 3: Build + sync + restart runtime (with local-dev bypass), then live-verify**

Build: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" npm run build-and-sync 2>&1 | tail -3`.
Restart the runtime with the bypass env (server on :38879, PG :55433) — kill old by PID, clear `~/.memsmith/local-pg.pid` + `pgdata/postmaster.pid`, boot with `MEMSMITH_RUNTIME=local MEMSMITH_AUTH_MODE=local-dev MEMSMITH_ALLOW_LOCAL_DEV_BYPASS=1 MEMSMITH_LOCAL_DEV_TEAM_ID=ab8e1f17-020e-4794-bae3-e59885e7df05 MEMSMITH_LOCAL_DEV_PROJECT_ID=5fc024f0-0994-4f1d-baed-300d9b4d3416` via a `startLocalRuntime()` script. (These are the operator env vars proven this session.)

- [ ] **Step 4: Live acceptance — backstop end-to-end**

```bash
KEY=$(cat ~/.memsmith/credentials.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).keys['ab8e1f17-020e-4794-bae3-e59885e7df05'])})")
# 1. record-intent endpoint records on a clear request
curl -s -m30 -X POST "http://127.0.0.1:38879/v1/record-intent" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"projectId":"5fc024f0-0994-4f1d-baed-300d9b4d3416","prompt":"remember that we picked embedded postgres to avoid docker for local dev"}'
# expect {"recorded":true,"content":"..."}
# 2. it landed as a user_note, embedded, and is filterable
curl -s -m8 -X POST "http://127.0.0.1:38879/v1/search" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"projectId":"5fc024f0-0994-4f1d-baed-300d9b4d3416","query":"why avoid docker locally","userDirected":true,"limit":3}'
# expect the recorded note in results
# 3. idempotency: same prompt again → no duplicate user_note with the same key
```
Expected: (1) `recorded:true`; (2) the note appears under the `userDirected` filter; (3) re-running (1) does not create a second identical row (verify count in PG).

- [ ] **Step 4b: Dashboard**

Open `http://127.0.0.1:38879/`, confirm the Notes panel shows the recorded note and the Observations "My notes" chip filters to it.

- [ ] **Step 5: No commit** (verification). Report results.

---

## Self-review notes
- **Spec coverage:** capture directive (T6) + backstop (T7,T8,T9) = two-layer detection; idempotency (T1,T2,T3); filter (T4); boost (T5); dashboard panel + observations chip (T10); settings `USER_NOTE_BOOST` (T5) + `RECORD_INTENT_BACKSTOP` (T9); write-loud/read-quiet honored (backstop + boost fail-open, directive surfaces write failure); mark-survives-ranking (T4 relies on `kind` on result rows — the idempotency/filter tests assert `kind` present). All acceptance criteria mapped.
- **Idempotency ON CONFLICT constraint** resolved in T2 (dedicated column + partial unique index + branched insert), honoring the one-conflict-clause limit.
- **Backstop does not overload obs-XML generate()** — T7 is a separate minimal completion helper.
- **Type consistency:** `computeContentIdempotencyKey` (T1) used by T2/T8; `idempotencyKey` field threaded T2→T3; `userDirected` T4→T5/T10; `boostUserDirected` T5; `providerComplete` T7→T8; `recordIntent` client method T9. Names consistent across tasks.
- **Ordering:** T1→T2→T3 (idempotency foundation) before T8/T9 (which compute+use the key); T4 before T5 (filter before boost share the seam); T6 independent; T10 last UI. T7 before T8.
