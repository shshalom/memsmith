# MemSmith Local Project Identity — Design

**Goal:** Give every project a durable memory identity (team_id + project_id + a real base key) born at session-init, so local mode holds a real API key — fixing local read-back (GAP-A) — and every project is ready to be *promoted* to team mode later without a re-key or data migration.

**This is the front edge of the identity system (subsystem #3), scoped thin.** It builds only the birth of identity + wiring the key into the existing client gate. It does NOT build the team/user layer.

## Why (the reframe)

GAP-A was originally slated for a keyless local-dev bypass in `buildServerContext`. The user reframed it: rather than teach the client to *skip* the key on loopback, make local mode *hold a real key* like team mode does. That turns the key into the **seam** for local→team and the foundation of the identity system, instead of a patch that entrenches a two-auth-path model we'd later delete.

## Mental model (agreed)

- **The key is a per-team *capability*** — the credential that grants access to a team's memory. It is the seam: born at local first-boot, unchanged through local→team.
- **The key is scoped to `team_id`, not `(team_id, project_id)`** — so one key spans a team's many projects (matches "add a user to the team → they get context across projects"; avoids N-keys-per-person).
- **`project_id` is the isolation boundary** between memories (`WHERE project_id = ?`), already enforced. Not the key's job.
- **Users are a layer added on top of the base key when you go team** — granted/revoked at the team level. Raw-key-sharing is the degenerate one-user form; the real model attaches users under the key (this is what makes offboarding work). **The user layer is subsystem #3, DEFERRED.**

```
[team_id]  base key ──┬─ project_id X   (isolation)
                      ├─ project_id Y
                      └─ Users: A, B, C  (LATER — team-line)
```

- **local→team is a PROMOTION, not a migration**: rename/attach the team the project already carries, move rows to a shared PG, keep the key. No re-key.

## Architecture — three artifacts + a resolver seam

| Artifact | Form / where | Secret? |
|---|---|---|
| **team_id** | generated uuid; PG `teams` row | no |
| **project_id** | generated uuid; PG `projects` row + in-repo marker | no |
| **base key** | **hash** in PG `api_keys` (server validation, non-recoverable); **plaintext** in `~/.memsmith/credentials.json` (0600), keyed by team_id | **yes — never in the repo** |
| **recognition marker** | `.memsmith/project.json` (committed) | no |

**The marker** `.memsmith/project.json`:
```json
{
  "projectId": "<uuid>",
  "teamId": "<uuid>",
  "note": "Non-secret MemSmith identity pointer. The access key lives in ~/.memsmith, never here."
}
```

**Retrieval seam:** `resolveKeyForTeam(teamId) → plaintext | null`. Local implementation reads `credentials.json`. **AWS Secrets Manager is a later implementation of this same interface** (team-line) — no redesign of `buildServerContext` or the identity model when it lands. AWS is a future backing of the seam, not a reason to change the seam now.

**Key exists in two forms:** the hash (PG, for validation) and the plaintext (shown once at generation → cached in `credentials.json` so the client can send it in the `Authorization` header). The repo gets neither.

**Access enforcement — honest current state:** today, key-possession = access (no user layer yet). The identity system (subsystem #3) later makes access = *membership under the key*, so a known key without membership grants nothing and revoking membership offboards someone without rotating the key. This spec births the key and caches the plaintext; it does NOT build the membership gate.

## Components

Five focused units:

### 1. `ProjectIdentity` — `src/services/identity/project-identity.ts` (new)
- `ensureProjectIdentity(cwd): Promise<{ teamId: string; projectId: string }>`
  - If `<cwd>/.memsmith/project.json` exists → read `{projectId, teamId}` → project RECOGNIZED (existing). Return them.
  - Else → generate `teamId` + `projectId` (uuid v4), upsert PG `teams(id,name)` and `projects(id,team_id)` rows (idempotent `ON CONFLICT DO NOTHING`), write the marker, return them.
  - Idempotent: safe to call every session-init.
- Depends on: a PG pool (from the running local runtime), `crypto.randomUUID`, fs.

### 2. `CredentialStore` — `src/services/identity/credential-store.ts` (new)
- `resolveKeyForTeam(teamId: string): string | null` — read `~/.memsmith/credentials.json`, return the plaintext key for `teamId` or null.
- `storeKeyForTeam(teamId: string, key: string): void` — write/merge into `credentials.json`, `chmod 0600`.
- File shape: `{ "keys": { "<teamId>": "<plaintext>" } }`.
- This is the resolver seam AWS later re-implements.

### 3. `ensureBaseKey` — in `src/services/identity/project-identity.ts` (co-located)
- `ensureBaseKey(teamId: string): Promise<string>`
  - If `CredentialStore.resolveKeyForTeam(teamId)` returns a key → return it.
  - Else → generate a key against `api_keys` scoped to `teamId` using the EXISTING better-auth machinery (`src/server/auth/auth.ts` apiKey plugin; the same path `createServerApiKey`/`bootstrapAndPersistServerApiKey` uses in `install.ts`), `CredentialStore.storeKeyForTeam(teamId, plaintext)`, return plaintext.
- Reuses existing key-generation; does not reinvent hashing/storage.

### 4. session-init wiring — the trigger
- The per-project `SessionStart → session-init` hook (`plugin/hooks/hooks.json`, the `hook claude-code session-init` command) calls, after the runtime is up:
  `const {teamId, projectId} = await ensureProjectIdentity(cwd); await ensureBaseKey(teamId);`
- Mint-if-absent; idempotent. This is "the appropriate place" — fires per project with cwd, before capture.

### 5. `buildServerContext` change — `src/services/hooks/runtime-selector.ts`
- Resolve `{teamId, projectId}` for the current cwd (via the marker / ProjectIdentity), call `resolveKeyForTeam(teamId)`, build the server context with that key and projectId.
- Replaces the `if (!apiKey) return null` local-mode bail: in local mode the key now comes from `credentials.json`, so context builds and injection + MCP recall work.
- The server-side keyless loopback bypass (`postgres-auth.ts:87-108`) REMAINS as a fallback but is no longer the path local relies on.

### 6. Settings-view identity surface (read-only)
- A read-only panel in the existing Settings view showing the CURRENT project's identity: `team_id`, `project_id`, and the base key **masked by default with a reveal toggle** (e.g. `msk_••••••••1234` → click to reveal). No edit, no rotate, no regenerate in this spec — display only.
- **Data path:** a small server endpoint (reuse the existing dashboard/settings server, e.g. a `GET /identity` or an addition to the settings data the view already fetches) that returns `{ teamId, projectId, keyPresent, keyMasked, keyPlaintext? }` for the running project. The plaintext is only served to the local loopback UI (same trust boundary as the rest of the local dashboard) and only on explicit reveal.
- **Why here:** the user explicitly wants to *see* the minted identity. This is the minimal visibility surface; the full Identity view (join, users, grant/revoke) is still subsystem #3.
- Files: the settings server route (`src/server/routes/v1/settingsRoutes.ts` or the dashboard settings data source) + the Settings view component (`src/ui/viewer/views/SettingsView.tsx` or equivalent). Follow the existing Settings-view card + fetch pattern; do not restyle.

## One-time dogfood seed (this project)

This project has existing data that must land under its new durable identity. A one-off, idempotent seed script (`scripts/seed-dogfood-identity.ts`, run manually once, not part of the plugin runtime):

1. **Mint** the dogfood project's durable `teamId`+`projectId` (uuid) + first base key (via components above); write `.memsmith/project.json` in this repo; store the key in `credentials.json`.
2. **Re-scope** the 2790 existing rows: `UPDATE observations SET team_id=$new, project_id=$new WHERE team_id='local' AND project_id='local'` (+ the `teams`/`projects` rows). Back up the PG data dir first. Low risk — one uniform bucket.
3. **Import the claude-mem delta**: read `~/.claude-mem/claude-mem.db` (`/usr/bin/sqlite3`), select `observations WHERE project='team-agent-memory'` (2786 rows, through 22:32 today — the session work MemSmith couldn't read back), insert into the dogfood scope, **dedup on `content_hash`** so overlap with the re-scoped 2790 isn't doubled. Precedent: `firstRunImport.ts` / `sqliteReader.ts`.

Verified data ground truth (2026-07-13): MemSmith PG = 2790 obs `local/local`, 0 api_keys; claude-mem = 2786 obs `team-agent-memory` through 22:32. Overlap dedupable via `content_hash`.

**PG access for the seed:** embedded psql at `~/.memsmith/pg-binaries/bin/psql` needs `DYLD_LIBRARY_PATH=~/.memsmith/pg-binaries/lib`. Conn: `postgresql://memsmith:memsmith-local@127.0.0.1:55433/postgres`.

## Data flow (session-init, idempotent)

```
session-init (per project, has cwd)
  ├─ ensureProjectIdentity(cwd)
  │     ├─ marker exists → recognize {teamId, projectId}
  │     └─ absent → mint uuids, upsert PG rows, write marker
  ├─ ensureBaseKey(teamId)
  │     ├─ credentials.json has key → use it
  │     └─ absent → generate via better-auth, hash→PG, plaintext→credentials.json
  └─ buildServerContext resolves {serverUrl, key, projectId} → injection + MCP recall work
```

## Error handling

- **No PG pool available at session-init** (runtime not up yet): identity minting requires the DB. If the runtime isn't ready, skip minting this invocation and log once (the next session-init retries) — never crash the hook. Mirrors the existing non-fatal first-run-import pattern.
- **Marker present but PG rows missing** (e.g. fresh DB, committed marker from a clone): re-upsert the PG rows from the marker's ids (recognition drives PG state, idempotent). This is the clone case.
- **credentials.json unreadable / key missing but marker present**: treat as "no key for this team" → in local mode, fall back to the server-side keyless bypass (still present) so recall degrades gracefully rather than breaking; log once. (Team mode would error, as today.)
- **Key generation failure**: log, return null from ensureBaseKey; buildServerContext falls back to the keyless bypass for local. Non-fatal.
- **Seed script**: back up PG data dir before re-scope; dedup import is idempotent (re-runnable); abort loudly on any row-count mismatch after re-scope.

## Testing

- **ProjectIdentity**: mint-when-absent writes marker + upserts rows; recognize-when-present returns marker ids without minting; idempotent across repeated calls (no duplicate rows). Clone case: marker present, PG empty → rows re-upserted.
- **CredentialStore**: store→resolve round-trips; file is 0600; resolve returns null for unknown team; multiple teams coexist in the file.
- **ensureBaseKey**: generates when absent (key appears in api_keys + credentials.json), returns cached when present, no duplicate keys on repeat.
- **buildServerContext**: in local mode with a stored key → builds a context with that key + projectId (no longer returns null); with no key → falls back to keyless bypass path. A test proving local injection returns real content through the resolved key (the GAP-A regression guard).
- **Settings identity surface**: the endpoint returns `{teamId, projectId, keyPresent, keyMasked}` for the running project; plaintext only on explicit reveal; masked value never exposes more than the last 4 chars by default. A view test that the panel renders the ids + masked key and reveal toggles to plaintext.
- **Seed script**: on a fixture DB, re-scope moves all `local/local` rows to new ids; claude-mem import dedups by content_hash (no doubles); backup created. (Run against a copy, not live, in tests.)
- tsc clean; full suite no new failures beyond the known pre-existing set.

## Acceptance criteria

1. A fresh project's first session-init mints `{teamId, projectId}`, writes `.memsmith/project.json`, generates a base key (hash in PG, plaintext in `credentials.json` 0600), and recall works.
2. A second session-init on the same project recognizes the marker and mints nothing new.
3. `buildServerContext` in local mode resolves the stored key and returns a usable context — local injection + MCP recall return real content (GAP-A closed via a real key, not the bypass).
4. `credentials.json` is 0600 and the base key never appears in the repo or any committed file.
5. The dogfood project is seeded: durable identity minted, 2790 rows re-scoped, claude-mem delta imported+deduped; its MemSmith memory is whole through the seed time and recallable.
6. The key-retrieval path is behind `resolveKeyForTeam` so an AWS Secrets Manager implementation can replace the file backing without touching `buildServerContext`.
7. The Settings view shows the current project's team_id, project_id, and base key (masked, with reveal) — read-only. The user can SEE the minted identity.

## Explicitly deferred (subsystem #3 — the team-line, NOT this spec)

- Team generation, team accounts, membership.
- The user layer: attaching users under a base key; grant/revoke; offboarding enforcement.
- local→team promotion mechanics; memory sync to a shared PG.
- Dashboard identity/join UI (the *full* Identity view: join flow, user management, grant/revoke). NOTE: a read-only key/identity *display* in Settings IS in this spec (component 6); only the interactive identity management is deferred.
- AWS Secrets Manager backing of `resolveKeyForTeam`.
- Per-project access limits within a team.
