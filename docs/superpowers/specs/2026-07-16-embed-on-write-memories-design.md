# Embed-on-Write for `/v1/memories` — Design

**Goal:** Make the direct-insert observation path (`POST /v1/memories`, used by the `observation_add` MCP tool and manual/compat inserts) embed on write — so manually-added observations are immediately semantically searchable, exactly like generated ones. Close the "manual observations are semantically dark" gap.

**Status:** Design (2026-07-16). One of the Tier-1 retrieval-first gaps. Next: implementation plan.

---

## Motivation & the gap this closes

MemSmith's retrieval-first behavior depends on **semantic** recall (hybrid FTS + vector RRF via `/v1/context` and `/v1/search`). Semantic recall only works for observations that have an `embedding_vec`.

There are **two write paths** into `observations`:

1. **Generation pipeline** (`src/server/generation/processGeneratedResponse.ts`) — embeds on write. It defines a private `embedForPersist(content)` helper (never-throws, blank→null, best-effort), pre-computes embeddings *before* the DB transaction, and passes `embeddingVec` into `repo.create`. **This path is correct.**
2. **Direct insert** (`POST /v1/memories`, `ServerV1PostgresRoutes.ts:899-930`) — used by the `observation_add` MCP tool, manual inserts, and compat aliases. It calls `repo.create(createInput)` with **no `embeddingVec`** (verified at line 921). Rows land content-only → `embedding_vec = NULL` → **semantically dark** until a manual `scripts/backfill-embeddings.ts` run.

This was discovered live this session: an `observation_add`-created `open_item` came back `embedding_vec = NULL`, and a semantic query near-verbatim to its content failed to rank it (FTS could still find it, but semantic — the primary retrieval-first path — could not). It is the same root as the historical 78%-embedded gap: **only generation embeds on write; the direct-insert path never got the same treatment.** The `713c8330` "embed-on-write closed" work fixed the *generation* path only.

Why it matters especially now: the next Tier-1 gap is making "record/remember X" a deterministic MemSmith behavior. That feature will write via this exact direct-insert path — so if manual inserts don't embed, deliberate "remember this" notes would be semantically dark. **This fix unblocks that one.**

## Scope

**In:**
- Extract the never-throws embed-on-write helper into a shared, importable module.
- Wire it into the `POST /v1/memories` handler: embed the content, pass `embeddingVec` into `repo.create`.
- Point the generation pipeline at the same shared helper (remove its private copy) so there is ONE embed-on-write behavior.
- Regression test: a `/v1/memories` insert with non-blank content produces a non-null `embedding_vec` and is semantically recallable; blank content skips embedding; an embedder failure still persists the row (never throws).

**Out (explicitly):**
- Changing the generation pipeline's *behavior* (it already embeds correctly; it only changes WHERE the helper is imported from — behavior byte-identical).
- Pushing embedding into `repo.create` / the storage layer (rejected: layering concern — storage shouldn't depend on the ML embedder; and generation deliberately pre-computes before the txn to keep transactions short).
- Backfilling existing null rows (that's `scripts/backfill-embeddings.ts`, already exists and was run this session → corpus currently 100% embedded).
- The other Tier-1 gaps (hard-mode scoping, deterministic record-intent, sub-agent coverage, behavioral validation) — each is its own spec.

## Global Constraints

- **Never throw into the write path.** Embedding is best-effort: blank/whitespace content → `null` (skip); any embedder error → log a SYSTEM warning and return `null`, persist the observation *without* an embedding. An embedding failure MUST NOT roll back or block the insert. (Mirrors the existing generation-path stance: write correctness is paramount.)
- **One embed-on-write behavior.** After this change there is a single shared helper; the generation path and the `/v1/memories` path share identical semantics. No duplicated copy.
- **Behavior-preserving for generation.** Generation's observable behavior is unchanged — same embeddings, same pre-txn timing, same graceful degradation. Only the helper's location + import site change.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Never commit to main:** work on a dedicated branch.
- **Reuse the proven embedder:** `embed` from `src/server/generation/embedder.ts` (local Xenova/all-MiniLM-L6-v2, 384-dim, no API key). Do not introduce a new embedder.
- **Embed OUTSIDE any DB transaction / before acquiring the write.** History (the original generation embed-on-write, review concern on commit `713c8330`): awaiting `embed()` *inside* the Postgres transaction held a pooled connection during ONNX inference — fine warm (~90ms) but a multi-second cold-start model load could trip `idle_in_transaction`/statement timeouts. The fix was to pre-compute embeddings before entering the transaction. For `/v1/memories`: compute `embedForPersist(content)` BEFORE the `repo.create` call (the handler has no explicit multi-statement transaction, so this is naturally satisfied — but the implementer MUST NOT move the embed call into any future transaction wrapper around the insert).

---

## Architecture & Components

One new (extracted) module; two call sites converge on it.

```
                         ┌─────────────────────────────┐
  generation path ──────▶│  embedForPersist(content)   │
  (processGeneratedResponse)   (shared, never-throws)  │
                         │   • trim; blank → null      │
  /v1/memories handler ─▶│   • embed() best-effort     │──▶ number[] | null
  (ServerV1PostgresRoutes)   • error → warn + null     │
                         └─────────────────────────────┘
                                      │
                                      ▼
                         repo.create({ ..., embeddingVec })
```

### Components

1. **`embedForPersist` — shared helper** (`src/server/generation/embed-for-persist.ts`, new file).
   - Signature: `export async function embedForPersist(content: string): Promise<number[] | null>`
   - Behavior (moved verbatim from `processGeneratedResponse.ts:31-45`): `const text = content.trim(); if (!text) return null; try { return await embed(text); } catch (error) { logger.warn('SYSTEM', 'embedding failed; persisting observation without embedding_vec', {}, error…); return null; }`
   - Imports `embed` from `./embedder.js`, `logger` from the shared logger.
   - Rationale for a new file rather than putting it in `embedder.ts`: `embedder.ts` is the raw model wrapper (pure `embed`/`embedBatch`); `embedForPersist` is the *persistence-policy* wrapper (trim, best-effort, log). Keeping them separate preserves the single-responsibility split. (If the reviewer prefers colocating in `embedder.ts`, that is an acceptable variation — the requirement is one shared, exported helper.)

2. **`processGeneratedResponse.ts`** (modify) — delete the private `embedForPersist`; import it from the shared module. Everything else (the `embeddingByIndex` pre-compute loop, `repo.create` call) unchanged.

3. **`POST /v1/memories` handler** (`ServerV1PostgresRoutes.ts:907-929`, modify) — before `repo.create`, compute `const embeddingVec = await embedForPersist(body.content);` and add `embeddingVec` to `createInput`. The handler is already `async`. Keep the existing try/catch and response shape.

### Placement decision
The shared helper lives under `src/server/generation/` (alongside `embedder.ts`) because that is where the embedder and the existing helper already live. Both consumers (`generation/` and `routes/v1/`) import it from there. No new top-level module or layer.

---

## Data Flow

**`/v1/memories` (the fixed path):**
```
POST /v1/memories { projectId, content, kind?, metadata?, serverSessionId? }
  → writeAuth + ensureProjectAllowed
  → embeddingVec = await embedForPersist(content)   // best-effort; null on blank/error
  → repo.create({ projectId, teamId, serverSessionId, kind, content, metadata, embeddingVec })
  → 201 { memory: serializeObservation(observation) }
```
`repo.create` already accepts `embeddingVec?: number[] | null` (`observations.ts:103`) and writes it to the `embedding_vec` column (`:142`), so the storage layer needs no change.

**Generation path (unchanged behavior):** still pre-computes embeddings into `embeddingByIndex` before the transaction and passes them to `repo.create` — only the *import source* of `embedForPersist` changes.

---

## Error Handling & Failure Modes

| Failure | Behavior |
|---|---|
| Blank/whitespace content | `embedForPersist` returns `null` → row persists with `embedding_vec = NULL` (nothing meaningful to embed). |
| Embedder throws (model load fail, OOM, transient) | Caught inside `embedForPersist` → SYSTEM warn logged → returns `null` → **row still persists** (FTS-searchable, semantically dark until a later backfill). Never rolls back the insert. |
| Embedder slow | No added timeout in this spec (the direct-insert path is not the per-keystroke hot path; generation has no timeout here either). If latency becomes a concern it is a separate follow-up. |
| DB insert fails | Unchanged — existing handler try/catch returns the existing `handleDbError` response. |

**Invariant:** a `/v1/memories` insert never fails *because of* embedding. Embedding is additive; its absence degrades recall quality, never write success.

---

## Testing

**Unit / integration (live embedded PG, the project's existing pattern):**
1. **Embed-on-write (the fix):** POST `/v1/memories` (or call the handler / `repo.create` via the same path) with non-blank content → assert the persisted row has a non-null `embedding_vec`, AND a semantic `/v1/context` query close to the content ranks it. (This is the regression that would have caught the bug — the current code fails it.)
2. **Blank content skips:** content that trims to empty → row persists with `embedding_vec = NULL`, no throw.
3. **Embedder failure is graceful:** stub `embed` to throw → the insert still succeeds (201 / row present) with `embedding_vec = NULL`; a SYSTEM warning is logged. Never throws.
4. **Shared-helper parity:** the generation path still writes a non-null `embedding_vec` (guard against the extraction regressing generation) — reuse/adapt the existing generation embedding test if present; if none exists, add one (memory notes there is currently no test asserting generation writes a non-null embedding — close that too).

**Verification (live, like prior sessions):**
- Build + sync, restart the local runtime, then `observation_add` a test note via the MCP path and confirm `embedding_vec IS NOT NULL` for that row WITHOUT a manual backfill — the exact scenario that failed this session.

## Acceptance Criteria

1. A `/v1/memories` insert (incl. via `observation_add`) with non-blank content produces a non-null `embedding_vec` and is semantically recallable — no manual backfill needed.
2. Blank content persists with `NULL` embedding; an embedder failure persists the row without embedding and never throws.
3. Exactly one shared `embedForPersist` helper exists; both the generation path and `/v1/memories` import it; no duplicated copy.
4. Generation behavior is unchanged (still embeds on write, pre-txn) — verified by test.
5. `src` typecheck clean; the isolated per-file test gate green for the touched/added test files.
6. Nothing pushed; work on a branch; no change to `repo.create`'s signature (it already supports `embeddingVec`).

## Deferred (not this spec)
- Backfill of any pre-existing null rows (existing script; corpus already 100% embedded).
- A latency timeout on the embed call (add only if it proves necessary).
- The other Tier-1 retrieval-first gaps (each its own spec).
