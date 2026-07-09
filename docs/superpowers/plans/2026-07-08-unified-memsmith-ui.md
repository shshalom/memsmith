# Unified MemSmith UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give server-mode a rich, usable UI — one React app (served at `/`) that unifies the observation viewer and the team dashboard behind a left-sidebar switcher, running locally with no Team-ID/key paste, with live `/v1/stream` updates.

**Architecture:** Extend the existing React viewer (`src/ui/viewer/`) with a data-adapter that maps server `/v1/*` observations to the viewer's shape (components reused unchanged), an `App` sidebar shell routing between Observations and Dashboard views, a new server SSE endpoint `/v1/stream` fed from the generation-complete path, and `ServerViewerRoutes` serving the built app.

**Tech Stack:** React + esbuild (existing viewer build), TypeScript, Express (server routes), bun test, Postgres (:55432 test DB).

## Global Constraints

- Server-mode `/v1/*` ONLY — the unified app must not call worker `/api/*`.
- No Team-ID or key entry in local operation — the server scopes from the key / local-dev bypass; the UI sends no `teamId` param.
- Adapter and SSE MUST NEVER crash the UI — malformed rows degrade to empty fields; SSE disconnect falls back to periodic `/v1/search` refetch.
- Visual style: warm dark + gold; reuse existing viewer theme tokens.
- Bundle-safe server paths: NO `import.meta.url` at module top level in bundled server code (use `getPackageRoot()` — the dashboard-routes lesson).
- Team features are SEAMS ONLY (attribution slot, blocked-on-whom panel placement, switcher placement) — build no identity/auth subsystem.
- After server src changes, `npm run build` and commit regenerated `plugin/scripts/*.cjs`. After viewer src changes, the viewer build (`scripts/build-viewer.js`, invoked by `npm run build`) regenerates `plugin/ui/viewer-bundle.js` + `viewer.html` — commit those too.
- Reused viewer components (`Feed`, `ObservationCard`, `SummaryCard`, `PromptCard`, `ErrorBoundary`, `ScrollToTop`, `usePagination`, `useTheme`) keep their existing behavior; existing viewer tests stay green.

---

## Task 1: `serverAdapter` — map /v1 observation → viewer Observation

**Files:**
- Create: `src/ui/viewer/utils/serverAdapter.ts`
- Test: `tests/viewer/server-adapter.test.ts`

**Interfaces:**
- Consumes: the viewer `Observation` interface from `src/ui/viewer/types.ts` (fields: `id, memory_session_id, project, platform_source, type, title, subtitle, narrative, text, facts, concepts, files_read, files_modified, prompt_number, created_at, created_at_epoch`).
- Produces:
  - `type ServerObservation = { id: string; projectId: string; teamId: string; serverSessionId: string | null; kind: string; content: string; metadata: Record<string, unknown>; obsType?: string | null; lifecycleState?: string | null; createdAtEpoch: number; updatedAtEpoch: number; supersededBy?: string | null }`
  - `adaptObservation(row: ServerObservation): Observation`
  - `adaptObservations(rows: ServerObservation[]): Observation[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/viewer/server-adapter.test.ts
import { describe, test, expect } from 'bun:test';
import { adaptObservation } from '../../src/ui/viewer/utils/serverAdapter.js';

const row = {
  id: 'obs-1', projectId: 'p1', teamId: 't1', serverSessionId: null, kind: 'decision',
  content: 'Postgres Chosen Over SQLite\n\nconcurrent writers + pgvector',
  metadata: { title: 'Postgres Chosen Over SQLite', subtitle: 'over SQLite',
    facts: ['concurrent writers', 'pgvector'], narrative: 'The decision...', why: 'need multi-writer' },
  obsType: 'decision', lifecycleState: 'resolved', createdAtEpoch: 1783519301000, updatedAtEpoch: 1783519301000,
};

describe('adaptObservation', () => {
  test('maps obsType->type, metadata fields, lifecycle', () => {
    const o = adaptObservation(row as any);
    expect(o.type).toBe('decision');
    expect(o.title).toBe('Postgres Chosen Over SQLite');
    expect(o.subtitle).toBe('over SQLite');
    expect(o.narrative).toBe('The decision...');
    // facts array serialized to the viewer's string field
    expect(typeof o.facts).toBe('string');
    expect(o.facts).toContain('concurrent writers');
    expect(o.project).toBe('p1');
    expect(o.created_at_epoch).toBe(1783519301000);
    expect((o as any).lifecycle ?? (o as any).lifecycleState).toBe('resolved');
  });
  test('missing metadata degrades to empty, never throws', () => {
    const bare = { id: 'x', projectId: 'p', teamId: 't', serverSessionId: null, kind: 'observation',
      content: 'body', metadata: {}, createdAtEpoch: 1, updatedAtEpoch: 1 };
    expect(() => adaptObservation(bare as any)).not.toThrow();
    const o = adaptObservation(bare as any);
    expect(o.title === null || o.title === '').toBeTruthy();
    expect(o.text).toBe('body'); // content preserved
  });
  test('malformed metadata (wrong types) never throws', () => {
    const bad = { id: 'x', projectId: 'p', teamId: 't', serverSessionId: null, kind: 'observation',
      content: 'c', metadata: { title: 42, facts: 'not-array', why: {} }, createdAtEpoch: 1, updatedAtEpoch: 1 };
    expect(() => adaptObservation(bad as any)).not.toThrow();
    expect(typeof adaptObservation(bad as any).facts === 'string' || adaptObservation(bad as any).facts === null).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `~/.bun/bin/bun test tests/viewer/server-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

```ts
// src/ui/viewer/utils/serverAdapter.ts
import type { Observation } from '../types.js';

export type ServerObservation = {
  id: string; projectId: string; teamId: string; serverSessionId: string | null;
  kind: string; content: string; metadata: Record<string, unknown>;
  obsType?: string | null; lifecycleState?: string | null;
  createdAtEpoch: number; updatedAtEpoch: number; supersededBy?: string | null;
};

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;
const strArrayToString = (v: unknown): string | null =>
  Array.isArray(v) ? v.filter(x => typeof x === 'string').join('\n') || null : null;

export function adaptObservation(row: ServerObservation): Observation {
  const m = row.metadata ?? {};
  return {
    id: row.id as unknown as number, // viewer treats id opaquely for keys; server ids are strings
    memory_session_id: row.serverSessionId ?? '',
    project: row.projectId,
    platform_source: (str((m as any).platform_source) ?? ''),
    type: row.obsType ?? row.kind ?? 'observation',
    title: str((m as any).title),
    subtitle: str((m as any).subtitle),
    narrative: str((m as any).narrative),
    text: row.content ?? null,
    facts: strArrayToString((m as any).facts),
    concepts: strArrayToString((m as any).concepts),
    files_read: strArrayToString((m as any).files_read),
    files_modified: strArrayToString((m as any).files_modified),
    prompt_number: null,
    created_at: new Date(row.createdAtEpoch).toISOString(),
    created_at_epoch: row.createdAtEpoch,
    // team-aware-ready seams + server extras (extra fields are harmless to the viewer):
    lifecycle: row.lifecycleState ?? null,
    supersededBy: row.supersededBy ?? null,
  } as unknown as Observation;
}

export function adaptObservations(rows: ServerObservation[]): Observation[] {
  return (rows ?? []).map(adaptObservation);
}
```
(If `Observation` in types.ts doesn't allow the extra `lifecycle`/`supersededBy` fields, widen the interface with optional `lifecycle?: string | null; supersededBy?: string | null;` — add them to types.ts in this task.)

- [ ] **Step 4: Run test, verify it passes**

Run: `~/.bun/bin/bun test tests/viewer/server-adapter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/viewer/utils/serverAdapter.ts src/ui/viewer/types.ts tests/viewer/server-adapter.test.ts
git commit -m "feat(ui): serverAdapter maps /v1 observation shape to viewer Observation"
```

---

## Task 2: `/v1` API constants + data-fetch layer (no teamId)

**Files:**
- Modify: `src/ui/viewer/constants/api.ts`
- Create: `src/ui/viewer/utils/serverData.ts`
- Test: `tests/viewer/server-data.test.ts`

**Interfaces:**
- Consumes: `adaptObservations` (Task 1).
- Produces:
  - `V1_ENDPOINTS = { SEARCH: '/v1/search', CONTEXT: '/v1/context', OBSERVATION: '/v1/observations', STREAM: '/v1/stream', DASH_BOARD: '/dashboard/board', DASH_DECISIONS: '/dashboard/decisions', DASH_BLOCKED: '/dashboard/blocked', DASH_COST: '/dashboard/cost' }`
  - `fetchObservations(opts?: { query?: string; type?: string; lifecycle?: string; limit?: number }): Promise<Observation[]>` — POSTs `/v1/search` with `{ query, obsType?, lifecycleState?, limit }` (NO teamId), adapts the response.
  - `fetchDashboard(kind: 'board'|'decisions'|'blocked'|'cost'): Promise<unknown>` — GETs the matching `/dashboard/*` (NO teamId query param).

- [ ] **Step 1: Write the failing test**

```ts
// tests/viewer/server-data.test.ts — mock global fetch, assert URL + body shape + adaptation
import { describe, test, expect, afterEach } from 'bun:test';
import { fetchObservations } from '../../src/ui/viewer/utils/serverData.js';

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

describe('serverData', () => {
  test('fetchObservations POSTs /v1/search with filters, no teamId, adapts result', async () => {
    let seenUrl = '', seenBody: any = null;
    globalThis.fetch = (async (url: any, init: any) => {
      seenUrl = String(url); seenBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ observations: [
        { id: 'o1', projectId: 'p', teamId: 't', serverSessionId: null, kind: 'decision',
          content: 'c', metadata: { title: 'T' }, obsType: 'decision', lifecycleState: 'open',
          createdAtEpoch: 1, updatedAtEpoch: 1 } ] }) };
    }) as any;
    const out = await fetchObservations({ query: 'db', type: 'decision', lifecycle: 'open', limit: 10 });
    expect(seenUrl).toContain('/v1/search');
    expect(seenBody.query).toBe('db');
    expect(seenBody.obsType).toBe('decision');
    expect(seenBody.lifecycleState).toBe('open');
    expect('teamId' in seenBody).toBe(false); // NO teamId in UI
    expect(out[0].type).toBe('decision');     // adapted
    expect(out[0].title).toBe('T');
  });
  test('fetchObservations returns [] on non-ok, never throws', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
    expect(await fetchObservations({ query: 'x' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `~/.bun/bin/bun test tests/viewer/server-data.test.ts` → module not found.

- [ ] **Step 3: Implement `serverData.ts` + add `V1_ENDPOINTS` to api.ts**

```ts
// src/ui/viewer/utils/serverData.ts
import { adaptObservations } from './serverAdapter.js';
import type { Observation } from '../types.js';

export const V1_ENDPOINTS = {
  SEARCH: '/v1/search', CONTEXT: '/v1/context', OBSERVATION: '/v1/observations', STREAM: '/v1/stream',
  DASH_BOARD: '/dashboard/board', DASH_DECISIONS: '/dashboard/decisions',
  DASH_BLOCKED: '/dashboard/blocked', DASH_COST: '/dashboard/cost',
} as const;

export async function fetchObservations(
  opts: { query?: string; type?: string; lifecycle?: string; limit?: number } = {},
): Promise<Observation[]> {
  try {
    const body: Record<string, unknown> = { query: opts.query ?? '', limit: opts.limit ?? 50 };
    if (opts.type) body.obsType = opts.type;
    if (opts.lifecycle) body.lifecycleState = opts.lifecycle;
    const res = await fetch(V1_ENDPOINTS.SEARCH, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return adaptObservations(data.observations ?? []);
  } catch { return []; }
}

export async function fetchDashboard(kind: 'board'|'decisions'|'blocked'|'cost'): Promise<unknown> {
  const map = { board: V1_ENDPOINTS.DASH_BOARD, decisions: V1_ENDPOINTS.DASH_DECISIONS,
    blocked: V1_ENDPOINTS.DASH_BLOCKED, cost: V1_ENDPOINTS.DASH_COST };
  try {
    const res = await fetch(map[kind], { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
```
Add `V1_ENDPOINTS` export to `constants/api.ts` (re-export or define there) so the SSE hook (Task 5) imports `STREAM` from one place.

- [ ] **Step 4: Run, verify pass** (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/viewer/utils/serverData.ts src/ui/viewer/constants/api.ts tests/viewer/server-data.test.ts
git commit -m "feat(ui): /v1 data layer (fetchObservations/fetchDashboard, no teamId)"
```

---

## Task 3: Server `/v1/stream` SSE endpoint + broadcast on generation-complete

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (add `GET /v1/stream`)
- Create: `src/server/routes/v1/ObservationStream.ts` (a tiny in-process broadcaster)
- Modify: `src/server/generation/processGeneratedResponse.ts` (emit on `obsRepo.create` success, ~line 339)
- Test: `tests/server/v1-stream.test.ts`

**Interfaces:**
- Produces:
  - `ObservationStream` — a singleton with `subscribe(res): () => void` (registers an SSE response, returns unsubscribe) and `publish(event: { type: 'new_observation'; observation: unknown }): void` (writes `data: <json>\n\n` to all subscribers).
  - `GET /v1/stream` — sets `Content-Type: text/event-stream`, sends an initial `{type:'initial_load'}` comment/event, subscribes the response, cleans up on `req.close`.
- Consumes: nothing new; the generation path calls `ObservationStream.instance.publish(...)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/server/v1-stream.test.ts — unit-test the broadcaster (no live HTTP needed for the core)
import { describe, test, expect } from 'bun:test';
import { ObservationStream } from '../../src/server/routes/v1/ObservationStream.js';

describe('ObservationStream', () => {
  test('publish writes SSE-framed data to subscribers; unsubscribe stops delivery', () => {
    const s = new ObservationStream();
    const writes: string[] = [];
    const fakeRes: any = { write: (chunk: string) => writes.push(chunk), writableEnded: false };
    const unsub = s.subscribe(fakeRes);
    s.publish({ type: 'new_observation', observation: { id: 'o1' } });
    expect(writes.some(w => w.startsWith('data: ') && w.includes('o1') && w.endsWith('\n\n'))).toBe(true);
    unsub();
    writes.length = 0;
    s.publish({ type: 'new_observation', observation: { id: 'o2' } });
    expect(writes.length).toBe(0); // no delivery after unsubscribe
  });
  test('publish never throws if a subscriber write fails', () => {
    const s = new ObservationStream();
    s.subscribe({ write: () => { throw new Error('broken pipe'); }, writableEnded: false } as any);
    expect(() => s.publish({ type: 'new_observation', observation: { id: 'x' } })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify fail** — module not found.

- [ ] **Step 3: Implement `ObservationStream.ts`**

```ts
// src/server/routes/v1/ObservationStream.ts
// SPDX-License-Identifier: Apache-2.0
// In-process SSE fan-out for new observations. Best-effort: a broken subscriber
// is dropped, never throws into the publisher (generation path must not break).
type SseResponse = { write: (chunk: string) => void; writableEnded?: boolean };
export type StreamEvent = { type: 'initial_load' | 'new_observation'; observation?: unknown };

export class ObservationStream {
  private subscribers = new Set<SseResponse>();
  subscribe(res: SseResponse): () => void {
    this.subscribers.add(res);
    return () => { this.subscribers.delete(res); };
  }
  publish(event: StreamEvent): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of [...this.subscribers]) {
      try {
        if (res.writableEnded) { this.subscribers.delete(res); continue; }
        res.write(frame);
      } catch { this.subscribers.delete(res); }
    }
  }
  static instance = new ObservationStream();
}
```

- [ ] **Step 4: Run, verify pass** (2 tests).

- [ ] **Step 5: Wire the route + the emit**

In `ServerV1PostgresRoutes.ts`, register (place with the other reads, uses the same read auth):
```ts
app.get('/v1/stream', readAuth, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ type: 'initial_load' })}\n\n`);
  const unsub = ObservationStream.instance.subscribe(res);
  req.on('close', () => { unsub(); });
});
```
(import `ObservationStream` at top.)

In `processGeneratedResponse.ts`, immediately after the successful `obsRepo.create({...})` (~line 339), emit — wrapped so it never affects generation:
```ts
try {
  ObservationStream.instance.publish({ type: 'new_observation', observation: serializeForStream(observation) });
} catch { /* streaming is best-effort; never break generation */ }
```
`serializeForStream` should shape the observation the same way `/v1/search` serializes (reuse `serializeObservation` or the row mapper so the client adapter handles it identically). If importing `serializeObservation` is awkward, publish `{ id, projectId, obsType, lifecycleState, content, metadata, createdAtEpoch, updatedAtEpoch }` — the fields `adaptObservation` reads.

- [ ] **Step 6: Rebuild bundle + commit**

```bash
npm run build
git add src/server/routes/v1/ObservationStream.ts src/server/routes/v1/ServerV1PostgresRoutes.ts src/server/generation/processGeneratedResponse.ts tests/server/v1-stream.test.ts plugin/scripts/*.cjs
git commit -m "feat(server): /v1/stream SSE endpoint + broadcast new observations on generation-complete"
```

---

## Task 4: App shell — Sidebar + view routing

**Files:**
- Modify: `src/ui/viewer/App.tsx`
- Create: `src/ui/viewer/components/Sidebar.tsx`
- Create: `src/ui/viewer/views/ObservationsView.tsx`
- Create: `src/ui/viewer/views/DashboardView.tsx` (stub in this task; filled in Task 6)
- Test: `tests/viewer/app-shell.test.ts`

**Interfaces:**
- Consumes: `fetchObservations` (Task 2), reused `Feed`/`ObservationCard`.
- Produces:
  - `Sidebar` props: `{ activeView: 'observations'|'dashboard'; onSelect: (v) => void; projects: string[]; ... }`
  - `App` renders `<Sidebar>` + the active view; view state defaults to `'observations'`.
  - `ObservationsView` props: `{ observations: Observation[]; filter state }`.

- [ ] **Step 1: Write the failing test** — a render/logic test (use the viewer's existing test setup; if components need DOM, use the same test harness the current viewer component tests use — check `tests/viewer/`):

```ts
// tests/viewer/app-shell.test.ts
import { describe, test, expect } from 'bun:test';
import { getInitialView, VIEWS } from '../../src/ui/viewer/views/viewState.js';
describe('app shell view state', () => {
  test('default view is observations', () => { expect(getInitialView()).toBe('observations'); });
  test('VIEWS lists observations + dashboard', () => {
    expect(VIEWS.map(v => v.id)).toEqual(expect.arrayContaining(['observations', 'dashboard']));
  });
});
```
(Extract the view registry into a tiny testable `views/viewState.ts` — `export const VIEWS = [{id:'observations',label:'Observations'},{id:'dashboard',label:'Dashboard'}] as const; export function getInitialView(){return 'observations';}` — so the shell logic is unit-testable without a DOM.)

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `views/viewState.ts`, `Sidebar.tsx` (left rail: brand, VIEWS nav items with active highlight, project selector, theme toggle; leave a commented "team switcher / members" seam), `views/ObservationsView.tsx` (wraps reused `Feed` + a filter-chips row — chips call `fetchObservations({type, lifecycle})`; hybrid-search input calls `fetchObservations({query})`), a stub `views/DashboardView.tsx` returning a "Dashboard" placeholder, and rewire `App.tsx` to hold `activeView` state and render `<Sidebar>` + the active view. Warm-dark+gold styling via existing theme tokens.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/ui/viewer/App.tsx src/ui/viewer/components/Sidebar.tsx src/ui/viewer/views/ tests/viewer/app-shell.test.ts
git commit -m "feat(ui): sidebar shell + view routing (Observations | Dashboard)"
```

---

## Task 5: Repoint useSSE to /v1/stream with refetch fallback

**Files:**
- Modify: `src/ui/viewer/hooks/useSSE.ts`
- Test: `tests/viewer/use-sse-fallback.test.ts`

**Interfaces:**
- Consumes: `V1_ENDPOINTS.STREAM` (Task 2), `fetchObservations` (Task 2), `adaptObservation` (Task 1).
- Produces: `useSSE()` unchanged return shape (`{ observations, ... }`), now sourced from `/v1/stream`; on stream error/drop it starts a periodic `fetchObservations()` refetch until the stream reconnects.

- [ ] **Step 1: Write the failing test** — extract the fallback decision into a pure helper so it's testable without `EventSource`:

```ts
// tests/viewer/use-sse-fallback.test.ts
import { describe, test, expect } from 'bun:test';
import { shouldFallbackToPolling } from '../../src/ui/viewer/hooks/sse-fallback.js';
describe('sse fallback', () => {
  test('falls back after a stream error', () => {
    expect(shouldFallbackToPolling({ streamErrored: true, reconnecting: true })).toBe(true);
  });
  test('no fallback while stream is healthy', () => {
    expect(shouldFallbackToPolling({ streamErrored: false, reconnecting: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `hooks/sse-fallback.ts` (`export function shouldFallbackToPolling(s:{streamErrored:boolean;reconnecting:boolean}){return s.streamErrored;}`), and update `useSSE.ts`: point `new EventSource` at `V1_ENDPOINTS.STREAM`; handle the `{type:'new_observation', observation}` event by `adaptObservation`-ing it into state; in `onerror`, set streamErrored and start a `setInterval` polling `fetchObservations()` (clearing it on successful reconnect). Keep the existing reconnect-timeout logic.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/ui/viewer/hooks/useSSE.ts src/ui/viewer/hooks/sse-fallback.ts tests/viewer/use-sse-fallback.test.ts
git commit -m "feat(ui): useSSE reads /v1/stream, degrades to refetch on drop"
```

---

## Task 6: DashboardView — KPI strip + lifecycle Kanban + decision log + cost

**Files:**
- Modify: `src/ui/viewer/views/DashboardView.tsx`
- Create: `src/ui/viewer/utils/dashboardShape.ts` (pure transforms of `/dashboard/*` payloads → render models)
- Test: `tests/viewer/dashboard-shape.test.ts`

**Interfaces:**
- Consumes: `fetchDashboard` (Task 2).
- Produces:
  - `toKpis(board, cost): { open:number; blocked:number; resolved:number; usd:number }`
  - `toKanbanColumns(board): Array<{ state: string; items: Array<{id:string;title:string}> }>`
  - `toDecisionChains(decisions): Array<{ head:{id:string;title:string;why?:string}; history: Array<{id:string;title:string}> }>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/viewer/dashboard-shape.test.ts
import { describe, test, expect } from 'bun:test';
import { toKpis, toKanbanColumns, toDecisionChains } from '../../src/ui/viewer/utils/dashboardShape.js';

const board = { open: [{ id:'a', content:'A' }], blocked: [], deferred: [],
  resolved: [{ id:'b', content:'B' }], active: [], superseded: [] };
const cost = { discoveryTokens: 85000, estUsd: 0.42 };
const decisions = [{ head: { id:'d1', content:'Postgres over SQLite', metadata:{ why:'multi-writer' } }, history: [] }];

describe('dashboardShape', () => {
  test('toKpis counts by lifecycle + usd', () => {
    const k = toKpis(board, cost);
    expect(k.open).toBe(1); expect(k.resolved).toBe(1); expect(k.blocked).toBe(0); expect(k.usd).toBeCloseTo(0.42);
  });
  test('toKanbanColumns yields a column per state with items', () => {
    const cols = toKanbanColumns(board);
    const open = cols.find(c => c.state === 'open');
    expect(open?.items[0].id).toBe('a');
  });
  test('toDecisionChains preserves head + history with why', () => {
    const chains = toDecisionChains(decisions);
    expect(chains[0].head.id).toBe('d1');
    expect(chains[0].head.why).toBe('multi-writer');
    expect(chains[0].history).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `dashboardShape.ts` (pure functions; title from `metadata.title` or first line of `content`; usd from `cost.estUsd`; group board keys into ordered columns open→active→blocked→deferred→resolved→superseded), then `DashboardView.tsx` renders KPI strip, Kanban columns, decision-log (head + collapsible history), cost — fetching via `fetchDashboard`. Include the blocked-on-whom panel as a rendered-but-empty seam.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add src/ui/viewer/views/DashboardView.tsx src/ui/viewer/utils/dashboardShape.ts tests/viewer/dashboard-shape.test.ts
git commit -m "feat(ui): DashboardView — KPI strip, lifecycle Kanban, decision log, cost"
```

---

## Task 7: Serve the unified app from server-mode at /

**Files:**
- Modify: `src/server/runtime/ServerViewerRoutes.ts`
- Modify: `scripts/build-viewer.js` (if the built entry/name changes) — else no-op
- Test: `tests/server/unified-ui-serve.test.ts`

**Interfaces:** none new — serves the built `viewer-bundle.js` + `viewer.html` (now the unified app) at `/`, static assets from `ui`/`plugin/ui`.

- [ ] **Step 1: Write the failing test** — mirror `tests/server/dashboard/dashboard-mount.test.ts`: boot a `Server`, register `ServerViewerRoutes`, assert `GET /` → 200 `text/html` and the body contains the app root mount point (e.g. `id="root"` or the MemSmith title).

```ts
// tests/server/unified-ui-serve.test.ts (Postgres-gated skip guard like the others)
// beforeEach: new Server(...), server.registerRoutes(new ServerViewerRoutes()), finalizeRoutes, listen(0)
// test: GET / -> 200, content-type text/html, body includes 'MemSmith' and the react root div
```

- [ ] **Step 2: Run, verify fail** (if current viewer.html already serves at / it may pass trivially — then assert the body is the UNIFIED app, i.e. contains the sidebar/view markers the build emits).

- [ ] **Step 3: Implement** — confirm `ServerViewerRoutes` serves `viewer.html` (the unified app's HTML after Task 4–6 build) at `/` and the bundle + assets statically; the existing candidate-path/`getPackageRoot()` resolution already covers `plugin/ui`. If the unified build emits a differently-named HTML/bundle, update the candidate paths. No `import.meta.url` at module top level.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Rebuild + commit**

```bash
npm run build
git add src/server/runtime/ServerViewerRoutes.ts scripts/build-viewer.js plugin/ui/* plugin/scripts/*.cjs tests/server/unified-ui-serve.test.ts
git commit -m "feat(server): serve the unified MemSmith UI at / on server-mode"
```

---

## Task 8: End-to-end verification against the live dogfood server

**Files:** none (verification only).

- [ ] **Step 1: Full build + suite**

```bash
npm run build   # exit 0, regenerates bundle + viewer
export MEMSMITH_TEST_POSTGRES_URL="postgres://postgres:postgres@localhost:55432/tam_test"
~/.bun/bin/bun test   # all pass, incl. new viewer + stream + serve tests
npx tsc --noEmit 2>&1 | grep -c "error TS"   # 0
```

- [ ] **Step 2: Manual smoke against the running dogfood server** (the one on :37900 from the dogfood, restart if needed with the local-dev-bypass env):

```
GET http://127.0.0.1:37900/                 -> 200, unified app HTML
open the app -> Observations view shows the qwen-generated decision (no Team-ID prompt)
click a type chip (decision) -> feed filters
switch to Dashboard -> the decision appears in the Resolved column + decision log
POST a new /v1/events observation -> it appears live via /v1/stream (or on refetch fallback)
```
Record the outcome (screenshot/notes) in the task report. This is the real dogfood confirmation.

---

## Self-Review

**1. Spec coverage:**
- serverAdapter (/v1→viewer shape) → Task 1 ✅
- /v1 data layer, no teamId → Task 2 ✅
- `/v1/stream` SSE + broadcast → Task 3 ✅
- sidebar shell + view switcher → Task 4 ✅
- Observations view (feed + inline chips + hybrid search) → Task 4 ✅
- useSSE repoint + fallback → Task 5 ✅
- DashboardView (KPI + Kanban + decision log + cost) → Task 6 ✅
- serve unified app at / → Task 7 ✅
- warm-dark+gold, team seams, bundle-safe paths → Global Constraints + Tasks 4/6/7 ✅
- e2e dogfood confirmation → Task 8 ✅
- Out-of-scope (identity, embedding gap) → not tasked, correct.

**2. Placeholder scan:** No TBD/TODO. Each code task has complete code or a concrete component spec with the exact props/transforms; test bodies are real. The two React *view* components (Task 4/6) are described by their props + the pure helpers they consume (viewState, dashboardShape) which ARE fully coded and tested — the JSX rendering is delegated to reused components + the tested transforms, which is the right seam for a plan (don't over-specify JSX).

**3. Type consistency:** `Observation` (viewer) is the single target type across adapter/data/SSE. `ServerObservation` fields match `serializeObservation`'s output. `V1_ENDPOINTS` defined once (Task 2), consumed by Tasks 2/5. `ObservationStream.instance.publish({type,observation})` shape matches the client's `{type:'new_observation',observation}` handler. Dashboard transforms consume the real `/dashboard/*` shapes (`{open,blocked,...}` board, `{head,history}` decisions, `{estUsd}` cost) verified against queries.ts.

**Note for executor:** Tasks 1→3 are independent (adapter, data, server-stream) and could be done in any order, but run 1→8 as written: data/adapter/stream first, then the shell (Task 4) consumes them, then SSE (5), then dashboard (6), then serving (7), then e2e (8). Server tasks (3, 7) touch bundles — rebuild + commit `.cjs`. Viewer tasks (1,2,4,5,6) touch `viewer-bundle.js` via `npm run build` — rebuild + commit at the serving/e2e step at latest.
