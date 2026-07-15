# MemSmith: AI Development Instructions

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

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
  - Manage it with: the `local start | stop | status` CLI (`src/services/local-runtime-cli.ts`).
  - Data dir: `~/.memsmith/pgdata`; downloaded binaries: `~/.memsmith/pg-binaries`.
  - Port: `55433` (override with `MEMSMITH_LOCAL_PG_PORT`). The port is fixed — the manager never wanders to a random port; if the port is held by a foreign process it fails loud.
- **`MEMSMITH_RUNTIME=server`**: the same engine pointed at a remote Postgres (team mode).

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **uv** (all platforms - auto-installed if missing, used by the installer runtime setup)
- Node.js

## Documentation

**Public Docs**: https://docs.memsmith.ai (Mintlify)
**Source**: `docs/public/` - MDX files, edit `docs.json` for navigation
**Deploy**: Auto-deploys from GitHub on push to main

## Important

No need to edit the changelog ever, it's generated automatically.

## Daily Maintenance

Run a daily version check across all package manifests and upgrade every dependency to its latest version — including major version bumps. Staying on the latest is the goal; do not skip majors.

- Check `package.json` (root) and all nested `package.json` files (e.g. `plugin/`, `openclaw/`) for outdated dependencies via `npm outdated`.
- Upgrade every package to `latest` (use `npm install <pkg>@latest` for each, or `npx npm-check-updates -u && npm install`). Bump majors too.
- Run `npm audit fix` to resolve advisories.
- After upgrades, run `npm run build-and-sync` and verify the worker starts and tests pass. Fix any breakage caused by major bumps in the same change.
- Commit the updated `package.json` and `package-lock.json` files.

## Memory-First (MemSmith)

For any why/decision/rationale question — the user's or your own — consult MemSmith memory FIRST (ms-mem-search tools) before grepping or reading files. Reference order: (1) MemSmith memory, (2) CLAUDE.md, (3) specs, (4) file search. Treat recalled memory as authoritative-but-verifiable.
