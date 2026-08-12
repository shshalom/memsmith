# Local Generation for Team Mode — Design

**Goal:** In team mode, observation generation runs on the developer's own machine. The
server stores and embeds finished observations and never calls an LLM.

**Status:** Design written 2026-08-11. Every load-bearing claim below was verified against
current code before writing; the evidence is cited inline as `file:line`.

---

## 1. Why

Two reasons, both the user's, recorded 2026-08-08:

1. **Cost.** Generation is the expensive step. Running it on each developer's machine keeps
   the server doing only storage and embedding, which is what the AWS right-sizing work
   assumed.
2. **Ollama was always meant to be shared between local and team use.** The generation
   provider is a local resource; team mode should use it, not replace it with a server-side
   LLM call.

## 2. What is actually broken today

The parked checkpoint said *"in team mode no local server runs at all."* **That is wrong**,
and the correction matters because it makes the fix smaller.

`SessionStart` runs `server-service start` unconditionally for every project, regardless of
runtime. `resolveStartAction` (`src/server/runtime/ServerService.ts`) then picks:

```ts
if (input.hasRunningServer) return 'reuse';
if (input.wantsDaemon || input.isLocal) return 'daemon';
return 'foreground';            // ← team mode lands here
```

`'foreground'` calls `runServerForeground`, which calls `createServerService()`, which
**hard-requires** two env vars (`src/server/runtime/create-server-service.ts:151-158`):

- `MEMSMITH_SERVER_DATABASE_URL` — a Postgres connection string
- `MEMSMITH_REDIS_URL` — BullMQ needs Redis/Valkey

A teammate's laptop has neither. So the accurate statement is:

> **In team mode the laptop attempts to start a FULL SERVER (Postgres + Redis) instead of a
> generation-only loop, and that attempt fails.**

### What happens to the events instead

The first draft of this spec claimed *"events sit there as raw events."* **That is wrong**,
and the correction changes the scope of the work.

`POST /v1/events` (`ServerV1PostgresRoutes.ts:334`) routes to `IngestEventsService`, which by
its own header comment centralizes *"the transactional write (event row + outbox row +
lifecycle log) and the post-commit BullMQ enqueue."* So a team-mode event **does** create an
outbox row and **does** get enqueued for generation server-side.

And generation is **enabled by default** on a server: `create-server-service.ts:230-231` only
disables it when `MEMSMITH_GENERATION_DISABLED` is `1`/`true`, and
`ActiveServerGenerationWorkerManager.start()` is called otherwise (`:257-258`).

So the true statement of today's behavior is:

> **Team-mode events are enqueued for SERVER-SIDE generation. Whether they are actually
> generated depends on the deployment's env.** The documented AWS topology
> (`docs/deploy/aws.md:210`, `:378`) sets `MEMSMITH_GENERATION_DISABLED=true` on the HTTP task
> and expects a separate `memsmith server worker start` task to consume the queues.

**VERIFIED against live AWS, 2026-08-11** (account `191421492724`, `us-west-2`):

| Check | Finding |
|---|---|
| ECS services in cluster `memsmith` | **one** (`memsmith`) — there is NO separate worker task |
| `MEMSMITH_GENERATION_DISABLED` on task def `memsmith:6` | **`"true"`** |
| `/v1/info` → `boundaries.generationWorkerManager.status` | **`disabled`** |
| `/v1/info` → `generation.providerReachable` | **`false`** |
| `/v1/info` → `generation.queued` | **`0`** |

So the live server enqueues nothing and generates nothing, and **no backlog has
accumulated**. Three consequences, all simplifying:

1. **There is no server-side LLM cost to stop.** Fargate already does storage and embedding
   only.
2. **There is no migration.** `queued: 0` means this work is purely "redirect new events" —
   no drain task, no backfill.
3. **`generate=false` is belt-and-braces, not load-bearing.** With generation disabled
   server-side, an event posted without the flag would not generate anyway. Still set it:
   the flag is an *explicit* contract, whereas the current behavior depends on a deployment
   env var someone could flip. But it downgrades the duplicate-generation risk in §7 from
   real to hypothetical.

**Follow-up noted, not scoped here:** `/v1/info` reports this server's generation as
`stalled` with *"generation provider is unreachable"*. For a team server under this design
that is the INTENDED state, not a fault. Reporting a healthy configuration as `stalled`
trains operators to ignore the indicator — the exact failure the health check was built to
prevent. A team server should report something like "generation delegated to clients".

### `?generate=false` already exists — use it

The second review pass found a supported server contract the first draft missed.
`ServerClient.recordEvent` already sends `/v1/events?generate=false` when
`input.generate === false` (`src/services/hooks/server-client.ts:228`), and the route honours
it (`ServerV1PostgresRoutes.ts:340`): with `generate=false` the event row is still written but
`outbox` stays `null` and `enqueueState` is `'skipped'` — **no outbox row, no BullMQ enqueue**.

This is materially better than the first draft's plan of "stop posting the raw event":

- The **event row still reaches the server**, so the team keeps a shared record of what
  happened, and a future server-side backfill remains possible.
- **No server-side generation is triggered**, which is the actual goal.
- It is an existing, supported contract — no new endpoint, no schema change, and it cannot
  strand the events the way "don't post at all" would.

**Revision to §3:** a team-mode hook does **not** stop posting. It posts with
`generate: false` AND enqueues locally for generation. The two are complementary: the server
gets the raw event for the record, the laptop generates the observation.

### There are FIVE event-posting call sites, not one

`recordEvent` is called from `observation.ts`, `summarize.ts`, `session-init.ts`,
`file-edit.ts`, and `mcp-server.ts`. The first draft discussed only `observation.ts`. Any
call site left un-redirected keeps enqueueing server-side generation, which would leave the
cost problem half-solved and produce a confusing split where some observation types generate
remotely and others locally.

**Decision: set `generate: false` centrally, not per call site.** The team-mode decision
belongs in one place — `ServerClient.recordEvent` — defaulted by runtime, so a sixth call site
added later inherits the correct behavior rather than silently reintroducing server-side
generation. Per-call-site flags are how this regresses.

## 3. Chosen shape

```
                       ┌──▶ POST /v1/events?generate=false ──HTTPS──▶ event row stored,
                       │                                              NO outbox, NO enqueue
team-mode hook ──▶ event
                       │
                       └──▶ local generation queue (file, durable, bounded)
                                   │
                                   ▼  drained by a local generation loop
                     generate(event) ──▶ Ollama  (ensureOllamaRunning)
                                   │
                                   ▼  finished observation
                       POST /v1/memories  ──HTTPS──▶  server stores + embeds
```

The server's role shrinks to storage, embedding, and search. It never calls an LLM.

**Both arms matter.** The event still reaches the server so the team keeps a shared record of
what happened and a future server-side backfill stays possible; `generate=false` ensures it
does not trigger server-side generation. The laptop separately generates the observation and
posts the finished result. See "`?generate=false` already exists" in §2.

### Why this shape and not the alternatives

Three shapes were considered across two sessions. Two are ruled out by verified facts:

| Shape | Verdict | Reason (verified) |
|---|---|---|
| **A** — server-owned job queue; laptops claim/lease/submit over HTTP | Rejected | Needs a claim protocol, lease expiry, and crash recovery. Unnecessary: the laptop already holds the events, so it needs no permission to work on them. |
| **C** — run `memsmith server worker start` on the laptop against AWS | Ruled out | `runServerGenerationWorker` (`ServerService.ts:1046`) calls `createServerService`, which requires `MEMSMITH_SERVER_DATABASE_URL` + `MEMSMITH_REDIS_URL`. That means opening RDS:5432 and Redis:6379 to laptops and handing teammates a **database credential** — the exact thing join-over-HTTPS was built to eliminate. |
| **B** — generate locally, post the finished observation | **Chosen** | Reuses the existing local spool, the existing generator, and the existing `/v1/memories` write path. |

**A correction to an earlier framing.** Shape B was previously split into "B1 (local queue,
needs Postgres)" and "B2 (inline in the hook, no queue)". Both premises were wrong:

- B1 does **not** need Postgres. A durable file-based local queue already exists — see §4.1.
- B2 cannot work. A real observation takes 20-60s on a local model
  (`generation-health.ts:22`), and hooks are short-lived processes. Inline generation would
  either block the user's tool call or spawn a detached worker, which is a queue with extra
  steps.

So there is no fork. There is one implementable shape.

## 4. Components — what exists vs what is new

### 4.1 The local spool — EXISTS, no database

`src/cli/handlers/capture-spool.ts` already provides a bounded, durable, file-based queue:

- `MAX_SPOOL_ENTRIES = 5_000` with `TRIM_SLACK = 500` — bounded so an extended outage cannot
  fill the disk
- `spoolEvent(path, event)`, `readSpooledEvents(path)`, `clearSpool(path)`
- Already drained at session start by `src/cli/handlers/spool-flush.ts` →
  `flushSpooledEvents`, called from `session-init.ts:185`

It was built for a different reason (events were dropped entirely when the server was down)
but it is exactly the durable local buffer this design needs, and it needs **no Postgres**.
This removes the only real objection to keeping a local queue.

**Two changes are required to reuse it, and neither is cosmetic:**

1. **It is currently a FAILURE path, not a normal path.** `observation.ts:109-122` posts the
   raw event to the server first and spools only when that call fails and the error
   `isFallbackEligible()`. Team mode must enqueue locally on the *happy* path — in addition
   to posting with `generate=false`, per §3, not instead of posting.
2. **Its drain currently forwards raw events to the server** (`spool-flush.ts` →
   `flushSpooledEvents`, called from `session-init.ts:185`). That is the correct behavior for
   its original purpose and the WRONG behavior here — it would ship the raw event to the
   server unprocessed, which is what this design exists to avoid.

**Decision: use a SEPARATE queue file, not the existing spool path.** Reuse the
`capture-spool` module (its bounding, trimming, and corrupt-file tolerance are exactly right)
but point the generation queue at its own file. Overloading one file with two drains that
must behave differently — forward-raw vs generate-then-post — is how a subtle
"events silently shipped unprocessed" bug gets built. Same code, separate instance.

### 4.2 The generator — EXISTS, but coupled to the job queue

`ProviderObservationGenerator` takes its pool as an **injected dependency**
(`ProviderObservationGenerator.ts:67`), so generation itself does not care where the pool
points. But the class touches the pool in exactly two places, and both are **job-queue
bookkeeping, not generation**:

| Call site | Purpose | Applies on a laptop? |
|---|---|---|
| `loadCanonicalOutbox` (`:402`) | Re-reads the outbox row as the authoritative scope source, as a BullMQ-payload tampering detector | **No** — there is no local outbox row |
| `isApiKeyRevoked` (`:464`) | `SELECT revoked_at, expires_at FROM api_keys WHERE id = $1` | **No** — there is no local `api_keys` table |

This is the one genuine seam in the design. The generation core must be usable without a
pool.

**Decision: extract, do not nullable.** Introduce a narrow interface for the
generate-one-event path and have the existing job-queue class compose it. Making `pool`
optional and threading null checks through a 500-line class is how that class of change
rots, and it would leave the tampering-detector logic in a state where "no row" and "row
missing" are indistinguishable.

### 4.3 The local generation loop — NEW

The only genuinely new component. Responsibilities:

1. Read spooled events for team-mode projects.
2. For each, call the extracted generation core (which calls `ensureOllamaRunning` then
   Ollama).
3. `POST /v1/memories` with the finished observation.
4. On success remove the entry; on failure leave it spooled for the next drain.

It must run **outside the hook process** — see §6.

### 4.4 The write path — EXISTS, with two gaps

`POST /v1/memories` (`ServerV1PostgresRoutes.ts:967`) is the correct target. Verified
properties:

- Auth: `writeAuth, requireWriteRole()` — a team key with write role suffices. **No database
  credential.**
- Embeds on write: `const embeddingVec = await embedForPersist(body.content)` at `:983`,
  computed before `repo.create` so a cold model load never holds the insert open.
- The route comment states the contract precisely: *"direct/manual observation insertion…
  MUST NOT call generator and MUST NOT create outbox rows."* Exactly what this design wants.

**Gap 1 — the request schema cannot carry a generated observation's shape.** Verified at
`:968-974`, the accepted body is:

```ts
{ projectId, serverSessionId?, kind?, content, metadata?, idempotencyKey? }
```

There is **no `obsType` and no `quality` field**, and `kind` defaults to `'manual'`. Yet the
repository *does* accept both (`src/storage/postgres/observations.ts:165-168`, persisted at
`:192-195`). So today a locally generated observation would land as `kind='manual'` with a
null `quality` — indistinguishable from a hand-written note, and invisible to any
quality-based filtering.

**Gap 2 — the team quality bar would stop applying.** The per-team `qualityFloor`
(default 20, `src/server/settings/settingKeys.ts:63`) is enforced today *inside* server-side
generation: `processGeneratedResponse.ts:128` resolves it by `teamId` and drops sub-floor
observations. Under this design generation no longer happens on the server, so nothing
applies the floor.

## 5. Quality enforcement — server-side at ingest

**Decision: score and gate on ingest, server-side. Do not trust a client-supplied score.**

This follows the user's standing ruling that team-wide settings are core behavior, not
per-user preferences. If each laptop applied its own floor from its own env var, the same
event could be kept on one machine and dropped on another, and the team's bar would become
advisory.

Verified feasible: `scoreObservation` (`src/server/generation/quality.ts:7-13`) is a **pure
function** over `{ obsType, facts, narrative, title, concepts }` — no pool, no I/O. It can
run inside the route handler.

Rules:

1. The client MAY send `obsType` and the structured fields; it MUST NOT send `quality`.
2. The server computes `quality = scoreObservation(...)` from the submitted fields.
3. The server resolves the team's `qualityFloor` by `teamId` and rejects sub-floor
   submissions with `422`, mirroring the drop that generation performs today.
4. The computed score is persisted via the repository's existing `quality` field.

This keeps one team-wide bar, enforced in one place, regardless of how many laptops submit.

### Two constraints the implementation must respect

**`scoreObservation` needs the STRUCTURED fields, not just `content`.** Its inputs are
`{ obsType, facts, narrative, title, concepts }` (`quality.ts:7-13`) and its points come from
`facts.length`, `narrative.length`, and `concepts.length` (`:15-20`). The server-side path
scores the *parsed* observation before flattening it to text
(`processGeneratedResponse.ts:123-126`). Therefore the client must submit those fields — they
travel in `metadata`, which the route already accepts as
`z.record(z.string(), z.unknown())`. Scoring only the flattened `content` string would score
every submission near zero and reject everything. **This is the single most likely way to get
this wrong.**

**`settingsResolver` is OPTIONAL on the routes class** (`ServerV1PostgresRoutes.ts:122`,
guarded at `:1402`). When it is absent — as in tests and any caller that did not wire it —
there is no per-team floor available. Behavior when absent: fall back to the env default
(`MEMSMITH_QUALITY_FLOOR`, default 20), exactly as `processGeneratedResponse.ts:128-129`
already does. Do **not** skip the gate when the resolver is missing; that would make the bar
silently disappear in any deployment that omitted it.

## 6. Where the loop runs

The generation loop must **not** run inside a hook process. Hooks are short-lived and a
20-60s generation would block the user's tool call.

**Decision: a detached background process, started by the same `SessionStart` path that
already starts the server, selected by runtime.**

The branch point already exists — `runRuntimeForeground` picks by `selectRuntime(cwd)`:

```ts
if (pick(cwd) === 'local') { await startLocal(); return; }
await startServer(port, host);          // ← team mode: currently fails, needs DB + Redis
```

Team mode should take a third path: start the **local generation loop**, not a full server.
This is the smallest correct change — it replaces a call that cannot succeed on a laptop with
one that can.

## 7. Failure handling

Inherits the project's established asymmetry: capture failures are durable and retried;
retrieval failures fail open.

| Failure | Behavior |
|---|---|
| Ollama down | `ensureOllamaRunning` (`OllamaObservationProvider.ts:65`) restarts it at point of use, single-flighted with backoff. No new code. |
| Ollama unrecoverable | Event stays spooled; retried on the next drain. Never dropped silently. |
| Server unreachable when posting | Event stays spooled. Same durability the spool already provides. |
| Spool full (5,000 entries) | Existing trim behavior applies; the bound exists so an extended outage cannot fill the disk. |
| Observation scores below the team floor | Server rejects `422`. The event is consumed, not retried — a low-signal observation is a correct drop, matching today's behavior. |
| Laptop never generates (machine off) | The event is never observed. **Accepted limitation — see §9.** |
| A client posts without `generate=false` | The server enqueues its own generation for that event, and if the laptop also generates it, the observation is produced TWICE. Prevented by defaulting the flag centrally in `ServerClient.recordEvent` (§2) rather than per call site; a regression test must assert that a team-mode `recordEvent` sends `generate=false`. |

## 8. Testing

- **Unit** — the extracted generation core produces an observation from an event with no
  pool; `ensureOllamaRunning` is called before the provider; a provider failure leaves the
  spool entry intact.
- **Unit** — ingest scoring: `quality` is computed server-side; a client-supplied `quality`
  is ignored; sub-floor submissions are rejected `422`; at-or-above-floor are persisted with
  the computed score.
- **Integration** — spool → generate → `POST /v1/memories` → row present with the right
  `kind`, `obsType`, non-null `quality`, and a non-null embedding.
- **Live** — a team-mode project on the laptop produces an observation in AWS with no
  database credential present and no VPN.
- **Mutation** — every new test must be shown to fail against the unfixed code. Four fixtures
  in this project's history could not distinguish pass from fail; assume nothing is covered
  until a mutation proves it.

## 9. Accepted limitations

State them rather than discover them later.

1. **Per-laptop backlog is invisible to the team.** The generation-health check reads the
   *server's* job counts. Under this design the backlog lives on each laptop, so a teammate
   whose Ollama has been dead for a week shows as `idle` to everyone else. This is the
   15-hour incident, per-person. Not solved here; needs a health surface that reports
   client-side state.
2. **Observation quality varies by whoever's model generated it.** A teammate on a small
   local model produces weaker observations than one on a large model. The ingest floor
   catches the worst, but the team's memory is only as good as its weakest generator.
3. **An event whose machine never generates is lost to the team.** The spool is local, so it
   is not recoverable from the server side.

## 10. Out of scope

- Client-side health reporting for per-laptop backlogs (limitation 1).
- Changing which model teammates run.
- The untested join client half and multi-teammate sharing — separate work, tracked
  independently.
