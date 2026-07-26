// SPDX-License-Identifier: Apache-2.0
//
// Opt-in integration test: proves per-request database routing end-to-end —
// two different projects hitting ONE running ServerService over real HTTP
// land in SEPARATE Postgres databases and cannot see each other's data. This
// is the exact P3 gap that motivated the per-request-db-routing feature (a
// second local project previously rode the first project's database).
//
// Run with: MEMSMITH_TEST_REQROUTE=1 bun test tests/server/runtime/per-request-isolation-integration.test.ts
// Without opt-in: 0 tests registered — clean skip, no PG, no HTTP server, no crash.
import { describe, it, expect, afterAll } from 'bun:test';
import { randomUUID, createHash } from 'crypto';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { rmSync, mkdirSync } from 'fs';

const OPT_IN = process.env.MEMSMITH_TEST_REQROUTE === '1';
const DATA_DIR = join(tmpdir(), `ms-reqroute-${randomUUID()}`);
// Non-dogfood, non-colliding port. Dogfood PG is 55433 (HTTP :38879); other
// opt-in integration tests already claim 55450 (coldboot) and 55451
// (db-per-project) — this suite gets 55452.
const PG_PORT = 55452;
const HTTP_TEST_PORT_GUARD = 38879; // the dogfood HTTP port — never bind this.
// Fixed throwaway HTTP port for THIS test's ServerService. getServerPort()
// (src/server/runtime/ServerService.ts) requires MEMSMITH_SERVER_PORT to
// parse as an integer > 0, so '0' (OS-assigned) is rejected and it falls
// back to the UID-derived default — which can collide with a real running
// dogfood server. Using an explicit, clearly-non-default literal instead.
const HTTP_TEST_PORT = 48879;

if (OPT_IN) {
  // HARD dogfood guards — must be verified before any PG/HTTP interaction.
  // These throw at MODULE LOAD, before any test body runs, so a misconfigured
  // opt-in can never reach a live resource.
  if (DATA_DIR.includes('/.memsmith')) {
    throw new Error('BUG: DATA_DIR points into ~/.memsmith — refusing to run');
  }
  if (String(PG_PORT) === '55433') {
    throw new Error('BUG: PG_PORT matches the dogfood Postgres port — refusing to run');
  }
  if (PG_PORT === HTTP_TEST_PORT_GUARD) {
    throw new Error('BUG: PG_PORT collides with the dogfood HTTP port literal — refusing to run');
  }
  if (HTTP_TEST_PORT === HTTP_TEST_PORT_GUARD) {
    throw new Error('BUG: HTTP_TEST_PORT matches the dogfood HTTP port — refusing to run');
  }

  // CRITICAL DOGFOOD GUARD: src/shared/paths.ts computes DATA_DIR = a
  // module-level `const` (resolveDataDir()) evaluated on that module's FIRST
  // import in this process — it defaults to the real ~/.memsmith when
  // MEMSMITH_DATA_DIR is unset. ServerService.start()/stop() (called by
  // createServerService(), used below) persists pid/port/runtime state via
  // paths.serverPid()/serverPort()/serverRuntime() UNLESS constructed with
  // persistRuntimeState:false — an option createServerService() does not
  // expose. Left unset, a successful run of this test would overwrite the
  // REAL dogfood server's ~/.memsmith/.server-beta.{pid,port,runtime.json}
  // while it is live on :38879. Setting MEMSMITH_DATA_DIR here — at module
  // scope, before any dynamic import below ever runs, and before this test
  // file's own static imports (bun:test/crypto/path/os/fs) could transitively
  // load paths.ts — redirects ALL of this test's on-disk state (pid/port/
  // runtime files included) into the throwaway DATA_DIR instead.
  if (!process.env.MEMSMITH_DATA_DIR) {
    process.env.MEMSMITH_DATA_DIR = DATA_DIR;
  }
  if (!process.env.MEMSMITH_DATA_DIR.includes(tmpdir()) || process.env.MEMSMITH_DATA_DIR.includes('/.memsmith')) {
    throw new Error(
      `BUG: MEMSMITH_DATA_DIR (${process.env.MEMSMITH_DATA_DIR}) is not a throwaway tmp path — refusing to run`,
    );
  }

  let manager: import('../../../src/server/runtime/EmbeddedPostgresManager.js').EmbeddedPostgresManager | null = null;
  let service: import('../../../src/server/runtime/ServerService.js').ServerService | null = null;
  let adminPool: import('pg').Pool | null = null;

  afterAll(async () => {
    if (service) {
      try { await service.stop(); } catch { /* best-effort */ }
    }
    if (adminPool) {
      try { await adminPool.end(); } catch { /* best-effort */ }
    }
    if (manager) {
      try { await manager.stop(); } catch { /* best-effort */ }
    }
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  describe('two-project per-request database isolation (opt-in integration, HTTP surface)', () => {
    it(
      'boots a real ServerService over HTTP against a throwaway PG; two local-dev projects write/read through the full auth -> resolveRequestDatabase -> handler chain and land in physically separate msp_* databases',
      async () => {
        // Hard guards inside the test body as well — belt and suspenders.
        expect(DATA_DIR.includes('/.memsmith')).toBe(false);
        expect(String(PG_PORT)).not.toBe('55433');

        const { EmbeddedPostgresManager } = await import('../../../src/server/runtime/EmbeddedPostgresManager.js');
        const { createServerService } = await import('../../../src/server/runtime/create-server-service.js');
        const pg = (await import('pg')).default;

        const throwawayDataDir = join(DATA_DIR, 'pgdata');
        const throwawayPidFile = join(DATA_DIR, 'local-pg.pid');
        // Reuse the already-downloaded PG binaries (read-only; never the
        // dogfood's pgdata/pid) — mirrors local-database-per-project-integration.test.ts
        // so this test doesn't re-download tens of MB of binaries per run.
        const existingBinariesDir = join(homedir(), '.memsmith', 'pg-binaries');

        mkdirSync(DATA_DIR, { recursive: true });

        manager = new EmbeddedPostgresManager({
          paths: {
            binariesDir: existingBinariesDir,
            dataDir: throwawayDataDir,
            pidFile: throwawayPidFile,
          },
          port: PG_PORT,
        });

        const { connectionString } = await manager.start();
        expect(connectionString).toContain(String(PG_PORT));

        // Admin/base pool — targets the base 'postgres' database, same as
        // production's base pool. createServerService() will bootstrap schema
        // on this pool and use it as the base database for routing (any
        // project whose id equals baseProjectId would route here; neither of
        // our two test projects does, so both provision their own msp_* DB).
        adminPool = new pg.Pool({ connectionString, max: 5 });

        // Env wiring for createServerService(): point it at our throwaway PG,
        // force local-dev auth + loopback bypass (so the test can authenticate
        // without minting real API keys), and disable generation/queueing so
        // no BullMQ/Redis/provider config is required for this DB-routing proof.
        //
        // DOGFOOD-LEAK GUARD: createServerService() resolves localDevTeamId via
        // readLocalScopeFromMarkerOrEnv(process.env.MEMSMITH_PROJECT_CWD ??
        // process.cwd()). Without an override, that reads THIS repo's real
        // <repo-root>/.memsmith/project.json marker and would attribute test
        // writes (teamId column) to the actual dogfood team. Setting
        // MEMSMITH_LOCAL_DEV_TEAM_ID/_PROJECT_ID short-circuits that lookup
        // (env wins over the marker unconditionally — see
        // src/server/runtime/resolve-local-scope.ts) with synthetic test-only
        // values, so the marker file is never read.
        const fallbackTeamId = randomUUID();
        const fallbackProjectId = randomUUID();
        const prevEnv = {
          MEMSMITH_SERVER_DATABASE_URL: process.env.MEMSMITH_SERVER_DATABASE_URL,
          MEMSMITH_AUTH_MODE: process.env.MEMSMITH_AUTH_MODE,
          MEMSMITH_ALLOW_LOCAL_DEV_BYPASS: process.env.MEMSMITH_ALLOW_LOCAL_DEV_BYPASS,
          MEMSMITH_GENERATION_DISABLED: process.env.MEMSMITH_GENERATION_DISABLED,
          MEMSMITH_QUEUE_ENGINE: process.env.MEMSMITH_QUEUE_ENGINE,
          MEMSMITH_LOCAL_DEV_TEAM_ID: process.env.MEMSMITH_LOCAL_DEV_TEAM_ID,
          MEMSMITH_LOCAL_DEV_PROJECT_ID: process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID,
          MEMSMITH_SERVER_PORT: process.env.MEMSMITH_SERVER_PORT,
        };
        process.env.MEMSMITH_SERVER_DATABASE_URL = connectionString;
        process.env.MEMSMITH_AUTH_MODE = 'local-dev';
        process.env.MEMSMITH_ALLOW_LOCAL_DEV_BYPASS = '1';
        process.env.MEMSMITH_GENERATION_DISABLED = '1';
        process.env.MEMSMITH_QUEUE_ENGINE = 'inline';
        process.env.MEMSMITH_LOCAL_DEV_TEAM_ID = fallbackTeamId;
        process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID = fallbackProjectId;
        // ServerService (built inside createServerService()) has no port
        // option threaded through createServerService's own options — it
        // reads getServerPort(), which reads MEMSMITH_SERVER_PORT (must parse
        // as an integer > 0; '0' is rejected and falls back to the UID-
        // derived default, which can collide with a real running dogfood
        // server). Force the fixed throwaway HTTP_TEST_PORT instead.
        process.env.MEMSMITH_SERVER_PORT = String(HTTP_TEST_PORT);

        try {
          service = await createServerService({
            pool: adminPool,
            authMode: 'local-dev',
            bootstrapSchema: true,
            generationDisabled: true,
          });
          await service.start();
        } finally {
          // Restore env immediately after boot so other tests sharing this
          // process are unaffected — the running service captured what it
          // needed already.
          restoreEnv(prevEnv);
        }

        const runtimeState = service!.getRuntimeState();
        const port = runtimeState.port;
        expect(port).not.toBe(HTTP_TEST_PORT_GUARD);
        const base = `http://127.0.0.1:${port}`;

        const projectA = randomUUID();
        const projectB = randomUUID();

        // --- Step 1: write one observation as project A, one as project B ---
        // The local-dev bypass (loopback + MEMSMITH_AUTH_MODE=local-dev +
        // MEMSMITH_ALLOW_LOCAL_DEV_BYPASS=1) adopts body.projectId into
        // authContext.projectId (Task 3), which resolveRequestDatabase (Task 4)
        // then uses — and ONLY that — to pick the database (Task 5/6 proof).
        const memA = await postJson(base, '/v1/memories', {
          projectId: projectA,
          content: 'Observation in project A',
        });
        expect(memA.status).toBe(201);
        const memABody = await memA.json() as { memory: { id: string; projectId: string } };
        expect(memABody.memory.projectId).toBe(projectA);
        const obsIdA = memABody.memory.id;

        const memB = await postJson(base, '/v1/memories', {
          projectId: projectB,
          content: 'Observation in project B',
        });
        expect(memB.status).toBe(201);
        const memBBody = await memB.json() as { memory: { id: string; projectId: string } };
        expect(memBBody.memory.projectId).toBe(projectB);
        const obsIdB = memBBody.memory.id;

        expect(obsIdA).not.toBe(obsIdB);

        // --- Assertion 1: cross-project invisibility (the core proof) ---
        // Read back as A (body.projectId=A) — must see ONLY A's observation.
        const searchA = await postJson(base, '/v1/search', { projectId: projectA, query: '' });
        expect(searchA.status).toBe(200);
        const searchABody = await searchA.json() as { observations: Array<{ id: string; projectId: string }> };
        const idsSeenByA = searchABody.observations.map(o => o.id);
        expect(idsSeenByA).toContain(obsIdA);
        expect(idsSeenByA).not.toContain(obsIdB);
        expect(searchABody.observations.every(o => o.projectId === projectA)).toBe(true);

        // Read back as B (body.projectId=B) — must see ONLY B's observation,
        // and A's row must be totally absent.
        const searchB = await postJson(base, '/v1/search', { projectId: projectB, query: '' });
        expect(searchB.status).toBe(200);
        const searchBBody = await searchB.json() as { observations: Array<{ id: string; projectId: string }> };
        const idsSeenByB = searchBBody.observations.map(o => o.id);
        expect(idsSeenByB).toContain(obsIdB);
        expect(idsSeenByB).not.toContain(obsIdA);
        expect(searchBBody.observations.every(o => o.projectId === projectB)).toBe(true);

        // --- Assertion 2: two distinct msp_* databases actually exist ---
        const dbNameA = `msp_${projectA.replace(/-/g, '')}`;
        const dbNameB = `msp_${projectB.replace(/-/g, '')}`;
        expect(dbNameA).not.toBe(dbNameB);
        const dbRows = await adminPool.query(
          'SELECT datname FROM pg_database WHERE datname = ANY($1::text[])',
          [[dbNameA, dbNameB]],
        );
        const foundNames = (dbRows.rows as Array<{ datname: string }>).map(r => r.datname).sort();
        expect(foundNames).toEqual([dbNameA, dbNameB].sort());

        // --- Assertion 3: security guard — query-string projectId is NEVER
        // consulted for routing. This must be proven via api-key auth, NOT
        // the local-dev bypass: the bypass itself legitimately reads
        // req.query.projectId as a documented fallback (Task 3 — "adopts the
        // request's projectId ... body, then query"), so a local-dev request
        // with a query-string projectId and no body projectId would
        // correctly fold that value INTO authContext, making it a poor probe
        // for this invariant. An api-key's authContext.projectId instead
        // comes ONLY from the authenticated `api_keys` row (verifyPostgresApiKey,
        // never from req.query/req.body), so a real key scoped to project A
        // plus a conflicting ?projectId=B in the URL is a clean test that the
        // ONLY thing resolveRequestDatabase ever consults is authContext.
        //
        // Seed teams/projects hinge rows for A and B directly in the BASE
        // database (api_keys' FK target) so createApiKey's ownership check
        // passes, then mint a real key scoped to project A.
        await adminPool.query('INSERT INTO teams (id, name) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING', [fallbackTeamId]);
        await adminPool.query(
          'INSERT INTO projects (id, team_id, name) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING',
          [projectA, fallbackTeamId],
        );
        const { PostgresAuthRepository } = await import('../../../src/storage/postgres/auth.js');
        const authRepo = new PostgresAuthRepository(adminPool);
        const rawApiKeyA = `cmem_test_${randomUUID().replace(/-/g, '')}`;
        const keyHashA = createHash('sha256').update(rawApiKeyA).digest('hex');
        await authRepo.createApiKey({
          keyHash: keyHashA,
          teamId: fallbackTeamId,
          projectId: projectA,
          actorId: 'test:per-request-isolation',
          scopes: ['memories:read', 'memories:write'],
        });

        // Conflicting ?projectId=B in the query string; NO body.projectId at
        // all (so there is nothing for ensureProjectAllowed to compare
        // against — the ONLY signal for scoping is the key's own project, A).
        const conflictingQueryRes = await fetch(`${base}/v1/search?projectId=${projectB}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${rawApiKeyA}`,
          },
          body: JSON.stringify({ query: '' }),
        });
        expect(conflictingQueryRes.status).toBe(200);
        const conflictingQueryBody = await conflictingQueryRes.json() as {
          observations: Array<{ id: string; projectId: string }>;
        };
        const idsFromConflictingQuery = conflictingQueryBody.observations.map(o => o.id);
        // Must read A's database (the key's own project): A's row present,
        // B's row absent — proving resolveRequestDatabase routed on
        // authContext.projectId (=A, from the key) and never on
        // req.query.projectId (=B, the attacker-controlled bait).
        expect(idsFromConflictingQuery).toContain(obsIdA);
        expect(idsFromConflictingQuery).not.toContain(obsIdB);
        expect(conflictingQueryBody.observations.every(o => o.projectId === projectA)).toBe(true);

        // --- Assertion 4: provisioning is idempotent ---
        // A second write as project A must not error and must not create a
        // duplicate database — pg_database still has exactly one row for A.
        const memA2 = await postJson(base, '/v1/memories', {
          projectId: projectA,
          content: 'Second observation in project A',
        });
        expect(memA2.status).toBe(201);
        const memA2Body = await memA2.json() as { memory: { id: string; projectId: string } };
        expect(memA2Body.memory.projectId).toBe(projectA);

        const dbCountA = await adminPool.query(
          'SELECT count(*) AS n FROM pg_database WHERE datname = $1',
          [dbNameA],
        );
        expect(Number((dbCountA.rows[0] as { n: string }).n)).toBe(1);

        // And A now sees both of its own observations, still with zero
        // cross-contamination from B.
        const searchA2 = await postJson(base, '/v1/search', { projectId: projectA, query: '' });
        const searchA2Body = await searchA2.json() as { observations: Array<{ id: string; projectId: string }> };
        const idsSeenByA2 = searchA2Body.observations.map(o => o.id);
        expect(idsSeenByA2).toContain(obsIdA);
        expect(idsSeenByA2).toContain(memA2Body.memory.id);
        expect(idsSeenByA2).not.toContain(obsIdB);
      },
      120_000,
    );
  });
} else {
  // No opt-in: register nothing. `bun test` sees zero tests from this file.
}

async function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: '127.0.0.1',
    },
    body: JSON.stringify(body),
  });
}

function restoreEnv(prev: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
