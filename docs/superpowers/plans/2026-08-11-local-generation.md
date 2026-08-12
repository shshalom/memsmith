# Local Generation for Team Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In team mode, observation generation runs on the developer's machine; the server stores and embeds finished observations and never calls an LLM.

**Architecture:** A team-mode hook does two things with each event: posts it to `/v1/events?generate=false` (so the team keeps the shared raw record without triggering server-side generation) and enqueues it to a local, file-based generation queue. A detached local loop drains that queue, generates via Ollama, and posts the finished observation to `/v1/memories`. The server computes and enforces the team `qualityFloor` at ingest.

**Tech Stack:** TypeScript, Bun test runner, Express (the `/v1/memories` route), Claude Code hooks, Ollama.

**Spec:** `docs/superpowers/specs/2026-08-11-local-generation-design.md` (read §2 and §5 before Task 3).

## Global Constraints

- **The server must never call an LLM in team mode.** Verified live: task def `memsmith:6` sets `MEMSMITH_GENERATION_DISABLED=true`, `/v1/info` reports `generationWorkerManager: disabled`, `providerReachable: false`, `queued: 0`.
- **Teammates hold only a team API key.** No database credential, no Postgres port, no Redis port. This is what join-over-HTTPS exists to guarantee.
- **No VPN requirement** for running team projects.
- **Capture failures are durable and retried; retrieval failures fail open.** A generation failure must never lose the event.
- **Never break the user's tool call.** Hooks are short-lived; a 20-60s generation must not run inline (`generation-health.ts:22`).
- **Quality floor default is `20`** (`src/server/settings/settingKeys.ts:63`), per-team, resolved by `teamId`.
- **Mutation-check every new test:** revert the fix, confirm the test FAILS, restore. Four fixtures in this project's history could not distinguish pass from fail.
- **After every change that affects runtime behavior: `npm run build-and-sync`.** The running hook executes the INSTALLED bundle; source edits alone change nothing. This cost real time in the previous session.
- **`npm run build` does NOT typecheck.** Run `npx tsc --noEmit -p tsconfig.json` as a separate gate.
- **The dogfood project (`5fc024f0-0994-4f1d-baed-300d9b4d3416`) must not be touched.** The loopback cookie authenticates as it by default; check `/v1/identity` before any state-changing local call.

## Pre-Flight Findings (verified before planning)

1. `ServerRecordEventRequest.generate?: boolean` **already exists** (`server-client.ts:96`) and maps to `?generate=false` (`:228`). The route honours it (`ServerV1PostgresRoutes.ts:340`): event row written, `outbox` null, `enqueueState` `'skipped'`. **No new endpoint or schema change is needed for the redirect.**
2. `recordEvent` has **five** call sites: `observation.ts`, `summarize.ts`, `session-init.ts`, `file-edit.ts`, `mcp-server.ts`. The flag is therefore defaulted centrally (Task 2), not per site.
3. `ServerGenerationProvider.generate(context, signal?, opts?)` (`providers/shared/types.ts:30`) is the only provider call, and `genContext` is a plain object `{ job, events, project }` built at `ProviderObservationGenerator.ts:311-320`. **The provider needs no pool.**
4. The generator's only two pool uses are `loadCanonicalOutbox` (`:402`) and `isApiKeyRevoked` (`:464`) — both job-queue bookkeeping, neither applicable on a laptop.
5. `scoreObservation` (`quality.ts:7-13`) is pure over `{ obsType, facts, narrative, title, concepts }`.
6. `capture-spool` is path-parameterised (`spoolEvent(path, event)`), so a second queue file needs no new storage code.
7. `/v1/memories` zod schema is **not** `.strict()`, so adding fields is backward compatible.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/services/generation/local-queue.ts` | Team-mode generation queue: its own file, reusing capture-spool primitives | **create** |
| `src/services/generation/generate-one.ts` | Pool-free generation core: event → parsed observation | **create** |
| `src/services/generation/local-generation-loop.ts` | Drain the queue, generate, POST `/v1/memories` | **create** |
| `src/services/hooks/server-client.ts` | Default `generate:false` in team mode; add `createMemory` | modify |
| `src/server/routes/v1/ingest-quality.ts` | Pure scoring + floor helpers for client-submitted observations | **create** |
| `src/server/routes/v1/ServerV1PostgresRoutes.ts` | `/v1/memories`: accept `obsType`, score server-side, enforce floor | modify |
| `src/server/runtime/ServerService.ts` | Team mode starts the generation loop, not a full server | modify |

---

### Task 1: Team-mode generation queue

**Files:**
- Create: `src/services/generation/local-queue.ts`
- Test: `tests/generation/local-queue.test.ts`

**Interfaces:**
- Consumes: `spoolEvent`, `readSpooledEvents`, `clearSpool` from `src/cli/handlers/capture-spool.js`.
- Produces: `generationQueuePath(): string`, `enqueueForGeneration(event: unknown, path?: string): boolean`, `readGenerationQueue(path?: string): unknown[]`, `clearGenerationQueue(path?: string): void`.

A **separate file** from `capture-spool.jsonl`. Both are drained, but with opposite semantics — the capture spool forwards raw events to the server, this queue generates first. One file with two drains is how "events silently shipped unprocessed" gets built.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { enqueueForGeneration, readGenerationQueue, clearGenerationQueue, generationQueuePath } from '../../src/services/generation/local-queue.js';
import { defaultSpoolPath } from '../../src/cli/handlers/capture-spool.js';

let dir: string; let p: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ms-gq-')); p = join(dir, 'q.jsonl'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('local generation queue', () => {
  it('round-trips an enqueued event', () => {
    enqueueForGeneration({ eventType: 'PostToolUse', projectId: 'p1' }, p);
    const got = readGenerationQueue(p) as Array<Record<string, unknown>>;
    expect(got).toHaveLength(1);
    expect(got[0]!.projectId).toBe('p1');
  });

  it('appends rather than overwriting', () => {
    enqueueForGeneration({ n: 1 }, p);
    enqueueForGeneration({ n: 2 }, p);
    expect(readGenerationQueue(p)).toHaveLength(2);
  });

  it('clears', () => {
    enqueueForGeneration({ n: 1 }, p);
    clearGenerationQueue(p);
    expect(readGenerationQueue(p)).toHaveLength(0);
  });

  it('returns empty for a missing file, never throws', () => {
    expect(readGenerationQueue(join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('never throws when the path is unwritable', () => {
    expect(() => enqueueForGeneration({ n: 1 }, '/proc/nope/q.jsonl')).not.toThrow();
  });

  // The whole point of a separate file.
  it('uses a DIFFERENT default path than the capture spool', () => {
    expect(generationQueuePath()).not.toBe(defaultSpoolPath());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/generation/local-queue.test.ts`
Expected: FAIL — `Cannot find module '.../local-queue.js'`

- [ ] **Step 3: Write the implementation**

```ts
// src/services/generation/local-queue.ts
// SPDX-License-Identifier: Apache-2.0
//
// The team-mode generation queue: events awaiting LOCAL generation.
//
// Reuses capture-spool's primitives (bounded at MAX_SPOOL_ENTRIES, trimmed,
// corrupt-file tolerant, never throws) but against its OWN file. The two
// queues are drained with OPPOSITE semantics — the capture spool forwards raw
// events to the server, this one generates first and posts the finished
// observation. Sharing one file would eventually ship raw events unprocessed.

import { join, dirname } from 'path';
import { spoolEvent, readSpooledEvents, clearSpool, defaultSpoolPath } from '../../cli/handlers/capture-spool.js';

export function generationQueuePath(): string {
  return join(dirname(defaultSpoolPath()), 'generation-queue.jsonl');
}

export function enqueueForGeneration(event: unknown, path: string = generationQueuePath()): boolean {
  return spoolEvent(path, event);
}

export function readGenerationQueue(path: string = generationQueuePath()): unknown[] {
  return readSpooledEvents(path);
}

export function clearGenerationQueue(path: string = generationQueuePath()): void {
  clearSpool(path);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/generation/local-queue.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Mutation-check**

Change `generationQueuePath` to return `defaultSpoolPath()`. Run the tests — the last test MUST fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/services/generation/local-queue.ts tests/generation/local-queue.test.ts
git commit -m "feat(generation): add team-mode local generation queue"
```

---

### Task 2: Default `generate:false` in team mode, centrally

**Files:**
- Modify: `src/services/hooks/server-client.ts:226-230`
- Test: `tests/hooks/record-event-generate-flag.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ServerClientConfig` gains `delegateGeneration?: boolean`. When true, `recordEvent` sends `?generate=false` unless the caller explicitly passed `generate: true`.

Set centrally because `recordEvent` has five call sites (Pre-Flight #2). A sixth added later must inherit the correct behavior rather than silently reintroducing server-side generation.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'bun:test';
import { ServerClient } from '../../src/services/hooks/server-client.js';

function captureFetch() {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ event: { id: 'e1' } }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fn: fn as unknown as typeof fetch };
}

const base = { projectId: 'p1', sourceType: 'hook' as const, eventType: 'PostToolUse', occurredAtEpoch: 0 };

describe('recordEvent generate flag', () => {
  it('sends generate=false when the client delegates generation', async () => {
    const { calls, fn } = captureFetch();
    const c = new ServerClient({ serverBaseUrl: 'http://x', apiKey: 'k', delegateGeneration: true, fetchImpl: fn });
    await c.recordEvent(base);
    expect(calls[0]).toContain('generate=false');
  });

  it('does NOT send generate=false by default (local mode unchanged)', async () => {
    const { calls, fn } = captureFetch();
    const c = new ServerClient({ serverBaseUrl: 'http://x', apiKey: 'k', fetchImpl: fn });
    await c.recordEvent(base);
    expect(calls[0]).not.toContain('generate=false');
  });

  it('an explicit generate:false still wins when not delegating', async () => {
    const { calls, fn } = captureFetch();
    const c = new ServerClient({ serverBaseUrl: 'http://x', apiKey: 'k', fetchImpl: fn });
    await c.recordEvent({ ...base, generate: false });
    expect(calls[0]).toContain('generate=false');
  });

  it('an explicit generate:true overrides delegation', async () => {
    const { calls, fn } = captureFetch();
    const c = new ServerClient({ serverBaseUrl: 'http://x', apiKey: 'k', delegateGeneration: true, fetchImpl: fn });
    await c.recordEvent({ ...base, generate: true });
    expect(calls[0]).not.toContain('generate=false');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hooks/record-event-generate-flag.test.ts`
Expected: FAIL — `delegateGeneration` is not a config option; first test sees no `generate=false`.

If `ServerClient` has no `fetchImpl` seam, add one in this task (a constructor-injected `fetchImpl?: typeof fetch` defaulting to global `fetch`) — do not reach for network mocking.

- [ ] **Step 3: Implement**

Add to `ServerClientConfig`:

```ts
  /** Team mode: generation happens on this machine, so events are recorded
   *  WITHOUT enqueuing server-side generation. Set centrally rather than at
   *  each of recordEvent's five call sites, so a new call site inherits it. */
  delegateGeneration?: boolean;
```

In `recordEvent`, replace the path computation:

```ts
    const generate = input.generate ?? !this.config.delegateGeneration;
    const path = generate === false ? '/v1/events?generate=false' : '/v1/events';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/hooks/record-event-generate-flag.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Set it for team mode**

In `buildServerContext` (`src/services/hooks/runtime-selector.ts:138-147`), pass
`delegateGeneration: selectRuntime(cwd) === 'server'` into the `ServerClientConfig`.
Add a test asserting a team-mode context yields a client that sends `generate=false`,
and a local-mode context one that does not.

- [ ] **Step 6: Commit**

```bash
git add src/services/hooks/server-client.ts src/services/hooks/runtime-selector.ts tests/hooks/record-event-generate-flag.test.ts
git commit -m "feat(hooks): delegate generation to the client in team mode"
```

---

### Task 3: Server-side quality scoring at ingest

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts:967-1004`
- Test: `tests/server/routes/v1/memories-quality-gate.test.ts`

**Interfaces:**
- Consumes: `scoreObservation` from `src/server/generation/quality.js`; `this.options.settingsResolver`.
- Produces: `/v1/memories` accepts `obsType?: string`; computes and persists `quality`; rejects sub-floor with `422`.

**Read spec §5 before starting.** Two constraints are easy to get wrong:

- `scoreObservation` needs the STRUCTURED fields (`facts`, `narrative`, `concepts`), which travel in `metadata` — NOT the flattened `content`. Scoring `content` alone scores everything near zero and rejects everything.
- `settingsResolver` is OPTIONAL (`:122`, guarded at `:1402`). When absent, fall back to the env default (`MEMSMITH_QUALITY_FLOOR`, default 20) exactly as `processGeneratedResponse.ts:128-129` does. Do NOT skip the gate.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'bun:test';
import { scoreSubmittedObservation, meetsFloor } from '../../../../src/server/routes/v1/ingest-quality.js';

const rich = {
  obsType: 'decision',
  facts: ['a', 'b', 'c'],
  narrative: 'A sufficiently long narrative explaining what was decided and why it matters.',
  title: 'A decision',
  concepts: ['x'],
};

describe('ingest quality scoring', () => {
  it('scores from the STRUCTURED fields, not the content string', () => {
    expect(scoreSubmittedObservation(rich)).toBeGreaterThan(20);
  });

  it('scores a bare content-only submission BELOW the default floor', () => {
    expect(scoreSubmittedObservation({})).toBeLessThan(20);
  });

  it('ignores a client-supplied quality value', () => {
    const spoofed = { ...rich, quality: 100 } as Record<string, unknown>;
    expect(scoreSubmittedObservation(spoofed)).toBe(scoreSubmittedObservation(rich));
  });

  it('meetsFloor is inclusive at the boundary', () => {
    expect(meetsFloor(20, 20)).toBe(true);
    expect(meetsFloor(19, 20)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/routes/v1/memories-quality-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure helper**

```ts
// src/server/routes/v1/ingest-quality.ts
// SPDX-License-Identifier: Apache-2.0
//
// Quality scoring for client-submitted observations.
//
// Under local generation the client produces the observation, so the team's
// qualityFloor can no longer be enforced inside server-side generation
// (processGeneratedResponse.ts:128). It moves here, to the ingest boundary, so
// ONE team-wide bar applies no matter how many laptops submit.
//
// The score is always computed server-side. A client-supplied `quality` is
// ignored — trusting it would make the bar advisory.

import { scoreObservation } from '../../generation/quality.js';

/** Read the structured fields scoreObservation needs out of a submitted
 *  metadata bag. They live in metadata, NOT in the flattened content string —
 *  scoring content alone would score every submission near zero. */
export function scoreSubmittedObservation(metadata: Record<string, unknown>): number {
  return scoreObservation({
    obsType: typeof metadata.obsType === 'string' ? metadata.obsType : undefined,
    facts: Array.isArray(metadata.facts) ? (metadata.facts as string[]) : undefined,
    narrative: typeof metadata.narrative === 'string' ? metadata.narrative : undefined,
    title: typeof metadata.title === 'string' ? metadata.title : undefined,
    concepts: Array.isArray(metadata.concepts) ? (metadata.concepts as string[]) : undefined,
  });
}

/** Inclusive at the boundary, matching applyQualityGate's `quality < floor` drop. */
export function meetsFloor(score: number, floor: number): boolean {
  return score >= floor;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/routes/v1/memories-quality-gate.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Wire into the route**

In the `/v1/memories` handler (`:976`), after `ensureProjectAllowed` and before `embedForPersist`:

```ts
        // Local generation moved the quality bar here — see spec §5. Score is
        // ALWAYS computed server-side; a client-supplied value is ignored.
        const md = body.metadata ?? {};
        const quality = scoreSubmittedObservation(md);
        const floor = this.options.settingsResolver
          ? await this.options.settingsResolver.qualityFloor(teamId)
          : Number.parseInt(process.env.MEMSMITH_QUALITY_FLOOR ?? '20', 10) || 20;
        if (!meetsFloor(quality, floor)) {
          res.status(422).json({ error: 'BelowQualityFloor', quality, floor });
          return;
        }
```

Add `obsType` to the zod schema and pass `obsType` + `quality` into `createInput`
(the repository already accepts both — `observations.ts:165-168`, persisted `:192-195`).

**BACK-COMPAT — VERIFIED HAZARD, NOT HYPOTHETICAL.** `note_add` posts to this same route:
`buildUserNoteRequest` (`src/services/retrieval/user-note-write.ts:12-18`) produces
`{ projectId, content, kind: 'user_note', metadata: { userDirected: true } }` — no `facts`,
no `narrative`, no `concepts` — and `ServerClient.addObservation` sends it to `/v1/memories`
(`server-client.ts:252`). It would score ~0, fall below the floor of 20, and be **rejected
with 422**, silently breaking a shipped feature the user relies on every session.

The exemption is therefore mandatory, and it must be pinned by tests written BEFORE the gate
is wired:

```ts
it('accepts a user note despite it scoring below the floor', async () => {
  // kind='user_note' + metadata.userDirected===true bypasses the gate.
});
it('still rejects a low-quality NON-note submission', async () => {
  // the exemption must not become a universal bypass
});
```

Exempt on `kind === 'user_note' && metadata.userDirected === true`. Both conditions — a
`kind` check alone would let any client opt out of the bar by relabelling.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/v1/ingest-quality.ts src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/routes/v1/memories-quality-gate.test.ts
git commit -m "feat(server): enforce the team quality floor at ingest"
```

---

### Task 4: Pool-free generation core

**Files:**
- Create: `src/services/generation/generate-one.ts`
- Test: `tests/generation/generate-one.test.ts`

**Interfaces:**
- Consumes: `ServerGenerationProvider` (`providers/shared/types.ts:30`), `parseAgentXml` (`src/sdk/parser.js`).
- Produces: `generateOne(input: { provider: ServerGenerationProvider; event: unknown; projectId: string; teamId: string; serverSessionId?: string | null; projectName?: string | null }): Promise<ParsedObservation[]>`

Extracts the generate-one-event path from `ProviderObservationGenerator`, whose only pool uses are `loadCanonicalOutbox` (`:402`) and `isApiKeyRevoked` (`:464`) — both job-queue bookkeeping that does not exist on a laptop. `genContext` is a plain object (`:311-320`), so the provider needs no pool.

**Do not make `pool` optional on the existing class.** Threading null checks through it would leave "no row" and "row missing" indistinguishable in the tampering detector.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'bun:test';
import { generateOne } from '../../src/services/generation/generate-one.js';

function fakeProvider(xml: string, opts: { calls?: string[] } = {}) {
  return {
    providerLabel: 'ollama' as const,
    generate: async (ctx: unknown) => { opts.calls?.push('generate'); return { text: xml, model: 'm', raw: null } as never; },
  };
}
const XML = '<observations><observation type="decision"><title>T</title><facts><fact>f1</fact></facts><narrative>n</narrative></observation></observations>';

describe('generateOne', () => {
  it('produces parsed observations with NO pool', async () => {
    const out = await generateOne({
      provider: fakeProvider(XML), event: { eventType: 'PostToolUse' },
      projectId: 'p1', teamId: 't1',
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.title).toBe('T');
  });

  it('returns an empty array when the provider output cannot be parsed', async () => {
    const out = await generateOne({
      provider: fakeProvider('not xml'), event: {}, projectId: 'p1', teamId: 't1',
    });
    expect(out).toEqual([]);
  });

  it('propagates a provider throw rather than swallowing it (caller keeps the event queued)', async () => {
    const boom = { providerLabel: 'ollama' as const, generate: async () => { throw new Error('ollama down'); } };
    await expect(generateOne({ provider: boom, event: {}, projectId: 'p1', teamId: 't1' })).rejects.toThrow('ollama down');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/generation/generate-one.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Build the same `genContext` shape the existing generator builds (`:311-320`), call
`provider.generate(genContext)`, and run the result through `parseAgentXml`. Errors
propagate — the caller decides whether to requeue, and swallowing here would silently drop
events.

**Interface correction (found in plan review):** `parseAgentXml(raw, correlationId?)` returns
a `ParseResult` object with a `valid` flag, **not** an array. Follow the existing consumer at
`processGeneratedResponse.ts:106-109`:

```ts
const parsed = parseAgentXml(rawText, correlationId);
if (!parsed.valid) return [];           // unparseable → empty, per test 2
```

Then take the observations off `parsed`, matching how `processGeneratedResponse` reads them
(see its flatten at `:123-126`). Do not invent a different accessor — read the existing
consumer and mirror it.

The `job` field of `genContext` is typed as a generation-job row. Construct a minimal
synthetic value carrying only the fields the providers actually read; if the type does
not permit that, define a narrower context type in this module rather than widening the
shared one.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/generation/generate-one.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Mutation-check** — make `generateOne` return `[]` unconditionally; test 1 MUST fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/services/generation/generate-one.ts tests/generation/generate-one.test.ts
git commit -m "feat(generation): extract a pool-free generate-one-event core"
```

---

### Task 5: The local generation loop

**Files:**
- Create: `src/services/generation/local-generation-loop.ts`
- Modify: `src/services/hooks/server-client.ts` (add `createMemory`)
- Test: `tests/generation/local-generation-loop.test.ts`

**Interfaces:**
- Consumes: Task 1's queue, Task 4's `generateOne`, `ensureOllamaRunning`.
- Produces: `drainGenerationQueue(deps): Promise<{ generated: number; failed: number; kept: number }>`

Inject every dependency (queue read/clear, provider, poster) so the loop is testable without Ollama or a server.

- [ ] **Step 1: Write the failing test**

```ts
describe('drainGenerationQueue', () => {
  it('generates each queued event and posts the finished observation', async () => {
    const posted: unknown[] = [];
    const r = await drainGenerationQueue({
      read: () => [{ projectId: 'p1', eventType: 'PostToolUse' }],
      clear: () => {},
      generate: async () => [{ type: 'decision', title: 'T', facts: ['f'], narrative: 'n' } as never],
      post: async (o: unknown) => { posted.push(o); },
    });
    expect(r.generated).toBe(1);
    expect(posted).toHaveLength(1);
  });

  it('KEEPS the event queued when generation throws (durability)', async () => {
    let cleared = false;
    const r = await drainGenerationQueue({
      read: () => [{ projectId: 'p1' }],
      clear: () => { cleared = true; },
      generate: async () => { throw new Error('ollama down'); },
      post: async () => {},
    });
    expect(r.failed).toBe(1);
    expect(cleared).toBe(false);
  });

  it('KEEPS the event queued when the POST fails', async () => {
    let cleared = false;
    const r = await drainGenerationQueue({
      read: () => [{ projectId: 'p1' }],
      clear: () => { cleared = true; },
      generate: async () => [{ type: 'x', title: 't' } as never],
      post: async () => { throw new Error('network'); },
    });
    expect(r.failed).toBe(1);
    expect(cleared).toBe(false);
  });

  it('CONSUMES an event the server rejects as below the quality floor', async () => {
    // 422 is a correct drop, not a retryable failure — requeuing would loop forever.
    const r = await drainGenerationQueue({
      read: () => [{ projectId: 'p1' }],
      clear: () => {},
      generate: async () => [{ type: 'x', title: 't' } as never],
      post: async () => { const e = new Error('below floor') as Error & { status?: number }; e.status = 422; throw e; },
    });
    expect(r.failed).toBe(0);
    expect(r.generated).toBe(1);
  });

  it('is a no-op on an empty queue', async () => {
    const r = await drainGenerationQueue({ read: () => [], clear: () => {}, generate: async () => [], post: async () => {} });
    expect(r).toEqual({ generated: 0, failed: 0, kept: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — module not found.

- [ ] **Step 3: Implement.** Partition the queue into consumed vs kept, rewrite the file with only the kept entries, and treat a `422` as consumed (a correct drop) rather than failed. Add `createMemory(input)` to `ServerClient` posting to `/v1/memories`, surfacing the HTTP status on the thrown error so the loop can distinguish 422 from a network failure.

- [ ] **Step 4: Run tests** — PASS, 5 tests.

- [ ] **Step 5: Mutation-check** — make the failure path clear the queue; tests 2 and 3 MUST fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/services/generation/local-generation-loop.ts src/services/hooks/server-client.ts tests/generation/local-generation-loop.test.ts
git commit -m "feat(generation): drain the local queue, generate, post finished observations"
```

---

### Task 6: Enqueue locally in team mode, and start the loop

**Files:**
- Modify: `src/cli/handlers/observation.ts`
- Modify: `src/server/runtime/ServerService.ts` (`runRuntimeForeground`)
- Test: `tests/cli/handlers/observation-team-enqueue.test.ts`

**Interfaces:** consumes Tasks 1, 5.

Two wirings:

1. **Enqueue.** In team mode the observation handler enqueues to the generation queue in addition to posting with `generate=false` (Task 2 makes the flag automatic). Enqueue must not depend on the POST succeeding — a server outage must not cost the observation.
2. **Start the loop.** `runRuntimeForeground` (`ServerService.ts:687`) currently calls `startServer(port, host)` for non-local runtimes, which requires Postgres + Redis and fails on a laptop (spec §2). Team mode instead starts the generation loop.

- [ ] **Step 1: Write the failing tests**

```ts
it('team mode enqueues the event locally', async () => { /* assert queue length 1 */ });
it('team mode still enqueues when the POST fails', async () => { /* server throws; queue still 1 */ });
it('local mode does NOT enqueue (unchanged behavior)', async () => { /* queue length 0 */ });
```

Plus, for the runtime branch:

```ts
it('team mode starts the generation loop, not a full server', async () => {
  const calls: string[] = [];
  await runRuntimeForeground(1, 'h', {
    selectRuntime: () => 'server',
    startServer: async () => { calls.push('server'); },
    startGenerationLoop: async () => { calls.push('loop'); },
  } as never);
  expect(calls).toEqual(['loop']);
});
it('local mode is unchanged', async () => { /* expect ['local'] */ });
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.** Add `startGenerationLoop` to `RuntimeForegroundDeps` alongside the existing `selectRuntime`/`startLocal`/`startServer` seams, and branch on `pick(cwd) === 'server'`.

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(generation): enqueue locally and run the generation loop in team mode"
```

---

### Task 7: Full-suite gate, build, and live validation

- [ ] **Step 1: Full suite.** `bun test`. Compare against a clean-tree baseline (`git stash -u`) — the known-flaky set is ~14-16 subprocess/concurrency failures. Any NEW failure blocks.

- [ ] **Step 2: Typecheck.** `npx tsc --noEmit -p tsconfig.json` → exit 0. (`npm run build` does not typecheck.)

- [ ] **Step 3: Build and sync.** `npm run build-and-sync`; confirm `deploy-drift: clean`.

- [ ] **Step 4: Verify the dogfood project is untouched.** `curl /v1/identity` on the loopback server and confirm the local project's runtime is still `local` and its marker unchanged.

- [ ] **Step 5: Live validation in a SCRATCH team project** (`/tmp/ms-gen-test`, never the dogfood project):
  1. Convert/join it to team mode against the AWS endpoint.
  2. Trigger a tool event; assert the raw event reaches the server with **no** outbox row (`/v1/info` queued stays 0).
  3. Assert the generation queue file gains an entry.
  4. Run the drain; assert an observation appears in AWS with non-null `quality`, correct `obsType`, and a non-null embedding.
  5. Stop Ollama, trigger an event, drain: the entry stays queued and nothing is lost. Restart Ollama, drain again: it generates.
  6. Confirm no database credential and no VPN were used.

- [ ] **Step 6: Report.** State what passed, what did not, and anything left unverified. Do not claim completion on unrun steps.

---

## Notes for the executor

- **Rebuild before believing a live result.** The running hook executes the INSTALLED bundle; a source edit changes nothing until `npm run build-and-sync`. This produced two false "the fix failed" conclusions last session.
- **Never touch the dogfood project.** The loopback cookie authenticates as it by default.
- **A 422 is a correct drop, not a failure.** Requeuing it loops forever.
- **Do not weaken a test to make it pass.** If a test seems impossible to satisfy, escalate.
