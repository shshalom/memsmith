# Team-Mode Rig Scripts

This directory contains scripts to bring up and tear down a throwaway, isolated team-mode MemSmith server for testing and proofs.

## Prerequisites

- **Colima** (or Docker Desktop with compatible Docker CLI)
- **Node.js** (for running preflight and server scripts)
- **bash** (both scripts are bash)

## Isolation Guarantees

The rig is **completely isolated** from the dogfood (your local development instance). Specifically:

- **Data Directory**: Throwaway server stores data in `/tmp/ms-team-server` (override with `RIG_DATA_DIR`), never in `~/.memsmith` (the dogfood).
- **Database**: Throwaway Postgres runs on port `:55440` (override with `RIG_PG_PORT`), never `:55433` (the dogfood embedded PG).
- **HTTP Port**: Throwaway server listens on `:38890` (override with `RIG_HTTP_PORT`), never `:38879` (the dogfood server).
- **Preflight Guard**: `team-up.sh` calls `preflight.mjs` to verify these constraints before bringing anything up. If any env var would target the dogfood, the script refuses and exits with status 1. `team-down.sh` does not run the preflight — it only calls `docker compose down -v`, which drops the throwaway compose volume and never touches the dogfood.

## Full Run Order

### 1. Bring Up the Rig

```bash
./scripts/rig/team-up.sh
```

This script:
- Calls `node scripts/rig/preflight.mjs` to verify the rig target is safe (not dogfood).
- Ensures Colima is running (`colima start` if needed).
- Brings up the Docker Postgres service with pgvector on `:55440` (throwaway volume, reset on teardown).
- Prints the exact `!`-launch command for the user to start the team server.

**Default Environment:**
- `RIG_DATA_DIR=/tmp/ms-team-server`
- `RIG_PG_PORT=55440`
- `RIG_HTTP_PORT=38890`
- `RIG_PG_USER=memsmith`
- `RIG_PG_PASSWORD=rig-throwaway`
- `RIG_PG_DB=memsmith`

Override any of these before calling `./scripts/rig/team-up.sh`:

```bash
RIG_DATA_DIR=/custom/path RIG_HTTP_PORT=39000 ./scripts/rig/team-up.sh
```

### 2. User Starts the Team Server

After `team-up.sh` completes, the user (!-launches — agents cannot due to the mise shim) the team server with the printed command. The command will be:

```bash
! MEMSMITH_RUNTIME=server \
  MEMSMITH_SERVER_DATABASE_URL="postgres://memsmith:rig-throwaway@127.0.0.1:55440/memsmith" \
  MEMSMITH_IDENTITY_PROVIDER=better-auth \
  MEMSMITH_QUEUE_ENGINE=inline \
  MEMSMITH_DATA_DIR="/tmp/ms-team-server" \
  MEMSMITH_SERVER_PORT=38890 \
  npx memsmith server start
```

The team server is now running and ready to test proofs.

### 3. Run Proofs

The rig is now ready for end-to-end testing. Connect to the team server and exercise the proof scenarios.

### 4. Tear Down the Rig

```bash
./scripts/rig/team-down.sh
```

This script:
- Runs `docker compose down -v` to drop the throwaway Postgres container and its volume (data is discarded).
- Looks for the team server PID file (at `${RIG_DATA_DIR}/.server-beta.pid`) and prints the PID so the user can kill the server.
- Confirms that the dogfood is untouched.

If the team server is still running, you'll need to kill it manually:

```bash
! kill <PID>
```

## Preflight Guard

The `preflight.mjs` utility enforces dogfood isolation. It refuses to proceed if:

- `--data-dir` resolves to `~/.memsmith`
- `--db-url` targets port `:55433` (the dogfood embedded PG)
- `--http-port` is `:38879` (the dogfood server port)

If any constraint is violated, the script prints a refusal message and exits with status 1.

**Usage:**

```bash
node scripts/rig/preflight.mjs --data-dir <dir> --db-url <url> --http-port <port>
```

On success, prints `[rig-preflight] OK — target is not the dogfood.` and exits with status 0.

## Environment Variables Reference

All `RIG_*` vars are optional and have sensible throwaway defaults. Set them before running `team-up.sh` to customize:

| Variable | Default | Purpose |
|----------|---------|---------|
| `RIG_DATA_DIR` | `/tmp/ms-team-server` | Data directory for the throwaway server |
| `RIG_PG_PORT` | `55440` | Postgres port (must differ from `:55433` dogfood) |
| `RIG_HTTP_PORT` | `38890` | Server HTTP port (must differ from `:38879` dogfood) |
| `RIG_PG_USER` | `memsmith` | Postgres user |
| `RIG_PG_PASSWORD` | `rig-throwaway` | Postgres password |
| `RIG_PG_DB` | `memsmith` | Database name |

The `RIG_DB_URL` is derived from the above and passed to the team server.

## Notes

- **No unit tests**: These scripts are integration/shell utilities tested live during the proof phase.
- **Idempotent Colima**: `team-up.sh` only starts Colima if it's not already running.
- **Dogfood is never touched**: The preflight guard is a hard requirement before any Docker/Colima operations.
