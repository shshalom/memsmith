# MemSmith Complete Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MemSmith completely distinguishable from claude-mem at every surface — ports, skill names, and self-identity — so the two products never collide when both run on the same machine.

**Architecture:** Pure rename/re-base. Three independent collision classes: (1) runtime ports re-based to MemSmith's own band, (2) all 17 skills prefixed `ms-`, (3) all "Claude-Mem" self-identification changed to "MemSmith". No behavioral/data-flow changes. Each class is one task with its own guard test; a final task builds and re-points the live machine.

**Tech Stack:** TypeScript, Bun (test runner + build), Node, React (viewer UI), Claude Code plugin (skills as directories with `SKILL.md` frontmatter).

**Spec:** `docs/superpowers/specs/2026-07-13-complete-separation-design.md`

## Global Constraints

- **Never rename keep-list deps:** `claude-code`, `claude-agent`, `@anthropic-ai/*` must not be touched. These are legitimate ecosystem names, not MemSmith identity.
- **Do NOT rename legitimate references to the OTHER product.** These name claude-mem *correctly* because they interoperate with or contrast against it — keep verbatim: `scripts/migrate-claude-mem.ts`, `src/server/runtime/import/sqliteReader.ts`, any `src/server/compat/` path, and the explanatory code comment at `src/ui/viewer/views/ObservationsView.tsx:8` ("NOT the legacy claude-mem set").
- **`.cjs` files under `plugin/scripts/` are BUILD ARTIFACTS.** Never hand-edit them; they regenerate from `src/`. Only Task 4 rebuilds them.
- **Port scheme:** MemSmith = claude-mem + 1000. Worker/dashboard band `38700 + uid%100`; server-runtime band `38877 + uid%100`. Do not use `377xx`/`378xx` (claude-mem's bands).
- **Skill scheme:** every skill directory + its `name:` frontmatter gets the `ms-` prefix. No exceptions among the 17.
- **Self-identity:** MemSmith speaks its own name — "You are MemSmith", "MemSmith memory system hooks", "MemSmith search server started". Never "Claude-Mem" for MemSmith's own identity.
- **Bun clean-env for commands:** `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun ...` (Bun is not otherwise on PATH under the harness).
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Branch `embedded-pg-local-runtime`. Nothing pushed.

---

### Task 1: Re-base runtime ports to MemSmith's own band

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts` (lines 93, 153, 159, 162)
- Modify: `src/server/runtime/ServerService.ts:34`
- Modify: `src/npx-cli/commands/install.ts` (lines 804, 1774)
- Test: `tests/shared/settings-port-separation.test.ts` (create)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks depend on (ports are internal defaults).

- [ ] **Step 1: Write the failing test**

Create `tests/shared/settings-port-separation.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

// MemSmith must never derive a port in claude-mem's bands (377xx worker / 378xx
// server). claude-mem uses 37700+uid%100 and 37877+uid%100; MemSmith uses
// 38700+uid%100 and 38877+uid%100 (claude-mem + 1000). Same-machine collision
// with claude-mem's dashboard/server is the bug this guards against.
describe('port separation from claude-mem', () => {
  const uid = process.getuid?.() ?? 77;
  const defaults = SettingsDefaultsManager.getAllDefaults();

  it('worker port is in the 387xx band, not claude-mem 377xx', () => {
    expect(defaults.MEMSMITH_WORKER_PORT).toBe(String(38700 + (uid % 100)));
    expect(Number(defaults.MEMSMITH_WORKER_PORT)).toBeGreaterThanOrEqual(38700);
    expect(Number(defaults.MEMSMITH_WORKER_PORT)).toBeLessThan(38800);
  });

  it('server runtime URL uses the 388xx band, not claude-mem 378xx', () => {
    const port = new URL(defaults.MEMSMITH_SERVER_URL).port;
    expect(port).toBe(String(38877 + (uid % 100)));
    expect(defaults.MEMSMITH_SERVER_BETA_URL).toBe(defaults.MEMSMITH_SERVER_URL);
  });

  it('redis prefix embeds the new worker port', () => {
    expect(defaults.MEMSMITH_QUEUE_REDIS_PREFIX).toBe(`memsmith_${38700 + (uid % 100)}`);
  });

  it('no default value contains a claude-mem port base', () => {
    const all = JSON.stringify(defaults);
    expect(all).not.toContain('37700');
    expect(all).not.toContain('37877');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/shared/settings-port-separation.test.ts`
Expected: FAIL — current defaults still produce `37700`/`37877`.

- [ ] **Step 3: Re-base the ports in `SettingsDefaultsManager.ts`**

Line 93 — worker port:
```typescript
    MEMSMITH_WORKER_PORT: String(38700 + ((process.getuid?.() ?? 77) % 100)),
```
Line 153 — redis prefix (keep the env fallback, only change the numeric base):
```typescript
    MEMSMITH_QUEUE_REDIS_PREFIX: `memsmith_${process.env.MEMSMITH_WORKER_PORT ?? String(38700 + ((process.getuid?.() ?? 77) % 100))}`,
```
Line 159 — server URL:
```typescript
    MEMSMITH_SERVER_URL: `http://127.0.0.1:${process.env.MEMSMITH_SERVER_PORT ?? String(38877 + ((process.getuid?.() ?? 77) % 100))}`,  // Default server runtime URL — UID-derived for multi-account isolation
```
Line 162 — server beta URL:
```typescript
    MEMSMITH_SERVER_BETA_URL: `http://127.0.0.1:${process.env.MEMSMITH_SERVER_PORT ?? String(38877 + ((process.getuid?.() ?? 77) % 100))}`,  // Legacy server-beta runtime URL — UID-derived for multi-account isolation
```

- [ ] **Step 4: Re-base the constants in `ServerService.ts` and `install.ts`**

`src/server/runtime/ServerService.ts:34`:
```typescript
const DEFAULT_SERVER_PORT = 38877;
```
`src/npx-cli/commands/install.ts:804`:
```typescript
const DEFAULT_SERVER_RUNTIME_BASE_URL = 'http://127.0.0.1:38877';
```
`src/npx-cli/commands/install.ts:1774` (fallback literal in the `|| '...'`):
```typescript
  const localRuntimePort = new URL(localRuntimeBaseUrl).port || '38877';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/shared/settings-port-separation.test.ts`
Expected: PASS (4/4).

- [ ] **Step 6: Grep-verify no MemSmith source still derives a claude-mem port**

Run: `grep -rnE "3770[0-9]|37877" src/ --include="*.ts" | grep -v ".test.ts"`
Expected: ZERO matches (all MemSmith port derivation now on `387xx`/`388xx`).

- [ ] **Step 7: Commit**

```bash
git add src/shared/SettingsDefaultsManager.ts src/server/runtime/ServerService.ts src/npx-cli/commands/install.ts tests/shared/settings-port-separation.test.ts
git commit -m "$(printf 'fix(separation): re-base MemSmith ports off claude-mem band (387xx/388xx)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Prefix all 17 skills with `ms-`

**Files:**
- Rename (dir + `name:` frontmatter): all 17 dirs under `plugin/skills/`:
  `babysit, design-is, do, how-it-works, knowledge-agent, learn-codebase, make-plan, mem-search, oh-my-issues, pathfinder, smart-explore, standup, timeline-report, version-bump, weekly-digests, what-the, wowerpoint`
  → each becomes `ms-<name>`.
- Modify (internal cross-references): `plugin/skills/*/SKILL.md` and `plugin/skills/standup/standup.mjs`, `plugin/skills/how-it-works/onboarding-explainer.md` — any reference to a bare old skill name → `ms-`-prefixed.
- Test: `tests/plugin/skill-namespace-separation.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: the canonical `ms-`-prefixed skill names other docs/tests reference.

- [ ] **Step 1: Write the failing test**

Create `tests/plugin/skill-namespace-separation.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

// Every MemSmith skill must be ms-prefixed so it never collides with a
// claude-mem skill of the same base name when both plugins load. This guards
// both the directory name AND the `name:` frontmatter, which must agree.
const SKILLS_DIR = join(import.meta.dir, '..', '..', 'plugin', 'skills');

describe('skill namespace separation (ms- prefix)', () => {
  const dirs = readdirSync(SKILLS_DIR).filter(d =>
    statSync(join(SKILLS_DIR, d)).isDirectory());

  it('has the expected 17 skills, all ms-prefixed', () => {
    expect(dirs.length).toBe(17);
    for (const d of dirs) expect(d.startsWith('ms-')).toBe(true);
  });

  it('each SKILL.md name: frontmatter matches its ms- directory name', () => {
    for (const d of dirs) {
      const skillMd = join(SKILLS_DIR, d, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const src = readFileSync(skillMd, 'utf-8');
      const m = src.match(/^name:\s*(\S+)\s*$/m);
      expect(m, `${d}/SKILL.md missing name:`).toBeTruthy();
      expect(m![1]).toBe(d);
    }
  });

  it('no SKILL.md references a bare (un-prefixed) old skill name via slash-command', () => {
    // After renaming, any "/mem-search"-style reference to another skill must be
    // "/ms-mem-search". Catch stragglers: a "/<oldname>" not preceded by "ms-".
    const OLD = ['mem-search','timeline-report','how-it-works','smart-explore',
      'learn-codebase','standup','babysit','design-is','knowledge-agent',
      'make-plan','oh-my-issues','pathfinder','version-bump','weekly-digests',
      'what-the','wowerpoint'];
    for (const d of dirs) {
      const skillMd = join(SKILLS_DIR, d, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const src = readFileSync(skillMd, 'utf-8');
      for (const old of OLD) {
        const bareSlash = new RegExp(`/${old}\\b`, 'g');
        for (const match of src.matchAll(bareSlash)) {
          const idx = match.index ?? 0;
          const preceding = src.slice(Math.max(0, idx - 3), idx);
          expect(preceding.endsWith('ms-'),
            `${d}/SKILL.md has bare /${old} (must be /ms-${old})`).toBe(true);
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/plugin/skill-namespace-separation.test.ts`
Expected: FAIL — dirs are not ms-prefixed.

- [ ] **Step 3: Rename all 17 skill directories**

```bash
cd plugin/skills
for s in babysit design-is do how-it-works knowledge-agent learn-codebase make-plan mem-search oh-my-issues pathfinder smart-explore standup timeline-report version-bump weekly-digests what-the wowerpoint; do
  git mv "$s" "ms-$s"
done
```

- [ ] **Step 4: Update the `name:` frontmatter in each renamed SKILL.md**

For every `plugin/skills/ms-<name>/SKILL.md`, change the frontmatter `name:` to match. Example (`ms-mem-search/SKILL.md`):
```
name: ms-mem-search
```
Do this for all 17. Verify none was missed:
```bash
for d in plugin/skills/ms-*; do
  n=$(basename "$d"); grep -q "^name: $n\$" "$d/SKILL.md" || echo "MISMATCH: $d";
done
```
Expected: no MISMATCH lines.

- [ ] **Step 5: Update internal cross-references**

Re-grep for any bare old-name slash reference inside the renamed skills and prefix it:
```bash
grep -rnE "/(mem-search|timeline-report|how-it-works|smart-explore|learn-codebase|standup|babysit|design-is|knowledge-agent|make-plan|oh-my-issues|pathfinder|version-bump|weekly-digests|what-the|wowerpoint)\b" plugin/skills/ | grep -v "/ms-"
```
For each hit, replace `/<oldname>` with `/ms-<oldname>` in that file. Known files with cross-refs (from the spec): `ms-pathfinder/SKILL.md`, `ms-standup/SKILL.md`, `ms-standup/standup.mjs`, `ms-design-is/SKILL.md`, `ms-how-it-works/onboarding-explainer.md`, `ms-how-it-works/SKILL.md`, `ms-mem-search/SKILL.md`, `ms-wowerpoint/SKILL.md`. Re-run the grep until it returns nothing (excluding already-`/ms-` hits).

- [ ] **Step 6: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/plugin/skill-namespace-separation.test.ts`
Expected: PASS (3/3).

- [ ] **Step 7: Commit**

```bash
git add plugin/skills tests/plugin/skill-namespace-separation.test.ts
git commit -m "$(printf 'fix(separation): prefix all 17 skills with ms- to avoid claude-mem collision\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Replace all "Claude-Mem" self-identity with "MemSmith"

**Files:**
- Modify: `plugin/hooks/hooks.json:2`
- Modify: `plugin/modes/meme-tokens.json:87`, `plugin/modes/email-investigation.json:82`, `plugin/modes/law-study.json:82`
- Modify: `src/servers/mcp-server.ts:723`
- Modify: `src/npx-cli/commands/install.ts:589`
- Modify: `src/services/integrations/CursorHooksInstaller.ts:239`
- Modify: `src/utils/cursor-utils.ts:73`
- Modify: `src/ui/viewer/components/Header.tsx:61`
- Test: `tests/branding/no-claude-mem-self-identity.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `tests/branding/no-claude-mem-self-identity.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// MemSmith must not identify ITSELF as Claude-Mem anywhere. Legitimate
// references to the OTHER product (migration, compat, contrastive comments)
// are allowlisted — they name claude-mem correctly because they interoperate
// with or contrast against it.
const ROOT = join(import.meta.dir, '..', '..');
const ALLOWLIST = [
  'scripts/migrate-claude-mem.ts',
  'src/server/runtime/import/sqliteReader.ts',
  'src/server/compat/',
  'src/ui/viewer/views/ObservationsView.tsx', // explanatory comment: "NOT the legacy claude-mem set"
];

describe('no Claude-Mem self-identity', () => {
  it('src/ and plugin/ contain no un-allowlisted claude-mem string', () => {
    // ripgrep-style scan via git grep; case-insensitive; source + shipped plugin
    // config (exclude .cjs build artifacts and node_modules).
    let out = '';
    try {
      out = execSync(
        `git grep -niE "claude-mem|claude_mem|claudemem" -- 'src/**/*.ts' 'src/**/*.tsx' 'plugin/**/*.json' ':!plugin/scripts/*.cjs'`,
        { cwd: ROOT, encoding: 'utf-8' });
    } catch (e: any) {
      // git grep exits 1 when there are no matches — that's the pass case.
      if (e.status === 1) out = '';
      else throw e;
    }
    const offending = out.split('\n').filter(Boolean).filter(line => {
      const file = line.split(':')[0];
      return !ALLOWLIST.some(alw => file.startsWith(alw) || file.includes(alw));
    });
    expect(offending, `un-allowlisted claude-mem refs:\n${offending.join('\n')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/branding/no-claude-mem-self-identity.test.ts`
Expected: FAIL — lists the leak lines below.

- [ ] **Step 3: Fix `plugin/hooks/hooks.json:2`**

```json
  "description": "MemSmith memory system hooks",
```

- [ ] **Step 4: Fix the three observer `system_identity` prompts**

`plugin/modes/meme-tokens.json:87` — change the opening clause only:
```
"system_identity": "You are MemSmith, a specialized observer for Solana memecoin trading activity.\n\n...
```
`plugin/modes/email-investigation.json:82` (note: fix the "a Claude-Mem" grammar too):
```
"system_identity": "You are MemSmith, a specialized observer tool for creating searchable memory FOR FUTURE SESSIONS.\n\n...
```
`plugin/modes/law-study.json:82`:
```
"system_identity": "You are MemSmith, a specialized observer tool for creating searchable memory FOR FUTURE SESSIONS.\n\n...
```
Preserve the rest of each string exactly (only the "You are [a] Claude-Mem" clause changes).

- [ ] **Step 5: Fix the source code/log/UI leaks**

`src/servers/mcp-server.ts:723`:
```typescript
  logger.info('SYSTEM', 'MemSmith search server started');
```
`src/npx-cli/commands/install.ts:589`:
```typescript
    log.warn('Claude Code is not installed. MemSmith works best in Claude Code, but also works with the IDEs below.');
```
`src/services/integrations/CursorHooksInstaller.ts:239` and `src/utils/cursor-utils.ts:73` (identical string in both):
```
description: "MemSmith context from past sessions (auto-updated)"
```
`src/ui/viewer/components/Header.tsx:61`:
```tsx
          href="https://github.com/shshalom/memsmith"
```

- [ ] **Step 6: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test tests/branding/no-claude-mem-self-identity.test.ts`
Expected: PASS (1/1). If it flags `ObservationsView.tsx`, confirm the allowlist entry covers it (it should — that's a contrastive comment, not self-identity).

- [ ] **Step 7: Commit**

```bash
git add plugin/hooks/hooks.json plugin/modes/meme-tokens.json plugin/modes/email-investigation.json plugin/modes/law-study.json src/servers/mcp-server.ts src/npx-cli/commands/install.ts src/services/integrations/CursorHooksInstaller.ts src/utils/cursor-utils.ts src/ui/viewer/components/Header.tsx tests/branding/no-claude-mem-self-identity.test.ts
git commit -m "$(printf 'fix(separation): MemSmith self-identifies as MemSmith, not Claude-Mem\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Build, verify, and re-point the live machine to the new ports

**Files:**
- Modify (live, not committed): `~/.memsmith/settings.json` (port fields from old band)
- Build outputs: `plugin/scripts/*.cjs`, `plugin/` synced to `~/.claude/plugins/...`

**Interfaces:**
- Consumes: the re-based ports (Task 1), renamed skills (Task 2), and branding fixes (Task 3) — all must be committed before this task.
- Produces: a running MemSmith on the new `387xx`/`388xx` band, distinct from claude-mem's `377xx`.

- [ ] **Step 1: Full typecheck (including tests)**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -v "bun:test\|node_modules"`
Expected: empty (no type errors).

- [ ] **Step 2: Build + sync to marketplace + restart**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin npm run build-and-sync`
Expected: build succeeds; plugin synced; server restarts. This regenerates `plugin/scripts/*.cjs` from the fixed source (so the `mcp-server.cjs` log line now reads "MemSmith search server started").

- [ ] **Step 3: Verify the shipped bundle picked up the branding fix**

Run: `grep -c "MemSmith search server started" plugin/scripts/mcp-server.cjs; grep -c "Claude-mem search server started" plugin/scripts/mcp-server.cjs`
Expected: first `1` (or more), second `0`.

- [ ] **Step 4: Re-point the live settings off the old port band**

The live `~/.memsmith/settings.json` has hard-coded old-band values (`MEMSMITH_SERVER_URL` on `37879`, `MEMSMITH_WORKER_PORT` `37702`). Clear them so the new defaults regenerate on next boot (safer than hand-editing to the new number). Back up first:

```bash
cp ~/.memsmith/settings.json ~/.memsmith/settings.json.pre-port-rebase.bak
```

Then, in `~/.memsmith/settings.json`, set these three fields to empty string so the defaults recompute (the loader fills empties from `SettingsDefaultsManager` defaults, which are now `388xx`/`387xx`):
- `MEMSMITH_SERVER_URL: ""`
- `MEMSMITH_SERVER_BETA_URL: ""`
- `MEMSMITH_WORKER_PORT: ""`

(Do NOT touch the project override `MemSmith/.claude/settings.json` — it only sets `MEMSMITH_RUNTIME=local`, no ports.)

- [ ] **Step 5: Restart the runtime and confirm the new port**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun run src/services/local-runtime-cli.ts stop 2>/dev/null; sleep 1; lsof -nP -iTCP -sTCP:LISTEN | grep -E "3870[0-9]|3880[0-9]|3887[0-9]"`
Expected: after the next SessionStart (or an explicit `start`), MemSmith listens on a `387xx`/`388xx` port. Confirm nothing MemSmith-owned remains on `37702`/`37879`.

- [ ] **Step 6: Full suite regression check**

Run: `env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin ~/.bun/bin/bun test 2>&1 | tail -20`
Expected: the three new tests pass; no NEW failures beyond the known pre-existing set (adaptObservation, spawn-env, request_id ×3 per the deadroute-sweep brief). Report exact counts.

- [ ] **Step 7: Commit any build artifacts that changed**

```bash
git add plugin/
git commit -m "$(printf 'chore(separation): rebuild plugin bundle with re-based ports + branding\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

(Live `~/.memsmith/settings.json` changes are machine-local and not committed.)

---

## Notes for the executor

- Tasks 1–3 are independent (different files, no shared symbols) and each has its own guard test. Task 4 depends on all three being committed.
- The MCP server name (`mem`), plugin name (`memsmith`), marketplace (`shshalom`), data dir (`~/.memsmith`), and settings prefix (`MEMSMITH_`) are ALREADY separated — do not touch them.
- If any grep in Task 1 Step 6 or Task 2 Step 5 still returns hits after fixes, that's a real straggler — fix it, don't suppress the grep.
