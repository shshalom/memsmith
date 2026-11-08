import { describe, expect, it } from 'bun:test';
import { resolveLocalBaseDatabaseUrl } from '../src/services/identity/local-base-dsn.js';

// A hook-process test once minted seven projects into the developer's real
// embedded Postgres on 127.0.0.1:55433, because a temp MEMSMITH_DATA_DIR does
// not isolate the database. tests/preload.ts points the base-database
// variables at a closed port; this pins that guard.

const REAL_LOCAL_PG = '127.0.0.1:55433';

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
    const proc = Bun.spawn({
      cmd: [process.execPath, '-e', "const m = await import(process.argv[1]); console.log(m.resolveLocalBaseDatabaseUrl())", new URL('../src/services/identity/local-base-dsn.ts', import.meta.url).pathname],
      env: { ...process.env },
      stdout: 'pipe',
    });
    const out = (await new Response(proc.stdout).text()).trim();
    expect(await proc.exited).toBe(0);
    expect(new URL(out).host).not.toBe(REAL_LOCAL_PG);
  });
});
