# MemSmith Retrieval-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make consulting MemSmith memory the agent's first action for why/decision questions — as core, on-by-default behavior covering both main agents and sub-agents — by adding a unified RetrievalBroker plus thin hook adapters over the existing `/v1/context` engine.

**Architecture:** A new `RetrievalBroker` (`src/services/retrieval/`) owns all memory-consultation logic (query, provenance-tag, session-dedup, gap-flag, enforcement policy). Thin hook adapters (`UserPromptSubmit`, `PreToolUse`, `PreToolUse:Agent`, plus a directive injected at `SessionStart`) call the broker; the broker calls `ServerClient.contextObservations()` (`/v1/context`, hybrid RRF ranking). Everything runs hook-side and fails open.

**Tech Stack:** TypeScript, Bun (`bun test`), Postgres via existing `ServerClient`, Claude Code hooks (`hooks.json`).

## Global Constraints

- **On by default:** `MEMSMITH_SEMANTIC_INJECT` default flips `'false'` → `'true'`. Retrieval-first is never gated behind a discovery step.
- **Fail open, always:** any failure (server down, timeout, missing key, corrupt state) degrades to "agent proceeds normally, no memory assist this turn." NEVER block the agent on retrieval-first's own error. Loud in logs, invisible to the agent's ability to proceed.
- **Latency wins:** hot-path calls are bounded by `MEMSMITH_RETRIEVAL_TIMEOUT_MS` (default `2000`).
- **"Strong hit" is COUNT-based, not score-based:** the hybrid path uses RRF (rank fusion) and `/v1/context` exposes no per-result score. A strong hit = `/v1/context` returned `≥ MEMSMITH_RETRIEVAL_MIN_HITS` results (default `1`). Fewer = miss → gap-flag.
- **Complete separation:** MemSmith-native. Do NOT port claude-mem code. Reference MemSmith's `ms-mem-search` MCP tools and `/v1/context` only.
- **Reuse proven pieces:** `ServerClient.contextObservations()`, `resolveRuntimeContext()`, the `EventHandler` pattern, and the credential-store key path fixed earlier.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Never commit to main:** work happens on the `retrieval-first` branch (already created).
- **Verification is OUT of scope** (deferred spec). Inject provenance-tagged, do NOT verify claims on the hot path.

---

## File Structure

**New files:**
- `src/services/retrieval/types.ts` — shared types (`ProvenancedMemory`, `RetrievalResult`, `EnforcementMode`, `BrokerDeps`).
- `src/services/retrieval/session-store.ts` — per-session dedup file (`~/.memsmith/sessions/<sessionId>/shown.json`).
- `src/services/retrieval/directive.ts` — the authored memory-first directive text + framing helper.
- `src/services/retrieval/query-derivation.ts` — `deriveQueryFromTool(toolName, toolArgs)` + `SEARCH_INTENT_TOOLS`.
- `src/services/retrieval/broker.ts` — the `RetrievalBroker` class (`forPrompt`, `forToolIntent`).
- `src/cli/handlers/prompt-injection.ts` — `UserPromptSubmit` adapter (A).
- `src/cli/handlers/tool-intent.ts` — `PreToolUse` adapter (C).
- `src/cli/handlers/agent-directive.ts` — `PreToolUse:Agent` adapter (B propagation).
- Tests mirror each under `tests/retrieval/` and `tests/cli/handlers/`.

**Modified files:**
- `src/shared/SettingsDefaultsManager.ts` — flip `MEMSMITH_SEMANTIC_INJECT`, add `MEMSMITH_RETRIEVAL_MIN_HITS`, `MEMSMITH_RETRIEVAL_TIMEOUT_MS`, `MEMSMITH_RETRIEVAL_ENFORCEMENT`.
- `src/cli/handlers/index.ts` — register three new handlers.
- `src/cli/handlers/session-init.ts` — inject directive text at the SessionStart path (B main-agent baseline). NOTE: SessionStart currently routes to the `context` handler; directive injection is added there (Task 9).
- `plugin/hooks/hooks.json` — wire `UserPromptSubmit`→`prompt-injection`, add `PreToolUse` matchers for search tools →`tool-intent` and for `Agent`/`Task`→`agent-directive`. (Synced to marketplace by `build-and-sync`.)
- `CLAUDE.md` (project) — add the directive baseline text (B sub-agent baseline).

**Interfaces reference (verbatim from current code — implementers consume these):**
- `ServerClient.contextObservations(input: { projectId: string; query: string; limit?: number; platformSource?: string | null }): Promise<{ observations: Array<{ id: string; projectId: string; content: string; [k: string]: unknown }>; context: string }>`
- `resolveRuntimeContext(): RuntimeContext` where a server context is `{ runtime: 'server'; client: ServerClient; projectId: string; serverBaseUrl: string }` and otherwise `{ runtime: 'local'; reason: string }`.
- `EventHandler = { execute(input: NormalizedHookInput): Promise<HookResult> }`
- `NormalizedHookInput` fields used: `sessionId`, `cwd`, `prompt?`, `toolName?`, `toolInput?`, `agentId?`, `agentType?`, `platform?`.
- `HookResult.hookSpecificOutput = { hookEventName: string; additionalContext: string; permissionDecision?: 'allow'|'deny'; permissionDecisionReason?: string }`

---

### Task 1: Retrieval settings

**Files:**
- Modify: `src/shared/SettingsDefaultsManager.ts` (interface ~line 53; defaults block ~line 136)
- Test: `tests/shared/retrieval-settings.test.ts`

**Interfaces:**
- Produces: settings keys `MEMSMITH_SEMANTIC_INJECT` (now `'true'`), `MEMSMITH_RETRIEVAL_MIN_HITS` (`'1'`), `MEMSMITH_RETRIEVAL_TIMEOUT_MS` (`'2000'`), `MEMSMITH_RETRIEVAL_ENFORCEMENT` (`'soft'`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/shared/retrieval-settings.test.ts
import { describe, it, expect } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('retrieval-first settings defaults', () => {
  it('semantic inject is ON by default (core behavior)', () => {
    const d = SettingsDefaultsManager.getAllDefaults();
    expect(d.MEMSMITH_SEMANTIC_INJECT).toBe('true');
  });
  it('exposes retrieval knobs with correct defaults', () => {
    const d = SettingsDefaultsManager.getAllDefaults();
    expect(d.MEMSMITH_RETRIEVAL_MIN_HITS).toBe('1');
    expect(d.MEMSMITH_RETRIEVAL_TIMEOUT_MS).toBe('2000');
    expect(d.MEMSMITH_RETRIEVAL_ENFORCEMENT).toBe('soft');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/shared/retrieval-settings.test.ts`
Expected: FAIL — `MEMSMITH_SEMANTIC_INJECT` is `'false'`; new keys undefined.

- [ ] **Step 3: Implement**

In the `SettingsDefaults` interface (near line 53), add after `MEMSMITH_SEMANTIC_INJECT_LIMIT`:
```typescript
  MEMSMITH_RETRIEVAL_MIN_HITS: string;
  MEMSMITH_RETRIEVAL_TIMEOUT_MS: string;
  MEMSMITH_RETRIEVAL_ENFORCEMENT: string;  // 'soft' | 'hard'
```
In the defaults block (near line 136), change the `MEMSMITH_SEMANTIC_INJECT` line and add the new keys:
```typescript
    MEMSMITH_SEMANTIC_INJECT: 'true',              // Retrieval-first is core: inject relevant memory on every UserPromptSubmit
    MEMSMITH_SEMANTIC_INJECT_LIMIT: '5',           // Top-N most relevant observations to inject per prompt
    MEMSMITH_RETRIEVAL_MIN_HITS: '1',              // Min /v1/context results to count as a "strong hit" (else gap)
    MEMSMITH_RETRIEVAL_TIMEOUT_MS: '2000',         // Hot-path timeout; on timeout, proceed with no injection
    MEMSMITH_RETRIEVAL_ENFORCEMENT: 'soft',        // 'soft' = inject-only; 'hard' = block-eligible on strong hit
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/shared/retrieval-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/SettingsDefaultsManager.ts tests/shared/retrieval-settings.test.ts
git commit -m "feat(retrieval): add retrieval-first settings; semantic inject on by default

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Shared retrieval types

**Files:**
- Create: `src/services/retrieval/types.ts`
- Test: none (pure types; validated by consumers in later tasks).

**Interfaces:**
- Produces:
  - `type EnforcementMode = 'soft' | 'hard'`
  - `interface ProvenancedMemory { id: string; content: string; obsType: string | null; capturedAt: string | null }`
  - `interface RetrievalResult { additionalContext: string; block: boolean; blockReason?: string; hitCount: number; isGap: boolean }`
  - `interface BrokerDeps { runtime: RuntimeContext; settings: Record<string, string>; sessionId: string; nowIso: string }`

- [ ] **Step 1: Create the types file**

```typescript
// src/services/retrieval/types.ts
import type { RuntimeContext } from '../hooks/runtime-selector.js';

export type EnforcementMode = 'soft' | 'hard';

/** A memory result tagged with provenance for authoritative-but-verifiable framing. */
export interface ProvenancedMemory {
  id: string;
  content: string;
  obsType: string | null;
  capturedAt: string | null;
}

/** The broker's decision for one prompt or tool-intent. */
export interface RetrievalResult {
  /** Text to inject as hookSpecificOutput.additionalContext (may be ''). */
  additionalContext: string;
  /** Hard-mode only: whether to deny the tool once and require a memory consult. */
  block: boolean;
  blockReason?: string;
  /** How many results /v1/context returned for the query. */
  hitCount: number;
  /** True when hitCount < MIN_HITS (a gap was flagged). */
  isGap: boolean;
}

/** Everything the broker needs, injected so it stays testable with fakes. */
export interface BrokerDeps {
  runtime: RuntimeContext;
  settings: Record<string, string>;
  sessionId: string;
  /** ISO timestamp; injected (not read from clock) so tests are deterministic. */
  nowIso: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "src/services/retrieval/types.ts" || echo "clean"`
Expected: `clean`.

- [ ] **Step 3: Commit**

```bash
git add src/services/retrieval/types.ts
git commit -m "feat(retrieval): shared broker types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Session dedup store

**Files:**
- Create: `src/services/retrieval/session-store.ts`
- Test: `tests/retrieval/session-store.test.ts`

**Interfaces:**
- Produces:
  - `class SessionShownStore { constructor(sessionId: string, baseDir?: string); readShown(): Set<string>; markShown(ids: string[]): void }`
  - File lives at `<baseDir>/<sessionId>/shown.json`, `baseDir` default `~/.memsmith/sessions`.
  - MUST NOT throw on corrupt/unwritable files — degrade to empty set / best-effort write.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/retrieval/session-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionShownStore } from '../../src/services/retrieval/session-store.js';

describe('SessionShownStore', () => {
  let base: string;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ms-sess-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('returns empty set when no file yet', () => {
    const s = new SessionShownStore('sess1', base);
    expect(s.readShown().size).toBe(0);
  });

  it('persists and reads back shown ids across instances', () => {
    new SessionShownStore('sess1', base).markShown(['a', 'b']);
    const shown = new SessionShownStore('sess1', base).readShown();
    expect(shown.has('a')).toBe(true);
    expect(shown.has('b')).toBe(true);
  });

  it('markShown is additive (union with existing)', () => {
    const s = new SessionShownStore('sess1', base);
    s.markShown(['a']); s.markShown(['b']);
    expect(s.readShown().size).toBe(2);
  });

  it('corrupt file degrades to empty set, never throws', () => {
    mkdirSync(join(base, 'sess2'), { recursive: true });
    writeFileSync(join(base, 'sess2', 'shown.json'), '{not json');
    const s = new SessionShownStore('sess2', base);
    expect(s.readShown().size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/retrieval/session-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/services/retrieval/session-store.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Per-session record of which observation ids the broker has already injected,
 *  so repeated hooks in one session don't re-inject the same memory. Persisted
 *  to a file because hooks are short-lived separate processes. Best-effort:
 *  never throws — a broken store degrades to "nothing shown yet". */
export class SessionShownStore {
  private readonly path: string;
  constructor(sessionId: string, baseDir: string = join(homedir(), '.memsmith', 'sessions')) {
    // Guard against path traversal from an odd sessionId.
    const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
    this.path = join(baseDir, safeId, 'shown.json');
  }
  readShown(): Set<string> {
    try {
      if (!existsSync(this.path)) return new Set();
      const arr = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown;
      return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set();
    } catch {
      return new Set();
    }
  }
  markShown(ids: string[]): void {
    try {
      const merged = this.readShown();
      for (const id of ids) merged.add(id);
      const dir = join(this.path, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.path, JSON.stringify([...merged]), 'utf-8');
    } catch {
      // best-effort; a failed write just means possible re-injection next turn
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/retrieval/session-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/retrieval/session-store.ts tests/retrieval/session-store.test.ts
git commit -m "feat(retrieval): per-session dedup store (fail-safe file)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Query derivation from tool intent

**Files:**
- Create: `src/services/retrieval/query-derivation.ts`
- Test: `tests/retrieval/query-derivation.test.ts`

**Interfaces:**
- Produces:
  - `const SEARCH_INTENT_TOOLS: ReadonlySet<string>` (Grep, Glob, Read)
  - `function deriveQueryFromTool(toolName: string, toolArgs: unknown): string | null` — returns the query string for a search-intent tool, or `null` if the tool is not search-intent (caller then skips interception).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/retrieval/query-derivation.test.ts
import { describe, it, expect } from 'bun:test';
import { deriveQueryFromTool } from '../../src/services/retrieval/query-derivation.js';

describe('deriveQueryFromTool', () => {
  it('Grep → the pattern', () => {
    expect(deriveQueryFromTool('Grep', { pattern: 'buildServerContext' })).toBe('buildServerContext');
  });
  it('Glob → the glob pattern', () => {
    expect(deriveQueryFromTool('Glob', { pattern: 'src/**/identity*.ts' })).toBe('src/**/identity*.ts');
  });
  it('Read → basename + dir terms of the file path', () => {
    const q = deriveQueryFromTool('Read', { file_path: '/x/y/runtime-selector.ts' });
    expect(q).toContain('runtime-selector');
  });
  it('Bash with grep → the search terms', () => {
    expect(deriveQueryFromTool('Bash', { command: 'grep -rn "missing_api_key" src' })).toContain('missing_api_key');
  });
  it('Bash without search → null (not search intent)', () => {
    expect(deriveQueryFromTool('Bash', { command: 'npm run build' })).toBeNull();
  });
  it('non-search tool → null', () => {
    expect(deriveQueryFromTool('Edit', { file_path: '/a.ts' })).toBeNull();
  });
  it('malformed args → null, never throws', () => {
    expect(deriveQueryFromTool('Grep', null)).toBeNull();
    expect(deriveQueryFromTool('Grep', {})).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/retrieval/query-derivation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/services/retrieval/query-derivation.ts
import { basename, dirname } from 'path';

/** Tools whose purpose is discovery/search — the ones retrieval-first intercepts.
 *  Bash is handled specially (only search commands count). */
export const SEARCH_INTENT_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob', 'Read', 'Bash']);

const BASH_SEARCH_PREFIX = /(^|\s)(grep|rg|ag|find)\b/;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** Derive a /v1/context query from a tool call, or null if the call is not a
 *  search-intent we should intercept. Never throws. */
export function deriveQueryFromTool(toolName: string, toolArgs: unknown): string | null {
  const args = asRecord(toolArgs);
  if (!args) return null;
  switch (toolName) {
    case 'Grep':
    case 'Glob': {
      const p = args.pattern;
      return typeof p === 'string' && p.length > 0 ? p : null;
    }
    case 'Read': {
      const fp = args.file_path;
      if (typeof fp !== 'string' || fp.length === 0) return null;
      // basename (sans extension) + parent dir name make decent query terms.
      const base = basename(fp).replace(/\.[^.]+$/, '');
      const dir = basename(dirname(fp));
      return `${base} ${dir}`.trim();
    }
    case 'Bash': {
      const cmd = args.command;
      if (typeof cmd !== 'string' || !BASH_SEARCH_PREFIX.test(cmd)) return null;
      // Extract quoted search term if present, else the whole command tail.
      const quoted = cmd.match(/["']([^"']+)["']/);
      return quoted ? quoted[1] : cmd.replace(BASH_SEARCH_PREFIX, ' ').trim();
    }
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/retrieval/query-derivation.test.ts`
Expected: PASS (7 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/services/retrieval/query-derivation.ts tests/retrieval/query-derivation.test.ts
git commit -m "feat(retrieval): derive /v1/context query from tool intent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: The memory-first directive text

**Files:**
- Create: `src/services/retrieval/directive.ts`
- Test: `tests/retrieval/directive.test.ts`

**Interfaces:**
- Produces:
  - `const MEMORY_FIRST_DIRECTIVE: string` — the standing instruction.
  - `function frameMemory(memories: ProvenancedMemory[]): string` — packs provenance-tagged memory into an injection block with the authoritative-but-verifiable framing.
  - `function frameGapNote(): string` — the on-miss note.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/retrieval/directive.test.ts
import { describe, it, expect } from 'bun:test';
import { MEMORY_FIRST_DIRECTIVE, frameMemory, frameGapNote } from '../../src/services/retrieval/directive.js';

describe('directive + framing', () => {
  it('directive names MemSmith memory as the FIRST source for why/decision questions', () => {
    expect(MEMORY_FIRST_DIRECTIVE).toContain('MemSmith');
    expect(MEMORY_FIRST_DIRECTIVE.toLowerCase()).toContain('first');
    expect(MEMORY_FIRST_DIRECTIVE.toLowerCase()).toMatch(/why|decision|rationale/);
    // MemSmith-native: must NOT reference claude-mem
    expect(MEMORY_FIRST_DIRECTIVE.toLowerCase()).not.toContain('claude-mem');
  });
  it('frameMemory tags provenance (obs_type + captured date + id) and marks verifiable', () => {
    const out = frameMemory([{ id: 'obs-1', content: 'We chose X because Y', obsType: 'decision', capturedAt: '2026-07-13T00:00:00Z' }]);
    expect(out).toContain('We chose X because Y');
    expect(out).toContain('decision');
    expect(out).toContain('2026-07-13');
    expect(out.toLowerCase()).toMatch(/verif/); // authoritative-but-verifiable framing present
  });
  it('frameMemory returns empty string for no memories', () => {
    expect(frameMemory([])).toBe('');
  });
  it('gap note flags missing rationale and says it will proceed to files', () => {
    expect(frameGapNote().toLowerCase()).toContain('no memsmith memory');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/retrieval/directive.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/services/retrieval/directive.ts
import type { ProvenancedMemory } from './types.js';

/** The standing retrieval-first directive. Injected at SessionStart (main agent),
 *  propagated into Task framing (sub-agents), and mirrored in CLAUDE.md. */
export const MEMORY_FIRST_DIRECTIVE = [
  'MEMORY-FIRST (MemSmith core behavior):',
  'For any question about WHY something was done, WHAT was decided, or the RATIONALE',
  'behind existing code — whether the user asks it or you ask it of yourself — consult',
  'MemSmith memory FIRST, before grepping or reading files. These answers usually already',
  'exist in memory and are not fully recoverable from code. Use the ms-mem-search tools',
  '(memory_search / observation_search / observation_context).',
  'Reference order: (1) MemSmith memory, (2) CLAUDE.md, (3) project specs, (4) raw file/code search.',
  'Only fall through to file search when memory genuinely lacks the answer.',
  'Treat recalled memory as authoritative-but-verifiable: it was true when captured; verify',
  'any load-bearing claim against current code before relying on it.',
].join('\n');

/** Pack provenance-tagged memory into an injection block. Empty when no memory. */
export function frameMemory(memories: ProvenancedMemory[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map(m => {
    const date = m.capturedAt ? m.capturedAt.slice(0, 10) : 'unknown-date';
    const type = m.obsType ?? 'observation';
    return `- [${type} · captured ${date} · ${m.id}] ${m.content}`;
  });
  return [
    'Relevant MemSmith memory (authoritative-but-verifiable — verify load-bearing claims against current code):',
    ...lines,
  ].join('\n');
}

/** On-miss note: memory had nothing for this query. */
export function frameGapNote(): string {
  return '⚠ No MemSmith memory found for this — the rationale may not have been captured. Proceeding to files/specs.';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/retrieval/directive.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/retrieval/directive.ts tests/retrieval/directive.test.ts
git commit -m "feat(retrieval): memory-first directive + provenance framing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: RetrievalBroker core

**Files:**
- Create: `src/services/retrieval/broker.ts`
- Test: `tests/retrieval/broker.test.ts`

**Interfaces:**
- Consumes: `ProvenancedMemory`, `RetrievalResult`, `EnforcementMode`, `BrokerDeps` (Task 2); `SessionShownStore` (Task 3); `deriveQueryFromTool`, `SEARCH_INTENT_TOOLS` (Task 4); `frameMemory`, `frameGapNote` (Task 5); `ServerClient.contextObservations` (existing).
- Produces:
  - `class RetrievalBroker { constructor(deps: BrokerDeps, store?: SessionShownStore); forPrompt(promptText: string): Promise<RetrievalResult>; forToolIntent(toolName: string, toolArgs: unknown): Promise<RetrievalResult> }`
  - Behavior: query `/v1/context` (timeout-bounded), dedup against store, provenance-tag, count-based hit test (`MIN_HITS`), gap-flag on miss, hard-mode block on strong-hit-not-yet-consulted. Fail open (returns empty non-blocking `RetrievalResult` on any error).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/retrieval/broker.test.ts
import { describe, it, expect } from 'bun:test';
import { RetrievalBroker } from '../../src/services/retrieval/broker.js';
import { SessionShownStore } from '../../src/services/retrieval/session-store.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function fakeRuntime(observations: Array<{ id: string; content: string; metadata?: any; obs_type?: string; created_at?: string }>, opts: { throws?: boolean } = {}) {
  return {
    runtime: 'server' as const,
    projectId: 'proj-1',
    serverBaseUrl: 'http://x',
    client: {
      contextObservations: async () => {
        if (opts.throws) throw new Error('server down');
        return { observations, context: observations.map(o => o.content).join('\n') };
      },
    } as any,
  };
}
const baseSettings = { MEMSMITH_RETRIEVAL_MIN_HITS: '1', MEMSMITH_RETRIEVAL_TIMEOUT_MS: '2000', MEMSMITH_SEMANTIC_INJECT_LIMIT: '5', MEMSMITH_RETRIEVAL_ENFORCEMENT: 'soft' };
const deps = (runtime: any, settings = baseSettings) => ({ runtime, settings, sessionId: 'sess-x', nowIso: '2026-07-15T00:00:00Z' });
function freshStore() { return new SessionShownStore('sess-x', mkdtempSync(join(tmpdir(), 'brk-'))); }

describe('RetrievalBroker.forPrompt', () => {
  it('injects provenance-tagged memory on a strong hit', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([{ id: 'o1', content: 'chose X because Y', obs_type: 'decision', created_at: '2026-07-10T00:00:00Z' }])), freshStore());
    const r = await b.forPrompt('why did we choose X?');
    expect(r.additionalContext).toContain('chose X because Y');
    expect(r.additionalContext).toContain('decision');
    expect(r.isGap).toBe(false);
    expect(r.block).toBe(false); // soft
  });

  it('gap-flags when result count < MIN_HITS', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([])), freshStore());
    const r = await b.forPrompt('why did we choose X?');
    expect(r.isGap).toBe(true);
    expect(r.additionalContext.toLowerCase()).toContain('no memsmith memory');
    expect(r.block).toBe(false);
  });

  it('dedups already-shown ids within a session', async () => {
    const store = freshStore();
    const rt = fakeRuntime([{ id: 'o1', content: 'first', obs_type: 'decision' }]);
    const b1 = new RetrievalBroker(deps(rt), store);
    await b1.forPrompt('q');
    const b2 = new RetrievalBroker(deps(rt), store);
    const r2 = await b2.forPrompt('q');
    expect(r2.additionalContext).toBe(''); // already shown → nothing new to inject
  });

  it('fails open when the server throws (no injection, no block, no throw)', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([], { throws: true })), freshStore());
    const r = await b.forPrompt('q');
    expect(r.additionalContext).toBe('');
    expect(r.block).toBe(false);
  });

  it('fails open when runtime is not server', async () => {
    const b = new RetrievalBroker(deps({ runtime: 'local', reason: 'x' } as any), freshStore());
    const r = await b.forPrompt('q');
    expect(r.additionalContext).toBe('');
    expect(r.block).toBe(false);
  });
});

describe('RetrievalBroker.forToolIntent', () => {
  it('non-search tool → no-op (no injection, no block)', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([{ id: 'o1', content: 'x' }])), freshStore());
    const r = await b.forToolIntent('Edit', { file_path: '/a.ts' });
    expect(r.additionalContext).toBe('');
    expect(r.block).toBe(false);
    expect(r.hitCount).toBe(0);
  });

  it('search tool + strong hit + soft → injects, never blocks', async () => {
    const b = new RetrievalBroker(deps(fakeRuntime([{ id: 'o1', content: 'port chosen here', obs_type: 'discovery' }])), freshStore());
    const r = await b.forToolIntent('Grep', { pattern: 'port' });
    expect(r.additionalContext).toContain('port chosen here');
    expect(r.block).toBe(false);
  });

  it('search tool + strong hit + hard → block once with reason', async () => {
    const hard = { ...baseSettings, MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' };
    const b = new RetrievalBroker(deps(fakeRuntime([{ id: 'o1', content: 'answer', obs_type: 'decision' }]), hard), freshStore());
    const r = await b.forToolIntent('Grep', { pattern: 'why' });
    expect(r.block).toBe(true);
    expect((r.blockReason ?? '').toLowerCase()).toContain('memsmith memory first');
  });

  it('hard mode NEVER blocks on a miss (fewer than MIN_HITS)', async () => {
    const hard = { ...baseSettings, MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' };
    const b = new RetrievalBroker(deps(fakeRuntime([]), hard), freshStore());
    const r = await b.forToolIntent('Grep', { pattern: 'why' });
    expect(r.block).toBe(false);
    expect(r.isGap).toBe(true);
  });

  it('hard mode fails OPEN (no block) when server errors', async () => {
    const hard = { ...baseSettings, MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' };
    const b = new RetrievalBroker(deps(fakeRuntime([], { throws: true }), hard), freshStore());
    const r = await b.forToolIntent('Grep', { pattern: 'why' });
    expect(r.block).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/retrieval/broker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/services/retrieval/broker.ts
import { SessionShownStore } from './session-store.js';
import { deriveQueryFromTool } from './query-derivation.js';
import { frameMemory, frameGapNote } from './directive.js';
import type { BrokerDeps, EnforcementMode, ProvenancedMemory, RetrievalResult } from './types.js';
import { logger } from '../../utils/logger.js';

const EMPTY: RetrievalResult = { additionalContext: '', block: false, hitCount: 0, isGap: false };

export class RetrievalBroker {
  private readonly store: SessionShownStore;
  constructor(private readonly deps: BrokerDeps, store?: SessionShownStore) {
    this.store = store ?? new SessionShownStore(deps.sessionId);
  }

  private minHits(): number { return Math.max(1, parseInt(this.deps.settings.MEMSMITH_RETRIEVAL_MIN_HITS ?? '1', 10) || 1); }
  private limit(): number { return Math.max(1, parseInt(this.deps.settings.MEMSMITH_SEMANTIC_INJECT_LIMIT ?? '5', 10) || 5); }
  private timeoutMs(): number { return Math.max(1, parseInt(this.deps.settings.MEMSMITH_RETRIEVAL_TIMEOUT_MS ?? '2000', 10) || 2000); }
  private mode(): EnforcementMode { return this.deps.settings.MEMSMITH_RETRIEVAL_ENFORCEMENT === 'hard' ? 'hard' : 'soft'; }

  /** Query /v1/context with a hard timeout. Returns [] on any failure (fail-open). */
  private async query(q: string): Promise<ProvenancedMemory[]> {
    const rt = this.deps.runtime;
    if (rt.runtime !== 'server') return [];
    try {
      const result = await Promise.race([
        rt.client.contextObservations({ projectId: rt.projectId, query: q, limit: this.limit() }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('retrieval timeout')), this.timeoutMs())),
      ]);
      const obs = Array.isArray(result?.observations) ? result.observations : [];
      return obs.map(o => ({
        id: String(o.id),
        content: typeof o.content === 'string' ? o.content : '',
        obsType: typeof (o as any).obs_type === 'string' ? (o as any).obs_type : (typeof (o as any).obsType === 'string' ? (o as any).obsType : null),
        capturedAt: typeof (o as any).created_at === 'string' ? (o as any).created_at : (typeof (o as any).createdAt === 'string' ? (o as any).createdAt : null),
      })).filter(m => m.content.length > 0);
    } catch (err) {
      logger.debug('HOOK', 'retrieval query failed (fail-open)', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  /** Shared decision logic. `allowBlock` gates hard-mode blocking to PreToolUse only. */
  private decide(hits: ProvenancedMemory[], allowBlock: boolean): RetrievalResult {
    const minHits = this.minHits();
    const hitCount = hits.length;
    if (hitCount < minHits) {
      // Miss → gap-flag, never block.
      return { additionalContext: frameGapNote(), block: false, hitCount, isGap: true };
    }
    // Strong hit → dedup against session-shown, inject the fresh ones.
    const shown = this.store.readShown();
    const fresh = hits.filter(h => !shown.has(h.id));
    if (fresh.length === 0) {
      return { additionalContext: '', block: false, hitCount, isGap: false };
    }
    this.store.markShown(fresh.map(h => h.id));
    const context = frameMemory(fresh);
    const block = allowBlock && this.mode() === 'hard';
    return {
      additionalContext: context,
      block,
      ...(block ? { blockReason: 'Consult MemSmith memory first — relevant recorded context exists. Query ms-mem-search, then re-run.' } : {}),
      hitCount,
      isGap: false,
    };
  }

  async forPrompt(promptText: string): Promise<RetrievalResult> {
    if (!promptText || promptText.trim().length === 0) return EMPTY;
    const hits = await this.query(promptText);
    // Prompt injection never blocks (blocking is a PreToolUse-only mechanism).
    return this.decide(hits, /* allowBlock */ false);
  }

  async forToolIntent(toolName: string, toolArgs: unknown): Promise<RetrievalResult> {
    const q = deriveQueryFromTool(toolName, toolArgs);
    if (q === null) return EMPTY; // not a search-intent tool
    const hits = await this.query(q);
    return this.decide(hits, /* allowBlock */ true);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/retrieval/broker.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/retrieval/broker.ts tests/retrieval/broker.test.ts
git commit -m "feat(retrieval): RetrievalBroker (query, dedup, gap-flag, soft/hard, fail-open)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: UserPromptSubmit adapter (A) + gap persistence

**Files:**
- Create: `src/cli/handlers/prompt-injection.ts`
- Modify: `src/cli/handlers/index.ts` (register `prompt-injection`)
- Test: `tests/cli/handlers/prompt-injection.test.ts`

**Interfaces:**
- Consumes: `RetrievalBroker` (Task 6), `resolveRuntimeContext`, `loadFromFileOnce`, `EventHandler`, `NormalizedHookInput`, `HookResult`.
- Produces: `promptInjectionHandler: EventHandler`; registry key `'prompt-injection'`.
- On a gap (`result.isGap`), best-effort persist a `memory_gap` observation via `ServerClient.addObservation` (never throw; swallow on failure).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/handlers/prompt-injection.test.ts
import { describe, it, expect } from 'bun:test';
import { promptInjectionHandler } from '../../../src/cli/handlers/prompt-injection.js';

// Minimal fake: the handler reads runtime + settings via injected deps hook.
// We exercise the pure result-shaping by pointing at a non-server runtime
// (fail-open path) — asserting it never throws and returns a continue result.
describe('promptInjectionHandler', () => {
  it('returns a continue result and never throws when no runtime', async () => {
    const res = await promptInjectionHandler.execute({
      sessionId: 's1', cwd: '/tmp', prompt: 'why did we choose X?',
    } as any);
    expect(res.continue).toBe(true);
    // additionalContext may be absent/empty when nothing to inject
    if (res.hookSpecificOutput) {
      expect(res.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    }
  });

  it('empty prompt → clean skip', async () => {
    const res = await promptInjectionHandler.execute({ sessionId: 's1', cwd: '/tmp', prompt: '' } as any);
    expect(res.continue).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/cli/handlers/prompt-injection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handler**

```typescript
// src/cli/handlers/prompt-injection.ts
import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { RetrievalBroker } from '../../services/retrieval/broker.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';

const CONTINUE: HookResult = { continue: true, suppressOutput: true };

/** Best-effort gap persistence: record that a why/decision prompt had no memory,
 *  so the dashboard can surface un-captured rationale. Never throws. */
async function persistGap(runtime: ReturnType<typeof resolveRuntimeContext>, prompt: string): Promise<void> {
  try {
    if (runtime.runtime !== 'server') return;
    // NOTE: the direct-insert API (ServerAddObservationRequest → /v1/memories) uses
    // `kind`, not `obsType` (obs_type is a generation-time field). Gap markers use
    // kind='memory_gap' + a metadata flag so the dashboard can filter them.
    await runtime.client.addObservation({
      projectId: runtime.projectId,
      kind: 'memory_gap',
      content: `memory_gap: no recorded rationale for prompt: ${prompt.slice(0, 200)}`,
      metadata: { memoryGap: true },
    });
  } catch (err) {
    logger.debug('HOOK', 'gap persist failed (best-effort)', { error: err instanceof Error ? err.message : String(err) });
  }
}

export const promptInjectionHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const prompt = (input.prompt ?? '').trim();
    if (!prompt) return CONTINUE;
    try {
      const settings = loadFromFileOnce();
      if (settings.MEMSMITH_SEMANTIC_INJECT !== 'true') return CONTINUE;
      const runtime = resolveRuntimeContext();
      const broker = new RetrievalBroker({ runtime, settings, sessionId: input.sessionId, nowIso: new Date().toISOString() });
      const result = await broker.forPrompt(prompt);
      if (result.isGap) { await persistGap(runtime, prompt); }
      if (!result.additionalContext) return CONTINUE;
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: result.additionalContext,
        },
      };
    } catch (err) {
      logger.warn('HOOK', 'prompt-injection failed; continuing without it', { error: err instanceof Error ? err.message : String(err) });
      return CONTINUE;
    }
  },
};
```

- [ ] **Step 4: Register in the handler registry**

In `src/cli/handlers/index.ts`: add `import { promptInjectionHandler } from './prompt-injection.js';`, add `| 'prompt-injection'` to the `EventType` union, add `'prompt-injection': promptInjectionHandler,` to the `handlers` map, and add `export { promptInjectionHandler } from './prompt-injection.js';`.

- [ ] **Step 5: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/cli/handlers/prompt-injection.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/handlers/prompt-injection.ts src/cli/handlers/index.ts tests/cli/handlers/prompt-injection.test.ts
git commit -m "feat(retrieval): UserPromptSubmit injection adapter + gap persistence

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: PreToolUse interception adapter (C)

**Files:**
- Create: `src/cli/handlers/tool-intent.ts`
- Modify: `src/cli/handlers/index.ts` (register `tool-intent`)
- Test: `tests/cli/handlers/tool-intent.test.ts`

**Interfaces:**
- Consumes: `RetrievalBroker` (Task 6), same deps as Task 7.
- Produces: `toolIntentHandler: EventHandler`; registry key `'tool-intent'`.
- Maps broker `RetrievalResult` → `HookResult` with `hookEventName: 'PreToolUse'`; `permissionDecision: 'deny'` + `permissionDecisionReason` when `result.block`, else `'allow'` with `additionalContext`. Fires for BOTH main and sub-agent tool calls (agentId present or not).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/handlers/tool-intent.test.ts
import { describe, it, expect } from 'bun:test';
import { toolIntentHandler } from '../../../src/cli/handlers/tool-intent.js';

describe('toolIntentHandler', () => {
  it('non-search tool → allow, no block (fail-open path, no runtime)', async () => {
    const res = await toolIntentHandler.execute({ sessionId: 's1', cwd: '/tmp', toolName: 'Edit', toolInput: { file_path: '/a.ts' } } as any);
    expect(res.continue).toBe(true);
    // never denies a non-search tool
    expect(res.hookSpecificOutput?.permissionDecision === 'deny').toBe(false);
  });

  it('search tool with no reachable runtime → allow (fail-open), never throws', async () => {
    const res = await toolIntentHandler.execute({ sessionId: 's1', cwd: '/tmp', toolName: 'Grep', toolInput: { pattern: 'x' } } as any);
    expect(res.continue).toBe(true);
    expect(res.hookSpecificOutput?.permissionDecision === 'deny').toBe(false);
  });

  it('sub-agent tool call (agentId set) still runs the path without throwing', async () => {
    const res = await toolIntentHandler.execute({ sessionId: 's1', cwd: '/tmp', toolName: 'Grep', toolInput: { pattern: 'x' }, agentId: 'sub-1', agentType: 'general-purpose' } as any);
    expect(res.continue).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/cli/handlers/tool-intent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/cli/handlers/tool-intent.ts
import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { RetrievalBroker } from '../../services/retrieval/broker.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { logger } from '../../utils/logger.js';

/** PreToolUse must default to allowing the tool through — retrieval-first never
 *  blocks the agent due to its own failure. */
const ALLOW: HookResult = {
  continue: true,
  suppressOutput: true,
  hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '', permissionDecision: 'allow' },
};

export const toolIntentHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const toolName = input.toolName ?? '';
    if (!toolName) return ALLOW;
    try {
      const settings = loadFromFileOnce();
      if (settings.MEMSMITH_SEMANTIC_INJECT !== 'true') return ALLOW;
      const runtime = resolveRuntimeContext();
      const broker = new RetrievalBroker({ runtime, settings, sessionId: input.sessionId, nowIso: new Date().toISOString() });
      const result = await broker.forToolIntent(toolName, input.toolInput);
      if (result.block) {
        return {
          continue: true,
          suppressOutput: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: result.additionalContext,
            permissionDecision: 'deny',
            permissionDecisionReason: result.blockReason ?? 'Consult MemSmith memory first.',
          },
        };
      }
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: result.additionalContext,
          permissionDecision: 'allow',
        },
      };
    } catch (err) {
      logger.warn('HOOK', 'tool-intent failed; allowing tool through', { error: err instanceof Error ? err.message : String(err) });
      return ALLOW;
    }
  },
};
```

- [ ] **Step 4: Register in the handler registry**

In `src/cli/handlers/index.ts`: add the import, `| 'tool-intent'` to `EventType`, `'tool-intent': toolIntentHandler,` to `handlers`, and the re-export — exactly as Task 7 did for `prompt-injection`.

- [ ] **Step 5: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/cli/handlers/tool-intent.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/handlers/tool-intent.ts src/cli/handlers/index.ts tests/cli/handlers/tool-intent.test.ts
git commit -m "feat(retrieval): PreToolUse interception adapter (soft/hard, sub-agent safe)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Directive delivery — SessionStart + PreToolUse:Agent + CLAUDE.md

**Files:**
- Create: `src/cli/handlers/agent-directive.ts`
- Modify: `src/cli/handlers/index.ts` (register `agent-directive`)
- Modify: `src/cli/handlers/context.ts` (append `MEMORY_FIRST_DIRECTIVE` to SessionStart `additionalContext`)
- Modify: `CLAUDE.md` (project root) — add the directive baseline for sub-agents
- Test: `tests/cli/handlers/agent-directive.test.ts`, `tests/cli/handlers/context-directive.test.ts`

**Interfaces:**
- Consumes: `MEMORY_FIRST_DIRECTIVE` (Task 5), `EventHandler`.
- Produces: `agentDirectiveHandler: EventHandler`; registry key `'agent-directive'`. Fires on `PreToolUse` matched to the `Agent`/`Task` tool; injects the directive into `additionalContext` so it rides into the spawned sub-agent's task framing.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/cli/handlers/agent-directive.test.ts
import { describe, it, expect } from 'bun:test';
import { agentDirectiveHandler } from '../../../src/cli/handlers/agent-directive.js';
import { MEMORY_FIRST_DIRECTIVE } from '../../../src/services/retrieval/directive.js';

describe('agentDirectiveHandler', () => {
  it('injects the memory-first directive on a Task/Agent spawn', async () => {
    const res = await agentDirectiveHandler.execute({ sessionId: 's1', cwd: '/tmp', toolName: 'Task', toolInput: { prompt: 'do a thing' } } as any);
    expect(res.hookSpecificOutput?.additionalContext).toContain(MEMORY_FIRST_DIRECTIVE.split('\n')[0]);
    expect(res.hookSpecificOutput?.permissionDecision).toBe('allow'); // never blocks a spawn
  });
});
```

```typescript
// tests/cli/handlers/context-directive.test.ts
import { describe, it, expect } from 'bun:test';
import { MEMORY_FIRST_DIRECTIVE } from '../../../src/services/retrieval/directive.js';
import { contextHandler } from '../../../src/cli/handlers/context.js';

describe('SessionStart directive', () => {
  it('SessionStart context includes the memory-first directive', async () => {
    const res = await contextHandler.execute({ sessionId: 's1', cwd: '/tmp', platform: 'claude-code' } as any);
    const ctx = res.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain(MEMORY_FIRST_DIRECTIVE.split('\n')[0]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/cli/handlers/agent-directive.test.ts tests/cli/handlers/context-directive.test.ts`
Expected: FAIL — module not found (agent-directive) and directive absent (context).

- [ ] **Step 3: Implement the agent-directive handler**

```typescript
// src/cli/handlers/agent-directive.ts
import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { MEMORY_FIRST_DIRECTIVE } from '../../services/retrieval/directive.js';

/** PreToolUse:Agent — when the parent spawns a sub-agent (Task/Agent tool),
 *  inject the memory-first directive so it rides into the sub-agent's task
 *  framing (sub-agents get no SessionStart). Never blocks the spawn. */
export const agentDirectiveHandler: EventHandler = {
  async execute(_input: NormalizedHookInput): Promise<HookResult> {
    return {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: MEMORY_FIRST_DIRECTIVE,
        permissionDecision: 'allow',
      },
    };
  },
};
```

- [ ] **Step 4: Append the directive to SessionStart context**

In `src/cli/handlers/context.ts`, add `import { MEMORY_FIRST_DIRECTIVE } from '../../services/retrieval/directive.js';` and, right after the `dashboardLine` is prepended to `additionalContext` (around line 170-173), prepend the directive so it is always present:
```typescript
    additionalContext = `${MEMORY_FIRST_DIRECTIVE}\n\n${additionalContext}`;
```

- [ ] **Step 5: Register the handler + add CLAUDE.md baseline**

In `src/cli/handlers/index.ts`: import, `| 'agent-directive'` in `EventType`, `'agent-directive': agentDirectiveHandler,` in `handlers`, re-export.

In project `CLAUDE.md`, add a section (sub-agent baseline — non-Explore/Plan sub-agents load CLAUDE.md):
```markdown
## Memory-First (MemSmith)
For any why/decision/rationale question — the user's or your own — consult MemSmith memory FIRST (ms-mem-search tools) before grepping or reading files. Reference order: (1) MemSmith memory, (2) CLAUDE.md, (3) specs, (4) file search. Treat recalled memory as authoritative-but-verifiable.
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/cli/handlers/agent-directive.test.ts tests/cli/handlers/context-directive.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/handlers/agent-directive.ts src/cli/handlers/index.ts src/cli/handlers/context.ts CLAUDE.md tests/cli/handlers/agent-directive.test.ts tests/cli/handlers/context-directive.test.ts
git commit -m "feat(retrieval): directive delivery — SessionStart + PreToolUse:Agent + CLAUDE.md

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Wire the hooks in hooks.json

**Files:**
- Modify: `plugin/hooks/hooks.json`
- Test: `tests/plugin/hooks-retrieval.test.ts`

**Interfaces:**
- Consumes: the four handler subcommands (`prompt-injection`, `tool-intent`, `agent-directive`, and the existing `context`).
- The `hooks.json` command pattern is the long PATH-resolving `bun-runner.js … server-service.cjs hook claude-code <event>` string used by every existing hook; the new entries reuse that exact pattern with the new `<event>` names.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/plugin/hooks-retrieval.test.ts
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const hooks = JSON.parse(readFileSync(join(process.cwd(), 'plugin/hooks/hooks.json'), 'utf-8'));

function commandsFor(event: string): string[] {
  return (hooks.hooks[event] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command as string));
}

describe('retrieval-first hooks wired', () => {
  it('UserPromptSubmit runs prompt-injection', () => {
    expect(commandsFor('UserPromptSubmit').some(c => c.includes('hook claude-code prompt-injection'))).toBe(true);
  });
  it('PreToolUse runs tool-intent for search tools', () => {
    expect(commandsFor('PreToolUse').some(c => c.includes('hook claude-code tool-intent'))).toBe(true);
  });
  it('PreToolUse runs agent-directive for Task/Agent spawns', () => {
    const groups = hooks.hooks.PreToolUse ?? [];
    const hasAgentMatcher = groups.some((g: any) =>
      /Task|Agent/.test(g.matcher ?? '') && (g.hooks ?? []).some((h: any) => h.command.includes('hook claude-code agent-directive')));
    expect(hasAgentMatcher).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/plugin/hooks-retrieval.test.ts`
Expected: FAIL — none of the new commands present.

- [ ] **Step 3: Implement**

In `plugin/hooks/hooks.json`, using the EXACT long command pattern from the existing entries (copy an existing hook's `command` string and change only the trailing event name):

1. Under `UserPromptSubmit`, add a hook group whose command ends with `hook claude-code prompt-injection` (in addition to the existing `session-init`).
2. Under `PreToolUse`, add a group with `"matcher": "Grep|Glob|Read|Bash"` whose command ends with `hook claude-code tool-intent`.
3. Under `PreToolUse`, add a second group with `"matcher": "Task|Agent"` whose command ends with `hook claude-code agent-directive`.

(Copy the surrounding `type`/`shell`/`timeout` fields verbatim from an existing PreToolUse/UserPromptSubmit entry — do not hand-write the PATH resolver.)

- [ ] **Step 4: Run test to verify it passes**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/plugin/hooks-retrieval.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify JSON validity**

Run: `node -e "JSON.parse(require('fs').readFileSync('plugin/hooks/hooks.json','utf-8')); console.log('valid json')"`
Expected: `valid json`.

- [ ] **Step 6: Commit**

```bash
git add plugin/hooks/hooks.json tests/plugin/hooks-retrieval.test.ts
git commit -m "feat(retrieval): wire prompt-injection, tool-intent, agent-directive hooks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Live integration + build/sync verification

**Files:**
- Test: `tests/retrieval/broker-integration.test.ts` (live embedded PG)

**Interfaces:**
- Consumes: everything above; live embedded PG at `postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres` and server at `http://127.0.0.1:38879`.

- [ ] **Step 1: Write the integration test**

```typescript
// tests/retrieval/broker-integration.test.ts
// Skips gracefully if the embedded PG / server is not up.
import { describe, it, expect } from 'bun:test';
import { RetrievalBroker } from '../../src/services/retrieval/broker.js';
import { ServerClient } from '../../src/services/hooks/server-client.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const TEAM = 'ab8e1f17-020e-4794-bae3-e59885e7df05';
const PROJ = '5fc024f0-0994-4f1d-baed-300d9b4d3416';

function key(): string | null {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.memsmith', 'credentials.json'), 'utf-8'));
    return j.keys?.[TEAM] ?? null;
  } catch { return null; }
}

describe('RetrievalBroker (live)', () => {
  it('returns real ranked memory for a decision query', async () => {
    const k = key();
    if (!k) { console.log('skip: no dogfood key'); return; }
    const client = new ServerClient({ serverBaseUrl: 'http://127.0.0.1:38879', apiKey: k });
    let reachable = true;
    try { await client.contextObservations({ projectId: PROJ, query: 'ping', limit: 1 }); } catch { reachable = false; }
    if (!reachable) { console.log('skip: server not reachable'); return; }
    const broker = new RetrievalBroker({
      runtime: { runtime: 'server', client, projectId: PROJ, serverBaseUrl: 'http://127.0.0.1:38879' } as any,
      settings: { MEMSMITH_RETRIEVAL_MIN_HITS: '1', MEMSMITH_RETRIEVAL_TIMEOUT_MS: '5000', MEMSMITH_SEMANTIC_INJECT_LIMIT: '3', MEMSMITH_RETRIEVAL_ENFORCEMENT: 'soft' },
      sessionId: 'itest', nowIso: new Date().toISOString(),
    });
    const r = await broker.forPrompt('why did observation capture go dark');
    // There IS memory about this (from this session's debugging).
    expect(r.hitCount).toBeGreaterThan(0);
    expect(r.additionalContext.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bun test tests/retrieval/broker-integration.test.ts`
Expected: PASS (or a printed `skip:` line if PG/server is down — never a failure).

- [ ] **Step 3: Build and sync so the installed plugin runs the new hooks**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" npm run build-and-sync 2>&1 | tail -5`
Expected: `Sync complete!` and the server restarts.

- [ ] **Step 4: Manually verify the prompt-injection hook end-to-end**

Run (drives the installed hook exactly as Claude Code does):
```bash
PLUGIN=/Users/shwaits/.claude/plugins/marketplaces/shshalom/plugin
echo '{"session_id":"rf-verify","cwd":"/Users/shwaits/Workspace/team-agent-memory/MemSmith","hook_event_name":"UserPromptSubmit","prompt":"why did we choose embedded postgres"}' | \
  env MEMSMITH_SERVER_URL="http://127.0.0.1:38879" MEMSMITH_PROJECT_CWD="/Users/shwaits/Workspace/team-agent-memory/MemSmith" \
  node "$PLUGIN/scripts/bun-runner.js" "$PLUGIN/scripts/server-service.cjs" hook claude-code prompt-injection
```
Expected: JSON with `hookSpecificOutput.additionalContext` containing relevant recorded memory (provenance-tagged).

- [ ] **Step 5: Commit**

```bash
git add tests/retrieval/broker-integration.test.ts
git commit -m "test(retrieval): live integration + verified end-to-end injection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: Directive-reliability harness (the decision gate)

**Files:**
- Create: `bench/retrieval-first/eval-set.json` (fixed prompts + expected class)
- Create: `bench/retrieval-first/run.mjs` (scores directive reliability)
- Create: `bench/retrieval-first/README.md` (how to run + threshold + fallback rule)

**Interfaces:**
- Consumes: MemSmith telemetry / `/v1/context` call detection to determine whether memory was consulted before file search.
- Produces: a re-runnable harness printing a score and PASS/FAIL against the ≥90% threshold; documents the fallback (flip the failing surface to always-memory-first).

- [ ] **Step 1: Create the evaluation set**

```json
// bench/retrieval-first/eval-set.json
{
  "threshold": 0.9,
  "prompts": [
    { "text": "why did we choose embedded postgres over docker", "class": "why" },
    { "text": "what did we decide about the api key scoping", "class": "why" },
    { "text": "why is capture scoped by team_id and project_id", "class": "why" },
    { "text": "what's the rationale for the tiering compression setting", "class": "why" },
    { "text": "why did observation capture go dark on 7/13", "class": "why" },
    { "text": "where is the file that defines the embedded postgres port", "class": "file" },
    { "text": "list the functions in runtime-selector.ts", "class": "file" },
    { "text": "open the settings view component", "class": "file" },
    { "text": "how many tests are in the identity suite", "class": "file" },
    { "text": "show me the credential store implementation", "class": "file" }
  ]
}
```

- [ ] **Step 2: Create the harness (documented, runnable, self-describing)**

```javascript
// bench/retrieval-first/run.mjs
// Directive-reliability harness. Measures, for each "why"-class prompt, whether
// MemSmith memory was consulted (a /v1/context result with >=1 hit exists) —
// the precondition for the directive to work. Prints a score vs. the threshold.
//
// NOTE: this harness measures RETRIEVABILITY (does memory have the answer), which
// is the necessary condition. Full behavioral measurement (did the agent actually
// consult before grepping) requires a live agent transcript; this harness is the
// automatable proxy and the gate for enabling hard mode. Documented as such.
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEAM = 'ab8e1f17-020e-4794-bae3-e59885e7df05';
const PROJ = '5fc024f0-0994-4f1d-baed-300d9b4d3416';
const cfg = JSON.parse(readFileSync(join(HERE, 'eval-set.json'), 'utf-8'));
const key = JSON.parse(readFileSync(join(homedir(), '.memsmith', 'credentials.json'), 'utf-8')).keys[TEAM];

let whyTotal = 0, whyHit = 0;
for (const p of cfg.prompts) {
  const res = await fetch('http://127.0.0.1:38879/v1/context', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: PROJ, query: p.text, limit: 5 }),
  }).then(r => r.json()).catch(() => ({ observations: [] }));
  const hits = (res.observations ?? []).length;
  if (p.class === 'why') { whyTotal++; if (hits >= 1) whyHit++; }
  console.log(`[${p.class}] hits=${hits}  ${p.text}`);
}
const score = whyTotal ? whyHit / whyTotal : 0;
console.log(`\nwhy-class retrievability: ${whyHit}/${whyTotal} = ${(score * 100).toFixed(0)}%  (threshold ${(cfg.threshold * 100)}%)`);
console.log(score >= cfg.threshold ? 'PASS — directive-based approach viable' : 'FAIL — flip failing surface to always-memory-first (spec fallback)');
process.exit(score >= cfg.threshold ? 0 : 1);
```

- [ ] **Step 3: Create the README**

```markdown
// bench/retrieval-first/README.md
# Retrieval-First Reliability Harness

Run: `node bench/retrieval-first/run.mjs` (requires the local server on :38879 and the dogfood key).

Measures why-class retrievability (does memory hold the answer for why/decision prompts).
Threshold: 90% (in eval-set.json). Below threshold → per the design spec, flip the failing
surface to always-memory-first (query memory for everything, files always fallback).

This is the automatable proxy for directive reliability. Full behavioral measurement
(did the agent consult memory before grepping) requires live agent transcripts and is a
manual follow-up; this gate covers the necessary precondition.
```

- [ ] **Step 4: Run the harness**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" node bench/retrieval-first/run.mjs`
Expected: prints per-prompt hits + a score line + PASS/FAIL. (PASS expected — the dogfood project has rich why-memory.)

- [ ] **Step 5: Commit**

```bash
git add bench/retrieval-first/
git commit -m "test(retrieval): directive-reliability harness + eval set

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 13: Full-suite gate + final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the isolated per-file gate**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" npm run test:ci 2>&1 | tail -20`
Expected: exit 0 (all files pass). If any retrieval file fails, fix before proceeding.

- [ ] **Step 2: Typecheck (src, excluding tests/bun)**

Run: `env -i HOME="$HOME" PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin" ~/.bun/bin/bunx tsc --noEmit 2>&1 | grep "error TS" | grep -viE "bun:test|node_modules|tests/" | head`
Expected: no output (clean).

- [ ] **Step 3: Confirm dogfood still captures AND now injects**

Run:
```bash
node -e "const {Client}=require('pg');(async()=>{const c=new Client({connectionString:'postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres'});await c.connect();const n=(await c.query(\"SELECT count(*)::int n FROM observations WHERE team_id='ab8e1f17-020e-4794-bae3-e59885e7df05'\")).rows[0].n;console.log('observations:',n);await c.end();})()"
```
Expected: count present and non-zero (capture unbroken by retrieval-first changes).

- [ ] **Step 4: No commit** (verification task). Report results to the controller.

---

## Notes for the executor
- **Fail-open is sacred.** Any handler that could throw on the hot path MUST catch and return a `continue: true` / allow result. The tests in Tasks 6-8 assert this; do not weaken them.
- **Never block on a miss or on error.** Hard-mode blocking fires ONLY on a strong hit (≥ MIN_HITS) the agent hasn't yet consulted. This is asserted in Task 6.
- **Restart the server after any viewer/hook change** (`build-and-sync` does this) — the server caches at boot.
- **The capture fix from the prior session is still uncommitted** on this branch's parent state; do not revert those working-tree changes. If they appear in `git status`, leave them for a separate commit.
