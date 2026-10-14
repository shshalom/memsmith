# Changelog

All notable changes to MemSmith are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

History before the fork lives in the upstream project credited in [NOTICE](NOTICE).

## [Unreleased]

### Changed

- The installer's provider prompt now drives generation. It lists Ollama first as the recommended default and writes `MEMSMITH_SERVER_PROVIDER` and `MEMSMITH_SERVER_MODEL`, which the server reads. It previously recommended Claude and saved `MEMSMITH_PROVIDER`, which generation never read, so every install generated with Ollama.
- Choosing Claude in the installer asks for an Anthropic API key only. The server calls the Anthropic Messages API directly and can't use a Claude subscription or a gateway.

### Added

- When you choose Ollama, the installer checks that Ollama is installed, running, and has the model, and offers to install it, start it, and download the model. Non-interactive installs print the fix commands instead. `--setup-ollama` performs the steps without asking.
- `memsmith doctor` has a **Generation** check that uses the provider the running server resolves, including a dashboard override. `memsmith doctor --fix` starts a stopped Ollama and downloads a missing model.

### Fixed

- The server reads the API keys the installer saves: Gemini and OpenRouter keys in `~/.memsmith/settings.json` and the Anthropic key in `~/.memsmith/.env`. It previously read them from its process environment only.
- The provider and model in `~/.memsmith/settings.json` apply to generation. A provider chosen on the dashboard still takes precedence.

### Upgrade notes

- If you picked Claude, Gemini, or OpenRouter in an earlier installer, MemSmith has been generating with Ollama. Upgrading doesn't switch you, because the old `MEMSMITH_PROVIDER` value is ignored rather than migrated. To use a hosted provider, rerun `npx memsmith install` and choose it, or choose it on the dashboard **Settings** tab.
- If `~/.memsmith/settings.json` already sets `MEMSMITH_SERVER_PROVIDER`, generation now uses that provider. Before, the per-job provider ignored the file and used Ollama. If the file names a hosted provider with a saved key, paid API calls can start after you upgrade.
- The settings file now applies to every server setting, not only the provider: any key from the dashboard **Settings** tab, such as `MEMSMITH_TIERING` or `MEMSMITH_QUALITY_FLOOR`, set in `~/.memsmith/settings.json` takes effect. A dashboard override and the environment still win.
- Claude generation requires an Anthropic API key. If you used a Claude gateway such as LiteLLM, set `MEMSMITH_SERVER_PROVIDER` to `openrouter` and `MEMSMITH_OPENROUTER_BASE_URL` to the gateway's OpenAI-compatible URL.
- API key precedence is the MemSmith variable (`MEMSMITH_ANTHROPIC_API_KEY`, `MEMSMITH_GEMINI_API_KEY`, `MEMSMITH_OPENROUTER_API_KEY`), then the saved file, then the generic shell variable (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`).
- New fresh settings files no longer contain `MEMSMITH_PROVIDER` or `MEMSMITH_CLAUDE_AUTH_METHOD`, and the installer writes `settings.json` with mode 0600.

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
