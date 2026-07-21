# Content Moderation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee `<private>` content is stripped before storage (closing the raw-`agent_events` ingest leak) and add a session-scoped incognito mode that suppresses all capture while leaving memory injection intact.

**Architecture:** Three defense-in-depth strip layers — the client capture hook (before transmit), the server `IngestEventsService` (backstop before `agent_events` write, the definitive leak closure), and the already-existing generation prompt-builder (unchanged). Incognito is a session-scoped flag the client hook honors by not emitting events; it is surfaced via a slash command with on-toggle confirmation and an every-N-turn heartbeat.

**Tech Stack:** TypeScript, `bun:test`, existing `stripTags` util (`src/utils/tag-stripping.ts`), existing `IngestEventsService` + `PostgresAgentEventsRepository`, existing settings registry (`settingKeys.ts` / `SettingsResolver`), existing CLI hook handler (`src/cli/handlers/observation.ts`).

## Global Constraints

- **Capture-time only.** Moderation prevents an event/observation from ever being **stored**; it never mutates already-stored rows. No "stored but hidden" concept.
- **Fail-safe = suppress.** If it is ambiguous whether content is private or whether incognito is on, do **not** capture. A missed capture is recoverable; a leaked secret is not.
- **Never break the read path.** Incognito suppresses writes only; injection/recall keeps working.
- **The server strip is the definitive backstop.** Correctness of leak-closure is proven at the server ingest chokepoint that every client shares.
- **No local-mode regression.** Tag-free, non-incognito capture behaves byte-identically to today (modulo the existing `stripTags(...).trim()`). Existing tests stay green.
- **Reuse the existing rail.** Use `stripTags` / `stripMemoryTags` and the existing `IngestEventsService` chokepoint; do not build a parallel strip.
- **Visible state.** Incognito toggle confirmation + every-N heartbeat exist to prevent silent memory loss (the dangerous direction is believing it is ON when OFF, or forgetting it is ON).
- **Heartbeat default N = 10**, overridable via setting `MEMSMITH_INCOGNITO_REMINDER_TURNS`.
- **Commit trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. **Never commit to main;** work on a branch. Nothing pushed.

---

## File Structure

- `src/server/services/IngestEventsService.ts` (modify) — add a payload strip before `eventsRepo.create` in `ingestOne` + `ingestBatch`.
- `src/server/services/event-payload-scrub.ts` (create) — pure helper that recursively strips `<private>` from an event payload (the shared strip logic for the server backstop; keeps `IngestEventsService` thin).
- `tests/server/services/event-payload-scrub.test.ts` (create) — unit tests for the scrub helper.
- `tests/server/services/ingest-events-strip.test.ts` (create) — proves the stored `agent_events` payload has no private content (the leak-closure regression).
- `src/cli/incognito.ts` (create) — session-scoped incognito flag read/write + turn counter (pure, file-backed per session).
- `tests/cli/incognito.test.ts` (create) — unit tests for the flag + counter.
- `src/cli/handlers/observation.ts` (modify) — client-side `<private>` strip of the event payload + incognito short-circuit (no emit when ON).
- `tests/cli/handlers/observation-moderation.test.ts` (create) — client strip + incognito suppression.
- `src/cli/handlers/incognito-command.ts` (create) — the `/incognito on|off|toggle` handler: flips the flag, returns confirmation copy.
- `tests/cli/handlers/incognito-command.test.ts` (create) — toggle + confirmation copy.
- `src/cli/handlers/session-init.ts` (modify) — emit the every-N-turn heartbeat while incognito is ON.
- `tests/cli/handlers/incognito-heartbeat.test.ts` (create) — heartbeat cadence.
- `src/server/settings/settingKeys.ts` (modify) — add `incognitoReminderTurns` setting.
- `tests/server/settings/incognito-setting.test.ts` (create) — setting registered with default 10.

---

### Task 1: Event payload scrub helper (server-side strip logic)

**Files:**
- Create: `src/server/services/event-payload-scrub.ts`
- Test: `tests/server/services/event-payload-scrub.test.ts`

**Interfaces:**
- Consumes: `stripMemoryTags(content: string): string` from `src/utils/tag-stripping.js` (strips `<private>` and the other tag names; returns the stripped, trimmed string).
- Produces: `scrubEventPayload(payload: unknown): unknown` — returns a deep copy of `payload` with every string value run through `stripMemoryTags`. Non-string leaves are returned unchanged. Never throws (on error, returns the original payload — but see note: the caller treats a throw as fail-safe-suppress, so this helper simply must not throw for normal inputs).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/services/event-payload-scrub.test.ts
import { describe, it, expect } from 'bun:test';
import { scrubEventPayload } from '../../../src/server/services/event-payload-scrub.js';

describe('scrubEventPayload', () => {
  it('strips <private> content from nested string values', () => {
    const input = {
      tool_name: 'Bash',
      tool_input: { command: 'echo <private>SECRET_TOKEN</private> done' },
      tool_response: 'ok <private>hunter2</private>',
      nested: { deep: ['keep <private>drop</private>', 'plain'] },
    };
    const out = scrubEventPayload(input) as typeof input;
    expect(JSON.stringify(out)).not.toContain('SECRET_TOKEN');
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('drop');
    expect(out.tool_input.command).toContain('echo');
    expect(out.tool_input.command).toContain('done');
    expect(out.nested.deep[1]).toBe('plain');
  });

  it('leaves a tag-free payload semantically unchanged', () => {
    const input = { a: 'hello', b: { c: 42, d: true, e: null } };
    const out = scrubEventPayload(input);
    expect(out).toEqual({ a: 'hello', b: { c: 42, d: true, e: null } });
  });

  it('does not mutate the original payload', () => {
    const input = { x: 'a <private>b</private> c' };
    scrubEventPayload(input);
    expect(input.x).toBe('a <private>b</private> c');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/services/event-payload-scrub.test.ts`
Expected: FAIL — `scrubEventPayload` is not defined / module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/services/event-payload-scrub.ts
// SPDX-License-Identifier: Apache-2.0
//
// Server-side backstop: strip <private> (and the other stripped tags) from
// every string value in an event payload BEFORE it is written to agent_events.
// This closes the ingest leak — private content must never be stored raw,
// even from a client that did not strip before transmit.

import { stripMemoryTags } from '../../utils/tag-stripping.js';

export function scrubEventPayload(payload: unknown): unknown {
  return scrubValue(payload);
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return stripMemoryTags(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValue(v);
    }
    return out;
  }
  return value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/services/event-payload-scrub.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/services/event-payload-scrub.ts tests/server/services/event-payload-scrub.test.ts
git commit -m "feat(moderation): event payload scrub helper (strip <private> from any value)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Server ingest backstop — strip before agent_events write (the leak closure)

**Files:**
- Modify: `src/server/services/IngestEventsService.ts` (`ingestOne` ~line 96–98, `ingestBatch` ~line 168–169)
- Test: `tests/server/services/ingest-events-strip.test.ts`

**Interfaces:**
- Consumes: `scrubEventPayload(payload: unknown): unknown` (Task 1); `CreatePostgresAgentEventInput` (has `payload?: JsonValue`) from `src/storage/postgres/agent-events.js`.
- Produces: no signature change. `IngestEventsService.ingestOne` / `ingestBatch` now scrub `input.payload` before `eventsRepo.create(input)`.

**Note on how the test injects a fake repo:** `IngestEventsService` constructs `new PostgresAgentEventsRepository(client)` inside the transaction using the `pool`'s client. The cleanest test seam is to call `scrubEventPayload` on the input inside the service and assert via a fake pool whose `withPostgresTransaction` provides a client that records what `eventsRepo.create` received. Rather than mock Postgres, this task asserts the scrub is applied to the input by extracting the scrub call to the top of `ingestOne`/`ingestBatch` (before the transaction) and testing that the input handed into the transaction is already scrubbed. Implement by scrubbing `input` into a local `scrubbedInput` at function entry and using it throughout.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/services/ingest-events-strip.test.ts
import { describe, it, expect } from 'bun:test';
import { IngestEventsService } from '../../../src/server/services/IngestEventsService.js';

// A pool whose transaction hands a client to the callback; the fake
// PostgresAgentEventsRepository is not used — instead we capture the payload
// the service would persist by stubbing withPostgresTransaction indirectly.
// Simplest: spy on scrubEventPayload's effect by giving the service a fake
// pool and asserting eventsRepo.create sees a scrubbed payload.

function makeCapturingPool(captured: { payload?: unknown }) {
  return {
    // withPostgresTransaction(pool, cb) calls cb(client). We route create()
    // through a client object the repo will use. Because the repo is
    // constructed internally, we instead assert at the DB boundary via a
    // fake query layer: the repo's create runs an INSERT with the payload as
    // a parameter. We capture that parameter.
    async connect() {
      return {
        query: async (_sql: string, params?: unknown[]) => {
          // agent_events INSERT: payload is JSON.stringify(input.payload) at $10
          if (params && typeof params[9] === 'string') {
            captured.payload = JSON.parse(params[9] as string);
          }
          // Return a minimal row shape mapAgentEventRow expects.
          return {
            rows: [{
              id: 'e1', project_id: 'p1', team_id: 't1', server_session_id: null,
              source_adapter: 'hook', source_event_id: null, idempotency_key: 'k1',
              event_type: 'tool_use', platform_source: null,
              payload: params ? JSON.parse(params[9] as string) : {},
              metadata: {}, occurred_at: new Date(),
            }],
          };
        },
        release() {},
      };
    },
  };
}

describe('IngestEventsService server-side private strip', () => {
  it('scrubs <private> from the payload before persisting to agent_events', async () => {
    const captured: { payload?: unknown } = {};
    const service = new IngestEventsService({
      pool: makeCapturingPool(captured) as never,
      resolveEventQueue: () => null,
    });
    await service.ingestOne(
      {
        projectId: 'p1', teamId: 't1', sourceAdapter: 'hook',
        eventType: 'tool_use', occurredAt: Date.now(),
        payload: { tool_response: 'ok <private>LEAK_ME</private>' },
      } as never,
      { generate: false },
    );
    expect(JSON.stringify(captured.payload)).not.toContain('LEAK_ME');
    expect(JSON.stringify(captured.payload)).toContain('ok');
  });
});
```

> If `withPostgresTransaction` / `assertProjectOwnership` make this DB-shaped test brittle in practice, the implementer may instead export a tiny internal `scrubIngestInput(input)` from `IngestEventsService.ts` and unit-test that directly — but the preferred assertion is the one above (payload as persisted). Decide based on what the transaction helper allows; keep the leak-closure assertion ("persisted payload has no `<private>` content").

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/services/ingest-events-strip.test.ts`
Expected: FAIL — persisted payload still contains `LEAK_ME` (no scrub applied yet).

- [ ] **Step 3: Write minimal implementation**

In `src/server/services/IngestEventsService.ts`, add the import near the top:

```typescript
import { scrubEventPayload } from './event-payload-scrub.js';
```

In `ingestOne`, immediately after computing `generate`/`source` and before `withPostgresTransaction`, scrub the input:

```typescript
    const generate = opts.generate ?? true;
    const source = opts.source ?? 'http_post_v1_events';

    // Server-side backstop: strip <private> before anything is stored, so the
    // raw agent_events table never holds private content (closes the leak for
    // every client, including non-hook adapters).
    const scrubbedInput = { ...input, payload: scrubEventPayload(input.payload ?? {}) };

    const txResult = await withPostgresTransaction(this.options.pool, async (client) => {
      const eventsRepo = new PostgresAgentEventsRepository(client);
      const inserted = await eventsRepo.create(scrubbedInput);
```

In `ingestBatch`, scrub each input before `eventsRepo.create`:

```typescript
      for (const input of inputs) {
        const scrubbedInput = { ...input, payload: scrubEventPayload(input.payload ?? {}) };
        const event = await eventsRepo.create(scrubbedInput);
```

(Use `scrubbedInput` wherever `input` fed `eventsRepo.create`; leave `inserted`/`event` usage unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/services/ingest-events-strip.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing ingest/events suite to confirm no regression**

Run: `bun test tests/server/services/ 2>&1 | tail -20`
Expected: existing IngestEventsService tests still green (or "no tests found" for unrelated paths — no failures introduced).

- [ ] **Step 6: Commit**

```bash
git add src/server/services/IngestEventsService.ts tests/server/services/ingest-events-strip.test.ts
git commit -m "feat(moderation): strip <private> at server ingest backstop before agent_events write

Closes the team-mode leak: raw event payloads were stored unstripped; only the
downstream generation prompt-builder stripped <private>. Now every ingest path
(v1/events + compat adapter) scrubs before persistence.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Incognito session flag + turn counter (pure module)

**Files:**
- Create: `src/cli/incognito.ts`
- Test: `tests/cli/incognito.test.ts`

**Interfaces:**
- Produces:
  - `isIncognito(sessionId: string): boolean` — true if incognito is ON for the session.
  - `setIncognito(sessionId: string, on: boolean): void` — flip the flag.
  - `bumpTurn(sessionId: string): number` — increment and return this session's turn count (used by the heartbeat).
  - `resetSession(sessionId: string): void` — clear flag + counter (used by tests and session end).
- State is stored under `~/.memsmith/incognito/<sessionId>.json` (per-session file, so it survives across the multiple hook invocations that make up one session but is naturally scoped and disposable). Never throws — a read error returns `false`/`0` (fail toward "not incognito"? No — see note).

**Fail-safe note:** for the *strip/leak* path the fail-safe is "suppress." For the *incognito flag read*, a corrupt/missing file means "we cannot prove incognito is ON" → treat as **OFF** (capture proceeds). This is correct: incognito is an explicit opt-in; the every-N heartbeat + on-toggle confirmation are what protect against a silently-lost ON state, not the flag storage. Document this in a comment.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/incognito.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { isIncognito, setIncognito, bumpTurn, resetSession } from '../../src/cli/incognito.js';

const S = 'test-session-incognito';

describe('incognito session flag', () => {
  beforeEach(() => resetSession(S));

  it('defaults to OFF', () => {
    expect(isIncognito(S)).toBe(false);
  });

  it('turns ON and OFF', () => {
    setIncognito(S, true);
    expect(isIncognito(S)).toBe(true);
    setIncognito(S, false);
    expect(isIncognito(S)).toBe(false);
  });

  it('counts turns independently of the flag', () => {
    expect(bumpTurn(S)).toBe(1);
    expect(bumpTurn(S)).toBe(2);
    expect(bumpTurn(S)).toBe(3);
  });

  it('resetSession clears flag and counter', () => {
    setIncognito(S, true);
    bumpTurn(S);
    resetSession(S);
    expect(isIncognito(S)).toBe(false);
    expect(bumpTurn(S)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/incognito.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/cli/incognito.ts
// SPDX-License-Identifier: Apache-2.0
//
// Session-scoped incognito state. One file per session under
// ~/.memsmith/incognito/. Incognito is an explicit opt-in: if the flag file
// is missing or unreadable we treat the session as NOT incognito (capture
// proceeds). The on-toggle confirmation + every-N-turn heartbeat — not this
// storage — are what guard against a silently-lost ON state.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface IncognitoState { on: boolean; turns: number }

function dir(): string {
  return join(homedir(), '.memsmith', 'incognito');
}

function file(sessionId: string): string {
  return join(dir(), `${encodeURIComponent(sessionId)}.json`);
}

function read(sessionId: string): IncognitoState {
  try {
    return JSON.parse(readFileSync(file(sessionId), 'utf8')) as IncognitoState;
  } catch {
    return { on: false, turns: 0 };
  }
}

function write(sessionId: string, state: IncognitoState): void {
  try {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(file(sessionId), JSON.stringify(state), { mode: 0o600 });
  } catch {
    // fail-safe: a write failure for incognito state must never crash the hook
  }
}

export function isIncognito(sessionId: string): boolean {
  return read(sessionId).on === true;
}

export function setIncognito(sessionId: string, on: boolean): void {
  const state = read(sessionId);
  write(sessionId, { ...state, on });
}

export function bumpTurn(sessionId: string): number {
  const state = read(sessionId);
  const turns = (state.turns ?? 0) + 1;
  write(sessionId, { ...state, turns });
  return turns;
}

export function resetSession(sessionId: string): void {
  try {
    if (existsSync(file(sessionId))) rmSync(file(sessionId));
  } catch {
    // best-effort
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/incognito.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/incognito.ts tests/cli/incognito.test.ts
git commit -m "feat(moderation): session-scoped incognito flag + turn counter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Client-side strip + incognito suppression in the capture hook

**Files:**
- Modify: `src/cli/handlers/observation.ts` (the `observationHandler.execute` body, lines 39–105)
- Test: `tests/cli/handlers/observation-moderation.test.ts`

**Interfaces:**
- Consumes: `isIncognito(sessionId: string): boolean` (Task 3); `scrubEventPayload(payload: unknown): unknown` (Task 1 — reused client-side; import from the server module is fine since both run in the same bundle, but to avoid a client→server import edge, this task imports `stripMemoryTags` directly and scrubs the two known string fields `tool_input`/`tool_response`; see implementation).
- Produces: no signature change. `observationHandler.execute` now (a) returns early with no emit when incognito is ON, and (b) scrubs `tool_input`/`tool_response` before building the event payload.

**Note:** `toolInput` may be a string or object. Reuse the recursive scrub for safety. To keep the client free of a server-dir import, this task adds a tiny local reuse: import `scrubEventPayload` from `../../server/services/event-payload-scrub.js` IS acceptable (it only depends on `stripMemoryTags`, a util). Use it.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/handlers/observation-moderation.test.ts
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { resetSession, setIncognito } from '../../../src/cli/incognito.js';

// The handler resolves runtime + a client with recordEvent. We capture calls.
const recorded: unknown[] = [];

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  resolveRuntimeContext: () => ({
    runtime: 'server',
    projectId: 'p1',
    client: { recordEvent: async (e: unknown) => { recorded.push(e); } },
  }),
}));
// shouldTrackProject must return true
mock.module('../../../src/cli/project-tracking.js', () => ({
  shouldTrackProject: () => true,
}));

import { observationHandler } from '../../../src/cli/handlers/observation.js';

const S = 'obs-moderation-session';
function input(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: S, cwd: '/tmp/proj', toolName: 'Bash',
    toolInput: { command: 'echo <private>SECRET</private> hi' },
    toolResponse: 'done <private>LEAK</private>',
    platform: 'claude', agentId: undefined, agentType: undefined,
    ...overrides,
  } as never;
}

describe('observation handler moderation', () => {
  beforeEach(() => { recorded.length = 0; resetSession(S); });

  it('strips <private> from the emitted event payload', async () => {
    await observationHandler.execute(input());
    expect(recorded).toHaveLength(1);
    const json = JSON.stringify(recorded[0]);
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('LEAK');
    expect(json).toContain('echo');
  });

  it('emits nothing when incognito is ON', async () => {
    setIncognito(S, true);
    await observationHandler.execute(input());
    expect(recorded).toHaveLength(0);
  });
});
```

> The exact module paths for `resolveRuntimeContext` and `shouldTrackProject` must match the real imports in `observation.ts`. Before writing the mock, the implementer confirms the real import specifiers (they are `resolveRuntimeContext` from the runtime-selector and `shouldTrackProject`) and adjusts the `mock.module` paths to the specifiers `observation.ts` actually uses. If mocking proves impractical under `bun:test`, refactor the emit into an injectable dependency: add an optional `deps` param to a new exported `runObservation(input, deps)` that `observationHandler.execute` calls with real deps — and test `runObservation` with fakes. Prefer the refactor if the mock is fragile.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/handlers/observation-moderation.test.ts`
Expected: FAIL — payload still contains `SECRET`/`LEAK`; incognito case still emits.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/handlers/observation.ts`, add imports:

```typescript
import { isIncognito } from '../incognito.js';
import { scrubEventPayload } from '../../server/services/event-payload-scrub.js';
```

Add the incognito short-circuit right after the `shouldTrackProject` guard (after line 59), before `resolveRuntimeContext`:

```typescript
    if (isIncognito(sessionId)) {
      logger.debug('HOOK', 'Incognito session — suppressing capture', { toolName });
      return { continue: true, suppressOutput: true };
    }
```

Scrub the two content fields when building the payload (replace the `payload:` block, lines 73–81):

```typescript
        payload: {
          tool_name: toolName,
          tool_input: scrubEventPayload(toolInput),
          tool_response: scrubEventPayload(toolResponse),
          cwd,
          agentId: input.agentId,
          agentType: input.agentType,
          platformSource,
        },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/handlers/observation-moderation.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/handlers/observation.ts tests/cli/handlers/observation-moderation.test.ts
git commit -m "feat(moderation): client hook strips <private> + suppresses capture when incognito

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `/incognito` command handler (toggle + confirmation copy)

**Files:**
- Create: `src/cli/handlers/incognito-command.ts`
- Test: `tests/cli/handlers/incognito-command.test.ts`

**Interfaces:**
- Consumes: `isIncognito`, `setIncognito` (Task 3).
- Produces: `handleIncognitoCommand(sessionId: string, arg: string | undefined): { on: boolean; message: string }`.
  - `arg === 'on'` → set ON. `arg === 'off'` → set OFF. `arg` empty/`'toggle'` → flip current.
  - `message` is the confirmation copy: ON → `🔒 Incognito ON — nothing from this session will be recorded.`; OFF → `Incognito OFF — recording resumed.`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/handlers/incognito-command.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { handleIncognitoCommand } from '../../../src/cli/handlers/incognito-command.js';
import { isIncognito, resetSession } from '../../../src/cli/incognito.js';

const S = 'incognito-cmd-session';

describe('handleIncognitoCommand', () => {
  beforeEach(() => resetSession(S));

  it('turns ON with "on" and returns the ON confirmation', () => {
    const r = handleIncognitoCommand(S, 'on');
    expect(r.on).toBe(true);
    expect(isIncognito(S)).toBe(true);
    expect(r.message).toContain('Incognito ON');
    expect(r.message).toContain('nothing from this session will be recorded');
  });

  it('turns OFF with "off" and returns the OFF confirmation', () => {
    handleIncognitoCommand(S, 'on');
    const r = handleIncognitoCommand(S, 'off');
    expect(r.on).toBe(false);
    expect(isIncognito(S)).toBe(false);
    expect(r.message).toContain('Incognito OFF');
    expect(r.message).toContain('recording resumed');
  });

  it('bare arg toggles current state', () => {
    expect(handleIncognitoCommand(S, undefined).on).toBe(true);
    expect(handleIncognitoCommand(S, undefined).on).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/handlers/incognito-command.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/cli/handlers/incognito-command.ts
// SPDX-License-Identifier: Apache-2.0
import { isIncognito, setIncognito } from '../incognito.js';

const MSG_ON = '🔒 Incognito ON — nothing from this session will be recorded.';
const MSG_OFF = 'Incognito OFF — recording resumed.';

export function handleIncognitoCommand(
  sessionId: string,
  arg: string | undefined,
): { on: boolean; message: string } {
  const normalized = (arg ?? '').trim().toLowerCase();
  let on: boolean;
  if (normalized === 'on') on = true;
  else if (normalized === 'off') on = false;
  else on = !isIncognito(sessionId); // '' or 'toggle'
  setIncognito(sessionId, on);
  return { on, message: on ? MSG_ON : MSG_OFF };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/handlers/incognito-command.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/handlers/incognito-command.ts tests/cli/handlers/incognito-command.test.ts
git commit -m "feat(moderation): /incognito on|off|toggle command with confirmation copy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `incognitoReminderTurns` setting

**Files:**
- Modify: `src/server/settings/settingKeys.ts` (append to `SETTING_KEYS`, after the `identityProvider` entry at line 85–89)
- Test: `tests/server/settings/incognito-setting.test.ts`

**Interfaces:**
- Consumes: the existing `SETTING_KEYS` array + `getSettingKey(key)` accessor.
- Produces: a registered setting `{ key: 'incognitoReminderTurns', type: 'number', env: 'MEMSMITH_INCOGNITO_REMINDER_TURNS', default: 10 }` retrievable via `getSettingKey('incognitoReminderTurns')`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/settings/incognito-setting.test.ts
import { describe, it, expect } from 'bun:test';
import { getSettingKey } from '../../../src/server/settings/settingKeys.js';

describe('incognitoReminderTurns setting', () => {
  it('is registered with env MEMSMITH_INCOGNITO_REMINDER_TURNS and default 10', () => {
    const k = getSettingKey('incognitoReminderTurns');
    expect(k).toBeDefined();
    expect(k?.env).toBe('MEMSMITH_INCOGNITO_REMINDER_TURNS');
    expect(k?.type).toBe('number');
    expect(k?.default).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/settings/incognito-setting.test.ts`
Expected: FAIL — `getSettingKey('incognitoReminderTurns')` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `src/server/settings/settingKeys.ts`, add this entry to the `SETTING_KEYS` array immediately after the `identityProvider` entry (before the closing `];` at line 90):

```typescript
  { key: 'incognitoReminderTurns', type: 'number', env: 'MEMSMITH_INCOGNITO_REMINDER_TURNS', default: 10,
    boot: false,
    label: 'Incognito reminder cadence',
    description: 'How many turns between "still incognito" reminders while an incognito session is active.',
    help: 'While incognito is ON (no capture), MemSmith re-surfaces a short "still incognito — not recording" reminder every N turns so you do not forget it is on and silently lose memory. Default 10. Only affects the reminder cadence; it does not change what is recorded.' },
```

(Match the exact field shape of the neighboring entries — confirm whether `type: 'number'` entries elsewhere use the same keys; if the registry's number entries omit `options`, do not add it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/settings/incognito-setting.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the settings registry still typechecks + no duplicate key**

Run: `bunx tsc --noEmit 2>&1 | grep -i settingKeys || echo "settingKeys clean"`
Expected: `settingKeys clean`.

- [ ] **Step 6: Commit**

```bash
git add src/server/settings/settingKeys.ts tests/server/settings/incognito-setting.test.ts
git commit -m "feat(moderation): MEMSMITH_INCOGNITO_REMINDER_TURNS setting (default 10)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Incognito heartbeat (every-N-turn reminder while ON)

**Files:**
- Modify: `src/cli/handlers/session-init.ts` (the handler that runs per turn / on UserPromptSubmit)
- Test: `tests/cli/handlers/incognito-heartbeat.test.ts`

**Interfaces:**
- Consumes: `isIncognito`, `bumpTurn` (Task 3); the reminder cadence (default 10). Because `session-init.ts` runs client-side and the setting lives in the server registry, this task reads the cadence from `process.env.MEMSMITH_INCOGNITO_REMINDER_TURNS` (falling back to 10) — the client hook does not have the server `SettingsResolver` in-process. This matches how other client-side hooks read env-configured values.
- Produces: a pure helper `incognitoHeartbeat(sessionId: string, env?: NodeJS.ProcessEnv): string | null` — returns the reminder string on the Nth turn while incognito is ON, else `null`. `session-init.ts` calls it and, when non-null, includes the string in its `additionalContext` output.

**Cadence semantics:** `bumpTurn` returns the running turn count. Emit the reminder when `isIncognito` AND `turn % N === 0` (so every Nth turn: 10, 20, 30…). N parsed from env, default 10, invalid/≤0 → 10.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/handlers/incognito-heartbeat.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { incognitoHeartbeat } from '../../../src/cli/handlers/session-init.js';
import { setIncognito, resetSession } from '../../../src/cli/incognito.js';

const S = 'incognito-heartbeat-session';

describe('incognitoHeartbeat', () => {
  beforeEach(() => resetSession(S));

  it('returns null when incognito is OFF regardless of turns', () => {
    for (let i = 0; i < 25; i++) {
      expect(incognitoHeartbeat(S, { MEMSMITH_INCOGNITO_REMINDER_TURNS: '10' } as never)).toBeNull();
    }
  });

  it('fires every 10th turn while incognito is ON (default)', () => {
    setIncognito(S, true);
    const env = {} as never; // no override → default 10
    const fired: number[] = [];
    for (let t = 1; t <= 20; t++) {
      const r = incognitoHeartbeat(S, env);
      if (r) { fired.push(t); expect(r).toContain('still incognito'); }
    }
    expect(fired).toEqual([10, 20]);
  });

  it('honors a custom cadence from env', () => {
    setIncognito(S, true);
    const env = { MEMSMITH_INCOGNITO_REMINDER_TURNS: '5' } as never;
    const fired: number[] = [];
    for (let t = 1; t <= 12; t++) {
      if (incognitoHeartbeat(S, env)) fired.push(t);
    }
    expect(fired).toEqual([5, 10]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/handlers/incognito-heartbeat.test.ts`
Expected: FAIL — `incognitoHeartbeat` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/cli/handlers/session-init.ts`, add imports (near existing imports):

```typescript
import { isIncognito, bumpTurn } from '../incognito.js';
```

Add the exported helper (top-level in the module):

```typescript
export function incognitoHeartbeat(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isIncognito(sessionId)) return null;
  const raw = Number.parseInt(env.MEMSMITH_INCOGNITO_REMINDER_TURNS ?? '', 10);
  const n = Number.isFinite(raw) && raw > 0 ? raw : 10;
  const turn = bumpTurn(sessionId);
  return turn % n === 0 ? '🔒 still incognito — not recording' : null;
}
```

Wire it into the session-init handler body: after the handler computes its normal `additionalContext` (or near the end of a UserPromptSubmit turn), call `incognitoHeartbeat(sessionId)` and, if non-null, append it to the `additionalContext` string that the handler already returns. (Locate the existing `additionalContext` construction in `session-init.ts` and concatenate the heartbeat line with a leading newline when present. If the handler currently short-circuits for private-flagged inits before producing context, place the heartbeat before that short-circuit so an incognito reminder still surfaces.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/cli/handlers/incognito-heartbeat.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/handlers/session-init.ts tests/cli/handlers/incognito-heartbeat.test.ts
git commit -m "feat(moderation): every-N-turn incognito heartbeat (default 10)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Wire `/incognito` into the plugin command surface + full typecheck

**Files:**
- Modify: `plugin/hooks/hooks.json` and/or the command registry that dispatches slash commands to handlers (confirm the real dispatch path — the implementer greps for where existing `/` commands or CLI subcommands register, e.g. the npx-cli command table or the plugin command manifest).
- Test: `tests/cli/handlers/incognito-command.test.ts` (already covers handler logic; this task adds the wiring + a full build/typecheck).

**Interfaces:**
- Consumes: `handleIncognitoCommand` (Task 5).
- Produces: an invokable `/incognito` (or `memsmith incognito`) surface that calls `handleIncognitoCommand` with the current `sessionId` and prints `message`.

**Note:** MemSmith exposes user-facing commands via the plugin (see `plugin/`) and the npx-cli (`src/npx-cli/commands/`). The implementer determines which surface is correct for a per-session toggle a user types during a Claude Code session (most likely a slash command backed by a hook/command entry). Register `/incognito` there, dispatch to `handleIncognitoCommand`, and surface `message` to the user. Because the exact registry differs, this task's deliverable is: the command is reachable and prints the confirmation; add one integration-style test asserting the dispatch calls `handleIncognitoCommand` and echoes `message`.

- [ ] **Step 1: Locate the command registry**

Run: `grep -rn "commands\|registerCommand\|slash\|npx-cli/commands" src/npx-cli plugin 2>/dev/null | grep -iv node_modules | head -30`
Expected: identifies where user commands are registered (record the file path for Step 3).

- [ ] **Step 2: Write the failing wiring test**

Write a test asserting that invoking the incognito command surface with `'on'` for a session results in `isIncognito(session) === true` and the printed/returned message contains `Incognito ON`. (Exact form depends on the registry found in Step 1; assert against the registered entry point, not `handleIncognitoCommand` directly.)

- [ ] **Step 3: Wire the command**

Register `/incognito` in the surface located in Step 1, dispatching `arg` to `handleIncognitoCommand(sessionId, arg)` and surfacing `message`.

- [ ] **Step 4: Run the wiring test**

Run: `bun test tests/cli/handlers/incognito-command.test.ts` (and the new wiring test)
Expected: PASS.

- [ ] **Step 5: Full typecheck + moderation suite**

Run: `bunx tsc --noEmit 2>&1 | tail -5 && bun test tests/server/services/event-payload-scrub.test.ts tests/server/services/ingest-events-strip.test.ts tests/cli/incognito.test.ts tests/cli/handlers/observation-moderation.test.ts tests/cli/handlers/incognito-command.test.ts tests/server/settings/incognito-setting.test.ts tests/cli/handlers/incognito-heartbeat.test.ts 2>&1 | tail -15`
Expected: tsc clean; all moderation tests green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(moderation): wire /incognito command surface

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Ingest leak closure → Tasks 1+2 (scrub helper + IngestEventsService backstop). ✓
- `<private>` client strip (never leaves machine) → Task 4. ✓
- Generation-layer strip (already exists) → no task needed; unchanged. ✓
- Incognito suppression (no emit) → Tasks 3+4. ✓
- `/incognito on|off` toggle + confirmation → Tasks 5+8. ✓
- Every-N heartbeat, default 10, settable → Tasks 6+7. ✓
- `MEMSMITH_INCOGNITO_REMINDER_TURNS` setting → Task 6. ✓
- No regression (tag-free/non-incognito unchanged) → covered by Task 1 (tag-free unchanged) + Task 2 Step 5 (existing suite) + Task 8 full typecheck. ✓
- Live acceptance (dogfood) → deferred to the final whole-branch review / manual acceptance (noted below); the automated suite proves the invariants.

**2. Placeholder scan:** Two tasks (2, 4, 8) carry *implementer-judgment notes* about test seams / exact registry paths rather than hardcoded assumptions — these are deliberate (the DB-transaction mockability and the command-registry location genuinely depend on current code the implementer must confirm), each with a concrete fallback (extract-and-unit-test / injectable deps). Not placeholders; they name the exact decision and the default. No "TODO/handle edge cases" left.

**3. Type consistency:** `scrubEventPayload(payload: unknown): unknown` used identically in Tasks 1, 2, 4. `isIncognito/setIncognito/bumpTurn/resetSession` signatures consistent across Tasks 3, 4, 5, 7. `handleIncognitoCommand(sessionId, arg) → {on, message}` consistent Tasks 5, 8. `incognitoHeartbeat(sessionId, env?) → string|null` consistent Task 7. Setting key `incognitoReminderTurns` / env `MEMSMITH_INCOGNITO_REMINDER_TURNS` consistent Tasks 6, 7. ✓

**Live acceptance note (for the final whole-branch review):** after all tasks, manually dogfood on the local runtime — (a) type `<private>secret</private>` in a real session, confirm it never appears in `agent_events` (query PG :55433 via the `pg` module, not embedded psql); (b) `/incognito on`, do work, confirm zero new observations, then `/incognito off` and confirm capture resumes; (c) confirm the heartbeat surfaces around turn 10 while ON.
