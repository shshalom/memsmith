# Distribution and lifecycle CLI — design

**Status:** design approved in conversation on 2026-10-13. Waiting for written-spec review.
**Branch:** `feat/distribution-lifecycle-cli`

## Goal

MemSmith is open source. Teams need to install it with one command and manage it
with one command, so they can start using it and contributing to it.

Success means:

- `npx memsmith install` works on a machine that has never seen the repo.
- `memsmith start`, `stop`, `restart`, `status`, and `doctor` work from any
  directory and act on the MemSmith server.
- `memsmith doctor --fix` repairs the failures that new users already hit.

## Current state

| Problem | Evidence |
| --- | --- |
| `memsmith` is not on npm. | `npm view memsmith` returns `404`. `npx memsmith` works only inside the repo, where npm resolves the project's own `bin`. |
| The README says MemSmith is on npm. | `README.md:48`. |
| The publish workflow never ran. | `.github/workflows/npm-publish.yml` triggers on `v*` tags. The local repo has tags through `v13.10.1`; `git ls-remote --tags origin` lists none. |
| The publish workflow would fail. | It runs `npm run smoke:clean-room`, and `package.json` has no such script. |
| Top-level lifecycle commands are broken. | `memsmith start|stop|restart|status` call `plugin/scripts/worker-service.cjs` (`src/npx-cli/commands/runtime.ts:68`). That script no longer ships; only `server-service.cjs` does. |
| `memsmith server start` blocks the terminal. | `runServerStartCommand` passes `start` without `--daemon`. `server-service start` defaults to foreground. |
| The installer builds a dead path. | `src/npx-cli/commands/install.ts:1701` builds a `worker-service.cjs` path. |
| `doctor` checks the wrong process. | It probes `MEMSMITH_WORKER_PORT` and labels the result "Worker daemon". The server listens on the `MEMSMITH_SERVER_URL` port. |
| A test enforces the broken routing. | `tests/npx-cli-server-namespace.test.ts` asserts on source strings, including the worker lifecycle routing. |
| Stopping the server leaves embedded Postgres running. | In the `local` runtime, the daemon boots embedded Postgres through `startLocalRuntime()` and never stops it on shutdown. |
| The documented `memsmith local` CLI is unreachable. | `CLAUDE.md` documents `local start|stop|status`. `src/services/local-runtime-cli.ts` has no callers. |

The npm tarball is small: `npm pack --dry-run` reports 3.0 MB packed, 7.5 MB
unpacked, 113 files. The 946 MB plugin footprint comes from dependency installs
during `memsmith install`. Reducing it is a separate piece of work.

## Out of scope

- Install footprint and speed.
- Contributor onboarding (clone to linked dev build).
- Changelog or release-PR automation.
- An npm organization.
- `doctor --fix` repairs beyond the three listed below.

## Decisions

- **Package name:** `memsmith`, unscoped.
- **Release flow:** a one-time manual publish claims the name. After that, a `v*`
  tag publishes from GitHub Actions through npm trusted publishing (OIDC) with
  provenance. No long-lived `NPM_TOKEN`.
- **CLI shape:** top-level lifecycle commands act on the server. The `server`
  namespace stays as an alias.
- **Doctor:** `--fix` is included, limited to three repairs.

## Design

### 1. Distribution

**Maintainer steps, done once by hand.** These publish to a public registry, so
they are not automated by this change.

1. From a clean build of the current version, run `npm publish`.
2. On npmjs.com, add a trusted publisher for repository `shshalom/memsmith` and
   workflow `npm-publish.yml`.

**Repository changes.**

- `npm-publish.yml`:
  - Add `permissions: { contents: read, id-token: write }`.
  - Add a step that fails unless the tag, without its `v` prefix, equals
    `package.json` `version`.
  - Run `npm publish --provenance --access public`.
  - Remove `NODE_AUTH_TOKEN`.
  - Keep `npm run build` and `npm run smoke:clean-room` before publishing.
- Add the `smoke:clean-room` script (section 3).
- `README.md`:
  - Make `npx memsmith install` the primary install path. Keep the `/plugin`
    marketplace steps as the alternative.
  - Replace the note at line 48 with an accurate one: `npm install -g memsmith`
    installs the CLI only; `memsmith install` registers the plugin.
  - Add a "Manage the server" section that lists `start`, `stop [--all]`,
    `restart`, `status`, and `doctor [--fix]`.

**Releasing.** Push a `v*` tag that matches `package.json`. The `ms-version-bump`
skill already creates the tag; the tag must also be pushed.

### 2. Lifecycle CLI

| Command | Behavior |
| --- | --- |
| `memsmith start` | Runs `server-service.cjs start --daemon`. Returns after the server answers its health check. On timeout, prints the log path and exits 1. |
| `memsmith stop` | Runs `server-service.cjs stop`. Embedded Postgres keeps running, so the next `start` is fast. |
| `memsmith stop --all` | Stops the server, then stops embedded Postgres with `EmbeddedPostgresManager.stop()`. In the `server` runtime, `--all` is the same as `stop`. |
| `memsmith restart` | Runs `server-service.cjs restart`. |
| `memsmith status` | Prints PID, port, runtime, start time, installed plugin version, and dashboard URL. In the `local` runtime, also prints whether embedded Postgres is running. Exits 0 when the server is running, 1 when not. |
| `memsmith server start\|stop\|restart\|status` | Aliases. They call the same functions as the top-level commands. |

All four resolve `server-service.cjs` through the existing
`serverServiceScriptPath()` and run it with the resolved Bun binary.

**Removed:**

- `spawnBunWorkerCommand` and `workerServiceScriptPath` in
  `src/npx-cli/commands/runtime.ts`.
- The worker-based `runStartCommand`, `runStopCommand`, `runRestartCommand`, and
  `runStatusCommand`. The names are reused for the server-based versions.
- `runWorkerLifecycleCommand` in `src/npx-cli/commands/server.ts`.
- The `worker-service.cjs` path in `src/npx-cli/commands/install.ts:1701`. If a
  fallback is still needed there, it uses `server-service.cjs`.
- `src/services/local-runtime-cli.ts`, which has no callers. `stop --all` and
  `status` replace its `stop` and `status`. The `CLAUDE.md` "Runtimes" section
  is updated to point at the `memsmith` commands.

`runServerApiKeyCommand` also routes through `spawnBunWorkerCommand` today. It
moves to the server script, which already handles `server api-key`.

**`status` exit code.** `server-service.cjs status` prints but always exits 0.
It gains a nonzero exit when the server is not running, so the CLI can pass the
exit code through.

### 3. `doctor` and `doctor --fix`

**Check changes.**

- Rename "Worker daemon" to "Server".
- Probe the port from `MEMSMITH_SERVER_URL`.
- Compare the running server's version with the installed plugin version.
  A mismatch is a warning.
- Update remediation text from `npx memsmith start` to `memsmith start`.

**Without `--fix`.** `doctor` stays read-only and keeps its current exit codes.

**With `--fix`.** `doctor` runs the checks, applies these repairs in order,
prints each action, then runs the checks again and exits with the new result.

1. **Stale PID file.** If `verifyPidFileOwnership` rejects the PID file, remove
   the server state.
2. **Missing marketplace dependencies.** Run the same dependency step that
   `memsmith repair` runs.
3. **Server not running, or running an older version.** Run `restart` when a
   server is running, `start` when none is.

A failed repair stops the remaining repairs and reports which one failed.
`doctor --fix` never installs Bun or uv; it prints their install instructions.

## Testing

### Clean-room smoke test (release gate)

A new script, run by `npm run smoke:clean-room`:

1. Runs `npm pack`.
2. Creates a temporary `HOME` and installs the tarball into it.
3. With that `HOME` and a non-default `MEMSMITH_SERVER_PORT`, runs:
   1. `memsmith install --no-auto-start`
   2. `memsmith start`
   3. `memsmith status` — must exit 0 and report the package version.
   4. `memsmith stop --all`
   5. `memsmith status` — must exit 1.
   6. No process listens on the smoke test's server port or its
      `MEMSMITH_LOCAL_PG_PORT`.
4. Removes the temporary `HOME`.

This catches the failures found in this investigation: an uninstallable
package, `stop` pointing at a missing script, and `start` blocking.

### Unit tests (`bun test`)

- **Replace `tests/npx-cli-server-namespace.test.ts`.** The new tests call the
  routing functions with an injected spawner and assert on the script path and
  arguments:
  - `stop` and `server stop` both run `server-service.cjs stop`.
  - `start` and `server start` both pass `--daemon`.
  - An unknown `server` subcommand exits nonzero.
  - In the `local` runtime, `stop --all` stops embedded Postgres and plain
    `stop` does not.

  Each assertion fails if routing reverts to `worker-service.cjs` or drops
  `--daemon`.
- **Add `doctor --fix` tests** with a temporary data directory:
  - A PID file for a dead PID is removed.
  - A PID file for a live, owned server is kept.
  - A version mismatch triggers `restart`, not `start`.
  - Without `--fix`, no state changes.

### Error handling

- `start` timeout: print the log path, exit 1, and leave no PID file for a
  process that never became healthy.
- `doctor --fix`: stop at the first failed repair and name it.
- Publish: a tag and `package.json` version mismatch fails before publishing.
