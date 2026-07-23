# Per-Project Runtime Resolution — Design

**Status:** Design (2026-07-23). Branches from `main` @ `b2b57673`. First of two sequenced sub-specs for the "project-scoped Go Team" fix (finding #5). This sub-spec makes runtime mode (`local` vs `server`) resolvable **per project** so that, on one machine, a project that has gone team resolves to the team/server runtime while sibling projects stay local. Sub-spec 2 (scoped convert) builds on this and is brainstormed separately after this ships.

---

## Motivation

Live team-mode validation surfaced that **runtime mode is a machine-global switch, not per-project.** `selectRuntime()` (`src/services/hooks/runtime-selector.ts:54`) reads `MEMSMITH_RUNTIME` from the global `~/.memsmith/settings.json` and is **cwd-blind** — it consults the project cwd only for the *identity* marker, never for the *runtime mode*. The Go Team flip (`writeServerModeSettings`) writes that same global settings file.

Consequence: with projects A and B sharing one machine's runtime, "Go Team on B" flips the **whole machine** to server mode — A is dragged onto the team server too. The correct, expected behavior (the user's mental model) is: **Go Team on B converts only B; B runs in team mode; A stays local — same machine.** That requires per-project runtime resolution, which does not exist today. This sub-spec builds it.

## The model (target behavior)

- A project's runtime mode is recorded in its **own per-project marker** (`.memsmith/project.json`), which is already cwd-keyed and holds the project's identity.
- `selectRuntime(cwd)` reads that marker first: if it says `server`, the project runs against its recorded team server; otherwise it falls back to the global `MEMSMITH_RUNTIME` (default `local`).
- Going team flips the **project marker**, not the global settings file.
- Result: B's marker says `server` → B is team; A has no server marker → A stays local. Both on one machine.

## Scope

**In:**
- Extend the `.memsmith/project.json` marker to optionally record: `runtime` (`'local' | 'server'`), `serverUrl` (team server base URL). The **API key is NOT stored in the marker** — it stays in the existing `CredentialStore` (`~/.memsmith/credentials.json`), resolved by `teamId`.
- Make `selectRuntime` cwd/marker-aware: `selectRuntime(cwd?)` reads the project marker; `runtime==='server'` → server, else fall back to global `MEMSMITH_RUNTIME`.
- Update the callers of `selectRuntime()` to pass the project cwd. **Caller caveat:** the cwd-bearing hook paths (`session-init.ts`, `summarize.ts`, `observation.ts` — each receives the hook `input.cwd`) pass it and get true per-project resolution. The **long-lived MCP server** (`mcp-server.ts:76,768`) calls `selectRuntime()` with no meaningful per-request cwd — it resolves runtime once at its launch context. That is acceptable for this sub-spec: the MCP server keeps process-level runtime (resolved at launch cwd, defaulting to global), and the per-project win applies to the hook paths that actually carry a project cwd. Making the MCP server per-call-cwd-aware is out of scope (it would require threading cwd through every tool call — a separate concern).
- Point the Go Team flip at the **project marker** (write `runtime:'server'` + `serverUrl` + ensure the key is in `CredentialStore` keyed by `teamId`), instead of the global `settings.json`.
- Tests: marker read/write round-trip incl. the new fields; `selectRuntime` resolution matrix (marker server / marker local / marker absent / marker present-but-no-runtime-field, × global setting); back-compat (no runtime field → behaves as today); the flip writes the marker not global settings.

**Out (explicitly):**
- **The scoped convert copy** (copy only B's rows) — that is sub-spec 2. This sub-spec only changes *where the runtime decision lives* and *what the flip writes*; it does NOT change *what data the convert copies* (that stays whole-store until sub-spec 2). NOTE: until sub-spec 2 lands, the copy is still whole-store — this sub-spec is shipped as the foundation, and the combined correct behavior is only complete after sub-spec 2. This is called out so the interim state isn't mistaken for the finished feature.
- Storing secrets in the marker (never — key stays in `CredentialStore`).
- Any change to the dashboard scope model (already per-identity, unaffected).

## Global Constraints

- **Never commit to `main`;** branch `per-project-runtime`. `--no-ff` merge recording pre-merge rollback SHA `b2b57673`. Nothing pushed.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Secret never in the marker.** The team API key lives only in `CredentialStore` (`~/.memsmith/credentials.json`), keyed by `teamId`; the marker holds `teamId` + `serverUrl` (non-secret references). `.memsmith/` is gitignored, but we do NOT rely on that for the secret — it simply never goes in the marker.
- **Back-compat is mandatory.** Existing setups (dogfood + others) have a global `MEMSMITH_RUNTIME` and markers WITHOUT a `runtime` field. They MUST resolve exactly as today (marker has no `runtime` → fall through to global). The default path is byte-behavior-identical for any project that hasn't gone team.
- **Dogfood safe.** The dogfood is `local` with a marker that has no `runtime` field → must keep resolving `local` unchanged.
- **Reuse, don't rebuild.** Extend the existing marker (`readMarker`/`writeMarker`/`readMarkerFor`), the existing `CredentialStore` (`storeKeyForTeam`/`resolveKeyForTeam`), and the existing `selectRuntime`/`buildServerContext` seam (which already takes `cwd`).

---

## Architecture

```
SessionStart / hook (has cwd)
   │
   ▼
selectRuntime(cwd)                      ← NOW cwd-aware
   │   marker = readProjectMarker(cwd)
   │   if marker?.runtime === 'server'  → 'server'   (this project is team)
   │   else                             → normalizeRuntime(globalSettings.MEMSMITH_RUNTIME)  (default 'local')
   ▼
server runtime (per marker.serverUrl + CredentialStore.resolveKeyForTeam(marker.teamId))
   OR local runtime (embedded PG, shared)

Go Team flip (convert-service):
   writeProjectRuntime(cwd, { runtime:'server', serverUrl })   ← marker, NOT global settings
   + CredentialStore.storeKeyForTeam(teamId, key)              (key already there post-bootstrap)
```

## Components

### 1. Extended marker (`src/services/identity/project-identity.ts`)
```ts
interface ProjectMarker {
  projectId: string;
  teamId: string;
  note: string;
  runtime?: 'local' | 'server';   // NEW — absent = legacy/local (back-compat)
  serverUrl?: string;             // NEW — team server base URL when runtime==='server'
}
```
- `readMarker`/`readMarkerFor` return the new optional fields when present (tolerate absence).
- A new `writeProjectRuntime(cwd, { runtime, serverUrl })` merges the runtime fields into the existing marker (preserving `projectId`/`teamId`/`note`) — used by the flip. Never writes a key.

### 2. `selectRuntime` becomes cwd-aware (`src/services/hooks/runtime-selector.ts`)
```ts
export function selectRuntime(cwd: string = process.cwd()): SelectedRuntime {
  const marker = readMarkerFor(cwd);            // already exists; extend to read `runtime`
  if (marker?.runtime === 'server') return 'server';
  const settings = loadFromFileOnce();
  return normalizeRuntime(settings.MEMSMITH_RUNTIME);   // default 'local'
}
```
- `readMarkerFor` (already in this file, line ~68) is extended to also return `runtime`/`serverUrl`.
- Callers of `selectRuntime()` are updated to pass the hook/session `cwd` (they already have it — the SessionStart handler receives `input.cwd`). A no-arg call defaults to `process.cwd()` for safety.
- `buildServerContext(cwd)` already reads the marker; extend it to prefer the marker's `serverUrl` (falling back to the existing global `MEMSMITH_SERVER_URL` resolution) and to resolve the key via `CredentialStore.resolveKeyForTeam(marker.teamId)`.

### 3. Flip writes the marker (`src/server/convert/settings-writer.ts` + convert wiring)
- Add `writeProjectRuntime(cwd, {...})` usage in the flip path: on Go Team, write `runtime:'server'` + `serverUrl` into the converting project's marker, and ensure the team key is in `CredentialStore` (keyed by `teamId`).
- The legacy `writeServerModeSettings` (global settings write) is retained for now for any explicit machine-global opt-in, but the Go Team wizard flip uses the per-project marker path. (Sub-spec 2 finalizes the convert wiring; this sub-spec establishes the marker-write mechanism + selectRuntime honoring it.)

## Data Flow

| Situation | `selectRuntime(cwd)` result |
|---|---|
| Project B marker `runtime:'server'` | `server` (B → team, via marker serverUrl + CredentialStore key) |
| Project A marker no `runtime` field | falls back to global `MEMSMITH_RUNTIME` → `local` |
| Any project, global `MEMSMITH_RUNTIME=local`, no marker runtime | `local` (unchanged, back-compat) |
| Legacy global `MEMSMITH_RUNTIME=server`, marker no runtime | `server` (unchanged — existing global-server setups keep working) |
| Marker `runtime:'local'` explicitly | `local` (fall through to global, which defaults local) |

## Error Handling & Failure Modes

| Situation | Behavior |
|---|---|
| Marker missing / unreadable / corrupt | Treat as no marker → fall back to global setting (never throw; matches current fail-safe) |
| Marker `runtime:'server'` but `serverUrl` empty/missing | Fail-safe: treat as not-server → fall back to global (don't half-start a server with no URL); log a warning |
| Marker `runtime:'server'` but no key in CredentialStore for teamId | `buildServerContext` returns null (existing "server not reachable" path) → handlers degrade as today; log |
| Key would be written to marker | Never happens — design forbids it (key only in CredentialStore) |

**Invariants:**
- A project with no `runtime` field in its marker resolves exactly as before this change (back-compat).
- The team API key never appears in `.memsmith/project.json`.
- One machine can simultaneously have project B → server and project A → local.

## Testing

1. **Marker round-trip** (`project-identity` test): write a marker with `runtime:'server'`+`serverUrl`, read it back; write via `writeProjectRuntime` and confirm it merges (preserves projectId/teamId/note, adds runtime fields); confirm no key field is ever written.
2. **`selectRuntime` resolution matrix** (`runtime-selector` test): marker server → 'server'; marker local → global; marker absent → global; marker present without `runtime` → global; × global setting local/server. Assert the table above.
3. **Back-compat**: a marker without `runtime` + global `MEMSMITH_RUNTIME=local` → `local` (byte-identical to today). A legacy global `MEMSMITH_RUNTIME=server` + no marker runtime → `server`.
4. **Secret safety**: assert the marker JSON written by `writeProjectRuntime` contains `teamId`/`serverUrl`/`runtime` but NO key/secret field (explicit negative assertion).
5. **buildServerContext prefers marker serverUrl + resolves key by teamId** (unit, with a stub CredentialStore).
6. **Two-project isolation (integration-style)**: given two cwds — A (no runtime marker) and B (runtime:'server') — `selectRuntime(A)`='local', `selectRuntime(B)`='server'. Proves the core goal.
7. **Gate**: `bunx tsc --noEmit` clean; touched tests green; broader suite's known 5 `:55432` env failures unchanged.

## Acceptance Criteria

1. `.memsmith/project.json` marker supports optional `runtime`/`serverUrl`; `writeProjectRuntime` merges them without disturbing identity fields and never writes a key.
2. `selectRuntime(cwd)` resolves per the matrix: marker `server` → server; otherwise global (default local). The cwd-bearing hook callers (session-init, summarize, observation) pass their `input.cwd`; the long-lived MCP server keeps its process-level (launch-cwd/global) resolution by design; no-arg defaults to `process.cwd()`.
3. Back-compat proven: any project without a `runtime` marker field resolves exactly as today (incl. the dogfood staying `local` and legacy global-server setups staying server).
4. The team API key is never stored in the marker; it stays in `CredentialStore` keyed by `teamId`, resolved at runtime.
5. Two projects on one machine resolve independently (A local, B server), proven by test.
6. The Go Team flip writes the project marker (`runtime:'server'`+`serverUrl`) + ensures the key in `CredentialStore`, not the global settings file.
7. `src` typecheck clean; touched tests green; branch; `--no-ff` merge w/ rollback SHA; nothing pushed.

## Deferred (sub-spec 2 + later)
- **Scoped convert copy** (copy only the current project's rows, re-stamped to the target team, skip team-account tables, scoped verify) — sub-spec 2, decisions sketched (mem `9348b8c9`).
- Then **P3** (manual wizard e2e) becomes trivial: temp project shares the dogfood runtime, Go Team scopes to it + flips only its marker.
- Better-auth login wiring (finding #2) and OIDC/Cognito — unchanged, later.
