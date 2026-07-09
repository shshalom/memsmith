# Unified MemSmith UI (server-mode) — Design

**What:** One React single-page app, served by the **server-mode** runtime, that
unifies the rich observation **viewer** and the team **dashboard** behind a left-sidebar
view switcher — running locally with **no Team-ID and no key paste**, in a warm-dark +
gold aesthetic, built **team-aware-ready**.

**Why:** Dogfooding surfaced the gap: the polished observation-browsing viewer
(`src/ui/viewer/`, a React app) targets the **worker** runtime's `/api/*` endpoints and
does not work against **server-mode** (`/v1/*`), where all the new product value lives
(hybrid retrieval, tiering, supersession, typed taxonomy, team dashboard). Server-mode
had only a thin 4-panel dashboard that (a) required pasting a Team-ID UUID and (b)
couldn't authenticate its own data calls. This design gives server-mode the rich,
usable UI the product needs.

## Scope

**In scope:** unified viewer + dashboard UI on server-mode `/v1/*`; left-sidebar shell +
view switcher; Observations view (feed + inline type/lifecycle filter chips + hybrid
search); Dashboard view (KPI strip + lifecycle Kanban + decision log + cost); a
`/v1/stream` SSE endpoint for live updates; serving the built app from server-mode at
`/`; local zero-Team-ID / zero-key operation.

**Out of scope (tracked follow-ups):**
- **Team identity & access** — owners, members, self-serve API keys, real multi-user
  auth, attribution *data*. This UI leaves the *seams* (attribution slot, member/team
  switcher placement) but builds no identity subsystem.
- **The embedding gap** — server-mode generation not populating `embedding_vec` (found
  during dogfood; semantic search empty, FTS covers it). Separate investigation.
- Remote/multi-team deployment of the UI.

## Decisions (settled in brainstorm)

- **Shell:** left sidebar nav (Observations · Dashboard; Decisions/Blocked/Cost as
  future sub-items).
- **Observations filtering:** inline filter chips (type + lifecycle) above the feed, plus
  a hybrid-search bar.
- **Dashboard organization:** KPI strip + lifecycle Kanban (open→blocked→deferred→
  resolved) + decision log + cost panel.
- **Visual style:** warm dark + gold (current brand accent; the "smith"/forge feel).
- **Team resolution:** from the API key / local-dev bypass — the server derives
  team+project; the UI never shows or asks for a Team-ID.
- **Live updates:** build a real `/v1/stream` SSE endpoint (not polling).
- **Team-readiness:** build single-team now, but leave structural seams (attribution
  slot on cards, blocked-on-whom panel, switcher placement) for the deferred identity
  work.

## Architecture

Extend the existing React app in `src/ui/viewer/`. It currently renders a flat
`Observation` shape from worker `/api/*`; the port introduces a **data-adapter layer** so
components stay unchanged while the data source becomes `/v1/*`.

```
src/ui/viewer/
  App.tsx                      # CHANGED: sidebar shell + view routing
  components/
    Sidebar.tsx                # NEW: left rail nav, brand, project selector, theme; team-switcher seam
    ObservationCard.tsx        # CHANGED: add attribution slot (empty until identity lands)
    Feed.tsx, SummaryCard.tsx, PromptCard.tsx, ErrorBoundary.tsx, ScrollToTop.tsx  # REUSED as-is
  views/
    ObservationsView.tsx       # NEW: Feed + inline type/lifecycle chips + hybrid search
    DashboardView.tsx          # NEW: KPI strip + lifecycle Kanban + decision log + cost
  utils/
    serverAdapter.ts           # NEW: /v1 observation shape -> viewer Observation shape
  hooks/
    useSSE.ts                  # CHANGED: repoint to /v1/stream, fall back to refetch on drop
  constants/
    api.ts                     # CHANGED: /v1 endpoints (no teamId in UI)
```

Server-side:
```
src/server/routes/v1/ServerV1PostgresRoutes.ts   # ADD: GET /v1/stream (SSE)
src/server/runtime/ServerViewerRoutes.ts         # CHANGED: serve the unified app at /
```

## Data layer (the core of the port)

The viewer's `Observation` (types.ts) is flat: `type, title, subtitle, narrative, text,
facts, concepts, files_read, files_modified, created_at_epoch, ...`. Server `/v1`
serializes: `{ id, projectId, teamId, kind, content, metadata: {title, subtitle, facts,
narrative, why, ...}, obsType, lifecycleState, createdAtEpoch, updatedAtEpoch,
supersededBy? }`.

`serverAdapter.ts` maps `/v1 → viewer`:
- `obsType` → `type`; `lifecycleState` → a lifecycle field the card reads.
- `metadata.title/subtitle/narrative` → `title/subtitle/narrative`.
- `metadata.facts` (array) → the viewer's `facts` (string) — join/serialize to match.
- `content` retained as the full body.
- Missing fields degrade to empty strings — **never throws** on a malformed row.

Endpoints (`api.ts`): `/v1/search` (feed + hybrid search), `/v1/context`,
`/v1/observations/:id`, `/dashboard/board|decisions|blocked|cost`, `/v1/stream`. No
`teamId` query param — the server scopes from the key / local-dev bypass.

## Views

**ObservationsView:** hybrid-search bar; a wrapping row of inline chips — type
(decision/bug/blocker/gotcha/change/…) and lifecycle (open/active/blocked/deferred/
resolved/superseded) — that filter the feed; the reused `Feed`/`ObservationCard` render
adapted observations. Chips drive `/v1/search` filters (obs_type, lifecycle) already
supported server-side.

**DashboardView:** a KPI strip (open / blocked / resolved counts + $ reused from
`/dashboard/cost`), a lifecycle Kanban from `/dashboard/board`, a decision log from
`/dashboard/decisions` (rendered with its supersession lineage — the `{head, history}`
shape from grab-spec #8), and the cost panel. The blocked-on-whom query is wired but
its panel is a team seam (shows when attribution data exists).

## Live updates — `/v1/stream`

New server-sent-events endpoint on the server runtime that emits an event when a new
observation is persisted (hook into the generation-complete path / queue-completion).
`useSSE.ts` connects to `/v1/stream`; on connection drop it falls back to a periodic
`/v1/search` refetch so a broken stream degrades to polling, never a dead feed. Reuses
the worker viewer's SSE event shape where practical.

## Serving

`ServerViewerRoutes` currently serves the stale worker `viewer.html` at `/` (whose
`/api/*` calls 404 on server-mode). Change it to serve the **built unified app** (the
React bundle + assets) at `/`, so `GET /` on the server runtime returns the working UI.
Keep the candidate-path / `getPackageRoot()` resolution pattern (bundle-safe, per the
dashboard-routes fix).

## Error handling

- **Adapter:** never throws; missing metadata → empty fields.
- **SSE:** disconnect → automatic fallback to periodic refetch; reconnect attempts
  bounded.
- **Auth/empty states:** a `/v1` 401 (non-local, missing key) renders a clear
  "configure an API key" state, not a blank page; no observations yet → a friendly empty
  state; no key and no local-dev bypass → "configure a key" guidance.
- **Server-serve:** if the built app is missing at boot, log and fall back (mirror
  ServerViewerRoutes' existing null-bytes handling).

## Testing

- **Adapter unit tests** (pure, no server): `/v1` → viewer shape; missing-field degrade;
  obs_type→type and lifecycleState mapping; facts array→string.
- **DashboardView tests:** `/dashboard/*` payloads render into KPI/Kanban/decision-log;
  decision supersession lineage renders.
- **ObservationsView tests:** chip filters produce the right `/v1/search` query params;
  hybrid-search input drives the query.
- **`/v1/stream` integration test** (Postgres-gated, port 55432): persisting an
  observation emits a stream event; disconnect falls back to refetch.
- **Server-serve test:** `GET /` returns the unified app HTML (mirrors the
  `dashboard-mount` test).
- **Reused-component tests** stay green (Feed/ObservationCard unchanged behavior).

## Global constraints

- Server-mode `/v1/*` only; no worker `/api/*` dependency in the unified app.
- No Team-ID or key entry in local operation (server resolves scope).
- Adapter + SSE never crash the UI; degrade gracefully.
- Warm-dark + gold; reuse existing theme tokens where present.
- Bundle-safe path resolution for server-side serving (no `import.meta.url` at module
  top level in bundled code — the dashboard-routes lesson).
- Team features are seams only; no identity/auth subsystem built here.
