# Local Fresh-Install Readiness — Design

**Date:** 2026-07-27
**Status:** Proposed — awaiting user approval
**Goal:** A fresh project installs MemSmith, gets memory, views its own scoped dashboard, and reaches the Go Team wizard safely.

---

## Why this exists

2026-07-27 was the first time MemSmith was installed into a genuinely fresh
project end-to-end. That single exercise surfaced seven distinct defects on the
install-and-use path. Every prior P3 attempt died at step one for a different
reason, and each was fixed as a one-off symptom rather than as a class.

The prior plan (`docs/superpowers/plans/2026-07-14-local-production-readiness.md`)
covered test-suite health and scope resolution. It does not cover any item here.

**The bar:** a fresh project works end-to-end *through the dashboard*. UI is in
scope — items 1–3 are UI, and item 1 is precisely what makes Go Team unsafe.

## Already proven working (do not re-litigate)

Verified live on 2026-07-27 against the running server:

- A fresh project mints identity and gets its own `msp_<projectId>` database on first write
- Data isolation holds — the temp project's observations never entered the dogfood's 4172
- A scoped dashboard returns a real empty state (`200`, `total: 0`), not an error
- Per-request DB routing, generation-path routing, cold-boot stale-stamp repair, embedded-PG pid re-adoption

## Out of scope (deferred, tracked separately)

5. 7 legacy `api_keys` rows with `project_id = NULL` (pre-`fc8a38ca`) — dormant teams
6. `shouldTrackProject` string-globs an unresolved path (`/tmp` vs `/private/tmp`)
7. Settings API accepts only 4 keys; most config is hand-edit-only
8. 9 pre-existing test failures

---

## Item 1 — Settings must report the request's project (P3 BLOCKER)

**Defect.** `settingsRoutes.ts:79` reads the marker from
`process.env.MEMSMITH_PROJECT_CWD ?? process.cwd()` — the **server's** cwd — so
`GET /v1/identity` always returns the dogfood's `teamId`/`projectId` regardless
of which project's dashboard is being viewed.

**Why it blocks P3.** The Go Team wizard lives in Settings. `ConvertRoutes`
correctly converts `req.authContext.projectId`, but the UI would *display* a
different project than the one being converted. A user could reasonably believe
they are converting the dogfood. Nobody should click convert on that screen.

**Fix.** Derive identity from `req.authContext` first; fall back to the marker
only when `authContext` carries no project.

```ts
const ctxTeam = req.authContext?.teamId;
const ctxProject = req.authContext?.projectId;
const ids = (ctxTeam && ctxProject)
  ? { teamId: ctxTeam, projectId: ctxProject }
  : readProjectMarker(process.env.MEMSMITH_PROJECT_CWD ?? process.cwd());
```

**Response shape is unchanged** — `{teamId, projectId, keyPresent, keyMasked}`,
plus `keyPlaintext` under the existing loopback-gated `?reveal=true`. Only the
*source* of the values changes. The frontend needs no coordination for this item.

**Security note.** `keyMasked`/`keyPlaintext` come from
`store.resolveKeyForTeam(ids.teamId)`. Because `teamId` now comes from
`authContext`, a caller only ever sees the key for the team it authenticated as.
This is narrower than today's behaviour, not wider.

**Tests.** authContext present → returns that project, not the server's cwd;
authContext absent → falls back to the marker; no marker and no authContext →
404 unchanged; `?reveal=true` stays loopback-only.

---

## Item 2 — Scope must survive navigation

**Defect.** `GET /?project=<id>` sets the scoping cookie, but visiting bare `/`
overwrites it back to the server's project. Reproduced live: `?project=<temp>`
returns the temp project's data; a subsequent `/` returns the dogfood's. In a
browser, `/` is hit constantly, so scope silently reverts.

**Fix (frontend).** The viewer reads `?project=` from `location.search` on load,
holds it in app state, and preserves it across view changes so the query
parameter is never dropped. The SPA is currently *entirely unaware* of
`?project=` — the only `URLSearchParams` use in the viewer is pagination.

**Do not** change the server rule that a bare `/` means "the server's project".
That default is correct for a first visit; the bug is the SPA discarding the
parameter it was given.

**Tests.** A view change preserves `?project=`; a load without the parameter
behaves exactly as today.

---

## Item 3 — Project switcher

**Defect.** No way to change scope except hand-editing the URL.

### New endpoint: `GET /v1/projects`

Loopback-gated, using the same three-part gate already shipped for the cookie
(`isLocalhost` && `hasLoopbackHostHeader` && `!hasForwardedClientHeaders`).

Returns only projects **this machine holds a key for** — the DB `projects` table
joined against `CredentialStore`. This mirrors the cookie rule exactly, so the
switcher can never offer a project it cannot actually open.

```json
[
  {
    "projectId": "42d7997d-…",
    "teamId": "bfc62ef3-…",
    "name": "ms-p3-fresh",
    "runtime": "local",
    "isCurrent": true
  }
]
```

- `runtime` is `"local" | "team"`, read from that project's **own marker**
  (`ProjectMarker.runtime`), not the global `MEMSMITH_RUNTIME`. Absent → `"local"`.
- `isCurrent` — matches `req.authContext.projectId`.

### `name` — an honest gap

`upsertTeamAndProject` inserts `VALUES ($1, $2, $1)` — **`projects.name` is set
to the projectId**. There are no human-readable names today, so a naive switcher
would list raw UUIDs.

Resolution for this round: derive the display name from the project's directory
basename when a marker path is known, else fall back to the short projectId
(first 8 chars). Populating `projects.name` properly is a follow-up, not part of
this work — but the endpoint must not pretend a real name exists.

### Header

The dashboard header always names the current project and its runtime:

```
ms-p3-fresh · Local        acme-api · Team
```

This is the user's stated requirement: one dashboard is fine **provided the
headline of both local and team is properly set**.

### Selecting a project

Navigating to `/?project=<id>` re-issues the cookie for that project (already
implemented and verified). The switcher performs that navigation.

**Tests.** Only key-holding projects are listed; `runtime` reflects each
project's own marker; `isCurrent` matches authContext; non-loopback requests are
refused.

---

## Item 4 — First-run welcome link is unscoped

**Defect.** Identity mints on `UserPromptSubmit` (`session-init`), not
`SessionStart`. The two SessionStart hooks only boot the server and render the
welcome, so the very first welcome renders before a marker exists and emits an
unscoped link. It self-corrects on the second session.

**Fix.** In `context.ts`, when no marker exists yet, emit the bare link as today
(never block or fail the welcome). The durable fix is for the server to resolve
a bare link to the requesting project; that is a larger change and is **not**
required for the bar. Lowest priority of the four.

---

## Parallelisation

The work splits with **no file overlap**:

| Agent | Items | Files |
|---|---|---|
| Backend | 1, 3-endpoint, 4 | `settingsRoutes.ts`, `identity-payload.ts`, `dashboard-url.ts`, `context.ts` |
| Frontend | 2, 3-UI | `App.tsx`, `SettingsView.tsx`, `serverData.ts` |

The only shared contract is `GET /v1/projects`, specified above. `/v1/identity`
keeps its current response shape. Neither agent may change an API shape without
raising it — the controller owns the contract.

**Known verification limit.** Neither agent can drive a real browser. Frontend
work is verified by component logic and HTTP. Final confirmation requires the
user to click through — this is the same gap that let the "Failed to load
dashboard data" error persist for weeks while every curl check passed.

## Global constraints

- **Dogfood safety is absolute.** Live store is base `postgres` on `:55433`
  (~4172 observations). Never DROP/ALTER an existing database. Test guards
  refusing `/.memsmith` and `:55433` stay.
- **Security invariant.** The database a request touches derives from
  `req.authContext` and nothing else. A client-supplied `projectId` may narrow a
  `WHERE` clause but must never select a pool.
- The team API key must never be written into `.memsmith/project.json`; it lives
  only in `CredentialStore`.
- `npx tsc --noEmit` is the typecheck gate. Ignore known editor-only false
  positives: `bun:test` resolution, `.js` import paths, `ZodTypeAny` deprecated.
- Baseline is **9 test failures**; the bar is zero *new* failures.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Acceptance

A fresh project, installed from scratch:

1. Mints identity and its own `msp_` database
2. Welcome link is scoped from the second session onward
3. Its dashboard loads with a real empty state
4. The header names the project and its runtime
5. The switcher lists only projects this machine can open
6. Scope survives navigation
7. **Settings shows that project's identity** — so Go Team is safe to click
8. The dogfood remains untouched throughout
