<h1 align="center">MemSmith</h1>

<h4 align="center">Shared, persistent memory for AI coding agents. Built for <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/version-13.10.1-green.svg" alt="Version">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node">
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

Install with a single command:

```bash
npx memsmith install
```

Or install from the plugin marketplace inside Claude Code:

```bash
/plugin marketplace add shshalom/memsmith

/plugin install memsmith
```

Restart Claude Code. Context from previous sessions automatically appears in
new sessions, and the dashboard is available at http://localhost:38879.

> **Note:** MemSmith is also published on npm, but `npm install -g memsmith`
> installs the SDK/library only — it does not register the plugin hooks or set
> up the server. Always install through `npx memsmith install` or the `/plugin`
> commands above.

## Key features

- 🧠 **Persistent memory** - Context survives across sessions
- 👥 **Team mode** - One shared memory per team, scoped by project, over authenticated HTTPS
- 🔍 **Hybrid search** - Full-text plus semantic vector search, fused with reciprocal rank fusion
- 📊 **Progressive disclosure** - Layered retrieval keeps token cost low; lower-ranked memories render at reduced detail
- 🏠 **Local first** - Embedded Postgres and a local embedder; no Docker, no API keys, nothing leaves your machine in local mode
- 🖥️ **Dashboard** - Real-time memory stream and team controls at http://localhost:38879
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
5. **Inject.** At session start and on each prompt, relevant observations render
   into the agent's context. Superseded decisions collapse to their current
   head, so the agent sees only current truth.

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

- **`observation_search`** - Full-text search across observations, with project and platform filters
- **`smart_search`** - Hybrid semantic and keyword search over the memory corpus
- **`observation_context`** - Chronological context around a specific observation

**Progressive disclosure for file memory:**

- **`smart_outline`** - Structural map of a file with line numbers, cheaper than re-reading it
- **`smart_unfold`** - Expand only the sections you need

**Capture:**

- **`note_add`** - Record a user-directed note ("remember that...") as a findable user note

Start broad with `observation_search` or `smart_search`, then narrow with
`observation_context` before fetching full details. The `ms-mem-search` skill
wraps this workflow for natural language queries.

## Configuration

Settings are managed in `~/.memsmith/settings.json` (auto-created with defaults
on first run). Configure the AI provider, data directory, log level, and
context injection settings.

The `MEMSMITH_MODE` setting controls workflow behavior and the language of
generated observations. Language modes follow the pattern `code--[lang]`, such
as `code--zh` or `code--ja`. Restart Claude Code after changing the mode.

## System requirements

- **Node.js**: 20.0.0 or higher
- **Claude Code**: Latest version with plugin support
- **Bun**: JavaScript runtime and process manager (auto-installed if missing)
- **uv**: Python package manager (auto-installed if missing)
- **Postgres**: Embedded and managed automatically in `~/.memsmith/pgdata`; no Docker or manual setup required

## Documentation and development

Documentation source lives in [`docs/`](docs/), including the
[AWS deploy runbook](docs/deploy/) and the design specs in
[`docs/superpowers/specs/`](docs/superpowers/specs/).

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

**Note on Ragtime**: The `ragtime/` directory is licensed under the Apache
License 2.0. See [ragtime/LICENSE](ragtime/LICENSE) for details.

## Credits

MemSmith is based on the open source
[claude-mem](https://github.com/thedotmack/claude-mem) plugin by Alex Newman
and draws on ideas from the wider open source agent memory ecosystem.

---

**Built with Claude Agent SDK** | **Works with Claude Code** | **Made with TypeScript**
