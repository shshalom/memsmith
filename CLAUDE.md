# MemSmith: AI Development Instructions

MemSmith is a Claude Code plugin that gives agents persistent memory across sessions. Hooks capture tool usage, a configurable generation provider (Claude, Gemini, OpenRouter, or Ollama) turns it into observations, and a Postgres-backed server (pgvector and semantic search) stores them and injects relevant context into future sessions. The server runs as a local single-user runtime or as a shared team runtime.

## Build

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/shshalom/`
- **Database**: `~/.memsmith/memsmith.db`
- **Chroma**: `~/.memsmith/chroma/`
- **Embedded PG data dir** (local runtime): `~/.memsmith/pgdata`
- **Embedded PG binaries** (local runtime): `~/.memsmith/pg-binaries`

## Runtimes

The legacy `worker`/SQLite runtime has been retired. There are two runtimes, both
running the same server engine (Postgres + pgvector + semantic search):

- **Default runtime**: `local` (embedded Postgres, single-user, no Docker). This is
  the shipped default (`MEMSMITH_RUNTIME=local`); legacy `worker` settings remap to
  `local` transparently.
- **`MEMSMITH_RUNTIME=local`**: runs an embedded Postgres in-process (no Docker) so a solo user gets Postgres + semantic search without a container. On first boot it imports any existing SQLite DB (`~/.memsmith/memsmith.db`) into Postgres — taxonomy-aware, idempotent (marker `~/.memsmith/.local-import-done`), with embedding backfill so semantic search works immediately.
  - Manage it with `memsmith start | stop [--all] | restart | status` (`src/npx-cli/commands/lifecycle.ts`). `stop` leaves embedded Postgres running; `stop --all` stops it too.
  - Data dir: `~/.memsmith/pgdata`; downloaded binaries: `~/.memsmith/pg-binaries`.
  - Port: `55433` (override with `MEMSMITH_LOCAL_PG_PORT`). The port is fixed — the manager never wanders to a random port; if the port is held by a foreign process it fails loud.
- **`MEMSMITH_RUNTIME=server`**: the same engine pointed at a remote Postgres (team mode).

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **uv** (all platforms - auto-installed if missing, used by the installer runtime setup)
- Node.js

## Documentation

**Source**: `docs/public/` - Mintlify MDX files; edit `docs.json` for navigation.
**Hosting**: No hosted docs site yet. Link to the files on GitHub (https://github.com/shshalom/memsmith/tree/main/docs/public) or to the README.

## Important

No need to edit the changelog ever, it's generated automatically.

## Daily Maintenance

Run a daily version check across all package manifests and upgrade every dependency to its latest version — including major version bumps. Staying on the latest is the goal; do not skip majors.

- Check `package.json` (root) and all nested `package.json` files (e.g. `plugin/`) for outdated dependencies via `npm outdated`.
- Upgrade every package to `latest` (use `npm install <pkg>@latest` for each, or `npx npm-check-updates -u && npm install`). Bump majors too.
- Run `npm audit fix` to resolve advisories.
- After upgrades, run `npm run build-and-sync` and verify the worker starts and tests pass. Fix any breakage caused by major bumps in the same change.
- Commit the updated `package.json` and `package-lock.json` files.
