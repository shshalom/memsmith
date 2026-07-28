import { describe, it, expect } from 'bun:test';
import { probeConnection, MIN_PG_MAJOR } from '../../../src/server/convert/connection-probe.js';

function depsFor(script: Record<string, { rows: Array<Record<string, unknown>> } | Error>) {
  return {
    runQuery: async (_url: string, sql: string) => {
      for (const key of Object.keys(script)) {
        if (sql.includes(key)) {
          const v = script[key];
          if (v instanceof Error) throw v;
          return v;
        }
      }
      return { rows: [] };
    },
  };
}

describe('probeConnection', () => {
  it('reports all-green when reachable, writable, pgvector present, version ok, schema fresh', async () => {
    const deps = depsFor({
      'SELECT 1': { rows: [{ '?column?': 1 }] },
      'server_version_num': { rows: [{ server_version_num: `${(MIN_PG_MAJOR + 2) * 10000}` }] },
      'TEMP TABLE': { rows: [] },
      "extname='vector'": { rows: [{ '?column?': 1 }] },
      'information_schema.tables': { rows: [] }, // observations absent → fresh
    });
    const r = await probeConnection('postgres://x', deps);
    expect(r.connectivity.reachable).toBe(true);
    expect(r.fitness.pgvector).toBe(true);
    expect(r.fitness.versionOk).toBe(true);
    expect(r.allGreen).toBe(true);
    expect(r.fixable).toEqual([]);
  });

  it('marks pgvector fixable when not installed but available', async () => {
    const deps = depsFor({
      'SELECT 1': { rows: [{ '?column?': 1 }] },
      'server_version_num': { rows: [{ server_version_num: `${(MIN_PG_MAJOR + 2) * 10000}` }] },
      'TEMP TABLE': { rows: [] },
      "extname='vector'": { rows: [] },              // not installed
      "name='vector'": { rows: [{ '?column?': 1 }] }, // but available
      // ...and this connection may actually create it. A fix is only offered
      // when it is BOTH available and permitted, so a managed database that
      // refuses CREATE EXTENSION gets instructions rather than a failing button.
      'usesuper': { rows: [{ allowed: true }] },
      'information_schema.tables': { rows: [] },
    });
    const r = await probeConnection('postgres://x', deps);
    expect(r.fitness.pgvector).toBe(false);
    expect(r.fixable).toContain('pgvector');
    expect(r.allGreen).toBe(false);
  });

  it('reports unreachable (never throws) when the connectivity query errors', async () => {
    const deps = depsFor({ 'SELECT 1': new Error('ECONNREFUSED') });
    const r = await probeConnection('postgres://x', deps);
    expect(r.connectivity.reachable).toBe(false);
    expect(r.allGreen).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});
