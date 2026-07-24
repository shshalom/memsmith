# Wizard Convert Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /v1/convert/migrate` resolve `cwd`/`projectId`/`teamId`/`serverUrl`/`apiKey` server-side so the browser wizard posts only `{ databaseUrl }` and the team secret never enters the browser.

**Architecture:** Introduce a `resolveConvertContext(databaseUrl)` dependency on `ConvertRoutes`. The route reads `databaseUrl` from the body and `ownerUserId` from `authContext`, calls the resolver to get `{ cwd, teamId, projectId, serverUrl, apiKey }` (or an error), and forwards the assembled input to the existing `convert` dep. Production composes the resolver from `readLocalScopeFromMarkerOrEnv`, a `serverUrl` derivation, `CredentialStore`, and `ensureBaseKey` (minting against a freshly-built + bootstrapped remote pool). Sub-spec 2's scoped copy is untouched — it still receives a real `projectId`/`teamId`.

**Tech Stack:** TypeScript, Express, node-postgres (`pg`), `bun test`.

## Global Constraints

- Branch from `main` (`625dc3bb`); already on branch `wizard-convert-wiring`. Never commit to `main`. Merge `--no-ff` recording a pre-merge rollback SHA. Nothing pushed (local only).
- Every commit ends with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- The team API key NEVER enters the browser and NEVER goes in the marker — only `CredentialStore`. This plan removes the client's ability to carry it.
- Dogfood data must never be at risk (`:38879` local runtime — tests use fakes / disposable pools only).
- No new schema/migration; no dependency changes.
- `teamId`/`projectId` for the copy come from the LOCAL marker scope (the project being converted), NOT from `authContext`. `ownerUserId` still comes from `authContext`.
- The mint (`ensureBaseKey`) must run AFTER the remote schema is bootstrapped (the `api_keys` table must exist) and BEFORE the flip. The resolver owns this ordering by building + bootstrapping its own remote pool.
- Existing sub-spec 2 behavior (scoped copy, `convert-scope.ts`, `buildConvertCopyDeps`) is unchanged.

## Existing primitives to reuse (do NOT reimplement)

- `readLocalScopeFromMarkerOrEnv(cwd): { teamId; projectId } | null` — `src/server/runtime/resolve-local-scope.ts`.
- `ensureBaseKey(pool, teamId, projectId, store): Promise<string>` — `src/services/identity/project-identity.ts`. Idempotent: returns cached key or mints (inserts `api_keys` hash row + caches plaintext in `CredentialStore`). Requires the `api_keys` table to exist on `pool`.
- `CredentialStore` (`resolveKeyForTeam`/`storeKeyForTeam`) — `src/services/identity/credential-store.ts`.
- `parsePostgresConfig` / `createPostgresPool` / `bootstrapServerPostgresSchema` — already imported in `ServerV1PostgresRoutes.ts`.

---

## Pre-Flight Note (regression the plan must handle)

`tests/server/routes/v1/convert-routes.test.ts` currently sends `cwd`/`serverUrl`/
`apiKey`/`projectId` in the migrate body and asserts specific 400s for missing `cwd`,
etc. Task 2 removes those body reads and their 400s, so those assertions must be
reconciled in the same task: the happy-path bodies drop to `{ databaseUrl }` (with a
fake resolver injected), and the missing-field 400 assertions are replaced by (a)
`databaseUrl required` and (b) the new D4 "no local project identity" 400.

---

## File Structure

- `src/server/convert/convert-context.ts` — NEW: `deriveServerUrl(databaseUrl)` + the composed `makeResolveConvertContext(...)` factory (pure/injectable seams) (Task 1).
- `src/server/routes/v1/ConvertRoutes.ts` — migrate route reads only `databaseUrl`, calls `resolveConvertContext`, handles the error branch, forwards assembled input (Task 2).
- `src/server/routes/v1/ServerV1PostgresRoutes.ts` — wire the production `resolveConvertContext` into `registerConvertRoutes` (Task 3).
- Tests: `tests/server/convert/convert-context.test.ts` (Task 1), `tests/server/routes/v1/convert-routes.test.ts` (Task 2), `tests/server/convert/convert-context-integration.test.ts` (Task 3, self-skipping).

---

## Task 1: convert-context module (serverUrl derivation + resolver factory)

**Files:**
- Create: `src/server/convert/convert-context.ts`
- Test: `tests/server/convert/convert-context.test.ts`

**Interfaces:**
- Produces:
  - `deriveServerUrl(databaseUrl: string, existingServerUrl?: string): string`
  - `type ConvertContext = { cwd: string; teamId: string; projectId: string; serverUrl: string; apiKey: string }`
  - `type ResolveConvertContext = (databaseUrl: string) => Promise<ConvertContext | { error: string }>`
  - `makeResolveConvertContext(deps): ResolveConvertContext` where
    `deps = { cwd: string; readScope: (cwd: string) => { teamId: string; projectId: string } | null; resolveKey: (teamId: string) => string | null; mintKey: (teamId: string, projectId: string, databaseUrl: string) => Promise<string>; existingServerUrl?: (cwd: string) => string | undefined }`.
    `mintKey` takes `databaseUrl` (3rd arg) so the production mint can build a pool to the destination; the resolver already has `databaseUrl` and passes it through.

**serverUrl derivation rule (fixed):** parse `databaseUrl` as a URL; `serverUrl` =
`http://<host>:38879` when the db host is `localhost`/`127.0.0.1`, else
`https://<host>` (no port). If `existingServerUrl(cwd)` returns a non-empty string, it
takes precedence. If `databaseUrl` is unparseable, throw (surfaces as convert error).

- [ ] **Step 1: Write failing tests**

Create `tests/server/convert/convert-context.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { deriveServerUrl, makeResolveConvertContext } from '../../../src/server/convert/convert-context.js';

describe('deriveServerUrl', () => {
  it('local host → http + 38879', () => {
    expect(deriveServerUrl('postgres://u:p@localhost:5432/db')).toBe('http://localhost:38879');
    expect(deriveServerUrl('postgres://u:p@127.0.0.1:5432/db')).toBe('http://127.0.0.1:38879');
  });
  it('remote host → https, no port', () => {
    expect(deriveServerUrl('postgres://u:p@team.example.com:5432/db')).toBe('https://team.example.com');
  });
  it('existing serverUrl takes precedence', () => {
    expect(deriveServerUrl('postgres://u:p@team.example.com/db', 'https://override.example')).toBe('https://override.example');
  });
  it('unparseable url throws', () => {
    expect(() => deriveServerUrl('not a url')).toThrow();
  });
});

describe('makeResolveConvertContext', () => {
  const base = {
    cwd: '/proj/b',
    readScope: () => ({ teamId: 't1', projectId: 'p1' }),
    resolveKey: () => 'cmem_existing',
    mintKey: async (_t: string, _p: string, _url: string) => 'cmem_minted',
  };

  it('resolves full context with an existing key (no mint)', async () => {
    let minted = false;
    const resolve = makeResolveConvertContext({ ...base, mintKey: async () => { minted = true; return 'x'; } });
    const ctx = await resolve('postgres://u:p@localhost:5432/db');
    expect(ctx).toEqual({ cwd: '/proj/b', teamId: 't1', projectId: 'p1', serverUrl: 'http://localhost:38879', apiKey: 'cmem_existing' });
    expect(minted).toBe(false);
  });

  it('mints the key (with databaseUrl) when the store misses', async () => {
    let seenUrl = '';
    const resolve = makeResolveConvertContext({
      ...base,
      resolveKey: () => null,
      mintKey: async (_t, _p, url) => { seenUrl = url; return 'cmem_minted'; },
    });
    const ctx = await resolve('postgres://u:p@localhost:5432/db');
    expect((ctx as any).apiKey).toBe('cmem_minted');
    expect(seenUrl).toBe('postgres://u:p@localhost:5432/db');
  });

  it('returns an error when local scope is unresolvable', async () => {
    const resolve = makeResolveConvertContext({ ...base, readScope: () => null });
    const ctx = await resolve('postgres://u:p@localhost:5432/db');
    expect(ctx).toEqual({ error: 'no local project identity — run inside a MemSmith project' });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/server/convert/convert-context.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the module**

Create `src/server/convert/convert-context.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// Server-side resolution of the fields the browser wizard cannot supply for
// POST /v1/convert/migrate (cwd, projectId, teamId, serverUrl, apiKey). See
// docs/superpowers/specs/2026-07-23-wizard-convert-wiring-design.md.

export interface ConvertContext {
  cwd: string;
  teamId: string;
  projectId: string;
  serverUrl: string;
  apiKey: string;
}

export type ResolveConvertContext = (databaseUrl: string) => Promise<ConvertContext | { error: string }>;

export interface ResolveConvertContextDeps {
  cwd: string;
  readScope: (cwd: string) => { teamId: string; projectId: string } | null;
  resolveKey: (teamId: string) => string | null;
  mintKey: (teamId: string, projectId: string, databaseUrl: string) => Promise<string>;
  existingServerUrl?: (cwd: string) => string | undefined;
}

export function deriveServerUrl(databaseUrl: string, existingServerUrl?: string): string {
  if (existingServerUrl && existingServerUrl.length > 0) return existingServerUrl;
  const u = new URL(databaseUrl); // throws on unparseable → surfaces as convert error
  const host = u.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return `http://${host}:38879`;
  return `https://${host}`;
}

export function makeResolveConvertContext(deps: ResolveConvertContextDeps): ResolveConvertContext {
  return async (databaseUrl: string) => {
    const scope = deps.readScope(deps.cwd);
    if (!scope) return { error: 'no local project identity — run inside a MemSmith project' };
    const serverUrl = deriveServerUrl(databaseUrl, deps.existingServerUrl?.(deps.cwd));
    const existing = deps.resolveKey(scope.teamId);
    const apiKey = existing ?? (await deps.mintKey(scope.teamId, scope.projectId, databaseUrl));
    return { cwd: deps.cwd, teamId: scope.teamId, projectId: scope.projectId, serverUrl, apiKey };
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/server/convert/convert-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0 (ignore editor-only false positives: `bun:test` module, `.js` import resolution, `ZodTypeAny deprecated`).

- [ ] **Step 6: Commit**

```bash
git add src/server/convert/convert-context.ts tests/server/convert/convert-context.test.ts
git commit -m "feat(convert): server-side convert-context resolver (serverUrl + scope + key)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Migrate route uses resolveConvertContext

**Files:**
- Modify: `src/server/routes/v1/ConvertRoutes.ts:6-42`
- Test: `tests/server/routes/v1/convert-routes.test.ts`

**Interfaces:**
- Consumes: `ConvertContext` / `ResolveConvertContext` (Task 1).
- Produces: `ConvertRoutesDeps` gains `resolveConvertContext: ResolveConvertContext`. The migrate handler reads only `databaseUrl` (body) + `ownerUserId` (authContext); resolves the rest; forwards `{ databaseUrl, ownerUserId, ...ctx }` to `convert`. `convert`'s input type is unchanged from sub-spec 2.

- [ ] **Step 1: Update the route tests**

In `tests/server/routes/v1/convert-routes.test.ts`:

1. Every `/v1/convert/migrate` test now injects a fake `resolveConvertContext` in the deps. Add a helper returning a full context:

```ts
const fakeResolve = async (_databaseUrl: string) => ({
  cwd: '/proj', teamId: 't1', projectId: 'p1',
  serverUrl: 'http://localhost:38879', apiKey: 'cmem_k',
});
```

2. The two happy-path migrate tests: body becomes `{ databaseUrl: 'postgres://x' }` only; deps include `resolveConvertContext: fakeResolve`. Still expect 200 / the convert result. If a test asserts what `convert` was called with, expect the resolved fields (`cwd:'/proj'`, `teamId:'t1'`, `projectId:'p1'`, `serverUrl`, `apiKey:'cmem_k'`, `ownerUserId:'u1'`).

3. REPLACE the "returns 400 when required body fields are missing" cases:
   - Keep: missing `databaseUrl` → 400 `databaseUrl required` (deps still include `fakeResolve`).
   - REMOVE the `cwd required` / `serverUrl required` / `apiKey required` / `projectId required` assertions.
   - ADD: unresolvable scope → 400. Inject `resolveConvertContext: async () => ({ error: 'no local project identity — run inside a MemSmith project' })`, body `{ databaseUrl: 'postgres://x' }`, authContext with userId → expect `r.code === 400` and `r.body.error === 'no local project identity — run inside a MemSmith project'`, and assert `convert` was NOT called (use a spy/flag).

4. Any test that builds deps without `resolveConvertContext` must add it (the test-connection tests don't need it but the deps object is shared — add `fakeResolve` to the shared deps factory).

- [ ] **Step 2: Run to verify the new/edited tests fail**

Run: `bun test tests/server/routes/v1/convert-routes.test.ts`
Expected: FAIL — route still reads cwd/serverUrl/apiKey/projectId from body and has no `resolveConvertContext`.

- [ ] **Step 3: Rewrite the migrate route**

In `src/server/routes/v1/ConvertRoutes.ts`:

1. Add to `ConvertRoutesDeps` (import the type):

```ts
import type { ResolveConvertContext } from '../../convert/convert-context.js';
```
```ts
  resolveConvertContext: ResolveConvertContext;
```

2. Replace the migrate handler body (the `app.post('/v1/convert/migrate', ...)` block) with:

```ts
  app.post('/v1/convert/migrate', ...deps.authMiddleware, async (req: any, res: any) => {
    const url = String(req.body?.databaseUrl ?? '');
    const ownerUserId = req.authContext?.userId;
    if (!url) { res.status(400).json({ error: 'databaseUrl required' }); return; }
    if (!ownerUserId) { res.status(403).json({ error: 'no owner identity' }); return; }
    try {
      const ctx = await deps.resolveConvertContext(url);
      if ('error' in ctx) { res.status(400).json({ error: ctx.error }); return; }
      res.json(await deps.convert({
        databaseUrl: url,
        ownerUserId,
        cwd: ctx.cwd,
        teamId: ctx.teamId,
        serverUrl: ctx.serverUrl,
        apiKey: ctx.apiKey,
        projectId: ctx.projectId,
      }));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'convert failed' });
    }
  });
```

(The old `cwd`/`serverUrl`/`apiKey`/`projectId`/`teamId` body reads and their 400/403 guards are deleted. `teamId` now comes from the resolved ctx, not authContext.)

- [ ] **Step 4: Run route tests to verify pass**

Run: `bun test tests/server/routes/v1/convert-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + convert suite**

Run: `npx tsc --noEmit && bun test tests/server/convert/ tests/server/routes/v1/convert-routes.test.ts`
Expected: tsc exit 0 (real errors only); all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/v1/ConvertRoutes.ts tests/server/routes/v1/convert-routes.test.ts
git commit -m "feat(convert): migrate route resolves context server-side; body is databaseUrl-only

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Wire the production resolveConvertContext + integration proof

**Files:**
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts:1561-1585` (registerConvertRoutes call)
- Test: `tests/server/convert/convert-context-integration.test.ts` (new, self-skipping)

**Interfaces:**
- Consumes: `makeResolveConvertContext`/`deriveServerUrl` (Task 1); `readLocalScopeFromMarkerOrEnv`, `ensureBaseKey`, `CredentialStore`, `parsePostgresConfig`/`createPostgresPool`/`bootstrapServerPostgresSchema` (existing).
- Produces: production `resolveConvertContext` passed into `registerConvertRoutes`.

- [ ] **Step 1: Wire the production resolver**

In `src/server/routes/v1/ServerV1PostgresRoutes.ts`, add imports:

```ts
import { makeResolveConvertContext } from '../../convert/convert-context.js';
import { readLocalScopeFromMarkerOrEnv } from '../../runtime/resolve-local-scope.js';
import { readProjectMarker } from '../../../services/identity/project-identity.js';
import { ensureBaseKey } from '../../../services/identity/project-identity.js';
```

(If `readProjectMarker` is already imported for another purpose, don't double-import. Use Grep to check existing imports first.)

In the `registerConvertRoutes(app, { ... })` call, add the `resolveConvertContext` dep. The `mintKey` closure receives `databaseUrl` (Task 1's `mintKey` arity) and builds + bootstraps a remote pool so the `api_keys` table exists before `ensureBaseKey` inserts:

```ts
    const credStore = new CredentialStore();
    const convertCwd = process.env.MEMSMITH_PROJECT_CWD ?? process.cwd();
    registerConvertRoutes(app, {
      authMiddleware: [...writeAuth, requireRole('owner')],
      probe: (url) => probeConnection(url, makeRealProbeDeps()),
      resolveConvertContext: makeResolveConvertContext({
        cwd: convertCwd,
        readScope: (cwd) => readLocalScopeFromMarkerOrEnv(cwd),
        resolveKey: (teamId) => credStore.resolveKeyForTeam(teamId),
        existingServerUrl: (cwd) => readProjectMarker(cwd)?.serverUrl,
        mintKey: async (teamId, projectId, databaseUrl) => {
          // The remote schema must exist before ensureBaseKey inserts the api_keys row.
          const cfg = parsePostgresConfig({ env: { MEMSMITH_SERVER_DATABASE_URL: databaseUrl } as NodeJS.ProcessEnv });
          if (!cfg) throw new Error('invalid remote databaseUrl');
          const pool = createPostgresPool(cfg);
          try {
            await bootstrapServerPostgresSchema(pool);
            return await ensureBaseKey(pool, teamId, projectId, credStore);
          } finally {
            await pool.end();
          }
        },
      }),
      convert: async (input) => { /* unchanged from sub-spec 2 */ },
    });
```

- [ ] **Step 2: Typecheck the wiring**

Run: `npx tsc --noEmit`
Expected: exit 0 (real errors only). Confirms the production `mintKey` closure matches Task 1's `(teamId, projectId, databaseUrl)` arity and all imports resolve.

- [ ] **Step 3: Write the self-skipping integration test**

Create `tests/server/convert/convert-context-integration.test.ts`. Use the same skip idiom as `tests/server/convert/scoped-convert-integration.test.ts` / `tests/server/server-service.test.ts`:

```ts
const TEST_DATABASE_URL = process.env.MEMSMITH_TEST_POSTGRES_URL;
describe('convert-context mint (integration)', () => {
  if (TEST_DATABASE_URL) {
    it('mints a team key against the destination and caches it', async () => {
      // 1. new pg.Pool(TEST_DATABASE_URL); bootstrapServerPostgresSchema(pool)
      // 2. build a fresh CredentialStore (in-memory / temp path)
      // 3. call the mint closure equivalent: ensureBaseKey(pool, teamId, projectId, store)
      // 4. assert: store.resolveKeyForTeam(teamId) === returned key
      // 5. assert: api_keys has a row with key_hash = hashApiKey(returned key) AND team_id = teamId
      // 6. idempotency: second ensureBaseKey returns the SAME key, still 1 matching api_keys row
    });
  }
});
```

Import `ensureBaseKey` and `hashApiKey` from `src/services/identity/project-identity.js` (Grep for the exact export of `hashApiKey`; if it's not exported, assert via `resolveKeyForTeam` round-trip + row count instead of recomputing the hash). Seed a `teams` row first if the `api_keys` FK requires it (check `insertApiKeyHash` — it inserts team_id; ensure the FK is satisfiable; if `api_keys.team_id REFERENCES teams(id)`, insert the team row first).

- [ ] **Step 4: Verify skip + typecheck**

Run without PG: `bun test tests/server/convert/convert-context-integration.test.ts` → 0 tests (clean skip, no ECONNREFUSED).
Run: `npx tsc --noEmit` → exit 0.

- [ ] **Step 5: Full convert + route suite**

Run: `bun test tests/server/convert/ tests/server/routes/v1/convert-routes.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/v1/ServerV1PostgresRoutes.ts src/server/convert/convert-context.ts tests/server/convert/convert-context.test.ts tests/server/convert/convert-context-integration.test.ts
git commit -m "feat(convert): wire production convert-context resolver + mint-against-destination proof

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** D1 (server resolves fields, client sends databaseUrl only) → Tasks 1+2. D2 (mint against destination on key miss) → Task 1 resolver + Task 3 production mint closure (bootstrap-before-insert ordering enforced by building+bootstrapping the pool inside `mintKey`). D3 (serverUrl derivation, marker precedence) → Task 1 `deriveServerUrl`. D4 (honest 400 on unresolvable scope) → Task 1 error branch + Task 2 route 400. All covered.
- **Placeholder scan:** no placeholders or TODOs. `mintKey` is defined with its final `(teamId, projectId, databaseUrl)` arity in Task 1, so Task 3 is a single clean wiring step.
- **Type consistency:** `mintKey` arity `(teamId, projectId, databaseUrl)` is consistent across Task 1's type, Task 1's test, and Task 3's production closure. `ConvertContext` fields match across module, route, and `convert` input. `resolveConvertContext` name identical in module, deps, and wiring.
- **Regression pre-empted:** convert-routes tests reconciled in Task 2 (drop the removed-field 400s, add resolver dep + scope-error 400). test-connection tests get the resolver dep added to the shared deps factory.
