# Join over HTTPS + Secrets Manager — Design

**Date:** 2026-08-04
**Status:** Design complete, reviewed, awaiting user approval. Not implemented.

**Evidence standard used here:** every file-and-line reference was read in the current
tree, not recalled. Claims are marked where they rest on a code audit rather than a
live run — the design's central security claim (§4.2) is one of those, because §4.3
establishes the current rig cannot exercise the HTTPS path at all. Nothing in this
document has been observed working end to end, and it should not be read as if it had.
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

So this work is a **transport change to an already-authorized operation**. It does not
introduce a new authorization model.

It does, however, need **one piece of new security-relevant code**: because the remote
route must return specific error reasons (§2.1), it inspects the team key as a body
parameter rather than delegating to the auth middleware — which makes it reachable
without prior authentication and therefore requires rate limiting (§3.2). An earlier
draft claimed no rate limiting was needed; that was true only of a design that
sacrificed the specific error messages.

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
  ▼                                  │ body: { teamKey, projectId }  (§2.1)
TEAM Postgres  ◄── direct           ▼
                                   TEAM server
                                     │ rate-limited (§3.2)
                                     │ (DB password from Secrets Manager,
                                     │  injected as env at task start)
                                     ▼
                                   TEAM Postgres  ◄── server-side only
```

The joiner's machine holds the **team key** and nothing else. No database password
crosses the boundary in either direction, at any point in the project's lifecycle
(§4.2).

### 2.1 The two layers, and where specific errors come from

The joiner authenticates to their **own local** server with their **own local** key
(`writeAuth`). The pasted **team key** travels as a body parameter on that local
request, and then — deliberately **also as a body parameter**, not a `Bearer` token —
on the outward HTTPS hop.

That last choice needs stating plainly, because the obvious design is wrong. If the
team key were presented as `Authorization: Bearer`, the existing auth middleware would
evaluate it, and `postgres-auth.ts:360-370` returns `null` for **missing, revoked,
expired, and insufficient-scope** alike → one flat `401` at line 222. The four
distinct reasons `join-service.ts:110-126` produces today would be destroyed:
a teammate whose key was revoked would see only "unauthorized" and have to go ask the
owner why.

So the remote route takes the team key as **data it inspects**, performing the same
hash lookup `runJoin` does today, and returns the specific reason. This is a
deliberate, narrow exception to "credentials go in the Authorization header," and its
cost is that the route is reachable without prior authentication — addressed in §3.2.

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
| Rate limiting | `src/server/middleware/rate-limit.ts` + `storage/postgres/rate-limit.ts` | **reuse**; add only a subject-derivation middleware (§3.2) |
| Deps wiring | `ServerV1PostgresRoutes.ts:1676-1690` | choose transport |
| Join form | `src/ui/viewer/…` (join dialog) | HTTPS-only URL field (§4.1) |
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
Content-Type: application/json

{ "teamKey": "<team key>", "projectId": "<uuid>", "projectName": "my-service" }

200 { "status": "joined", "teamId": "<uuid>" }
422 { "status": "failed", "error": "that key has been revoked" }
429 { "error": "rate_limited", "message": "Rate limit exceeded (10 requests / 900s)" }
```

The `429` body is **not invented for this route** — it is the shape the existing
limiter already emits (`rate-limit.ts:42-45`), along with `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, `X-RateLimit-Reset` and `Retry-After` headers. See §3.2.

### 3.1 Handler logic

The same four checks `runJoin` performs today, moved server-side:

1. Look up `hashKey(body.teamKey)` in `api_keys`, reading `team_id`, `revoked_at`,
   `expires_at` — the identical query at `join-service.ts:105-108`. `teamId` therefore
   comes from **the key's own row**, never from the body.
2. Return the specific reason on failure, all `422`:
   no row → `"that key is not valid for this workspace"`; `revoked_at` set →
   `"that key has been revoked"`; `expires_at` past → `"that key has expired"`;
   `team_id` null → `"that key is not scoped to a team"`.
3. `upsertTeamAndProject(pool, row.team_id, body.projectId, body.projectName)`
   — the existing idempotent function. Re-joining and two simultaneous joins both
   succeed.
4. Return `teamId` and nothing secret. **The response must never carry the database
   URL or password** — that is the whole point of the change.

### 3.2 Rate limiting — required, and mostly already built

Because §2.1 puts the team key in the body rather than the `Authorization` header,
this route is reachable **without prior authentication**. Untreated, it is a
key-guessing oracle that helpfully distinguishes "no such key" from "revoked key."

**Prior art, and the trap in reusing it.** A limiter already exists —
`requireRateLimit(pool, { windowSec, max })` in `src/server/middleware/rate-limit.ts`:
fixed-window, atomic, cross-instance-correct, with the headers and `429` body above.
But it **cannot be used on this route as written**. Lines 54-55 read the subject from
`req.authContext?.apiKeyId` and `return next()` when it is absent — an intentional
"unauthenticated / local-dev bypass: nothing to limit." On a deliberately
unauthenticated route `authContext` is undefined, so **every request would pass
through unlimited**: the reuse looks safe and is a silent no-op. This is worth naming
because it is the project's recurring failure mode — the plausible-looking path that
quietly does nothing.

**What is actually new is small.** The storage layer is reusable as-is:
`PostgresRateLimitRepository.hit({ subjectId, windowStart, limit })` does one atomic
UPSERT, and `schema.ts:287-291` declares `subject_id TEXT NOT NULL` with
`PRIMARY KEY (subject_id, window_start)` and **no foreign key** — so an arbitrary
subject string is already legal. **No schema change, no new table, no new limiter.**
The only new code is a middleware that derives the subject from the request instead
of from `authContext`:

- `joinkey:<hashKey(teamKey)>` when the body carries a key, else
- `joinip:<source ip>`.

Keying on the key hash keeps one noisy teammate from locking out colleagues behind the
same NAT; the IP bucket is the branch that actually catches guessing, since an attacker
probing for valid keys produces many *distinct* hashes from one source.

Budget: 10 attempts per 900s per bucket. The key space is a SHA-256 of a random key,
so this is not the primary defence — it exists so that distinguishing the four reasons
cannot be amplified.

**Failure mode — a stated decision, not an inherited one.** The existing limiter
**fails open** by design (`rate-limit.ts:58-63`: "a limiter/quota storage hiccup must
never take the API down"). This route keeps that behaviour: a database blip must not
make joining impossible, and the guessing resistance given up is marginal against a
256-bit key space. Recorded explicitly because fail-open is the *wrong* default for
most anti-guessing controls, and a future reader should see that it was chosen rather
than inherited by accident.

### 3.3 Why `projectId` may come from the body here

**This is the only place in the codebase where that is true**, so the justification is
stated here rather than left to a code comment. The row is being *created* under the
authenticated key's own team, not *read* from another team. The composite FK
`projects(id, team_id)` makes the team half non-negotiable, and the team half comes
from the key's own row (§3.1 step 1). A caller can therefore only ever create a project
inside its own team, and naming a fresh id reveals nothing because nothing exists at
it yet.

Contrast `resolve-requested-project.ts`, whose rule this appears to cross but does not:
that middleware exists to stop a request **widening a read to an existing project**
(`WHERE id = $1 AND team_id = $2`, miss → `source: 'denied'`). Creation under your own
team is the opposite operation. §5 pins this with a cross-team regression test.

### 3.4 Why no role gate

Possession of a valid, unrevoked, unexpired, team-scoped key **is** the authorization —
exactly as it is today. Requiring `admin`/`owner` would mean only someone who already
has the workspace could join it (`ConvertRoutes.ts:102-104`,
`ServerV1PostgresRoutes.ts:1681`). A team key is by construction a credential the owner
chose to hand out, and revoking it is a row update.

---

## 4. Transport selection

Per the agreed scope: **HTTPS preferred, Postgres fallback.**

`runJoin` receives a transport chosen at wiring time:

- The invite carries an `https://` URL → HTTPS transport.
- The invite carries a `postgres://` URL → existing direct-Postgres transport,
  unchanged, so today's rig and any existing team keep working.

### 4.1 The fallback is migration-only, and must be labelled as such

Presenting the Postgres fallback as cost-free back-compat would be a mistake, so state
the cost explicitly: **the fallback is the only path that still requires a teammate to
hold a database password.** It therefore preserves, for anyone who uses it, the exact
vulnerability this work exists to remove.

It is retained for one situation: a team already converted against a raw Postgres URL,
whose owner necessarily *already* has that URL. That is a migration path for the owner,
not an onboarding path for teammates.

**Measured: the fallback currently protects nothing.** On the development machine,
`~/.memsmith/settings.json` has `MEMSMITH_RUNTIME: local` and **no**
`MEMSMITH_SERVER_DATABASE_URL`, and nothing is pointed at a remote Postgres URL (52
teams / 16 projects / 5 team-scoped keys, all local). So deleting the fallback would
carry no migration cost today.

**DECIDED (2026-08-04): the fallback is retained. Do not delete it.** This is settled,
not open. That removal happens to be cheap is not a reason to remove it — the audit
above covers one machine and cannot see a team already running on a raw Postgres URL
elsewhere. A later review pass must not reopen this as "free to remove."

Consequences the implementation must honour:

- The dashboard join form offers **HTTPS only**. A `postgres://` URL is reachable via
  the fallback but is not advertised in the teammate-facing UI.
- When the fallback is used, log a warning naming it as deprecated.
- Once a team is reachable over HTTPS, nothing should hand a teammate a pg URL again.

### 4.2 Steady state after joining is already HTTPS-only

Worth recording because it makes the win larger than the handshake alone: the joiner
needs no Postgres URL **after** the join either. `flip-to-team.ts:28` writes the marker
as `{ runtime: 'server', serverUrl }` and puts the key in `CredentialStore` — it never
persists a `databaseUrl`. `server-client.ts:216` builds its transport from
`serverBaseUrl` with `Authorization: Bearer` at line 384.

So with the HTTPS join path, a teammate's machine never holds a database credential at
any point in its lifecycle. The handshake was the only remaining place one was needed.

**Status of this claim: verified by exhaustive audit of the write paths, not by a live
run.** It is the strongest security claim in this document, so the evidence is listed
rather than asserted:

| Write path | Does it persist a DB credential? |
|---|---|
| `ProjectMarker` (`project-identity.ts:23-30`) | **No** — the type has no field for one (§8, invariant 2) |
| `flipToTeam` (`flip-to-team.ts:27-30`) | **No** — writes marker + `CredentialStore` only |
| `writeServerModeSettings` (`settings-writer.ts:13`) | **Would** write `MEMSMITH_SERVER_DATABASE_URL` — but has **zero call sites** |
| `CredentialStore` | Team API key only, keyed by teamId |
| `server-bootstrap.ts:161` | Writes `MEMSMITH_SERVER_URL` — an **HTTP** base URL |

The third row is the near-miss and the reason this table exists. `settings-writer.ts`
persists `MEMSMITH_SERVER_DATABASE_URL` into `~/.memsmith/settings.json`, and if it
were ever wired into the join path the claim above would be **false**. Today it is
unreachable — `grep` finds no call site, and `flip-to-team.ts:22-25` documents that it
is deliberately not invoked, keeping a `writeGlobalSettings` dep present purely as a
test spy to assert it stays uncalled.

**Therefore this is a live invariant with a loaded gun next to it.** The implementation
must add a test asserting `writeServerModeSettings` is not called on the join path
(§5), because a future change that wires it in would silently write a database password
to disk on every teammate's machine and nothing else would catch it.

### 4.3 Rig limitation — and why a second server alone is not enough

`deriveServerUrl` (`convert-context.ts:25-32`) resolves in this order:

1. `existingServerUrl` argument, if non-empty → **returned verbatim** (line 26).
2. host is `localhost`/`127.0.0.1` → `http://${host}:38879` — **port hard-coded**.
3. otherwise → `https://${host}` — **port dropped entirely**.

Two consequences for testing, and the second is the one that bites:

- The local rig cannot exercise the HTTPS path from a single server: branch 2 returns
  `:38879`, the very server the joiner is running.
- **Standing up a second server on another port does not fix it by itself.** Branch 2
  ignores the real port, so a second local server is unreachable unless
  `existingServerUrl` is threaded through explicitly (the code comment at line 30 says
  as much). An integration test that boots a second server and relies on
  `deriveServerUrl` will silently address the *first* one and report a false pass.

The implementation plan must therefore specify how `existingServerUrl` reaches
`deriveServerUrl` in the test rig. This is the same failure mode as the earlier "two
machines verified" claim in this project, which was really two projects on one server.

---

## 5. Testing

Unit (no live infrastructure):

- Transport selection: `https://` → HTTPS client; `postgres://` → pg client.
- **Cross-team refusal:** a key for team A sending `projectId` of an existing team-B
  project must not move or read it. This is the guard for §3.3.
- **All four reasons distinctly:** unknown / revoked / expired / teamless key each
  return `422` with their own message. This is the §2.1 property; if a change ever
  collapses them to a flat 401, these tests are what catches it.
- **Rate limit actually engages on an unauthenticated request.** The 11th attempt in
  the window returns `429` **with no `authContext` present** — this is the specific
  trap in §3.2: the existing limiter's `authContext` bypass would make the limit a
  silent no-op, and only a test that omits authentication catches it.
- **Rate limit buckets are independent:** attempts against one team's key do not
  exhaust another team's budget, and a bad-key IP bucket does not exhaust a valid
  team's.
- Idempotency: two identical register calls both return 200, one `projects` row.
- Ordering: on a non-200 from the remote, no local marker write and no credential
  cached (the §2.3 guarantee).
- Response shape: assert the 200 body contains no `password`, no `databaseUrl`, no
  `postgres://` substring.
- The response body for every failure path likewise contains no `postgres://`
  substring — an error message must not leak the connection string.
- **`writeServerModeSettings` is never called on the join path.** This is the guard for
  the §4.2 near-miss: that function writes `MEMSMITH_SERVER_DATABASE_URL` to
  `~/.memsmith/settings.json`, and wiring it into join would put a database password on
  every teammate's disk. `flipToTeam` already accepts a `writeGlobalSettings` dep
  purely so a spy can assert it stays uncalled — use it.

Integration (two servers, different ports, `existingServerUrl` threaded per §4.3):

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
  ~$50-100/mo. See §7.1 — AWS is **not** a prerequisite for building or testing this.
- **No per-user identity.** The joiner is still `LOCAL_OWNER_USER_ID` locally. Per-user
  identity is a later step in the agreed order.
- **No Incognito.** MemSmith's privacy toggle is unrelated to this work. (Noting it
  because "Incognito" and AWS "Cognito" were conflated earlier in this project.)
- **No sync-on-join.** Local observations stay local until the user chooses to share,
  per the agreed semantics. The banner offering that choice is a later step.

### 7.1 AWS is a deployment target, not the goal

Worth stating because it is easy to invert: this work is **not** being built in order to
test AWS. The deliverable is *a joining teammate needs only the team key, never a
database password* — which holds on a VPS, on Fly, or on a machine in an office.
AWS is simply where this team intends to run it. Reading it the other way would make an
AWS account a blocker for the whole piece of work, which it is not.

**When AWS access is actually required:**

| Stage | AWS needed? |
|---|---|
| HTTPS join route + HTTPS join client | No |
| Rate-limit subject-derivation middleware (§3.2) | No |
| Every unit test (§5) | No |
| Full integration test — real join over HTTPS | No — two local servers, §4.3 |
| Secrets Manager change itself (§6) | No — a task-definition JSON edit + an IAM grant |
| **Verify TLS terminates against a real cert** | **Yes** |
| **Verify ECS resolves `valueFrom` into the env** | **Yes** |

So AWS is needed only at the end, and only to **confirm** two things. Everything
functional is provable locally first.

**One seam this cannot close locally.** `deriveServerUrl` (`convert-context.ts:25-32`)
returns `https://${host}` with **no port** for a non-localhost host (branch 3), but the
local rig necessarily exercises `http` on a nonstandard port via `existingServerUrl`
(branch 1). **The URL-shaping branch used in production is not the branch the tests
exercise.** It is small and inspectable, but it is exactly the "verified locally,
differs in production" shape that produced false verification claims earlier in this
project — so the first action once AWS exists is a smoke check of branch 3, before
anything else is trusted.

---

## 8. Security invariants this preserves

1. The database password never leaves the server. Not in a response, not in a
   client, not in a marker file.
2. The team API key lives **only** in `CredentialStore`
   (`~/.memsmith/credentials.json`), keyed by teamId — **never** in
   `.memsmith/project.json`, which is committed to git and would put the credential
   in git history, every clone, CI, and the git host permanently.
   This is **structural, not conventional**: `ProjectMarker`
   (`project-identity.ts:23-30`) has no credential field to write one into —
   `projectId`, `teamId`, `note`, `runtime?`, `serverUrl?`, `databaseName?` — and the
   marker's own `note` says so. Adding such a field would break this invariant, so
   don't.
3. `teamId` is always derived from the presented credential, never from a request.
4. `projectId` from the body is accepted at exactly one route, for creation only,
   always inside the authenticated key's own team, with a regression test pinning it.
5. The marker is never flipped before the credential resolves (§2.3).
