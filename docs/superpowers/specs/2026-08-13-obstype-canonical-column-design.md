# `obsType` — one canonical home — Design

**Goal:** Locally generated observations must populate the `obs_type` column, not only
`metadata.obsType`, so type filtering and the dashboard see them.

**Status:** Written 2026-08-13. Every claim below was verified against current code before
writing; evidence is cited inline as `file:line`.

---

## 1. The symptom

Local generation (shipped 2026-08-12, tasks 1-7) writes observations to AWS successfully, but
every row has `obsType: null` while `metadata.obsType` is correct:

```
row 25620e13…  obsType: None   metadata: {"obsType": "refactor", "title": …, "facts": […]}
```

Verified live against the deployed server after two separate image rebuilds, so it is not a
stale-deployment artifact.

## 2. Root cause — a deliberate fold, not a bug

`ServerClient.buildAddObservationPayload` (`src/services/hooks/server-client.ts`) folds the
caller's `obsType` **into metadata** and sends no top-level field:

```ts
const metadata = input.obsType !== undefined
  ? { obsType: input.obsType, ...(input.metadata ?? {}) }
  : input.metadata;
return { projectId, kind, content, ...(metadata !== undefined ? { metadata } : {}), … };
```

Its comment states the reason plainly: *"obsType rides into metadata (what
ingest-quality.ts's scoreSubmittedObservation reads)"*. That was correct for Task 3's quality
gate, which scores `metadata.facts/narrative/concepts/title/obsType`.

The consequence is that the route's `obsType: body.obsType ?? null`
(`ServerV1PostgresRoutes.ts:1010`) **always** resolves to `null`, because `body.obsType` is
never sent.

**Both halves are individually right.** The server accepts and persists a top-level `obsType`
(schema at `:973`, persisted at `:1010`; the repository has accepted `obsType`/`quality` since
`src/storage/postgres/observations.ts:165-168`). The client sends the field the scorer needs.
Nobody sends the field the column needs.

## 3. Why it matters (verified, not assumed)

A null `obs_type` is not cosmetic:

- **`/v1/search` filters on it** — `ServerV1PostgresRoutes.ts:1172`:
  `if (obsType) results = results.filter(o => o.obsType === obsType)`. Every locally generated
  observation is invisible to a type-filtered search.
- **The dashboard reads it** — `src/ui/viewer/utils/{serverAdapter,serverData,dashboardShape}.ts`.
- **Server-side generation populates it** — `processGeneratedResponse.ts:155` passes
  `obsType: k.original.type ?? null`. So local and server generation currently produce rows
  with *different shapes* for the same logical observation, which is the deeper problem: two
  producers, one table, divergent records.

## 4. Decision — send both; the column is canonical

**The column is the canonical home. `metadata.obsType` is retained as scoring input.**

The client sends `obsType` **top-level AND inside metadata**:

- **Top-level** → the route writes the `obs_type` column, matching what server-side generation
  already produces. Filtering and the dashboard work.
- **In metadata** → `scoreSubmittedObservation` keeps reading exactly what it reads today, so
  Task 3's quality gate is untouched.

### Alternatives considered and rejected

| Option | Why not |
|---|---|
| **Make the route read `metadata.obsType`** into the column | Silently promotes arbitrary client metadata into a first-class column. A client could set any `obs_type` by writing metadata, and the route's explicit `obsType` parameter would become decorative. |
| **Change the scorer to read top-level `obsType`** | Narrower fix, but it splits the scorer's inputs across two locations (`obsType` top-level, `facts`/`narrative` in metadata) for no gain. The scorer's single-bag input is a feature. |
| **Drop `metadata.obsType`, send only top-level** | Measurable scoring regression: `scoreObservation` awards **exactly 10 points** for a present `obsType` (measured — the same observation scores **85 with** it and **75 without**). Dropping it would silently move every observation 10 points closer to the floor of 20, and a thin one could cross it and start getting 422'd. The kind of change that ships unnoticed. |
| **Leave it — the data is in metadata** | Rejected: type filtering and the dashboard are real consumers, and local vs server generation would keep producing divergent rows. |

Duplication is deliberate and cheap: one short string, in one place in the payload builder,
with the two consumers reading the representation each already expects.

### Blast radius — one edit, four callers, three unaffected

`addObservation` has four call sites, and all of them funnel through
`buildAddObservationPayload`, so the fix is a single edit:

| Call site | Passes `obsType`? | Effect of this change |
|---|---|---|
| `services/generation/start-generation-loop.ts:157` | **yes** | the one that gains a populated column |
| `cli/handlers/prompt-injection.ts:17` | yes | also gains a populated column — correct, same reasoning |
| `servers/mcp-server.ts:166,182` | no | none: the field stays absent, so no top-level key is emitted |
| `note_add` via `user-note-write.ts` | no (`grep -c obsType` → 0) | none — and its floor exemption (`kind: 'user_note'` + `metadata.userDirected`) is untouched |

The builder already guards on `input.obsType !== undefined`, so callers that omit it emit no
new key and their payloads are byte-identical. This matters: `note_add` is a shipped
user-facing feature and must not change shape.

## 5. `quality` — a separate, smaller gap

`quality` is computed server-side at ingest (Task 3) and persisted via the repository, but
**`/v1/search` does not return it**, so a client cannot confirm it was stored. Verified: the
search response keys are `content, createdAtEpoch, id, kind, lifecycleState, metadata,
obsType, projectId, serverSessionId, teamId, updatedAtEpoch` — no `quality`.

That is an observability gap, not a correctness one: a submission below the floor is rejected
with `422`, so a `201` proves the score met the bar. **Out of scope here** — exposing it means
deciding whether `quality` belongs in the public search contract, which is its own question.

## 6. Testing

- **Unit** — `buildAddObservationPayload` emits BOTH a top-level `obsType` and
  `metadata.obsType` when the caller supplies one; emits neither when it does not; an explicit
  `metadata.obsType` still wins over the convenience field (existing behavior, must not
  regress).
- **Unit** — `scoreSubmittedObservation` scores identically before and after, proving the
  quality gate is untouched.
- **Mutation** — remove the top-level field and confirm a test fails. Four fixtures in this
  project's history could not distinguish pass from fail; assume nothing is covered until a
  mutation proves it.
- **Live** — generate one observation from a laptop in team mode and confirm the AWS row has a
  non-null `obsType` matching `metadata.obsType`, then confirm a type-filtered `/v1/search`
  returns it.

## 7. Out of scope

- Exposing `quality` in the search response (§5).
- Backfilling `obs_type` on the rows already written with null. There are four, all in the
  scratch test project — not worth a migration.
- The `stalled` health indicator on a team server whose generation is correctly delegated to
  clients (tracked separately).
