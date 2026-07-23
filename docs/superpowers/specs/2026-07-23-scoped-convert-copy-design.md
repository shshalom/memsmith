# Scoped Convert Copy — Design (Sub-spec 2 of Project-Scoped Go Team)

**Date:** 2026-07-23
**Status:** Approved (design). Ready for implementation planning.
**Predecessor:** Sub-spec 1 — Per-Project Runtime Resolution (merged @ `38ce3ef7`).

## Problem

The Go Team wizard's Convert step copies the **whole physical local store** to the
destination team, not just the project being converted. Root cause: in
`buildConvertCopyDeps` (`src/server/routes/v1/ServerV1PostgresRoutes.ts:1611`),
`readRows` runs `SELECT * FROM ${table}` and `countRows` runs `count(*) FROM ${table}`
— both unscoped. `runConvert → runCopy` (`src/server/convert/copy-engine.ts`) then
walks every row of all 11 `COPY_TABLES`.

Because one embedded Postgres (`~/.memsmith`) hosts unlimited local projects (each its
own `teamId`/`projectId` minted by `ensureProjectIdentity`, separation is logical), a
user with projects A and B who hits **Go Team while working in B** would silently drag
**A's memory** onto the shared team store. This is a data-scope / privacy leak, not a
mere migration nit.

### Correct behavior (user's mental model)

With projects A and B sharing one local PG, running Go Team from inside B must convert
**only B**: copy only B's observations + lineage, re-stamped under the destination
team, and flip only B's runtime. Project A stays local and untouched.

## Scope

One focused change to the convert copy path. **In scope:**

- Thread the **local `projectId`** from the wizard client into the convert route and
  down into `buildConvertCopyDeps`.
- Make `readRows` / `countRows` **project-scoped** for project-scoped tables and their
  lineage; re-stamp `team_id` to the destination team on copy.
- Skip team-account tables.
- Make `verifyCopy` compare **scoped** counts.
- Tests proving "only the current project is copied; a sibling project is untouched."

**Out of scope (unchanged):** the flip (`flipToTeam` — sub-spec 1, done), the wizard
UI, connection probe, attribution re-stamp of `observations.metadata.createdByUserId`
(kept as-is), any new schema/migration.

## Decisions

### D1 — Scope source: client sends `projectId` in the request body

The wizard client already reads the local marker `.memsmith/project.json` and sends
`cwd`, `serverUrl`, `apiKey` in the `POST /v1/convert/migrate` body. It adds
`projectId` (the local marker's `projectId`) to that body. `teamId` continues to come
from `req.authContext` (the destination team).

- **Why not `authContext.projectId`:** that is the *destination* key's project scope
  (often null for a fresh team key) — the wrong axis for filtering *local source* rows.
- **Why not "server reads marker from `cwd`":** the server would read a filesystem path
  meaningful only on the client host — works today (co-located embedded PG) but is a
  layering hazard the moment the server is genuinely remote.
- **Trust:** the route is `writeAuth + requireRole('owner')`; the caller converts their
  own project; a bad `projectId` copies the wrong slice of the caller's *own* store —
  not a cross-tenant leak. The route validates presence (400 when missing).

### D2 — Skip team-account tables

`teams`, `team_members`, `api_keys`, `server_settings` are **not copied**. The
destination team already exists (the owner created it and minted the auth key). Copying
the local placeholder rows would clobber the real team's account rows. The copy carries
**project data + its lineage only**.

### D3 — `projects` row: copy and re-stamp `team_id`

The single local `projects` row for this project is copied, keeping the same
`project_id` (`id`) but with `team_id` **re-stamped to the destination `teamId`**. It
must be inserted before any child rows so the `(project_id, team_id) → projects(id,
team_id)` FKs on the child tables hold. This realizes "the project keeps its identity
but now lives under the team."

### D4 — Project-scoped tables: filter by `project_id`, re-stamp `team_id`

Tables with a direct `(project_id, team_id)`:

| Table | Local read filter |
|---|---|
| `projects` | `WHERE id = $projectId` (its scope column is `id`) |
| `server_sessions` | `WHERE project_id = $projectId` |
| `agent_events` | `WHERE project_id = $projectId` |
| `observation_generation_jobs` | `WHERE project_id = $projectId` |
| `observations` | `WHERE project_id = $projectId` |

Every copied row of these tables has its `team_id` set to the destination `teamId`
during copy (the `projects.id` / `project_id` values are unchanged).

**Lineage tables (no `project_id`/`team_id` column — filter via parent):**

| Table | Parent FK | Local read filter |
|---|---|---|
| `observation_sources` | `observation_id → observations(id)` | `WHERE observation_id IN (SELECT id FROM observations WHERE project_id = $projectId)` |
| `observation_generation_job_events` | `generation_job_id → observation_generation_jobs(id)` | `WHERE generation_job_id IN (SELECT id FROM observation_generation_jobs WHERE project_id = $projectId)` |

Lineage rows carry no scope columns, so they are copied verbatim (no re-stamp) — their
scope is implied by the parent, which is already re-stamped.

FK-safe copy order is unchanged from `COPY_TABLES`: `projects` →
`server_sessions` → `agent_events` → `observation_generation_jobs` →
`observations` → `observation_sources` → `observation_generation_job_events`. The four
team-account tables are removed from the copy walk (D2).

### D5 — `verifyCopy`: scoped counts on both sides

`verifyCopy` compares **the same scoped filter** local vs remote (not whole-table
`count(*)`):

- **local count** = rows matching the D4 filter (project-scoped / lineage-via-parent).
- **remote count** = same filter, additionally constrained to the destination
  `team_id` for the direct-scoped tables (lineage verified via the same parent
  subquery against the remote's now-scoped parents).
- Keep the existing `remote >= local` per-table semantics (idempotent, resume-safe).
- Team-account tables are excluded from verify (not copied).

Without this, an unscoped local count would include sibling projects we deliberately
didn't copy → guaranteed false mismatch; an unscoped remote count would include other
teams' data → also wrong.

## Component / data flow

```
wizard client (in project B)
  reads .memsmith/project.json  → local projectId
  POST /v1/convert/migrate { databaseUrl, cwd, serverUrl, apiKey, projectId }
        │  teamId ← authContext (destination team, owner-gated)
        ▼
ConvertRoutes.ts  — validate projectId present (400 if missing);
                    pass projectId into convert(input)
        ▼
ServerV1PostgresRoutes.buildConvertCopyDeps(remoteUrl, { projectId, teamId })
   readRows(table)   → scoped SELECT per D4 (filter + re-stamp team_id on copy)
   countRows(w,tbl)  → scoped count per D5
   upsertRows(...)   → unchanged (INSERT ... ON CONFLICT (id) DO NOTHING)
        ▼
runConvert → runCopy (COPY_TABLES minus team-account tables) → verifyCopy (scoped)
        ▼
on verify ok → flipToTeam (unchanged, sub-spec 1)
```

The re-stamp of `team_id` happens where the row is shaped for copy. `runCopy` already
has a per-row shaping hook for `observations` (attribution). This design extends
row-shaping to set `team_id` on all direct-scoped tables. Whether the re-stamp lives in
`readRows` (scoped SELECT already returns rows; rewrite `team_id` there) or in
`runCopy`'s shaping loop is an implementation choice for the plan; the spec requires
only that copied direct-scoped rows land under the destination `team_id`.

## Interfaces (contract changes)

- **`ConvertRoutesDeps.convert` input** gains `projectId: string`:
  `{ databaseUrl, ownerUserId, cwd, teamId, serverUrl, apiKey, projectId }`.
- **`POST /v1/convert/migrate`** reads `projectId` from body; returns `400 { error:
  'projectId required' }` when absent (consistent with the existing cwd/serverUrl/apiKey
  validations).
- **`buildConvertCopyDeps(remoteUrl, scope)`** gains a `scope: { projectId: string;
  teamId: string }` argument; `readRows`/`countRows` use it.
- **`CopyDeps` / `copy-engine`** signatures: `readRows`/`countRows`/`upsertRows` shapes
  are unchanged; the scoping lives behind the deps (in `buildConvertCopyDeps`). If the
  `team_id` re-stamp is done in `runCopy`, `runCopy` gains a `teamId` parameter
  alongside the existing `ownerUserId`; the plan picks the cleaner seam.
- `COPY_TABLES` in `copy-engine.ts` is reduced to the seven copied tables (D2), or the
  four team-account tables are filtered at the call site — plan's choice, but the
  team-account tables must not be read or counted.

## Error handling

- Missing `projectId` → 400 before any DB work (route-level).
- Local project with zero rows in a table → empty copy for that table (fine).
- Verify mismatch → existing `verify_failed` path, no flip (unchanged).
- FK violation on child insert (e.g. `projects` row missing) → surfaces as convert
  failure; prevented by copy order (D3/D4) inserting `projects` first.

## Testing

1. **Two-project isolation (the core proof):** seed a local PG with project A and
   project B rows (observations + lineage + sessions/events/jobs for each). Run a scoped
   convert for B. Assert: remote has **all** of B's rows under the destination `team_id`
   with unchanged `project_id`; remote has **zero** rows carrying A's `project_id`.
2. **Lineage follows parent:** B's `observation_sources` /
   `observation_generation_job_events` land on the remote iff their parent
   observation/job was copied; A's lineage does not.
3. **`team_id` re-stamp:** copied direct-scoped rows carry the destination `team_id`,
   not the local one; `project_id` unchanged.
4. **Team-account tables untouched:** convert does not read/count/insert `teams`,
   `team_members`, `api_keys`, `server_settings`; a pre-existing destination
   `team_members`/`api_keys` row is unchanged after convert.
5. **Scoped verify:** `verifyCopy` returns `ok` when B is fully copied even though the
   remote also contains unrelated team data and the local store also contains project A
   (i.e. no false mismatch from sibling/other-team rows).
6. **Idempotent re-run:** running the scoped convert twice yields the same remote state
   (`ON CONFLICT DO NOTHING`) and still verifies ok.
7. **Route validation:** `POST /v1/convert/migrate` without `projectId` → 400; with it →
   reaches `convert(input)` with `projectId` populated.

## Global constraints

- Never commit to `main` directly — branch from `38ce3ef7`; merge `--no-ff` recording a
  pre-merge rollback SHA; nothing pushed (local only).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Dogfood data must never be at risk (`:38879` local runtime, untouched).
- Team API key lives only in `CredentialStore` — never in the marker (unchanged; flip is
  sub-spec 1).
- No new schema/migration; no dependency changes.
