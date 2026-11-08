// SPDX-License-Identifier: Apache-2.0
//
// Opt-in: merges and prunes real local projects on a throwaway embedded
// Postgres, then searches through the real /v1/search route.
//
// Run with: MEMSMITH_TEST_PROJECTS_MERGE=1 bun test tests/server/runtime/projects-merge-integration.test.ts
import { describe, it, expect, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

const OPT_IN = process.env.MEMSMITH_TEST_PROJECTS_MERGE === '1';
const DATA_DIR = join(tmpdir(), `ms-merge-${randomUUID()}`);
const PG_PORT = 55454;
const HTTP_TEST_PORT = 48881;

if (OPT_IN) {
  if (DATA_DIR.includes('/.memsmith') || PG_PORT === 55433 || HTTP_TEST_PORT === 38879) {
    throw new Error('BUG: integration test would touch the live install — refusing to run');
  }
  if (!process.env.MEMSMITH_DATA_DIR) process.env.MEMSMITH_DATA_DIR = DATA_DIR;
  if (!process.env.MEMSMITH_DATA_DIR.includes(tmpdir())) {
    throw new Error(`BUG: MEMSMITH_DATA_DIR (${process.env.MEMSMITH_DATA_DIR}) is not a throwaway path — refusing to run`);
  }

  type Pool = import('pg').Pool;
  let manager: import('../../../src/server/runtime/EmbeddedPostgresManager.js').EmbeddedPostgresManager | null = null;
  let service: import('../../../src/server/runtime/ServerService.js').ServerService | null = null;
  const pools: Pool[] = [];

  afterAll(async () => {
    if (service) await service.stop().catch(() => {});
    for (const p of pools) await p.end().catch(() => {});
    if (manager) await manager.stop().catch(() => {});
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const msp = (id: string) => `msp_${id.replace(/-/g, '')}`;
  const vector = (seed: number) => `[${Array.from({ length: 384 }, (_, i) => ((i * seed) % 97) / 97).join(',')}]`;

  function marker(dir: string, teamId: string, projectId: string, extra: object = {}) {
    mkdirSync(join(dir, '.memsmith'), { recursive: true });
    writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify({ teamId, projectId, note: 'n', ...extra }));
  }

  async function postJson(base: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: '127.0.0.1' },
      body: JSON.stringify(body),
    });
  }

  describe('memsmith merge and prune (opt-in integration)', () => {
    it('folds one local project into another, keeps the source, and prunes with backups', async () => {
      const { EmbeddedPostgresManager } = await import('../../../src/server/runtime/EmbeddedPostgresManager.js');
      const { createServerService } = await import('../../../src/server/runtime/create-server-service.js');
      const { bootstrapServerPostgresSchema } = await import('../../../src/storage/postgres/schema.js');
      const { ProjectsDb } = await import('../../../src/services/projects/projects-db.js');
      const { pgDumpWith } = await import('../../../src/services/projects/backup.js');
      const { runMergeCommand, runProjectsCommand } = await import('../../../src/npx-cli/commands/projects.js');
      const pg = (await import('pg')).default;

      mkdirSync(DATA_DIR, { recursive: true });
      const binaries = join(homedir(), '.memsmith', 'pg-binaries');
      manager = new EmbeddedPostgresManager({
        paths: { binariesDir: binaries, dataDir: join(DATA_DIR, 'pgdata'), pidFile: join(DATA_DIR, 'local-pg.pid') },
        port: PG_PORT,
      });
      const { connectionString } = await manager.start();
      expect(connectionString).toContain(`:${PG_PORT}/`);
      expect(connectionString).not.toContain(':55433');
      const pool = (db: string) => {
        const u = new URL(connectionString);
        u.pathname = `/${db}`;
        const p = new pg.Pool({ connectionString: u.toString(), max: 3 });
        pools.push(p);
        return p;
      };
      const base = pool('postgres');

      const teamB = randomUUID();
      const teamA = randomUUID();
      const [A, B, E, F, G, T] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const home = realpathSync(mkdtemp('home'));
      const rootB = join(home, 'work', 'app');
      const folderA = join(rootB, 'packages', 'cli');
      const folderE = join(home, 'notes');
      const folderT = join(home, 'shared');
      mkdirSync(join(rootB, '.git'), { recursive: true });
      for (const d of [folderA, folderE, folderT]) mkdirSync(d, { recursive: true });
      marker(rootB, teamB, B, { databaseName: msp(B) });
      marker(folderA, teamA, A, { databaseName: msp(A) });
      marker(folderE, teamB, E);
      marker(folderT, teamA, T, { runtime: 'server', serverUrl: 'https://team.example.com' });

      process.env.MEMSMITH_SERVER_DATABASE_URL = connectionString;
      expect(process.env.MEMSMITH_SERVER_DATABASE_URL).not.toContain(':55433');
      process.env.MEMSMITH_AUTH_MODE = 'local-dev';
      process.env.MEMSMITH_ALLOW_LOCAL_DEV_BYPASS = '1';
      process.env.MEMSMITH_GENERATION_DISABLED = '1';
      process.env.MEMSMITH_QUEUE_ENGINE = 'inline';
      process.env.MEMSMITH_LOCAL_DEV_TEAM_ID = teamB;
      process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID = randomUUID();
      process.env.MEMSMITH_SERVER_PORT = String(HTTP_TEST_PORT);
      service = await createServerService({ pool: base as never, authMode: 'local-dev', bootstrapSchema: true, generationDisabled: true });
      await service.start();
      const http = `http://127.0.0.1:${service.getRuntimeState().port}`;

      const projects: Array<[string, string, string, string | null]> = [
        [A, teamA, 'cli', folderA], [B, teamB, 'app', rootB], [E, teamB, 'notes', folderE], [F, teamA, 'scratch', join(home, 'deleted-scratch')], [G, teamA, 'crowded', join(home, 'deleted-crowded')], [T, teamA, 'shared', folderT],
      ];
      const dbs: Record<string, Pool> = {};
      for (const [id, team, name, folder] of projects) {
        await base.query('INSERT INTO teams (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [team]);
        await base.query('INSERT INTO projects (id, team_id, name, metadata) VALUES ($1, $2, $3, $4)', [
          id, team, name, JSON.stringify(folder ? { memsmith_project_path: folder } : {}),
        ]);
        await base.query(`CREATE DATABASE "${msp(id)}"`);
        dbs[id] = pool(msp(id));
        await bootstrapServerPostgresSchema(dbs[id] as never, 'project');
        await dbs[id].query('INSERT INTO teams (id, name) VALUES ($1, $1)', [team]);
        await dbs[id].query('INSERT INTO projects (id, team_id, name) VALUES ($1, $2, $3)', [id, team, name]);
      }
      const orphan = `msp_${randomUUID().replace(/-/g, '')}`;
      await base.query(`CREATE DATABASE "${orphan}"`);
      await bootstrapServerPostgresSchema(pool(orphan) as never, 'project');
      // An orphan that still holds a record, and an empty project whose
      // database also holds another team's account row: prune keeps both.
      const orphanWithRecords = `msp_${randomUUID().replace(/-/g, '')}`;
      await base.query(`CREATE DATABASE "${orphanWithRecords}"`);
      const orphanPool = pool(orphanWithRecords);
      await bootstrapServerPostgresSchema(orphanPool as never, 'project');
      await orphanPool.query(`INSERT INTO teams (id, name) VALUES ('t-lost', 't-lost')`);
      await orphanPool.query(`INSERT INTO projects (id, team_id, name) VALUES ('p-lost', 't-lost', 'lost')`);
      await orphanPool.query(`INSERT INTO observations (id, project_id, team_id, content) VALUES ('o-lost', 'p-lost', 't-lost', 'a record nobody names')`);
      await dbs[G].query(`INSERT INTO teams (id, name) VALUES ('t-foreign', 't-foreign')`);

      // Target B: a session that also ran in A's folder, an unrelated row that
      // happens to use one of A's ids, and an event A captured too.
      const sB = randomUUID();
      const b = dbs[B];
      await b.query(`INSERT INTO server_sessions (id, project_id, team_id, external_session_id, platform_source) VALUES ($1, $2, $3, 'claude-1', 'claude-code')`, [sB, B, teamB]);
      await b.query(`INSERT INTO observations (id, project_id, team_id, content) VALUES ('obs-collide', $1, $2, 'B original row')`, [B, teamB]);
      await b.query(`INSERT INTO agent_events (id, project_id, team_id, source_adapter, idempotency_key, event_type, payload, occurred_at) VALUES ($1, $2, $3, 'hook', 'idem-shared', 'tool_use', '{}', now())`, [randomUUID(), B, teamB]);

      const a = dbs[A];
      const [s1, e1, e2, e3, j1, j2, j3, o1, n1, o2] = Array.from({ length: 10 }, () => randomUUID());
      await a.query(`INSERT INTO server_sessions (id, project_id, team_id, external_session_id, platform_source) VALUES ($1, $2, $3, 'claude-1', 'claude-code')`, [s1, A, teamA]);
      for (const [id, key] of [[e1, 'idem-1'], [e2, 'idem-2'], [e3, 'idem-shared']]) {
        await a.query(`INSERT INTO agent_events (id, project_id, team_id, server_session_id, source_adapter, idempotency_key, event_type, payload, occurred_at) VALUES ($1, $2, $3, $4, 'hook', $5, 'tool_use', '{"tool":"Edit"}', now())`, [id, A, teamA, s1, key]);
      }
      for (const [id, ev, status] of [[j1, e1, 'completed'], [j2, e2, 'queued'], [j3, e3, 'failed']]) {
        await a.query(`INSERT INTO observation_generation_jobs (id, project_id, team_id, agent_event_id, source_type, source_id, job_type, status, idempotency_key, payload) VALUES ($1, $2, $3, $4, 'agent_event', $4, 'observation', $5, $6, $7)`,
          [id, A, teamA, ev, status, `job-${id}`, JSON.stringify({ project_id: A, team_id: teamA, agent_event_id: ev })]);
      }
      await a.query(`INSERT INTO observation_generation_job_events (id, generation_job_id, event_type, status_after) VALUES ($1, $2, 'completed', 'completed')`, [randomUUID(), j1]);
      await a.query(`INSERT INTO observations (id, project_id, team_id, server_session_id, content, created_by_job_id, embedding_vec) VALUES ($1, $2, $3, $4, 'zebra quokka migration decision', $5, $6)`, [o1, A, teamA, s1, j1, vector(7)]);
      await a.query(`INSERT INTO observations (id, project_id, team_id, kind, content) VALUES ($1, $2, $3, 'user_note', 'remember the quokka')`, [n1, A, teamA]);
      await a.query(`INSERT INTO observations (id, project_id, team_id, content, supersedes) VALUES ($1, $2, $3, 'zebra decision revised', $4)`, [o2, A, teamA, o1]);
      await a.query(`INSERT INTO observations (id, project_id, team_id, content) VALUES ('obs-collide', $1, $2, 'A row with a colliding id')`, [A, teamA]);
      await a.query(`INSERT INTO observation_sources (id, observation_id, agent_event_id, generation_job_id, source_type, source_id) VALUES ($1, $2, $3, $4, 'agent_event', $3)`, [randomUUID(), o1, e1, j1]);
      await dbs[E].query(`INSERT INTO observations (id, project_id, team_id, content) VALUES ($1, $2, $3, 'pelican field notes')`, [randomUUID(), E, teamB]);

      const backupDir = join(DATA_DIR, 'backups');
      const out: string[] = [];
      const err: string[] = [];
      const forgotten: string[] = [];
      const deps = {
        cwd: rootB,
        env: { home, searchRoots: [] },
        runtime: () => 'local',
        openDb: () => new ProjectsDb(connectionString),
        hasKeyForTeam: () => true,
        forgetTeamKey: (teamId: string) => forgotten.push(teamId),
        dump: pgDumpWith(join(binaries, 'bin', 'pg_dump')),
        backupDir,
        now: () => new Date(),
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
      };
      const run = async (fn: () => Promise<number>) => { out.length = 0; err.length = 0; return fn(); };

      // Listing.
      expect(await run(() => runProjectsCommand(['--json'], deps))).toBe(0);
      const listed = JSON.parse(out.join('\n')) as { projects: Array<{ projectId: string | null; flags: string[]; databaseName: string; counts: { observations: number; notes: number; events: number } }> };
      const entry = (id: string | null) => listed.projects.find((p) => p.projectId === id)!;
      expect(entry(A).flags).toEqual(['stray']);
      expect(entry(A).counts).toMatchObject({ observations: 3, notes: 1, events: 3 });
      expect(entry(F).flags).toEqual(['empty']);
      expect(listed.projects.find((p) => p.databaseName === orphan)?.flags).toEqual(['orphan-db', 'empty']);

      // Preview changes nothing and names the exact command.
      expect(await run(() => runMergeCommand([A, B], deps))).toBe(0);
      const preview = out.join('\n');
      expect(preview).toContain('sessions: 0 (1 already in the target)');
      expect(preview).toContain('events: 2 (1 already in the target)');
      expect(preview).toContain('generation jobs: 2');
      expect(preview).toContain('observations and notes: 4 (1 get a new id because the target uses theirs)');
      expect(preview).toContain('Queued or running generation jobs: 1. They move to the target as queued');
      expect(preview).toContain(folderA);
      expect(preview).toContain(`memsmith merge ${A} ${B} --yes`);
      expect((await b.query('SELECT count(*)::int AS n FROM observations')).rows[0].n).toBe(1);
      expect(existsSync(backupDir)).toBe(false);

      // A team project is refused before any backup.
      expect(await run(() => runMergeCommand([T, B, '--yes'], deps))).toBe(1);
      expect(err.join('\n')).toContain('shared is a team project');
      expect(await run(() => runMergeCommand([A, A, '--yes'], deps))).toBe(1);
      expect(existsSync(backupDir)).toBe(false);

      // A copy that fails partway is rolled back: the target gains nothing,
      // the source is not archived, and its queued job is still queued.
      await b.query(`CREATE FUNCTION refuse_revised() RETURNS trigger AS $$
        BEGIN IF NEW.content = 'zebra decision revised' THEN RAISE EXCEPTION 'refused by test trigger'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await b.query('CREATE TRIGGER refuse_revised BEFORE INSERT ON observations FOR EACH ROW EXECUTE FUNCTION refuse_revised()');
      expect(await run(() => runMergeCommand([A, B, '--yes'], deps))).toBe(1);
      expect(err.join('\n')).toContain('stopped at the copy step');
      expect(err.join('\n')).toContain('rolled back');
      expect((await b.query('SELECT count(*)::int AS n FROM observations')).rows[0].n).toBe(1);
      expect((await b.query('SELECT count(*)::int AS n FROM agent_events WHERE project_id = $1', [B])).rows[0].n).toBe(1);
      expect((await a.query('SELECT status FROM observation_generation_jobs WHERE id = $1', [j2])).rows[0].status).toBe('queued');
      const untouched = (await base.query('SELECT metadata FROM projects WHERE id = $1', [A])).rows[0].metadata;
      expect(untouched.mergedInto).toBeUndefined();
      expect(untouched.mergingInto).toBeUndefined();
      await b.query('DROP TRIGGER refuse_revised ON observations');

      // Merge.
      expect(await run(() => runMergeCommand([A, B, '--yes'], deps))).toBe(0);
      const backups = readdirSync(backupDir).sort((x, y) => statSync(join(backupDir, y)).mtimeMs - statSync(join(backupDir, x)).mtimeMs);
      expect(backups).toHaveLength(2);
      expect(backups[0]).toStartWith(`merge-${A}-`);
      expect(statSync(join(backupDir, backups[0])).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(backupDir, backups[0]), 'utf-8')).toContain('zebra quokka migration decision');

      const moved = (await b.query('SELECT id, team_id, content, kind, supersedes, created_by_job_id, server_session_id, embedding_vec::text AS vec FROM observations WHERE project_id = $1', [B])).rows;
      const byId = new Map(moved.map((r) => [r.id, r]));
      expect(byId.get(o1)).toMatchObject({ team_id: teamB, created_by_job_id: j1, server_session_id: sB });
      const createdText = async (pool: Pool) => (await pool.query('SELECT created_at::text AS t FROM observations WHERE id = $1', [o1])).rows[0].t;
      expect(await createdText(b)).toBe(await createdText(a));
      expect(byId.get(o1).vec).toBe((await a.query('SELECT embedding_vec::text AS vec FROM observations WHERE id = $1', [o1])).rows[0].vec);
      expect(byId.get(n1).kind).toBe('user_note');
      expect(byId.get(o2).supersedes).toBe(o1);
      expect(byId.get('obs-collide').content).toBe('B original row');
      expect(byId.get(`obs-collide-m${A.replace(/-/g, '').slice(0, 8)}`).content).toBe('A row with a colliding id');
      const events = (await b.query('SELECT id, server_session_id, team_id FROM agent_events WHERE id = ANY($1)', [[e1, e2, e3]])).rows;
      expect(events.map((r) => r.id).sort()).toEqual([e1, e2].sort());
      expect(events.every((r) => r.server_session_id === sB && r.team_id === teamB)).toBe(true);
      const movedJobs = (await b.query('SELECT id, status FROM observation_generation_jobs WHERE project_id = $1 ORDER BY id', [B])).rows;
      expect(movedJobs).toEqual([{ id: j1, status: 'completed' }, { id: j2, status: 'queued' }].sort((x, y) => (x.id < y.id ? -1 : 1)));
      expect((await b.query('SELECT count(*)::int AS n FROM observation_sources WHERE observation_id = $1', [o1])).rows[0].n).toBe(1);
      expect((await a.query('SELECT status FROM observation_generation_jobs WHERE id = $1', [j2])).rows[0].status).toBe('cancelled');
      expect((await a.query('SELECT count(*)::int AS n FROM observations')).rows[0].n).toBe(4);
      const archived = (await base.query('SELECT metadata FROM projects WHERE id = $1', [A])).rows[0].metadata;
      expect(archived.mergedInto).toBe(B);
      expect(typeof archived.archivedAt).toBe('string');
      expect((await base.query('SELECT 1 FROM pg_database WHERE datname = $1', [msp(A)])).rows).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(folderA, '.memsmith', 'project.json'), 'utf-8'))).toMatchObject({ projectId: B, teamId: teamB, databaseName: msp(B) });

      const search = await postJson(http, '/v1/search', { projectId: B, query: 'zebra' });
      expect(search.status).toBe(200);
      const found = (await search.json() as { observations: Array<{ id: string; projectId: string }> }).observations;
      expect(found.map((o) => o.id)).toContain(o1);
      expect(found.every((o) => o.projectId === B)).toBe(true);

      // A hook that still sends the archived project's id is routed to the target.
      const late = await postJson(http, '/v1/memories', { projectId: A, kind: 'user_note', metadata: { userDirected: true }, content: 'Observation in project A after the merge' });
      expect(late.status).toBe(201);
      const lateBody = await late.json() as { memory: { id: string; projectId: string } };
      expect(lateBody.memory.projectId).toBe(B);
      expect((await b.query('SELECT project_id, team_id FROM observations WHERE id = $1', [lateBody.memory.id])).rows[0]).toEqual({ project_id: B, team_id: teamB });
      expect((await a.query('SELECT count(*)::int AS n FROM observations')).rows[0].n).toBe(4);
      const viaOld = await postJson(http, '/v1/search', { projectId: A, query: 'zebra' });
      expect(viaOld.status).toBe(200);
      expect((await viaOld.json() as { observations: Array<{ id: string }> }).observations.map((o) => o.id)).toContain(o1);
      await b.query('DELETE FROM observations WHERE id = $1', [lateBody.memory.id]);

      // A second run copies nothing new.
      expect(await run(() => runMergeCommand([A, B, '--yes'], deps))).toBe(0);
      expect((await b.query('SELECT count(*)::int AS n FROM observations')).rows[0].n).toBe(moved.length);

      // Rows changed or added in the source after a copy reach the target on the next pass.
      const o4 = randomUUID();
      await a.query(`UPDATE observations SET content = 'zebra quokka migration decision, amended', updated_at = now() WHERE id = $1`, [o1]);
      await a.query(`INSERT INTO observations (id, project_id, team_id, content) VALUES ($1, $2, $3, 'late arrival')`, [o4, A, teamA]);
      expect(await run(() => runMergeCommand([A, B, '--yes'], deps))).toBe(0);
      expect((await b.query('SELECT content FROM observations WHERE id = $1', [o1])).rows[0].content).toBe('zebra quokka migration decision, amended');
      expect((await b.query('SELECT project_id FROM observations WHERE id = $1', [o4])).rows[0].project_id).toBe(B);
      await b.query('DELETE FROM observations WHERE id = $1', [o4]);

      // E shares B's team; once merged and archived, a team-wide read must not return its rows twice.
      expect(await run(() => runMergeCommand([E, B, '--yes'], deps))).toBe(0);
      const browse = await postJson(http, '/v1/search', { projectId: B, query: '' , limit: 100 });
      const ids = (await browse.json() as { observations: Array<{ id: string }> }).observations.map((o) => o.id);
      expect(ids.length).toBe(new Set(ids).size);
      expect(ids.length).toBe(moved.length + 1);

      // Prune.
      expect(await run(() => runProjectsCommand(['--prune'], deps))).toBe(0);
      const prunePreview = out.join('\n');
      for (const name of ['cli', 'notes', 'scratch', orphan]) expect(prunePreview).toContain(name);
      expect(prunePreview).toContain(`Keeping ${orphanWithRecords}: it holds 1 records`);
      expect(prunePreview).toContain('Keeping crowded: its database holds 1 account rows');
      expect(prunePreview).not.toContain('app (');
      expect(prunePreview).toContain('Keeping shared');
      expect((await base.query('SELECT count(*)::int AS n FROM projects')).rows[0].n).toBe(6);

      for (const p of pools) if (p !== base && p !== b) await p.end().catch(() => {});
      expect(await run(() => runProjectsCommand(['--prune', '--yes'], deps))).toBe(0);
      expect(out).toContain('Run `memsmith restart` to release connections to dropped databases.');
      expect(forgotten).toEqual([]);
      const remaining = (await base.query('SELECT id FROM projects ORDER BY id')).rows.map((r) => r.id);
      // Merged projects keep their record, so a folder that still names them is routed to B.
      expect(remaining.sort()).toEqual([A, B, E, G, T].sort());
      const dbNames = (await base.query("SELECT datname FROM pg_database WHERE datname LIKE 'msp_%'")).rows.map((r) => r.datname);
      expect(dbNames.sort()).toEqual([msp(B), msp(G), msp(T), orphanWithRecords].sort());
      const pruneBackups = readdirSync(backupDir).filter((f) => f.startsWith('prune-'));
      expect(pruneBackups).toHaveLength(5);
      for (const name of [msp(A), msp(E), msp(F), `${F}-account`, orphan]) expect(pruneBackups.some((f) => f.includes(name))).toBe(true);
      const accountBackup = readFileSync(join(backupDir, pruneBackups.find((f) => f.includes(`${F}-account`))!), 'utf-8');
      expect(accountBackup).toContain(F);
      expect(accountBackup).toContain('json_populate_record');
      expect((await b.query('SELECT count(*)::int AS n FROM observations')).rows[0].n).toBe(moved.length + 1);
    }, 180_000);
  });

  function mkdtemp(label: string): string {
    const dir = join(DATA_DIR, `${label}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
