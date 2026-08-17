# Owner Join-Over-HTTPS + Promote-to-Sync — Design

> **WITHDRAWN 2026-08-17.** Superseded by `2026-08-17-convert-over-https-design.md`.
> Its central premise was wrong: it treated a per-project team id as "silent isolation"
> when that is the access boundary working as designed, and its "39% fail the quality
> floor" figure came from measuring the dogfood project's entire history instead of a
> representative project (the real figure on current code is 0%). Retained only as a
> record of the error — see §9 of the replacement. Do not implement.

**Date:** 2026-08-14
**Status:** Proposed
**Supersedes part of:** `2026-07-21-go-team-wizard-design.md` (the owner/convert path)
**Builds on:** `2026-08-04-join-over-https-design.md` (which did this for the *joiner* only)

## 1. Why

Team mode's **joiner** path is proven working against live AWS: `/v1/join/register`
returns a join-specific 422 for a bad key, takes `teamId` from the key's own row, and
refused a planted cross-team `teamId` in the request body. A teammate needs only the
team key, over HTTPS, and never a database password.

The **owner** path — GO TEAM / convert — was never given the same treatment, and it
does not work against a managed database. Four blockers, each verified by execution
against the live deployment on 2026-08-13/14, not by reading code:

1. **The browser cannot reach the destination database.** The wizard's destination
   field takes a `postgres://` connection string (`DestinationCard.tsx:110`), and the
   wizard runs in the user's browser. A production RDS is private — which is precisely
   why minting the AWS owner key required an in-VPC Fargate task rather than a laptop
   connection. There is no UI-level test that can cover this path as built.

2. **`deriveServerUrl` stamps the database host as the API endpoint.**
   `convert-context.ts:31` returns `https://${host}` where `host` is the *database*
   hostname. Executed against a realistic RDS URL:

   ```
   input : postgres://…@memsmith-db.cluster-abc123.us-west-2.rds.amazonaws.com:5432/memsmith
   output: https://memsmith-db.cluster-abc123.us-west-2.rds.amazonaws.com
   actual: https://a9usu1xbrh.execute-api.us-west-2.amazonaws.com/prod
   ```

   That host speaks Postgres, not HTTP. The converted project is flipped to team mode
   pointing at a non-existent API and every later request fails. The
   `2026-08-04` spec predicted this exactly — "the URL-shaping branch used in
   production is not the branch the tests exercise… the first action once AWS exists is
   a smoke check of branch 3, before anything else is trusted." That smoke check has
   now run, and branch 3 fails as predicted.

   The escape hatch is real but **unreachable from the UI**: `deriveServerUrl` honours
   an explicit `existingServerUrl` first (`convert-context.ts:26`), yet the wizard
   client posts only `{databaseUrl}` (`wizardData.ts:97`). There is no field for it.

3. **Convert lands the project in a brand-new isolated team.** A new local project
   mints `teamId: randomUUID()` (`project-identity.ts:242`). `restampTeamId`
   (`convert-scope.ts:61-68`) stamps every row with that *local* team id, and
   `ensureRemoteTeamHinge` **creates** that team on the remote rather than joining an
   existing one. The rows land in the team database under a team nobody else belongs
   to. Verified on live AWS: a team-wide key returned 14 rows, all one team — a project
   converted under a fresh team id is invisible to every existing teammate.

   **This is the most dangerous of the four because it appears to succeed.** Convert
   reports `converted`, counts verify, the marker flips. The user believes they joined
   their team. Nobody can see their work and there is no error to explain why.

4. **The bulk copy requires a direct pool.** `runCopy` + `verifyCopy`
   (`convert-service.ts:57,64`) copy all seven tables synchronously over a direct
   Postgres connection — the same connection blocker 1 says cannot exist.

## 2. Goals / Non-goals

**Goals**

- A new local project can attach to an **existing** remote team using only the team key
  over HTTPS, with no direct Postgres connection and no database password on the
  machine.
- The owner explicitly chooses *create a new team* or *join an existing team*, so
  silent isolation (blocker 3) becomes impossible rather than merely unlikely.
- Existing local observations reach the team by **user-initiated promote**, surfaced as
  a dashboard banner — not as a silent automatic upload.

**Non-goals**

- Selective per-observation promote. One-click promote-all ships first; selection is a
  follow-on once the sync path is proven.
- Removing the direct-Postgres convert path. It is retained for a self-hosted database
  the owner can actually reach, and stays the only way to bulk-copy in one shot.
- Changing the joiner path. It works; this spec does not touch it.

## 3. Architecture

Three independent units, each testable alone.

### 3.1 Wizard: explicit intent + HTTPS-only join inputs

The destination step gains a fork before any credential is requested:

```
Welcome → Intent ──"Start a new team"──→ (today's flow: databaseUrl + convert)
                └─"Join an existing team"→ team key + server URL → verify → flip
```

The join branch collects **two fields and no database URL**:

| Field | Example | Why |
|---|---|---|
| Team key | `cmem_…` | Authorization; `teamId` is derived from it server-side |
| Server URL | `https://…execute-api…/prod` | Stated, never derived from a DB hostname |

This kills blockers 1 and 2 by construction: nothing needs a Postgres connection, and
the server URL is supplied rather than inferred.

### 3.2 Owner join client (reuses the joiner's transport)

`makeHttpsJoinTransport()` (`join-transport-https.ts`) already POSTs
`{teamKey, projectId, projectName}` to the remote's `/v1/join/register`, which returns
`{status, teamId}` with `teamId` taken **only** from the key's row. That is exactly the
behaviour blocker 3 needs, and it is already proven live.

**Wire contract.** `POST /v1/join` today reads `{databaseUrl, apiKey}`
(`ConvertRoutes.ts:113-114`), and `runJoin` already decides per-invite via `isHttpUrl`
whether to use the HTTPS transport or the retained Postgres fallback — so an `https://`
value in that field already works. It is nonetheless renamed: the route accepts
`{serverUrl, apiKey}` and treats `databaseUrl` as a deprecated alias for one release, so
existing callers keep working while the field stops misdescribing itself. Passing a
`postgres://` value as `serverUrl` is rejected with a message naming the expected shape,
rather than silently taking the fallback path — the owner join flow is HTTPS-only by
design, and a silent fallback would reintroduce blocker 1.

So the owner join path is not new machinery — it is the existing transport called from
the owner's flow:

1. POST `/v1/join/register` on the **stated** server URL with the team key.
2. On `{status:'joined', teamId}`, cache the key in `CredentialStore` under that
   `teamId`, then write the marker: `{teamId, projectId, runtime:'server', serverUrl}`.
3. Key **before** marker, so the project is never in team mode without a resolvable
   credential (the existing `applyConvertJoin` ordering rule).

The project's local rows are **not** touched at this point. Joining is a metadata
operation; data movement is §3.3.

### 3.3 Promote-to-sync

After joining, the project's existing local observations are not in the team. The
dashboard shows a banner:

> **N local observations aren't in the team yet.** [Promote]

Promote pushes every unsynced local observation to `POST /v1/memories` in batches over
the authenticated HTTPS API — the same path already proven against AWS.

**Idempotency is already solved and needs no new mechanism.** Migration 5 added
`observations.idempotency_key` plus a *partial unique index* on
`(team_id, project_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
(`schema.ts:141-146`), and the insert uses a matching `ON CONFLICT`
(`observations.ts:215`). `/v1/memories` already accepts `idempotencyKey`
(`ServerV1PostgresRoutes.ts:976`). A retried batch therefore cannot duplicate rows, so
promote is resumable for free: re-running it converges.

**Local rows are kept, never deleted.** A successful promote marks them synced. Nothing
is removed, so a failed or partial promote cannot lose data and the project still reads
locally. This costs duplicate storage and is the right trade: the alternative turns any
bug in the confirmation step into data loss on a live project.

**New state required.** There is no synced marker today — verified: no `synced`,
`remote_id`, or `promoted` column exists in `schema.ts`. Add migration 7:

```sql
ALTER TABLE observations ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;
```

Current schema version is 6 (`schema.ts:6`, and the live AWS server reports
`schemaVersion: 6`), so this is migration **7**, registered alongside the existing
entries and with `SERVER_POSTGRES_SCHEMA_VERSION` bumped to 7 in the same change —
otherwise the migration never runs.

`promoted_at IS NULL` defines "unsynced" and drives the banner count. A nullable
timestamp (rather than a boolean) records *when*, which is what a support question
actually needs.

**Scope of the column:** it is meaningful only in the *local* database. A row in the
team database is by definition already there, so `promoted_at` is never read remotely.
It is local bookkeeping, not replicated state.

## 4. Data flow

```
  Browser (wizard, join branch)
    │  POST /v1/join  { teamKey, serverUrl }        ← no databaseUrl
    ▼
  Owner's LOCAL server                              ← authenticated by loopback cookie
    │  POST {serverUrl}/v1/join/register { teamKey, projectId }
    ▼
  Team server on AWS  ── teamId FROM THE KEY'S ROW ──┐
    │  200 { status:'joined', teamId }               │  body teamId ignored
    ▼                                                │
  Owner's local server: cache key → write marker ────┘
    │
    ▼
  Dashboard banner: "N local observations aren't in the team yet"
    │  user clicks Promote
    ▼
  Batched POST {serverUrl}/v1/memories  { …, idempotencyKey }
    │  ON CONFLICT → no duplicates on retry
    ▼
  promoted_at = now() on each confirmed row
```

## 5. Error handling

Each failure keeps a distinct, actionable message — the reason the join transport puts
the key in the **body** rather than an `Authorization` header, so four causes do not
collapse into one flat 401:

| Condition | Result |
|---|---|
| Bad / revoked / expired / teamless key | 422 with the specific reason (existing behaviour) |
| Server URL unreachable | `cannot reach that server at <url>` — never echoes the request, which contains the key |
| Join succeeds, promote fails midway | Marker stays joined; banner still shows the remaining count; retry converges via `idempotencyKey` |
| Promote partially applied | No data loss: local rows retained, only confirmed rows get `promoted_at` |

A join that succeeds while promote fails is a **normal, recoverable state**, not a
half-migration. That is the main structural advantage over today's all-or-nothing copy.

## 6. Testing

**Unit**
- `deriveServerUrl` branch 3 with a realistic RDS host, asserting the result is *not*
  used when an explicit server URL is supplied. This is the branch the `2026-08-04`
  spec flagged as untested-in-production; it now gets a pinned test.
- Owner join: given `{status:'joined', teamId:T}`, the marker is written with `T` and
  **not** with the local `randomUUID` team. This is the blocker-3 regression test.
- Promote batching: a retried batch produces no duplicate rows (drive the real
  `ON CONFLICT` path, not a mock).

**Integration (isolated rig, never dogfood)**
- Two local projects under one team in the rig database; join project A to a remote team
  and assert project B's rows never move — the scope property already proven for the
  read path now proven for the write path.
- Promote with the remote unreachable → banner count unchanged, no partial marker.

**Against AWS**
- Owner join a scratch project to the real AWS team, then confirm the existing
  team-wide key **sees it** — the direct inverse of the blocker-3 finding, where a
  converted project was invisible.

**Every test runs against the rig (`scripts/rig/`) or a scratch AWS project. Never the
dogfood project** — its data is not to be tampered with, per standing instruction.

## 7. Security invariants preserved

1. The database password never reaches the owner's machine on the join path — there is
   no database URL field at all.
2. The team key lives only in `CredentialStore`, keyed by `teamId`, never in
   `.memsmith/project.json` (which is committed to git). This is structural:
   `ProjectMarker` has no credential field.
3. `teamId` is always derived from the presented credential, never from a request body.
   Verified live: a planted dogfood `teamId` in the `/v1/join/register` body was ignored.
4. Key is written **before** the marker, so a project is never in team mode without a
   resolvable credential ("dark capture" prevention).

## 8. What this does not fix

The direct-Postgres convert path keeps blocker 2 for anyone who uses it without a
marker `serverUrl`: `deriveServerUrl` will still stamp the database host. This spec
routes the *managed-database* case around it entirely rather than repairing it, because
the branch is only correct when the API and the database share a hostname — true for a
single-box self-hosted server, false for every managed deployment. Repairing that branch
is a separate, smaller change: require an explicit server URL whenever the database host
is not loopback.
