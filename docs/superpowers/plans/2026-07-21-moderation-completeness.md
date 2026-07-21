# Moderation-Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip `<private>` from the two remaining raw-prompt sinks (`/v1/sessions/start` metadata + `/v1/record-intent`) at both the client sender and the server route, so the moderation invariant ("private content is never persisted / never reaches the LLM") holds literally across all paths.

**Architecture:** Defense-in-depth mirroring Content Moderation v1 — for each of the two paths, strip at the client sender (never-leaves-machine) AND as a server backstop (covers any client). Reuse the existing rail: `stripMemoryTags` for string prompts, `scrubEventPayload` for the sessions metadata object. Four independent tasks (server + client per path).

**Tech Stack:** TypeScript, `bun:test`, existing `stripMemoryTags`/`stripTags` (`src/utils/tag-stripping.ts`), existing `scrubEventPayload` (`src/server/services/event-payload-scrub.ts`), the `/v1` routes (`ServerV1PostgresRoutes.ts`), CLI hook handlers (`session-init.ts`, `record-intent.ts`), and `record-intent.ts` server helper (`src/server/routes/v1/record-intent.ts`).

## Global Constraints

- **Capture-time only.** Strip prevents a prompt / its private fragments from being persisted or sent to the LLM; never mutates already-stored rows.
- **Defense-in-depth.** Strip at BOTH the client sender AND the server route per path. The server strip is the definitive backstop.
- **`<private>` means "never persist," even inside a deliberate save.** In `/v1/record-intent`, strip BEFORE classify so the LLM classifier, the idempotency hash, and the stored content all see the stripped prompt.
- **Never reaches the LLM.** The record-intent strip happens before `classifyAndComposeRecordIntent` (which calls `deps.complete`).
- **Fail-safe.** `stripMemoryTags`/`scrubEventPayload` are pure and never throw for their inputs; a tag-free prompt is byte-identical after strip (modulo `stripMemoryTags`' existing `.trim()`).
- **No regression.** Prompts without `<private>` behave exactly as today; existing tests green.
- **Reuse, don't rebuild.** Use `stripMemoryTags` (string) / `scrubEventPayload` (object); add no parallel stripper.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. **Never commit to main;** work on branch `moderation-completeness`. Nothing pushed.

---

## File Structure

- `src/server/routes/v1/ServerV1PostgresRoutes.ts` (modify) — two edits: `/v1/sessions/start` handler (scrub metadata) + `/v1/record-intent` handler (strip prompt before classify). Add one import.
- `src/cli/handlers/session-init.ts` (modify) — strip prompt before building `metadata` in `startServerSession`. Add one import.
- `src/cli/handlers/record-intent.ts` (modify) — strip prompt before `client.recordIntent`. Add one import.
- Tests: `tests/server/routes/v1/sessions-start-strip.test.ts`, `tests/server/routes/v1/record-intent-strip.test.ts`, and additions to CLI handler tests.

**Task order:** server backstops first (Tasks 1–2, the definitive protection + the trickier record-intent 3-sink case), then client senders (Tasks 3–4). Each task is independently testable.

---

### Task 1: `/v1/record-intent` server strip (the 3-sink backstop)

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (the `/v1/record-intent` handler, ~line 997 — the `classifyAndComposeRecordIntent(body.prompt, deps)` call)
- Test: `tests/server/routes/v1/record-intent-strip.test.ts`

**Interfaces:**
- Consumes: `stripMemoryTags(content: string): string` from `src/utils/tag-stripping.js`; `classifyAndComposeRecordIntent(prompt: string, deps): Promise<{recorded, content?, id?}>` from `./record-intent.js` (unchanged — it already derives the LLM input, the idempotency key, and the stored content from its `prompt` argument).
- Produces: no signature change. The route now passes a stripped prompt to `classifyAndComposeRecordIntent`, so all three sinks receive stripped text.

**Note on the test seam:** `classifyAndComposeRecordIntent` is a standalone exported function taking `(prompt, deps)` where `deps` has `complete`, `write`, `teamId`, `projectId`. The test calls it directly with fakes that CAPTURE what `complete` (the LLM) and `write` (the store) receive, plus asserts the idempotency key. Because the STRIP happens at the route before calling it, the cleanest unit test is: strip the prompt with `stripMemoryTags` yourself, then verify `classifyAndComposeRecordIntent(stripped, deps)` never leaks the private text to any sink. But that tests the helper, not the route's strip. To test the ROUTE's strip specifically, this task ALSO adds a tiny assertion that the route computes `stripMemoryTags(body.prompt)` before the call — implemented by extracting the one line so the behavior is: `const prompt = stripMemoryTags(body.prompt); ... classifyAndComposeRecordIntent(prompt, deps)`. The unit test targets `classifyAndComposeRecordIntent` with a pre-stripped vs raw prompt to prove the three-sink property, which is the security-meaningful assertion.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/routes/v1/record-intent-strip.test.ts
import { describe, it, expect } from 'bun:test';
import { classifyAndComposeRecordIntent } from '../../../../src/server/routes/v1/record-intent.js';
import { stripMemoryTags } from '../../../../src/utils/tag-stripping.js';

describe('record-intent private strip (3-sink property)', () => {
  it('a stripped prompt leaks no <private> content to the LLM, the hash, or the stored content', async () => {
    const raw = 'remember that my key is <private>sk-SECRET-123</private> ok';
    const stripped = stripMemoryTags(raw); // what the route will pass

    let sentToLLM = '';
    let storedContent = '';
    let storedKey = '';
    const deps = {
      complete: async (_system: string, user: string) => { sentToLLM = user; return `RECORD: ${user}`; },
      write: async (o: { content: string; idempotencyKey: string; projectId: string; teamId: string; kind: string; metadata: Record<string, unknown> }) => {
        storedContent = o.content; storedKey = o.idempotencyKey; return { id: 'note-1' };
      },
      teamId: 't1',
      projectId: 'p1',
    };

    const result = await classifyAndComposeRecordIntent(stripped, deps as never);
    expect(result.recorded).toBe(true);
    // Sink 1: LLM never saw the secret
    expect(sentToLLM).not.toContain('sk-SECRET-123');
    // Sink 3: stored content never holds the secret
    expect(storedContent).not.toContain('sk-SECRET-123');
    // Sink 2: the idempotency key is derived from the stripped prompt — proven by
    // the fact that a DIFFERENT secret with the same non-private text yields the SAME key.
    let key2 = '';
    const deps2 = { ...deps, write: async (o: { idempotencyKey: string }) => { key2 = o.idempotencyKey; return { id: 'note-2' }; } } as never;
    await classifyAndComposeRecordIntent(stripMemoryTags('remember that my key is <private>sk-DIFFERENT-999</private> ok'), deps2);
    expect(storedKey).toBe(key2); // same stripped prompt → same key regardless of the private fragment
    // and the non-private text survived
    expect(storedContent).toContain('remember that my key is');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/routes/v1/record-intent-strip.test.ts`
Expected: This test targets `classifyAndComposeRecordIntent` with a pre-stripped prompt — it should PASS on the CURRENT helper (the helper is agnostic; stripping is the caller's job). So this test proves the PROPERTY holds when the route strips. **To make the task test-driven for the ROUTE change**, first add an assertion that FAILS without the route edit: see Step 2b.

- [ ] **Step 2b: Add the route-level failing assertion**

The route currently calls `classifyAndComposeRecordIntent(body.prompt, deps)` with the RAW prompt. Add this focused test that exercises the route's strip by asserting the route helper is fed stripped input. Since the route handler isn't independently callable without the full app, assert via the extracted variable pattern: after the implementation (Step 3), the route reads `const prompt = stripMemoryTags(body.prompt)`. Verify by a grep-style source assertion is NOT valid TDD; instead, rely on the property test above (Step 1) as the security gate and confirm the route edit by the reviewer reading the diff. Mark this task's automated coverage as the Step-1 property test; the route wiring is a one-line change verified in review.

Run: `bun test tests/server/routes/v1/record-intent-strip.test.ts`
Expected: PASS (the property test).

- [ ] **Step 3: Make the route strip before classify**

In `src/server/routes/v1/ServerV1PostgresRoutes.ts`, add the import near the other route imports:

```typescript
import { stripMemoryTags } from '../../utils/tag-stripping.js';
```

In the `/v1/record-intent` handler, change the classify call (~line 997) from:

```typescript
          const result = await classifyAndComposeRecordIntent(body.prompt, deps);
```

to:

```typescript
          // Strip <private> before classify so the LLM classifier, the
          // idempotency hash, and the stored content all receive stripped text
          // (moderation invariant: private content never reaches the LLM or DB).
          const prompt = stripMemoryTags(body.prompt);
          const result = await classifyAndComposeRecordIntent(prompt, deps);
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/server/routes/v1/record-intent-strip.test.ts && bunx tsc --noEmit 2>&1 | tail -3`
Expected: property test PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/routes/v1/record-intent-strip.test.ts
git commit -m "feat(moderation): strip <private> at /v1/record-intent before classify (3-sink backstop)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `/v1/sessions/start` server strip (metadata backstop)

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (the `/v1/sessions/start` handler, ~line 807 — the `metadata:` field of `createInput`)
- Test: `tests/server/routes/v1/sessions-start-strip.test.ts`

**Interfaces:**
- Consumes: `scrubEventPayload(payload: unknown): unknown` from `src/server/services/event-payload-scrub.js` (recursively strips `<private>` from every string value in an object; never mutates input; never throws).
- Produces: no signature change. The `server_sessions` metadata written no longer contains `<private>` content.

**Note on the test seam:** `scrubEventPayload` is a standalone pure function. The cleanest unit test asserts the SCRUB behavior on a metadata object shaped like what `session-init` sends (`{ project, prompt }`), proving the route's chosen transform removes the private text. (The full DB-write path is covered by acceptance; the security-meaningful unit is that `scrubEventPayload(body.metadata)` strips it.)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/routes/v1/sessions-start-strip.test.ts
import { describe, it, expect } from 'bun:test';
import { scrubEventPayload } from '../../../../src/server/services/event-payload-scrub.js';

describe('sessions/start metadata private strip', () => {
  it('scrubs <private> from the session metadata (project + prompt shape)', () => {
    const metadata = { project: 'MemSmith', prompt: 'working on <private>secret-plan-X</private> today' };
    const scrubbed = scrubEventPayload(metadata) as typeof metadata;
    expect(JSON.stringify(scrubbed)).not.toContain('secret-plan-X');
    expect(scrubbed.project).toBe('MemSmith');       // non-private field preserved
    expect(scrubbed.prompt).toContain('working on');  // non-private text survives
    expect(scrubbed.prompt).toContain('today');
  });

  it('leaves tag-free metadata semantically unchanged', () => {
    const metadata = { project: 'MemSmith', prompt: 'plain prompt' };
    expect(scrubEventPayload(metadata)).toEqual({ project: 'MemSmith', prompt: 'plain prompt' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/routes/v1/sessions-start-strip.test.ts`
Expected: PASS on the current `scrubEventPayload` (it already strips) — this test pins the PROPERTY the route relies on. The route CHANGE (applying it) is verified by Step 3 + review; there is no way to make `scrubEventPayload` itself fail here since it already works. (If you want a strictly-failing-first gate, temporarily assert the RAW `metadata` still contains the secret to confirm the test discriminates, then remove that line.)

- [ ] **Step 3: Make the route scrub metadata before persist**

In `src/server/routes/v1/ServerV1PostgresRoutes.ts`, add the import (if not already present from Task 1's work — this task may run first; add it if missing):

```typescript
import { scrubEventPayload } from '../../services/event-payload-scrub.js';
```

In the `/v1/sessions/start` handler, change the `metadata` line in `createInput` (~line 807) from:

```typescript
            metadata: (body.metadata ?? {}) as Record<string, unknown>,
```

to:

```typescript
            // Strip <private> from session metadata (the client sends the raw
            // prompt here) before it lands in server_sessions.
            metadata: scrubEventPayload(body.metadata ?? {}) as Record<string, unknown>,
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/server/routes/v1/sessions-start-strip.test.ts && bunx tsc --noEmit 2>&1 | tail -3`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/routes/v1/sessions-start-strip.test.ts
git commit -m "feat(moderation): scrub <private> from /v1/sessions/start metadata before persist

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `session-init.ts` client strip

**Files:**
- Modify: `src/cli/handlers/session-init.ts` (`startServerSession`, ~line 167 — the `metadata: { project, prompt }`)
- Test: `tests/cli/handlers/session-init-strip.test.ts`

**Interfaces:**
- Consumes: `stripMemoryTags` from `../../utils/tag-stripping.js` (the file already imports `isInternalProtocolPayload` from that module — extend the import).
- Produces: `startServerSession` sends `metadata: { project, prompt: stripMemoryTags(prompt) }`.

**Note on the test seam:** `startServerSession` is a module-private async function that calls `runtime.client.startSession`. It is not exported. The cleanest testable unit is to EXPORT a tiny pure helper `buildSessionMetadata(project: string, prompt: string)` from `session-init.ts` that returns `{ project, prompt: stripMemoryTags(prompt) }`, use it in `startServerSession`, and unit-test the helper. This keeps the change testable without invoking the full hook.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/handlers/session-init-strip.test.ts
import { describe, it, expect } from 'bun:test';
import { buildSessionMetadata } from '../../../src/cli/handlers/session-init.js';

describe('session-init metadata strip', () => {
  it('strips <private> from the prompt in session metadata', () => {
    const m = buildSessionMetadata('MemSmith', 'draft <private>the secret</private> plan');
    expect(m.project).toBe('MemSmith');
    expect(m.prompt).not.toContain('the secret');
    expect(m.prompt).toContain('draft');
    expect(m.prompt).toContain('plan');
  });
  it('leaves a tag-free prompt unchanged (modulo trim)', () => {
    expect(buildSessionMetadata('P', 'hello world').prompt).toBe('hello world');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/handlers/session-init-strip.test.ts`
Expected: FAIL — `buildSessionMetadata` is not exported.

- [ ] **Step 3: Add the helper + use it**

In `src/cli/handlers/session-init.ts`, extend the existing tag-stripping import (line 11) from:

```typescript
import { isInternalProtocolPayload } from '../../utils/tag-stripping.js';
```

to:

```typescript
import { isInternalProtocolPayload, stripMemoryTags } from '../../utils/tag-stripping.js';
```

Add the exported helper (top-level in the module):

```typescript
export function buildSessionMetadata(project: string, prompt: string): { project: string; prompt: string } {
  return { project, prompt: stripMemoryTags(prompt) };
}
```

In `startServerSession`, change the `metadata` field (~line 167) from:

```typescript
    metadata: { project, prompt },
```

to:

```typescript
    metadata: buildSessionMetadata(project, prompt),
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/cli/handlers/session-init-strip.test.ts && bunx tsc --noEmit 2>&1 | tail -3`
Expected: PASS (2 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/handlers/session-init.ts tests/cli/handlers/session-init-strip.test.ts
git commit -m "feat(moderation): strip <private> from session-init metadata prompt before send

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `record-intent.ts` client strip

**Files:**
- Modify: `src/cli/handlers/record-intent.ts` (~line 36 — the `client.recordIntent` call)
- Test: `tests/cli/handlers/record-intent-client-strip.test.ts`

**Interfaces:**
- Consumes: `stripMemoryTags` from `../../utils/tag-stripping.js`.
- Produces: a tiny exported pure helper `stripRecordIntentPrompt(prompt: string): string` = `stripMemoryTags(prompt)`, used at the `recordIntent` call site so the POST body carries a stripped prompt. (Exporting the one-liner keeps the change unit-testable without invoking the full hook + runtime.)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/handlers/record-intent-client-strip.test.ts
import { describe, it, expect } from 'bun:test';
import { stripRecordIntentPrompt } from '../../../src/cli/handlers/record-intent.js';

describe('record-intent client strip', () => {
  it('strips <private> from the prompt before it is sent', () => {
    const out = stripRecordIntentPrompt('remember <private>my password</private> please');
    expect(out).not.toContain('my password');
    expect(out).toContain('remember');
    expect(out).toContain('please');
  });
  it('leaves a tag-free prompt unchanged', () => {
    expect(stripRecordIntentPrompt('just remember this')).toBe('just remember this');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/handlers/record-intent-client-strip.test.ts`
Expected: FAIL — `stripRecordIntentPrompt` not exported.

- [ ] **Step 3: Add the helper + use it**

In `src/cli/handlers/record-intent.ts`, add the import near the top (with the other `../../` imports):

```typescript
import { stripMemoryTags } from '../../utils/tag-stripping.js';
```

Add the exported helper (top-level in the module):

```typescript
export function stripRecordIntentPrompt(prompt: string): string {
  return stripMemoryTags(prompt);
}
```

Change the `recordIntent` call (~line 36) from:

```typescript
      await runtime.client.recordIntent({ projectId: runtime.projectId, prompt });
```

to:

```typescript
      await runtime.client.recordIntent({ projectId: runtime.projectId, prompt: stripRecordIntentPrompt(prompt) });
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test tests/cli/handlers/record-intent-client-strip.test.ts && bunx tsc --noEmit 2>&1 | tail -3`
Expected: PASS (2 tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/handlers/record-intent.ts tests/cli/handlers/record-intent-client-strip.test.ts
git commit -m "feat(moderation): strip <private> from record-intent prompt before POST

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** (against `2026-07-21-moderation-completeness-design.md`):
- `/v1/sessions/start` server backstop → Task 2. ✓
- `session-init.ts` client strip → Task 3. ✓
- `/v1/record-intent` server backstop (3-sink) → Task 1. ✓
- `record-intent.ts` client strip → Task 4. ✓
- Both-layers-per-path (defense-in-depth) → Tasks 1+4 (record-intent), 2+3 (sessions). ✓
- `<private>` stripped before LLM/hash/content in record-intent → Task 1 (strip before `classifyAndComposeRecordIntent`, whose single `prompt` arg feeds all three). ✓
- No regression / tag-free unchanged → every task's second test case + `bunx tsc`. ✓
- Reuse existing rail → `stripMemoryTags` (string sites) + `scrubEventPayload` (metadata object). ✓
- Live acceptance → deferred to final whole-branch review / manual (noted below).

**2. Placeholder scan:** Tasks 1 and 2 carry an honest TDD caveat — `stripMemoryTags`/`scrubEventPayload` already work, so their *property* tests pass on the current helpers; the route CHANGE (applying the strip) is a one-line edit verified by the reviewer reading the diff plus the property test proving the security invariant. This is called out explicitly, not hidden. Tasks 3 and 4 are strictly test-driven (new exported helper fails first). No "TODO"/vague steps.

**3. Type consistency:** `stripMemoryTags(content: string): string` used identically in Tasks 1, 3, 4. `scrubEventPayload(payload: unknown): unknown` in Task 2 matches its v1 definition. `buildSessionMetadata(project, prompt) → {project, prompt}` (Task 3) and `stripRecordIntentPrompt(prompt) → string` (Task 4) are self-consistent. The `/v1/record-intent` handler passing a stripped `prompt` into `classifyAndComposeRecordIntent(prompt, deps)` matches that function's existing `(prompt: string, deps)` signature. ✓

**Note on shared file (Tasks 1 & 2 both edit ServerV1PostgresRoutes.ts):** both add an import and change one line in different handlers. Run them sequentially (not parallel) to avoid a merge conflict in the import block; the second task adds its import only if the first didn't already. The subagent-driven controller runs tasks sequentially by default, so this is automatic.

**Live acceptance note (for the final whole-branch review):** dogfood on the local runtime — (a) start a session with a `<private>` fragment in the first prompt, confirm `server_sessions.metadata` (query via the `pg` module, `:55433`, role `memsmith`) holds no private text; (b) fire a "remember this: … `<private>secret</private>`" prompt with the record-intent backstop enabled, confirm the resulting note excludes the secret and nothing private reached the store.
