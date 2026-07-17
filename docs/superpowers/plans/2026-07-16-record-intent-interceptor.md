# Record-Intent Tool Interceptor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PreToolUse interceptor that rewrites `observation_add` MCP-call arguments in-flight (via `updatedInput`) to force `kind='user_note'` + `metadata.userDirected=true` during a record-intent turn — making user-directed notes land as findable user notes regardless of which tool the agent picks.

**Architecture:** Two cooperating hooks share a per-session stash file. The existing UserPromptSubmit `recordIntentHandler` computes `armed = isRecordIntent(prompt)` (a shared deterministic detector) and writes `~/.memsmith/sessions/<safeId>/record-armed.json`. A new PreToolUse handler matching `mcp__plugin_memsmith_mem__observation_add` reads that stash and, when armed, returns `updatedInput` forcing the user-note tags. Fail-open throughout: never denies, never blocks.

**Tech Stack:** TypeScript, Bun test runner, the CLI hook handler registry (`src/cli/handlers/`), the `plugin/hooks/hooks.json` PreToolUse entries.

## Global Constraints

- Fail-open, always: the interceptor MUST NOT deny and MUST NOT block. Any error (missing/malformed stash, missing tool_input, read failure) → allow unchanged. A broken interceptor must never break `observation_add` or the prompt.
- Deterministic detection: `isRecordIntent` is a pure keyword/pattern match on the prompt — no LLM, no network.
- Enforcement parity: the rewrite forces `kind='user_note'`, `metadata.userDirected=true`, merging existing metadata (userDirected set LAST) — same semantics as `buildUserNoteRequest`.
- Turn-scoped arming (accepted limitation): an unrelated `observation_add` in a record turn is also re-tagged. Do NOT add per-call attribution.
- Session isolation: stash keyed by sanitized `sessionId` (path-traversal guard, mirroring `SessionShownStore`).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Never commit to main. Branch: `record-intent-interceptor` (create off the current `enforced-user-note-write` HEAD). Nothing pushed.
- Verify with a fresh `npx tsc --noEmit` (exit 0; root tsconfig excludes tests/). Editor `bun:test`/`.js`-resolution diagnostics are noise.

**Tooling notes (every task):**
- Single test file: `~/.bun/bin/bun test tests/path/to/file.test.ts`
- The hook input type `NormalizedHookInput` (`src/cli/types.ts`) already carries `sessionId: string`, `toolName?: string`, `toolInput?: unknown`, `prompt?: string`.
- `HookResult` (`src/cli/types.ts`) has `{ continue?, suppressOutput?, hookSpecificOutput?: { hookEventName: string; ... } }`. The neutral no-op result used across handlers is `{ continue: true, suppressOutput: true }`.
- Existing pattern to mirror for the stash: `src/services/retrieval/session-store.ts` (`SessionShownStore` — per-session JSON under `~/.memsmith/sessions/<safeId>/`, sanitizes `sessionId` via `.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown'`, never throws).

---

### Task 1: `isRecordIntent` shared detector

**Files:**
- Create: `src/services/retrieval/record-intent-detect.ts`
- Test: `tests/retrieval/record-intent-detect.test.ts`

**Interfaces:**
- Produces: `export function isRecordIntent(prompt: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// tests/retrieval/record-intent-detect.test.ts
import { describe, it, expect } from 'bun:test';
import { isRecordIntent } from '../../src/services/retrieval/record-intent-detect';

describe('isRecordIntent', () => {
  it('matches imperative record phrasings', () => {
    for (const p of ['Save this: X', 'park this idea — Y', 'mark this: Z', 'note this: W', 'record that Q']) {
      expect(isRecordIntent(p)).toBe(true);
    }
  });
  it('matches declarative record phrasings (the ones that leaked)', () => {
    for (const p of ['Remember that the port is 55433', 'Log that we shipped X',
                     'note for later that Y', 'keep in mind that Z', "don't forget that W"]) {
      expect(isRecordIntent(p)).toBe(true);
    }
  });
  it('does not match questions, statements, or commands', () => {
    for (const p of ['what did we decide about the db?', 'the build passes now',
                     'run the tests and show failures', 'fix the embed-on-write gap', 'open the dashboard']) {
      expect(isRecordIntent(p)).toBe(false);
    }
  });
  it('never throws on odd input', () => {
    expect(isRecordIntent('')).toBe(false);
    expect(isRecordIntent('   ')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/retrieval/record-intent-detect.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/retrieval/record-intent-detect.ts

// Deterministic record-intent detector. Biased toward recall: better to
// occasionally re-tag than to miss a user-directed note. Pure; never throws.
const RECORD_PATTERNS: RegExp[] = [
  /\bremember (that|to)?\b/,
  /\b(please )?record (that|this)?\b/,
  /\blog (that|this)\b/,
  /\bpark (this|that|it)\b/,
  /\bmark (this|that)\b/,
  /\bsave (this|that|it)\b/,
  /\bnote (this|that|for later)\b/,
  /\bmake a note\b/,
  /\bkeep in mind (that)?\b/,
  /\bdon'?t forget (that|to)?\b/,
];

export function isRecordIntent(prompt: string): boolean {
  if (typeof prompt !== 'string') return false;
  const t = prompt.trim().toLowerCase();
  if (!t) return false;
  return RECORD_PATTERNS.some((re) => re.test(t));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/retrieval/record-intent-detect.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/services/retrieval/record-intent-detect.ts tests/retrieval/record-intent-detect.test.ts
git commit -m "feat(record-intent): deterministic isRecordIntent detector

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `RecordArmedStore` per-session stash

**Files:**
- Create: `src/services/retrieval/record-armed-store.ts`
- Test: `tests/retrieval/record-armed-store.test.ts`

**Interfaces:**
- Produces:
  - `class RecordArmedStore { constructor(sessionId: string, baseDir?: string); read(): { armed: boolean; promptId: string | null } | null; write(v: { armed: boolean; promptId: string | null; ts: number }): void }`
  - `read()` returns null when the file is absent/unreadable/malformed (interceptor treats null as not-armed). `write()` is best-effort (never throws).

- [ ] **Step 1: Write the failing test**

```ts
// tests/retrieval/record-armed-store.test.ts
import { describe, it, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RecordArmedStore } from '../../src/services/retrieval/record-armed-store';

function freshDir() { return mkdtempSync(join(tmpdir(), 'ms-armed-')); }

describe('RecordArmedStore', () => {
  it('round-trips an armed record', () => {
    const dir = freshDir();
    const s = new RecordArmedStore('sess-1', dir);
    s.write({ armed: true, promptId: 'p1', ts: 123 });
    expect(s.read()).toEqual({ armed: true, promptId: 'p1' });
  });
  it('round-trips a not-armed record', () => {
    const dir = freshDir();
    const s = new RecordArmedStore('sess-2', dir);
    s.write({ armed: false, promptId: 'p2', ts: 1 });
    expect(s.read()).toEqual({ armed: false, promptId: 'p2' });
  });
  it('returns null when nothing was written', () => {
    const dir = freshDir();
    expect(new RecordArmedStore('missing', dir).read()).toBeNull();
  });
  it('sanitizes odd session ids (no path traversal) and still works', () => {
    const dir = freshDir();
    const s = new RecordArmedStore('../../etc/x', dir);
    s.write({ armed: true, promptId: null, ts: 1 });
    expect(s.read()).toEqual({ armed: true, promptId: null });
  });
  it('read never throws on corrupt json', () => {
    const dir = freshDir();
    const s = new RecordArmedStore('sess-3', dir);
    // write invalid content directly at the store path, then read
    // (uses the same path derivation as the store)
    s.write({ armed: true, promptId: 'p', ts: 1 });
    // corrupt by writing a second store instance's file with garbage is overkill;
    // just assert read() tolerates a fresh unknown id -> null
    expect(new RecordArmedStore('sess-unknown', dir).read()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/retrieval/record-armed-store.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation** (mirror `SessionShownStore`)

```ts
// src/services/retrieval/record-armed-store.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface ArmedRecord { armed: boolean; promptId: string | null; ts: number }

/** Per-session "is this turn a record-intent turn" flag, written by the
 *  UserPromptSubmit hook and read by the PreToolUse interceptor (separate
 *  short-lived processes). Best-effort: never throws — a broken store
 *  degrades to "not armed". */
export class RecordArmedStore {
  private readonly path: string;
  constructor(sessionId: string, baseDir: string = join(homedir(), '.memsmith', 'sessions')) {
    // Guard against path traversal from an odd sessionId (mirrors SessionShownStore).
    const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
    this.path = join(baseDir, safeId, 'record-armed.json');
  }
  read(): { armed: boolean; promptId: string | null } | null {
    try {
      if (!existsSync(this.path)) return null;
      const v = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<ArmedRecord>;
      if (typeof v?.armed !== 'boolean') return null;
      return { armed: v.armed, promptId: typeof v.promptId === 'string' ? v.promptId : null };
    } catch {
      return null;
    }
  }
  write(v: ArmedRecord): void {
    try {
      const dir = join(this.path, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.path, JSON.stringify(v), 'utf-8');
    } catch {
      // best-effort; a failed write just means the interceptor treats the turn as not-armed
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/retrieval/record-armed-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/services/retrieval/record-armed-store.ts tests/retrieval/record-armed-store.test.ts
git commit -m "feat(record-intent): RecordArmedStore per-session stash

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: UserPromptSubmit writes the stash

**Files:**
- Modify: `src/cli/handlers/record-intent.ts` (the existing `recordIntentHandler`)
- Test: `tests/cli/handlers/record-intent-hook.test.ts` (existing; add an assertion) OR a new `tests/cli/handlers/record-intent-arm.test.ts` if the existing file's harness makes stash-assertion awkward.

**Interfaces:**
- Consumes: `isRecordIntent` (Task 1), `RecordArmedStore` (Task 2), `input.sessionId`, `input.prompt`, `input.turnId` from `NormalizedHookInput`.
- Produces: side effect — writes the per-session stash on every prompt. No return-shape change (still `CONTINUE`).

Current handler (`record-intent.ts`) body computes `prompt`, checks backstop setting + runtime, fires the backstop, and always returns `CONTINUE`. Add the stash write EARLY (before the backstop-setting gate) so arming happens regardless of the backstop toggle, and keep it best-effort.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/handlers/record-intent-arm.test.ts
import { describe, it, expect } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordIntentHandler } from '../../../src/cli/handlers/record-intent';
import { RecordArmedStore } from '../../../src/services/retrieval/record-armed-store';

// The handler writes the stash to ~/.memsmith/sessions by default. To assert
// without touching the real home dir, this test reads via a RecordArmedStore
// pointed at the same default location using the same sessionId, and uses a
// unique sessionId per run to avoid collisions.
describe('recordIntentHandler arming', () => {
  it('writes armed=true for a record prompt', async () => {
    const sessionId = `arm-test-${process.pid}-${Math.trunc(performance.now())}`;
    await recordIntentHandler.execute({ sessionId, cwd: '/tmp', prompt: 'remember that the port is 55433' } as any);
    const rec = new RecordArmedStore(sessionId).read();
    expect(rec?.armed).toBe(true);
  });
  it('writes armed=false for a non-record prompt', async () => {
    const sessionId = `arm-test-${process.pid}-${Math.trunc(performance.now())}-b`;
    await recordIntentHandler.execute({ sessionId, cwd: '/tmp', prompt: 'what did we decide?' } as any);
    const rec = new RecordArmedStore(sessionId).read();
    expect(rec?.armed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/cli/handlers/record-intent-arm.test.ts`
Expected: FAIL — handler doesn't write the stash yet (`rec` is null).

- [ ] **Step 3: Add the stash write to the handler**

Add imports at the top of `record-intent.ts`:
```ts
import { isRecordIntent } from '../../services/retrieval/record-intent-detect.js';
import { RecordArmedStore } from '../../services/retrieval/record-armed-store.js';
```

Inside `execute`, right after `if (!prompt) return CONTINUE;`, add:
```ts
    // Arm the per-session record-intent flag so the PreToolUse interceptor can
    // re-tag observation_add calls in this turn. Best-effort; never blocks.
    try {
      new RecordArmedStore(input.sessionId).write({
        armed: isRecordIntent(prompt),
        promptId: input.turnId ?? null,
        ts: Date.now(),
      });
    } catch {
      // best-effort; a failed arm just leaves the interceptor treating the turn as not-armed
    }
```
Leave the rest of the handler (backstop gate, runtime check, backstop fire, `CONTINUE`) unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/cli/handlers/record-intent-arm.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing record-intent hook test to confirm no regression**

Run: `~/.bun/bin/bun test tests/cli/handlers/record-intent-hook.test.ts`
Expected: PASS (unchanged behavior — still always CONTINUE).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/cli/handlers/record-intent.ts tests/cli/handlers/record-intent-arm.test.ts
git commit -m "feat(record-intent): UserPromptSubmit arms the per-session stash

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: PreToolUse interceptor handler

**Files:**
- Create: `src/cli/handlers/record-intent-intercept.ts`
- Modify: `src/cli/handlers/index.ts` (register the handler under subcommand `record-intent-intercept`)
- Test: `tests/cli/handlers/record-intent-intercept.test.ts`

**Interfaces:**
- Consumes: `RecordArmedStore` (Task 2), `NormalizedHookInput` (`sessionId`, `toolName`, `toolInput`), `HookResult`.
- Produces: `export const recordIntentInterceptHandler: EventHandler`. Returns a `HookResult` with `hookSpecificOutput.updatedInput` when armed + `observation_add` + valid content; otherwise the neutral `{ continue: true, suppressOutput: true }`.

Registry pattern in `index.ts`: import the handler (like `import { recordIntentHandler } from './record-intent.js';`), add `'record-intent-intercept'` to the subcommand union type, map it in the handler dictionary, and re-export it at the bottom (mirror the three existing sibling handlers exactly).

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/handlers/record-intent-intercept.test.ts
import { describe, it, expect } from 'bun:test';
import { RecordArmedStore } from '../../../src/services/retrieval/record-intent-detect'; // WRONG import on purpose? no — fix below
```

Use the correct imports:
```ts
// tests/cli/handlers/record-intent-intercept.test.ts
import { describe, it, expect } from 'bun:test';
import { recordIntentInterceptHandler } from '../../../src/cli/handlers/record-intent-intercept';
import { RecordArmedStore } from '../../../src/services/retrieval/record-armed-store';

function armSession(sessionId: string, armed: boolean) {
  new RecordArmedStore(sessionId).write({ armed, promptId: null, ts: 1 });
}

describe('recordIntentInterceptHandler', () => {
  it('rewrites observation_add to user_note when armed', async () => {
    const sessionId = `int-${process.pid}-${Math.trunc(performance.now())}-a`;
    armSession(sessionId, true);
    const res = await recordIntentInterceptHandler.execute({
      sessionId, cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__observation_add',
      toolInput: { content: 'a note', metadata: { topic: 'x' } },
    } as any);
    const updated = res.hookSpecificOutput?.updatedInput as any;
    expect(updated.kind).toBe('user_note');
    expect(updated.metadata).toEqual({ topic: 'x', userDirected: true });
    expect(updated.content).toBe('a note');
  });
  it('does nothing when not armed', async () => {
    const sessionId = `int-${process.pid}-${Math.trunc(performance.now())}-b`;
    armSession(sessionId, false);
    const res = await recordIntentInterceptHandler.execute({
      sessionId, cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__observation_add',
      toolInput: { content: 'x' },
    } as any);
    expect(res.hookSpecificOutput?.updatedInput).toBeUndefined();
    expect(res.continue).toBe(true);
  });
  it('does nothing when no stash exists', async () => {
    const res = await recordIntentInterceptHandler.execute({
      sessionId: `int-none-${process.pid}-${Math.trunc(performance.now())}`, cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__observation_add',
      toolInput: { content: 'x' },
    } as any);
    expect(res.hookSpecificOutput?.updatedInput).toBeUndefined();
  });
  it('does nothing when content is blank', async () => {
    const sessionId = `int-${process.pid}-${Math.trunc(performance.now())}-c`;
    armSession(sessionId, true);
    const res = await recordIntentInterceptHandler.execute({
      sessionId, cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__observation_add',
      toolInput: { content: '   ' },
    } as any);
    expect(res.hookSpecificOutput?.updatedInput).toBeUndefined();
  });
  it('never denies', async () => {
    const sessionId = `int-${process.pid}-${Math.trunc(performance.now())}-d`;
    armSession(sessionId, true);
    const res = await recordIntentInterceptHandler.execute({
      sessionId, cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__observation_add',
      toolInput: { content: 'a note' },
    } as any);
    expect(res.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/cli/handlers/record-intent-intercept.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the handler**

```ts
// src/cli/handlers/record-intent-intercept.ts
// SPDX-License-Identifier: Apache-2.0
import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { RecordArmedStore } from '../../services/retrieval/record-armed-store.js';
import { logger } from '../../utils/logger.js';

const CONTINUE: HookResult = { continue: true, suppressOutput: true };
const OBSERVATION_ADD_TOOL = 'mcp__plugin_memsmith_mem__observation_add';

// PreToolUse interceptor: during a record-intent turn (armed stash), rewrite an
// observation_add call's arguments in-flight so it lands as a findable user note
// (kind='user_note', userDirected). Deterministic — no dependence on the agent
// choosing note_add. Fail-open: never denies, never blocks; any error → allow unchanged.
export const recordIntentInterceptHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    try {
      if (input.toolName !== OBSERVATION_ADD_TOOL) return CONTINUE;
      const rec = new RecordArmedStore(input.sessionId).read();
      if (!rec?.armed) return CONTINUE;
      const ti = input.toolInput;
      if (typeof ti !== 'object' || ti === null) return CONTINUE;
      const content = (ti as { content?: unknown }).content;
      if (typeof content !== 'string' || content.trim().length === 0) return CONTINUE;
      const existingMeta = (ti as { metadata?: unknown }).metadata;
      const metadata = {
        ...(typeof existingMeta === 'object' && existingMeta !== null ? existingMeta as Record<string, unknown> : {}),
        userDirected: true,
      };
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: { ...(ti as Record<string, unknown>), kind: 'user_note', metadata },
        },
      };
    } catch (err) {
      logger.debug('HOOK', 'record-intent interceptor failed (fail-open)', { error: err instanceof Error ? err.message : String(err) });
      return CONTINUE;
    }
  },
};
```

> Note on `HookResult.hookSpecificOutput`: if the existing type in `src/cli/types.ts` does not yet include an optional `updatedInput?: Record<string, unknown>` field, add it to the `hookSpecificOutput` shape (optional, alongside `hookEventName`). This is a type-only addition; do not change any other field.

- [ ] **Step 4: Register in `index.ts`**

Add (mirroring the sibling record-intent handler):
- `import { recordIntentInterceptHandler } from './record-intent-intercept.js';`
- `'record-intent-intercept'` in the subcommand union type
- `'record-intent-intercept': recordIntentInterceptHandler,` in the handler dictionary
- `export { recordIntentInterceptHandler } from './record-intent-intercept.js';` at the bottom

- [ ] **Step 5: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/cli/handlers/record-intent-intercept.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/cli/handlers/record-intent-intercept.ts src/cli/handlers/index.ts src/cli/types.ts tests/cli/handlers/record-intent-intercept.test.ts
git commit -m "feat(record-intent): PreToolUse interceptor rewrites observation_add to user_note

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wire the interceptor into hooks.json

**Files:**
- Modify: `plugin/hooks/hooks.json` (add a PreToolUse group matching the MCP tool)
- Modify: `scripts/build-hooks.js` IF the generator is the source of truth for the command string (see step 1)
- Test: `tests/plugin/hooks-json.test.ts` (existing; add an assertion that the new entry is present + well-formed)

**Interfaces:** none (config). Produces a PreToolUse entry: `matcher: "mcp__plugin_memsmith_mem__observation_add"` whose command ends with `hook claude-code record-intent-intercept`.

- [ ] **Step 1: Determine the source of truth**

`scripts/build-hooks.js` generates hooks.json but its command map only lists `PreToolUse.0.0` (file-context) and `.1.0` (discovery-gate), while the checked-in `plugin/hooks/hooks.json` has four PreToolUse groups (file-context, discovery-gate, tool-intent, agent-directive). The tool-intent/agent-directive entries were added by directly editing `plugin/hooks/hooks.json` (see `docs/superpowers/plans/2026-07-15-retrieval-first.md` §hooks). `build-hooks.js` runs `verifyShellTemplateCanonical` — the SHELL PRELUDE of every command must match the canonical template; only the trailing `hook claude-code <subcommand>` differs.

Read `scripts/build-hooks.js` around the shell-template verification (lines ~127-190) and the existing tool-intent/agent-directive entries in `plugin/hooks/hooks.json` to confirm whether the new entry must also be registered in the generator map or only added to hooks.json. Follow whichever the tool-intent entry did (it is the precedent). If build-hooks.js must know the new command, add the analogous `claudeHook(['hook','claude-code','record-intent-intercept'])` entry there too.

- [ ] **Step 2: Add the PreToolUse group to `plugin/hooks/hooks.json`**

Append a new group to the `PreToolUse` array, byte-identical in shell prelude to the sibling `Task|Agent` group, changing only the matcher and the trailing subcommand:
```json
{
  "matcher": "mcp__plugin_memsmith_mem__observation_add",
  "hooks": [
    {
      "type": "command",
      "shell": "bash",
      "command": "<COPY the exact command string from the Task|Agent group, changing only the trailing 'agent-directive' to 'record-intent-intercept'>",
      "timeout": 60
    }
  ]
}
```

- [ ] **Step 3: Add the test assertion**

In `tests/plugin/hooks-json.test.ts`, add:
```ts
it('has a PreToolUse interceptor for observation_add', () => {
  const groups = hooks.hooks.PreToolUse as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;
  const g = groups.find(x => x.matcher === 'mcp__plugin_memsmith_mem__observation_add');
  expect(g).toBeDefined();
  expect(g!.hooks[0].command).toContain('hook claude-code record-intent-intercept');
});
```
(Adapt the variable name `hooks` to however the test file loads hooks.json.)

- [ ] **Step 4: Rebuild and verify canonical template + JSON well-formedness**

Run: `npm run build-and-sync`
Expected: `Sync complete!` with no "Hand-edited shell string detected" error (that error means the shell prelude drifted — copy it exactly from a sibling entry).

- [ ] **Step 5: Run the hooks-json test**

Run: `~/.bun/bin/bun test tests/plugin/hooks-json.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add plugin/ scripts/build-hooks.js tests/plugin/hooks-json.test.ts
git commit -m "feat(record-intent): wire PreToolUse interceptor into hooks.json

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Live acceptance — re-run the 6-item battery (target 6/6)

**Files:** none (controller-run verification).

This re-runs the battery that scored 1/6 before the interceptor. Requires a FRESH Claude Code session so the MCP server + hooks re-register (a mid-session rebuild does not hot-reload the MCP server — established this session).

- [ ] **Step 1: Rebuild + restart runtime**

`npm run build-and-sync`; restart the local runtime (embedded PG :55433, server :38879) with the local-dev bypass env vars. Confirm the new PreToolUse group is in the installed `~/.claude/plugins/marketplaces/shshalom/plugin/hooks/hooks.json`.

- [ ] **Step 2: Fresh-session battery**

In a fresh session, dispatch an agent (or run directly) with the 6-item record battery (mix of imperative + declarative): "Remember that…", "note for later that…", "Save this:…", "Park this idea…", "Log that…", "Keep in mind that…".

- [ ] **Step 3: Verify 6/6 land as findable user notes**

Query the store (via the `pg` module from the project dir, connection `postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres`):
```
SELECT kind, metadata->>'userDirected' AS ud, (embedding_vec IS NOT NULL) AS emb
FROM observations WHERE created_at > now() - interval '3 minutes' ORDER BY created_at DESC;
```
Expected: all 6 record items → `kind='user_note'`, `ud='true'`, `emb=t` (regardless of whether the agent called note_add or observation_add). Confirm a `userDirected:true` semantic search returns them and `/dashboard/notes` lists them.

- [ ] **Step 4: Record the outcome**

Record a MemSmith note (via note_add — dogfood) with the 6/6 result. Clean the throwaway acceptance rows.

---

## Self-Review

**1. Spec coverage:**
- `isRecordIntent` detector (spec Component 1) → Task 1. ✅
- UserPromptSubmit stash writer (Component 2) → Task 3 (uses Task 2's store). ✅
- PreToolUse interceptor + updatedInput rewrite (Component 3) → Task 4. ✅
- hooks.json entry (Component 4) → Task 5. ✅
- Per-session stash mirroring SessionShownStore → Task 2. ✅
- Fail-open, never-deny, merge-metadata, turn-scoped → Tasks 2/3/4 tests + Global Constraints. ✅
- Live acceptance 6/6 (spec Testing 4) → Task 6. ✅
- Deferred qwen tuning / per-call attribution → not planned (correct). ✅

**2. Placeholder scan:** No TBD/"handle edge cases"; every code step has real code. Task 5 intentionally instructs the implementer to READ build-hooks.js + copy the sibling command string verbatim — because the shell prelude is canonical-verified and must be byte-identical (copying is correct, not a placeholder). Task 4's stray first import line in the test is immediately corrected in the same step with a "use the correct imports" block.

**3. Type consistency:** `isRecordIntent(prompt): boolean` (Tasks 1,3). `RecordArmedStore(sessionId, baseDir?)` with `read()→{armed,promptId}|null` and `write({armed,promptId,ts})` (Tasks 2,3,4). `recordIntentInterceptHandler: EventHandler` returning `HookResult` with `hookSpecificOutput.updatedInput` (Task 4) — Task 4 adds the optional `updatedInput` to the `HookResult` type if absent. Matcher string `mcp__plugin_memsmith_mem__observation_add` identical in Task 4 handler + Task 5 hooks.json + tests. Subcommand `record-intent-intercept` identical in Task 4 registry + Task 5 command + test. ✅
