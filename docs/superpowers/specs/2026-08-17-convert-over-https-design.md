# Convert Over HTTPS — Design

**Date:** 2026-08-17
**Status:** Proposed
**Replaces:** `2026-08-14-owner-join-over-https-design.md` (withdrawn — its central premise was wrong; see §9)
**Completes:** `2026-08-04-join-over-https-design.md`, which did this for the *joiner* only

## 1. The model this serves

Every local project has its own database, fully isolated. GO TEAM **publishes that
project** so it is reachable from other machines. The team database then holds many
projects side by side, and **access is granted per project**:

```
AWS DB ─┬─ Project A   ← users A, B
        ├─ Project B   ← users C, D
        └─ Project C   ← user E (owner), plus whoever E grants access
```

Users A and B reach project A and **not** project B. This is enforced by **two distinct
mechanisms**, and the difference matters for §10.5:

- `resolveRequestedProject` (`resolve-requested-project.ts:84-88`) returns
  `source: 'denied'` and **falls back to the key's own project**. No HTTP status, no
  error message — a denial degrades scope rather than failing the request.
- `ensureProjectAllowed` (`ServerV1PostgresRoutes.ts:2333-2339`) is what returns
  `403 API key is scoped to a different project` — but **only when the key already has a
  project scope**. A team-scoped key (`project_id IS NULL`) passes it for any project in
  its team.

Verified live: a key scoped to project A got that 403 writing to project B
(reproduce: `POST {endpoint}/v1/memories` with `projectId` = B using an A-scoped key).

**Consequence for this design:** GO TEAM has exactly one meaning — publish this project.
There is no "create a team vs join a team" choice, and a per-project team id is the
access boundary working correctly, not a defect.

## 2. The blocker, validated by execution

Convert is the **only** MemSmith operation that requires a raw Postgres socket to the
destination. Everything else — every observation write, every search, the whole join
flow — goes over HTTPS. That is why a user can record observations against AWS all day
and still have GO TEAM fail.

Measured on 2026-08-17, same local server, same code path, same request shape, with
**only the destination changed**:

| Destination | `POST /v1/convert/test-connection` |
|---|---|
| `postgres://…@127.0.0.1:55441` | `{"reachable":true,"authenticates":true}` |
| `postgres://…@memsmith-dev.c32kaqseed4v.us-west-2.rds.amazonaws.com:5432` | `{"reachable":false,"error":"Connection terminated due to connection timeout"}` |

`POST /v1/convert/migrate` against the same RDS host returns the identical timeout, so
**the conversion itself cannot execute** — this is not merely a UI gate refusing to
unlock.

**It is not a VPN problem.** At the moment of that failure the machine was *on* VPN:
`npm.autodesk.com:443` (Autodesk-only) was reachable while `registry.npmjs.org:443`
(public) timed out — the exact inverse of the off-VPN state earlier the same day. The
RDS still timed out. `PubliclyAccessible: false`, and the hostname resolves to
`10.134.166.42` (RFC1918). No machine outside the VPC reaches it, on VPN or off.

**The same host is reachable from inside the VPC.** An ECS Fargate task with
`assignPublicIp=DISABLED` ran `api-key create --team … --role viewer` and succeeded,
returning a real key — it connected, authenticated, and wrote both `api_keys` and
`team_members` rows.

Measured simultaneously from one machine:

```
GET  /v1/info                     → 200
POST /v1/memories                 → 201     (team key write works)
TCP  memsmith-dev…:5432           → timeout
```

**Where the connection is made.** The browser never touches Postgres: `wizardData.ts:27`
posts `{databaseUrl}` to a *relative* path. The **local server** opens the connection —
the probe at `ServerV1PostgresRoutes.ts:1821` (`probeConnection`) and the copy pool at
`:2126` (`createPostgresPool(remoteConfig)`). The blocker is the local server's reach, not
the browser's.

## 3. The server-URL problem is ALREADY FIXED — do not re-fix it

An earlier draft of this spec listed the stamped server URL as a second blocker. **That
was wrong, and the error is worth recording because of how it happened.**

`resolveConvertServerUrl` (`resolve-convert-server-url.ts`) exists and **is wired into
the live convert path** (`ServerV1PostgresRoutes.ts:1904-1912`), with precedence:

1. the project marker's `serverUrl` — per-project, written by an actual previous
   convert/join, so it reflects observed reality
2. `MEMSMITH_SERVER_URL` — machine-wide operator configuration, **discarded when it is
   loopback and the database is remote**, because `SettingsDefaultsManager` gives that
   setting a `http://127.0.0.1:<uid-port>` default and reading it unconditionally would
   silently point every remote convert at the operator's own laptop
3. `deriveServerUrl(databaseUrl)` — the unchanged fallback

`deriveServerUrl` still returns `https://${host}` for a remote host
(`convert-context.ts:31`), but at `:1913` it is called **only to log when the resolved URL
differs from the derived one**. It is no longer the value that gets stamped.

It is also **already tested**: `tests/server/convert/derive-server-url-production.test.ts`
pins branch 3 against a realistic RDS hostname, and
`tests/server/convert/resolve-convert-server-url.test.ts` covers the precedence chain
including loopback rejection — 20 tests, all passing.

**How the error happened.** The withdrawn text was near-verbatim from
`resolve-convert-server-url.ts`'s own header comment — which is written in the **past
tense, describing the bug it fixed**. Reading it as a present-tense finding is the same
mistake this project has made before: *code shows what exists, not what superseded what.*
A comment explaining why something was built reads exactly like a description of a live
defect.

**Consequence for this design:** the HTTPS path needs an explicit server URL because the
laptop cannot reach the database (§2), **not** because the derived URL is wrong. One
blocker, not two.

## 4. Design: convert speaks HTTPS, like everything else

The wizard's destination step asks for the **server URL and the team key** — not a
database URL:

| Field | Example | Why |
|---|---|---|
| Server URL | `https://…execute-api…/prod` | The reachable, public front door. Stated, never derived. |
| Team key | `cmem_…` | Authorization; `teamId` is derived from it server-side |

This resolves both blockers by construction: no Postgres socket is opened from the
laptop, and the API endpoint is supplied rather than inferred from a database hostname.

`test-connection` becomes an **HTTPS probe** — `GET {serverUrl}/v1/info` plus an
authenticated `GET {serverUrl}/v1/identity` — reporting reachability and whether the key
authenticates. The pgvector/schema checks it performs today are properties of a database
the owner no longer touches; the team server already guarantees them for itself
(`/v1/info` reports `postgres.initialized` and `schemaVersion`), so the probe reads them
from that response instead of connecting.

**The direct-Postgres path is retained**, unchanged, for a self-hosted database the owner
can actually reach. It is selected by supplying a `postgres://` URL. A `postgres://`
value is never silently accepted on the HTTPS path — it is rejected with a message
naming the expected shape, because a silent fallback would reintroduce the timeout this
design exists to remove.

## 5. Moving the data

Convert today copies seven tables (`copy-engine.ts:17-25`) over the direct pool:
`projects`, `server_sessions`, `agent_events`, `observation_generation_jobs`,
`observations`, `observation_sources`, `observation_generation_job_events`. Over HTTPS,
the existing routes cannot carry that faithfully. Three gaps, each measured:

**Gap 1 — timestamps are destroyed.** `POST /v1/memories` has no `createdAt` field, and
`ObservationsRepository.create` omits `created_at` from its INSERT column list, so the
column always takes `DEFAULT now()` (`schema.ts:211`). Verified live: an observation
posted with `createdAt: 2020-01-15` was stored as `2026-08-14`. Promoting a mature
project through this route would collapse its whole history to one day — and would break
the recency merge `readTeamWide` relies on when ranking across a team's projects.

**There are TWO insert sites, not one**, and both need the change: `observations.ts:208`
(the `idempotency_key` conflict branch) and `observations.ts:234` (the `generation_key`
branch). They exist separately because Postgres permits only one `ON CONFLICT` per
INSERT. Changing only the first would preserve timestamps for some writes and silently
not others — the kind of half-fix that looks verified because the test happened to
exercise the patched branch.

**Gap 2 — idempotency does not cover existing rows.** Migration 5 added a partial unique
index on `(team_id, project_id, idempotency_key) WHERE idempotency_key IS NOT NULL`, but
only **367 of 10,762** observations in a real long-lived project carry that key (3.4%).
The other 96.6% bypass the constraint entirely, so a copy that fails midway and is
retried duplicates everything already sent.

**Gap 3 — one table of seven.** `/v1/memories` carries observations only. `agent_events`
(the raw capture) and `observation_sources` (the provenance links joining an observation
to the events that produced it) would be dropped, leaving copied memory with no
traceable origin.

**Gap 4 — embeddings are silently lost, and no count check can detect it.**
`observations.embedding_vec` is a `public.vector(384)` column with an HNSW index
(`schema.ts:99,102-103`). Today's copy preserves it verbatim: `buildConvertCopyDeps` does
`SELECT *` and raw-INSERTs every non-generated column, so the vector crosses as-is. Over
HTTPS it must be JSON-serialised and re-cast (`$16::public.vector`,
`observations.ts:196`), which makes carrying `embeddingVec` a **second** repository
change — an earlier draft claimed `createdAt` was "the only repository change", which was
wrong.

The alternative — regenerating embeddings on import — is worse: `embedForPersist`
**degrades to NULL when the embedder is unavailable**, so a migration run while the
embedder is down produces a team project whose semantic search returns nothing. And
because `verifyCopy` compares only row counts, **that loss passes verification silently**.
Import therefore carries the vector; it never regenerates.

**Gap 5 — `created_at` is not the only defaulted timestamp.** `updated_at` also defaults
to `now()` (`schema.ts:386`), and six of the seven tables have defaulted timestamp
columns — not just `observations`. `agent_events` additionally has `occurred_at`, which is
a *distinct* column from `created_at` (when the event happened vs when the row was
written) and must be preserved separately.

### 5.1 A migration transport, not fresh ingest

Copy therefore gets its own authenticated route rather than reusing the ingest path:

```
POST {serverUrl}/v1/convert/import
  { table, rows: [...], batchToken }
```

Distinct from ingest in exactly the ways migration requires:

- **Preserves `created_at`/`occurred_at`** as supplied. Rows are being *relocated*, not
  created; the original timestamps are the data. This needs `ObservationsRepository` to
  accept an optional `createdAt` — the only repository change in this design.
- **Bypasses the ingest quality floor.** These rows already passed it locally when they
  were generated. Re-judging historical data at migration time would reject rows the
  product itself produced. (Note the floor is *not* the problem earlier believed: on a
  current project the only rows lacking `facts`/`narrative` are user notes — measured
  125 of 1,203 over seven days, and **all 125** are `kind='user_note'` with
  `userDirected: true`, which `isExemptUserNote` already exempts. Migration must not
  depend on that exemption holding for generated rows, so it bypasses the floor
  explicitly.)
- **Carries all seven tables**, in the FK order `copy-engine.ts` already establishes, so
  provenance survives.
- **Idempotent per batch, not per row.** The client sends a `batchToken` derived from
  `(projectId, table, offset)`; the server records applied tokens and returns
  `already_applied` for a repeat. This works regardless of whether individual rows carry
  an `idempotency_key`, which Gap 2 shows most do not.
- **Reuses `restampTeamId` and `buildScopedReadQuery`** unchanged on the read side.
  Their project scoping is already proven: seeded with project A (3 rows) and project B
  (2 rows) in one database, a scoped read for A returned exactly A's rows and none of
  B's.

### 5.2 What a `CopyDeps` swap does NOT cover

An earlier draft claimed "`runCopy`/`verifyCopy` keep their logic; only `CopyDeps`
changes." **That is false**, and the gaps are where the real implementation risk lives.

**Verification cannot be a simple count call.** `buildScopedCountQuery`
(`convert-scope.ts:39-57`) emits *different SQL for local vs remote*, and the remote
variant needs `team_id`. But `observation_sources` has **no `project_id` and no `team_id`
column at all** — its remote count is a correlated subquery through the parent table
(`convert-scope.ts:29-31`). A generic "scoped count endpoint" cannot express that from the
caller's side. The server must therefore own verification: import exposes
`GET /v1/convert/verify?projectId=` that runs the *existing* remote count queries
server-side and returns per-table counts, because only the server can join through the
parent tables.

**`verifyCopy` only detects under-copy.** It flags `remote < local` (`copy-engine.ts:66`).
With per-batch idempotency and no cross-batch transaction, a partially-applied retry can
leave `remote > local` and **pass verification while being wrong**. Verification must
compare for equality, not sufficiency.

**Batching is byte-bounded, not row-bounded.** `COPY_BATCH_SIZE` is **200**
(`copy-engine.ts:27`), and the server's JSON body limit is **5 MB**
(`services/server/middleware.ts:9`). An observations row carries `content`, a `metadata`
JSONB blob, and a 384-float vector (several KB as JSON), so 200 rows can exceed the limit
and return `413` — a failure mode the row count alone never predicts. Import batches to a
**byte budget** with a row cap as a secondary bound, and `413` is handled by halving the
batch and retrying.

**FK order within a table matters, not just across tables.** `runCopy` iterates
`COPY_TABLES` in FK order, but `observations` has a **self-referential FK**
(`supersedes → observations(id)`, `schema.ts:471-472`), so a superseding row can land in
batch N while its target sits in batch N+1 *of the same table*. `observation_sources` FKs
to both `observations` and `agent_events` (`schema.ts:392-394`). Import therefore defers
`supersedes` — inserting rows with it NULL, then applying the links in a final pass once
all rows exist. Nothing in today's code does this, because a single-connection copy never
had to.

**Generated columns must be stripped server-side.** `discoverGeneratedColumns`
(`generated-columns.ts:25-42`) queries `information_schema` on the **destination**
connection, deliberately — so a future migration adding a generated column cannot
silently reintroduce the insert crash. An HTTPS client has no such connection.
`observations.content_search` is `GENERATED ALWAYS` (`schema.ts:380`) and comes back from
`SELECT *`. Stripping therefore moves to the receiving end, where the destination schema
is knowable; the client must not hardcode a column list, as that is exactly the silent-
crash class the existing code was written to prevent.

**Import bypasses more than the quality floor.** Today's copy also bypasses
`assertProjectOwnership`, `assertSessionOwnership`, `assertJobOwnership`
(`observations.ts:171-177`), attribution stamping, and embed-on-write. Each must be
classified as *safety* (keep) or *ingest policy* (bypass). The ownership asserts are
safety and stay: they are what stops a row naming a project or session the caller does not
own. Attribution and embed-on-write are ingest policy and are bypassed, because the rows
already carry their own attribution and vector.

**Applied-token storage needs a table.** Per-batch idempotency requires the server to
remember which tokens it has applied. No such table exists; the design adds one
(`convert_import_batches`: `project_id`, `table_name`, `batch_token`, `applied_at`, with a
unique constraint on the first three). An earlier draft named the mechanism without
defining where it lives.

Only after all of the above does the `CopyDeps` shape change: `upsertRows` POSTs a
byte-bounded batch, and the count check calls the server-side verify endpoint. The
`runCopy` control flow survives; its *assumptions about being one connection* do not.

## 6. The sync banner

The user promotes their existing observations **inside the wizard**, before convert
reports done — not from a dashboard banner afterwards. The wizard shows the count and a
Promote action, so there is no window in which the project is half-migrated and the user
has navigated away.

One-click promotes everything unsynced; per-observation selection is out of scope.
**Local rows are never deleted** — a successful batch marks them, so a failed or partial
promote cannot lose data and the project still reads locally.

Marking requires one migration — **two edits in one place, not a new file.** The
`src/storage/postgres/migrations/` directory holds only `002`–`005` and each file declares
itself "source-of-truth SQL; **not loaded by code**"; the DDL that actually executes is
embedded in `schema.ts` (migration 6 exists only there, `schema.ts:157-173`, with no
`.sql` counterpart). So:

```sql
ALTER TABLE observations ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;
```

goes into the embedded migration list in `schema.ts` as entry **7**, **and**
`SERVER_POSTGRES_SCHEMA_VERSION` (`schema.ts:6`, currently 6) is bumped to 7 in the same
change — without the bump the migration never runs.

`promoted_at IS NULL` means unsynced and drives the count. The column is **local
bookkeeping only** — a row in the team database is by definition already there, so it is
never read remotely.

## 7. Error handling

| Condition | Result |
|---|---|
| Server URL unreachable | `cannot reach that server at <url>` — never echoes the request, which contains the key |
| `postgres://` given as server URL | Rejected, naming the expected shape. No silent fallback. |
| Key invalid / revoked / expired / teamless | The specific reason, not a flat 401 (existing `/v1/join/register` behaviour, verified live: a bogus key returns `422 that key is not valid for this workspace`) |
| Import batch fails midway | Retry is safe: applied `batchToken`s return `already_applied`. Local rows retained; only confirmed batches set `promoted_at`. |
| Count verification mismatch | `verify_failed`, and **the marker is not flipped** — the existing rule that a copy which cannot be verified leaves the project local |

## 8. Testing

**Already covered — do not rewrite.** `deriveServerUrl` branch 3 and the
`resolveConvertServerUrl` precedence chain are pinned by
`tests/server/convert/derive-server-url-production.test.ts` and
`tests/server/convert/resolve-convert-server-url.test.ts` (20 tests, passing). An earlier
draft listed this as new work; it is not.

**Unit**
- `createdAt` round-trip through `ObservationsRepository`, on **both** insert branches
  (`observations.ts:208` idempotency-key branch and `:234` generation-key branch — they
  are separate because Postgres allows one `ON CONFLICT` per INSERT). A row inserted with
  an explicit past timestamp reads back with that timestamp, not `now()`. Patching only
  one branch is the specific half-fix this test exists to catch, so it must assert both.
- `embedding_vec` round-trip: a vector supplied on insert reads back identical, and is
  **not** regenerated.
- `updated_at` and `agent_events.occurred_at` preserved as supplied.
- Batch idempotency: replaying a `batchToken` inserts nothing and reports
  `already_applied`.
- Byte-budget batching: a batch that would exceed 5 MB is split, not sent and 413'd.
- `supersedes` deferral: importing a superseding row before its target succeeds, and the
  link is present after the final pass.

**Integration (isolated rig — never the dogfood project)**
- Two projects in one rig database; import project A and assert none of project B's rows
  reach the destination.
- Import with the destination unreachable → no `promoted_at` set, count unchanged, marker
  still local.

**Against AWS**
- Convert a scratch project from the rig to the real AWS team over HTTPS, then confirm a
  team-scoped key reads it back and `created_at` matches the source. This is the test
  that has never passed, and the one that proves the design.
- Re-run the same convert to confirm idempotency against a live remote.

**All tests run against the rig (`scripts/rig/`) or a scratch AWS project. Never the
dogfood project** — it is the only real workspace and its data is not to be tampered
with. Verify with the `credentials.json` sha256 + row-count baseline before and after.

## 9. What the withdrawn spec got wrong

`2026-08-14-owner-join-over-https-design.md` is withdrawn. Recording why, so the errors
are not repeated:

1. **It treated a fresh team id as a bug** ("the project lands in an invisible new
   team"). Under the model in §1 that is the access boundary working correctly. The
   create-vs-join wizard fork it proposed solved a non-problem.
2. **It claimed ~39% of observations would fail the quality floor.** That number came
   from measuring the *dogfood* project's entire history — 10,762 rows accumulated by
   older code — instead of a representative project. On current code the figure is 125
   of 1,203, and all 125 are exempt user notes. The floor rejects nothing.
3. **It said the browser cannot reach the RDS.** The browser never connects to Postgres;
   the local server does. The conclusion held, the mechanism did not.
4. **It asserted the RDS was unreachable without testing it**, and separately reported
   convert as "validated" on the strength of a run against a *local* container. That is
   the shortcut this project has been bitten by repeatedly: verifying the plumbing and
   claiming the deployment.

The surviving findings from that review — timestamps, idempotency coverage, and
single-table promote — are all measured, and are §5 of this spec.

## 10. Security invariants preserved

1. On the HTTPS path the database password never reaches the owner's machine — that path
   has no database URL field at all. **This is a per-path guarantee, not a global one:**
   §4 deliberately retains the direct-Postgres path for a reachable self-hosted database,
   and that path still takes `{databaseUrl}` (`ConvertRoutes.ts:34,63`). The invariant is
   "HTTPS convert never handles a password", not "MemSmith never handles one".
2. The team key lives only in `CredentialStore`, keyed by `teamId`, never in
   `.memsmith/project.json` (which is committed to git). Structural: `ProjectMarker` has
   no credential field.
3. `teamId` is always derived from the presented credential, never a request body.
   Verified live: a planted foreign `teamId` in the `/v1/join/register` body was ignored
   and the server returned the key's own team.
4. Key is written **before** the marker, so a project is never in team mode without a
   resolvable credential ("dark capture" prevention).
5. `/v1/convert/import` is **`[...writeAuth, requireRole('owner')]`** — the same gate
   every other convert route uses (`ServerV1PostgresRoutes.ts:1704`), and the project is
   taken from `req.authContext.projectId` **only, never a body field**, exactly as
   `/v1/convert/migrate` does (`ConvertRoutes.ts:80-87`).

   **An earlier draft of this spec specified `requireWriteRole()` instead, which was a
   real security defect.** Three facts combine:
   - `requireWriteRole()` treats `role == null` as member-equivalent
     (`postgres-auth.ts:69`), so a scope-only key with no role passes.
   - `ensureProjectAllowed` only rejects when the key HAS a project scope
     (`ServerV1PostgresRoutes.ts:2334`), so a **team-scoped key** (`project_id IS NULL`)
     passes for *any* `projectId` in its team.
   - The team-wide key minted for this deployment has exactly `project_id: null`.

   So the draft route would have let a roleless, team-scoped key write **raw rows** into
   any project in the team — including `projects` itself, with a re-stamped `team_id`.
   `/v1/memories` tolerates that middleware permissiveness only because it adds a
   row-ownership check on top; a raw-row import route has no equivalent, so it must be
   gated at the route.

   **`ensureProjectAllowed` is therefore NOT sufficient for this route** and must not be
   the only check. Import derives its project from the credential and refuses a
   team-scoped key outright: a caller with no project scope has not identified which
   project it is importing, and guessing is what the whole convert-scope history warns
   against.

## 10a. Implementation order — three plans, not one

An adversarial review found this spec too large for a single plan, and it was right: the
first unit is ready now while the second is where all the residual risk sits. Build in
this order, each with its own plan:

**Unit 1 — repository-layer fidelity.** Optional `createdAt`/`updatedAt` on **both**
`observations` insert branches (`:208`, `:234`), `embeddingVec` passthrough, and the
equivalent for the other five tables (`agent_events.occurred_at` included). No transport
change, no new route, no migration. Independently testable, and needed by every later
unit. **Start here.**

**Unit 2 — the import route.** `POST /v1/convert/import` plus
`GET /v1/convert/verify`: owner-gated authz (§10.5), server-side generated-column
stripping, byte-budgeted batching with 413 handling, `supersedes` deferral, the
`convert_import_batches` token table, and equality-not-sufficiency verification. This is
the bulk of the work and the bulk of the risk.

**Unit 3 — wizard destination + `promoted_at`.** §4 and §6. Depends on unit 2.

## 11. Reproducing every measured number in this spec

§9.2 withdraws a prior spec for a mismeasured denominator, so no number here ships
without the command that produced it. Run these against the rig or a scratch project —
never the dogfood project.

**The A/B connectivity result (§2).** Same server, same route; only the URL changes:

```bash
# reachable
curl -s -X POST -H "Authorization: Bearer $RIG_KEY" -H 'content-type: application/json' \
  -d '{"databaseUrl":"postgres://memsmith:rig-throwaway@127.0.0.1:55441/memsmith"}' \
  http://127.0.0.1:38890/v1/convert/test-connection
# times out
curl -s -X POST -H "Authorization: Bearer $RIG_KEY" -H 'content-type: application/json' \
  -d '{"databaseUrl":"postgres://memsmith:x@memsmith-dev.c32kaqseed4v.us-west-2.rds.amazonaws.com:5432/memsmith"}' \
  http://127.0.0.1:38890/v1/convert/test-connection
```

**That it is not VPN (§2).** On VPN, the Autodesk-only host resolves and the public one
does not; the RDS times out either way:

```bash
python3 -c "import socket
for h in ('npm.autodesk.com','registry.npmjs.org','memsmith-dev.c32kaqseed4v.us-west-2.rds.amazonaws.com'):
    s=socket.socket(); s.settimeout(8)
    try: s.connect((h, 443 if 'npm' in h else 5432)); print(h,'OK')
    except Exception as e: print(h, type(e).__name__)
    finally: s.close()"
```

**RDS is VPC-internal (§2).** `PubliclyAccessible: false`, private address:

```bash
aws rds describe-db-instances --region us-west-2 \
  --query 'DBInstances[*].{public:PubliclyAccessible,host:Endpoint.Address}'
dig +short memsmith-dev.c32kaqseed4v.us-west-2.rds.amazonaws.com   # -> 10.134.166.42
```

**Timestamps are destroyed (§5, Gap 1).** Post a past date and read back what was stored:

```bash
curl -s -X POST -H "Authorization: Bearer $TEAM_KEY" -H 'content-type: application/json' \
  -d '{"projectId":"<scratch>","content":"probe","kind":"user_note",
       "metadata":{"userDirected":true},"createdAt":"2020-01-15T00:00:00Z"}' \
  "$ENDPOINT/v1/memories"
# observed: createdAtEpoch corresponds to the ingest date, not 2020-01-15
```

**Idempotency coverage (§5, Gap 2)** — 367 of 10,762 = 3.4% on a long-lived project:

```sql
SELECT count(*) AS total, count(idempotency_key) AS with_key
FROM observations WHERE project_id = '<project>';
```

**Quality-floor exposure (§5.1)** — on current code, the only rows lacking
facts/narrative are exempt user notes:

```sql
SELECT kind, count(*) FROM observations
WHERE project_id = '<project>' AND created_at > now() - interval '7 days'
  AND (metadata->'facts') IS NULL AND (metadata->'narrative') IS NULL
GROUP BY kind;
-- observed: user_note 125, of 1203 rows in the window; all with userDirected=true
```

Note the denominator: measured over a **7-day window on current code**, not a project's
entire multi-month history. The all-time figure on a long-lived project is 39%, and using
it would misstate what a real convert faces — that is precisely the error §9.2 records.

**In-VPC reachability (§2).** A Fargate task with `assignPublicIp=DISABLED` running
`server api-key create` against the same RDS host succeeds and returns a key; read the
result from CloudWatch (`/ecs/memsmith`), never from the task's exit code, which is 0 even
when the command inside fails.

## 12. Known adjacent bug (not fixed here)

`server api-key list` fails against schema v6 with
`column "last_used_at" does not exist` — found when probing RDS reachability from
in-VPC. Stale SQL, unrelated to convert, worth its own small fix.
