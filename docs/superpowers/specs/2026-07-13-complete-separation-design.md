# MemSmith Complete Separation — Design

**Goal:** Make MemSmith a fully distinct product from claude-mem. Both may run
simultaneously on the same project; they must be completely distinguishable at
*every* surface a human or tool navigates by — ports, dashboards/URLs, skill and
command names, MCP identity, and the product's own self-description. MemSmith is
its own product, not "a claude-mem fork."

**Governing principle (user directive, 2026-07-13):** "Complete separation... I
don't want you to see MemSmith as a fork of claude-mem. That includes all the
skills I kept, every identifier, everything." And: "We are MemSmith, not
Claude-Mem" — set the wording and identity to MemSmith everywhere.

**Non-goal:** This spec does NOT force "one memory system per project." Running
both on one project is acceptable. This spec is about *distinguishability*, not
mutual exclusion. GAP-A (local read-back) is a SEPARATE spec, designed next.

---

## Root cause

MemSmith was forked from claude-mem. The rebrand renamed the *plumbing* identity
(plugin name `memsmith`, marketplace `shshalom`, data dir `~/.memsmith`, settings
prefix `MEMSMITH_`, cache paths, MCP server name `mem`) but left three classes of
fork-leak that make the two products indistinguishable:

- **Class 1 — Runtime port collisions.** Ports are computed with claude-mem's
  exact formula (`37700 + uid%100`, `37877 + uid%100`), so both products resolve
  to the *same* TCP ports (`:37702`, `:37877` on this machine). Whichever booted
  last owns the port → "open the claude-mem dashboard" opens MemSmith. **This is
  the concrete bug the user hit.**
- **Class 2 — Namespace collisions.** All 17 skills share claude-mem's exact
  names (`mem-search`, `timeline-report`, `how-it-works`, ...). When both plugins
  load, `/mem-search` etc. are ambiguous.
- **Class 3 — Identity/branding leaks.** MemSmith's code and observer prompts
  still *say* "Claude-Mem" — including the observer `system_identity` that tells
  the generating model "You are Claude-Mem."

Version drift (MemSmith 13.10.1 vs claude-mem 13.11.0) is NOT a leak — separate
version lines are correct for separate products. No action.

---

## Verified collision inventory (fresh commands, 2026-07-13)

Already separated (keep, do not touch): plugin name `memsmith`, marketplace
`shshalom`, data dir `~/.memsmith`, settings prefix `MEMSMITH_`, MCP server name
`mem`, embedded PG port `55433` (MemSmith-unique), hook path resolution
(`shshalom/memsmith`).

### Class 1 — ports (source: `src/shared/SettingsDefaultsManager.ts`)
| Key / const | File:line | Current | New |
| `MEMSMITH_WORKER_PORT` | SettingsDefaultsManager.ts:93 | `37700 + uid%100` | `38700 + uid%100` |
| `MEMSMITH_QUEUE_REDIS_PREFIX` | SettingsDefaultsManager.ts:153 | `memsmith_${37700 + uid%100}` | `memsmith_${38700 + uid%100}` |
| `MEMSMITH_SERVER_URL` | SettingsDefaultsManager.ts:159 | `37877 + uid%100` | `38877 + uid%100` |
| `MEMSMITH_SERVER_BETA_URL` | SettingsDefaultsManager.ts:162 | `37877 + uid%100` | `38877 + uid%100` |
| `DEFAULT_SERVER_PORT` | src/server/runtime/ServerService.ts:34 | `37877` | `38877` |
| `DEFAULT_SERVER_RUNTIME_BASE_URL` | src/npx-cli/commands/install.ts:804 | `http://127.0.0.1:37877` | `http://127.0.0.1:38877` |
| local runtime port fallback | src/npx-cli/commands/install.ts:1774 | `'37877'` | `'38877'` |

Scheme: **claude-mem + 1000**. Same uid-isolation math, memorable offset. Worker/
dashboard band → `387xx`; server-runtime band → `388xx`.

### Class 2 — skills (source: `plugin/skills/`, 17 dirs; NO `plugin/commands/`)
Scheme: **`ms-` prefix** on every skill. New names:
`ms-babysit, ms-design-is, ms-do, ms-how-it-works, ms-knowledge-agent,
ms-learn-codebase, ms-make-plan, ms-mem-search, ms-oh-my-issues, ms-pathfinder,
ms-smart-explore, ms-standup, ms-timeline-report, ms-version-bump,
ms-weekly-digests, ms-what-the, ms-wowerpoint`.

Rename = directory rename + the skill's `name:` frontmatter in each `SKILL.md`.
Internal cross-references (a skill invoking another by name) MUST update in
lockstep. Files with cross-refs (verified via grep): `pathfinder/SKILL.md`,
`standup/SKILL.md`, `standup/standup.mjs`, `design-is/SKILL.md`,
`how-it-works/onboarding-explainer.md`, `how-it-works/SKILL.md`,
`mem-search/SKILL.md`, `wowerpoint/SKILL.md`. The plan re-greps after renaming to
catch any straggler references.

### Class 3 — identity/branding (source files only; `.cjs` is a build artifact)
All become **MemSmith** (self-name) / **memsmith** (identifier form):
| File:line | Current leak | Fix |
| plugin/hooks/hooks.json:2 | `"description": "Claude-mem memory system hooks"` | `"MemSmith memory system hooks"` |
| plugin/modes/meme-tokens.json:87 | `"You are Claude-Mem, ..."` | `"You are MemSmith, ..."` |
| plugin/modes/email-investigation.json:82 | `"You are a Claude-Mem, ..."` | `"You are MemSmith, ..."` |
| plugin/modes/law-study.json:82 | `"You are Claude-Mem, ..."` | `"You are MemSmith, ..."` |
| src/servers/mcp-server.ts:723 | `'Claude-mem search server started'` | `'MemSmith search server started'` |
| src/npx-cli/commands/install.ts:589 | `'...Claude-mem works best in Claude Code...'` | `'...MemSmith works best in Claude Code...'` |
| src/services/integrations/CursorHooksInstaller.ts:239 | `"Claude-mem context from past sessions..."` | `"MemSmith context from past sessions..."` |
| src/utils/cursor-utils.ts:73 | `"Claude-mem context from past sessions..."` | `"MemSmith context from past sessions..."` |
| src/ui/viewer/components/Header.tsx:61 | `href="https://x.com/Claude_Memory"` | `href="https://github.com/shshalom/memsmith"` (MemSmith's own repo, per plugin.json) |
| src/ui/viewer/views/ObservationsView.tsx:8 | `Claude-Mem` reference | `MemSmith` |

`plugin/scripts/mcp-server.cjs:243` is a BUILD ARTIFACT regenerated from
`src/servers/mcp-server.ts`. Do NOT hand-edit; rebuild after fixing source.

EXCLUDED from renaming (legitimate references to the OTHER product — keep as-is):
`scripts/migrate-claude-mem.ts`, `src/server/runtime/import/sqliteReader.ts`
(migration reads claude-mem's DB — must keep the real name), any `compat/`
migration path. These name claude-mem *correctly* because they interoperate with
it.

---

## Architecture / data flow

No data-flow changes. This is a rename/re-base spec: identifiers change value,
behavior does not. The only runtime-observable effects:

1. MemSmith services bind to new ports (`387xx`/`388xx`). Existing running
   services on old ports must be restarted to pick up the new band. The live
   `~/.memsmith/settings.json` has hard-coded `MEMSMITH_SERVER_URL` /
   `MEMSMITH_WORKER_PORT` values from the OLD band — these must be updated (or
   cleared so defaults regenerate) as part of deployment, or the new code will
   still talk to old ports. Plan handles this explicitly.
2. Skill invocation names change (`/ms-*`). User muscle-memory changes; documented.
3. Observer prompts self-identify as MemSmith. Newly generated observations will
   reflect the corrected identity; existing observations are unaffected.

## Error handling

- Port re-base: if an old-band port is still held by a stale MemSmith process at
  deploy time, restart resolves it. No new error paths.
- Skill rename: Claude Code discovers skills by directory; a renamed dir with
  matching frontmatter registers cleanly. Risk is a *dangling cross-reference*
  (skill A says "use /old-name") — mitigated by the lockstep cross-ref update +
  post-rename re-grep gate.

## Testing

- **Class 1:** unit test asserting MemSmith's derived worker/server ports differ
  from claude-mem's formula (`38700+`/`38877+`, not `37700+`/`37877+`); assert no
  MemSmith default resolves into the `377xx` band. Extend
  `SettingsDefaultsManager` tests.
- **Class 2:** a namespace-safety test (mirroring the existing
  `mcp-server-name-safety.test.ts` pattern) asserting every shipped skill dir
  name begins with `ms-`, and that no cross-reference to a bare (un-prefixed) old
  skill name remains in `plugin/skills/`.
- **Class 3:** a branding test asserting no source file under `src/` and `plugin/`
  (excluding the migration/compat allowlist and `.cjs` build artifacts) contains
  the string `Claude-Mem`/`Claude-mem`/`claude_mem` case-insensitively.
- Full build + `tsc --noEmit` clean; existing suite fail-count not exceeded.

## Acceptance criteria

1. `grep` for `37700`/`37877` port bases in MemSmith source returns only
   claude-mem-migration references (none in MemSmith's own port derivation).
2. All 17 skills are `ms-`-prefixed; no dangling cross-references.
3. No `Claude-Mem` self-identification anywhere in MemSmith source (migration/
   compat allowlist excepted); observer prompts say "You are MemSmith."
4. Build clean; branding/port/namespace tests pass.
5. Live `~/.memsmith/settings.json` updated to the new port band; services
   restarted; MemSmith dashboard resolves to its own port, distinct from
   claude-mem's `:37702`.

## Deferred (separate specs, not this one)
- GAP-A: `buildServerContext` local-dev bypass (local read-back). Designed next.
- Stale `MEMSMITH_MODEL=claude-haiku` field cleanup (provider=ollama makes it
  inert; cosmetic).
