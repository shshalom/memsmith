import { describe, expect, it } from 'bun:test';
import { resolveLocalBaseDatabaseUrl } from '../src/services/identity/local-base-dsn.js';
import { embeddedPostgresDefaultPaths } from '../src/server/runtime/EmbeddedPostgresManager.js';
import { homedir } from 'os';
import { join } from 'path';

// A hook-process test once minted seven projects into the developer's real
// embedded Postgres on 127.0.0.1:55433, because a temp MEMSMITH_DATA_DIR does
// not isolate the database. tests/preload.ts points the base-database
// variables at a closed port; this pins that guard.

const REAL_LOCAL_PG = '127.0.0.1:55433';
const ROOT = new URL('..', import.meta.url).pathname;

async function run(cmd: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawn({ cmd, cwd: ROOT, env: env as Record<string, string>, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout: stdout.trim(), stderr, code };
}

async function preloadedEnv(env: Record<string, string | undefined>) {
  const { stdout, stderr, code } = await run([process.execPath, 'test', './tests/fixtures/db-guard/print-database-env.ts'], env);
  const line = stdout.split('\n').find((l) => l.startsWith('DB_GUARD_ENV '));
  if (!line) throw new Error(`print-database-env.ts printed no DB_GUARD_ENV line (exit ${code}):\n${stderr}`);
  const [url, port, binaries] = JSON.parse(line.slice('DB_GUARD_ENV '.length)) as [string, string, string];
  return { url, port, binaries };
}

describe('test preload database guard', () => {
  it('never resolves the local base database to the real embedded Postgres', () => {
    const url = new URL(resolveLocalBaseDatabaseUrl());
    expect(url.host).not.toBe(REAL_LOCAL_PG);
    expect(url.host).not.toBe('localhost:55433');
  });

  it('keeps the guard when MEMSMITH_SERVER_DATABASE_URL is absent', () => {
    const { MEMSMITH_SERVER_DATABASE_URL: _ignored, ...rest } = process.env;
    const url = new URL(resolveLocalBaseDatabaseUrl(rest, () => null));
    expect(url.host).not.toBe(REAL_LOCAL_PG);
  });

  it('hands the guard to a spawned hook process', async () => {
    const { stdout, code } = await run(
      [process.execPath, '-e', 'const m = await import(process.argv[1]); console.log(m.resolveLocalBaseDatabaseUrl())', join(ROOT, 'src/services/identity/local-base-dsn.ts')],
      { ...process.env },
    );
    expect(code).toBe(0);
    expect(new URL(stdout).host).not.toBe(REAL_LOCAL_PG);
  });

  for (const dsn of [
    'postgres://memsmith:memsmith-local@localhost:55433/postgres',
    'postgresql://memsmith:memsmith-local@0.0.0.0:55433/postgres',
    'host=127.0.0.1 port=55433 dbname=postgres user=memsmith',
    "host='localhost' port = 55433 dbname=postgres",
  ]) {
    it(`overrides a developer shell that points the tests at the real local Postgres: ${dsn}`, async () => {
      const shell = await preloadedEnv({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MEMSMITH_SERVER_DATABASE_URL: dsn,
        MEMSMITH_LOCAL_PG_PORT: '55433',
      });
      expect(shell.url).not.toContain('55433');
      expect(shell.port).not.toBe('55433');
    });
  }

  it('keeps a key=value DSN that names another database', async () => {
    const chosen = 'host=127.0.0.1 port=55499 dbname=ci';
    const shell = await preloadedEnv({ PATH: process.env.PATH, HOME: process.env.HOME, MEMSMITH_SERVER_DATABASE_URL: chosen });
    expect(shell.url).toBe(chosen);
  });

  it('keeps a database the run chose on purpose', async () => {
    const chosen = 'postgres://ci:ci@db.example.test:5432/ci';
    const shell = await preloadedEnv({ PATH: process.env.PATH, HOME: process.env.HOME, MEMSMITH_SERVER_DATABASE_URL: chosen, MEMSMITH_LOCAL_PG_PORT: '55499' });
    expect(shell.url).toBe(chosen);
    expect(shell.port).toBe('55499');
  });

  it('fails the test that leaves the base database on the real local Postgres', async () => {
    const { code, stderr } = await run(
      [process.execPath, 'test', './tests/fixtures/db-guard/leaves-real-database-url.ts'],
      { PATH: process.env.PATH, HOME: process.env.HOME },
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain('real local Postgres');
  }, 30_000);

  it('keeps embedded Postgres binaries out of the real home folder', async () => {
    const real = join(homedir(), '.memsmith');
    expect(embeddedPostgresDefaultPaths().binariesDir.startsWith(real)).toBe(false);
    const shell = await preloadedEnv({ PATH: process.env.PATH, HOME: process.env.HOME });
    expect(shell.binaries.startsWith(real)).toBe(false);
  });
});
