<h1 align="center">MemSmith</h1>

<h4 align="center">Shared, persistent memory for AI coding agents. Built for <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D20.12.0-brightgreen.svg" alt="Node">
  </a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> •
  <a href="#how-it-works">How it works</a> •
  <a href="#team-mode">Team mode</a> •
  <a href="#mcp-search-tools">Search tools</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#license">License</a>
</p>

AI coding agents forget everything between sessions, and what they do remember
stays on one developer's machine. MemSmith captures what your agent does, turns
that activity into short typed observations (decisions, bug fixes, discoveries,
changes), and injects the relevant ones back into future sessions — so knowledge
compounds instead of evaporating. In team mode, the whole team shares one
searchable memory.

---

## Quick start

Install with a single command (recommended):

```bash
npx memsmith install
```

Or install from the plugin marketplace inside Claude Code:

```bash
/plugin marketplace add shshalom/memsmith

/plugin install memsmith@shshalom
```

A marketplace install copies the plugin but skips the installer. In your first
session, MemSmith installs Bun if it's missing, and Claude asks you the
installer's questions and runs `npx memsmith install` for you, so both paths
end with the same setup. Claude never asks for an API key in chat.

The installer asks which generation provider turns your sessions into
memories. The default is Ollama, which runs a local model on your machine and
needs no API key. If you choose Ollama, the installer checks that it is
installed, running, and has the model (`qwen2.5:14b`, about 9 GB), and offers
to set up whatever is missing. To use Claude, Gemini, or OpenRouter instead,
choose it at the prompt and paste an API key, or run
`npx memsmith install --provider claude`. To check generation later, run
`memsmith doctor`.

Restart Claude Code. Context from previous sessions automatically appears in
new sessions, and the dashboard is available at the address that
`memsmith status` prints. By default, the address is `http://127.0.0.1:` followed
by a port derived from your user ID.

> **Note:** `npm install -g memsmith` installs the `memsmith` CLI only. To
> register the plugin hooks and set up the server, run `memsmith install`.

## Manage the server

| Command | What it does |
| --- | --- |
| `memsmith start` | Starts the local server and waits until it is ready. Accepts `--timeout <s>` (default 300 seconds). |
| `memsmith stop` | Stops the server. Embedded Postgres keeps running so the next start is fast. |
| `memsmith stop --all` | Stops the server and embedded Postgres. |
| `memsmith restart` | Restarts the server. Accepts `--timeout <s>` (default 300 seconds). |
| `memsmith status` | Shows the server's state and version. Exits 1 when it is not running. |
| `memsmith doctor` | Checks Bun, uv, the plugin install, the server, and whether the generation provider can create memories. |
| `memsmith doctor --fix` | Also repairs stale state, missing dependencies, a stopped or outdated server, and a stopped Ollama or missing Ollama model. |
| `memsmith update` | Updates the CLI, the plugin, and the server to the latest version and keeps your settings. |

Without a global install, prefix each command with `npx`, for example
`npx memsmith status`.

### Update

To update MemSmith, run:

```bash
npx memsmith@latest update
```

The command installs the latest plugin for Claude Code, including any
per-project installs, restarts the local server on the new version, and checks
that the versions match. It doesn't ask the installer questions again. When it
finishes, restart Claude Code. `/reload-plugins` doesn't restart the running
memory server that Claude Code started, so new memory tools appear only after
a restart.

If Claude Code updates the plugin on its own, the server keeps running the old
version. MemSmith warns you about this at the start of the next session. To fix
it, run `npx memsmith@latest update`.

## Key features

- 🧠 **Persistent memory** - Context survives across sessions
- 👥 **Team mode** - One shared memory per team, scoped by project, over authenticated HTTPS
- 🔍 **Hybrid search** - Full-text plus semantic vector search, fused with reciprocal rank fusion
- 📊 **Progressive disclosure** - Layered retrieval keeps token cost low; lower-ranked memories render at reduced detail
- 🏠 **Local first** - Embedded Postgres and a local embedder; no Docker, no API keys, nothing leaves your machine in local mode
- 🖥️ **Dashboard** - Real-time memory stream and team controls at the address that `memsmith status` prints
- 🔒 **Privacy control** - Use `<private>` tags to exclude sensitive content from storage
- 🤖 **Automatic operation** - No manual intervention required

## How it works

1. **Capture.** Claude Code lifecycle hooks (`SessionStart`, `UserPromptSubmit`,
   `PreToolUse`, `PostToolUse`, `Stop`) send events to a local MemSmith server.
2. **Generate.** A generation step turns raw events into typed observations on
   your own machine. The LLM provider is swappable between Ollama (default in
   team mode), Claude, Gemini, and OpenRouter.
3. **Store.** Observations land in Postgres with pgvector. Each project has its
   own database. A local embedder produces the vectors — no API key required.
4. **Retrieve.** Hybrid search ranks results with weighted reciprocal rank
   fusion. If the embedder is down, search degrades to full-text instead of
   failing.
5. **Inject.** At session start, the latest observations render into the
   agent's context for orientation. On each task prompt, relevant observations
   render as background. Superseded decisions collapse to their current head,
   so the agent sees only current truth.
6. **Answer from memory.** When a prompt asks about past work, decisions,
   history, or anything outside the current conversation, MemSmith tells the
   agent to answer from a memory search (`observation_search`), not from the
   session-start context, and to verify load-bearing claims against the current
   code. Questions about what was said earlier in the same conversation are
   exempt. In `hard` enforcement mode (the default), the `Stop` hook sends the
   agent back once if it answers without searching memory. To turn enforcement
   off, run `npx memsmith enforcement off`; `npx memsmith enforcement status`
   shows the mode the hooks use.

## Team mode

MemSmith runs the same engine in two runtimes:

| Runtime | Who it serves | Where data lives |
| --- | --- | --- |
| `local` (default) | A solo developer | Embedded Postgres in `~/.memsmith/pgdata` |
| `server` | A team | Remote Postgres behind an HTTPS API |

A project moves from `local` to `server` through the **GO TEAM** flow in the
dashboard. It copies local data to the team server, verifies the copy, and only
then flips the runtime. Local data is never deleted.

A teammate who clones a converted repo sees a **Join** button in the dashboard,
enters a team key, and their sessions start reading and writing team memory. No
teammate ever holds a database password — API keys are hashed at rest,
revocable, expirable, and scoped to a team and optionally one project.

## MCP search tools

MemSmith exposes memory through MCP tools that follow a token-efficient,
filter-before-fetching workflow:

**Search and recall:**

- **`observation_search`** - Ranked index of matching observations: id, date, type, title, and a short snippet (10 results by default, up to 25)
- **`observation_get`** - Full records for ids chosen from the index (up to 10 per call)
- **`observation_context`** - Full bodies of the top few matches in one call (5 by default, up to 10)

**Code exploration:**

- **`smart_search`** - Search the codebase for symbols, functions, and classes
- **`smart_outline`** - Structural map of a file with line numbers, cheaper than re-reading it
- **`smart_unfold`** - Expand only the sections you need

**Capture:**

- **`note_add`** - Record a user-directed note ("remember that...") as a findable user note

Search with `observation_search`, then fetch full records with `observation_get`
for only the results that matter. Each tool's output is capped so it fits in the
agent's context. The `ms-mem-search` skill wraps this workflow for natural
language queries.

## Configuration

Settings are managed in `~/.memsmith/settings.json` (auto-created with defaults
on first run). Configure the AI provider, data directory, log level, and
context injection settings.

The `MEMSMITH_MODE` setting controls workflow behavior and the language of
generated observations. Language modes follow the pattern `code--[lang]`, such
as `code--zh` or `code--ja`. Restart Claude Code after changing the mode.

## System requirements

- **Node.js**: 20.12.0 or higher
- **Claude Code**: Latest version with plugin support
- **Bun**: JavaScript runtime and process manager (auto-installed if missing)
- **uv**: Python package manager (auto-installed if missing)
- **Postgres**: Embedded and managed automatically in `~/.memsmith/pgdata`; no Docker or manual setup required

## Documentation and development

Documentation source lives in [`docs/`](docs/), including the
[AWS deploy runbook](docs/deploy/).

To build from source: clone the repo, run `npm install`, then `npm run build`.
Run tests with `bun test tests/server/` for a fast signal. After any source
change that lands in a plugin bundle, run `npm run build` and commit the
regenerated files under `plugin/`.

## Bug reports and contributing

Report issues at [GitHub Issues](https://github.com/shshalom/memsmith/issues).

Contributions are welcome:

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Update documentation
5. Submit a pull request

## License

MemSmith is licensed under the Apache License 2.0.

We chose Apache-2.0 because durable agentic memory should be easy to embed in
developer tools, local agents, MCP servers, enterprise systems, robotics stacks,
and production agent harnesses.

See the [LICENSE](LICENSE) file for full details. See [docs/license.md](docs/license.md)
and [docs/ip-boundary.md](docs/ip-boundary.md) for licensing scope and the
open/commercial boundary.

## Credits

MemSmith includes software derived from an Apache-2.0 licensed open source
project. See the [NOTICE](NOTICE) file for attribution.
