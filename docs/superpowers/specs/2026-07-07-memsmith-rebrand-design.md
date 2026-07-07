# MemSmith Rebrand — Design

**What:** Full rename of the product from **claude-mem → MemSmith**, with **zero shared
identifiers** (clean break). This unblocks dogfooding: the product currently shares
every identifier (name, binary, `CLAUDE_MEM_*` env vars, MCP namespace, data dir,
plugin/marketplace id) with the installed OG claude-mem, making the two indistinguishable
on one machine.

**Why now:** The naming collision structurally blocks running our product alongside the
installed claude-mem. Rebrand must precede product testing (see PROJECT-STATE.md).

## Decisions (settled)

- **Name:** MemSmith. Vetted clear in AI-agent-memory/MCP context and on npm. (Engram was
  rejected — crowded in-space: Lumetra Engram + others.)
- **Word style:** ONE token (`memsmith` / `MEMSMITH_` / `MemSmith` / `memSmith`), like
  GitHub/npm — NOT two words. The capital S marks the boundary in Pascal/camel; no
  separator elsewhere.
- **Back-compat:** NONE (clean break). New data dir `~/.memsmith`; only `MEMSMITH_*` env
  vars; the code never reads legacy `CLAUDE_MEM_*` or `~/.claude-mem`. The existing
  claude-mem install keeps running independently on its own data. Historical-data
  migration is a SEPARATE, later project (the SQLite→Postgres migrator), not part of this.
- **Repo identity:** `github.com/shshalom/memsmith`; marketplace/plugin id `memsmith` /
  owner `shshalom`.

## Identifier transformation map

Each case-form of the product name maps to its correctly-cased MemSmith form:

| Form | From | To | approx occurrences (src) |
|------|------|-----|------|
| kebab (pkg, binary, files, urls) | `claude-mem` | `memsmith` | 423 |
| snake | `claude_mem` | `memsmith` | 5 |
| camel (JS identifiers) | `claudeMem` | `memSmith` | 3 |
| Pascal (classes/types) | `ClaudeMem` | `MemSmith` | 53 |
| screaming (env, 145 distinct vars) | `CLAUDE_MEM_` | `MEMSMITH_` | many |
| title (docs/UI prose) | `Claude Mem` / `Claude-Mem` | `MemSmith` | 349 |
| data dir | `~/.claude-mem` | `~/.memsmith` | 31 |
| repo url / owner | `github.com/thedotmack/claude-mem`, `thedotmack` | `github.com/shshalom/memsmith`, `shshalom` | — |
| MCP server key / namespace | `mcp-search` (in `plugin/.mcp.json`), plugin id `claude-mem` | `memsmith` → surfaces as `mcp__memsmith__*` | — |

Blast radius (string occurrences of any `claude[-_ ]mem` form): src ~1236, plugin ~1286,
tests ~945, scripts ~141, docs ~2799.

### MUST NOT rename (external references — Anthropic products / real deps)

These contain "claude" but are NOT our product; renaming them breaks the build or
misrepresents the integration:

- `@anthropic-ai/claude-agent-sdk`, `claude-agent-sdk` (the SDK we depend on)
- `claude-code` keyword, `Claude Code` in prose (MemSmith *integrates with* Claude Code)
- `@huggingface/transformers`, `@modelcontextprotocol/sdk`, all real dependency names
- Anything matching `claude-agent`, `claude-code`, `claude.ai`, `anthropic`

**Rule of thumb:** rename `claude[-_ ]mem` (our product); never touch `claude-code`,
`claude-agent`, `claude.ai`, `anthropic`, or dependency package names.

## Approach: ordered, form-specific transforms (not a blind global replace)

A single `s/claude-mem/memsmith/` would (a) miss `CLAUDE_MEM_*` (different case), (b)
corrupt casing of variables/classes, and (c) risk touching the keep-list. Instead, apply
transforms in a fixed order with anchored patterns, most-specific first:

1. **Env vars:** `CLAUDE_MEM_` → `MEMSMITH_` (word-boundary anchored; 145 vars).
2. **Data dir:** `.claude-mem` → `.memsmith` (covers `~/.claude-mem`, `join(homedir(), '.claude-mem')`).
3. **Repo/owner:** `thedotmack/claude-mem` → `shshalom/memsmith`; standalone `thedotmack` (marketplace owner) → `shshalom`.
4. **Pascal:** `ClaudeMem` → `MemSmith`.
5. **camel:** `claudeMem` → `memSmith`.
6. **snake:** `claude_mem` → `memsmith`.
7. **Title prose:** `Claude-Mem` and `Claude Mem` → `MemSmith`.
8. **kebab:** `claude-mem` → `memsmith` — LAST, and only after excluding the keep-list
   (`claude-code`, `claude-agent`, dep names), because kebab is the most collision-prone.

Every transform is applied per-file-type in scoped passes (source, then plugin, then
tests, then docs, then scripts, then manifests) so each area can be independently
verified. The keep-list is enforced by NOT matching `claude-code|claude-agent|claude\.ai|anthropic`.

## Special-case surfaces (not just string replaces)

- **package.json:** `name` claude-mem→memsmith; `bin` key; `repository`/`homepage`/`bugs`
  URLs → shshalom/memsmith; keep `@anthropic-ai/claude-agent-sdk` dep and `claude-code`
  keyword. `description` "for Claude Code" stays (integration, true).
- **Plugin manifests** (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
  `plugin/.claude-plugin/plugin.json`): plugin `name`, marketplace `name`/owner, repo URLs.
- **MCP config** (`plugin/.mcp.json`): the server key/name that produces the tool
  namespace → `memsmith` (so tools surface as `mcp__memsmith__*`).
- **Data dir default** (`SettingsDefaultsManager.ts`): `join(homedir(), '.claude-mem')`
  → `'.memsmith'`, plus any derived paths (transcript-watch.json, logs, chroma).
- **Generated bundles** (`plugin/scripts/*.cjs`): regenerated by `npm run build` AFTER
  source rename — never hand-edited. Committed with the rename.
- **build/sync scripts** (`scripts/*.js/.cjs`): marketplace sync paths that reference
  `~/.claude/plugins/marketplaces/thedotmack` → the new marketplace id path.
- **Hook command shell** (`plugin/hooks/hooks.json`): the long bash locator strings
  reference `plugins/cache/thedotmack/claude-mem` — must point at the new marketplace id.

## Error handling / risks

- **Keep-list corruption** (renaming `claude-agent-sdk`): mitigated by transform order +
  explicit exclusion pattern; verified by a post-rename check that the SDK import strings
  are intact and `npm run build` succeeds.
- **Split-brain data dir** (half-renamed → memory split across `~/.claude-mem` and
  `~/.memsmith`): mitigated by doing the data-dir transform as one dedicated pass and
  grep-verifying zero `.claude-mem` path literals remain in source.
- **Bundle drift** (source renamed but `.cjs` stale): `npm run build` + commit
  regenerated bundles; verify zero tracked drift.
- **Missed reference breaking build/tests:** the whole suite (2479 tests) + `tsc --noEmit`
  + `npm run build` must all pass after the rename; a final `grep` sweep asserts no
  stray `claude[-_ ]mem` outside the keep-list.

## Verification (definition of done)

1. `npm run build` exits 0; regenerated bundles committed; zero tracked drift.
2. `tsc --noEmit` → 0 errors.
3. Full suite green (parity with pre-rename 2479/0, with the test DB).
4. `grep -rIn 'claude[-_ ]mem\|CLAUDE_MEM\|claudeMem\|ClaudeMem\|thedotmack' src plugin scripts tests`
   returns ONLY keep-list hits (claude-code / claude-agent / anthropic) — zero product refs.
5. `grep -rn '\.claude-mem' src scripts` → zero (data dir fully migrated).
6. MCP tools surface under `mcp__memsmith__*` (verified in the built plugin manifest).
7. Binary is `memsmith`; `package.json` name is `memsmith`; env defaults are `MEMSMITH_*`.

## Scope / non-goals

- **In scope:** every product-identity string → MemSmith (one-word), across src, plugin,
  tests, scripts, manifests, docs; regenerated bundles; repo/marketplace identity →
  shshalom/memsmith.
- **Out of scope:** data migration from `~/.claude-mem` (separate project); publishing the
  repo/marketplace (you push when ready); any behavior change (this is a pure rename — no
  feature edits); renaming Anthropic/Claude Code/dependency references.
