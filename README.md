<h1 align="center">MemSmith</h1>

<h4 align="center">Persistent, shared memory for AI coding agents. Built for <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>.</h4>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License">
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/node-%3E%3D20.12.0-brightgreen.svg" alt="Node">
  </a>
</p>

<p align="center">
  <a href="#what-memsmith-does">What it does</a> •
  <a href="#install">Install</a> •
  <a href="#quick-start">Quick start</a> •
  <a href="#capabilities">Capabilities</a> •
  <a href="#runtimes">Runtimes</a> •
  <a href="#troubleshooting">Troubleshooting</a> •
  <a href="#license">License</a>
</p>

MemSmith gives your AI coding agent memory that survives between sessions. It
records what the agent does, turns that activity into short typed observations
(decisions, bug fixes, discoveries, and changes), and lets the agent search them
in later sessions. In team mode, a whole team shares one searchable memory.

## What MemSmith does

1. **Capture.** Claude Code hooks send prompts, tool use, file edits, and
   session summaries to a MemSmith server. MemSmith redacts known secrets
   before it stores anything.
2. **Generate.** A provider that you choose (Claude, Gemini, OpenRouter, or
   Ollama) turns the activity into observations. If a hosted provider fails,
   MemSmith can run the job on a local Ollama model.
3. **Store.** Observations go into Postgres with pgvector. A local embedder
   produces the vectors, so semantic search needs no API key.
4. **Recall.** Claude searches memory with MCP tools before it searches the
   code or the web. You can also search from a terminal or the dashboard.

## Install

Requires Node.js 20.12 or later. MemSmith installs Bun and uv if they're
missing. You don't need Docker.

```bash
npx memsmith install
```

Or install from the plugin marketplace inside Claude Code:

```bash
/plugin marketplace add shshalom/memsmith
/plugin install memsmith@shshalom
```

The installer asks which generation provider to use. The default, Claude
Haiku 5.5, needs an Anthropic API key. To use Ollama only, choose it at the
prompt. For all options, see [Installation](https://github.com/shshalom/memsmith/tree/main/docs/public/installation.mdx).

To update, run `npx memsmith@latest update`.

## Quick start

1. Restart Claude Code, and work as usual. MemSmith captures your sessions in
   the background. Context from earlier sessions appears from your second
   session in a project.
2. Ask Claude about past work, such as "why did we choose this approach?".
   Claude searches memory with `observation_search` and `observation_get`.
3. Search from a terminal, in a project folder:

   ```bash
   memsmith search "start at login"
   memsmith get <id>
   ```

4. Save a note on purpose:

   ```bash
   memsmith note "Deploys freeze on Fridays"
   ```

5. Open the dashboard at the address that `memsmith status` prints.
6. If something looks wrong, run `memsmith doctor`. Add `--fix` to repair what
   it finds.

Without a global install (`npm install -g memsmith`), prefix each command with
`npx`.

## Capabilities

| Capability | What it does | Documentation |
| --- | --- | --- |
| Memory tools | Search, read, and write memory through MCP, and explore code with `smart_*` tools | [Memory tools](https://github.com/shshalom/memsmith/tree/main/docs/public/usage/memory-tools.mdx) |
| Notes | Save a decision or fact on purpose, ranked first in search | [Notes](https://github.com/shshalom/memsmith/tree/main/docs/public/usage/notes.mdx) |
| CLI | Install, update, manage the server, search, link projects, and operate a team server | [CLI reference](https://github.com/shshalom/memsmith/tree/main/docs/public/cli-reference.mdx) |
| Projects | Map folders to projects with markers, and merge or prune projects | [Projects](https://github.com/shshalom/memsmith/tree/main/docs/public/usage/projects.mdx) |
| Dashboard | Browse observations, read notes, and change settings | [Dashboard](https://github.com/shshalom/memsmith/tree/main/docs/public/dashboard.mdx) |
| Actor tags | Label memory with the agent or role that wrote it, and filter by it | [Actor tags](https://github.com/shshalom/memsmith/tree/main/docs/public/usage/actor-tags.mdx) |
| Read-only mode | Let a session read memory but record nothing (`MEMSMITH_ACCESS=read`) | [Read-only mode](https://github.com/shshalom/memsmith/tree/main/docs/public/usage/read-only-mode.mdx) |
| Hook switches | Turn off hook features by name (`MEMSMITH_HOOKS_DISABLED`) | [Hook switches](https://github.com/shshalom/memsmith/tree/main/docs/public/usage/hook-switches.mdx) |
| Privacy | Exclude content with `<private>` tags, redact secrets automatically, and pause capture with `/incognito` | [Private tags](https://github.com/shshalom/memsmith/tree/main/docs/public/usage/private-tags.mdx), [Secret redaction](https://github.com/shshalom/memsmith/tree/main/docs/public/usage/secret-redaction.mdx), [Incognito mode](https://github.com/shshalom/memsmith/tree/main/docs/public/usage/incognito.mdx) |
| Providers | Choose Claude, Gemini, OpenRouter, or Ollama, with automatic local failover | [Generation providers](https://github.com/shshalom/memsmith/tree/main/docs/public/providers.mdx) |
| Generation | Queue, retries, quality floor, tiering, and monthly caps | [Generation queue and quality](https://github.com/shshalom/memsmith/tree/main/docs/public/generation.mdx) |
| Memory-first enforcement | Make the agent consult memory before it searches code or the web | [Architecture overview](https://github.com/shshalom/memsmith/tree/main/docs/public/architecture/overview.mdx) |
| Team server | Share memory across a team with API keys, roles, quotas, and remote MCP recall | [Team server](https://github.com/shshalom/memsmith/tree/main/docs/public/hosted-server.mdx) |
| Settings | Every setting and environment variable, with its default | [Settings reference](https://github.com/shshalom/memsmith/tree/main/docs/public/settings-reference.mdx) |
| Other IDEs | Cursor, Antigravity CLI, Claude Desktop, and others | [Cursor](https://github.com/shshalom/memsmith/tree/main/docs/public/cursor/index.mdx), [Antigravity CLI](https://github.com/shshalom/memsmith/tree/main/docs/public/antigravity-cli/setup.mdx), [Claude Desktop](https://github.com/shshalom/memsmith/tree/main/docs/public/usage/claude-desktop.mdx) |

## Runtimes

MemSmith runs the same engine in two runtimes. [Runtimes](https://github.com/shshalom/memsmith/tree/main/docs/public/runtimes.mdx) compares them.

| Runtime | Who it serves | Where data lives |
| --- | --- | --- |
| `local` (default) | A solo developer | Embedded Postgres in `~/.memsmith/pgdata` |
| `server` | A team | Remote Postgres behind an HTTPS API |

A project moves from `local` to `server` through the **GO TEAM** flow in the
dashboard. The flow copies local data to the team server, verifies the copy, and
then switches the project. MemSmith never deletes local data. A teammate who
clones the repository joins the team from the dashboard with a team key. For
deployment, see [Team server](https://github.com/shshalom/memsmith/tree/main/docs/public/hosted-server.mdx) and the
[AWS runbook](docs/deploy/aws.md).

## Troubleshooting

Run `memsmith doctor` first. For fixes to common problems, such as a stopped
server, missing context, or a blocked tool call, see
[Troubleshooting](https://github.com/shshalom/memsmith/tree/main/docs/public/troubleshooting.mdx).

## Documentation

The documentation source is in [`docs/public/`](https://github.com/shshalom/memsmith/tree/main/docs/public). Start with the
[introduction](https://github.com/shshalom/memsmith/tree/main/docs/public/introduction.mdx).

## Development

To build from source, clone the repository, run `npm install`, and then run
`npm run build`. To run the tests, run `bun test tests/server/` for a fast
signal. After a source change that lands in a plugin bundle, run
`npm run build` and commit the regenerated files under `plugin/`. For
contributor details, see [Development](https://github.com/shshalom/memsmith/tree/main/docs/public/development.mdx).

Report issues at [GitHub Issues](https://github.com/shshalom/memsmith/issues).
Security reports go through GitHub private vulnerability reporting; see
[SECURITY.md](SECURITY.md).

## License

MemSmith is licensed under the Apache License 2.0. See the [LICENSE](LICENSE)
file for the full text, and [docs/license.md](docs/license.md) and
[docs/ip-boundary.md](docs/ip-boundary.md) for the licensing scope.

## Credits

MemSmith includes software derived from an Apache-2.0 licensed open source
project. See the [NOTICE](NOTICE) file for attribution.
