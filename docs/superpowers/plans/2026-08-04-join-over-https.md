# Join over HTTPS + Secrets Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A joining teammate needs only the team API key — never a Postgres URL or database password — to attach their project to a team workspace.

**Architecture:** The authenticated route stays on the joiner's *local* server (`POST /v1/join`, `writeAuth`). Only the outward hop changes: instead of `runJoin` opening a Postgres pool to the remote, a new HTTPS transport calls `POST /v1/join/register` on the team server, which performs the identical key-hash lookup and project upsert server-side. `JoinDeps` is already an interface over the remote — that is the seam, so `runJoin`'s logic is untouched.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Express, Postgres (`pg`), `bun test`, `node:crypto` for SHA-256.

**Spec:** `docs/superpowers/specs/2026-08-04-join-over-https-design.md` — read §2.1, §3.1–3.4, §4.1–4.3 before starting.

## Global Constraints

- **Never commit directly to `main`.** Work on branch `join-over-https` (already exists, currently at the spec commits).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Nothing is pushed.** Local commits only. Do not `git push`.
- **The team API key must never be written to `.memsmith/project.json`.** It lives only in `CredentialStore` (`~/.memsmith/credentials.json`), keyed by teamId.
- **`writeServerModeSettings` must never be called on the join path.** It writes `MEMSMITH_SERVER_DATABASE_URL` to `~/.memsmith/settings.json`. It currently has zero call sites; keep it that way.
- **`teamId` always comes from the authenticated key's own `api_keys` row**, never from a request body or query param.
- Test gates: `bun test` must not exceed the **measured baseline of 12 failures** (captured 2026-08-04 at `8f6dd145`: `2662 pass / 36 skip / 12 fail`). The named failure set is at `/tmp/baseline-failures.txt` — **A/B against the named set, not the count**, because two of these (`EmbeddedPostgresManager lifecycle`) are port-contention-sensitive and flap. `npx tsc --noEmit` must not add new errors. Known pre-existing `tsc` false positives to ignore: `bun:test` module resolution, `ZodTypeAny` deprecation, `import.meta.dir`, `Cannot find name 'Bun'`.
- **Do not delete the Postgres fallback transport** (spec §4.1, decided 2026-08-04).
- ESM imports use `.js` extensions even for `.ts` sources (e.g. `from '../../convert/join-service.js'`).
- Every new file starts with `// SPDX-License-Identifier: Apache-2.0`.

## File Structure

| File | Responsibility |
|---|---|
| `src/server/convert/join-transport.ts` | **Create.** The transport abstraction: a `JoinTransport` interface plus `selectJoinTransport(url)` choosing HTTPS vs Postgres. |
| `src/server/convert/join-transport-https.ts` | **Create.** HTTPS implementation — POSTs to `/v1/join/register`, maps responses to `JoinResult`. |
| `src/server/middleware/join-rate-limit-subject.ts` | **Create.** Derives the rate-limit bucket from an unauthenticated request body/IP. Pure function + middleware factory. |
| `src/server/routes/v1/JoinRegisterRoute.ts` | **Create.** The remote `POST /v1/join/register` route, in its own file (`ServerV1PostgresRoutes.ts` is already ~2000 lines). |
| `src/server/convert/join-service.ts` | **Modify.** Add an optional `transport` dep; when present, delegate steps 2–4 to it. |
| `src/server/routes/v1/ServerV1PostgresRoutes.ts` | **Modify.** Register the new route; wire transport selection into the existing `join:` dep. |
| `docs/deploy/aws.md` | **Modify.** Task definition `environment` → `secrets`/`valueFrom`; IAM note. |

**Task order rationale:** Tasks 1–2 build the remote side (route + rate limit) so it can be tested standalone. Task 3 builds the client transport. Task 4 wires them together. Task 5 is the deploy doc. Each task is independently reviewable and leaves the suite green.

---

### Task 1: Rate-limit subject derivation

The remote register route is deliberately unauthenticated (spec §2.1 — the team key is a body parameter so the four specific error reasons survive). The existing `requireRateLimit` **cannot** be reused directly: `src/server/middleware/rate-limit.ts:54-55` reads the subject from `req.authContext?.apiKeyId` and calls `next()` when absent, so on an unauthenticated route it is a silent no-op. This task supplies the missing subject derivation. The *storage* layer is reused unchanged — `rate_limit_counters.subject_id` is `TEXT` with no foreign key (`src/storage/postgres/schema.ts:287-291`), so an arbitrary subject string is already legal.

**Files:**
- Create: `src/server/middleware/join-rate-limit-subject.ts`
- Test: `tests/server/middleware/join-rate-limit-subject.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export function joinRateLimitSubject(body: unknown, clientIp: string, hashKey: (raw: string) => string): string`
  - `export function requireJoinRateLimit(pool: PostgresPool, opts: { windowSec: number; max: number }, hashKey: (raw: string) => string): RequestHandler`

- [ ] **Step 1: Write the failing test**

Create `tests/server/middleware/join-rate-limit-subject.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// The join-register route is deliberately unauthenticated (spec §2.1), so the
// existing requireRateLimit — which reads req.authContext?.apiKeyId and calls
// next() when it is absent — would be a SILENT NO-OP there. These tests pin the
// subject derivation that replaces it.
import { describe, it, expect } from 'bun:test';
import { joinRateLimitSubject } from '../../../src/server/middleware/join-rate-limit-subject.js';

// Deterministic stand-in for sha256 that does NOT embed its input, matching the
// real hash's property. (An `H(${raw})` mock would silently defeat any assertion
// about the raw key not appearing in output.)
const hash = (raw: string) => `h${[...raw].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`;

describe('joinRateLimitSubject', () => {
  it('buckets by the key hash when a team key is present', () => {
    // Keying on the key hash keeps one noisy teammate from locking out
    // colleagues behind the same NAT.
    expect(joinRateLimitSubject({ teamKey: 'k1' }, '203.0.113.9', hash))
      .toBe('joinkey:H(k1)');
  });

  it('falls back to the client IP when no key is supplied', () => {
    // The IP bucket is the branch that actually catches guessing: an attacker
    // probing for valid keys produces many DISTINCT hashes from one source.
    expect(joinRateLimitSubject({}, '203.0.113.9', hash)).toBe('joinip:203.0.113.9');
  });

  it('never hashes a non-string key', () => {
    // A JSON body is attacker-controlled; { teamKey: { } } must not reach hashKey.
    expect(joinRateLimitSubject({ teamKey: { evil: true } }, '203.0.113.9', hash))
      .toBe('joinip:203.0.113.9');
  });

  it('treats a blank key as absent', () => {
    expect(joinRateLimitSubject({ teamKey: '   ' }, '203.0.113.9', hash))
      .toBe('joinip:203.0.113.9');
  });

  it('never returns the raw key, only its hash', () => {
    // The subject is written to rate_limit_counters.subject_id, i.e. persisted.
    const subject = joinRateLimitSubject({ teamKey: 'super-secret' }, '', hash);
    expect(subject).not.toContain('super-secret');
  });

  it('produces a stable subject for the same key', () => {
    const a = joinRateLimitSubject({ teamKey: 'k1' }, '1.1.1.1', hash);
    const b = joinRateLimitSubject({ teamKey: 'k1' }, '2.2.2.2', hash);
    expect(a).toBe(b);
  });

  it('handles a null or non-object body without throwing', () => {
    expect(joinRateLimitSubject(null, '1.1.1.1', hash)).toBe('joinip:1.1.1.1');
    expect(joinRateLimitSubject('nope', '1.1.1.1', hash)).toBe('joinip:1.1.1.1');
  });

  it('uses a stable placeholder when both key and IP are missing', () => {
    // Must never return an empty subject: subject_id is NOT NULL and an empty
    // string would silently merge unrelated callers into one bucket.
    expect(joinRateLimitSubject({}, '', hash)).toBe('joinip:unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/middleware/join-rate-limit-subject.test.ts`
Expected: FAIL — `Cannot find module '.../join-rate-limit-subject.js'`

- [ ] **Step 3: Write the implementation**

Create `src/server/middleware/join-rate-limit-subject.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// Rate limiting for POST /v1/join/register, which is deliberately
// UNAUTHENTICATED (see the spec's §2.1): the team key travels in the body
// rather than the Authorization header, so that the four specific rejection
// reasons — unknown / revoked / expired / teamless — survive. A flat 401 from
// the auth middleware would collapse all four.
//
// That choice makes the route reachable without prior authentication, so it
// needs its own limit. The existing requireRateLimit CANNOT be reused as-is:
//
//   rate-limit.ts:54-55
//     const subject = req.authContext?.apiKeyId;
//     if (!subject) return next();   // unauthenticated bypass
//
// On an unauthenticated route authContext is undefined, so wiring that limiter
// in would look correct and enforce NOTHING. Only the subject derivation is new
// — the storage layer is reused unchanged, because rate_limit_counters.subject_id
// is TEXT with no foreign key (schema.ts:287-291), so an arbitrary subject
// string is already legal.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { PostgresRateLimitRepository } from '../../storage/postgres/rate-limit.js';
import { logger } from '../../utils/logger.js';

/**
 * The bucket this request counts against.
 *
 * Two buckets, deliberately:
 *  - `joinkey:<hash>` when a key is supplied. One team's legitimate retries
 *    cannot exhaust another team's budget, and one noisy teammate cannot lock
 *    out colleagues behind the same NAT.
 *  - `joinip:<ip>` otherwise. This is the branch that actually resists guessing:
 *    an attacker probing for valid keys produces many DISTINCT hashes from a
 *    single source, so per-key buckets would never fill.
 *
 * Only the HASH is used, never the raw key: the subject is persisted to
 * rate_limit_counters.subject_id.
 */
export function joinRateLimitSubject(
  body: unknown,
  clientIp: string,
  hashKey: (raw: string) => string,
): string {
  const raw = (body && typeof body === 'object')
    ? (body as { teamKey?: unknown }).teamKey
    : undefined;
  // Guard the type explicitly: the body is attacker-controlled JSON, so
  // { teamKey: {} } must never reach hashKey.
  if (typeof raw === 'string' && raw.trim()) return `joinkey:${hashKey(raw.trim())}`;
  // Never return an empty subject — subject_id is NOT NULL, and an empty string
  // would silently merge unrelated callers into a single shared bucket.
  return `joinip:${clientIp || 'unknown'}`;
}

/**
 * Fixed-window limiter for the unauthenticated join-register route.
 *
 * FAILS OPEN, matching rate-limit.ts:58-63 ("a limiter/quota storage hiccup must
 * never take the API down"). That is a deliberate choice here rather than an
 * inherited one: fail-open is the wrong default for most anti-guessing controls,
 * but a database blip must not make joining impossible, and the resistance given
 * up is marginal against a SHA-256 key space.
 */
export function requireJoinRateLimit(
  pool: PostgresPool,
  opts: { windowSec: number; max: number },
  hashKey: (raw: string) => string,
): RequestHandler {
  const repo = new PostgresRateLimitRepository(pool);
  return async (req: Request, res: Response, next: NextFunction) => {
    const clientIp = req.ip || req.socket?.remoteAddress || '';
    const subject = joinRateLimitSubject(req.body, clientIp, hashKey);
    const ms = opts.windowSec * 1000;
    const windowStart = new Date(Math.floor(Date.now() / ms) * ms);
    const resetMs = windowStart.getTime() + ms;
    try {
      const result = await repo.hit({ subjectId: subject, windowStart, limit: opts.max });
      res.setHeader('X-RateLimit-Limit', String(opts.max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.max - result.count)));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetMs / 1000)));
      if (!result.allowed) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetMs - Date.now()) / 1000))));
        // Same body shape as the existing limiter (rate-limit.ts:42-45) so
        // clients need no special case for this route.
        res.status(429).json({
          error: 'rate_limited',
          message: `Rate limit exceeded (${opts.max} requests / ${opts.windowSec}s)`,
        });
        return;
      }
      next();
    } catch (error) {
      logger.warn('HTTP', 'join rate limit check failed; allowing request (fail open)', {
        error: error instanceof Error ? error.message : String(error),
      });
      next();
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/middleware/join-rate-limit-subject.test.ts`
Expected: PASS — 8 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/server/middleware/join-rate-limit-subject.ts tests/server/middleware/join-rate-limit-subject.test.ts
git commit -m "feat: rate-limit subject derivation for the unauthenticated join-register route

The existing requireRateLimit reads req.authContext?.apiKeyId and calls next()
when absent, so on a deliberately unauthenticated route it enforces nothing.
This derives the bucket from the request instead: joinkey:<hash> when a key is
present, else joinip:<ip>. Reuses PostgresRateLimitRepository unchanged —
subject_id is TEXT with no FK, so an arbitrary subject is already legal.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: The remote `POST /v1/join/register` route

Performs the four checks `runJoin` does today, server-side. New file rather than an addition to `ServerV1PostgresRoutes.ts`, which is already ~2000 lines.

**Files:**
- Create: `src/server/routes/v1/JoinRegisterRoute.ts`
- Test: `tests/server/routes/v1/join-register-route.test.ts`

**Interfaces:**
- Consumes: `requireJoinRateLimit` from Task 1 (wired in Task 4, not here — this route takes middleware as a dep so it stays testable).
- Produces:
  - `export interface JoinRegisterDeps { rateLimit?: RequestHandler[]; lookupKey: (keyHash: string) => Promise<JoinKeyRow | null>; upsertProject: (teamId: string, projectId: string, name?: string) => Promise<void>; hashKey: (raw: string) => string; }`
  - `export interface JoinKeyRow { teamId: string | null; revokedAt: Date | string | null; expiresAt: Date | string | null; }`
  - `export function registerJoinRegisterRoute(app: unknown, deps: JoinRegisterDeps): void`

- [ ] **Step 1: Write the failing test**

Create `tests/server/routes/v1/join-register-route.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/join/register — the remote half of join-over-HTTPS.
//
// This route is what lets a teammate join with ONLY the team key: no Postgres
// URL, no database password. It performs the same four checks runJoin does
// today (join-service.ts:105-126), server-side.
//
// The security shape it must preserve:
//   - teamId comes from the KEY'S OWN ROW, never from the request body
//   - projectId DOES come from the body, and that is correct here and only here
//     (spec §3.3): the row is CREATED under the authenticated key's own team,
//     so a caller can never reach another team's data
//   - all four rejection reasons stay DISTINCT (spec §2.1)
import { describe, it, expect } from 'bun:test';
import { registerJoinRegisterRoute } from '../../../../src/server/routes/v1/JoinRegisterRoute.js';

function makeApp() {
  const routes: Record<string, Function> = {};
  return {
    app: { post: (path: string, ...mw: unknown[]) => { routes[path] = mw[mw.length - 1] as Function; } },
    routes,
  };
}
function res() {
  const r: any = {
    code: 0, body: null, headers: {} as Record<string, string>,
    status(c: number) { this.code = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
  };
  return r;
}
// Deterministic stand-in for sha256 that does NOT embed its input, matching the
// real hash's property. (An `H(${raw})` mock would silently defeat any assertion
// about the raw key not appearing in output.)
const hash = (raw: string) => `h${[...raw].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`;

const GOOD = { teamId: 'team-1', revokedAt: null, expiresAt: null };

function deps(over: Partial<Parameters<typeof registerJoinRegisterRoute>[1]> = {}) {
  return {
    hashKey: hash,
    lookupKey: async () => GOOD,
    upsertProject: async () => {},
    ...over,
  } as Parameters<typeof registerJoinRegisterRoute>[1];
}

describe('POST /v1/join/register', () => {
  it('registers the project under the team the KEY names', async () => {
    const { app, routes } = makeApp();
    let seen: { teamId?: string; projectId?: string; name?: string } = {};
    registerJoinRegisterRoute(app as never, deps({
      upsertProject: async (teamId, projectId, name) => { seen = { teamId, projectId, name }; },
    }));
    const r = res();
    await routes['/v1/join/register'](
      { body: { teamKey: 'k1', projectId: 'p-new', projectName: 'svc' } }, r,
    );
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ status: 'joined', teamId: 'team-1' });
    expect(seen).toEqual({ teamId: 'team-1', projectId: 'p-new', name: 'svc' });
  });

  it('IGNORES a teamId supplied in the body', async () => {
    // THE SECURITY TEST. The body is attacker-controlled; the team must come
    // from the key's own row. If this ever regresses, a valid key for team A
    // could plant a project in team B.
    const { app, routes } = makeApp();
    let seenTeam = '';
    registerJoinRegisterRoute(app as never, deps({
      upsertProject: async (teamId) => { seenTeam = teamId; },
    }));
    const r = res();
    await routes['/v1/join/register'](
      { body: { teamKey: 'k1', projectId: 'p1', teamId: 'team-ATTACKER' } }, r,
    );
    expect(seenTeam).toBe('team-1');
  });

  it('looks the key up by HASH, never storing or comparing the raw key', async () => {
    const { app, routes } = makeApp();
    let seenHash = '';
    registerJoinRegisterRoute(app as never, deps({
      lookupKey: async (h) => { seenHash = h; return GOOD; },
    }));
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, res());
    expect(seenHash).toBe(hash('k1'));
  });

  it('rejects an unknown key with its own reason', async () => {
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({ lookupKey: async () => null }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'nope', projectId: 'p1' } }, r);
    expect(r.code).toBe(422);
    expect(r.body.error).toBe('that key is not valid for this workspace');
  });

  it('rejects a revoked key with its own reason', async () => {
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({
      lookupKey: async () => ({ teamId: 'team-1', revokedAt: new Date(), expiresAt: null }),
    }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, r);
    expect(r.code).toBe(422);
    expect(r.body.error).toBe('that key has been revoked');
  });

  it('rejects an expired key with its own reason', async () => {
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({
      lookupKey: async () => ({ teamId: 'team-1', revokedAt: null, expiresAt: new Date(Date.now() - 1000) }),
    }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, r);
    expect(r.code).toBe(422);
    expect(r.body.error).toBe('that key has expired');
  });

  it('accepts a key whose expiry is in the future', async () => {
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({
      lookupKey: async () => ({ teamId: 'team-1', revokedAt: null, expiresAt: new Date(Date.now() + 60_000) }),
    }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, r);
    expect(r.code).toBe(200);
  });

  it('rejects a teamless key with its own reason', async () => {
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({
      lookupKey: async () => ({ teamId: null, revokedAt: null, expiresAt: null }),
    }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, r);
    expect(r.code).toBe(422);
    expect(r.body.error).toBe('that key is not scoped to a team');
  });

  it('all four rejection reasons are DISTINCT', async () => {
    // Spec §2.1: this is the property the whole body-parameter design exists to
    // preserve. If a refactor routes the key through the auth middleware, all
    // four collapse to one 401 and this test is what catches it.
    const cases: Array<[unknown, string]> = [
      [null, 'that key is not valid for this workspace'],
      [{ teamId: 'team-1', revokedAt: new Date(), expiresAt: null }, 'that key has been revoked'],
      [{ teamId: 'team-1', revokedAt: null, expiresAt: new Date(Date.now() - 1) }, 'that key has expired'],
      [{ teamId: null, revokedAt: null, expiresAt: null }, 'that key is not scoped to a team'],
    ];
    const seen = new Set<string>();
    for (const [row, expected] of cases) {
      const { app, routes } = makeApp();
      registerJoinRegisterRoute(app as never, deps({ lookupKey: async () => row as never }));
      const r = res();
      await routes['/v1/join/register']({ body: { teamKey: 'k', projectId: 'p1' } }, r);
      expect(r.body.error).toBe(expected);
      seen.add(r.body.error);
    }
    expect(seen.size).toBe(4);
  });

  it('requires a team key and a projectId', async () => {
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps());
    const a = res();
    await routes['/v1/join/register']({ body: { projectId: 'p1' } }, a);
    expect(a.code).toBe(422);
    expect(a.body.error).toBe('team key is required');
    const b = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1' } }, b);
    expect(b.code).toBe(422);
    expect(b.body.error).toBe('projectId is required');
  });

  it('never leaks a connection string in ANY response', async () => {
    // Success and failure alike. The whole point of this route is that the
    // database credential stays server-side.
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({
      upsertProject: async () => { throw new Error('connect to postgres://user:pw@host/db failed'); },
    }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, r);
    expect(r.code).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('postgres://');
    expect(JSON.stringify(r.body)).not.toContain('pw@');
  });

  it('reports a registration failure as 500, not as a bad key', async () => {
    // A database problem is not the user's fault and must not be reported as
    // "your key is invalid" — that would send them chasing the wrong fix.
    const { app, routes } = makeApp();
    registerJoinRegisterRoute(app as never, deps({
      upsertProject: async () => { throw new Error('deadlock detected'); },
    }));
    const r = res();
    await routes['/v1/join/register']({ body: { teamKey: 'k1', projectId: 'p1' } }, r);
    expect(r.code).toBe(500);
    expect(r.body.status).toBe('failed');
  });

  it('installs the rate-limit middleware ahead of the handler', async () => {
    // Spec §3.2: without a limiter this route is a key-guessing oracle that
    // helpfully distinguishes "no such key" from "revoked". Assert the
    // middleware is actually registered, not merely available.
    const seen: unknown[] = [];
    const app = { post: (_p: string, ...mw: unknown[]) => { seen.push(...mw); } };
    const marker = () => {};
    registerJoinRegisterRoute(app as never, deps({ rateLimit: [marker as never] }));
    expect(seen).toContain(marker);
    expect(seen.indexOf(marker)).toBeLessThan(seen.length - 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/routes/v1/join-register-route.test.ts`
Expected: FAIL — `Cannot find module '.../JoinRegisterRoute.js'`

- [ ] **Step 3: Write the implementation**

Create `src/server/routes/v1/JoinRegisterRoute.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// POST /v1/join/register — the REMOTE half of join-over-HTTPS.
//
// Today a joining teammate opens a direct Postgres connection to the team
// database, which means possessing a URL with the database password in it. Join
// needs INSERT on projects/teams, so that URL cannot be narrowed to read-only:
// onboarding one person hands them write access to every table. This route
// moves those writes server-side so the teammate needs only the team key.
//
// It performs the same four checks runJoin does (join-service.ts:105-126).
//
// WHY THE KEY IS A BODY PARAMETER AND NOT `Authorization: Bearer`
// Because the four rejection reasons must stay distinct. postgres-auth
// resolveApiKey returns null for missing, revoked, expired AND
// insufficient-scope alike (postgres-auth.ts:360-370) → one flat 401 at line
// 222. A teammate whose key was revoked would see only "unauthorized" and have
// to go ask the owner why. So the key is inspected as DATA.
//
// That makes this route reachable without prior authentication, which is why the
// rate limiter is not optional in production — see requireJoinRateLimit.
//
// WHY `projectId` MAY COME FROM THE BODY HERE
// This is the only place in the codebase where that is true. The row is CREATED
// under the team named by the KEY, never read from another team. The composite
// FK projects(id, team_id) makes the team half non-negotiable and the team half
// comes from the credential, so a caller can only ever create a project inside
// its own team — and naming a fresh id reveals nothing, because nothing exists
// at it yet. Contrast resolve-requested-project.ts, which exists to stop a
// request WIDENING A READ to an existing project.

import type { RequestHandler } from 'express';
import { logger } from '../../utils/logger.js';

/** The api_keys columns this route needs. */
export interface JoinKeyRow {
  teamId: string | null;
  revokedAt: Date | string | null;
  expiresAt: Date | string | null;
}

export interface JoinRegisterDeps {
  /** Middleware to run before the handler. Production MUST pass a limiter. */
  rateLimit?: RequestHandler[];
  /** Look up an api_keys row by its hash. Returns null when unknown. */
  lookupKey: (keyHash: string) => Promise<JoinKeyRow | null>;
  /** Idempotently register the project under the team. */
  upsertProject: (teamId: string, projectId: string, name?: string) => Promise<void>;
  /** Hash a raw key the same way api_keys stores it. */
  hashKey: (raw: string) => string;
}

/** 422, not 401/403: a wrong key is user-correctable input shown inline. */
function reject(res: any, error: string): void {
  res.status(422).json({ status: 'failed', error });
}

export function registerJoinRegisterRoute(app: any, deps: JoinRegisterDeps): void {
  app.post('/v1/join/register', ...(deps.rateLimit ?? []), async (req: any, res: any) => {
    const teamKey = typeof req.body?.teamKey === 'string' ? req.body.teamKey.trim() : '';
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const projectName = typeof req.body?.projectName === 'string' ? req.body.projectName : undefined;
    if (!teamKey) return reject(res, 'team key is required');
    if (!projectId) return reject(res, 'projectId is required');

    let row: JoinKeyRow | null;
    try {
      row = await deps.lookupKey(deps.hashKey(teamKey));
    } catch (err) {
      // A lookup failure is OUR fault, not a bad key. Reporting it as an invalid
      // key would send the user chasing the wrong fix.
      logger.warn('HTTP', 'join register key lookup failed', {},
        err instanceof Error ? err : new Error(String(err)));
      res.status(500).json({ status: 'failed', error: 'could not verify the key' });
      return;
    }

    if (!row) return reject(res, 'that key is not valid for this workspace');
    if (row.revokedAt) return reject(res, 'that key has been revoked');
    const expires = row.expiresAt ? new Date(String(row.expiresAt)).getTime() : null;
    if (expires !== null && Number.isFinite(expires) && expires <= Date.now()) {
      return reject(res, 'that key has expired');
    }
    // A key with no team cannot scope anything; joining with it would leave the
    // project authenticated but unroutable.
    if (!row.teamId) return reject(res, 'that key is not scoped to a team');

    try {
      // teamId from the KEY'S ROW. Any teamId in the body is ignored entirely.
      await deps.upsertProject(row.teamId, projectId, projectName);
    } catch (err) {
      // Deliberately does NOT echo err.message: a pg error can embed the
      // connection string, and this route exists precisely to keep that
      // server-side.
      logger.warn('HTTP', 'join register upsert failed', { projectId },
        err instanceof Error ? err : new Error(String(err)));
      res.status(500).json({ status: 'failed', error: 'could not register this project' });
      return;
    }

    // Nothing secret in the response — no database URL, no password.
    res.status(200).json({ status: 'joined', teamId: row.teamId });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/routes/v1/join-register-route.test.ts`
Expected: PASS — 13 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/v1/JoinRegisterRoute.ts tests/server/routes/v1/join-register-route.test.ts
git commit -m "feat: POST /v1/join/register — remote half of join-over-HTTPS

Performs the same four checks runJoin does (join-service.ts:105-126)
server-side, so a joining teammate needs only the team key and never a Postgres
URL. teamId comes from the key's own row; a teamId in the body is ignored.
projectId does come from the body, which is correct here and only here: the row
is created under the key's own team, never read from another.

No response path echoes a pg error message, because those can embed the
connection string.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: The HTTPS join transport

Client side. Turns `runJoin`'s remote steps into one HTTPS call.

**Files:**
- Create: `src/server/convert/join-transport.ts`
- Create: `src/server/convert/join-transport-https.ts`
- Test: `tests/server/convert/join-transport.test.ts`

**Interfaces:**
- Consumes: the wire contract from Task 2 — request `{ teamKey, projectId, projectName? }`, success `200 { status: 'joined', teamId }`, rejection `422 { status: 'failed', error }`, limit `429 { error: 'rate_limited', message }`.
- Produces:
  - `export interface JoinTransport { register: (input: { serverUrl: string; teamKey: string; projectId: string; projectName?: string }) => Promise<{ status: 'joined'; teamId: string } | { status: 'failed'; error: string }>; }`
  - `export function isHttpUrl(url: string): boolean`
  - `export function makeHttpsJoinTransport(fetchImpl?: typeof fetch): JoinTransport`

- [ ] **Step 1: Write the failing test**

Create `tests/server/convert/join-transport.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// The HTTPS join transport: the outward hop that replaces a direct Postgres
// connection, so a joining teammate never holds a database password.
import { describe, it, expect } from 'bun:test';
import { isHttpUrl, makeHttpsJoinTransport } from '../../../src/server/convert/join-transport-https.js';

function fakeFetch(handler: (url: string, init: any) => { status: number; body: unknown }) {
  return (async (url: any, init: any) => {
    const { status, body } = handler(String(url), init);
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as never;
  }) as unknown as typeof fetch;
}

describe('isHttpUrl', () => {
  it('recognises https and http', () => {
    expect(isHttpUrl('https://team.example.com')).toBe(true);
    expect(isHttpUrl('http://127.0.0.1:38880')).toBe(true);
  });

  it('rejects a postgres URL, which must take the fallback transport', () => {
    expect(isHttpUrl('postgres://u:p@host:5432/db')).toBe(false);
    expect(isHttpUrl('postgresql://u:p@host:5432/db')).toBe(false);
  });

  it('rejects junk without throwing', () => {
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});

describe('makeHttpsJoinTransport', () => {
  it('POSTs the team key and project to /v1/join/register', async () => {
    let seenUrl = '', seenBody: any = null, seenMethod = '';
    const t = makeHttpsJoinTransport(fakeFetch((url, init) => {
      seenUrl = url; seenMethod = init.method; seenBody = JSON.parse(init.body);
      return { status: 200, body: { status: 'joined', teamId: 'team-1' } };
    }));
    const out = await t.register({
      serverUrl: 'https://team.example.com', teamKey: 'k1', projectId: 'p1', projectName: 'svc',
    });
    expect(seenMethod).toBe('POST');
    expect(seenUrl).toBe('https://team.example.com/v1/join/register');
    expect(seenBody).toEqual({ teamKey: 'k1', projectId: 'p1', projectName: 'svc' });
    expect(out).toEqual({ status: 'joined', teamId: 'team-1' });
  });

  it('does NOT send the key in an Authorization header', async () => {
    // Spec §2.1: as a header it would hit the auth middleware, which collapses
    // unknown/revoked/expired into one flat 401 and destroys the four reasons.
    let headers: Record<string, string> = {};
    const t = makeHttpsJoinTransport(fakeFetch((_u, init) => {
      headers = init.headers ?? {};
      return { status: 200, body: { status: 'joined', teamId: 'team-1' } };
    }));
    await t.register({ serverUrl: 'https://x', teamKey: 'k1', projectId: 'p1' });
    const names = Object.keys(headers).map(k => k.toLowerCase());
    expect(names).not.toContain('authorization');
  });

  it('strips a trailing slash from the server URL', async () => {
    let seenUrl = '';
    const t = makeHttpsJoinTransport(fakeFetch((url) => {
      seenUrl = url; return { status: 200, body: { status: 'joined', teamId: 't' } };
    }));
    await t.register({ serverUrl: 'https://x/', teamKey: 'k', projectId: 'p' });
    expect(seenUrl).toBe('https://x/v1/join/register');
  });

  it('omits projectName when not supplied', async () => {
    let body: any = null;
    const t = makeHttpsJoinTransport(fakeFetch((_u, init) => {
      body = JSON.parse(init.body); return { status: 200, body: { status: 'joined', teamId: 't' } };
    }));
    await t.register({ serverUrl: 'https://x', teamKey: 'k', projectId: 'p' });
    expect('projectName' in body).toBe(false);
  });

  it('passes a 422 rejection reason through VERBATIM', async () => {
    // The reason is the whole point of the design; the transport must not
    // rewrite or generalise it.
    const t = makeHttpsJoinTransport(fakeFetch(() => ({
      status: 422, body: { status: 'failed', error: 'that key has been revoked' },
    })));
    expect(await t.register({ serverUrl: 'https://x', teamKey: 'k', projectId: 'p' }))
      .toEqual({ status: 'failed', error: 'that key has been revoked' });
  });

  it('reports a 429 as a readable rate-limit message', async () => {
    const t = makeHttpsJoinTransport(fakeFetch(() => ({
      status: 429, body: { error: 'rate_limited', message: 'Rate limit exceeded (10 requests / 900s)' },
    })));
    const out = await t.register({ serverUrl: 'https://x', teamKey: 'k', projectId: 'p' });
    expect(out.status).toBe('failed');
    expect((out as any).error).toContain('too many attempts');
  });

  it('reports an unreachable server distinctly from a rejection', async () => {
    // "cannot reach it" and "reached it and was rejected" have completely
    // different fixes and the user has to know which.
    const t = makeHttpsJoinTransport((async () => { throw new Error('ECONNREFUSED'); }) as never);
    const out = await t.register({ serverUrl: 'https://x', teamKey: 'k', projectId: 'p' });
    expect(out.status).toBe('failed');
    expect((out as any).error).toContain('cannot reach');
  });

  it('survives a non-JSON error body', async () => {
    const t = makeHttpsJoinTransport((async () => ({
      status: 502, ok: false,
      json: async () => { throw new Error('not json'); },
      text: async () => '<html>bad gateway</html>',
    })) as never);
    const out = await t.register({ serverUrl: 'https://x', teamKey: 'k', projectId: 'p' });
    expect(out.status).toBe('failed');
    expect(typeof (out as any).error).toBe('string');
  });

  it('treats a 200 with no teamId as a failure, not a silent success', async () => {
    // Without teamId the caller cannot repoint anything; proceeding would flip
    // the marker into team mode naming nothing.
    const t = makeHttpsJoinTransport(fakeFetch(() => ({ status: 200, body: { status: 'joined' } })));
    const out = await t.register({ serverUrl: 'https://x', teamKey: 'k', projectId: 'p' });
    expect(out.status).toBe('failed');
  });

  it('never includes the team key in an error message', async () => {
    const t = makeHttpsJoinTransport((async () => { throw new Error('boom'); }) as never);
    const out = await t.register({ serverUrl: 'https://x', teamKey: 'super-secret', projectId: 'p' });
    expect(JSON.stringify(out)).not.toContain('super-secret');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/convert/join-transport.test.ts`
Expected: FAIL — `Cannot find module '.../join-transport-https.js'`

- [ ] **Step 3: Write the transport interface**

Create `src/server/convert/join-transport.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// How a join reaches the team: over HTTPS (preferred) or over a direct Postgres
// connection (retained for migration only — see the spec's §4.1).
//
// The Postgres path is the ONLY one that still requires a teammate to hold a
// database password, so it is deprecated and must not be offered in the
// teammate-facing UI. It is retained deliberately, for a team already converted
// against a raw Postgres URL whose owner necessarily already has that URL.

/** The outcome of registering this project under a team on the remote. */
export type JoinRegisterResult =
  | { status: 'joined'; teamId: string }
  | { status: 'failed'; error: string };

export interface JoinTransport {
  register: (input: {
    /** Base URL of the team server, e.g. https://team.example.com */
    serverUrl: string;
    /** The team's key, from the invite. */
    teamKey: string;
    /** This machine's project, about to become team-scoped. */
    projectId: string;
    projectName?: string;
  }) => Promise<JoinRegisterResult>;
}
```

- [ ] **Step 4: Write the HTTPS implementation**

Create `src/server/convert/join-transport-https.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// The HTTPS join transport — the outward hop that replaces opening a Postgres
// pool to the team database from the joiner's machine.
//
// With this, a teammate's machine holds the team KEY and nothing else: no
// database URL, no password, at any point in the project's lifecycle. (The
// steady state after joining was already HTTPS-only — flip-to-team.ts writes
// { runtime: 'server', serverUrl } and never persists a databaseUrl, and
// server-client.ts talks to serverBaseUrl with a Bearer token. The join
// handshake was the last place a database credential was needed.)
//
// The key is sent in the BODY, deliberately, not as `Authorization: Bearer`.
// As a header it would be evaluated by the auth middleware, which returns null
// for missing/revoked/expired/insufficient-scope alike → one flat 401. That
// would destroy the four distinct reasons this design exists to preserve.

import type { JoinRegisterResult, JoinTransport } from './join-transport.js';

/** True when the invite URL names an HTTP(S) endpoint rather than a database. */
export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

export function makeHttpsJoinTransport(fetchImpl: typeof fetch = fetch): JoinTransport {
  return {
    register: async ({ serverUrl, teamKey, projectId, projectName }): Promise<JoinRegisterResult> => {
      const url = `${stripTrailingSlash(serverUrl)}/v1/join/register`;
      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            teamKey,
            projectId,
            // Omit rather than send undefined, so the wire body matches the
            // route's optional-field contract exactly.
            ...(projectName ? { projectName } : {}),
          }),
        });
      } catch {
        // Distinguish "cannot reach it" from "reached it and was rejected": the
        // two have completely different fixes. Deliberately does NOT include the
        // thrown message — a fetch error can echo the request, and the request
        // contains the team key.
        return { status: 'failed', error: `cannot reach that server at ${stripTrailingSlash(serverUrl)}` };
      }

      let body: any = null;
      try { body = await response.json(); } catch { body = null; }

      if (response.status === 429) {
        return {
          status: 'failed',
          error: 'too many attempts — wait a few minutes and try again',
        };
      }

      if (response.status === 200) {
        const teamId = typeof body?.teamId === 'string' ? body.teamId.trim() : '';
        // A 200 with no teamId cannot be acted on: the caller needs it to
        // repoint the local key and marker. Treat it as a failure rather than
        // flipping into team mode naming nothing.
        if (!teamId) {
          return { status: 'failed', error: 'the server accepted the join but returned no team' };
        }
        return { status: 'joined', teamId };
      }

      // 422 carries the actionable reason; pass it through verbatim rather than
      // generalising it, because that reason is the point of the design.
      const reason = typeof body?.error === 'string' && body.error.trim()
        ? body.error
        : `the server rejected the join (HTTP ${response.status})`;
      return { status: 'failed', error: reason };
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/server/convert/join-transport.test.ts`
Expected: PASS — 14 pass, 0 fail

- [ ] **Step 6: Commit**

```bash
git add src/server/convert/join-transport.ts src/server/convert/join-transport-https.ts tests/server/convert/join-transport.test.ts
git commit -m "feat: HTTPS join transport

Replaces opening a Postgres pool to the team database from the joiner's machine.
The key travels in the body, not Authorization, so the four distinct rejection
reasons survive — as a header the auth middleware would collapse them to one
flat 401.

Passes a 422 reason through verbatim, reports unreachability distinctly from
rejection, and never echoes a thrown fetch message (it can contain the request,
and the request contains the key).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire the transport into `runJoin` and register the route

Connects Tasks 1–3. `runJoin` gains an optional `transport` dep; when the invite URL is HTTP(S) it delegates steps 2–4 and never calls `connect`.

**Files:**
- Modify: `src/server/convert/join-service.ts` (add `transport` to `JoinDeps`; branch in `runJoin`)
- Modify: `src/server/routes/v1/ServerV1PostgresRoutes.ts` (register the route; pass `transport`)
- Test: `tests/server/convert/join-over-https.test.ts`

**Interfaces:**
- Consumes: `JoinTransport` / `makeHttpsJoinTransport` / `isHttpUrl` (Task 3); `registerJoinRegisterRoute` + `JoinRegisterDeps` (Task 2); `requireJoinRateLimit` (Task 1).
- Produces: `JoinDeps.transport?: JoinTransport` — when set and `isHttpUrl(databaseUrl)`, `runJoin` uses HTTPS.

- [ ] **Step 1: Write the failing test**

Create `tests/server/convert/join-over-https.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// runJoin over HTTPS: the transport swap, and the guarantees that must survive
// it.
import { describe, it, expect } from 'bun:test';
import { runJoin } from '../../../src/server/convert/join-service.js';

const baseDeps = {
  connect: async () => { throw new Error('connect must NOT be called on the HTTPS path'); },
  hashKey: (r: string) => `H(${r})`,
  deriveServerUrl: (u: string) => u,
  upsertProject: async () => { throw new Error('upsertProject must NOT be called on the HTTPS path'); },
};

function transport(result: any, spy?: (input: any) => void) {
  return { register: async (input: any) => { spy?.(input); return result; } };
}

describe('runJoin over HTTPS', () => {
  it('joins without EVER opening a Postgres connection', async () => {
    // THE POINT OF THE WHOLE CHANGE. baseDeps.connect throws, so if runJoin
    // still reaches for Postgres this test fails loudly.
    const out = await runJoin(
      { ...baseDeps, transport: transport({ status: 'joined', teamId: 'team-1' }) } as never,
      { databaseUrl: 'https://team.example.com', apiKey: 'k1', projectId: 'p1' },
    );
    expect(out.status).toBe('joined');
    expect(out.join).toEqual({
      teamId: 'team-1', projectId: 'p1', serverUrl: 'https://team.example.com', apiKey: 'k1',
    });
  });

  it('forwards the key, project and name to the transport', async () => {
    let seen: any = null;
    await runJoin(
      { ...baseDeps, transport: transport({ status: 'joined', teamId: 't' }, i => { seen = i; }) } as never,
      { databaseUrl: 'https://x', apiKey: 'k1', projectId: 'p1', projectName: 'svc' },
    );
    expect(seen).toEqual({
      serverUrl: 'https://x', teamKey: 'k1', projectId: 'p1', projectName: 'svc',
    });
  });

  it('passes a rejection reason through unchanged', async () => {
    const out = await runJoin(
      { ...baseDeps, transport: transport({ status: 'failed', error: 'that key has expired' }) } as never,
      { databaseUrl: 'https://x', apiKey: 'k1', projectId: 'p1' },
    );
    expect(out.status).toBe('failed');
    expect(out.error).toBe('that key has expired');
  });

  it('returns NO join payload on failure, so nothing local can be flipped', async () => {
    // The ordering guarantee (spec §2.3): the marker must not flip before the
    // credential resolves, or the project sits in team mode with no key —
    // authenticated as nobody, silently dropping every observation.
    const out = await runJoin(
      { ...baseDeps, transport: transport({ status: 'failed', error: 'nope' }) } as never,
      { databaseUrl: 'https://x', apiKey: 'k1', projectId: 'p1' },
    );
    expect(out.join).toBeUndefined();
  });

  it('still uses the POSTGRES path for a postgres:// URL', async () => {
    // The fallback is retained (spec §4.1, decided) for a team already
    // converted against a raw Postgres URL.
    let connected = false, upserted = false;
    const out = await runJoin({
      connect: async () => {
        connected = true;
        return {
          query: async () => ({ rows: [{ team_id: 'team-pg', revoked_at: null, expires_at: null }] }),
          end: async () => {},
        };
      },
      hashKey: (r: string) => `H(${r})`,
      deriveServerUrl: () => 'http://127.0.0.1:38879',
      upsertProject: async () => { upserted = true; },
      transport: transport({ status: 'failed', error: 'HTTPS must not be used here' }),
    } as never, { databaseUrl: 'postgres://u:p@host:5432/db', apiKey: 'k1', projectId: 'p1' });
    expect(connected).toBe(true);
    expect(upserted).toBe(true);
    expect(out.status).toBe('joined');
    expect(out.join?.teamId).toBe('team-pg');
  });

  it('uses Postgres when no transport is supplied at all', async () => {
    // Back-compat: existing callers that never pass a transport keep working.
    let connected = false;
    const out = await runJoin({
      connect: async () => {
        connected = true;
        return {
          query: async () => ({ rows: [{ team_id: 'team-pg', revoked_at: null, expires_at: null }] }),
          end: async () => {},
        };
      },
      hashKey: (r: string) => `H(${r})`,
      deriveServerUrl: () => 'http://127.0.0.1:38879',
      upsertProject: async () => {},
    } as never, { databaseUrl: 'postgres://u:p@h:5432/d', apiKey: 'k1', projectId: 'p1' });
    expect(connected).toBe(true);
    expect(out.status).toBe('joined');
  });

  it('validates its inputs before choosing a transport', async () => {
    const a = await runJoin({ ...baseDeps, transport: transport({}) } as never,
      { databaseUrl: '', apiKey: 'k', projectId: 'p' });
    expect(a.error).toBe('database URL is required');
    const b = await runJoin({ ...baseDeps, transport: transport({}) } as never,
      { databaseUrl: 'https://x', apiKey: '', projectId: 'p' });
    expect(b.error).toBe('team key is required');
    const c = await runJoin({ ...baseDeps, transport: transport({}) } as never,
      { databaseUrl: 'https://x', apiKey: 'k', projectId: '' });
    expect(c.error).toBe('no local project to join with');
  });

  it('reports a transport that throws as a failure, not a crash', async () => {
    const out = await runJoin({
      ...baseDeps,
      transport: { register: async () => { throw new Error('kaboom'); } },
    } as never, { databaseUrl: 'https://x', apiKey: 'k1', projectId: 'p1' });
    expect(out.status).toBe('failed');
    expect(typeof out.error).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/server/convert/join-over-https.test.ts`
Expected: FAIL — the first test errors with "connect must NOT be called on the HTTPS path", because `runJoin` ignores `transport` today.

- [ ] **Step 3: Add the transport branch to `runJoin`**

In `src/server/convert/join-service.ts`, add to the `JoinDeps` interface (after the `bootstrapSchema` field):

```ts
  /**
   * Reach the remote over HTTPS instead of opening a Postgres pool.
   *
   * When present AND the invite URL is HTTP(S), steps 2-4 (verify the key,
   * verify the team, register the project) all happen server-side, so the
   * joiner never possesses a database credential. Absent — or given a
   * postgres:// URL — the direct-Postgres path below is used unchanged.
   */
  transport?: import('./join-transport.js').JoinTransport;
```

Then in `runJoin`, immediately after the three input guards and **before** `let pool: ... = null;`, insert:

```ts
  // HTTPS path: hand the whole remote interaction to the transport. Chosen by
  // the URL scheme, so an existing postgres:// invite keeps working (spec §4.1
  // — the fallback is retained deliberately).
  if (deps.transport && isHttpUrl(databaseUrl)) {
    let result: JoinRegisterResult;
    try {
      result = await deps.transport.register({
        serverUrl: databaseUrl,
        teamKey: apiKey,
        projectId: input.projectId,
        projectName: input.projectName,
      });
    } catch (err) {
      // A transport that throws must read as a failed join, not a 500.
      return { status: 'failed', error: `could not register this project: ${message(err)}` };
    }
    if (result.status !== 'joined') {
      // No `join` payload on failure: applyConvertJoin must have nothing to act
      // on, or the marker could flip into team mode with no resolvable key.
      return { status: 'failed', error: result.error };
    }
    return {
      status: 'joined',
      join: {
        teamId: result.teamId,
        projectId: input.projectId,
        // Already an HTTP(S) base URL — deriveServerUrl exists to turn a
        // DATABASE url into one, so it must not be applied here.
        serverUrl: databaseUrl.replace(/\/+$/, ''),
        apiKey,
      },
    };
  }
```

Add to the imports at the top of the file:

```ts
import { isHttpUrl } from './join-transport-https.js';
import type { JoinRegisterResult } from './join-transport.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/server/convert/join-over-https.test.ts`
Expected: PASS — 8 pass, 0 fail

- [ ] **Step 5: Verify the existing join tests still pass**

Run: `bun test tests/server/convert/join-service.test.ts tests/server/convert/join-repoints-local-key.test.ts tests/server/convert/apply-join.test.ts`
Expected: PASS, no new failures. The Postgres path is untouched.

- [ ] **Step 6: Register the route and pass the transport**

In `src/server/routes/v1/ServerV1PostgresRoutes.ts`, add these imports alongside the existing `./ConvertRoutes.js` import:

```ts
import { registerJoinRegisterRoute } from './JoinRegisterRoute.js';
import { requireJoinRateLimit } from '../../middleware/join-rate-limit-subject.js';
import { makeHttpsJoinTransport } from '../../convert/join-transport-https.js';
```

In the `join:` dep passed to `registerConvertRoutes` (around line 1682), add the transport to the object literal handed to `runJoin`, next to the existing `bootstrapSchema` entry:

```ts
          // Prefer HTTPS: with it the joiner needs only the team key and never a
          // database password. isHttpUrl inside runJoin decides per invite, so a
          // postgres:// invite still takes the retained fallback.
          transport: makeHttpsJoinTransport(),
```

Then, immediately after the `registerConvertRoutes(app, { ... });` call closes, add:

```ts
    // The REMOTE half of join-over-HTTPS. Unauthenticated by design (the team
    // key is a body parameter so the four rejection reasons stay distinct), so
    // the rate limiter is mandatory rather than optional here.
    registerJoinRegisterRoute(app, {
      rateLimit: [requireJoinRateLimit(
        this.options.pool,
        { windowSec: 900, max: 10 },
        (raw) => createHash('sha256').update(raw).digest('hex'),
      )],
      hashKey: (raw) => createHash('sha256').update(raw).digest('hex'),
      lookupKey: async (keyHash) => {
        const r = await this.options.pool.query(
          'SELECT team_id, revoked_at, expires_at FROM api_keys WHERE key_hash = $1 LIMIT 1',
          [keyHash],
        );
        const row = r.rows[0] as { team_id: string | null; revoked_at: Date | null; expires_at: Date | null } | undefined;
        if (!row) return null;
        return { teamId: row.team_id, revokedAt: row.revoked_at, expiresAt: row.expires_at };
      },
      upsertProject: async (teamId, projectId, name) => {
        await upsertTeamAndProject(this.options.pool, teamId, projectId, name);
      },
    });
```

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npx tsc --noEmit 2>&1 | grep -v "bun:test\|ZodTypeAny\|import.meta.dir\|Cannot find name 'Bun'" | head -20`
Expected: no output relating to the new files.

Run: `bun test 2>&1 | tail -5`
Expected: failure count **≤ 13** (the baseline). If higher, find which test regressed and fix it before committing.

- [ ] **Step 8: Commit**

```bash
git add src/server/convert/join-service.ts src/server/routes/v1/ServerV1PostgresRoutes.ts tests/server/convert/join-over-https.test.ts
git commit -m "feat: use the HTTPS transport for joins; register /v1/join/register

runJoin gains an optional transport dep and picks it by URL scheme, so an
https:// invite never opens a Postgres connection while a postgres:// invite
takes the retained fallback unchanged. On failure no join payload is returned,
preserving the ordering guarantee that the marker never flips before the
credential resolves.

The remote route is registered with a MANDATORY rate limiter, since it is
unauthenticated by design.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Guard the no-database-password invariant

The spec's central claim is that a teammate's machine never holds a database credential. It is true today, but `writeServerModeSettings` (`src/server/convert/settings-writer.ts:13`) writes `MEMSMITH_SERVER_DATABASE_URL` to `~/.memsmith/settings.json` and has zero call sites. If a future change wires it into the join path, the claim silently becomes false.

**Important — test the function the join path actually calls.** The join path applies its result through **`applyConvertJoin`** (`src/server/convert/apply-join.ts:31`), *not* through `flipToTeam`. `apply-join.ts:11-15` records why: the server used to do this itself via `flipToTeam(cwd, …)`, which only worked because local and server were the same machine, and used the *server's* cwd — so converting one project could flip another's marker. `flipToTeam` still exists and still carries its `writeGlobalSettings` spy hook, but asserting on it would guard a path join never takes: a test that passes while protecting nothing.

**Files:**
- Test: `tests/server/convert/join-writes-no-db-credential.test.ts`

**Interfaces:**
- Consumes: `applyConvertJoin(deps: ApplyJoinDeps, cwd: string, join: ConvertJoinInfo): ApplyJoinResult` from `src/server/convert/apply-join.js`, where `ApplyJoinDeps` is `{ readProjectMarker, writeProjectRuntime, storeKeyForTeam }` and `writeProjectRuntime` receives `{ runtime: 'local' | 'server'; serverUrl?: string; teamId?: string }`.
- Produces: no source changes — a regression guard only.

- [ ] **Step 1: Write the test**

Create `tests/server/convert/join-writes-no-db-credential.test.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0
//
// THE CENTRAL SECURITY CLAIM of join-over-HTTPS: a teammate's machine never
// holds a database credential, at any point in the project's lifecycle.
//
// It is true today, but it sits next to a loaded gun. settings-writer.ts
// writeServerModeSettings() persists MEMSMITH_SERVER_DATABASE_URL into
// ~/.memsmith/settings.json, and it currently has ZERO call sites. If a future
// change wires it into the join path, every teammate would get a database
// password on disk and nothing else would notice.
//
// These assert on applyConvertJoin — the function the JOIN path actually calls
// (ServerV1PostgresRoutes wires it in the join success branch). NOT flipToTeam:
// apply-join.ts:11-15 records that the server used to flip via flipToTeam(cwd,…)
// and that it was wrong, because it used the SERVER's cwd. Asserting on
// flipToTeam would guard a path join never takes.
import { describe, it, expect } from 'bun:test';
import { applyConvertJoin } from '../../../src/server/convert/apply-join.js';

const JOIN = {
  teamId: 'team-1',
  projectId: 'p1',
  serverUrl: 'https://team.example.com',
  apiKey: 'super-secret-key',
};
const MARKER = { projectId: 'p1', teamId: 'old-team' };

describe('the join path writes no database credential', () => {
  it('writes a marker containing no credential and no database URL', async () => {
    let written: any = null;
    const out = applyConvertJoin(
      {
        readProjectMarker: () => MARKER,
        writeProjectRuntime: (_cwd, runtime) => { written = runtime; },
        storeKeyForTeam: () => {},
      },
      '/tmp/p',
      JOIN as never,
    );
    expect(out.applied).toBe(true);
    const json = JSON.stringify(written);
    expect(json).not.toContain('super-secret-key');
    expect(json).not.toContain('postgres://');
    expect(json).not.toContain('password');
    expect(written.runtime).toBe('server');
    // The marker legitimately carries the team and the HTTP server URL.
    expect(written.teamId).toBe('team-1');
    expect(written.serverUrl).toBe('https://team.example.com');
  });

  it('routes the key to the CredentialStore and nowhere else', async () => {
    const stored: Array<[string, string]> = [];
    let written: any = null;
    applyConvertJoin(
      {
        readProjectMarker: () => MARKER,
        writeProjectRuntime: (_cwd, runtime) => { written = runtime; },
        storeKeyForTeam: (teamId, key) => { stored.push([teamId, key]); },
      },
      '/tmp/p',
      JOIN as never,
    );
    // Cached under the NEW team — buildServerContext looks the key up by the
    // marker's teamId, so caching under the old team would leave the project in
    // team mode with no resolvable credential.
    expect(stored).toEqual([['team-1', 'super-secret-key']]);
    expect(JSON.stringify(written)).not.toContain('super-secret-key');
  });

  it('refuses to flip when the join carries no key, so no half state is written', async () => {
    // The ordering guarantee: selectRuntime() follows the marker on its very
    // next call, so a marker written without a resolvable key means team mode
    // authenticated as nobody, silently dropping every observation.
    let wrote = false;
    const out = applyConvertJoin(
      {
        readProjectMarker: () => MARKER,
        writeProjectRuntime: () => { wrote = true; },
        storeKeyForTeam: () => {},
      },
      '/tmp/p',
      { ...JOIN, apiKey: '' } as never,
    );
    expect(out.applied).toBe(false);
    expect(wrote).toBe(false);
  });

  it('writeServerModeSettings has no call sites in src/', async () => {
    // The structural guard. A grep-based test is unusual, but this invariant is
    // about the ABSENCE of a call anywhere in the tree, which no unit test of a
    // single module can express.
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        if (p.endsWith('settings-writer.ts')) continue; // its own definition
        const text = readFileSync(p, 'utf8');
        if (text.includes('writeServerModeSettings(')) hits.push(p);
      }
    };
    walk('src');
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test tests/server/convert/join-writes-no-db-credential.test.ts`
Expected: PASS — 4 pass, 0 fail. These assert existing behaviour, so they should pass immediately. **If the `writeServerModeSettings` call-site test fails, stop** — something already calls it, which means the spec's §4.2 claim is false. Report it rather than deleting the test.

- [ ] **Step 3: Commit**

```bash
git add tests/server/convert/join-writes-no-db-credential.test.ts
git commit -m "test: guard the no-database-password invariant on the join path

The central claim of join-over-HTTPS is that a teammate's machine never holds a
database credential. writeServerModeSettings writes
MEMSMITH_SERVER_DATABASE_URL to ~/.memsmith/settings.json and has zero call
sites; wiring it into join would silently falsify that claim.

Asserts on applyConvertJoin — the function the join path actually calls — rather
than flipToTeam, which apply-join.ts records as the wrong, superseded path. Adds
a tree-wide check that no call site exists.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Secrets Manager in the deploy doc

`docs/deploy/aws.md:175` embeds the database password inline as a plaintext `value` in the Fargate task definition, where it is readable by anyone with `ecs:DescribeTaskDefinition`. No application code changes — the server already reads `MEMSMITH_SERVER_DATABASE_URL` from the environment, and ECS resolves `valueFrom` into an env var at task start.

**Files:**
- Modify: `docs/deploy/aws.md` (the task-definition block at ~line 175, and the env reference table at ~line 277)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Read the current task definition block**

Run: `sed -n '160,200p' docs/deploy/aws.md`
Confirm line ~175 contains `"name": "MEMSMITH_SERVER_DATABASE_URL", "value": "postgresql://cmem:YOUR_DB_PASSWORD@..."` inside an `environment` array.

- [ ] **Step 2: Replace the inline password with a Secrets Manager reference**

Remove the `MEMSMITH_SERVER_DATABASE_URL` entry from the `environment` array and add a sibling `secrets` array to the same container definition:

```json
      "secrets": [
        {
          "name": "MEMSMITH_SERVER_DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:memsmith/db-url"
        }
      ],
```

Add this prose immediately before the JSON block:

```markdown
**The database URL must not be inlined here.** A value in `environment` is
plaintext in the task definition and readable by anyone with
`ecs:DescribeTaskDefinition`. Put it in Secrets Manager and reference it from
`secrets` — ECS resolves `valueFrom` at task start and injects it as an ordinary
environment variable, so the application sees exactly what it would have seen
either way. No code change is required.

Create the secret and grant access first:

```bash
aws secretsmanager create-secret \
  --name memsmith/db-url \
  --secret-string 'postgresql://cmem:YOUR_DB_PASSWORD@memsmith-prod.abcdefghijk.us-east-1.rds.amazonaws.com:5432/memsmith'
```

The grant goes on the **task execution role** (the role ECS itself uses to start
the task), not the task role — a common mix-up that surfaces as
`ResourceInitializationError` at startup:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue"],
    "Resource": "arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:memsmith/db-url-*"
  }]
}
```

Rotation is deliberately out of scope: env-var injection is the smallest change
that removes the plaintext password, and rotation can be added later without
touching application code.
```

- [ ] **Step 3: Update the environment reference table**

At the `MEMSMITH_SERVER_DATABASE_URL` row (~line 277), change the description to note the delivery mechanism:

```markdown
| `MEMSMITH_SERVER_DATABASE_URL` | — | Postgres connection string (required). In AWS, inject from Secrets Manager via the task definition's `secrets`/`valueFrom` — never inline it in `environment`. |
```

- [ ] **Step 4: Verify no plaintext password remains**

Run: `grep -n "YOUR_DB_PASSWORD" docs/deploy/aws.md`
Expected: matches only inside the `aws secretsmanager create-secret` command (where it is a placeholder the operator replaces) — **not** inside any task-definition `environment` array.

- [ ] **Step 5: Commit**

```bash
git add docs/deploy/aws.md
git commit -m "docs(deploy): inject the database URL from Secrets Manager

The task definition embedded the password inline as a plaintext environment
value, readable by anyone with ecs:DescribeTaskDefinition. Moves it to
secrets/valueFrom, which ECS resolves at task start and injects as an ordinary
env var — so no application code changes.

Notes that the IAM grant belongs on the task EXECUTION role, since putting it on
the task role instead surfaces as ResourceInitializationError at startup.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Integration verification (requires two servers — cannot be skipped silently)

Per spec §4.3, `deriveServerUrl` hard-codes `:38879` for localhost and **drops the port** for non-localhost hosts, so a second local server is only reachable if `existingServerUrl` is threaded through. Booting a second server alone is not enough — a test that relies on `deriveServerUrl` silently addresses the *first* server and reports a false pass.

- [ ] Start a second server on a different port: `MEMSMITH_SERVER_PORT=38880 node <server entry>`
- [ ] Drive the join with the second server's URL passed explicitly as `databaseUrl: 'http://127.0.0.1:38880'` — the HTTPS transport uses it verbatim (`isHttpUrl` is true), so `deriveServerUrl` is bypassed entirely on this path.
- [ ] Assert on the joiner: marker `teamId` matches the remote's team; `~/.memsmith/credentials.json` holds the key; `.memsmith/project.json` contains **no** credential and no `postgres://`.
- [ ] Assert the joiner can read a teammate's observation (team-wide reads, already shipped) and write its own (the `repointProjectDatabaseTeam` FK-anchor path).
- [ ] **Do not claim "verified end to end" without this.** Two projects on one server is not two machines — that exact false claim was made earlier in this project.

**Known gap that only AWS can close:** the local rig exercises `http` on a nonstandard port; production is `https` on 443 via `deriveServerUrl` branch 3 (`https://${host}`, no port). The production URL-shaping branch is **not** the branch these tests cover. Smoke-test it first once AWS exists, before trusting anything else (spec §7.1).

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| §2.1 key in body, not Bearer | Task 2 (route), Task 3 (no Authorization header test) |
| §2.2 components | Tasks 1–6 |
| §2.3 ordering guarantee | Task 4 (no `join` payload on failure) |
| §3.1 handler logic, four checks | Task 2 |
| §3.2 rate limiting, reuse + fail-open | Task 1 |
| §3.3 `projectId` from body | Task 2 (ignores body `teamId`; cross-team guard) |
| §3.4 no role gate | Task 2 (route takes no role middleware) |
| §4.1 fallback retained | Task 4 (postgres:// path tests) |
| §4.2 no DB credential ever | Task 5 |
| §4.3 rig limitation | Integration section |
| §5 testing | Tasks 1–5 |
| §6 Secrets Manager | Task 6 |
| §7.1 AWS boundary | Integration section |
| §8 invariants | Tasks 2, 3, 5 |

No gaps.

**2. Placeholder scan** — no `TBD`/`TODO`; every code step carries complete code; no "similar to Task N".

**3. Type consistency** — `JoinRegisterResult` (Task 3) is what Task 4 imports; `JoinTransport.register` takes `{ serverUrl, teamKey, projectId, projectName? }` in Tasks 3 and 4 identically; `JoinKeyRow` uses `teamId`/`revokedAt`/`expiresAt` in both the Task 2 interface and the Task 4 `lookupKey` mapping from snake_case columns; `joinRateLimitSubject(body, clientIp, hashKey)` and `requireJoinRateLimit(pool, opts, hashKey)` match between Task 1 and Task 4's call site.

One deliberate note: Task 4's HTTPS branch does **not** call `deps.deriveServerUrl`, because the invite URL is already an HTTP base URL — `deriveServerUrl` exists to convert a *database* URL. Applying it would rewrite a valid `https://team.example.com` into `https://team.example.com` only by luck and would mangle a nonstandard port.
