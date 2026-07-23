# Wizard Convert Wiring — Design (Sub-spec 3 of Project-Scoped Go Team)

**Date:** 2026-07-23
**Status:** Approved (design). Ready for implementation planning.
**Predecessors:** Sub-spec 1 — Per-Project Runtime (merged `38ce3ef7`); Sub-spec 2 — Scoped Convert Copy (merged `625dc3bb`).

## Problem

The Go Team wizard's convert path is not wired end-to-end. The server route
`POST /v1/convert/migrate` now requires `databaseUrl`, `cwd`, `serverUrl`, `apiKey`,
and `projectId` (added across sub-specs 1 and 2), but the **browser** wizard client
(`src/ui/viewer/views/wizard/wizardData.ts` `migrate()`, called by `ConvertCard.tsx`)
posts only `{ databaseUrl }`. A live wizard convert therefore fails with
`400 cwd required` before it ever reaches the scoping logic.

Worse, three of the required fields are **impossible or unsafe for the browser to
supply**:

- **`cwd`** — the browser has no filesystem / project-directory concept.
- **`projectId`** — lives in the on-disk local marker `.memsmith/project.json`.
- **`apiKey`** — the team API key. Per project constraint, it lives **only** in
  `CredentialStore` and must never leave it; putting it in the browser is a security
  regression.

## Insight (why the fix is server-side)

The convert route runs on the **local server**, co-located with the project. It
already knows — or can resolve — every field:

- The codebase already resolves local scope via
  `readLocalScopeFromMarkerOrEnv(process.env.MEMSMITH_PROJECT_CWD ?? process.cwd())`
  (`src/server/runtime/resolve-local-scope.ts`), the same pattern used by
  `settingsRoutes.ts`, `dashboard/spend.ts`, and `create-server-service.ts`.
- The team API key is minted/resolved by the existing idempotent primitive
  `ensureBaseKey(pool, teamId, projectId, store)`
  (`src/services/identity/project-identity.ts`), which reuses `createRawApiKey` /
  `hashApiKey`, inserts the `api_keys` hash row, and caches the plaintext in
  `CredentialStore`.

So sub-spec 2's Decision D1 ("the client sends `projectId`") was correct reasoning for
a *remote* server, but convert is a *local-server* operation: the server is the client's
host. This sub-spec moves field resolution to the server for the migrate route.

## Scope

**In scope:**
- `POST /v1/convert/migrate` resolves `projectId`/`teamId`/`cwd` from its own local
  marker/env, `serverUrl` from `databaseUrl`, and `apiKey` from `CredentialStore`
  (minting against the destination on first convert). The request body carries **only**
  `databaseUrl` (unchanged client).
- Remove the now-obsolete body-field requirements (`cwd`, `serverUrl`, `apiKey`,
  `projectId`) from the migrate route.
- Explicit, honest error when local scope cannot be resolved (no marker/env).
- Keep the client (`wizardData.migrate`, `ConvertCard`) posting `{ databaseUrl }` — no
  browser change beyond what's already there.
- Tests: route resolves fields server-side; 400 collapses to only `databaseUrl required`
  + a new "local scope unresolvable" error; the scoped-copy behavior from sub-spec 2 is
  unchanged (still receives a real `projectId`/`teamId`).

**Out of scope (unchanged):**
- The scoped copy engine / `convert-scope.ts` / `buildConvertCopyDeps` (sub-spec 2) —
  they keep their `{ projectId, teamId }` scope input; only the *source* of those values
  changes (route resolves instead of body).
- `flipToTeam` internals (sub-spec 1).
- `POST /v1/convert/test-connection` — already `{ databaseUrl }`-only; untouched.
- Better-auth / interactive sign-in (finding #2) — not required; the key is minted from
  the destination connection.
- Any wizard UI redesign, new cards, or invite flow.

## Decisions

### D1 — Server resolves host/identity fields; client sends only `databaseUrl`

The migrate route resolves:

| Field | Source |
|---|---|
| `cwd` | `process.env.MEMSMITH_PROJECT_CWD ?? process.cwd()` |
| `projectId`, `teamId` | `readLocalScopeFromMarkerOrEnv(cwd)` → `{ teamId, projectId } \| null` |
| `serverUrl` | derived from the submitted `databaseUrl` (see D3); else existing marker `serverUrl` |
| `apiKey` | `CredentialStore.resolveKeyForTeam(teamId)`, minting on miss (see D2) |

`databaseUrl` continues to come from the request body (the user typed it in
`DestinationCard`). Reverses sub-spec 2's D1 **for the migrate route only** — the copy
scope still uses a real `projectId`/`teamId`, now server-resolved.

### D2 — First-convert key bootstrap: mint against the destination

On `resolveKeyForTeam(teamId)` miss (first Go Team for this team), the route mints the
team key **server-side against the destination database**, so the browser never holds a
secret:

1. Open a pool to the destination via the submitted `databaseUrl` (the convert route
   already builds a remote pool in `buildConvertCopyDeps`; reuse that pool/bootstrap).
2. Call `ensureBaseKey(remotePool, teamId, projectId, credStore)` — idempotent: it mints
   a raw key, inserts the `api_keys` hash row on the destination, and caches the
   plaintext in `CredentialStore` keyed by `teamId`. On a second run it returns the
   cached key (repairing DB drift if needed).
3. Use the resolved/minted key as the `apiKey` the flip records.

The key the user *did* provide — the destination Postgres credentials — is already
inside the `databaseUrl` they submitted; no additional secret enters the browser.

Ordering: the remote schema must be bootstrapped before `ensureBaseKey` inserts the
`api_keys` row. `buildConvertCopyDeps` already lazily bootstraps the remote schema; the
mint must run **after** bootstrap and **before** the copy's flip. The plan places the
key resolution/mint at the start of the convert handler using the same remote pool the
copy uses (bootstrap it up front for this path).

### D3 — `serverUrl` derivation

`serverUrl` is the HTTP base URL the flipped marker records so the local hooks can reach
the team server. It is derived deterministically from the submitted `databaseUrl`
host, or taken from the existing marker's `serverUrl` if one is already present
(re-convert). Exact derivation rule is fixed in the plan; the spec requires only that it
is server-derived (not browser-supplied) and non-empty before the flip.

### D4 — Honest failure when local scope is unresolvable

If `readLocalScopeFromMarkerOrEnv(cwd)` returns `null` (no marker, no env — e.g. convert
invoked outside a MemSmith project), the route returns
`400 { error: 'no local project identity — run inside a MemSmith project' }` before any
copy or mint. This replaces the four field-presence 400s the client can no longer
satisfy. `databaseUrl` presence 400 stays.

## Component / data flow

```
DestinationCard (browser)     ConvertCard (browser)
   user enters databaseUrl  →   migrate(databaseUrl)   [UNCHANGED]
                                     │  POST { databaseUrl }
                                     ▼
ConvertRoutes.ts  /v1/convert/migrate  (owner-gated)
   databaseUrl ← body (400 if missing)
   cwd        ← MEMSMITH_PROJECT_CWD ?? process.cwd()
   scope      ← readLocalScopeFromMarkerOrEnv(cwd)   (400 if null — D4)
   serverUrl  ← derive(databaseUrl) | marker.serverUrl   (D3)
   apiKey     ← credStore.resolveKeyForTeam(teamId)
                 ?? ensureBaseKey(remotePool, teamId, projectId, credStore)  (D2)
        │  convert({ databaseUrl, ownerUserId(authCtx), cwd, teamId(scope),
        │            serverUrl, apiKey, projectId(scope) })
        ▼
buildConvertCopyDeps(databaseUrl, { projectId, teamId })   [sub-spec 2, UNCHANGED]
runConvert → scoped runCopy → verifyCopy → flipToTeam       [UNCHANGED]
```

`ownerUserId` continues to come from `req.authContext` (unchanged). `teamId` now comes
from the local marker scope (the project being converted), not authContext — consistent
with "convert THIS local project."

## Interfaces (contract changes)

- **`POST /v1/convert/migrate` body:** `{ databaseUrl: string }` only. The `cwd`,
  `serverUrl`, `apiKey`, `projectId` body reads and their 400s are removed; a new
  D4 400 is added.
- **`ConvertRoutesDeps`** gains a server-side resolver dependency so the route stays
  testable without real fs/PG. Proposed shape (plan finalizes):
  `resolveConvertContext: (databaseUrl: string) => Promise<{ cwd; teamId; projectId; serverUrl; apiKey } | { error: string }>`.
  The production wiring composes it from `readLocalScopeFromMarkerOrEnv`,
  `serverUrl` derivation, `CredentialStore`, and `ensureBaseKey`. Tests inject a fake.
- **`ConvertRoutesDeps.convert`** input is unchanged from sub-spec 2
  (`{ databaseUrl, ownerUserId, cwd, teamId, serverUrl, apiKey, projectId }`) — it now
  receives server-resolved values.
- **`wizardData.migrate(databaseUrl, fetchImpl?)`** — unchanged (already
  `{ databaseUrl }`). `ConvertCard` — unchanged.
- No schema/migration changes.

## Error handling

- Missing `databaseUrl` → `400 databaseUrl required` (unchanged).
- Local scope null → `400 no local project identity …` (D4), before any DB work.
- `resolveKeyForTeam` miss handled by mint (D2), not an error.
- Mint failure (e.g. destination unreachable / not writable) → surfaces as convert
  failure (existing `try/catch` → 500 with the error message); no flip.
- Verify mismatch → existing `verify_failed`, no flip (unchanged).

## Testing

1. **Route resolves server-side (happy path):** POST `{ databaseUrl }` with a fake
   `resolveConvertContext` returning a full context → route calls `convert` with the
   resolved `cwd/teamId/projectId/serverUrl/apiKey`; 200 converted. Asserts the client
   no longer needs to send those fields.
2. **Missing databaseUrl → 400 databaseUrl required.**
3. **Unresolvable local scope → 400** with the D4 message; `convert` not called.
4. **Key resolved from CredentialStore (existing key):** resolver returns the cached
   key; `ensureBaseKey`/mint not invoked. (Unit-test the composed resolver with a fake
   store + fake pool.)
5. **Key minted on miss (first convert):** resolver with an empty store + a fake remote
   pool → `ensureBaseKey` mints, stores in CredentialStore, and the resolved context
   carries the minted key. Idempotent on a second call (returns the same key).
6. **serverUrl derivation:** given a `databaseUrl`, the derived `serverUrl` matches the
   fixed rule (plan pins exact expected value); marker `serverUrl` takes precedence when
   present.
7. **Scoped copy unaffected:** the copy still receives a real `projectId`/`teamId` and
   the sub-spec 2 scoped/isolation behavior is unchanged (existing sub-spec 2 tests stay
   green).
8. **Client unchanged:** `wizardData.migrate` still posts `{ databaseUrl }` (existing
   test, if any, stays green; add one asserting the body shape).

## Global constraints

- Branch from `main` (`625dc3bb`). Never commit to `main`. Merge `--no-ff` recording a
  pre-merge rollback SHA. Nothing pushed (local only).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **The team API key never enters the browser and never goes in the marker — it lives
  only in `CredentialStore`.** (This sub-spec strengthens that: the client stops
  carrying it entirely.)
- Dogfood data must never be at risk (`:38879` local runtime, untouched).
- No new schema/migration; no dependency changes.
- Sonnet implementers + per-task review + broad Opus review, per standing instruction.
