# MemSmith Server (Beta)

MemSmith Server is the beta server runtime for MemSmith 13. It is a
Postgres-backed, BullMQ-driven, API-key-authenticated runtime that replaces
the legacy `memsmith worker` for deployable use cases.

## Architecture

```
                +-------------------+
                |  Hooks / SDK / MCP|
                |    (clients)      |
                +---------+---------+
                          |  HTTPS / Bearer API key
                          v
+-----------------+  +----+---------+   +-------------------+
|    Postgres     |<-+ memsmith-  +-->+      Valkey       |
| (canonical      |  |   server      |   | (BullMQ queue,   |
|  storage:       |  | --daemon      |   |  noeviction,     |
|  events,        |  | HTTP only,    |   |  appendonly yes) |
|  observations,  |  | no generation |   +---------+---------+
|  jobs, sessions,|  +-------+-------+             ^
|  api_keys)      |          | enqueue              | poll
+--------^--------+          |                      |
         |                   v                      |
         |          +-----------------+             |
         +----------+ memsmith-     +-------------+
            read    |  worker (Nx)    |  consume jobs
            write   | server worker   |  call provider
                    |  start          |
                    +-----------------+
```

The HTTP service and the BullMQ generation worker run from the **same image
and same codebase**, but are split into separate processes / containers so
that:

1. Long-running provider calls cannot block HTTP responsiveness.
2. Generation can scale horizontally (`docker compose up --scale memsmith-worker=N`).
3. Restarting the HTTP server does not lose enqueued generation work — jobs
   live in Valkey, persisted by AOF.

The legacy `memsmith worker` runtime is **not** spawned in Docker. The
container entrypoint runs `bun server-service.cjs --daemon` (or
`worker start`) and never `bun worker-service.cjs`.

## Required environment variables

`validateServerBetaEnv()` runs at startup and refuses to boot when any of
the following are missing or invalid in Docker:

| Variable                          | Required | Notes                                                        |
|-----------------------------------|----------|--------------------------------------------------------------|
| `MEMSMITH_RUNTIME`              | Docker   | Must be `server-beta` in Docker (warned otherwise).          |
| `MEMSMITH_QUEUE_ENGINE`         | Docker   | Must be `bullmq`. In-process queues are rejected in Docker.  |
| `MEMSMITH_SERVER_DATABASE_URL`  | Always   | Postgres connection string. Fails fast at startup.           |
| `MEMSMITH_REDIS_URL`            | bullmq   | Required when queue engine is `bullmq`.                      |
| `MEMSMITH_AUTH_MODE`            | Always   | Must NOT be `local-dev` in Docker.                           |
| `MEMSMITH_ALLOW_LOCAL_DEV_BYPASS` | Docker | Must NOT be `1`/`true` in Docker.                            |
| `MEMSMITH_GENERATION_DISABLED`  | Optional | Set to `true` on the HTTP service when running a separate worker. |
| `MEMSMITH_SERVER_PROVIDER`      | Worker   | One of `claude`, `gemini`, `openrouter`. Worker only.        |
| `ANTHROPIC_API_KEY` (or alt)      | Worker   | Required by the chosen provider.                             |

Local development can still use SQLite + `local-dev` auth bypass **outside
Docker only**. Deployable mode must use the table above.

## Generation worker mode (`memsmith server worker start`)

The same image runs the generation worker via:

```sh
memsmith server worker start
```

This starts a process that:

* Connects to Postgres and Valkey using the same configuration as the HTTP
  service.
* Attaches BullMQ Workers to the `event` and `summary` queues.
* Never opens an HTTP listener.
* Blocks in the foreground (good for `docker run`, `kubectl run`, systemd).
* Forces generation enabled even if `MEMSMITH_GENERATION_DISABLED=true`
  is inherited from the shared compose file. The worker IS the generation
  process.

In Compose this is the `memsmith-worker` service. Scale it horizontally:

```sh
docker compose up -d --scale memsmith-worker=4
```

BullMQ guarantees only one worker processes a given job at a time; the
provider call inside `ProviderObservationGenerator.process` is idempotent
on the `job.id` (`evt_<sha256>` / `sum_<sha256>`) so retries cannot
duplicate observations.

## Auth in production

```sh
MEMSMITH_AUTH_MODE=api-key
```

API keys are created with:

```sh
memsmith server api-key create \
  --name "ci"                  \
  --scope memories:read,memories:write
```

The raw key is shown **once**; only a SHA-256 hash is stored in Postgres
(`api_keys.key_hash`). Revoke with:

```sh
memsmith server api-key revoke <id>
```

Revocation is enforced on every request because `requirePostgresServerAuth`
reloads the row by hash on each call. There is no in-memory cache to
poison.

> **Do not enable `MEMSMITH_AUTH_MODE=local-dev` in Docker.** The
> loopback bypass relies on the request originating from `127.0.0.1` on
> the HTTP listener, which is not a meaningful boundary inside a
> container. The startup validator refuses to boot with this combination
> and returns a non-zero exit code.

## Compose stack

`docker-compose.yml` ships four services:

* `postgres` — canonical storage. Schema is bootstrapped at startup by
  `bootstrapServerBetaPostgresSchema()`.
* `valkey` — BullMQ queue, configured with `appendonly yes`,
  `appendfsync everysec`, `maxmemory-policy noeviction`.
* `memsmith-server` — HTTP runtime.
  `MEMSMITH_GENERATION_DISABLED=true` so the BullMQ Worker is **not**
  attached here.
* `memsmith-worker` — generation worker. Scale horizontally.

Bring it up:

```sh
docker compose up -d --build
```

Tear it down (and wipe data):

```sh
docker compose down -v
```

## End-to-end test

`scripts/e2e-server-docker.sh` brings up the full stack and verifies:

* `POST /v1/events?wait=true` returns a `generationJob` descriptor.
* Restart of `memsmith-server` and `memsmith-worker` mid-stream does
  not lose data.
* Revoking an API key denies subsequent reads and writes (401/403).
* No `worker-service.cjs` process runs in any container.
* `MEMSMITH_AUTH_MODE=local-dev` is rejected inside Docker.
