# Changelog

All notable changes to MemSmith are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

History before the fork lives in the upstream project credited in [NOTICE](NOTICE).

## [Unreleased]

### Added

- Capture redacts known secret patterns, such as Anthropic, OpenAI, GitHub, Google, AWS, Slack, and npm keys, bearer tokens, JWTs, private keys, and `*_KEY=`, `*_TOKEN=`, `*_SECRET=`, and `*_PASSWORD=` values, before an event is spooled, stored, or sent to a generation provider. Each value becomes a marker such as `[REDACTED:anthropic_key]`, and the surrounding text is kept. The server applies the same redaction, so events from older hook clients and direct `observation_add` and `note_add` writes are covered too.

## [13.13.2] - 2026-11-08

### Fixed

- `memsmith search` and `memsmith get` use the project folder in `MEMSMITH_PROJECT_CWD` when it's set, the same as the hooks. Before, they always used the current folder.
- `memsmith update` updates a global `memsmith` command installed with `npm install -g`. Before, it updated the plugin and the server but left the global command on the old version, so commands added since then, such as `memsmith autostart`, failed with `Unknown command`. A command linked to a local checkout with `npm link` is left alone. If the npm install fails, the update still finishes and prints the command to run.

## [13.13.1] - 2026-11-06

### Added

- `memsmith get <id> [<id>...]` prints the full records for observation ids, so you can read memory from a terminal without the MCP tools.

### Fixed

- `memsmith search` works on local installs. Before, it printed `MemSmith runtime is not configured` even while the server was running, because it read only team-server settings. It now searches the project that the current folder belongs to, prints the same ranked index as the `observation_search` tool, and accepts `--limit <n>`.

## [13.13.0] - 2026-11-05

### Added

- `memsmith autostart enable | disable | status` registers MemSmith to start when you log in, using a LaunchAgent on macOS, a systemd user unit on Linux, and a `Run` registry value on Windows. The installer asks `Start MemSmith when you log in?` in interactive local installs; `--start-at-login` and `--no-start-at-login` control it in non-interactive installs. `memsmith update` offers it once, and `memsmith uninstall` removes it. Only macOS has been verified on a real machine; Linux and Windows support is experimental.

## [13.12.1] - 2026-11-05

### Fixed

- Resuming a Claude Code session now starts the MemSmith server. Before, only a new, cleared, or compacted session started it, so after a reboot a resumed session ran without memory until you ran `memsmith start`. MemSmith doesn't inject session-start context again on resume.

## [13.12.0] - 2026-11-05

### Changed

- The default generation provider is now Claude Haiku 5.5 (`claude-haiku-5-5`). It needs an Anthropic API key in `~/.memsmith/.env` or `MEMSMITH_ANTHROPIC_API_KEY`; a Claude subscription login doesn't cover it.
- The default Ollama model is now `gemma4:12b` (8 GB download, about 9.7 GB of RAM while loaded).
- The Ollama provider uses Ollama's native `/api/chat` with a fixed 20,480-token context and thinking off. Before, Ollama sized the context itself, up to 256k tokens for Gemma 4, which multiplied RAM use. The record-intent backstop and the import classifier use the same call.
- The installer lists Claude Haiku 5.5 first as the recommended choice.
- Existing installs keep their provider. At server start, an install whose settings file has no `MEMSMITH_SERVER_PROVIDER` is pinned to Ollama with its current model (`MEMSMITH_OLLAMA_MODEL`, or `qwen2.5:14b`). An Ollama install with no `MEMSMITH_SERVER_MODEL` is pinned to the same model.
- A shell `ANTHROPIC_API_KEY` alone no longer turns on Claude generation. MemSmith uses it only when you choose the provider with the `MEMSMITH_SERVER_PROVIDER` environment variable or on the dashboard. Otherwise, save the key with `npx memsmith install` or set `MEMSMITH_ANTHROPIC_API_KEY`.

### Added

- Automatic failover to local Ollama. On any Claude error, the same job runs on the backup. After a failure, jobs go to the backup first for 5 minutes, and with no Anthropic key MemSmith uses the backup only. Failover never goes from a local model to a cloud one. Configure it with `MEMSMITH_SERVER_FALLBACK` (`ollama` or `none`) and `MEMSMITH_SERVER_FALLBACK_MODEL` (default `gemma4:12b`).
- The installer asks "Install a local backup for outages? (8 GB)" after you choose Claude Haiku 5.5. The new `--local-backup` flag answers it in non-interactive installs.
- If your install runs Ollama, `memsmith update` offers the switch to Claude Haiku 5.5 with a local `gemma4:12b` backup (8 GB download) once, in an interactive terminal. It asks before the download starts. A non-interactive update prints a tip instead.
- A model benchmark in `bench/model-bench/` that scores generation models on synthetic and real events.

### Fixed

- The server now reads `MEMSMITH_SERVER_PROVIDER` and `MEMSMITH_SERVER_MODEL` from `settings.json` at startup. The boot loader dropped both.
- The Claude generation provider no longer sends `temperature`. Claude Haiku 5.5 and Claude Sonnet 5.5 reject that parameter, so every observation failed when you selected either model.

## [13.11.2] - 2026-10-15

### Added

- A marketplace install now ends with the same setup as `npx memsmith install`. At the start of the first session, MemSmith installs Bun when it's missing (opt out with `MEMSMITH_SKIP_BUN_INSTALL=1`; a failed attempt waits a day before retrying), and Claude asks you the installer's questions (generation provider, Ollama setup) and runs `npx memsmith install` for you. Claude never asks for an API key in chat. Only a fresh marketplace install is asked: the prompt appears when the server created `settings.json` from its defaults, which an `npx memsmith install` never leaves behind.

### Changed

- In Claude Code, memory first follows one flow for the agent and every subagent: do I already know this from this conversation? If not, search memory, then validate against the code. The standing instruction says so, and the `tool-intent` gate enforces it when the agent reaches out: before the first Grep, Glob, search-style Bash command, or web search on a topic, `hard` mode blocks until memory was consulted with `observation_search` or `observation_context`, and `soft` mode reminds. Web search is now gated too. When memory can't be reached, the gate lets the search through with a notice instead of blocking.
- MemSmith no longer injects memories on every prompt and tool call. Prompts that aren't clear questions about past work, such as tasks, "status?", or "ok", cost no memory search, and the gate runs no search of its own. The agent consults memory itself, by calling the memory tools. The opt-in team discovery gate (`MEMSMITH_GATE_TOOLS`, off by default) still injects team memory when you turn it on.
- Only a prompt with a clear retrieval signal, such as "what did we decide…", "why…", "where is X configured", or "status of X", gets the answer-from-memory directive and the `Stop` check. Any short prompt with a question mark used to count, so "status?" or "why?" required a memory search.
- `memsmith update` tells you to restart Claude Code when it finishes. `/reload-plugins` doesn't restart the running MCP server, so new memory tools didn't appear.

## [13.11.1] - 2026-10-14

### Added

- MemSmith warns you at session start when the local server runs a different version than the plugin, for example after Claude Code updated the plugin, and tells you to run `npx memsmith@latest update`. Team servers and servers run from source are skipped.

### Changed

- `npx memsmith install` no longer prints an npm `ERESOLVE` report. The marketplace copy of `package.json` leaves out dev dependencies, which caused the conflict.
- `memsmith update` updates the CLI, the plugin, and the server in one step and keeps your settings. It reruns itself with the newest version on npm, installs the plugin and moves every Claude Code plugin entry (user-wide and per-project) to it, restarts the local server, and checks the server's version. It previously reran the full installer, which asked every question again, installed whatever version the CLI carried, left the old server running, and dropped per-project plugin entries. Run it as `npx memsmith@latest update`.

## [13.11.0] - 2026-10-14

### Added

- Questions about past work are answered from a memory search. When a prompt asks about past work, decisions, history, or anything outside the current conversation, MemSmith tells the agent to search memory with `observation_search`, answer from the results, and verify load-bearing claims against the code, instead of injecting the top memories as a ready answer. Questions about the current conversation and pure task instructions are exempt.
- In `hard` enforcement mode, the `Stop` hook sends the agent back once when it answers a question about past work without searching memory. It never blocks in `soft` mode, twice in one turn, or when memory is unavailable. To turn it off, run `npx memsmith enforcement off`.
- When you choose Ollama, the installer checks that Ollama is installed, running, and has the model, and offers to install it, start it, and download the model. Non-interactive installs print the fix commands instead. `--setup-ollama` performs the steps without asking.
- `observation_get` returns the full records for ids that `observation_search` returned, up to 10 per call.
- `memsmith doctor` has a **Generation** check that uses the provider the running server resolves, including a dashboard override. `memsmith doctor --fix` starts a stopped Ollama and downloads a missing model.

### Changed

- `observation_search` returns a short ranked index (id, date, type, title, and a snippet of about 200 characters) instead of full records. It returns 10 results by default and at most 25. Fetch full records with `observation_get`.
- `observation_context` returns the full bodies of the top matches as text, 5 by default and at most 10, capped at about 20,000 characters.
- The hosted recall link (`/v1/mcp`) follows the same rules: `search` and `recent` return an index, `context` returns capped text, and a new `get` tool returns full records by id.
- Session-start memory is labeled as the latest context for orientation, not as the source for answers.
- The installer's provider prompt now drives generation. It lists Ollama first as the recommended default and writes `MEMSMITH_SERVER_PROVIDER` and `MEMSMITH_SERVER_MODEL`, which the server reads. It previously recommended Claude and saved `MEMSMITH_PROVIDER`, which generation never read, so every install generated with Ollama.
- Choosing Claude in the installer asks for an Anthropic API key only. The server calls the Anthropic Messages API directly and can't use a Claude subscription or a gateway.

### Fixed

- Memory searches no longer overflow Claude Code's tool output limit. `observation_search` returned every matching record in full, about 2,700 characters each, so a 40-result search produced over 100,000 characters, and Claude Code saved it to a file instead of showing it to the agent.
- `npx memsmith enforcement status` reports the mode that the hooks use. It reported `soft` when `settings.json` had no `MEMSMITH_RETRIEVAL_ENFORCEMENT` key, while the hooks ran with the default, `hard`. It now also says whether the mode is the default, set in `settings.json`, or set by the environment variable, and it uses the settings file under `MEMSMITH_DATA_DIR`.
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
