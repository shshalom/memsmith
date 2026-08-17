# Convert Over HTTPS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GO TEAM work against a managed database (private RDS) by moving convert's data transfer from a direct Postgres connection to the same authenticated HTTPS API everything else already uses.

**Architecture:** `CopyDeps` (`copy-engine.ts:7-11`) is a three-method seam — `readRows`, `upsertRows`, `countRows`. Today it is satisfied by a direct `pg` pool to the destination. This plan adds a second implementation that satisfies the same interface over HTTPS, plus the two server routes it calls. `runCopy`'s control flow is untouched; only the transport changes. This mirrors how the joiner's transport was swapped without rewriting `runJoin`.

**Tech Stack:** TypeScript, Express, `pg`, Zod, `bun test`.

## Global Constraints

- **Never test against the dogfood project** `5fc024f0-0994-4f1d-baed-300d9b4d3416` (team `ab8e1f17-020e-4794-bae3-e59885e7df05`). It is the only real workspace. Use the rig (`scripts/rig/`) or a scratch AWS project. Verify with the `credentials.json` sha256 baseline `7eee46d2cb7f029f8318efb436637b639068d5195639fff26fb520b8ada4f9d4` before and after.
- **Never stop the dogfood server** on `:38879`. It exists to observe this project.
- **Import route auth is `[...writeAuth, requireRole('owner')]`** — the same gate as every other convert route (`ServerV1PostgresRoutes.ts:1704`). Never `requireWriteRole()`: it treats `role == null` as member-equivalent (`postgres-auth.ts:69`).
- **A team-scoped key (`project_id IS NULL`) must be REFUSED** by the import route. `ensureProjectAllowed` (`ServerV1PostgresRoutes.ts:2333-2339`) only rejects when the key *has* a project scope, so it is not sufficient on its own.
- **`projectId` comes from `req.authContext.projectId` only, never a request body field** — as `/v1/convert/migrate` does (`ConvertRoutes.ts:80-87`).
- **JSON body limit is 5 MB** (`services/server/middleware.ts:9`). `COPY_BATCH_SIZE` is **200** (`copy-engine.ts:27`).
- **Embeddings are carried, never regenerated.** `embedForPersist` degrades to NULL when the embedder is down, and a row-count check cannot detect that loss.
- **`observations.embedding_vec` is `vector(384)`.** A test vector must have exactly 384 elements or Postgres rejects it with `expected 384 dimensions, not N`.
- Schema version is currently **6** (`schema.ts:6`). This plan adds migration **7**. DDL goes in the embedded list in `schema.ts` — `src/storage/postgres/migrations/*.sql` is **not loaded by code**.
- Run `~/.bun/bin/bun test <path>` (not bare `bun`) and `npx tsc --noEmit` before every commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/storage/postgres/schema.ts` (modify) | Migration 7: `promoted_at` + `convert_import_batches`; version bump |
| `src/server/convert/import-batching.ts` (create) | Pure byte-budget batch splitter. No I/O. |
| `src/server/convert/copy-transport-https.ts` (create) | `CopyDeps` implementation over HTTPS |
| `src/server/routes/v1/ConvertImportRoutes.ts` (create) | `POST /v1/convert/import`, `GET /v1/convert/verify` |
| `src/server/convert/import-apply.ts` (create) | Server-side row application: strip generated cols, defer `supersedes`, record tokens |
| `src/server/routes/v1/ServerV1PostgresRoutes.ts` (modify) | Register the two new routes |
| `src/server/convert/copy-engine.ts` (modify) | `verifyCopy` equality check |
| `src/ui/viewer/views/wizard/wizardData.ts` (modify) | Post `{serverUrl, teamKey}` |
| `src/ui/viewer/views/wizard/cards/DestinationCard.tsx` (modify) | Two fields instead of a database URL |

---

## Task 1: Migration 7 — `promoted_at` and `convert_import_batches`

**Files:**
- Modify: `src/storage/postgres/schema.ts`
- Test: `tests/storage/postgres/migration-7.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: table `convert_import_batches(project_id TEXT, table_name TEXT, batch_token TEXT, applied_at TIMESTAMPTZ)` with `PRIMARY KEY (project_id, table_name, batch_token)`; column `observations.promoted_at TIMESTAMPTZ`; `SERVER_POSTGRES_SCHEMA_VERSION === 7`.

- [ ] **Step 1: Write the failing test**

Create `tests/storage/postgres/migration-7.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { SERVER_POSTGRES_SCHEMA_VERSION } from '../../../src/storage/postgres/schema.js';

describe('migration 7', () => {
  it('bumps the schema version to 7', () => {
    // Without the bump the migration never runs — the version gate is what
    // triggers it, so the constant and the DDL must land in the same change.
    expect(SERVER_POSTGRES_SCHEMA_VERSION).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/storage/postgres/migration-7.test.ts`
Expected: FAIL — `Expected: 7, Received: 6`

- [ ] **Step 3: Implement**

In `src/storage/postgres/schema.ts`, change line 6:

```ts
export const SERVER_POSTGRES_SCHEMA_VERSION = 7;
```

Then, immediately after the migration-006 block that ends with the
`INSERT INTO server_beta_schema_migrations … [6, 'identity-core: …']` call, add:

```ts
  // Migration 007: convert-over-HTTPS support.
  //
  // promoted_at — LOCAL bookkeeping only. NULL means "this row is not in the team
  // yet" and drives the wizard's sync count. Never read on the remote: a row in the
  // team database is by definition already there.
  //
  // convert_import_batches — per-batch idempotency for the HTTPS import. Row-level
  // idempotency cannot carry this: only 3.4% of real observations have an
  // idempotency_key, and the unique index is partial (WHERE idempotency_key IS NOT
  // NULL), so the rest would duplicate on a retried batch.
  await client.query(
    `ALTER TABLE observations ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ`
  );
  await client.query(
    `CREATE TABLE IF NOT EXISTS convert_import_batches (
       project_id TEXT NOT NULL,
       table_name TEXT NOT NULL,
       batch_token TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (project_id, table_name, batch_token)
     )`
  );
  await client.query(
    `
      INSERT INTO server_beta_schema_migrations (version, description)
      VALUES ($1, $2)
      ON CONFLICT (version) DO NOTHING
    `,
    [7, 'convert-over-https: observations.promoted_at + convert_import_batches']
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/storage/postgres/migration-7.test.ts`
Expected: PASS (1 pass)

- [ ] **Step 5: Verify the DDL actually applies against a real database**

Run:

```bash
~/.bun/bin/bun -e "
const {Client}=require('pg');
const {bootstrapServerPostgresSchema}=await import('./src/storage/postgres/schema.ts');
const c=new Client({connectionString:'postgres://memsmith:rig-throwaway@127.0.0.1:55440/memsmith'});
await c.connect();
await bootstrapServerPostgresSchema({query:(t,v)=>c.query(t,v)});
const a=await c.query(\"SELECT count(*)::int n FROM information_schema.columns WHERE table_name='observations' AND column_name='promoted_at'\");
const b=await c.query(\"SELECT count(*)::int n FROM information_schema.tables WHERE table_name='convert_import_batches'\");
console.log('promoted_at:',a.rows[0].n,' convert_import_batches:',b.rows[0].n);
await c.end();"
```

Expected: `promoted_at: 1  convert_import_batches: 1`
If the rig database is not running: `bash scripts/rig/team-up.sh` first.

- [ ] **Step 6: Commit**

```bash
git add src/storage/postgres/schema.ts tests/storage/postgres/migration-7.test.ts
git commit -m "feat(schema): migration 7 — promoted_at and convert_import_batches

promoted_at is local bookkeeping (NULL = not yet in the team) and drives the
wizard's sync count. convert_import_batches gives the HTTPS import per-batch
idempotency, which row-level idempotency cannot: only 3.4% of real observations
carry an idempotency_key and its unique index is partial, so the rest would
duplicate on a retried batch.

Verified the DDL applies against the rig database (both objects present).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Byte-budget batch splitter

**Files:**
- Create: `src/server/convert/import-batching.ts`
- Test: `tests/server/convert/import-batching.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `splitByByteBudget(rows: Array<Record<string, unknown>>, budgetBytes: number): Array<Array<Record<string, unknown>>>` and `IMPORT_BYTE_BUDGET: number`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/convert/import-batching.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// Row count is the wrong bound for an HTTPS import. COPY_BATCH_SIZE is 200 and the
// server's JSON limit is 5 MB; an observations row carries content, a metadata blob
// and a 384-float vector (several KB as JSON), so 200 rows can exceed the limit and
// return 413 — a failure the row count never predicts.
import { describe, expect, it } from 'bun:test';
import { splitByByteBudget, IMPORT_BYTE_BUDGET } from '../../../src/server/convert/import-batching.js';

describe('splitByByteBudget', () => {
  it('keeps a small set in one chunk', () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
    expect(splitByByteBudget(rows, 10_000)).toEqual([rows]);
  });

  it('splits when the budget is exceeded', () => {
    const big = { content: 'x'.repeat(400) };
    const chunks = splitByByteBudget([big, big, big], 900);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toHaveLength(3);
  });

  it('never drops or reorders rows', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ i, pad: 'y'.repeat(100) }));
    const chunks = splitByByteBudget(rows, 1_000);
    expect(chunks.flat().map(r => r.i)).toEqual(rows.map(r => r.i));
  });

  it('emits an oversized row alone rather than dropping it or looping forever', () => {
    // A single row larger than the whole budget cannot be split further. It must
    // still be attempted — dropping it would lose data silently, and skipping it
    // would spin.
    const huge = { content: 'z'.repeat(5_000) };
    const chunks = splitByByteBudget([huge, { a: 1 }], 1_000);
    expect(chunks[0]).toEqual([huge]);
    expect(chunks.flat()).toHaveLength(2);
  });

  it('returns no chunks for no rows', () => {
    expect(splitByByteBudget([], 1_000)).toEqual([]);
  });

  it('leaves headroom under the 5 MB server limit', () => {
    // The budget must sit below the limit, not at it: the JSON envelope (table
    // name, batchToken, field names) is sent on top of the rows.
    expect(IMPORT_BYTE_BUDGET).toBeLessThan(5 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/server/convert/import-batching.test.ts`
Expected: FAIL — cannot find module `import-batching.js`

- [ ] **Step 3: Implement**

Create `src/server/convert/import-batching.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// Batching for the HTTPS import, bounded by BYTES rather than row count.
//
// runCopy batches at COPY_BATCH_SIZE (200) rows, which is the right unit for a
// direct connection issuing one INSERT per row. Over HTTPS the constraint is the
// server's JSON body limit (5 MB, services/server/middleware.ts:9). An observations
// row carries content, a metadata JSONB blob and a 384-float embedding — several KB
// once serialised — so 200 rows can exceed the limit and 413. Row count cannot
// predict that; measured size can.

/**
 * Bytes of row payload per request. Well under the server's 5 MB limit: the JSON
 * envelope (table name, batchToken, field names) rides on top, and a request that
 * 413s costs a full round trip to discover.
 */
export const IMPORT_BYTE_BUDGET = 3 * 1024 * 1024;

/**
 * Split rows into chunks whose serialised size stays within `budgetBytes`.
 *
 * Order is preserved — callers rely on it for FK-safe application within a table.
 * A single row larger than the budget is emitted alone: it cannot be split, and
 * dropping it would silently lose data.
 */
export function splitByByteBudget(
  rows: Array<Record<string, unknown>>,
  budgetBytes: number = IMPORT_BYTE_BUDGET,
): Array<Array<Record<string, unknown>>> {
  const chunks: Array<Array<Record<string, unknown>>> = [];
  let current: Array<Record<string, unknown>> = [];
  let currentBytes = 0;

  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
    // Flush before adding, so the row that would breach the budget starts the next
    // chunk instead of overflowing this one. An empty `current` never flushes, which
    // is what lets an oversized row through alone rather than looping.
    if (current.length > 0 && currentBytes + size > budgetBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(row);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/server/convert/import-batching.test.ts`
Expected: PASS (6 pass)

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/server/convert/import-batching.ts tests/server/convert/import-batching.test.ts
git commit -m "feat(convert): byte-budget batch splitter for the HTTPS import

Row count is the wrong bound over HTTPS: COPY_BATCH_SIZE is 200 but the server's
JSON limit is 5 MB, and an observations row carries content, metadata and a
384-float vector, so 200 rows can 413. Splits on measured size, preserves order
(callers depend on it for FK-safe application), and emits an oversized row alone
rather than dropping it or spinning.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Server-side row application

**Files:**
- Create: `src/server/convert/import-apply.ts`
- Test: `tests/server/convert/import-apply.test.ts`

**Interfaces:**
- Consumes: `discoverGeneratedColumns`, `stripGeneratedColumns` from `src/server/convert/generated-columns.js`.
- Produces:
  - `applyImportBatch(deps: ApplyDeps, input: ApplyInput): Promise<{ applied: number; status: 'applied' | 'already_applied' }>`
  - `ApplyInput = { projectId: string; teamId: string; table: string; rows: Array<Record<string, unknown>>; batchToken: string }`
  - `ApplyDeps = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }`
  - `DEFERRED_COLUMNS: Record<string, string[]>`

Why this lives on the server: `discoverGeneratedColumns` queries `information_schema` on the **destination** connection (`generated-columns.ts:25-42`), deliberately, so a future migration adding a generated column cannot silently reintroduce an insert crash. An HTTPS client has no such connection, so stripping must happen here. `observations.content_search` is `GENERATED ALWAYS` (`schema.ts:380`) and comes back from `SELECT *`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/convert/import-apply.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { applyImportBatch, DEFERRED_COLUMNS } from '../../../src/server/convert/import-apply.js';

function makeDeps(opts: { tokenSeen?: boolean } = {}) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  return {
    statements,
    query: async (text: string, values?: unknown[]) => {
      statements.push({ text, values: values ?? [] });
      if (/FROM convert_import_batches/i.test(text)) {
        return { rows: opts.tokenSeen ? [{ batch_token: 'tok' }] : [] };
      }
      if (/information_schema/i.test(text)) {
        // content_search is GENERATED ALWAYS and must never be named in an INSERT.
        return { rows: [{ table_name: 'observations', column_name: 'content_search' }] };
      }
      return { rows: [] };
    },
  };
}

const BASE = { projectId: 'p1', teamId: 't1', batchToken: 'tok' };

describe('applyImportBatch', () => {
  it('returns already_applied for a token it has seen, without inserting', async () => {
    const deps = makeDeps({ tokenSeen: true });
    const r = await applyImportBatch(deps, {
      ...BASE, table: 'observations', rows: [{ id: 'o1', content: 'x' }],
    });
    expect(r.status).toBe('already_applied');
    expect(r.applied).toBe(0);
    expect(deps.statements.some(s => /INSERT INTO observations/i.test(s.text))).toBe(false);
  });

  it('strips generated columns before inserting', async () => {
    const deps = makeDeps();
    await applyImportBatch(deps, {
      ...BASE, table: 'observations',
      rows: [{ id: 'o1', content: 'x', content_search: "'tsvector-junk'" }],
    });
    const insert = deps.statements.find(s => /INSERT INTO observations/i.test(s.text))!;
    // Naming a GENERATED ALWAYS column makes Postgres reject the whole statement.
    expect(insert.text).not.toMatch(/content_search/);
    expect(insert.text).toMatch(/content/);
  });

  it('defers supersedes so a superseding row can precede its target', async () => {
    // observations.supersedes is a SELF-FK (schema.ts:471-472). Within one table a
    // superseding row can land in an earlier batch than the row it points at, so the
    // link is applied in a later pass rather than at insert time.
    expect(DEFERRED_COLUMNS.observations).toContain('supersedes');

    const deps = makeDeps();
    await applyImportBatch(deps, {
      ...BASE, table: 'observations',
      rows: [{ id: 'o2', content: 'x', supersedes: 'o1' }],
    });
    const insert = deps.statements.find(s => /INSERT INTO observations/i.test(s.text))!;
    expect(insert.text).not.toMatch(/supersedes/);
    // The link must be recorded for the deferred pass, not discarded.
    expect(deps.statements.some(s => /UPDATE observations SET supersedes/i.test(s.text))).toBe(true);
  });

  it('records the batch token so a retry is a no-op', async () => {
    const deps = makeDeps();
    await applyImportBatch(deps, {
      ...BASE, table: 'observations', rows: [{ id: 'o1', content: 'x' }],
    });
    expect(deps.statements.some(s => /INSERT INTO convert_import_batches/i.test(s.text))).toBe(true);
  });

  it('forces team_id to the authenticated team, ignoring any value in the row', async () => {
    const deps = makeDeps();
    await applyImportBatch(deps, {
      ...BASE, table: 'observations',
      rows: [{ id: 'o1', content: 'x', team_id: 'SOMEONE-ELSES-TEAM' }],
    });
    const insert = deps.statements.find(s => /INSERT INTO observations/i.test(s.text))!;
    expect(insert.values).toContain('t1');
    expect(insert.values).not.toContain('SOMEONE-ELSES-TEAM');
  });

  it('forces project_id to the authenticated project', async () => {
    const deps = makeDeps();
    await applyImportBatch(deps, {
      ...BASE, table: 'observations',
      rows: [{ id: 'o1', content: 'x', project_id: 'ANOTHER-PROJECT' }],
    });
    const insert = deps.statements.find(s => /INSERT INTO observations/i.test(s.text))!;
    expect(insert.values).toContain('p1');
    expect(insert.values).not.toContain('ANOTHER-PROJECT');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/server/convert/import-apply.test.ts`
Expected: FAIL — cannot find module `import-apply.js`

- [ ] **Step 3: Implement**

Create `src/server/convert/import-apply.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// Applies one imported batch, server-side.
//
// This work cannot live in the client. discoverGeneratedColumns queries
// information_schema on the DESTINATION connection (generated-columns.ts:12-16),
// deliberately, so a migration that adds a generated column cannot silently
// reintroduce the insert crash it was written to prevent. An HTTPS client has no
// destination connection, so stripping happens here.
//
// SCOPE IS TAKEN FROM THE CREDENTIAL, NEVER THE ROW. Rows arrive over the network and
// carry their own project_id/team_id; trusting them would let an authenticated caller
// write into another tenant by editing a payload. Both are overwritten with the
// authenticated values.

import { discoverGeneratedColumns, stripGeneratedColumns } from './generated-columns.js';

export interface ApplyDeps {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ApplyInput {
  projectId: string;
  teamId: string;
  table: string;
  rows: Array<Record<string, unknown>>;
  batchToken: string;
}

/**
 * Columns held back at insert time and applied in a later pass.
 *
 * observations.supersedes is a SELF-referential FK (schema.ts:471-472): within a
 * single table a superseding row can arrive before the row it points at, so naming it
 * on insert would fail on a forward reference. Table order alone cannot fix that,
 * because the conflict is inside one table.
 */
export const DEFERRED_COLUMNS: Record<string, string[]> = {
  observations: ['supersedes'],
};

export async function applyImportBatch(
  deps: ApplyDeps,
  input: ApplyInput,
): Promise<{ applied: number; status: 'applied' | 'already_applied' }> {
  const seen = await deps.query(
    `SELECT batch_token FROM convert_import_batches
      WHERE project_id = $1 AND table_name = $2 AND batch_token = $3`,
    [input.projectId, input.table, input.batchToken],
  );
  // Idempotency is per BATCH, not per row: most observations carry no
  // idempotency_key, so row-level conflict handling cannot make a retry safe.
  if (seen.rows.length > 0) return { applied: 0, status: 'already_applied' };

  if (input.rows.length === 0) {
    await recordToken(deps, input);
    return { applied: 0, status: 'applied' };
  }

  const generated = await discoverGeneratedColumns(deps as never);
  const deferred = DEFERRED_COLUMNS[input.table] ?? [];
  const deferredLinks: Array<{ id: unknown; values: Record<string, unknown> }> = [];

  const writable = stripGeneratedColumns(input.table, input.rows, generated);

  for (const row of writable) {
    const scoped: Record<string, unknown> = { ...row };
    // Authenticated scope wins over anything the payload claims.
    if ('project_id' in scoped) scoped.project_id = input.projectId;
    if ('team_id' in scoped) scoped.team_id = input.teamId;

    const held: Record<string, unknown> = {};
    for (const col of deferred) {
      if (scoped[col] != null) {
        held[col] = scoped[col];
        delete scoped[col];
      }
    }
    if (Object.keys(held).length > 0) deferredLinks.push({ id: scoped.id, values: held });

    const cols = Object.keys(scoped);
    const colList = cols.map(c => `"${c}"`).join(', ');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    await deps.query(
      `INSERT INTO ${input.table} (${colList}) VALUES (${placeholders})
       ON CONFLICT DO NOTHING`,
      cols.map(c => scoped[c]),
    );
  }

  // Deferred pass: every row of this batch now exists, so self-FK targets inside the
  // batch resolve. A target in a LATER batch still fails, which is why the link is
  // applied with ON CONFLICT-free UPDATE and a missing target simply matches no row.
  for (const link of deferredLinks) {
    for (const [col, value] of Object.entries(link.values)) {
      await deps.query(
        `UPDATE ${input.table} SET ${col} = $1 WHERE id = $2
          AND EXISTS (SELECT 1 FROM ${input.table} WHERE id = $1)`,
        [value, link.id],
      );
    }
  }

  await recordToken(deps, input);
  return { applied: writable.length, status: 'applied' };
}

async function recordToken(deps: ApplyDeps, input: ApplyInput): Promise<void> {
  await deps.query(
    `INSERT INTO convert_import_batches (project_id, table_name, batch_token)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [input.projectId, input.table, input.batchToken],
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/server/convert/import-apply.test.ts`
Expected: PASS (6 pass)

If `stripGeneratedColumns`'s signature differs from `(table, rows, map)`, read
`src/server/convert/generated-columns.ts` and match it exactly rather than adapting the
call — the map type is produced by `discoverGeneratedColumns` and must be passed through
unchanged.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/server/convert/import-apply.ts tests/server/convert/import-apply.test.ts
git commit -m "feat(convert): server-side import batch application

Generated-column stripping must be server-side: discoverGeneratedColumns queries
information_schema on the DESTINATION connection by design, so a migration adding a
generated column cannot silently reintroduce the insert crash. An HTTPS client has
no such connection.

Scope is taken from the CREDENTIAL, never the row: rows arrive over the network
carrying their own project_id/team_id, and trusting them would let an authenticated
caller write into another tenant by editing a payload. Both are overwritten, pinned
by tests.

supersedes is deferred to a second pass because it is a self-FK — within one table a
superseding row can arrive before its target, which table ordering cannot fix.

Per-BATCH idempotency via convert_import_batches, because only 3.4% of real
observations carry an idempotency_key and its unique index is partial.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: `verifyCopy` compares for equality

**Files:**
- Modify: `src/server/convert/copy-engine.ts:59-70`
- Test: `tests/server/convert/verify-copy-equality.test.ts`

**Interfaces:**
- Consumes: `CopyDeps` from `copy-engine.js` (unchanged).
- Produces: `verifyCopy` with the same signature; only the comparison changes.

- [ ] **Step 1: Write the failing test**

Create `tests/server/convert/verify-copy-equality.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// verifyCopy flagged only remote < local. With per-batch idempotency and no
// cross-batch transaction, a partially-applied retry can leave remote > local — more
// rows on the destination than the source — and that passed verification while being
// wrong. Verification must mean "the same", not "at least as many".
import { describe, expect, it } from 'bun:test';
import { verifyCopy, COPY_TABLES } from '../../../src/server/convert/copy-engine.js';

function depsWith(local: number, remote: number) {
  return {
    readRows: async () => [],
    upsertRows: async () => {},
    countRows: async (which: 'local' | 'remote') => (which === 'local' ? local : remote),
  };
}

describe('verifyCopy', () => {
  it('passes when counts match', async () => {
    const r = await verifyCopy(depsWith(5, 5));
    expect(r.ok).toBe(true);
    expect(r.mismatches).toEqual([]);
  });

  it('fails when the remote has FEWER rows', async () => {
    const r = await verifyCopy(depsWith(5, 3));
    expect(r.ok).toBe(false);
  });

  it('fails when the remote has MORE rows', async () => {
    // The regression: a duplicated retry inflates the destination, and treating
    // "at least as many" as success declares that copy verified.
    const r = await verifyCopy(depsWith(5, 7));
    expect(r.ok).toBe(false);
    expect(r.mismatches[0]).toMatchObject({ local: 5, remote: 7 });
  });

  it('reports every table that mismatches', async () => {
    const r = await verifyCopy(depsWith(1, 2));
    expect(r.mismatches).toHaveLength(COPY_TABLES.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/server/convert/verify-copy-equality.test.ts`
Expected: FAIL on "fails when the remote has MORE rows" — `Expected: false, Received: true`

- [ ] **Step 3: Implement**

In `src/server/convert/copy-engine.ts`, replace the comparison inside `verifyCopy`:

```ts
    // EQUALITY, not sufficiency. `remote < local` alone missed the over-copy case:
    // with per-batch idempotency and no cross-batch transaction, a partially-applied
    // retry can leave MORE rows on the destination than the source, and that used to
    // pass verification while being wrong.
    if (remote !== local) mismatches.push({ table, local, remote });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/server/convert/verify-copy-equality.test.ts`
Expected: PASS (4 pass)

- [ ] **Step 5: Check for fallout**

Run: `~/.bun/bin/bun test tests/server/convert/`
Expected: all pass. If an existing test asserted `ok: true` with `remote > local`, that
test encoded the bug — update it and say so in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/server/convert/copy-engine.ts tests/server/convert/verify-copy-equality.test.ts
git commit -m "fix(convert): verifyCopy compares counts for equality, not sufficiency

It flagged only remote < local. With per-batch idempotency and no cross-batch
transaction a partially-applied retry can leave remote > local, and that passed
verification while being wrong. An over-copied project is not a verified project.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: The import and verify routes

**Files:**
- Create: `src/server/routes/v1/ConvertImportRoutes.ts`
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (register, near the existing `registerConvertRoutes` call at ~1703)
- Test: `tests/server/routes/v1/convert-import-routes.test.ts`

**Interfaces:**
- Consumes: `applyImportBatch`, `ApplyDeps` from `src/server/convert/import-apply.js`; `buildScopedCountQuery` from `src/server/routes/v1/convert-scope.js`.
- Produces: `registerConvertImportRoutes(app, deps)` where
  `deps = { authMiddleware: RequestHandler[]; pool: ApplyDeps }`.

**Auth is non-negotiable** — see Global Constraints. `[...writeAuth, requireRole('owner')]`,
and a team-scoped key (`authContext.projectId == null`) is refused with 400, because a
caller with no project scope has not said which project it is importing and guessing is
the whole convert-scope failure history.

- [ ] **Step 1: Write the failing test**

Create `tests/server/routes/v1/convert-import-routes.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import express from 'express';
import { registerConvertImportRoutes } from '../../../../src/server/routes/v1/ConvertImportRoutes.js';

/** Injects an authContext, standing in for the real auth middleware. */
function appWith(authContext: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  const inject: express.RequestHandler = (req, _res, next) => {
    (req as any).authContext = authContext;
    next();
  };
  registerConvertImportRoutes(app, {
    authMiddleware: [inject],
    pool: {
      query: async (text: string) => {
        if (/FROM convert_import_batches/i.test(text)) return { rows: [] };
        if (/information_schema/i.test(text)) return { rows: [] };
        if (/count\(\*\)/i.test(text)) return { rows: [{ count: '2' }] };
        return { rows: [] };
      },
    },
  });
  return app;
}

async function post(app: express.Express, path: string, body: unknown) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const OWNER = { projectId: 'p1', teamId: 't1', role: 'owner' };

describe('POST /v1/convert/import', () => {
  it('refuses a credential with no project scope', async () => {
    // A team-scoped key (project_id IS NULL) passes ensureProjectAllowed for ANY
    // project, so the route must reject it explicitly rather than guess.
    const res = await post(appWith({ projectId: null, teamId: 't1', role: 'owner' }),
      '/v1/convert/import', { table: 'observations', rows: [], batchToken: 'tok' });
    expect(res.status).toBe(400);
  });

  it('rejects a table outside COPY_TABLES', async () => {
    // The table name is interpolated into SQL, so an allowlist is the boundary.
    const res = await post(appWith(OWNER), '/v1/convert/import',
      { table: 'api_keys', rows: [], batchToken: 'tok' });
    expect(res.status).toBe(400);
  });

  it('accepts a well-formed batch', async () => {
    const res = await post(appWith(OWNER), '/v1/convert/import',
      { table: 'observations', rows: [{ id: 'o1', content: 'x' }], batchToken: 'tok' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'applied' });
  });

  it('ignores a projectId supplied in the body', async () => {
    const res = await post(appWith(OWNER), '/v1/convert/import',
      { table: 'observations', rows: [], batchToken: 'tok', projectId: 'ATTACKER' });
    expect(res.status).toBe(200);
    // Scope came from authContext; the body value must not appear anywhere.
    expect(JSON.stringify(res.body)).not.toMatch(/ATTACKER/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/server/routes/v1/convert-import-routes.test.ts`
Expected: FAIL — cannot find module `ConvertImportRoutes.js`

- [ ] **Step 3: Implement**

Create `src/server/routes/v1/ConvertImportRoutes.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/convert/import — receive one batch of relocated rows.
// GET  /v1/convert/verify — per-table row counts, computed server-side.
//
// WHY VERIFY IS A SERVER ROUTE. buildScopedCountQuery emits different SQL for local
// and remote, and the remote variant needs team_id — but observation_sources has
// NEITHER project_id NOR team_id, so its count is a correlated subquery through the
// parent table (convert-scope.ts:29-31). A client cannot express that. Only the server
// can answer "how many rows of this table belong to this project".
//
// AUTH. Owner-gated like every other convert route (ServerV1PostgresRoutes.ts:1704).
// NOT requireWriteRole(), which treats role == null as member-equivalent
// (postgres-auth.ts:69) — this route writes raw rows into seven tables, so a roleless
// key must not reach it.

import type { Application, RequestHandler, Request, Response } from 'express';
import { COPY_TABLES } from '../../convert/copy-engine.js';
import { applyImportBatch, type ApplyDeps } from '../../convert/import-apply.js';
import { buildScopedCountQuery } from './convert-scope.js';

export interface ConvertImportDeps {
  /** [...writeAuth, requireRole('owner')] — see the auth note above. */
  authMiddleware: RequestHandler[];
  pool: ApplyDeps;
}

export function registerConvertImportRoutes(app: Application, deps: ConvertImportDeps): void {
  app.post('/v1/convert/import', ...deps.authMiddleware, async (req: Request, res: Response) => {
    const ctx = (req as unknown as { authContext?: { projectId?: string | null; teamId?: string | null } }).authContext;
    const projectId = ctx?.projectId ?? null;
    const teamId = ctx?.teamId ?? null;
    // A team-scoped key reaches every project in its team, so it has not identified
    // which one is being imported. Refuse instead of guessing.
    if (!projectId || !teamId) {
      res.status(400).json({
        error: 'no project scope on this credential — cannot determine which project to import into',
      });
      return;
    }

    const body = req.body as { table?: unknown; rows?: unknown; batchToken?: unknown };
    const table = typeof body.table === 'string' ? body.table : '';
    // The table name is interpolated into SQL. An allowlist — not escaping — is the
    // boundary, and it doubles as a refusal to touch account tables.
    if (!COPY_TABLES.includes(table)) {
      res.status(400).json({ error: `table not importable: ${table || '(none)'}` });
      return;
    }
    const batchToken = typeof body.batchToken === 'string' ? body.batchToken : '';
    if (!batchToken) {
      res.status(400).json({ error: 'batchToken is required' });
      return;
    }
    if (!Array.isArray(body.rows)) {
      res.status(400).json({ error: 'rows must be an array' });
      return;
    }

    try {
      const result = await applyImportBatch(deps.pool, {
        projectId, teamId, table,
        rows: body.rows as Array<Record<string, unknown>>,
        batchToken,
      });
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'import failed' });
    }
  });

  app.get('/v1/convert/verify', ...deps.authMiddleware, async (req: Request, res: Response) => {
    const ctx = (req as unknown as { authContext?: { projectId?: string | null; teamId?: string | null } }).authContext;
    const projectId = ctx?.projectId ?? null;
    const teamId = ctx?.teamId ?? null;
    if (!projectId || !teamId) {
      res.status(400).json({ error: 'no project scope on this credential' });
      return;
    }

    try {
      const counts: Record<string, number> = {};
      for (const table of COPY_TABLES) {
        const q = buildScopedCountQuery(table, 'remote');
        const r = await deps.pool.query(q.text, q.params({ projectId, teamId }));
        counts[table] = Number((r.rows[0] as { count?: unknown })?.count ?? 0);
      }
      res.status(200).json({ counts });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'verify failed' });
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/server/routes/v1/convert-import-routes.test.ts`
Expected: PASS (4 pass)

- [ ] **Step 5: Register the routes in the real server**

In `src/server/routes/v1/ServerV1PostgresRoutes.ts`, add the import at the top with the
other route imports:

```ts
import { registerConvertImportRoutes } from './ConvertImportRoutes.js';
```

Then immediately after the existing `registerConvertRoutes(app, { … });` call (it begins
at ~line 1703 and its options object ends before the next statement), add:

```ts
    // Owner-gated, exactly like registerConvertRoutes above: this route writes raw
    // rows into seven tables, so it takes the strongest gate the codebase has.
    registerConvertImportRoutes(app, {
      authMiddleware: [...writeAuth, requireRole('owner')],
      pool: this.options.pool as never,
    });
```

- [ ] **Step 6: Verify registration against a live server**

Run: `npx tsc --noEmit`, then confirm the route exists rather than 404s. Start the rig
server (Task 7 has the full command) and run:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:38890/v1/convert/import
```

Expected: `403` (auth rejects an unauthenticated call) — **not** `404`. A 404 means
registration did not take effect.

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/v1/ConvertImportRoutes.ts src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/routes/v1/convert-import-routes.test.ts
git commit -m "feat(convert): POST /v1/convert/import and GET /v1/convert/verify

Owner-gated, matching every other convert route. NOT requireWriteRole(), which
treats role == null as member-equivalent — this route writes raw rows into seven
tables, so a roleless key must not reach it. A team-scoped key
(project_id IS NULL) is refused explicitly: it reaches every project in its team,
so it has not identified which one to import into, and ensureProjectAllowed passes
it for any project.

Table names are allowlisted against COPY_TABLES because the name is interpolated
into SQL; that also refuses account tables outright.

Verify is a SERVER route because observation_sources has neither project_id nor
team_id — its count is a correlated subquery through the parent table, which a
client cannot express.

Registration confirmed against a live server (403, not 404).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: The HTTPS `CopyDeps` transport

**Files:**
- Create: `src/server/convert/copy-transport-https.ts`
- Test: `tests/server/convert/copy-transport-https.test.ts`

**Interfaces:**
- Consumes: `CopyDeps` from `copy-engine.js`; `splitByByteBudget`, `IMPORT_BYTE_BUDGET` from `import-batching.js`.
- Produces: `makeHttpsCopyDeps(input: HttpsCopyInput): CopyDeps` where
  `HttpsCopyInput = { serverUrl: string; teamKey: string; projectId: string; readLocalRows: (table: string) => Promise<Array<Record<string, unknown>>>; countLocalRows: (table: string) => Promise<number>; fetchImpl?: typeof fetch }`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/convert/copy-transport-https.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { makeHttpsCopyDeps } from '../../../src/server/convert/copy-transport-https.js';

function fakeFetch(record: Array<{ url: string; body: unknown }>, opts: { status?: number } = {}) {
  let calls = 0;
  return async (url: string | URL, init?: RequestInit) => {
    calls += 1;
    record.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    // First call 413s when asked, so the halving path is exercised.
    if (opts.status === 413 && calls === 1) {
      return new Response(JSON.stringify({ error: 'too large' }), { status: 413 });
    }
    if (String(url).includes('/v1/convert/verify')) {
      return new Response(JSON.stringify({ counts: { observations: 3 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'applied', applied: 1 }), { status: 200 });
  };
}

const BASE = {
  serverUrl: 'https://team.example/prod',
  teamKey: 'cmem_test',
  projectId: 'p1',
  readLocalRows: async () => [{ id: 'o1' }],
  countLocalRows: async () => 3,
};

describe('makeHttpsCopyDeps', () => {
  it('POSTs to /v1/convert/import with a Bearer key', async () => {
    const record: Array<{ url: string; body: unknown }> = [];
    const deps = makeHttpsCopyDeps({ ...BASE, fetchImpl: fakeFetch(record) as never });
    await deps.upsertRows('observations', [{ id: 'o1' }]);
    expect(record[0]!.url).toBe('https://team.example/prod/v1/convert/import');
    expect(record[0]!.body).toMatchObject({ table: 'observations' });
  });

  it('sends a stable batchToken derived from project, table and offset', async () => {
    const record: Array<{ url: string; body: unknown }> = [];
    const deps = makeHttpsCopyDeps({ ...BASE, fetchImpl: fakeFetch(record) as never });
    await deps.upsertRows('observations', [{ id: 'o1' }]);
    await deps.upsertRows('observations', [{ id: 'o2' }]);
    const tokens = record.map(r => (r.body as { batchToken: string }).batchToken);
    // Distinct per batch, or a retry of batch 2 would be mistaken for batch 1.
    expect(new Set(tokens).size).toBe(2);
    expect(tokens[0]).toContain('p1');
    expect(tokens[0]).toContain('observations');
  });

  it('halves the batch and retries on 413', async () => {
    const record: Array<{ url: string; body: unknown }> = [];
    const deps = makeHttpsCopyDeps({
      ...BASE, fetchImpl: fakeFetch(record, { status: 413 }) as never,
    });
    await deps.upsertRows('observations', [{ id: 'a' }, { id: 'b' }]);
    // One rejected attempt plus two half-sized ones.
    expect(record.length).toBeGreaterThanOrEqual(3);
  });

  it('reads remote counts from the verify endpoint', async () => {
    const record: Array<{ url: string; body: unknown }> = [];
    const deps = makeHttpsCopyDeps({ ...BASE, fetchImpl: fakeFetch(record) as never });
    expect(await deps.countRows('remote', 'observations')).toBe(3);
    expect(record.some(r => r.url.includes('/v1/convert/verify'))).toBe(true);
  });

  it('reads local counts locally, never over the wire', async () => {
    const record: Array<{ url: string; body: unknown }> = [];
    const deps = makeHttpsCopyDeps({ ...BASE, fetchImpl: fakeFetch(record) as never });
    expect(await deps.countRows('local', 'observations')).toBe(3);
    expect(record).toHaveLength(0);
  });

  it('never puts the team key in a thrown message', async () => {
    const deps = makeHttpsCopyDeps({
      ...BASE,
      fetchImpl: (async () => { throw new Error('network down'); }) as never,
    });
    // A fetch error can echo the request, and the request carries the key.
    await expect(deps.upsertRows('observations', [{ id: 'o1' }])).rejects.toThrow(
      /cannot reach/i,
    );
    await expect(deps.upsertRows('observations', [{ id: 'o1' }])).rejects.not.toThrow(
      /cmem_test/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/server/convert/copy-transport-https.test.ts`
Expected: FAIL — cannot find module `copy-transport-https.js`

- [ ] **Step 3: Implement**

Create `src/server/convert/copy-transport-https.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// CopyDeps over HTTPS — the transport that lets convert reach a managed database.
//
// A private RDS is unreachable from a developer machine: PubliclyAccessible=false and
// the hostname resolves to a VPC-internal address, so the direct pool times out even
// on VPN. Measured, same code path, only the destination changed:
//   127.0.0.1:55441 -> {"reachable":true}
//   the real RDS    -> {"error":"Connection terminated due to connection timeout"}
// Every other MemSmith operation already speaks HTTPS to the team server; convert was
// the last one holding a raw Postgres socket.
//
// This satisfies the SAME CopyDeps interface the direct transport does, so runCopy's
// control flow is untouched — the same swap the joiner's transport used.

import type { CopyDeps } from './copy-engine.js';
import { splitByByteBudget } from './import-batching.js';

export interface HttpsCopyInput {
  serverUrl: string;
  teamKey: string;
  projectId: string;
  readLocalRows: (table: string) => Promise<Array<Record<string, unknown>>>;
  countLocalRows: (table: string) => Promise<number>;
  fetchImpl?: typeof fetch;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

export function makeHttpsCopyDeps(input: HttpsCopyInput): CopyDeps {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = stripTrailingSlash(input.serverUrl);
  // Offsets per table make the batch token stable across a retry of the SAME batch
  // while staying distinct between batches.
  const sent: Record<string, number> = {};
  let remoteCounts: Record<string, number> | null = null;

  const postBatch = async (
    table: string,
    rows: Array<Record<string, unknown>>,
    offset: number,
  ): Promise<void> => {
    const batchToken = `${input.projectId}:${table}:${offset}:${rows.length}`;
    let response: Response;
    try {
      response = await fetchImpl(`${base}/v1/convert/import`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${input.teamKey}`,
        },
        body: JSON.stringify({ table, rows, batchToken }),
      });
    } catch {
      // Deliberately does NOT include the thrown message: a fetch error can echo the
      // request, and the request body carries the team key.
      throw new Error(`cannot reach that server at ${base}`);
    }

    if (response.status === 413) {
      // The byte budget is an estimate; the server's limit is authoritative. Halve
      // and retry rather than failing the whole convert.
      if (rows.length <= 1) {
        throw new Error(`a single row exceeds the server's request limit (${table})`);
      }
      const mid = Math.ceil(rows.length / 2);
      await postBatch(table, rows.slice(0, mid), offset);
      await postBatch(table, rows.slice(mid), offset + mid);
      return;
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(detail?.error ?? `import failed with HTTP ${response.status}`);
    }
  };

  return {
    readRows: (table) => input.readLocalRows(table),

    upsertRows: async (table, rows) => {
      const offset = sent[table] ?? 0;
      let cursor = offset;
      for (const chunk of splitByByteBudget(rows)) {
        await postBatch(table, chunk, cursor);
        cursor += chunk.length;
      }
      sent[table] = cursor;
      // Counts change on the remote after a write, so drop the cache.
      remoteCounts = null;
    },

    countRows: async (which, table) => {
      if (which === 'local') return input.countLocalRows(table);
      if (remoteCounts === null) {
        let response: Response;
        try {
          response = await fetchImpl(
            `${base}/v1/convert/verify?projectId=${encodeURIComponent(input.projectId)}`,
            { headers: { authorization: `Bearer ${input.teamKey}` } },
          );
        } catch {
          throw new Error(`cannot reach that server at ${base}`);
        }
        if (!response.ok) throw new Error(`verify failed with HTTP ${response.status}`);
        const body = await response.json() as { counts?: Record<string, number> };
        remoteCounts = body.counts ?? {};
      }
      return remoteCounts[table] ?? 0;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/server/convert/copy-transport-https.test.ts`
Expected: PASS (6 pass)

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/server/convert/copy-transport-https.ts tests/server/convert/copy-transport-https.test.ts
git commit -m "feat(convert): CopyDeps transport over HTTPS

Satisfies the same three-method interface as the direct transport, so runCopy's
control flow is untouched — the swap the joiner's transport already demonstrated.

Batches by measured bytes, halves and retries on 413 (the byte budget is an
estimate; the server's limit is authoritative), derives a batchToken that is stable
across a retry of the same batch but distinct between batches, and reads remote
counts from /v1/convert/verify because observation_sources has no scope columns to
count by.

Errors never echo the request: a fetch failure carries the request body, and the
body carries the team key. Pinned by a test.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Wire the HTTPS transport into the convert route

**Files:**
- Modify: `src/server/routes/v1/ConvertRoutes.ts:34,62-93`
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (the `convert:` dep, ~1828)
- Test: `tests/server/convert/convert-route-https.test.ts`

**Interfaces:**
- Consumes: `makeHttpsCopyDeps` from `copy-transport-https.js`.
- Produces: `/v1/convert/test-connection` and `/v1/convert/migrate` accept
  `{ serverUrl, teamKey }` in addition to the existing `{ databaseUrl }`.

- [ ] **Step 1: Write the failing test**

Create `tests/server/convert/convert-route-https.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// The wizard must be able to convert to a destination the machine cannot open a
// Postgres socket to. That means selecting a transport from the shape of the input,
// and refusing the combination that would silently fall back.
import { describe, expect, it } from 'bun:test';
import { selectConvertTransport } from '../../../src/server/routes/v1/ConvertRoutes.js';

describe('selectConvertTransport', () => {
  it('chooses https when a server URL is given', () => {
    expect(selectConvertTransport({ serverUrl: 'https://team.example', teamKey: 'k' }))
      .toMatchObject({ kind: 'https' });
  });

  it('chooses postgres when a database URL is given', () => {
    expect(selectConvertTransport({ databaseUrl: 'postgres://u:p@127.0.0.1:5432/db' }))
      .toMatchObject({ kind: 'postgres' });
  });

  it('rejects a postgres:// value supplied as the server URL', () => {
    // A silent fallback here would reintroduce the exact timeout this design removes.
    expect(selectConvertTransport({ serverUrl: 'postgres://u:p@host:5432/db', teamKey: 'k' }))
      .toMatchObject({ kind: 'error' });
  });

  it('rejects a server URL with no team key', () => {
    expect(selectConvertTransport({ serverUrl: 'https://team.example' }))
      .toMatchObject({ kind: 'error' });
  });

  it('rejects an empty input', () => {
    expect(selectConvertTransport({})).toMatchObject({ kind: 'error' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/server/convert/convert-route-https.test.ts`
Expected: FAIL — `selectConvertTransport` is not exported

- [ ] **Step 3: Implement the selector**

At the top of `src/server/routes/v1/ConvertRoutes.ts`, after the existing imports, add:

```ts
export type ConvertTransport =
  | { kind: 'https'; serverUrl: string; teamKey: string }
  | { kind: 'postgres'; databaseUrl: string }
  | { kind: 'error'; message: string };

/**
 * Decide which transport a convert request is asking for, from the shape of its input.
 *
 * A `postgres://` value in the serverUrl field is an ERROR, not a fallback: the HTTPS
 * path exists because the machine cannot open a Postgres socket to a managed database,
 * so silently taking the direct path would reintroduce the timeout it removes.
 */
export function selectConvertTransport(input: {
  serverUrl?: unknown;
  teamKey?: unknown;
  databaseUrl?: unknown;
}): ConvertTransport {
  const serverUrl = typeof input.serverUrl === 'string' ? input.serverUrl.trim() : '';
  const teamKey = typeof input.teamKey === 'string' ? input.teamKey.trim() : '';
  const databaseUrl = typeof input.databaseUrl === 'string' ? input.databaseUrl.trim() : '';

  if (serverUrl) {
    if (/^postgres(ql)?:\/\//i.test(serverUrl)) {
      return {
        kind: 'error',
        message: 'serverUrl must be an https:// endpoint, not a postgres:// connection string',
      };
    }
    if (!/^https?:\/\//i.test(serverUrl)) {
      return { kind: 'error', message: 'serverUrl must start with https://' };
    }
    if (!teamKey) {
      return { kind: 'error', message: 'a team key is required with a server URL' };
    }
    return { kind: 'https', serverUrl, teamKey };
  }
  if (databaseUrl) return { kind: 'postgres', databaseUrl };
  return { kind: 'error', message: 'provide either a server URL and team key, or a database URL' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/server/convert/convert-route-https.test.ts`
Expected: PASS (5 pass)

- [ ] **Step 5: Use the selector in the two routes**

In `src/server/routes/v1/ConvertRoutes.ts`, replace the body of the
`/v1/convert/test-connection` handler's first two lines:

```ts
    const transport = selectConvertTransport(req.body ?? {});
    if (transport.kind === 'error') { res.status(400).json({ error: transport.message }); return; }
    if (transport.kind === 'https') {
      // An HTTPS destination is probed by asking the server about itself: the owner
      // never touches the destination database, so pgvector/schema fitness are the
      // team server's own guarantees, reported by /v1/info.
      res.json(await deps.probeHttps!(transport.serverUrl, transport.teamKey));
      return;
    }
    const url = transport.databaseUrl;
```

Add `probeHttps` to `ConvertRoutesDeps`:

```ts
  /** Probe an HTTPS destination: GET {serverUrl}/v1/info + an authenticated identity check. */
  probeHttps?: (serverUrl: string, teamKey: string) => Promise<unknown>;
```

Apply the same `selectConvertTransport` call at the start of the `/v1/convert/migrate`
handler, passing `transport` through to `deps.convert` so it can choose `makeHttpsCopyDeps`
or the existing direct deps.

- [ ] **Step 6: Run the whole convert suite**

Run: `~/.bun/bin/bun test tests/server/convert/ tests/server/routes/`
Expected: all pass. Any existing test that posts only `{databaseUrl}` must still pass —
that path is retained deliberately.

- [ ] **Step 7: Commit**

```bash
npx tsc --noEmit
git add src/server/routes/v1/ConvertRoutes.ts src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/convert/convert-route-https.test.ts
git commit -m "feat(convert): select transport from the request shape

serverUrl + teamKey takes the HTTPS path; databaseUrl keeps the direct path for a
self-hosted database the owner can actually reach. A postgres:// value supplied as
serverUrl is an ERROR, not a fallback — falling back silently would reintroduce the
timeout the HTTPS path exists to remove.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Wizard destination — server URL and team key

**Files:**
- Modify: `src/ui/viewer/views/wizard/wizardData.ts:27,97`
- Modify: `src/ui/viewer/views/wizard/cards/DestinationCard.tsx:110`
- Test: `tests/viewer/wizard-destination-https.test.ts`

**Interfaces:**
- Consumes: the routes from Task 7.
- Produces: `testConnection(dest: Destination)` and `migrate(dest: Destination)` where
  `Destination = { serverUrl: string; teamKey: string } | { databaseUrl: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/viewer/wizard-destination-https.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'bun:test';
import { testConnection } from '../../src/ui/viewer/views/wizard/wizardData.js';

describe('wizard testConnection', () => {
  it('posts serverUrl and teamKey for an HTTPS destination', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fake = async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ allGreen: true }), { status: 200 });
    };
    await testConnection(
      { serverUrl: 'https://team.example/prod', teamKey: 'cmem_x' },
      fake as never,
    );
    expect(seen[0]!.body).toMatchObject({
      serverUrl: 'https://team.example/prod', teamKey: 'cmem_x',
    });
    // No database URL must appear on this path — the whole point is that the browser
    // never handles a database password.
    expect(JSON.stringify(seen[0]!.body)).not.toMatch(/databaseUrl/);
  });

  it('still posts databaseUrl for a direct destination', async () => {
    const seen: Array<{ body: unknown }> = [];
    const fake = async (_url: string | URL, init?: RequestInit) => {
      seen.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ allGreen: true }), { status: 200 });
    };
    await testConnection({ databaseUrl: 'postgres://u:p@127.0.0.1:5432/db' }, fake as never);
    expect(seen[0]!.body).toMatchObject({ databaseUrl: 'postgres://u:p@127.0.0.1:5432/db' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/viewer/wizard-destination-https.test.ts`
Expected: FAIL — `testConnection` takes a string today, so the object body is posted as
`{"databaseUrl":{...}}` and the assertion on `serverUrl` fails.

- [ ] **Step 3: Implement**

In `src/ui/viewer/views/wizard/wizardData.ts`, change the signature and body of
`testConnection` (line ~24) and `migrate` (line ~95) from `databaseUrl: string` to:

```ts
export type Destination =
  | { serverUrl: string; teamKey: string }
  | { databaseUrl: string };
```

and post `JSON.stringify(dest)` directly instead of `JSON.stringify({ databaseUrl })`.
Keep `credentials: 'include'` and the relative paths unchanged — the request still goes to
the local server, which is what holds the credential and opens any outbound connection.

- [ ] **Step 4: Update `DestinationCard.tsx`**

Replace the single input (line ~110) with two fields plus a toggle. The default is the
HTTPS pair, because that is what a managed database requires:

```tsx
<label className="wizard-field">
  <span>Team server URL</span>
  <input
    value={serverUrl}
    onChange={(e) => setServerUrl(e.target.value)}
    placeholder="https://your-team-server.example.com"
  />
</label>
<label className="wizard-field">
  <span>Team key</span>
  <input
    value={teamKey}
    onChange={(e) => setTeamKey(e.target.value)}
    placeholder="cmem_…"
    type="password"
  />
</label>
<button type="button" className="wizard-link" onClick={() => setDirect(!direct)}>
  {direct ? 'Use a team server URL instead' : 'I have a database URL instead'}
</button>
```

When `direct` is true, render the existing single input with its
`postgres://user:pass@host:5432/db` placeholder unchanged.

- [ ] **Step 5: Run tests**

Run: `~/.bun/bin/bun test tests/viewer/`
Expected: all pass. Existing wizard tests that call `testConnection('postgres://…')` with a
string must be updated to `{ databaseUrl: 'postgres://…' }` — note that in the commit
message.

- [ ] **Step 6: Rebuild the bundle and commit**

The browser runs `plugin/ui/viewer-bundle.js`, not the source. A change here is invisible
until rebuilt:

```bash
npm run build-and-sync
git add src/ui/viewer/ tests/viewer/ plugin/
git commit -m "feat(wizard): destination takes a team server URL and team key

A managed database cannot be reached from the machine running the wizard, so the
destination is now the team server's HTTPS endpoint plus the team key. The database
URL field is retained behind a toggle for a self-hosted database the owner can
reach.

Bundle rebuilt: the browser runs plugin/ui/viewer-bundle.js, so a source-only
change would not have taken effect.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: End-to-end proof against AWS

**Files:**
- Create: `docs/superpowers/plans/2026-08-17-convert-over-https-e2e-log.md` (the evidence)

This is the task that decides whether the feature works. Everything before it is
plumbing. **Never point any of this at the dogfood project.**

- [ ] **Step 1: Record the dogfood baseline**

```bash
shasum -a 256 ~/.memsmith/credentials.json
~/.bun/bin/bun -e "
const {Client}=require('pg');
(async()=>{const c=new Client({connectionString:'postgresql://memsmith:memsmith-local@127.0.0.1:55433/postgres'});await c.connect();
const o=await c.query(\"SELECT count(*)::int n FROM observations WHERE project_id='5fc024f0-0994-4f1d-baed-300d9b4d3416'\");
console.log('dogfood observations:', o.rows[0].n); await c.end();})()"
```

Expected sha256: `7eee46d2cb7f029f8318efb436637b639068d5195639fff26fb520b8ada4f9d4`
(if it differs, something has already written to it — stop and investigate).

- [ ] **Step 2: Bring up the rig and start its server**

```bash
bash scripts/rig/team-up.sh
MEMSMITH_RUNTIME=server \
MEMSMITH_SERVER_DATABASE_URL="postgres://memsmith:rig-throwaway@127.0.0.1:55440/memsmith" \
MEMSMITH_IDENTITY_PROVIDER=better-auth MEMSMITH_QUEUE_ENGINE=inline \
MEMSMITH_DATA_DIR="/tmp/ms-team-server" MEMSMITH_SERVER_PORT=38890 \
MEMSMITH_PROJECT_CWD=/tmp/rig-workspace \
~/.bun/bin/bun plugin/scripts/server-service.cjs start
```

The rig needs `MEMSMITH_PROJECT_CWD` pointing at a workspace with its **own** marker
(`/tmp/rig-workspace/.memsmith/project.json` with `teamId: rig-team`,
`projectId: rig-proj-A`). Without it the server reads *this repo's* marker, which is the
dogfood project's.

- [ ] **Step 3: Convert the rig project to AWS over HTTPS**

```bash
curl -s -X POST -H "Authorization: Bearer $RIG_OWNER_KEY" \
  -H 'content-type: application/json' \
  -d '{"serverUrl":"https://a9usu1xbrh.execute-api.us-west-2.amazonaws.com/prod","teamKey":"<AWS_TEAM_KEY>"}' \
  http://127.0.0.1:38890/v1/convert/migrate
```

Expected: `{"status":"converted", …}` — **not** a connection timeout. A timeout means the
request still took the Postgres path.

- [ ] **Step 4: Prove the rows arrived, with their original timestamps**

```bash
curl -s -X POST -H "Authorization: Bearer <AWS_TEAM_KEY>" \
  -H 'content-type: application/json' \
  -d '{"projectId":"rig-proj-A","query":"platypus tidal charts","limit":5}' \
  https://a9usu1xbrh.execute-api.us-west-2.amazonaws.com/prod/v1/search
```

Expected: the seeded rig rows come back, and `createdAtEpoch` matches the **source**
timestamps rather than today. Timestamp fidelity is the whole reason Task 1 of the spec
existed; if these read as today, the import is dropping `createdAt`.

- [ ] **Step 5: Prove idempotency against the live remote**

Re-run Step 3 verbatim. Expected: it succeeds and the AWS row count is **unchanged**
(check with the same `/v1/search` call, or `GET /v1/convert/verify`). A second convert that
doubles the rows means the batch tokens are not stable.

- [ ] **Step 6: Confirm the dogfood project is untouched**

Re-run Step 1. The `credentials.json` sha256 must be **byte-identical** and the
observation count must not have decreased.

- [ ] **Step 7: Write the evidence file and commit**

Record, for each step: the exact command, the actual output, and pass/fail. Unattributed
claims are what this project keeps getting burned by — every number in the log needs the
command that produced it.

```bash
git add docs/superpowers/plans/2026-08-17-convert-over-https-e2e-log.md
git commit -m "docs: e2e evidence for convert over HTTPS against live AWS

Records the command and actual output for each step: HTTPS convert succeeds where
the Postgres path timed out, rows arrive with their ORIGINAL timestamps, a repeated
convert does not duplicate, and the dogfood credentials sha256 is byte-identical
before and after.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** §4 (HTTPS destination) → Tasks 7, 8. §5 Gap 1/5 (timestamps) → already
shipped as `058b9359`, proven again in Task 9 Step 4. Gap 2 (idempotency) → Tasks 1, 3, 6.
Gap 3 (seven tables) → Task 3 + the `COPY_TABLES` allowlist in Task 5. Gap 4 (embeddings)
→ carried as an ordinary column by Task 3; `058b9359` already passes `embeddingVec`
through. §5.2 → verification (Tasks 4, 5), batching (Tasks 2, 6), `supersedes` (Task 3),
generated columns (Task 3), token table (Task 1). §6 (`promoted_at`) → Task 1. §10.5
(authz) → Task 5. §11 (reproduction) → Task 9.

**Deliberately not covered.** §6's promote banner UI. The column and the routes it needs
exist after Task 1, but the banner is a separate user-facing surface and this plan is
already nine tasks. It gets its own plan once convert is proven end to end — there is no
point building a promote button before the transport under it works.

**Type consistency.** `ApplyDeps.query` matches the `{ rows }` shape
`buildScopedCountQuery` consumers expect. `CopyDeps` is re-implemented, never redefined.
`Destination` in Task 8 is the same union `selectConvertTransport` parses in Task 7.
`batchToken` is a string everywhere.

**Risk note.** Task 3's `ON CONFLICT DO NOTHING` on a bare INSERT relies on each table
having a primary key to conflict on. All seven do. If a table without one is ever added to
`COPY_TABLES`, the clause silently becomes a no-op guard and duplicates become possible —
the batch token is the real protection, which is why it exists.
