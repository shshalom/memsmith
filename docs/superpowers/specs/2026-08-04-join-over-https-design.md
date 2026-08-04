# Join over HTTPS + Secrets Manager — Design

**Date:** 2026-08-04
**Status:** Approved design, not yet implemented
**Scope:** Replace the joiner's direct Postgres connection to the team database with
an authenticated HTTPS call. Keep the team database password out of every client and
out of the Fargate task definition.

---

## 1. The problem

A teammate joining a team workspace today must possess a **raw Postgres URL with the
team database password in it**. `runJoin` (`src/server/convert/join-service.ts:78`)
opens a pool straight to the remote from the joiner's machine:

```
browser → POST /v1/join → joiner's LOCAL server → pg://user:PASSWORD@team-host:5432
```

That has three consequences:

1. **Every teammate holds the database superuser credential.** Join needs `INSERT`
   on `projects` and `teams`, so the URL cannot be narrowed to read-only. Onboarding
   one person hands them write access to every table in the team's database.
2. **The invite is un-revocable in practice.** Revoking a team *key* is a row
   update. Revoking a leaked *database password* means rotating it and re-issuing to
   everyone who legitimately has it.
3. **It requires direct 5432 reachability.** RDS must accept connections from every
   teammate's network, which argues for a public endpoint or per-teammate VPN.

The team key is the credential we actually want to be the unit of access. It is
already hashed at rest, already revocable, already expirable, and already
team-scoped.

### 1.1 What this is NOT

An earlier draft of this design claimed no remote route existed for registering a
joining teammate's project, and that a new endpoint would have to accept `projectId`
from the request body — deliberately crossing the rule that
`resolve-requested-project.ts` enforces. **That framing was wrong**, verified against
the code:

- Registration already exists and already runs. `join-service.ts:128-134` calls
  `upsertProject` → `upsertTeamAndProject` (`project-identity.ts:163`), an idempotent
  `INSERT … ON CONFLICT (id) DO UPDATE` that has been creating not-yet-existing
  remote `projects` rows since join shipped.
- `teamId` is never taken from client input. `join-service.ts:105-118` reads
  `team_id` from the remote's own `api_keys` row, matched on `hashKey(apiKey)`.
- The rule in `resolve-requested-project.ts` governs **widening a read to an existing
  project**; its probe is `WHERE id = $1 AND team_id = $2` and a miss returns
  `source: 'denied'`. Registration is the opposite operation: it creates a row under
  the authenticated key's own team. A caller naming a fresh id cannot read anyone's
  data, because nothing exists at that id.

So this work is a **transport change to an already-authorized operation**. It does
not introduce a new authorization model, and it does not need an unauthenticated
endpoint or new rate limiting.

---

## 2. Architecture

The authenticated route stays exactly where it is — on the joiner's **local** server,
`POST /v1/join`, gated by `joinAuthMiddleware: writeAuth`
(`ServerV1PostgresRoutes.ts:1681`; deliberately not `requireRole`, because join is
what a non-owner does — `ConvertRoutes.ts:102-104`).

Only the outward hop changes.

```
TODAY                              AFTER
--------------------------------   --------------------------------
browser                            browser
  │ POST /v1/join                    │ POST /v1/join
  ▼ (writeAuth, joiner's own key)    ▼ (writeAuth, joiner's own key)
LOCAL server                       LOCAL server
  │                                  │
  │ pg://user:PASSWORD@team:5432      │ HTTPS  POST /v1/join/register
  ▼                                  │ Authorization: Bearer <team key>
TEAM Postgres  ◄── direct           ▼
                                   TEAM server
                                     │ (password from Secrets Manager,
                                     │  injected as env at task start)
                                     ▼
                                   TEAM Postgres  ◄── server-side only
```

### 2.1 Why the two-key model survives — and why it must

The joiner authenticates to their **own local** server with their **own local** key.
The pasted **team key** travels as a body parameter on that local request, then as a
`Bearer` token on the outward HTTPS hop. Two keys, two layers, two different servers.

This separation is what makes **specific error messages safe**. Because the caller has
already authenticated to a server they control, the team server can answer "that key
has been revoked" rather than a flat 401, without becoming a key-guessing oracle for
an unauthenticated stranger. `join-service.ts:110-126` already returns those four
distinct reasons and the UI shows them inline.

A note on why the remote route is **not** gated by the joiner's own key: a brand-new
teammate has **no credential on the team server**. Their local key exists only in
their own embedded Postgres. `writeAuth` on the team server validates against *that
server's* `api_keys` table, so gating the remote route on the joiner's key would 401
before the handler ran. The team key is necessarily the credential on the outward hop.

### 2.2 Components

| Component | File | Change |
|---|---|---|
| Local join route | `src/server/routes/v1/ConvertRoutes.ts:112` | none |
| Join orchestration | `src/server/convert/join-service.ts` | swap deps, keep logic |
| **New:** HTTPS join client | `src/server/convert/join-transport-https.ts` | create |
| **New:** remote register route | `src/server/routes/v1/ServerV1PostgresRoutes.ts` | add `POST /v1/join/register` |
| Deps wiring | `ServerV1PostgresRoutes.ts:1676-1690` | choose transport |
| Deploy | `docs/deploy/aws.md` | Secrets Manager `valueFrom` |

The design keeps `runJoin`'s five-step contract and its ordering guarantee (§2.3),
replacing only *how* steps 2–4 reach the remote. `JoinDeps` (`join-service.ts:56`) is
already an interface over the remote — that is the seam.

### 2.3 Ordering guarantee (unchanged, load-bearing)

`join-service.ts:22-31` documents the order: verify reachability → verify key/team →
register the project → *only then* cache the credential and flip the marker. The
marker is read by `selectRuntime()` on the very next hook invocation, so flipping
before the credential resolves leaves the project in team mode with **no key** —
authenticated as nobody, silently dropping every observation. The HTTPS transport
must preserve this: no local state changes until the remote returns 200.

---

## 3. The remote route

```
POST /v1/join/register            (on the TEAM server)
Authorization: Bearer <team key>
Content-Type: application/json

{ "projectId": "<uuid>", "projectName": "my-service" }

200 { "status": "joined", "teamId": "<uuid>" }
422 { "status": "failed", "error": "that key has been revoked" }
```

Handler logic — the same four checks `runJoin` performs today, moved server-side:

1. `teamId` comes from `authContext.teamId`, resolved by the standard auth
   middleware from the presented key's `api_keys` row
   (`postgres-auth.ts:340-377`). Never from the body.
2. Reject a key with no team → `422 "that key is not scoped to a team"`. Revoked and
   expired keys are already rejected by the auth middleware itself, which returns
   `null` → 401; the handler's own checks cover the teamless case and any future
   drift.
3. `upsertTeamAndProject(pool, authContext.teamId, body.projectId, body.projectName)`
   — the existing idempotent function. Re-joining and two simultaneous joins both
   succeed.
4. Return `teamId` and nothing secret. **The response must never carry the database
   URL or password** — that is the whole point of the change.

**`projectId` from the body is correct here, and is the only place in the codebase
where that is true.** The justification, restated so a future reader does not
"fix" it: the row is being *created* under the authenticated key's own team, not
*read* from another team. The composite FK `projects(id, team_id)` makes the team
half non-negotiable, and the team half comes from the credential. A caller can only
ever create a project inside its own team. Add a regression test asserting exactly
this (§5).

### 3.1 Auth gate

`writeAuth` — matching the local `/v1/join`, and for the identical documented reason:
requiring `admin`/`owner` would mean only someone who already has the workspace could
join it. A team key is by construction a credential the owner chose to hand out.

---

## 4. Transport selection

Per the agreed scope: **HTTPS preferred, Postgres fallback.**

`runJoin` receives a transport chosen at wiring time:

- The invite carries an `https://` URL → HTTPS transport.
- The invite carries a `postgres://` URL → existing direct-Postgres transport,
  unchanged, so today's rig and any existing team keep working.

This keeps the change additive. No existing join path regresses, and the fallback is
the migration story for a team already converted against a raw Postgres URL.

**Known rig limitation (must be handled during implementation):** `deriveServerUrl`
(`src/server/convert/convert-context.ts:25`) maps a localhost database URL to
`http://127.0.0.1:38879` — the *same* server the joiner is running. So the local rig
cannot exercise the HTTPS path end-to-end without **two servers on different ports**.
The implementation plan must stand up a second server instance rather than asserting
the HTTPS path works from a single-server rig. This is exactly the mistake made
earlier in this project when "two machines" was claimed from two projects on one
server.

---

## 5. Testing

Unit (no live infrastructure):

- Transport selection: `https://` → HTTPS client; `postgres://` → pg client.
- **Cross-team refusal:** a key for team A sending `projectId` of an existing team-B
  project must not move or read it. This is the guard for §3's body-`projectId`
  decision.
- Teamless key → 422 with that specific reason.
- Idempotency: two identical register calls both return 200, one `projects` row.
- Ordering: on a non-200 from the remote, no local marker write and no credential
  cached (the §2.3 guarantee).
- Response shape: assert the 200 body contains no `password`, no `databaseUrl`, no
  `postgres://` substring.

Integration (two servers, different ports):

- Full join over HTTPS: joiner ends with correct marker `teamId`, credential in
  `CredentialStore` only, **no credential in `.memsmith/project.json`**.
- Joiner reads teammates' observations (team-wide reads, already shipped).
- Joiner writes its own observation successfully (the FK-anchor path
  `repointProjectDatabaseTeam` fixed).

Regression gates unchanged: `bun test` A/B against the recorded 13-failure baseline;
`npx tsc --noEmit`.

---

## 6. Secrets Manager

**Correction to an earlier claim:** I previously stated Secrets Manager was "zero
code." The *application* code is indeed unchanged — the server already reads
`MEMSMITH_SERVER_DATABASE_URL` from the environment
(`docs/deploy/aws.md:277`). But the deploy doc is **not** ready:
`docs/deploy/aws.md:175` embeds the password inline as a plaintext `value` in the
Fargate task definition, where it is visible to anyone with
`ecs:DescribeTaskDefinition`.

The change is in the task definition, from `environment` to `secrets`:

```json
"secrets": [
  { "name": "MEMSMITH_SERVER_DATABASE_URL",
    "valueFrom": "arn:aws:secretsmanager:us-east-1:ACCT:secret:memsmith/db-url" }
]
```

ECS resolves `valueFrom` at task start and injects it as an environment variable, so
the process sees exactly what it sees today. Required additions: the secret itself,
`secretsmanager:GetSecretValue` on the **task execution role**, and removal of the
inline `value` from `environment`.

Deliberately out of scope: rotation, and any in-process AWS SDK call. Env-var
injection is the smallest change that removes the plaintext password, and rotation
can be added later without touching application code.

---

## 7. What this does not do

- **No AWS deployment.** This is code plus a corrected deploy doc. Actually standing
  up RDS/Fargate/ACM remains a separate step needing an account, a domain, and
  ~$50-100/mo.
- **No per-user identity.** The joiner is still `LOCAL_OWNER_USER_ID` locally. Per-user
  identity is a later step in the agreed order.
- **No Incognito.** MemSmith's privacy toggle is unrelated to this work. (Noting it
  because "Incognito" and AWS "Cognito" were conflated earlier in this project.)
- **No sync-on-join.** Local observations stay local until the user chooses to share,
  per the agreed semantics. The banner offering that choice is a later step.

---

## 8. Security invariants this preserves

1. The database password never leaves the server. Not in a response, not in a
   client, not in a marker file.
2. The team API key lives **only** in `CredentialStore`
   (`~/.memsmith/credentials.json`), keyed by teamId — **never** in
   `.memsmith/project.json`, which is committed to git and would put the credential
   in git history, every clone, CI, and the git host permanently.
3. `teamId` is always derived from the presented credential, never from a request.
4. `projectId` from the body is accepted at exactly one route, for creation only,
   always inside the authenticated key's own team, with a regression test pinning it.
5. The marker is never flipped before the credential resolves (§2.3).
