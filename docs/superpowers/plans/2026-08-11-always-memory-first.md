# Always-Memory-First Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make memory consultation an enforced precondition for discovery tool calls — keyed on "not yet consulted for this topic this session" rather than on how many results memory returns — and make memory unavailability visible to the user instead of silent.

**Architecture:** The retrieval broker, session store, query derivation, and PreToolUse adapter all already exist and work (built 2026-07-15, 13 tasks, tests passing). This plan does **not** build new machinery. It changes the block predicate in `RetrievalBroker.decide`, adds a topic-consulted store alongside the existing shown-ids store, narrows `Read` gating to cold reads, and replaces the fail-silent `logger.debug` path with a user-visible notice. Enforcement stays OFF until the last task, so no intermediate commit changes installed behavior.

**Tech Stack:** TypeScript, Bun test runner, Express (settings route), Claude Code PreToolUse hooks.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-07-15-retrieval-first-design.md` (as amended 2026-08-11):

- **Fail open, always:** "Any failure (server down, timeout, missing key, corrupt state) degrades to 'agent proceeds normally, no memory assist this turn.' It must NEVER block the agent due to its own failure."
- **Fail open ≠ fail silent (Amendment 2):** when memory is unavailable the user MUST be told visibly; the answer is marked code-only; the grep is suggested rather than silently run.
- **Unavailability MUST NOT write a `memory_gap` record.** A gap means memory was asked and had nothing. Unavailability means it was never asked. Conflating them poisons the gap corpus.
- **Latency wins:** "if the King-solution goal and hot-path latency conflict, latency wins."
- **Blocking does NOT depend on how many results memory returns** (Amendment 1).
- **Friction bound:** at most one block per topic per session.
- **Never block on a miss.** A block that forces a consult returning nothing is pure friction.
- **Timeout default:** `MEMSMITH_RETRIEVAL_TIMEOUT_MS` default `2000`.
- **Injection cap:** 10,000 characters (Claude Code's `additionalContext` limit).

## Pre-Flight Findings (verified in code before planning)

Three things differ from what the amended spec assumes. The plan below is written against
the **code as it actually is**:

1. **Bash search-shaping is ALREADY implemented.** `query-derivation.ts:34` returns `null`
   unless the command matches `/(^|\s)(grep|rg|ag|find)\b/`. The spec claimed this was
   unimplemented. No work needed; Task 4 adds a regression test to pin it.
2. **`Read` gating is NOT implemented.** `query-derivation.ts:24-31` derives a query from
   every `Read`. Cold-vs-warm discrimination is genuinely missing → Task 4.
3. **`MEMSMITH_RETRIEVAL_ENFORCEMENT` is NOT a team setting.** It is absent from the 18 keys
   in `src/server/settings/settingKeys.ts`. `PATCH /v1/settings` writes **team overrides to
   the database** keyed by `teamId`; hooks read `~/.memsmith/settings.json` via
   `loadFromFileOnce`. These are **different stores** — the existing route cannot toggle
   enforcement. Task 5 adds a machine-local settings write path rather than reusing it.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/services/retrieval/topic-store.ts` | Persist which topics memory has been consulted for, this session | **create** |
| `src/services/retrieval/topic-key.ts` | Normalize a derived query into a stable topic key | **create** |
| `src/services/retrieval/broker.ts` | Block predicate: "not yet consulted" instead of "has hits" | modify |
| `src/services/retrieval/types.ts` | `RetrievalResult` gains `unavailable` | modify |
| `src/services/retrieval/query-derivation.ts` | `Read` gated to cold reads | modify |
| `src/services/retrieval/directive.ts` | `frameUnavailableNotice()` | modify |
| `src/cli/handlers/tool-intent.ts` | Surface unavailability; carry deny reason | modify |
| `src/npx-cli/commands/enforcement.ts` | `memsmith enforcement on\|off\|status` — non-gated escape hatch | **create** |

Tests mirror each under `tests/retrieval/` and `tests/cli/handlers/`.

---

### Task 1: Topic key normalization

**Files:**
- Create: `src/services/retrieval/topic-key.ts`
- Test: `tests/retrieval/topic-key.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `topicKey(derivedQuery: string): string`

Why a separate module: the topic key is the unit the whole friction bound rests on. Too coarse
and one memory call unlocks the session; too fine and every grep variant re-blocks. It is pure
and deserves its own tests.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'bun:test';
import { topicKey } from '../../src/services/retrieval/topic-key.js';

describe('topicKey', () => {
  it('is case- and whitespace-insensitive', () => {
    expect(topicKey('ensureOllamaRunning')).toBe(topicKey('  ensureollamarunning '));
  });

  it('ignores regex and glob punctuation so pattern variants share a topic', () => {
    expect(topicKey('spawn|exec|ollama')).toBe(topicKey('spawn exec ollama'));
    expect(topicKey('**/*.ollama.ts')).toBe(topicKey('ollama ts'));
  });

  it('is order-insensitive so term reordering does not re-block', () => {
    expect(topicKey('ollama restart')).toBe(topicKey('restart ollama'));
  });

  it('drops terms shorter than 3 chars, which carry no topic signal', () => {
    expect(topicKey('a an ollama')).toBe(topicKey('ollama'));
  });

  it('distinguishes genuinely different topics', () => {
    expect(topicKey('ollama restart')).not.toBe(topicKey('postgres pool'));
  });

  it('returns empty string for input with no usable terms', () => {
    expect(topicKey('a * ? |')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/retrieval/topic-key.test.ts`
Expected: FAIL — `Cannot find module '.../topic-key.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/retrieval/topic-key.ts
// A stable identity for "what subject is this search about".
//
// The friction bound of always-memory-first — at most one block per topic per
// session — rests entirely on this function. Too coarse and one memory call
// unlocks every later search; too fine and `grep foo` then `grep foo|bar`
// blocks twice for the same subject.
//
// Deliberately lossy: lowercase, strip regex/glob punctuation, drop sub-3-char
// terms, sort. So `spawn|exec|ollama` and `ollama exec spawn` are one topic.

const PUNCT = /[*?{}[\]()^$\\|.+/'"`~!@#%&=:;,<>-]+/g;

export function topicKey(derivedQuery: string): string {
  const terms = derivedQuery
    .toLowerCase()
    .replace(PUNCT, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3);
  return [...new Set(terms)].sort().join(' ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/retrieval/topic-key.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/services/retrieval/topic-key.ts tests/retrieval/topic-key.test.ts
git commit -m "feat(retrieval): add topic-key normalization for the consulted-topic bound"
```

---

### Task 2: Topic-consulted session store

**Files:**
- Create: `src/services/retrieval/topic-store.ts`
- Test: `tests/retrieval/topic-store.test.ts`

**Interfaces:**
- Consumes: `topicKey` from Task 1.
- Produces: `class SessionTopicStore { constructor(sessionId: string, baseDir?: string); hasConsulted(topic: string): boolean; markConsulted(topic: string): void; }`

Mirrors the existing `SessionShownStore` (`session-store.ts`) — same directory
(`~/.memsmith/sessions/<sessionId>/`), same corrupt-file-tolerant contract — but a separate
file (`consulted.json`) because the two answer different questions: *what have I injected* vs
*what have I been asked about*.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionTopicStore } from '../../src/services/retrieval/topic-store.js';

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'ms-topic-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('SessionTopicStore', () => {
  it('reports not-consulted for a fresh session', () => {
    const s = new SessionTopicStore('sess-1', base);
    expect(s.hasConsulted('ollama restart')).toBe(false);
  });

  it('persists a consulted topic across store instances (separate hook processes)', () => {
    new SessionTopicStore('sess-1', base).markConsulted('ollama restart');
    expect(new SessionTopicStore('sess-1', base).hasConsulted('ollama restart')).toBe(true);
  });

  it('scopes topics per session', () => {
    new SessionTopicStore('sess-1', base).markConsulted('ollama restart');
    expect(new SessionTopicStore('sess-2', base).hasConsulted('ollama restart')).toBe(false);
  });

  it('does not leak across topics', () => {
    const s = new SessionTopicStore('sess-1', base);
    s.markConsulted('ollama restart');
    expect(s.hasConsulted('postgres pool')).toBe(false);
  });

  it('treats a corrupt file as empty and never throws', () => {
    mkdirSync(join(base, 'sess-1'), { recursive: true });
    writeFileSync(join(base, 'sess-1', 'consulted.json'), '{not json');
    const s = new SessionTopicStore('sess-1', base);
    expect(s.hasConsulted('anything')).toBe(false);
    expect(() => s.markConsulted('x')).not.toThrow();
  });

  it('never throws when the base dir is unwritable', () => {
    const s = new SessionTopicStore('sess-1', '/proc/nonexistent-ms-test');
    expect(() => s.markConsulted('x')).not.toThrow();
    expect(s.hasConsulted('x')).toBe(false);
  });

  it('is idempotent — marking twice keeps one entry', () => {
    const s = new SessionTopicStore('sess-1', base);
    s.markConsulted('ollama');
    s.markConsulted('ollama');
    expect(s.hasConsulted('ollama')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/retrieval/topic-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/retrieval/topic-store.ts
// Which topics has memory already been consulted for, this session?
//
// Hooks are short-lived separate processes and share no memory, so this
// persists to a session-scoped file — same pattern and directory as
// SessionShownStore, deliberately a SEPARATE file because the questions
// differ: shown.json = what did I inject, consulted.json = what was I asked.
//
// Every failure path degrades to "not consulted" and never throws. A corrupt
// or unwritable file therefore costs at most one extra memory consult — it can
// never wedge the agent, per the fail-open constraint.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export class SessionTopicStore {
  private readonly file: string;
  private readonly dir: string;

  constructor(sessionId: string, baseDir: string = join(homedir(), '.memsmith', 'sessions')) {
    this.dir = join(baseDir, sessionId || 'unknown');
    this.file = join(this.dir, 'consulted.json');
  }

  private read(): Set<string> {
    try {
      if (!existsSync(this.file)) return new Set();
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8'));
      return Array.isArray(parsed) ? new Set(parsed.map(String)) : new Set();
    } catch {
      // Corrupt → empty set. Costs one extra consult, never a throw.
      return new Set();
    }
  }

  hasConsulted(topic: string): boolean {
    if (!topic) return false;
    return this.read().has(topic);
  }

  markConsulted(topic: string): void {
    if (!topic) return;
    try {
      const set = this.read();
      if (set.has(topic)) return;
      set.add(topic);
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify([...set]), 'utf-8');
    } catch {
      // Unwritable → the topic re-blocks next time. Degraded, never broken.
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/retrieval/topic-store.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/services/retrieval/topic-store.ts tests/retrieval/topic-store.test.ts
git commit -m "feat(retrieval): add per-session consulted-topic store"
```

---

### Task 3: Invert the block predicate + surface unavailability

**Files:**
- Modify: `src/services/retrieval/types.ts`
- Modify: `src/services/retrieval/directive.ts`
- Modify: `src/services/retrieval/broker.ts:52-91`
- Test: `tests/retrieval/broker.test.ts` (extend)

**Interfaces:**
- Consumes: `topicKey` (Task 1), `SessionTopicStore` (Task 2).
- Produces: `RetrievalResult` gains `unavailable: boolean`; `frameUnavailableNotice(): string`;
  `RetrievalBroker` constructor gains an optional 3rd param `topicStore?: SessionTopicStore`.

This is the core change. Two edits to `decide` / `forToolIntent`:

1. `block` is currently `allowBlock && this.mode() === 'hard'` computed **inside the strong-hit
   branch** — so it can only fire when hits ≥ minHits, and never on a miss. Per Amendment 1 the
   predicate becomes `allowBlock && hard && !topicStore.hasConsulted(topic)`, evaluated
   **regardless of hit count**.
2. `forPrompt`/`forToolIntent` currently `return EMPTY` on `FAILED`, which is the fail-silent
   path. It must return a result carrying `unavailable: true` plus a visible notice.

Note the deliberate asymmetry: the broker **does not** call `markConsulted`. The broker's own
`/v1/context` query is not the agent consulting memory — the agent consults memory by calling an
`ms-mem-search` MCP tool. Marking here would unlock the topic on the very call being blocked,
defeating the gate. Marking happens in Task 6.

- [ ] **Step 1: Write the failing tests**

Append to `tests/retrieval/broker.test.ts`. Reuse that file's existing fake-deps helper; these
tests assume a `makeDeps({ settings, observations })` shape returning `BrokerDeps` — match the
helper actually present in the file.

```ts
describe('Amendment 1 — always-memory-first block predicate', () => {
  it('blocks on a MISS when the topic has not been consulted', async () => {
    // The reverted design never blocked on a miss; Amendment 1 does, because the
    // predicate is "not yet consulted", not "memory has hits".
    const store = new SessionTopicStore('s1', tmpBase);
    const b = new RetrievalBroker(
      makeDeps({ settings: { MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' }, observations: [] }),
      undefined, store,
    );
    const r = await b.forToolIntent('Grep', { pattern: 'ollama restart' });
    expect(r.block).toBe(true);
  });

  it('blocks on a strong hit when the topic has not been consulted', async () => {
    const store = new SessionTopicStore('s2', tmpBase);
    const b = new RetrievalBroker(
      makeDeps({ settings: { MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' }, observations: [obs('1'), obs('2'), obs('3')] }),
      undefined, store,
    );
    expect((await b.forToolIntent('Grep', { pattern: 'ollama restart' })).block).toBe(true);
  });

  it('does NOT block once the topic has been consulted — the friction bound', async () => {
    const store = new SessionTopicStore('s3', tmpBase);
    store.markConsulted(topicKey('ollama restart'));
    const b = new RetrievalBroker(
      makeDeps({ settings: { MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' }, observations: [obs('1')] }),
      undefined, store,
    );
    expect((await b.forToolIntent('Grep', { pattern: 'ollama restart' })).block).toBe(false);
  });

  it('treats reordered / punctuation-variant patterns as the SAME topic', async () => {
    const store = new SessionTopicStore('s4', tmpBase);
    store.markConsulted(topicKey('ollama restart'));
    const b = new RetrievalBroker(
      makeDeps({ settings: { MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' }, observations: [] }),
      undefined, store,
    );
    expect((await b.forToolIntent('Grep', { pattern: 'restart|ollama' })).block).toBe(false);
  });

  it('still blocks a DIFFERENT topic in the same session', async () => {
    const store = new SessionTopicStore('s5', tmpBase);
    store.markConsulted(topicKey('ollama restart'));
    const b = new RetrievalBroker(
      makeDeps({ settings: { MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' }, observations: [] }),
      undefined, store,
    );
    expect((await b.forToolIntent('Grep', { pattern: 'postgres pool' })).block).toBe(true);
  });

  it('never blocks in soft mode', async () => {
    const store = new SessionTopicStore('s6', tmpBase);
    const b = new RetrievalBroker(
      makeDeps({ settings: { MEMSMITH_RETRIEVAL_ENFORCEMENT: 'soft' }, observations: [] }),
      undefined, store,
    );
    expect((await b.forToolIntent('Grep', { pattern: 'ollama' })).block).toBe(false);
  });

  it('never blocks on prompt injection, even in hard mode', async () => {
    const store = new SessionTopicStore('s7', tmpBase);
    const b = new RetrievalBroker(
      makeDeps({ settings: { MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' }, observations: [] }),
      undefined, store,
    );
    expect((await b.forPrompt('why do we have the allowlist')).block).toBe(false);
  });
});

describe('Amendment 2 — fail open but not fail silent', () => {
  it('marks unavailable and emits a visible notice when the query fails', async () => {
    const b = new RetrievalBroker(makeDeps({ failQuery: true }));
    const r = await b.forToolIntent('Grep', { pattern: 'ollama' });
    expect(r.unavailable).toBe(true);
    expect(r.additionalContext.length).toBeGreaterThan(0);
    expect(r.additionalContext).toMatch(/memory/i);
  });

  it('FAILS OPEN — never blocks when memory is unavailable, even in hard mode', async () => {
    const b = new RetrievalBroker(makeDeps({ failQuery: true, settings: { MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard' } }));
    expect((await b.forToolIntent('Grep', { pattern: 'ollama' })).block).toBe(false);
  });

  it('does NOT count unavailability as a gap (would poison the gap corpus)', async () => {
    const b = new RetrievalBroker(makeDeps({ failQuery: true }));
    expect((await b.forToolIntent('Grep', { pattern: 'ollama' })).isGap).toBe(false);
  });

  it('distinguishes a real gap (asked, nothing recorded) from unavailability', async () => {
    const b = new RetrievalBroker(makeDeps({ observations: [] }));
    const r = await b.forToolIntent('Grep', { pattern: 'ollama' });
    expect(r.isGap).toBe(true);
    expect(r.unavailable).toBe(false);
  });

  it('returns unavailable for a non-search tool without querying', async () => {
    const b = new RetrievalBroker(makeDeps({}));
    const r = await b.forToolIntent('Edit', { file_path: '/x.ts' });
    expect(r.block).toBe(false);
    expect(r.unavailable).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/retrieval/broker.test.ts`
Expected: FAIL — `unavailable` undefined; miss-case block is `false`.

- [ ] **Step 3: Implement**

In `types.ts`, add to `RetrievalResult`:

```ts
  /** True when memory could NOT be consulted (server down, timeout, bad key).
   *  Distinct from isGap, which means memory WAS consulted and had nothing.
   *  Amendment 2: this must reach the user, not just a debug log. */
  unavailable: boolean;
```

In `directive.ts`:

```ts
/** Amendment 2 — memory was not consulted, and the user must know.
 *  Fail-open keeps the agent working; this keeps the failure visible. */
export function frameUnavailableNotice(): string {
  return [
    '⚠ MemSmith memory is UNAVAILABLE for this query (server unreachable or timed out).',
    'This answer will be code-only and has NOT been checked against recorded memory.',
    'Tell the user memory is unavailable before answering, and propose the code search',
    'explicitly rather than silently falling back to it.',
  ].join('\n');
}
```

In `broker.ts` — add imports, the topic store, and rewrite `decide`/`forPrompt`/`forToolIntent`:

```ts
import { SessionTopicStore } from './topic-store.js';
import { topicKey } from './topic-key.js';
import { frameMemory, frameGapNote, frameUnavailableNotice } from './directive.js';

const EMPTY: RetrievalResult = Object.freeze({
  additionalContext: '', block: false, hitCount: 0, isGap: false, unavailable: false,
});

/** Amendment 2 — fail open, but visibly. */
const UNAVAILABLE: RetrievalResult = Object.freeze({
  additionalContext: frameUnavailableNotice(),
  block: false,          // fail-open is absolute: never block when we cannot verify
  hitCount: 0,
  isGap: false,          // NOT a gap — memory was never asked
  unavailable: true,
});
```

Constructor gains the store:

```ts
  private readonly topics: SessionTopicStore;
  constructor(
    private readonly deps: BrokerDeps,
    store?: SessionShownStore,
    topicStore?: SessionTopicStore,
  ) {
    this.store = store ?? new SessionShownStore(deps.sessionId);
    this.topics = topicStore ?? new SessionTopicStore(deps.sessionId);
  }
```

`decide` takes the topic and computes `block` independent of hit count:

```ts
  /** Amendment 1 — `block` keys on "not yet consulted for this topic", NOT on hit
   *  count. The reverted design blocked when memory had >=1 hit, so a rich corpus
   *  blocked nearly everything. Inverting this makes blocks RARER as memory grows:
   *  a good recall means the agent never reaches for the search at all. */
  private decide(hits: ProvenancedMemory[], allowBlock: boolean, topic: string): RetrievalResult {
    const hitCount = hits.length;
    const block = allowBlock && this.mode() === 'hard' && topic.length > 0
      && !this.topics.hasConsulted(topic);
    const blockFields = block
      ? { block: true as const, blockReason: 'Consult MemSmith memory first — query ms-mem-search / observation_search for this topic, then re-run. Memory is the first source for why/decision questions; code is the verification pass.' }
      : { block: false as const };

    if (hitCount < this.minHits()) {
      // Real gap: memory WAS asked and had nothing. Still block if unconsulted —
      // the agent must ask before falling through to code.
      return { additionalContext: frameGapNote(), ...blockFields, hitCount, isGap: true, unavailable: false };
    }
    const shown = this.store.readShown();
    const fresh = hits.filter(h => !shown.has(h.id));
    if (fresh.length === 0) {
      return { additionalContext: '', ...blockFields, hitCount, isGap: false, unavailable: false };
    }
    this.store.markShown(fresh.map(h => h.id));
    return { additionalContext: frameMemory(fresh), ...blockFields, hitCount, isGap: false, unavailable: false };
  }

  async forPrompt(promptText: string): Promise<RetrievalResult> {
    if (!promptText || promptText.trim().length === 0) return EMPTY;
    const hits = await this.query(promptText);
    if (hits === FAILED) return UNAVAILABLE;
    return this.decide(hits, /* allowBlock */ false, topicKey(promptText));
  }

  async forToolIntent(toolName: string, toolArgs: unknown): Promise<RetrievalResult> {
    const q = deriveQueryFromTool(toolName, toolArgs);
    if (q === null) return EMPTY; // not a search-intent tool — nothing to enforce
    const hits = await this.query(q);
    if (hits === FAILED) return UNAVAILABLE;
    return this.decide(hits, /* allowBlock */ true, topicKey(q));
  }
```

Also update the `logger.debug` in `query()` to `logger.warn` — an unavailable memory system is
a warning, not a debug detail:

```ts
      logger.warn('HOOK', 'retrieval unavailable (fail-open, surfaced to user)', { error: err instanceof Error ? err.message : String(err) });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/retrieval/broker.test.ts`
Expected: PASS — all pre-existing tests plus 12 new. Pre-existing tests asserting
`RetrievalResult` shape may need `unavailable: false` added to expected literals; update them,
do not weaken assertions.

- [ ] **Step 5: Commit**

```bash
git add src/services/retrieval/broker.ts src/services/retrieval/types.ts src/services/retrieval/directive.ts tests/retrieval/broker.test.ts
git commit -m "feat(retrieval): key blocking on consulted-topic, surface unavailability"
```

---

### Task 4: Gate `Read` to cold reads; pin Bash shaping

**Files:**
- Modify: `src/services/retrieval/query-derivation.ts`
- Test: `tests/retrieval/query-derivation.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `deriveQueryFromTool(toolName, toolArgs, opts?: { warmPaths?: ReadonlySet<string> }): string | null`

Amendment 1 scope: `Read` gates only a **cold** read. Re-reading a file already in context is
not seeking information. `warmPaths` is injected (not read from disk here) to keep this pure —
the adapter supplies it in Task 6. When `warmPaths` is omitted, behavior is unchanged, so no
existing caller breaks.

- [ ] **Step 1: Write the failing tests**

```ts
describe('Amendment 1 — Read gating', () => {
  it('derives a query for a COLD read', () => {
    expect(deriveQueryFromTool('Read', { file_path: '/a/generation-health.ts' }, { warmPaths: new Set() }))
      .toBe('generation-health a');
  });

  it('returns null for a WARM read — re-reading is not seeking information', () => {
    expect(deriveQueryFromTool('Read', { file_path: '/a/generation-health.ts' },
      { warmPaths: new Set(['/a/generation-health.ts']) })).toBeNull();
  });

  it('is unchanged when warmPaths is omitted (back-compat)', () => {
    expect(deriveQueryFromTool('Read', { file_path: '/a/x.ts' })).toBe('x a');
  });
});

describe('Bash search-shaping (regression pin — already implemented)', () => {
  it.each(['grep -rn foo src/', 'rg foo', 'find . -name x', 'ag foo'])(
    'treats %s as search intent', (cmd) => {
      expect(deriveQueryFromTool('Bash', { command: cmd })).not.toBeNull();
    });

  it.each(['npm test', 'git status', 'bun run build', 'ls -la'])(
    'does NOT gate routine command %s', (cmd) => {
      expect(deriveQueryFromTool('Bash', { command: cmd })).toBeNull();
    });

  it('does not gate a command that merely CONTAINS a search word', () => {
    expect(deriveQueryFromTool('Bash', { command: 'npm run findme' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/retrieval/query-derivation.test.ts`
Expected: FAIL on the warm-read case (returns a string, expected `null`). The Bash cases should
already PASS — they pin existing behavior. If `npm run findme` fails, note it: the
`\b`-anchored regex may need a word-start guard.

- [ ] **Step 3: Implement**

```ts
export interface DeriveOpts {
  /** Absolute paths already in the agent's context. A re-read of one of these is
   *  not "seeking information", so it is not gated (Amendment 1). Omit to keep
   *  the pre-amendment behavior. */
  warmPaths?: ReadonlySet<string>;
}

export function deriveQueryFromTool(
  toolName: string,
  toolArgs: unknown,
  opts: DeriveOpts = {},
): string | null {
```

In the `Read` branch, before deriving:

```ts
    case 'Read': {
      const fp = args.file_path;
      if (typeof fp !== 'string' || fp.length === 0) return null;
      // Amendment 1: only a COLD read is discovery. A re-read of a file already
      // in context is not seeking information and must not be gated.
      if (opts.warmPaths?.has(fp)) return null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/retrieval/query-derivation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/retrieval/query-derivation.ts tests/retrieval/query-derivation.test.ts
git commit -m "feat(retrieval): gate Read to cold reads; pin Bash search-shaping"
```

---

### Task 5: `memsmith enforcement` CLI — the non-gated escape hatch

**Files:**
- Create: `src/npx-cli/commands/enforcement.ts`
- Modify: `src/npx-cli/index.ts` (register the subcommand — match the file's existing dispatch style)
- Test: `tests/cli/enforcement.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `setEnforcement(mode: 'hard'|'soft', settingsPath: string): void`, `readEnforcement(settingsPath: string): string`

**This task MUST land before Task 7.** Per note `924c96d2`: disabling hard mode from inside a
hard-mode session requires a **non-gated write path**, because a gated tool call to change the
setting gets blocked by the mode being disabled. Hand-editing `settings.json` is how this got
reverted in July.

Pre-flight finding #3 rules out the dashboard route: `PATCH /v1/settings` writes **team
overrides to the database** keyed by `teamId`, and `MEMSMITH_RETRIEVAL_ENFORCEMENT` is not one
of the 18 keys in `settingKeys.ts`. Hooks read `~/.memsmith/settings.json`. A CLI writing that
file directly is the correct escape hatch here, and it is not tool-gated (the user runs it in
their own shell). A dashboard toggle would additionally require making enforcement a team key
and teaching hooks to read team overrides — a larger change, deferred.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setEnforcement, readEnforcement } from '../../src/npx-cli/commands/enforcement.js';

let dir: string; let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ms-enf-'));
  file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ MEMSMITH_RETRIEVAL_ENFORCEMENT: 'soft', MEMSMITH_OTHER: 'keep' }));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('enforcement CLI', () => {
  it('reads the current mode', () => {
    expect(readEnforcement(file)).toBe('soft');
  });

  it('flips soft -> hard', () => {
    setEnforcement('hard', file);
    expect(readEnforcement(file)).toBe('hard');
  });

  it('flips hard -> soft (the escape hatch)', () => {
    setEnforcement('hard', file);
    setEnforcement('soft', file);
    expect(readEnforcement(file)).toBe('soft');
  });

  it('preserves every other setting', () => {
    setEnforcement('hard', file);
    expect(JSON.parse(readFileSync(file, 'utf-8')).MEMSMITH_OTHER).toBe('keep');
  });

  it('defaults to soft when the key is absent', () => {
    writeFileSync(file, JSON.stringify({}));
    expect(readEnforcement(file)).toBe('soft');
  });

  it('reports soft for a missing file rather than throwing', () => {
    expect(readEnforcement(join(dir, 'nope.json'))).toBe('soft');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/enforcement.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/npx-cli/commands/enforcement.ts
// `memsmith enforcement on|off|status` — the non-gated escape hatch.
//
// WHY THIS EXISTS: hard mode blocks gated tool calls. If the only way to turn it
// off were a gated tool call, the agent could not disable the mode that is
// blocking it, and the user would be left hand-editing JSON — which is exactly
// how hard mode got reverted in July 2026 (note 924c96d2). This command runs in
// the user's own shell, so it is never tool-gated.
//
// It writes ~/.memsmith/settings.json directly, because that is the file the
// HOOKS read (via loadFromFileOnce). PATCH /v1/settings is a different store —
// team overrides in Postgres, keyed by teamId — and does not carry this key.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { styleText } from 'node:util';

const KEY = 'MEMSMITH_RETRIEVAL_ENFORCEMENT';

export function defaultSettingsPath(): string {
  return join(homedir(), '.memsmith', 'settings.json');
}

export function readEnforcement(settingsPath: string = defaultSettingsPath()): string {
  try {
    if (!existsSync(settingsPath)) return 'soft';
    const j = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    return j[KEY] === 'hard' ? 'hard' : 'soft';
  } catch {
    return 'soft';
  }
}

export function setEnforcement(mode: 'hard' | 'soft', settingsPath: string = defaultSettingsPath()): void {
  // Read-modify-write so unrelated settings survive.
  let j: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath)) j = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    j = {};
  }
  j[KEY] = mode;
  writeFileSync(settingsPath, `${JSON.stringify(j, null, 2)}\n`, 'utf-8');
}

export function runEnforcementCommand(argv: string[]): void {
  const sub = (argv[0] ?? 'status').toLowerCase();
  if (sub === 'status') {
    console.log(`memory-first enforcement: ${readEnforcement()}`);
    return;
  }
  if (sub === 'on' || sub === 'hard') {
    setEnforcement('hard');
    console.log(styleText('green', 'memory-first enforcement: hard (memory consulted before discovery searches)'));
    console.log('Disable at any time with: npx memsmith enforcement off');
    return;
  }
  if (sub === 'off' || sub === 'soft') {
    setEnforcement('soft');
    console.log(styleText('yellow', 'memory-first enforcement: soft (inject-only, never blocks)'));
    return;
  }
  console.error(styleText('red', `Unknown enforcement subcommand: ${sub}`));
  console.error('Usage: npx memsmith enforcement on|off|status');
  process.exit(1);
}
```

Register it in `src/npx-cli/index.ts` following that file's existing dispatch pattern
(`enforcement` → `runEnforcementCommand(argv.slice(1))`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/enforcement.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Verify the CLI end-to-end without changing live state**

```bash
npx memsmith enforcement status
```
Expected: `memory-first enforcement: soft`

- [ ] **Step 6: Commit**

```bash
git add src/npx-cli/commands/enforcement.ts src/npx-cli/index.ts tests/cli/enforcement.test.ts
git commit -m "feat(cli): add memsmith enforcement on|off|status escape hatch"
```

---

### Task 6: Adapter — mark consulted, pass warm paths, surface unavailability

**Files:**
- Modify: `src/cli/handlers/tool-intent.ts`
- Test: `tests/cli/handlers/tool-intent.test.ts` (extend; create if absent)

**Interfaces:**
- Consumes: `SessionTopicStore` (Task 2), `topicKey` (Task 1), `RetrievalResult.unavailable` (Task 3), `DeriveOpts.warmPaths` (Task 4).
- Produces: no new exports.

Two responsibilities the broker deliberately does not own:

1. **Marking a topic consulted.** The signal is the agent calling a memory MCP tool. Those
   arrive at `PreToolUse` with names matching `mcp__plugin_memsmith_mem__*` (also
   `mcp__plugin_claude-mem_mcp-search__*`). On such a call, derive the topic from the tool's
   `query` argument and `markConsulted` it — then allow. This is what unlocks the topic.
2. **Warm-path tracking.** Record each `Read` path in the session dir so a later re-read is
   warm. Keep it in the same session directory as the other two stores.

- [ ] **Step 1: Write the failing tests**

```ts
describe('tool-intent adapter — Amendment 1/2 wiring', () => {
  it('marks the topic consulted when a memory search tool is called, and allows it', async () => {
    const r = await toolIntentHandler.execute(fakeInput({
      toolName: 'mcp__plugin_memsmith_mem__observation_search',
      toolInput: { query: 'ollama restart' },
      sessionId: 'sx',
    }));
    expect(r.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(new SessionTopicStore('sx', tmpBase).hasConsulted(topicKey('ollama restart'))).toBe(true);
  });

  it('never denies a memory tool call — that would deadlock the gate', async () => {
    const r = await toolIntentHandler.execute(fakeInput({
      toolName: 'mcp__plugin_memsmith_mem__smart_search',
      toolInput: { query: 'anything' }, sessionId: 'sy',
    }));
    expect(r.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('emits the unavailable notice as additionalContext and still allows', async () => {
    // runtime unresolvable => broker.query returns FAILED
    const r = await toolIntentHandler.execute(fakeInput({
      toolName: 'Grep', toolInput: { pattern: 'ollama' }, sessionId: 'sz', breakRuntime: true,
    }));
    expect(r.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(r.hookSpecificOutput?.additionalContext).toMatch(/unavailable/i);
  });

  it('allows the tool through when the handler throws (fail-open)', async () => {
    const r = await toolIntentHandler.execute(fakeInput({ toolName: 'Grep', toolInput: null as any }));
    expect(r.hookSpecificOutput?.permissionDecision).toBe('allow');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/handlers/tool-intent.test.ts`
Expected: FAIL — topic not marked; no unavailable notice.

- [ ] **Step 3: Implement**

Add to `tool-intent.ts`:

```ts
import { SessionTopicStore } from '../../services/retrieval/topic-store.js';
import { topicKey } from '../../services/retrieval/topic-key.js';
import { WarmPathStore } from '../../services/retrieval/warm-path-store.js';

/** Memory-consultation tools. A call to one of these is the agent DOING the
 *  memory-first step, so it unlocks the topic — and must never be denied, or the
 *  gate would deadlock (blocked search, blocked way to unblock it). */
const MEMORY_TOOL = /^mcp__plugin_(memsmith_mem|claude-mem_mcp-search)__/;
```

Early in `execute`, before the broker runs:

```ts
      if (MEMORY_TOOL.test(toolName)) {
        // The agent is consulting memory: record the topic, always allow.
        const q = (input.toolInput as Record<string, unknown> | null)?.query;
        if (typeof q === 'string' && q.trim()) {
          new SessionTopicStore(input.sessionId).markConsulted(topicKey(q));
        }
        return ALLOW;
      }
```

Warm-path tracking for `Read`, and pass the set through. `WarmPathStore` is a third small
store in the same session dir with the same never-throw contract as `SessionTopicStore`
(create it in this task, mirroring Task 2's file — `warm.json`, `has(path)`, `mark(path)`).

The broker currently calls `deriveQueryFromTool` internally, so pass warm paths via
`BrokerDeps` rather than threading a new parameter through `forToolIntent`: add
`warmPaths?: ReadonlySet<string>` to `BrokerDeps`, and have the broker forward it as
`deriveQueryFromTool(toolName, toolArgs, { warmPaths: this.deps.warmPaths })`.

The unavailable notice needs no new branch — `result.additionalContext` already carries it and
the existing allow-path returns it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/cli/handlers/tool-intent.test.ts tests/retrieval/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/handlers/tool-intent.ts src/services/retrieval/warm-path-store.ts src/services/retrieval/types.ts src/services/retrieval/broker.ts tests/
git commit -m "feat(retrieval): mark consulted topics from memory tool calls; track warm reads"
```

---

### Task 7: Full-suite gate, build/sync, and live validation

**Files:** none modified (verification only), except `plugin/hooks/hooks.json` if the matcher
needs narrowing.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Full test suite**

Run: `bun test`
Expected: no failures. Any pre-existing failure must be confirmed pre-existing on
`git stash` before proceeding.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors in touched files. (`bun build` only transpiles — it does NOT typecheck; a
prior session was misled by a false exit 0 this way, per memory obs `550`.)

- [ ] **Step 3: Confirm the PreToolUse matcher covers the memory tools**

`hooks.json` routes `Grep|Glob|Read|Bash` to `tool-intent`. The consulted-marking in Task 6
only fires if the memory MCP tools ALSO reach that handler. Check:

```bash
python3 -c "
import json;d=json.load(open('plugin/hooks/hooks.json'))
for b in d['hooks']['PreToolUse']:
    print(b.get('matcher'), '->', b['hooks'][0]['command'].split('server-service.cjs')[-1].strip().strip('\"').split(';')[0])
"
```

If no matcher routes `mcp__plugin_memsmith_mem__*` to `tool-intent`, add one — otherwise
consulting memory never unlocks the topic and every search blocks forever. This is the single
most important check in the plan.

- [ ] **Step 4: Build and sync**

Run: `npm run build-and-sync`
Expected: completes; server restarts.

- [ ] **Step 5: Live validation — soft mode unchanged**

With enforcement still `soft`, confirm a Grep is not denied and the session still works
normally. Record the observed behavior.

- [ ] **Step 6: Live validation — hard mode, the real test**

```bash
npx memsmith enforcement on
```

Then, in a **new** session, verify each of these and record actual output:

1. A `Grep` on a fresh topic → **denied** with the consult-memory reason.
2. An `observation_search` on that topic → **allowed**.
3. The same `Grep` again → **allowed** (topic now consulted).
4. A `Grep` on a *different* topic → **denied** (topic scoping works).
5. `npm test` via Bash → **allowed** (routine Bash never gated).
6. Re-`Read` of a file already read → **allowed** (warm read).
7. Stop the server, then `Grep` → **allowed**, with the visible unavailable notice
   (fail-open + Amendment 2).

- [ ] **Step 7: Escape-hatch drill**

From inside a hard-mode session, run `npx memsmith enforcement off` and confirm it succeeds and
takes effect. This is the drill that was never run in July.

- [ ] **Step 8: Decide the shipped default and commit**

Report the validation results. The shipped default (`hard` vs `soft` in
`SettingsDefaultsManager` DEFAULTS) is the user's call — do NOT flip the installed default
without confirmation, since it changes behavior for every user at install time.

```bash
git add -A && git commit -m "test: validate always-memory-first enforcement end-to-end"
```

---

## Notes for the executor

- **Enforcement stays `soft` until Task 7.** Every commit before that is behavior-neutral on
  install.
- **Never make a memory tool call blockable.** A denied search plus a denied way to search
  memory is a deadlock. Task 6's `MEMORY_TOOL` early-return is load-bearing.
- **Fail-open is absolute.** If you find yourself writing a branch where a broker/hook error can
  produce `block: true`, it is wrong.
- **Do not weaken a test to make it pass.** Four fixtures in this project's history could not
  distinguish pass from fail. If a test seems impossible to satisfy, escalate instead.
