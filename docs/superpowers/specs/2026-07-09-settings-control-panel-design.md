# MemSmith Settings / Control Panel + Real Cost Story — Design

**What:** A server-mode **Settings/Control panel** that makes every capability knob
**visible and controllable** from the UI (Claude-style aesthetic), backed by a new
**team-scoped settings store** and a **`/v1/settings`** read/write API — plus the backend
work to make the **compression/cost savings story real** (it currently does not exist).

**Why:** Every capability MemSmith absorbed from the grab-spec (provider choice
local-vs-cloud, MemPalace tiering/compression, hybrid retrieval, supersession, quotas)
is controlled only by `MEMSMITH_*` environment variables. They are invisible and
uncontrollable in the UI, and the only visible "Settings" surface is the stale
**worker** one. The cost/compression capability in particular *records nothing* — the
dashboard `costPanel` hardcodes `distilledTokens: null` and there is no before-vs-after
measurement anywhere, so there is no savings number to show. This design surfaces and
controls the knobs, and closes the metering gap so the savings number is truthful.

## Scope

**In scope:**
- A **`SettingsResolver`** with a `user → team → env → code-default` resolution chain
  (user tier dormant until identity lands; team tier is a new Postgres table).
- A **team-scoped settings store** (`server_settings` table) written via the API.
- Refactoring the scattered `process.env.MEMSMITH_*` reads for capability knobs to read
  through the resolver, which makes several currently-BOOT knobs LIVE.
- A **`GenerationProviderHolder`** indirection so the provider (Ollama/Claude/…) can be
  **hot-swapped live** per generation job — no process restart.
- **`GET /v1/settings`** (resolved values + provenance) and **`PATCH /v1/settings`**
  (team overrides, validated, `settings:admin` scope, cloud-switch guardrails).
- **Compression metering:** record pre/post tokens as `usage_events` `kind='compression'`
  at the moment tiering compresses, and rework `costPanel` to compute a real savings story.
- A **Settings view** in the merged sidebar shell, in the locked Claude aesthetic.

**Out of scope (tracked follow-ups):**
- **User identity & auth** — the resolver's `user` tier and the `settings:admin`
  self-serve granting are seams only. No identity subsystem is built here.
- **The embedding gap** — server-mode generation not populating `embedding_vec`
  (separate investigation; unrelated to settings).
- Per-project settings (only team-level now; the row is keyed by team).

## Decisions (settled in brainstorm)

- **Aesthetic:** the **Claude look** — warm cream/ivory ground (`#f0eee6`/`#faf9f5`),
  coral/rust accent (`#cc785c`), humanist sans, soft rounded cards, generous spacing.
  (User rejected the prior warm-dark+gold; approved a Claude-style Settings mock.)
- **Scope of build:** BOTH the settings panel AND the real cost story.
- **BOOT knobs:** **persist + hot-reload** — no restart. Provider swap via a holder the
  worker reads per-job.
- **Store:** Postgres, **team-scoped**; two-level model (user + team) but **team now,
  user-ready seams** (resolution chain includes a dormant user tier).
- **Precedence:** **DB → env → code-default** (stored value wins; env still honored for
  ops/bootstrap; hardcoded default last).
- **Hot-swap mechanism:** **provider resolver indirection** — a `current()` holder read
  at the start of each job; a switch affects the next job, in-flight jobs finish on the
  provider they started with. No queue pause.
- **Switch guardrail:** **validate key + confirm** — switching to a cloud provider
  validates the API key is present; free-local → metered-cloud returns
  `confirmationRequired` the UI turns into a confirm.
- **Write authz:** a new **`settings:admin`** scope gates mutations; reads use
  `memories:read`. Local-dev loopback bypass is granted `settings:admin` (loopback +
  local-dev only, never production).
- **Savings framing:** savings = the context-injection tokens compression avoids, priced
  at `MEMSMITH_INPUT_RATE_PER_MTOK`; plus "local model = $0 generation cost" shown when
  the active provider is local. Both measured, not assumed.

## Architecture

### The settings resolution core

A new module `src/server/settings/` holds:

- **`settingKeys.ts`** — the canonical registry of every capability knob: for each, its
  key, type (`boolean|number|enum|string`), validation (enum values / numeric range),
  env-var name, code-default, and a `boot: boolean` flag (true only for knobs that still
  cannot hot-reload after this work — see "BOOT residue" below). This registry is the
  single source of truth that both the API validation and the UI rendering derive from.
- **`SettingsStore.ts`** — thin Postgres accessor over the `server_settings` table:
  `getTeamOverrides(teamId): Promise<Record<string,unknown>>` and
  `putTeamOverrides(teamId, patch): Promise<void>` (upsert-merge into the JSON column).
- **`SettingsResolver.ts`** — holds a short-TTL in-memory cache of per-team overrides
  (TTL ~2s so a PATCH is reflected near-immediately without hammering PG). Exposes typed
  getters used across the codebase. Each getter resolves
  `user(dormant) → team(store) → env → code-default`. **Never throws:** a malformed
  stored value falls through to env→default and is logged.

Resolution chain, concretely, for a boolean like `tiering`:
```
user override?  -> (no user tier yet: skip)
team override?  -> server_settings row JSON has "tiering": use it
env var set?    -> process.env.MEMSMITH_TIERING: use it
code default    -> true
```

### Knobs read through the resolver (LIVE after refactor)

These current `process.env` reads are replaced with `SettingsResolver` getters
(all become LIVE — a team override takes effect on the next operation):

| Knob | Current read (file:line) | Resolver getter |
|---|---|---|
| `tiering` | `src/server/retrieval/inject.ts:9-12` | `tieringEnabled(teamId)` |
| `searchHybrid` | `ServerV1PostgresRoutes.ts:1309` | `searchHybridEnabled(teamId)` |
| `ftsWeight`,`vecWeight` | `src/storage/postgres/observations.ts:284-285` | `weights(teamId)` |
| `supersedeMaxDepth` | `src/server/retrieval/supersession.ts` | `supersedeMaxDepth(teamId)` |
| `reformatRetries` | `ProviderObservationGenerator.ts` | `reformatRetries(teamId)` |
| `rrfK` (was module const) | `src/server/retrieval/rrf.ts:6` | `rrfK(teamId)` |
| `qualityFloor` (was module const) | `processGeneratedResponse.ts:26` | `qualityFloor(teamId)` |
| `inputRatePerMtok` | `src/server/dashboard/queries.ts:60` | `inputRatePerMtok(teamId)` |

`rrfK` and `qualityFloor` are today module-level `const`s (BOOT); refactoring them into
resolver calls makes them LIVE. `rrf.ts`'s `combineRanks(rankings, k = DEFAULT_K)` keeps
`k` as a parameter but callers pass `resolver.rrfK(teamId)`.

### The provider hot-swap

The provider is built at boot in
`src/server/runtime/create-server-service.ts:247-299`
(`buildServerGenerationProviderFromEnv` → `instantiateServerGenerationProvider`) and held
by `ActiveServerGenerationWorkerManager`. The job handler
`ProviderObservationGenerator.generateAndPersist()` calls
`this.options.provider.generate(genContext)` at
`src/server/generation/ProviderObservationGenerator.ts:235`.

Insert **`GenerationProviderHolder`** (`src/server/generation/GenerationProviderHolder.ts`):
- `current(teamId): ObservationProvider` — reads `resolver.provider(teamId)` +
  `resolver.model(teamId)`; if `(provider,model)` differs from the cached instance's key,
  lazily calls the existing `instantiateServerGenerationProvider(provider, model)` and
  caches by `(provider,model)`; returns the instance.
- The worker's `ProviderObservationGenerator` is changed so that instead of a fixed
  `options.provider`, it holds `options.providerHolder` and calls
  `this.options.providerHolder.current(teamId)` at the **start of each job**
  (in `process()` before `generateAndPersist`), passing that provider into the generate
  path. In-flight jobs keep the provider they resolved; the next job re-resolves.
- If instantiation fails (e.g., missing key), the holder keeps the last-good instance and
  the job errors clearly (the switch itself is guarded at the API — see below — so this
  is a defense-in-depth fallback, not the primary guard).

`instantiateServerGenerationProvider` is extended to accept an explicit `model` argument
(defaulting to its current env read) so the holder can build a specific `(provider,model)`.

### `/v1/settings` API

Registered in `ServerV1PostgresRoutes.setupRoutes()`
(`src/server/routes/v1/ServerV1PostgresRoutes.ts:152`).

**`GET /v1/settings`** — auth `memories:read`. Returns every knob from `settingKeys.ts`
resolved for `req.authContext.teamId`, with provenance:
```json
{ "settings": {
    "provider":  { "value": "ollama", "source": "team", "boot": false,
                   "type": "enum", "options": ["ollama","claude","gemini","openrouter"] },
    "model":     { "value": "qwen2.5:14b", "source": "env", "boot": false, "type": "string" },
    "tiering":   { "value": true, "source": "default", "boot": false, "type": "boolean" },
    "ftsWeight": { "value": 0.3, "source": "team", "boot": false, "type": "number",
                   "min": 0, "max": 1 }
    /* … every knob … */
} }
```
`source ∈ user|team|env|default`. `boot` true only for BOOT-residue knobs.

**`PATCH /v1/settings`** — auth **`settings:admin`**. Body: `{ patch: {<key>: <value>},
confirm?: boolean }`. Steps:
1. **Validate** each key against `settingKeys.ts` (unknown key → 400; enum/range/type
   violation → 400 with `field` + message; no partial write).
2. **Cloud-switch key check** — if the patch sets `provider` to a cloud provider
   (claude/gemini/openrouter), verify the corresponding key env is present and non-empty
   (`MEMSMITH_ANTHROPIC_API_KEY` etc.). Missing → 400 `MissingProviderKey`.
3. **Free→metered confirm gate** — if the patch switches provider from a local provider
   (ollama) to a cloud provider and `confirm !== true`, return
   `200 { confirmationRequired: true, message: "Switching to <provider> starts metered
   usage." }` **without writing**. Client re-sends with `confirm:true`.
4. **Write** via `SettingsStore.putTeamOverrides`. Return the new resolved settings
   (same shape as GET) so the UI updates from the response.

`ServerV1PostgresRoutes` gains `settingsResolver` and `settingsStore` in its options;
`ServerService.ts:180` is extended to construct them from the graph and pass them (and to
pass `allowLocalDevBypass` — currently omitted there — so the settings routes' bypass is
correct).

**Scope enforcement** uses the existing `hasRequiredScopes()` in
`src/server/middleware/postgres-auth.ts:177`. No scope enum exists; `settings:admin` is
just a string passed as `requiredScopes`. **Local-dev bypass** (`postgres-auth.ts:82`)
sets a synthetic `local-dev` scope; that path must also satisfy `settings:admin` — done by
having the bypass grant include `settings:admin` (or `*`) **only** under
`authMode==='local-dev' && allowLocalDevBypass && loopback` (the three existing guards).

### Compression metering + real cost story

`tierToBudget()` (`src/server/retrieval/tiering.ts:49-78`) is the deterministic
compression function: it steps observations down tiers (L3→L0) to fit a char budget and
returns `string[]`. It is called from `inject.ts:31`.

**Record at compression time.** `tierToBudget` (or its caller in `inject.ts`) computes,
per observation, the **pre** size (full L3/content) and the **post** size (the tier
actually emitted). We convert chars→tokens with a simple divisor (`Math.ceil(chars/4)` —
documented estimate, consistent with existing token estimates in the codebase) and record
one `usage_events` row `kind='compression'`, `quantity = preTokens - postTokens`,
`metadata = { preTokens, postTokens, tier, teamId, projectId }`. Recording is guarded by
the same `MEMSMITH_USAGE_METERING` check used elsewhere and is **generation/injection-safe**
(wrapped so a metering failure never breaks retrieval). `usage.ts`'s `UsageKind` is already
open-ended (`(string & {})`), so `'compression'` needs no schema change; `record()` is
`{ teamId, projectId?, kind, quantity?, metadata? }` (`src/storage/postgres/usage.ts:16`).

**Rework `costPanel`** (`src/server/dashboard/queries.ts:55-62`) to return the real story:
```ts
{
  savedTokens: number,        // SUM(quantity) WHERE kind='compression'
  preTokens: number,          // SUM(metadata->>'preTokens')
  pctSmaller: number,         // savedTokens / preTokens (0 if preTokens==0)
  estUsdSaved: number,        // savedTokens/1e6 * inputRatePerMtok(teamId)
  activeProvider: string,     // resolver.provider(teamId)
  localGeneration: boolean,   // activeProvider is local (ollama) => $0 generation cost
  discoveryTokens: number     // retained for back-compat with existing dashboard
}
```
`inputRatePerMtok` now comes from the resolver. `distilledTokens: null` is removed.

### The Settings view (UI)

New view in the merged sidebar shell (`src/ui/viewer/`), added to the existing
`Sidebar` nav (Observations · Dashboard · **Settings**) and `viewState`. Built in the
locked Claude aesthetic. Files:
- `src/ui/viewer/views/SettingsView.tsx` — grouped cards:
  - **Generation model** — Ollama·local vs Claude·cloud selector + model; coral border on
    active; free→metered switch shows the confirm dialog; missing-key switch blocks with
    an inline message.
  - **Retrieval** — coral toggles (hybrid search, compression/tiering); number inputs for
    FTS/VEC weights and supersede depth; each with a one-line plain-English description.
  - **Generation quality** — quality floor, reformat retries.
  - **Limits** — monthly token/request caps, rate limit; any `boot:true` knob renders with
    an "applies after restart" note.
  - **Compression savings strip** — the real explained number from `costPanel`.
- `src/ui/viewer/utils/settingsData.ts` — `fetchSettings()` / `patchSettings(patch,
  confirm?)` calling `/v1/settings` (alongside existing `serverData.ts`).
- Each control renders a subtle provenance tag (`env`/`team`/`default`). A change PATCHes
  and updates from the response (the server returns resolved settings). The
  `confirmationRequired` response drives a confirm dialog; a `MissingProviderKey` 400
  drives an inline error on the provider card.

The panel is driven by the `settingKeys.ts` registry shape delivered by GET, so adding a
knob later is a registry edit, not a UI rewrite.

### BOOT residue (honest limitation)

After this work the only knobs that still cannot hot-reload are the **quota / rate-limit
middleware** (`MEMSMITH_MONTHLY_TOKEN_CAP`, `MEMSMITH_MONTHLY_REQUEST_CAP`,
`MEMSMITH_RATE_LIMIT_PER_MIN`) — they are wired into the Express middleware chain at
`setupRoutes()` time (`ServerV1PostgresRoutes.ts:177-186`). These are flagged `boot:true`
in the registry and the UI shows "applies after restart". Making them live would require
reworking the middleware to read the resolver per-request; **out of scope** here (YAGNI —
caps change rarely). `MEMSMITH_GENERATION_DISABLED` is likewise boot (chooses the worker
manager class) and flagged `boot:true`.

## Data flow

**Read a knob (e.g. hybrid search during a query):**
`resolveSearchResults` → `resolver.searchHybridEnabled(teamId)` → resolver cache →
(miss) `SettingsStore.getTeamOverrides` → merge team/env/default → boolean.

**Change a knob:** Settings view → `patchSettings` → `PATCH /v1/settings` (validate →
guard → `SettingsStore.putTeamOverrides`) → returns resolved settings → UI updates →
resolver cache expires within TTL → next operation reads the new value.

**Provider switch:** as above, plus the next generation job's
`providerHolder.current(teamId)` sees the changed provider and builds/returns it.

**Cost story:** injection runs `tierToBudget` → records `kind='compression'` events →
`GET /dashboard/cost` → `costPanel` aggregates → savings strip.

## Error handling

- **Resolver never throws** — malformed stored value → fall through to env→default,
  logged. A PG error in the store getter → treat as no-override (env→default), logged.
- **PATCH** — validation failures return 400 with field-level messages and write nothing.
  Missing provider key → 400 `MissingProviderKey`. Free→metered without confirm → 200
  `confirmationRequired` (no write).
- **Provider holder** — instantiation failure keeps last-good provider; job errors
  clearly. (Primary guard is the API key check; this is defense-in-depth.)
- **Compression metering** — wrapped; a failure logs and never breaks
  retrieval/injection. `pctSmaller` guards divide-by-zero.
- **Scope** — non-`settings:admin` PATCH → 403 (existing middleware). Local-dev bypass
  grants it only on loopback + local-dev.

## Testing

- **Resolver precedence** (pure/PG): team over env over default; malformed value degrades;
  dormant user tier skipped; cache TTL reflects a write.
- **settingKeys registry** — every knob has type+validation+env+default+boot; enum/range
  validators accept/reject correctly.
- **`GET /v1/settings`** (PG-gated :55432) — returns all knobs with correct `source` and
  `boot`; scoped to the key's team.
- **`PATCH /v1/settings`** (PG-gated) — valid write persists + returns resolved; unknown
  key/out-of-range → 400 no write; cloud switch with missing key → 400 `MissingProviderKey`;
  ollama→claude without confirm → `confirmationRequired` no write; with confirm → writes;
  non-`settings:admin` → 403; local-dev loopback bypass → allowed.
- **`GenerationProviderHolder`** — `current` builds once and caches by `(provider,model)`;
  a changed setting yields a new instance on next call; instantiation failure keeps
  last-good.
- **Compression metering** (PG-gated) — an injection that compresses records a
  `kind='compression'` event with correct pre/post; metering failure doesn't break
  injection.
- **`costPanel`** (PG-gated) — savings math: `savedTokens`, `pctSmaller` (incl. zero-pre
  guard), `estUsdSaved` at the resolved rate, `localGeneration` reflects provider.
- **`SettingsView`** (viewer) — renders knobs from a GET payload with provenance tags;
  toggling PATCHes the right body; `confirmationRequired` shows the confirm; missing-key
  400 shows the inline error; boot knob shows "applies after restart".
- **Regression** — existing retrieval/generation/dashboard tests stay green after the
  env-read → resolver refactor.

## Global constraints

- Server-mode `/v1/*` and `/dashboard/*` only; no worker `/api/*` dependency.
- **Claude aesthetic**: cream ground `#f0eee6`/`#faf9f5`, coral accent `#cc785c`,
  humanist sans, soft rounded cards (radius ~11px), generous spacing. No warm-dark+gold.
- Resolver + metering **never crash** a read/injection/generation; degrade gracefully.
- Precedence is **DB → env → code-default**, always.
- `settings:admin` gates all mutations. Local-dev `settings:admin` grant is
  **loopback + local-dev only, NEVER production** (same rule as `MEMSMITH_LOCAL_DEV_TEAM_ID`).
- Schema change goes in `bootstrapServerPostgresSchema()` in
  `src/storage/postgres/schema.ts` with `SERVER_POSTGRES_SCHEMA_VERSION` bumped 3→4, plus a
  reference `src/storage/postgres/migrations/004_server_settings.sql`.
- `usage_events` `kind='compression'` needs no schema change (open-ended `UsageKind`); use
  the actual `record({teamId,projectId?,kind,quantity?,metadata?})` signature.
- Cloud-provider switch requires a validated key and (from local) an explicit confirm.
- User-identity tier is a seam only — no identity subsystem built here.
