# Enforced User-Note Write Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make user-note tagging structurally impossible to get wrong — a dedicated `note_add` MCP tool taking only content, backed by one shared enforcer (`buildUserNoteRequest`) that hard-codes `kind='user_note'` + `metadata.userDirected=true`, used by both the agent tool and the `/v1/record-intent` backstop.

**Architecture:** One pure enforcer sets the two tags LAST (overriding any caller value). The new MCP tool exposes no tag params, so the agent's only choice is which tool to call. The backstop's existing write routes through the same enforcer so the two layers can't drift. Plus a one-line dashboard render-order change (Notes above Decisions).

**Tech Stack:** TypeScript, Bun test runner, the existing MCP server (`src/servers/mcp-server.ts`), the server v1 routes, and the React viewer (`src/ui/viewer`).

## Global Constraints

- Tags are ENFORCED, not requested: `buildUserNoteRequest` sets `kind='user_note'` and `metadata.userDirected=true` LAST; a caller passing `kind:'manual'` or `userDirected:false` MUST be overridden.
- The new `note_add` tool exposes only `content` (required) + `projectId` (optional). No `kind`/`metadata`/`userDirected`/`idempotencyKey` param on it.
- Detection phrasing is UNCHANGED — this plan touches only the WRITE path.
- One behavior, one place: exactly one enforcer sets the tags; both callers use it; no duplicated tag literals.
- No-file guarantee preserved: no record/note path writes to a file.
- Fail-open preserved: the backstop's UserPromptSubmit contract (never block) is unchanged; the enforcer is pure and never throws on a string input.
- Embed-on-write preserved: both paths still call `embedForPersist`; the enforcer only sets tags.
- `observation_add` stays generic and untouched.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Never commit to main. Work on branch `enforced-user-note-write` (already created). Nothing pushed.
- Verify with a fresh `tsc --noEmit` (root tsconfig excludes `tests/`); treat editor `bun:test`/`.js`-resolution diagnostics as noise.

**Tooling notes for every task:**
- Run a single test file: `~/.bun/bin/bun test tests/path/to/file.test.ts`
- Typecheck src: `npx tsc --noEmit` (expect exit 0).
- Existing types you will import:
  - `ServerAddObservationRequest` from `src/services/hooks/server-client.ts`:
    ```ts
    export interface ServerAddObservationRequest {
      projectId: string;
      serverSessionId?: string | null;
      kind?: string;
      content: string;
      metadata?: Record<string, unknown>;
      idempotencyKey?: string | null;
    }
    ```

---

### Task 1: `buildUserNoteRequest` shared enforcer

**Files:**
- Create: `src/services/retrieval/user-note-write.ts`
- Test: `tests/retrieval/user-note-write.test.ts`

**Interfaces:**
- Consumes: `ServerAddObservationRequest` from `../hooks/server-client.js`.
- Produces: `buildUserNoteRequest(content: string, opts: { projectId: string; idempotencyKey?: string | null; metadata?: Record<string, unknown> }): ServerAddObservationRequest` — returns a request with `kind:'user_note'` and `metadata.userDirected:true` forced, other metadata merged, content/projectId/idempotencyKey preserved.

- [ ] **Step 1: Write the failing test**

```ts
// tests/retrieval/user-note-write.test.ts
import { describe, it, expect } from 'bun:test';
import { buildUserNoteRequest } from '../../src/services/retrieval/user-note-write';

describe('buildUserNoteRequest', () => {
  it('forces kind=user_note and metadata.userDirected=true', () => {
    const req = buildUserNoteRequest('a note', { projectId: 'p1' });
    expect(req.kind).toBe('user_note');
    expect(req.metadata).toEqual({ userDirected: true });
    expect(req.content).toBe('a note');
    expect(req.projectId).toBe('p1');
  });

  it('overrides caller-supplied metadata.userDirected=false and merges other keys', () => {
    const req = buildUserNoteRequest('n', { projectId: 'p1', metadata: { userDirected: false, topic: 'x' } });
    expect(req.metadata).toEqual({ topic: 'x', userDirected: true });
  });

  it('preserves idempotencyKey when given', () => {
    const req = buildUserNoteRequest('n', { projectId: 'p1', idempotencyKey: 'k1' });
    expect(req.idempotencyKey).toBe('k1');
  });

  it('omits idempotencyKey when not given', () => {
    const req = buildUserNoteRequest('n', { projectId: 'p1' });
    expect('idempotencyKey' in req).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/retrieval/user-note-write.test.ts`
Expected: FAIL — cannot find module `user-note-write`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/services/retrieval/user-note-write.ts
import type { ServerAddObservationRequest } from '../hooks/server-client.js';

/**
 * Build a user-note write request with the tag guarantee enforced.
 * kind='user_note' and metadata.userDirected=true are set LAST, so any
 * caller-supplied kind/userDirected is overridden. Pure; never throws.
 */
export function buildUserNoteRequest(
  content: string,
  opts: { projectId: string; idempotencyKey?: string | null; metadata?: Record<string, unknown> },
): ServerAddObservationRequest {
  const request: ServerAddObservationRequest = {
    projectId: opts.projectId,
    content,
    kind: 'user_note',
    metadata: { ...(opts.metadata ?? {}), userDirected: true },
  };
  if (opts.idempotencyKey !== undefined) request.idempotencyKey = opts.idempotencyKey;
  return request;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/retrieval/user-note-write.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/services/retrieval/user-note-write.ts tests/retrieval/user-note-write.test.ts
git commit -m "feat(record-intent): buildUserNoteRequest shared tag enforcer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `note_add` MCP tool

**Files:**
- Modify: `src/servers/mcp-server.ts` (add `NoteAddArgs`, `handleNoteAdd`, and the tool registration; `handleObservationAdd` is at `:151-167`, the `observation_add` tool object at `:388-405`)
- Test: `tests/server/note-add-tool.test.ts`

**Interfaces:**
- Consumes: `buildUserNoteRequest` from `../services/retrieval/user-note-write.js`; `wrapHandler`, `requireServerForObservationTool`, `formatJsonResult` (already in `mcp-server.ts`); `ctx.client.addObservation`.
- Produces: a `note_add` tool whose handler writes a request carrying the forced tags.

- [ ] **Step 1: Write the failing test**

The handler is not individually exported today. This task also exports `handleNoteAdd` so it can be unit-tested with a stubbed context. Test the enforcement by capturing what the client receives.

```ts
// tests/server/note-add-tool.test.ts
import { describe, it, expect } from 'bun:test';
import { buildUserNoteRequest } from '../../src/services/retrieval/user-note-write';

// note_add's guarantee is delegated to buildUserNoteRequest; this test locks in
// that the tool's write shape carries the forced tags and only exposes content+projectId.
describe('note_add write shape', () => {
  it('produces a user_note/userDirected request from content alone', () => {
    const req = buildUserNoteRequest('composed note', { projectId: 'proj-x' });
    expect(req.kind).toBe('user_note');
    expect(req.metadata).toEqual({ userDirected: true });
    expect(req.content).toBe('composed note');
    expect(req.projectId).toBe('proj-x');
  });
});
```

> Rationale: `handleNoteAdd` depends on module-level server context (`requireServerForObservationTool`) that isn't wired in a unit test; the enforcement logic lives in `buildUserNoteRequest` (Task 1) and is fully covered there. This test documents the tool's contract. The live E2E in Task 6 exercises the real handler end-to-end.

- [ ] **Step 2: Run test to verify it passes**

Run: `~/.bun/bin/bun test tests/server/note-add-tool.test.ts`
Expected: PASS (imports Task 1's module).

- [ ] **Step 3: Add the args interface and handler in `mcp-server.ts`**

Add the import near the other `src/services/...` imports at the top of the file:

```ts
import { buildUserNoteRequest } from '../services/retrieval/user-note-write.js';
```

Add immediately after the `handleObservationAdd` handler (after `:167`):

```ts
interface NoteAddArgs {
  projectId?: string;
  content: string;
}

export const handleNoteAdd = wrapHandler('note_add', async (args: NoteAddArgs) => {
  const ctx = requireServerForObservationTool('note_add');
  if (typeof args?.content !== 'string' || args.content.trim().length === 0) {
    throw new Error('note_add: "content" is required');
  }
  const projectId = args.projectId && args.projectId.trim().length > 0 ? args.projectId : ctx.projectId;
  const request = buildUserNoteRequest(args.content, { projectId });
  const response = await ctx.client.addObservation(request);
  return formatJsonResult(response);
});
```

- [ ] **Step 4: Register the tool in the `tools[]` array**

Add this object immediately after the `observation_add` tool object (after its closing `},` at `:405`):

```ts
  {
    name: 'note_add',
    description: 'Record a user-directed note to memory. Use this whenever the user asks to record / remember / note / save / park / log something, in any phrasing. Hard-tags the note as a findable user note (kind=user_note, userDirected). Server runtime only. Params: content (required), projectId (optional, falls back to settings).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id (falls back to MEMSMITH_SERVER_PROJECT_ID)' },
        content: { type: 'string', description: 'The self-contained note to record (required)' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    handler: async (args: any) => handleNoteAdd(args ?? {}),
  },
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/servers/mcp-server.ts tests/server/note-add-tool.test.ts
git commit -m "feat(record-intent): note_add MCP tool (content-only, enforced tags)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Backstop routes through the enforcer

**Files:**
- Modify: `src/server/routes/v1/record-intent.ts:34-35` (the pure classifier builds the write)
- Test: `tests/server/record-intent-endpoint.test.ts` (existing; add/strengthen an assertion)

**Interfaces:**
- Consumes: `buildUserNoteRequest` from `../../../services/retrieval/user-note-write.js`.
- Produces: no signature change to `classifyAndComposeRecordIntent`; its `deps.write` is now called with a request built by the enforcer (same `kind`/`metadata`/`idempotencyKey` values as before, now sourced from one place).

Current code at `record-intent.ts:34-35`:
```ts
const idempotencyKey = computeContentIdempotencyKey({ teamId: deps.teamId, projectId: deps.projectId, kind: 'user_note', content: prompt });
await deps.write({ projectId: deps.projectId, teamId: deps.teamId, kind: 'user_note', content, metadata: { userDirected: true }, idempotencyKey });
```
Note `deps.write` also needs `teamId` (not part of `ServerAddObservationRequest`). So build the tag portion via the enforcer and spread it, keeping `teamId` explicit.

- [ ] **Step 1: Write/strengthen the failing test**

In `tests/server/record-intent-endpoint.test.ts`, add an assertion to the existing "RECORD: reply writes a marked user_note" test (or add a sibling test) that the object passed to `write` has `kind==='user_note'` AND `metadata.userDirected===true` AND that these come through even though the classifier no longer hard-codes the literals inline. Capture the `write` argument via the existing stub and assert:

```ts
// within the existing deps stub capture:
expect(written.kind).toBe('user_note');
expect(written.metadata).toEqual({ userDirected: true });
expect(typeof written.idempotencyKey).toBe('string');
expect(written.content).toBe(/* the composed content from the stubbed complete() */);
```

- [ ] **Step 2: Run test to verify current state**

Run: `~/.bun/bin/bun test tests/server/record-intent-endpoint.test.ts`
Expected: PASS already if the assertions match current behavior (this task must keep them passing after the refactor — it's a guard, not a red test). If you add a NEW assertion the current code doesn't satisfy, it should be one that still holds (behavior is byte-identical).

- [ ] **Step 3: Refactor the classifier to use the enforcer**

Add the import at the top of `record-intent.ts`:
```ts
import { buildUserNoteRequest } from '../../../services/retrieval/user-note-write.js';
```

Replace lines 34-35 with:
```ts
const idempotencyKey = computeContentIdempotencyKey({ teamId: deps.teamId, projectId: deps.projectId, kind: 'user_note', content: prompt });
const noteReq = buildUserNoteRequest(content, { projectId: deps.projectId, idempotencyKey });
await deps.write({
  projectId: deps.projectId,
  teamId: deps.teamId,
  kind: noteReq.kind as string,
  content: noteReq.content,
  metadata: noteReq.metadata as Record<string, unknown>,
  idempotencyKey: idempotencyKey,
});
```

> This keeps `deps.write`'s existing signature (which carries `teamId`, not part of `ServerAddObservationRequest`) while sourcing `kind`/`metadata` from the one enforcer. The idempotency key stays PROMPT-derived (the ecac70ee fix) — do not change it to content-derived.

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/.bun/bin/bun test tests/server/record-intent-endpoint.test.ts`
Expected: PASS (all existing + new assertions).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/v1/record-intent.ts tests/server/record-intent-endpoint.test.ts
git commit -m "refactor(record-intent): backstop write via shared enforcer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Point the directive at `note_add`

**Files:**
- Modify: `src/services/retrieval/directive.ts` (`RECORD_INTENT_DIRECTIVE`)
- Test: `tests/retrieval/record-intent-directive.test.ts` (existing)

**Interfaces:**
- Produces: `RECORD_INTENT_DIRECTIVE` now names the `note_add` tool and drops the manual `kind`/`metadata` param instruction. `INJECTED_DIRECTIVES` wiring unchanged.

- [ ] **Step 1: Update the failing test**

In `tests/retrieval/record-intent-directive.test.ts`, change the assertion that currently checks the directive mentions `observation_add` with `kind:"user_note"`/`userDirected` to instead assert it names `note_add` and does NOT instruct passing `kind`/`metadata` params:

```ts
it('names the note_add tool and does not ask the agent to set kind/metadata', () => {
  expect(RECORD_INTENT_DIRECTIVE).toContain('note_add');
  expect(RECORD_INTENT_DIRECTIVE).not.toContain('observation_add');
  expect(RECORD_INTENT_DIRECTIVE).not.toContain('kind:"user_note"');
  expect(RECORD_INTENT_DIRECTIVE).not.toContain('metadata.userDirected');
});
```
Keep the existing assertions for: record verbs, self-contained compose, confirm echo ("📝 Recorded to memory"), surface-on-failure, no-files.

- [ ] **Step 2: Run test to verify it fails**

Run: `~/.bun/bin/bun test tests/retrieval/record-intent-directive.test.ts`
Expected: FAIL — directive still says `observation_add`.

- [ ] **Step 3: Update the directive text**

Replace the `RECORD_INTENT_DIRECTIVE` array in `directive.ts` with:

```ts
export const RECORD_INTENT_DIRECTIVE = [
  'RECORD-INTENT (MemSmith core behavior):',
  'When the user asks you to record/remember/log/park/mark/save something to memory —',
  'in any natural phrasing — you MUST capture it: compose a SELF-CONTAINED observation',
  'from the conversation (resolve "that"/"it" into a standalone note), then call the',
  'note_add tool with that note as `content`. (note_add records it as a findable user',
  'note automatically — you do not set kind or metadata.) Then echo a one-line',
  'confirmation: "📝 Recorded to memory: <summary>". If the write fails, say so plainly',
  '("⚠ Couldn\'t record to memory — say it again / I\'ll retry"); never record the note',
  'to a file (TODO.md, CLAUDE.md, etc.) unless the user explicitly asks for a file.',
  'Memory is the record.',
].join('\n');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/.bun/bin/bun test tests/retrieval/record-intent-directive.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/services/retrieval/directive.ts tests/retrieval/record-intent-directive.test.ts
git commit -m "feat(record-intent): directive points agent at note_add

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Dashboard — Notes panel above Decisions

**Files:**
- Modify: `src/ui/viewer/views/DashboardView.tsx:369-370`

**Interfaces:** none (pure render-order change). No data/fetch change.

Current render order (`:369-370`):
```tsx
      <DecisionLog chains={chains} />
      <NotesPanel notes={notes} />
```

- [ ] **Step 1: Swap the two lines**

```tsx
      <NotesPanel notes={notes} />
      <DecisionLog chains={chains} />
```

- [ ] **Step 2: Build the viewer**

Run: `npm run build-and-sync`
Expected: `Sync complete!` (no build errors).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/ui/viewer/views/DashboardView.tsx plugin/
git commit -m "feat(dashboard): Notes panel above Decisions log

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Live acceptance — re-run Validations #2 and #3

**Files:** none (verification task; may add findings to the ledger).

This task is a controller-run live acceptance, not a code change. It re-runs the two validations that failed before the fix.

Prereqs: rebuild + restart the local runtime with the bypass env vars so the live server has the new tool and directive; Ollama up (only needed for the backstop, not for the agent path). Connection string for direct DB verification: `postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres` (role `memsmith`, NOT `postgres`; query via the `pg` module from the project dir, not the bundled psql which has a dyld linkage bug).

- [ ] **Step 1: Rebuild + restart**

`npm run build-and-sync`, kill the runtime on :38879/:55433, reboot with `MEMSMITH_RUNTIME=local MEMSMITH_AUTH_MODE=local-dev MEMSMITH_ALLOW_LOCAL_DEV_BYPASS=1` and the dogfood team/project IDs.

- [ ] **Step 2: Validation #2 — E2E agent**

Dispatch a fresh subagent (clean context, MemSmith plugin active) with 3 natural record prompts + 2 non-record items. It should now call `note_add`. Then verify against the store:
```
SELECT kind, metadata->>'userDirected' AS ud, (embedding_vec IS NOT NULL) AS embedded
FROM observations WHERE created_at > now() - interval '3 minutes' ORDER BY created_at DESC;
```
Expected: the recorded items are `kind='user_note'`, `ud='true'`, `embedded=t`. (Before the fix they were `manual`/`null`.)

- [ ] **Step 3: Validation #3 — recall round-trip**

Query `/v1/search` with `userDirected:true` and a differently-worded query matching one of the agent's notes. Expected: the agent's note is returned. Confirm `/dashboard/notes` lists it and the dashboard renders Notes above Decisions.

- [ ] **Step 4: Record the outcome**

Record a MemSmith observation (via `note_add` — dogfood the fix) summarizing PASS/FAIL of Validations #2/#3. Clean the throwaway acceptance rows afterward.

---

## Self-Review

**1. Spec coverage:**
- Enforcer `buildUserNoteRequest` (spec Component 1) → Task 1. ✅
- `note_add` tool, content-only (Component 2, constraints) → Task 2. ✅
- Backstop through enforcer (Component 3) → Task 3. ✅
- Directive points at `note_add` (Component 4) → Task 4. ✅
- Dashboard Notes-above-Decisions (Component 5) → Task 5. ✅
- Live acceptance re-run Validations #2/#3 (spec Testing 5-6) → Task 6. ✅
- Deferred qwen tuning → not planned (correct; out of scope). ✅

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows real code. The Task 3 test content-value placeholder (`/* the composed content */`) is a fill-from-the-existing-stub instruction, acceptable since the value is defined by the existing test's stub — the implementer sees it in-file.

**3. Type consistency:** `buildUserNoteRequest(content, {projectId, idempotencyKey?, metadata?})` used identically in Tasks 1, 2, 3. `handleNoteAdd`/`NoteAddArgs` consistent in Task 2. `RECORD_INTENT_DIRECTIVE` string in Task 4 matches the test assertions. `ServerAddObservationRequest` fields match the real definition. `deps.write` signature in Task 3 unchanged (keeps `teamId`). ✅
