# Changelog

All notable changes to MemSmith are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

History before the fork lives in the upstream project credited in [NOTICE](NOTICE).

## [13.10.3] - 2026-10-14

### Changed

- The plugin, npm package, and docs present MemSmith only: one author, one description, and MemSmith links throughout.
- The plugin ships four skills: `ms-mem-search`, `ms-smart-explore`, `ms-how-it-works`, and `ms-dashboard`. `ms-mem-search` uses the server-backed `observation_search`, `observation_context`, and `note_add` tools.
- Only the `code` mode and its language and chill variants ship.
- Telemetry sends nothing unless you set `MEMSMITH_TELEMETRY_KEY`.
- Security reports go through GitHub private vulnerability reporting.
- The docs describe the embedded Postgres local runtime and the team runtime.

### Removed

- The bundled upstream telemetry key, the installer's waitlist opt-in, and the upstream community links.
- The OpenClaw integration, the hosted install-script deployment, the unused user-message hook handler, and the docs pages about the retired worker architecture.

### Fixed

- The memory gate and the tool-intent hook accept only MemSmith's own MCP tools.
- The post-install message and `ms-how-it-works` point only at skills that ship.
- `npx memsmith install --ide cursor`, `--ide antigravity`, and `--ide windsurf` write hooks that run the shipped `server-service.cjs` instead of the retired worker script, which made those installs fail.
- `npx memsmith install --runtime local` is accepted. The help advertises `local|server`; `worker` still works as a legacy alias for `local`.

## [13.10.2] - 2026-10-13

### Added

- npm distribution: `npx memsmith install` installs the plugin, the runtime dependencies, and the server, and `npm install -g memsmith` provides the `memsmith` CLI.
- Lifecycle commands: `memsmith start`, `stop`, `restart`, and `status`, which wait for the server and verify its state. `stop --all` also stops embedded Postgres.
- `memsmith doctor` checks Bun, uv, the plugin install, and the server. `memsmith doctor --fix` repairs common failures, such as a stopped server or stale server state.
- A clean-room smoke test that installs the package and runs the lifecycle commands in isolation.
- Releases publish from tags with npm trusted publishing.

### Fixed

- A fresh local install captures and recalls memory.
- One project identity per repository, not per folder.
- Local generation keeps working and reports its status.
- One memory consult covers the searches that follow it.
- The installer auto-starts the server script that ships, and the CLI resolves the server address from `settings.json`.
