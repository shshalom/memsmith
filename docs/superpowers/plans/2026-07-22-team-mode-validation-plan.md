# Team-Mode Validation Plan (better-auth, local Docker)

> **Status:** Plan for USER APPROVAL before any provisioning. This is a *validation* plan (prove team mode runs e2e), not a feature implementation plan. No new feature code is expected; any code changes are limited to fixing gaps this plan surfaces (e.g. the pgvector image).

**Goal:** Actually *see team mode running* — MemSmith in `server` runtime against a real reachable Postgres, with the already-built **better-auth** identity provider, memory served from the remote store, and a second identity reading it. This is the user's e2e bar for considering the Go Team wizard validated.

**Absolute constraint (restated):** The dogfood local DB (`~/.memsmith/pgdata`, `:55433`, 4008 observations) is NEVER the target and is NEVER at risk. Team mode runs against a SEPARATE Docker Postgres. We do not flip the live local runtime; we run a second, independent server instance pointed at the remote. The local server keeps running untouched.

---

## Key facts established (verified against code, 2026-07-22)

1. **Docker = Colima 0.10.0, installed but stopped.** Starting it is required; no Docker Desktop.
2. **`docker-compose.yml` ships `postgres:17-alpine` — which does NOT include pgvector.** The schema bootstrap runs `CREATE EXTENSION IF NOT EXISTS vector` (`schema.ts:42`), which **fails** on plain alpine. → **The plan MUST use `pgvector/pgvector:pg17` for the postgres service** (or an equivalent pgvector-bearing image). This is the single blocking gap.
3. **better-auth is selected by `MEMSMITH_IDENTITY_PROVIDER=better-auth`** (`settingKeys.ts:85`, enum, boot:true — takes effect at server start). `createAuth(database)` builds the better-auth instance (`auth.ts`) with `apiKey` + `organization` plugins against a `bun:sqlite` Database (better-auth's own store, separate from the observation Postgres).
4. **Key-based agent access is unchanged** and coexists — agents/CLI keep using a base key; better-auth adds the *human* login path.
5. **Team mode is inherently networked** — the Docker PG is reachable on a real host:port (`:5432`), unlike the in-process embedded `:55433`. That's what makes it a valid "team" store.

---

## What we are proving (acceptance criteria for "team mode runs")

1. A **separate MemSmith server** boots in `server` runtime against the **Docker Postgres** (pgvector present), schema bootstraps cleanly (the `CREATE EXTENSION vector` succeeds).
2. **Memory writes + reads work against the remote store**: an observation written through the server lands in the Docker PG and is retrievable via `/v1/search`.
3. **better-auth human identity works**: a real account can be created + a session established via better-auth; the session resolves to a `Principal` with a `userId`.
4. **Membership + roles work end-to-end**: the owner exists in `team_members`; a *second* identity (second account or second key) is added via `/v1/members`, gets a role, and its access is correctly gated (`requireRole`).
5. **Two-identity attribution**: an observation written by identity A carries `createdByUserId = A`; identity B can read it but attribution shows A.
6. **Offboarding**: removing the second member via `/v1/members` revokes its access (its key/session no longer authorizes).
7. **(Optional, if time) the wizard Convert flip e2e**: from a *throwaway* second local-embedded source (NOT dogfood), run the wizard Convert into the Docker PG and confirm the flip + verify. This is the wizard's own e2e; it can be a follow-on.

If 1–6 pass, **team mode is proven running** and the identity core is validated against a real networked store with real accounts.

---

## The setup (what we stand up, in order)

### Phase 0 — Pre-flight (no provisioning)
- Confirm the dogfood local server + PG are healthy and will be left ALONE (different port, different data dir, never targeted).
- Decide + record the Docker PG credentials (throwaway): `POSTGRES_USER=memsmith`, `POSTGRES_PASSWORD=<throwaway>`, `POSTGRES_DB=memsmith`, host port e.g. `:55440` (avoid clashing with anything).

### Phase 1 — Fix the pgvector gap
- Change the compose `postgres` service image from `postgres:17-alpine` to `pgvector/pgvector:pg17` (or add an init script that installs pgvector). This is a real change to `docker-compose.yml` — reviewed, committed on a branch (it's a legitimate fix: the stack is currently broken for the extension MemSmith requires).
- Verify: the image provides the `vector` extension so `CREATE EXTENSION IF NOT EXISTS vector` succeeds.

### Phase 2 — Bring up the remote Postgres (Colima + compose, PG only)
- Start Colima (`colima start`).
- Bring up ONLY the postgres service (`docker compose up -d postgres`) — we do NOT need the compose's bundled server; we'll run our own server process pointed at it, so we control config + can read logs.
- Health-check: `pg_isready`; confirm reachable on the chosen host port; confirm `CREATE EXTENSION vector` works (via the `pg` module, not psql — dyld bug).

### Phase 3 — Boot a SECOND MemSmith server in server mode against the Docker PG
- Launch a separate server instance (not the dogfood one) with:
  - `MEMSMITH_RUNTIME=server`
  - `MEMSMITH_SERVER_DATABASE_URL=postgres://memsmith:<pw>@127.0.0.1:55440/memsmith`
  - `MEMSMITH_IDENTITY_PROVIDER=better-auth`
  - `MEMSMITH_QUEUE_ENGINE=inline` (no Redis dependency for the test) OR bring up valkey if bullmq is required — decide in Phase 3.
  - a distinct HTTP port (NOT 38879 — the dogfood server owns that) e.g. `:38890`.
- Confirm schema bootstraps against the Docker PG (the pgvector `CREATE EXTENSION` succeeds — the whole reason for Phase 1).

### Phase 4 — Prove the acceptance criteria
- **Write/read:** create a team + project + owner in the remote (via the identity core's repos or an admin bootstrap), write an observation, read it back via `/v1/search` against the Docker PG.
- **better-auth account + session:** create a real account through the better-auth surface; confirm session → Principal(userId).
- **Members/roles:** add a second identity via `/v1/members`, assign a role, verify `requireRole` gating (viewer can't write, etc.).
- **Two-identity attribution:** A writes → `createdByUserId=A`; B reads → sees A's attribution.
- **Offboarding:** remove B → B's access denied.
- Each step verified via `curl` + the `pg` module reading the Docker PG directly.

### Phase 5 — Teardown + record
- `docker compose down` (keep or drop the volume — the Docker PG is throwaway).
- Stop the second server; the dogfood local server was never touched.
- Record results to memory: what passed, what the real-remote surfaced, and whether team mode is now considered proven.

---

## Safety analysis (why this can't repeat the earlier incident)

- **The dogfood server + PG are never killed or targeted.** The earlier incident was killing the running local HTTP server. Here the local server keeps running on `:38879`/`:55433`; the team-mode server is a *separate* process on a *different* port pointed at a *different* (Docker) DB.
- **No flip of the live local runtime.** We do NOT write `MEMSMITH_RUNTIME=server` into `~/.memsmith/settings.json`. The team server gets its config via env on its own process. `settings.json` stays `local`.
- **The Docker PG is disposable** and holds only test data. No dogfood data is copied into it unless we explicitly run the optional wizard-Convert step (Phase 4.7) from a *throwaway* source.
- **pgvector fix is a real, reviewed change** to a currently-broken compose file, committed on a branch — not a hack.

---

## What this does NOT cover (explicit)

- **OIDC/Cognito** — deliberately after this (the decided order: better-auth proof first, then OIDC).
- **Email-invite** — still deferred Spec #3; membership here is admin-adds-members via `/v1/members`.
- **AWS/RDS** — not needed; local Docker PG is the reachable remote. RDS is a later hosting-hardening concern.
- **Production hardening** (Fargate, Secrets Manager, CDN) — out of scope.

---

## Open decisions for the user

1. **Queue engine for the test:** `inline` (no Redis, simplest) vs bring up valkey (matches the compose's bullmq default). Recommend `inline` unless server-mode requires bullmq.
2. **Docker PG persistence:** throwaway volume dropped on teardown (recommend) vs keep it around for repeated runs.
3. **Scope of this pass:** stop at criteria 1–6 (team mode + identity proven), or also attempt 4.7 (wizard Convert flip e2e from a throwaway source) in the same session.
