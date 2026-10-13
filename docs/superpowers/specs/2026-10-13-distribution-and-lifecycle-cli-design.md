# Distribution and lifecycle CLI — design

**Status:** approved on 2026-10-13, revised after a code-verified review.
**Branch:** `feat/distribution-lifecycle-cli`

## Goal

MemSmith is open source. Teams need to install it with one command and manage it
with one command, so they can start using it and contributing to it.

Success means:

- `npx memsmith install` works on a machine that has never seen the repo.
- `memsmith start`, `stop`, `restart`, `status`, and `doctor` work from any
  directory and act on the MemSmith server on this machine.
- `memsmith doctor --fix` repairs the failures that new users already hit.

## Current state

| Problem | Evidence |
| --- | --- |
| `memsmith` is not on npm. | `npm view memsmith` returns `404`. `npx memsmith` works only inside the repo, where npm resolves the project's own `bin`. |
| The README says MemSmith is on npm. | `README.md:48`. |
| The publish workflow never ran. | `.github/workflows/npm-publish.yml` triggers on `v*` tags. The local repo has tags through `v13.10.1`; `git ls-remote --tags origin` lists none. |
| The publish workflow would fail. | It runs `npm run smoke:clean-room`, which `package.json` does not define. It uses Node 20, which ships npm 10; trusted publishing needs npm 11.5.1 or later. |
| Top-level lifecycle commands are broken. | `memsmith start|stop|restart|status` and `memsmith worker ...` call `plugin/scripts/worker-service.cjs` (`src/npx-cli/commands/runtime.ts:68`). That script no longer ships; only `server-service.cjs` does. |
| `memsmith server start` blocks in the `server` runtime. | `runServerStartCommand` passes `start` without `--daemon`. `server-service start` auto-detaches only in the `local` runtime (`ServerService.ts:705-722`). |
| `start --daemon` returns before the server is up. | It prints `{"status":"starting","pid":…}` and exits (`ServerService.ts:701-729`). |
| `stop` can report success while the server still runs. | It sends `SIGTERM`, waits 5 seconds, never escalates, then removes state and prints `Server stopped` (`ServerService.ts:736-747`). |
| `status` disagrees with `start` about "running". | `status` trusts only the PID file and always exits 0. `start` also treats a listener on the port as running (`findRunningServer`, `ServerService.ts:1424`). |
| Installer auto-start runs a command that does not exist. | `install.ts:1701-1731` runs `worker-service.cjs local start`. Its fallback messages at `:1695` and `:1722` point at `server start` and `local start`. |
| `doctor` checks the wrong process. | It probes `MEMSMITH_WORKER_PORT` and labels the result "Worker daemon" (`doctor.ts:93-104`). |
| Stopping the server leaves embedded Postgres running. | Daemon shutdown never stops Postgres (`ServerService.ts:804-808`). |
| Postgres cannot be stopped from another process. | `EmbeddedPostgresManager.stop()` only stops an in-process instance (`EmbeddedPostgresManager.ts:226-235`). From a new process it only deletes `local-pg.pid`, and the next start fails its port guard. |
| The documented `memsmith local` CLI is unreachable and buggy. | `CLAUDE.md:30` documents it. `src/services/local-runtime-cli.ts` has no callers outside tests, and its `local-stop` has the bug above. |
| A test enforces the broken routing. | `tests/npx-cli-server-namespace.test.ts` asserts on source strings, including the worker lifecycle routing. |

The npm tarball is small: `npm pack --dry-run` reports 3.0 MB packed, 7.5 MB
unpacked, 113 files. `install` copies the plugin from the package root
(`install.ts:640-670`), so installing from the tarball works. The 946 MB footprint
comes from dependency installs during `memsmith install`.

## Out of scope

- Install footprint and speed.
- Contributor onboarding (clone to linked dev build).
- Changelog or release-PR automation, and an npm organization.
- `adopt`, `cleanup`, and the `transcript watch` fallback. They also call the
  missing `worker-service.cjs` (`runtime.ts:142`, `:155`, `:248`). This change
  leaves them and their helper, `spawnBunWorkerCommand`, untouched; they need
  their own fix.
- Managing a remote team server. When `MEMSMITH_SERVER_URL` points at a
  non-loopback host, lifecycle commands print that the server is remote and
  exit 1.

## Decisions

- **Package name:** `memsmith`, unscoped.
- **Release flow:** a one-time manual publish claims the name. After that, a `v*`
  tag publishes from GitHub Actions through npm trusted publishing (OIDC) with
  provenance. No long-lived `NPM_TOKEN`.
- **CLI shape:** top-level lifecycle commands act on the local server. `server`
  and `worker` stay as aliases.
- **Doctor:** `--fix` is included, limited to three repairs.

## Design

### 1. Distribution

**Maintainer steps, done once by hand.** These publish to a public registry, so
this change does not automate them.

1. From a clean build whose version matches `package.json`, run `npm publish`.
2. On npmjs.com, add a trusted publisher for repository `shshalom/memsmith` and
   workflow `npm-publish.yml`.

**`npm-publish.yml`:**

- Add `permissions: { contents: read, id-token: write }`.
- Add a step `npm install -g npm@^11.5.1` after `setup-node`. Node stays at 20 to
  match `engines`.
- Add a step that fails unless the tag, without its `v` prefix, equals
  `package.json` `version`.
- Keep `npm run build`, then `npm run smoke:clean-room`.
- Run `npm publish --provenance`. Remove `NODE_AUTH_TOKEN`.
- Add `workflow_dispatch` with a `dry_run` input that runs every step except
  `npm publish`, so the gate can run without a release.

**`README.md`:**

- Make `npx memsmith install` the primary install path. Keep the `/plugin`
  marketplace steps as the alternative.
- Replace the note at line 48: `npm install -g memsmith` installs the CLI only;
  `memsmith install` registers the plugin.
- Add a "Manage the server" section that lists `start`, `stop [--all]`,
  `restart`, `status`, and `doctor [--fix]`.

**Releasing.** Push a `v*` tag that matches `package.json`. The `ms-version-bump`
skill creates the tag; it must also be pushed.

### 2. Server address

All lifecycle commands and `doctor` resolve the server address the same way:
host and port from the `MEMSMITH_SERVER_URL` setting. Its default already derives
from `MEMSMITH_SERVER_PORT` and the UID (`SettingsDefaultsManager.ts:235`). When
the CLI spawns `server-service.cjs`, it passes that port as
`MEMSMITH_SERVER_PORT`, so the CLI and the daemon agree. A non-loopback host is
remote (see Out of scope).

### 3. Lifecycle CLI

| Command | Behavior |
| --- | --- |
| `memsmith start [--timeout <s>]` | If the server already answers, print its status and exit 0. Otherwise run `server-service.cjs start --daemon`, read the daemon PID from its JSON output, and poll `GET /api/health` every 500 ms until the response has `initialized: true`. A `503` with `status: "degraded"` counts as started, with a warning. Default timeout: 300 seconds, because a first start downloads Postgres binaries and runs `initdb`. |
| `memsmith stop [--all]` | Run `server-service.cjs stop`. Then confirm the port is free. With `--all`, also stop embedded Postgres (section 4). |
| `memsmith restart` | `stop`, then `start`, with the same waits. |
| `memsmith status` | Print state, PID, port, runtime, version, plugin version, dashboard URL, and, in the `local` runtime, embedded Postgres state. Exit 0 when running, 1 when not. |
| `memsmith server start\|stop\|restart\|status` | Aliases for the commands above. |
| `memsmith worker start\|stop\|restart\|status` | Aliases kept for existing scripts. Help text calls them deprecated. |

**`start` timeout.** Send `SIGTERM` to the daemon PID from the JSON output, then
`SIGKILL` after 10 seconds if needed. Print the daemon log path and exit 1. The
daemon writes its PID file only after `listen()`, so killing it by the spawned
PID is the only way to avoid an orphan that `stop` cannot find.

**`stop` escalation.** `server-service.cjs stop` gains a `SIGKILL` after its
5-second wait. If the process is still alive after that, it keeps the state
files, prints an error, and exits 1. It prints `Server stopped` only after the
process exits.

**`status` definition of running.** `status` uses `findRunningServer`, the same
check `start` uses, so a live listener without a PID file counts as running.
Details come from `/api/health`: `version`, `pid`, and `initialized`. The CLI
adds the plugin version, the dashboard URL, and the Postgres state. The runtime
comes from `selectRuntime`, evaluated with the plugin directory as the working
directory; `status` says so, because a joined team project can select a
different runtime per directory. `server-service.cjs status` exits 1 when not
running. No hook, script, or test depends on its current exit code.

**`api-key`.** `runServerApiKeyCommand` moves to the server script and keeps the
`server` prefix: `server-service.cjs server api-key …`
(`ServerService.ts:682`).

**Installer auto-start.** `install.ts:1701-1731` runs
`server-service.cjs start --daemon` and does not wait for health, so a first
install is not held up by the Postgres download. Its result line tells the user
to run `memsmith status`. The fallback messages at `:1695` and `:1722` say
`memsmith start`.

**Removed.**

- `workerServiceScriptPath` use in lifecycle code, and the worker-based
  `runStartCommand`, `runStopCommand`, `runRestartCommand`, and
  `runStatusCommand`. The names are reused for the server-based versions.
- `runWorkerLifecycleCommand` in `src/npx-cli/commands/server.ts`. The `worker`
  alias calls the server lifecycle functions instead.
- `src/services/local-runtime-cli.ts`, `tests/services/local-runtime-cli.test.ts`,
  and its allowlist entry at `tests/logger-usage-standards.test.ts:35`.
- The "worker service" wording in the help text at `index.ts:38-49`.
- `CLAUDE.md` "Runtimes" section: point at the `memsmith` commands.

### 4. Stopping embedded Postgres from another process

Add `EmbeddedPostgresManager.stopExternal()`. It works without an in-process
instance:

1. Read the PID from `postmaster.pid` in the data directory with the existing
   `readPostmasterPid`. If the file is missing or the PID is dead, remove
   `local-pg.pid` and return.
2. Confirm that the process is Postgres and that it listens on
   `MEMSMITH_LOCAL_PG_PORT`. If not, return an error and touch nothing.
3. Send `SIGTERM` (a Postgres "smart" shutdown), poll for exit for 15 seconds,
   then send `SIGINT` ("fast" shutdown) and poll another 15 seconds.
4. Remove `local-pg.pid` only after the process exits. If it never exits, return
   an error and keep the file.

`stop --all` stops the server first, so no client holds connections, then calls
`stopExternal()`.

### 5. `doctor` and `doctor --fix`

**Check changes.**

- Rename "Worker daemon" to "Server". Probe `/api/health` at the address from
  section 2.
- Warn when the server's `version` differs from the installed plugin version.
- Update remediation text to `memsmith start` and `memsmith doctor --fix`.

**Without `--fix`.** Read-only, with the current exit codes.

**With `--fix`.** Run the checks, apply these repairs in order, print each
action, run the checks again, and exit with the new result. Under `--fix`, the
Server check is required, so a failed start makes the exit code 1.

1. **Stale server state.** If `verifyPidFileOwnership` rejects the PID file and
   nothing listens on the port, remove the server state. `removeServerState` and
   `verifyPidFileOwnership` move from `ServerService.ts` into a small module
   that the CLI bundle imports without loading the server.
2. **Missing marketplace dependencies.** Run the marketplace dependency step,
   extracted from the install flow (`runNpmInstallInMarketplace`,
   `install.ts:1626`) into a function that both `repair` and `--fix` call. It
   does not provision Bun or uv.
3. **Server not running, or running an older version.** Run `restart` if a
   server answers, `start` if none does.

A failed repair stops the remaining repairs and names the one that failed.
`--fix` never installs Bun or uv; it prints their install instructions.

## Testing

### Clean-room smoke test (release gate)

`npm run smoke:clean-room` runs `scripts/smoke-clean-room.mjs`:

1. Run `npm pack`.
2. Create a temporary `HOME`. Set `HOME`, `CLAUDE_CONFIG_DIR`,
   `MEMSMITH_SERVER_PORT`, and `MEMSMITH_LOCAL_PG_PORT` to values that do not
   collide with a developer's defaults. Require `bun` on `PATH`.
3. Install the tarball into the temporary `HOME`, then run:
   1. `memsmith install --no-auto-start`
   2. `memsmith start`
   3. `memsmith status` — exit 0, version equals `package.json`.
   4. `memsmith stop --all`
   5. `memsmith status` — exit 1.
   6. Neither port has a listener.
4. On failure, copy the daemon log to `smoke-artifacts/`. Always remove the
   temporary `HOME` and stop any process it started.

The whole script has a 15-minute timeout. A fresh `HOME` downloads Postgres
binaries and runs the full dependency install, so expect several minutes.

The workflow uploads `smoke-artifacts/` on failure. The smoke test runs on `v*`
tags, on `workflow_dispatch` with `dry_run`, and nightly on `main`. It does not
run on every pull request, because of its length and network use.

The installer's auto-start path is not covered: non-TTY installs skip
auto-start (`install.ts:1697-1699`). Unit tests cover its arguments instead.

### Unit tests (`bun test`)

Each test must fail against the bug it pins.

- **Replace `tests/npx-cli-server-namespace.test.ts`.** Call the routing
  functions with an injected spawner, and assert the script path and arguments:
  - `stop`, `server stop`, and `worker stop` run `server-service.cjs stop`.
  - `start`, `server start`, and `worker start` pass `--daemon`.
  - `server api-key list` runs `server-service.cjs server api-key list`.
  - An unknown `server` subcommand exits nonzero.
- **`start` wait**, with an injected health probe and clock:
  - It returns only after `initialized: true`.
  - On timeout, it signals the daemon PID from the JSON output and exits 1.
- **`stop` escalation:** a process that ignores `SIGTERM` gets `SIGKILL`; a
  process that survives keeps its state files and exits 1.
- **`stopExternal()`**, with a temporary data directory:
  - A dead PID in `postmaster.pid` removes `local-pg.pid` and sends no signal.
  - A PID that does not listen on the Postgres port gets no signal.
  - `local-pg.pid` is removed only after the process exits.
- **Installer auto-start:** it spawns `server-service.cjs start --daemon`.
- **`doctor --fix`**, with a temporary data directory:
  - Stale state is removed only when nothing listens on the port.
  - A version mismatch runs `restart`; a missing server runs `start`.
  - Without `--fix`, no state changes.
  - The dependency repair never calls Bun or uv provisioning.
