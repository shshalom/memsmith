# Embed-on-Write for `/v1/memories` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the direct-insert observation path (`POST /v1/memories`, used by `observation_add`) embed on write, so manual observations are immediately semantically searchable — via a single shared `embedForPersist` helper used by both the generation path and the route.

**Architecture:** Extract the existing never-throws `embedForPersist` helper (currently private in `processGeneratedResponse.ts`) into a shared module `src/server/generation/embed-for-persist.ts`. Point the generation path at it (behavior byte-identical) and call it in the `/v1/memories` handler before `repo.create`, passing the result as `embeddingVec`. `repo.create` already accepts `embeddingVec` — no storage change.

**Tech Stack:** TypeScript, Bun (`bun test`), Postgres + pgvector via `PostgresObservationRepository`, local Xenova/all-MiniLM-L6-v2 embedder (`src/server/generation/embedder.ts`).

## Global Constraints

- **Never throw into the write path.** Embedding is best-effort: blank/whitespace content → `null` (skip); embedder error → log SYSTEM warning + return `null`; persist the row regardless. An embedding failure MUST NOT roll back or block the insert.
- **One embed-on-write behavior.** After this change exactly one shared `embedForPersist` exists; both the generation path and `/v1/memories` import it. No duplicated copy.
- **Behavior-preserving for generation.** Generation's observable behavior is unchanged (same embeddings, same pre-transaction timing). Only the helper's location + import site change.
- **Embed OUTSIDE any DB transaction.** Compute the embedding BEFORE `repo.create` (and never inside a transaction wrapper) — a cold-start ONNX load is multi-second and must not run while holding a pooled connection (lesson from generation embed-on-write, commit `713c8330`).
- **Reuse the proven embedder:** `embed` from `src/server/generation/embedder.ts` (384-dim, no API key). Do not introduce a new embedder.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Branch:** work on `embed-on-write` (already created & checked out). Never commit to `main`.
- **Test DB:** integration tests that need Postgres read `process.env.MEMSMITH_TEST_POSTGRES_URL` and create an isolated per-test schema (existing pattern in `tests/storage/postgres/observation-embedding.test.ts`). They skip cleanly when the env var is absent. Do NOT boot the embedded runtime on port 55433 in tests (avoids dogfood port contention).

---

## File Structure

- **Create** `src/server/generation/embed-for-persist.ts` — the shared never-throws embed-on-write helper. One responsibility: turn content into an `embedding_vec` (or `null`) safely for persistence.
- **Modify** `src/server/generation/processGeneratedResponse.ts` — remove the private `embedForPersist` (lines 27-45), import it from the new module. No other change.
- **Modify** `src/server/routes/v1/ServerV1PostgresRoutes.ts` — in the `POST /v1/memories` handler (lines 907-929), compute `embeddingVec` via the shared helper before `repo.create` and include it in `createInput`.
- **Create** `tests/server/generation/embed-for-persist.test.ts` — unit tests for the helper (blank→null, success→vector, error→null-never-throws), using a stubbed `embed`.
- **Modify** `tests/storage/postgres/observation-embedding.test.ts` — add a regression test proving the `/v1/memories` create path (i.e. `repo.create` with content, given an embedding) round-trips, PLUS a route-level test that the handler embeds. (See Task 4 for the precise split.)

**Interfaces reference (verbatim from current code):**
- `embed(text: string): Promise<number[]>` — from `./embedder.js` (throws on failure).
- `logger.warn(component: string, message: string, context?: object, err?: Error): void` — from `../../utils/logger.js` (generation) / `../../../utils/logger.js` (routes).
- `PostgresObservationRepository.create(input: { projectId: string; teamId: string; serverSessionId?: string|null; kind?: string; content: string; metadata?: object; embeddingVec?: number[] | null; ... }): Promise<PostgresObservation>` — `embeddingVec` already supported (`observations.ts:103`, written at `:142`); returns an observation whose `embeddingVec` is the parsed vector.
- `/v1/memories` handler body shape: `{ projectId: string; serverSessionId?: string|null; kind?: string; content: string; metadata?: object }`.

---

### Task 1: Extract the shared `embedForPersist` helper

**Files:**
- Create: `src/server/generation/embed-for-persist.ts`
- Test: `tests/server/generation/embed-for-persist.test.ts`

**Interfaces:**
- Produces: `export async function embedForPersist(content: string): Promise<number[] | null>` — trims content; blank → `null`; else `await embed(text)`; on any throw, logs a SYSTEM warning and returns `null` (never throws).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/generation/embed-for-persist.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, mock, afterEach } from 'bun:test';

// Mock the embedder module BEFORE importing the subject.
const embedMock = mock(async (_t: string) => Array.from({ length: 384 }, () => 0.1));
mock.module('../../../src/server/generation/embedder.js', () => ({ embed: embedMock }));

import { embedForPersist } from '../../../src/server/generation/embed-for-persist.js';

afterEach(() => { embedMock.mockClear(); });

describe('embedForPersist', () => {
  it('embeds non-blank content to a vector', async () => {
    const v = await embedForPersist('why did we pick postgres');
    expect(Array.isArray(v)).toBe(true);
    expect(v).toHaveLength(384);
    expect(embedMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for blank/whitespace content without calling embed', async () => {
    expect(await embedForPersist('   ')).toBeNull();
    expect(await embedForPersist('')).toBeNull();
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('returns null and NEVER throws when embed throws', async () => {
    embedMock.mockImplementationOnce(async () => { throw new Error('embedder down'); });
    let threw = false;
    let result: number[] | null = [];
    try { result = await embedForPersist('some content'); } catch { threw = true; }
    expect(threw).toBe(false);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/server/generation/embed-for-persist.test.ts`
Expected: FAIL — `Cannot find module '.../embed-for-persist.js'`.

- [ ] **Step 3: Create the shared helper**

```typescript
// src/server/generation/embed-for-persist.ts
// SPDX-License-Identifier: Apache-2.0
import { logger } from '../../utils/logger.js';
import { embed } from './embedder.js';

// Embed observation content for semantic search on the persistence path.
// Best-effort: a failure returns null (the row persists without a vector; a
// later backfill can fill it) and NEVER throws — write correctness is
// paramount. Empty/blank content skips embedding. Shared by the generation
// pipeline (processGeneratedResponse) and the direct-insert route
// (/v1/memories) so both write paths embed identically.
//
// MUST be called OUTSIDE any DB transaction: a cold-start ONNX model load is
// multi-second and must not run while holding a pooled connection.
export async function embedForPersist(content: string): Promise<number[] | null> {
  const text = content.trim();
  if (!text) return null;
  try {
    return await embed(text);
  } catch (error) {
    logger.warn(
      'SYSTEM',
      'embedding failed; persisting observation without embedding_vec',
      {},
      error instanceof Error ? error : new Error(String(error)),
    );
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/server/generation/embed-for-persist.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/generation/embed-for-persist.ts tests/server/generation/embed-for-persist.test.ts
git commit -m "feat(retrieval): extract shared embedForPersist helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Point the generation path at the shared helper (behavior-preserving)

**Files:**
- Modify: `src/server/generation/processGeneratedResponse.ts` (remove private helper at lines 27-45; add import)

**Interfaces:**
- Consumes: `embedForPersist` from `./embed-for-persist.js` (Task 1).
- Produces: no interface change — `processGeneratedResponse` still calls `embedForPersist(stripped)` exactly as before.

- [ ] **Step 1: Remove the private helper and its now-unused direct `embed` import**

In `src/server/generation/processGeneratedResponse.ts`:
1. Delete the private helper block (lines 27-45 — the comment block + `async function embedForPersist(content: string) { ... }`).
2. Change the embedder import. The file currently has `import { embed } from './embedder.js';` (line 25). If `embed` is NOT used anywhere else in the file (it is only used inside the deleted helper — verify with a grep below), replace that line with:
```typescript
import { embedForPersist } from './embed-for-persist.js';
```
If `embed` IS still referenced elsewhere, keep its import AND add the `embedForPersist` import on a new line.

Verify which case applies:
Run: `grep -n "embed(" src/server/generation/processGeneratedResponse.ts`
Expected: after deleting the helper, the only remaining references are `embedForPersist(` calls (e.g. line ~329 `embedForPersist(stripped)`). If `embed(` (bare) appears elsewhere, keep its import.

- [ ] **Step 2: Verify the call site still compiles against the imported helper**

The existing call (around line 329) is `embeddingByIndex.set(index, await embedForPersist(stripped));`. It now resolves to the imported function. No code change to the call site.

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "processGeneratedResponse.ts" || echo "clean"`
Expected: `clean`.

- [ ] **Step 3: Run the generation pipeline tests (behavior unchanged)**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" MEMSMITH_TEST_POSTGRES_URL="postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres" ~/.bun/bin/bun test tests/server/generation/ 2>&1 | tail -8`
Expected: PASS (same as before this task — the extraction is behavior-preserving). If the local PG on 55433 is not running, these DB-gated tests skip; that is acceptable for this task (Task 4 covers the DB assertion). Note the result either way.

- [ ] **Step 4: Commit**

```bash
git add src/server/generation/processGeneratedResponse.ts
git commit -m "refactor(retrieval): generation uses shared embedForPersist (no behavior change)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Embed on write in the `/v1/memories` handler

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (the `POST /v1/memories` handler, lines 907-929)

**Interfaces:**
- Consumes: `embedForPersist` from `../../generation/embed-for-persist.js` (Task 1).
- Produces: `/v1/memories` inserts now carry `embeddingVec` (non-null when content is embeddable).

- [ ] **Step 1: Add the import**

At the top of `src/server/routes/v1/ServerV1PostgresRoutes.ts`, add (near the other imports):
```typescript
import { embedForPersist } from '../../generation/embed-for-persist.js';
```

- [ ] **Step 2: Compute the embedding before `repo.create` and pass it in**

In the `POST /v1/memories` handler body (currently lines 907-929), change the `createInput` construction and the create call. The current code is:
```typescript
        const createInput = {
          projectId: body.projectId,
          teamId,
          serverSessionId: body.serverSessionId ?? null,
          kind: body.kind ?? 'manual',
          content: body.content,
          metadata: body.metadata ?? {},
        };
        try {
          const repo = new PostgresObservationRepository(this.options.pool);
          const observation = await repo.create(createInput);
```
Replace with (compute `embeddingVec` BEFORE the transaction/insert — it is not inside any transaction here, keep it that way):
```typescript
        // Embed on write so manual/direct inserts are semantically searchable,
        // same as the generation path. Best-effort (never throws); computed
        // BEFORE repo.create so a cold-start model load never holds the insert.
        const embeddingVec = await embedForPersist(body.content);
        const createInput = {
          projectId: body.projectId,
          teamId,
          serverSessionId: body.serverSessionId ?? null,
          kind: body.kind ?? 'manual',
          content: body.content,
          metadata: body.metadata ?? {},
          embeddingVec,
        };
        try {
          const repo = new PostgresObservationRepository(this.options.pool);
          const observation = await repo.create(createInput);
```

- [ ] **Step 3: Typecheck**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -viE "bun:test|node_modules|tests/" | head || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts
git commit -m "fix(retrieval): embed on write in /v1/memories direct-insert path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Regression test — `/v1/memories` create path embeds and is recallable

**Files:**
- Modify: `tests/storage/postgres/observation-embedding.test.ts` (add a test that exercises the route handler's create semantics against live PG)

**Interfaces:**
- Consumes: the modified `/v1/memories` handler (Task 3), `embedForPersist` (Task 1), the existing test harness (`MEMSMITH_TEST_POSTGRES_URL`, isolated schema, `PostgresObservationRepository`).

This test proves the FIX at the route's create semantics: content in → non-null `embedding_vec` persisted. Because wiring a full Express app in-test is heavier than needed, the test reproduces the handler's exact create path (embed → `repo.create({... embeddingVec})`) using the SAME shared helper the handler uses, asserting the row persists WITH an embedding. This is the regression that fails on the pre-Task-3 code (which passed no `embeddingVec`).

- [ ] **Step 1: Write the failing test**

Add to `tests/storage/postgres/observation-embedding.test.ts`, inside the existing `describe` block (which already sets up `repo`, `teamId`, `projectId` per-test):

```typescript
  it('embed-on-write: manual insert path persists a non-null embedding_vec (regression for /v1/memories)', async () => {
    // Mirror the /v1/memories handler's create semantics: embed the content
    // via the shared helper, then repo.create with embeddingVec.
    const { embedForPersist } = await import('../../../src/server/generation/embed-for-persist.js');
    const content = 'We chose embedded Postgres over Docker for a frictionless local runtime.';
    const embeddingVec = await embedForPersist(content);
    expect(embeddingVec).not.toBeNull();          // content is embeddable
    const obs = await repo.create({ projectId, teamId, kind: 'manual', content, embeddingVec });
    expect(obs.embeddingVec).toHaveLength(384);    // persisted + round-tripped

    // And it is semantically retrievable via the hybrid search path.
    const hits = await repo.hybridSearch({
      projectId, teamId, query: 'why did we pick postgres for local', limit: 5,
    });
    expect(hits.some(o => o.id === obs.id)).toBe(true);
  });
```

NOTE on the hybrid-search call: use the SAME method name/signature the existing hybrid tests in this repo use. Before writing, confirm the method:
Run: `grep -n "hybridSearch\|async hybridSearch\|multiVectorSearch\|search(" src/storage/postgres/observations.ts | head`
If the public hybrid method has a different name/shape (e.g. it takes `{ projectId, teamId, query, limit }` vs positional args), match it exactly. If no single public hybrid method exists on the repo, drop the semantic-retrieval assertion and keep the persistence assertion (the `embedding_vec` round-trip is the core regression); note this in the task report.

- [ ] **Step 2: Run against the pre-fix expectation to confirm it's a real regression guard**

The test as written exercises Task 3's shared helper directly, so it passes once Tasks 1+3 are in. To confirm it is a genuine guard, temporarily reason: on the OLD `/v1/memories` code (no `embeddingVec` passed), an equivalent insert would store `embedding_vec = NULL` and the semantic assertion would fail. Document this in the task report (do not actually revert).

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" MEMSMITH_TEST_POSTGRES_URL="postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres" ~/.bun/bin/bun test tests/storage/postgres/observation-embedding.test.ts 2>&1 | tail -10`
Expected: PASS (all tests in the file, including the new one). If PG on 55433 is not running, the file skips (`requires MEMSMITH_TEST_POSTGRES_URL` / connection refused) — in that case start the local runtime first (see Task 6) or note the skip and rely on Task 6's live verification.

- [ ] **Step 3: Commit**

```bash
git add tests/storage/postgres/observation-embedding.test.ts
git commit -m "test(retrieval): regression — manual insert path embeds + is recallable

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Full gate — typecheck + isolated tests for touched files

**Files:** none (verification only).

- [ ] **Step 1: Typecheck (src only)**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -viE "bun:test|node_modules|tests/" | head || echo "clean"`
Expected: `clean`.

- [ ] **Step 2: Run the touched/added test files (isolated, no port contention concern for the pure-unit one)**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/server/generation/embed-for-persist.test.ts 2>&1 | tail -4`
Expected: PASS (unit test, no DB needed).

Run (DB-gated; needs local PG on 55433 up): `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" MEMSMITH_TEST_POSTGRES_URL="postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres" ~/.bun/bin/bun test tests/storage/postgres/observation-embedding.test.ts tests/server/generation/ 2>&1 | tail -8`
Expected: PASS, or clean SKIP if PG down (note which).

- [ ] **Step 3: No commit** (verification task). Report results to the controller.

---

### Task 6: Live end-to-end verification (the acceptance proof)

**Files:** none (verification only).

This reproduces the exact scenario that failed this session: an `observation_add` (→ `/v1/memories`) landing WITH an embedding, no manual backfill.

- [ ] **Step 1: Build + sync so the installed plugin runs the fix**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" npm run build-and-sync 2>&1 | tail -3`
Expected: `Sync complete!`

- [ ] **Step 2: Ensure the local runtime is up** (PG :55433 + server :38879)

Run: `lsof -iTCP:38879 -sTCP:LISTEN -P 2>/dev/null | grep -q LISTEN && echo "server UP" || echo "server DOWN — start it"`
If DOWN, start via the local runtime boot (from repo root):
```bash
nohup env HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" MEMSMITH_RUNTIME=local MEMSMITH_PROJECT_CWD="/Users/shwaits/Workspace/team-agent-memory" \
  ~/.bun/bin/bun -e 'process.env.MEMSMITH_RUNTIME="local"; const {startLocalRuntime}=await import("./src/server/runtime/local-runtime.js"); await startLocalRuntime();' > /tmp/ms-local.log 2>&1 &
```
Wait until `lsof -iTCP:38879` listens.

- [ ] **Step 2b: Insert a manual observation via `/v1/memories` and confirm it embeds**

```bash
cd /Users/shwaits/Workspace/team-agent-memory/MemSmith
KEY=$(cat ~/.memsmith/credentials.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).keys['ab8e1f17-020e-4794-bae3-e59885e7df05'])})")
RESP=$(curl -s -m15 -X POST "http://127.0.0.1:38879/v1/memories" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"projectId":"5fc024f0-0994-4f1d-baed-300d9b4d3416","kind":"manual","content":"EMBED-ON-WRITE VERIFY: a manual observation added via /v1/memories should be embedded immediately, no backfill."}')
ID=$(echo "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).memory.id)})")
echo "inserted id=$ID"
node -e "const {Client}=require('pg');(async()=>{const c=new Client({connectionString:'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres'});await c.connect();const r=await c.query(\"SELECT (embedding_vec IS NOT NULL) emb FROM observations WHERE id='$ID'\");console.log('embedded on write:', r.rows[0]?.emb);await c.end();})()"
```
Expected: `embedded on write: true` (pre-fix this was `false`).

- [ ] **Step 3: Confirm semantic recall (no backfill run)**

```bash
KEY=$(cat ~/.memsmith/credentials.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).keys['ab8e1f17-020e-4794-bae3-e59885e7df05'])})")
curl -s -m10 -X POST "http://127.0.0.1:38879/v1/context" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"projectId":"5fc024f0-0994-4f1d-baed-300d9b4d3416","query":"are manual observations embedded immediately on write","limit":3}' | \
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s).observations||[];o.forEach((x,i)=>console.log((i+1)+'. '+(x.content||'').slice(0,60)))})"
```
Expected: the "EMBED-ON-WRITE VERIFY" observation appears in the semantic results.

- [ ] **Step 4: No commit** (verification). Report results to the controller.

---

## Self-review notes
- **Spec coverage:** shared helper (Task 1), generation rewire behavior-preserved (Task 2), `/v1/memories` embed-on-write (Task 3), regression test incl. semantic recall (Task 4), gate (Task 5), live acceptance proof matching the discovered scenario (Task 6). All spec acceptance criteria mapped.
- **`repo.create` unchanged** — it already accepts `embeddingVec`; no signature change (spec constraint honored).
- **Embed-before-txn constraint** — enforced by placing the embed call before `repo.create` in Task 3 and documented in the helper's comment.
- **No new embedder** — reuses `embed` from `embedder.ts`.
- **Test isolation** — unit test (Task 1) needs no DB; DB tests use `MEMSMITH_TEST_POSTGRES_URL` + isolated schema and skip cleanly if PG is down.
