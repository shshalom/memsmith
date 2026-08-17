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

Users A and B reach project A and **not** project B. This is already enforced:
`resolve-requested-project.ts:86-88` denies a project-scoped key any other project,
verified live — a key scoped to project A got
`403 API key is scoped to a different project` writing to project B.

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
posts `{databaseUrl}` to a *relative* path, and the **local server** opens the pool
(`ServerV1PostgresRoutes.ts:1821`). The blocker is the local server's reach, not the
browser's.

## 3. Second blocker: the stamped server URL

`deriveServerUrl` (`convert-context.ts:31`) returns `https://${host}` where `host` is the
**database** hostname. Executed against a realistic RDS URL:

```
input : postgres://…@memsmith-db.cluster-abc123.us-west-2.rds.amazonaws.com:5432/memsmith
output: https://memsmith-db.cluster-abc123.us-west-2.rds.amazonaws.com
actual: https://a9usu1xbrh.execute-api.us-west-2.amazonaws.com/prod
```

That host speaks Postgres, not HTTP. Even with connectivity, the converted project flips
to team mode pointing at a non-existent API. The escape hatch exists —
`deriveServerUrl` honours an explicit `existingServerUrl` first
(`convert-context.ts:26`) — but is **unreachable from the UI**, because the wizard posts
only `{databaseUrl}` (`wizardData.ts:97`).

The `2026-08-04` spec predicted this: *"the URL-shaping branch used in production is not
the branch the tests exercise… the first action once AWS exists is a smoke check of
branch 3, before anything else is trusted."* That check has now run and branch 3 fails.

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

`runCopy`/`verifyCopy` keep their logic; only `CopyDeps` changes — `upsertRows` POSTs a
batch instead of executing INSERTs, and the count check calls a scoped count endpoint
instead of querying the remote directly. This mirrors how the joiner's transport was
swapped without rewriting `runJoin`.

## 6. The sync banner

The user promotes their existing observations **inside the wizard**, before convert
reports done — not from a dashboard banner afterwards. The wizard shows the count and a
Promote action, so there is no window in which the project is half-migrated and the user
has navigated away.

One-click promotes everything unsynced; per-observation selection is out of scope.
**Local rows are never deleted** — a successful batch marks them, so a failed or partial
promote cannot lose data and the project still reads locally.

Marking requires one migration (current version is 6, so this is **7**, with
`SERVER_POSTGRES_SCHEMA_VERSION` bumped in the same change or it never runs):

```sql
ALTER TABLE observations ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;
```

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

**Unit**
- `deriveServerUrl` branch 3 against a realistic RDS host, asserting the derived value is
  **not** used when a server URL is supplied. This is the branch `2026-08-04` flagged as
  untested-in-production; it gets a pinned test.
- `createdAt` round-trip through `ObservationsRepository`: a row inserted with an
  explicit past timestamp reads back with that timestamp, not `now()`. Mutation check —
  reverting the column addition must fail this test.
- Batch idempotency: replaying a `batchToken` inserts nothing and reports
  `already_applied`.

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

1. The database password never reaches the owner's machine on the HTTPS path — there is
   no database URL field on it at all.
2. The team key lives only in `CredentialStore`, keyed by `teamId`, never in
   `.memsmith/project.json` (which is committed to git). Structural: `ProjectMarker` has
   no credential field.
3. `teamId` is always derived from the presented credential, never a request body.
   Verified live: a planted foreign `teamId` in the `/v1/join/register` body was ignored
   and the server returned the key's own team.
4. Key is written **before** the marker, so a project is never in team mode without a
   resolvable credential ("dark capture" prevention).
5. `/v1/convert/import` is `writeAuth` + `requireWriteRole()` and scoped by the key's
   own project, so it cannot write into a project the caller cannot reach — the same
   `403` boundary proven for `/v1/memories`.

## 11. Known adjacent bug (not fixed here)

`server api-key list` fails against schema v6 with
`column "last_used_at" does not exist` — found when probing RDS reachability from
in-VPC. Stale SQL, unrelated to convert, worth its own small fix.
