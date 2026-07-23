# Team-Mode E2E Proof (Repeatable Local Rig, Dogfood-Isolated) — Design

**Status:** Design (2026-07-23). Branches from `main` @ `257c6cf5` (authorization-finish-and-tidy merge). A repeatable, one-command local rig that stands up MemSmith team mode against a throwaway Docker pgvector Postgres and proves four things end-to-end — with an absolute, enforced guarantee that the dogfood (`local` runtime, `~/.memsmith`, `:55433`/`:38879`, ~4030 observations) is never touched.

This is the **go/no-go gate for starting AWS/Cognito (OIDC)**. Team mode must be provably working e2e — locally and cheaply — before committing to cloud infra. Building Cognito on an unproven team-mode path would mean debugging code bugs and infra bugs simultaneously.

---

## Motivation

Team mode was validated once (pre-compact) against an ephemeral Docker rig that was torn down. That proved the code path *once*; it left nothing standing and nothing repeatable. Three backlog items presuppose a working, demonstrable team mode: OIDC/Cognito (how a second human authenticates), the attribution dashboard (a team-mode surface), and linked-observation dedup (needs a real second identity). So the highest-leverage next step is to convert "validated once, torn down" into "provably working, repeatably" — via a committed rig that any future session can bring up on command.

Two deferred validation gaps remain from the prior pass: the **better-auth browser session** (human login → Principal) and the **wizard Convert-flip e2e** (the real "going team" migration). This spec closes both, plus proves two-identity attribution, inside one repeatable rig.

## The dogfood-isolation contract (the load-bearing requirement)

The pre-compact incident was caused by killing the running dogfood server. This spec makes isolation a **first-class, enforced requirement**, not an afterthought.

```
DOGFOOD (never touched)                 TEAM RIG (throwaway)
──────────────────────────             ──────────────────────────
runtime: local (settings.json)          runtime: server (ENV ONLY on its process)
PG: embedded ~/.memsmith/pgdata         PG: Docker pgvector, throwaway port + volume
:55433 / :38879                         different PG port / different HTTP port
DATA_DIR: ~/.memsmith                   DATA_DIR: /tmp/ms-team-* (isolated PID + settings)
identity: team ab8e1f17 / proj 5fc024f0 identity: fresh random UUIDs (temp project)
stays running, unaware                  brought up + torn down by the rig
```

**Enforced mechanism (verified in code):** `MEMSMITH_DATA_DIR` (env) is the first-priority root for the data dir (`src/shared/paths.ts:17-18`), and it roots **everything** — `USER_SETTINGS_PATH = join(DATA_DIR,'settings.json')` (`paths.ts:44`), the server PID file, port file, the embedded DB. So a rig process with `MEMSMITH_DATA_DIR=/tmp/ms-team-*` reads/writes its *own* `/tmp` settings — the wizard flip (`writeServerModeSettings`, `src/server/convert/settings-writer.ts`, which defaults to `USER_SETTINGS_PATH` but accepts an `opts.path` override) targets the `/tmp` file and **physically cannot open** `~/.memsmith/settings.json`.

**Hard preconditions (every rig script asserts before acting):**
- Refuse to run if the resolved `MEMSMITH_DATA_DIR` is (or resolves to) `~/.memsmith`.
- Refuse to run if any target DB URL is the dogfood embedded PG (`:55433`) or the team server's HTTP port equals `:38879`.
- Never write `~/.memsmith/settings.json`. Never kill the dogfood process. The dogfood connection is opened **read-only** (snapshot only) and never as a write/convert target.

## Scope

**In:**
1. **pgvector compose fix** — the compose `postgres` service uses `pgvector/pgvector:pg17` (not `postgres:17-alpine`, which lacks the `vector` extension the schema bootstrap requires). This is the single known blocking gap from the prior validation plan.
2. **Repeatable rig scripts** — one-command bring-up + teardown of: Colima, the Docker pgvector PG (throwaway port/volume), and a team-mode MemSmith server process (server runtime via env, better-auth identity, inline queue, isolated `/tmp` DATA_DIR, distinct HTTP port). Committed so it's reproducible.
3. **Read-only dogfood snapshot + re-scoped import** — a script that `pg_dump`s the dogfood store read-only and imports it into a target store **re-scoped** to a fresh (temp) team/project identity, so copied content carries a throwaway identity, never the dogfood's.
4. **Four e2e proofs** driven by the rig (some automatable, some interactive — marked below).
5. **Isolation-precondition guard** — a shared preflight the rig scripts call, enforcing the hard preconditions above.

**Out (explicitly):**
- **AWS / Cognito / OIDC** — this is the gate *before* that work, not that work.
- **A standing/persistent remote store** — the rig is bring-up/teardown, not always-on hosting. (A persistent team server is the AWS phase.)
- **Email-invite membership** — membership here is admin-adds-via-`/v1/members` or a second minted identity.
- **Any change to product auth/convert logic** beyond the compose image fix and (if a proof surfaces a real defect) a scoped fix. This is a *proof* rig, not a feature build.
- **Linked-observation dedup / attribution dashboard views** — later, and they depend on this passing.

## Global Constraints

- **Never commit to `main`;** work on a branch. `--no-ff` merge recording pre-merge rollback SHA `257c6cf5`. Nothing pushed (local only).
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Dogfood is never at risk** — the isolation contract above is binding on every script and step. Read-only from dogfood; all mutation in Docker + `/tmp`.
- **Interactive steps are the user's** — the user `!`-launches servers (the mise shim blocks agent-launched bun servers) and performs the browser better-auth login. The user creates the temp project directory and runs `npx memsmith` setup there; the agent verifies the minted identity differs from dogfood before any copy.
- **Reuse, don't rebuild** — use the existing `pg` module, `pg_dump` at `~/.memsmith/pg-binaries/bin/pg_dump`, the existing convert engine (`copy-engine.ts` `runCopy`/`verifyCopy`) where it fits, the existing `/v1/*` routes for attribution checks.

---

## Architecture

```
┌─ dogfood (untouched) ─────────┐        ┌─ rig (throwaway, /tmp + Docker) ──────────────┐
│ local server :38879           │        │ Colima → Docker pgvector PG (throwaway port)  │
│ embedded PG :55433            │  read  │ team server: RUNTIME=server, better-auth,     │
│ ~/.memsmith                   │──only─▶│   inline queue, DATA_DIR=/tmp/ms-team-*,      │
│ team ab8e1f17 / proj 5fc024f0 │ pg_dump│   HTTP != :38879, DB → Docker PG              │
└───────────────────────────────┘        │ temp project (user-created dir): fresh identity│
                                          └───────────────────────────────────────────────┘
      preflight guard: refuse if DATA_DIR==~/.memsmith OR DB==:55433 OR HTTP==:38879
```

## Components

### 1. pgvector compose fix (`docker-compose.yml`)
Change the `postgres` service image to `pgvector/pgvector:pg17` so `CREATE EXTENSION IF NOT EXISTS vector` (schema bootstrap) succeeds. Reviewed, committed on the branch — a legitimate fix (the stack is currently broken for the extension MemSmith requires).

### 2. Isolation preflight guard (`scripts/rig/preflight.mjs`)
A pure, reused check every rig script calls first:
```
assertRigSafe({ dataDir, dbUrl, httpPort }):
  - throw if resolve(dataDir) === resolve(~/.memsmith)         // dogfood data dir
  - throw if dbUrl matches host:55433                          // dogfood embedded PG
  - throw if httpPort === 38879                                // dogfood HTTP port
  - else return ok
```
Loud, exits non-zero, prints which check failed. This is the belt-and-suspenders the user asked for.

### 3. Rig bring-up / teardown (`scripts/rig/team-up.sh`, `scripts/rig/team-down.sh`)
- `team-up`: run preflight → `colima start` (if down) → `docker compose up -d postgres` (pgvector, throwaway port e.g. `:55440`, throwaway volume) → `pg_isready` + confirm `CREATE EXTENSION vector` works → print the exact `!`-launch command for the user to start the team server (env: `MEMSMITH_RUNTIME=server`, `MEMSMITH_SERVER_DATABASE_URL=postgres://…:55440/…`, `MEMSMITH_IDENTITY_PROVIDER=better-auth`, `MEMSMITH_QUEUE_ENGINE=inline`, `MEMSMITH_DATA_DIR=/tmp/ms-team-server`, distinct HTTP port). The agent cannot launch it (mise shim); the script emits the command for the user to `!`-run.
- `team-down`: `docker compose down` (drop the throwaway volume) → print the PID (from the `/tmp` DATA_DIR) for the user to stop the team server. Dogfood untouched.

### 4. Read-only snapshot + re-scoped import (`scripts/rig/snapshot-and-rescope.mjs`)
- `pg_dump` (read-only) the dogfood observations (+ dependent rows the wizard/attribution proofs need) from `:55433` to a `/tmp` dump.
- Import into the **target** store (temp project's embedded PG, or the Docker PG per the proof), **re-scoping** every row's `team_id`/`project_id` to the target's fresh identity (rewrite on import — the idempotent re-scope pattern the original dogfood seed used). Never writes back to `:55433`.
- Reports counts by kind, and asserts the imported rows carry the *target* identity (not the dogfood's) — the differentiation check.

### 5. The four proofs (`scripts/rig/prove-*.mjs` + a checklist doc)
| # | Proof | Automatable? |
|---|---|---|
| P1 | **better-auth browser session → Principal(userId).** User logs in via better-auth in a browser against the team server; the session resolves to a Principal with a userId. | **Interactive** (user logs in; agent verifies the resolved Principal via an authenticated call) |
| P2 | **Two-identity attribution + role gating.** Identity A writes an observation (`createdByUserId=A`); identity B reads it via `/v1/search` and sees A's attribution; a viewer key is denied writes; a member can't mint keys / purge. | **Automatable** (mint two identities/keys via `/v1/keys` + `/v1/members`, drive `/v1/*` via curl/pg) |
| P3 | **Wizard Convert-flip e2e.** From the user-created temp project (fresh identity, seeded via #4 with re-scoped real data), run the real Go Team wizard: copy → verify → flip. Confirms the flip wrote the *temp* `/tmp/settings.json` (not dogfood) and the temp store now points at the Docker PG. | **Mixed** (user drives the wizard UI + `!`-launch; agent verifies copy counts, the flip target path, and post-flip state) |
| P4 | **Repeatable.** All of the above re-runnable via `team-up`/`team-down` + the scripts, with no manual one-off surgery. | **Automatable** (the rig *is* the artifact) |

### 6. Temp-project identity differentiation (procedure, not code)
- User creates an empty directory, runs a Claude session there, runs `npx memsmith` setup → MemSmith mints a **fresh** `team_id`/`project_id` (per-dir marker; `ensureProjectIdentity` → `randomUUID()`).
- Agent verifies the minted identity ≠ dogfood (`ab8e1f17…`/`5fc024f0…`) **before** any snapshot import.
- #4's re-scoped import stamps copied rows with this fresh identity → temp memory is realistic *content* under a throwaway *identity*, never confusable with dogfood memory, and (being a different project id) never surfaces in this session's recall.

## Data Flow

1. `team-up` → preflight passes → Colima + Docker pgvector PG up → extension verified.
2. User `!`-launches the team server (env-scoped, `/tmp` DATA_DIR, Docker DB).
3. **P2:** mint identities A/B → A writes → B reads → attribution + role gating asserted.
4. **P1:** user browser-logs-in via better-auth → agent verifies Principal(userId).
5. User creates temp project → agent verifies fresh identity → snapshot+re-scope real data into it.
6. **P3:** user drives wizard Go Team on the temp project → copy→verify→flip → agent verifies flip hit `/tmp/settings.json`, not dogfood, and temp store now on Docker PG.
7. `team-down` → Docker down + volume dropped → user stops team server → dogfood was never touched.
8. Record results; this gate goes green → AWS/Cognito may begin.

## Error Handling & Failure Modes

| Situation | Behavior |
|---|---|
| Preflight sees DATA_DIR==~/.memsmith or DB==:55433 or HTTP==:38879 | Refuse, exit non-zero, name the failing check. Nothing runs. |
| pgvector extension missing | `team-up` fails at the `CREATE EXTENSION` check (before any proof) — the compose fix prevents this. |
| Temp project identity == dogfood identity | Agent halts before import; something is misconfigured (marker reused). No copy proceeds. |
| Wizard flip would target ~/.memsmith | Impossible under `/tmp` DATA_DIR; P3 explicitly asserts the flip wrote `/tmp/settings.json`. |
| A proof reveals a real product defect (auth/convert bug) | Stop, treat as a systematic-debugging finding; scope a fix on the branch or a follow-up — do NOT paper over. |
| Interactive step can't complete (browser/login) | Fall back to documenting the gap; the rig records which proofs passed. Partial proof is recorded honestly, not claimed as full. |

**Invariant:** at every step, the dogfood (`~/.memsmith`, `:55433`, `:38879`, `local` settings) is only ever *read* (snapshot), never written, converted, or killed.

## Testing

This is itself a testing/validation artifact, but the *code* it introduces gets unit coverage:
1. **`preflight.mjs` unit** — table: `dataDir=~/.memsmith` → throw; `dbUrl=:55433` → throw; `httpPort=38879` → throw; a clean `/tmp` + `:55440` + `:38890` → ok. (Pure, no DB.)
2. **`snapshot-and-rescope.mjs` unit** — the re-scope SQL/transform: given rows with dogfood ids, assert the produced insert rows carry the *target* team/project ids and never the source ids. (Pure transform tested without a live DB; the actual dump/restore is exercised live in the rig.)
3. **compose fix** — verified live in `team-up` (the extension check).
4. **The four proofs** — executed live via the rig (the deliverable), results recorded to memory; not unit tests.
5. **Gate** — `bunx tsc --noEmit` clean for any `.ts` added; touched unit tests green; the broader suite's known 5 `:55432` env failures unchanged.

## Acceptance Criteria

1. `docker-compose.yml` postgres service is `pgvector/pgvector:pg17`; `team-up` confirms `CREATE EXTENSION vector` succeeds.
2. `preflight.mjs` refuses any run that targets the dogfood data dir, DB port, or HTTP port (unit-tested), and every rig script calls it first.
3. `team-up`/`team-down` bring the throwaway PG + (user-launched) team server up and down repeatably, touching nothing under `~/.memsmith`.
4. `snapshot-and-rescope.mjs` imports dogfood content **re-scoped** to a target's fresh identity (unit-tested transform); the dogfood is opened read-only (`pg_dump`) only.
5. P1 (better-auth session→Principal), P2 (two-identity attribution + role gating), P3 (wizard Convert-flip on a fresh-identity temp project seeded with re-scoped real data, flip verified to hit `/tmp` not dogfood), P4 (repeatable) are each executed and their pass/partial status recorded honestly.
6. The dogfood is verifiably untouched throughout (settings still `local`, obs count intact, server still up on `:38879`) — asserted at teardown.
7. `src` typecheck clean; added unit tests green; branch; `--no-ff` merge w/ rollback SHA; nothing pushed.
8. On all proofs green: record the go-ahead for the AWS/Cognito phase.

## Deferred (depends on this passing)
- AWS / Cognito / OIDC identity provider (the next major, gated by this).
- Attribution dashboard views.
- Linked-observation semantic dedup.
