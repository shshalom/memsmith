// SPDX-License-Identifier: Apache-2.0
//
// The Go Team wizard deadlocked on its own normal path. Next unlocks only when
// every check is green (DestinationCard.tsx:112 `disabled={!probeAllGreen}`),
// pgvector is absent from essentially every fresh Postgres a team would bring,
// and the wizard offered no way to install it — so no conversion could ever
// complete without the user leaving the UI to run SQL by hand.
//
// The spec called for both halves: "if a fitness check fails but is fixable AND
// MEMSMITH HAS PERMISSION (e.g. CREATE EXTENSION vector) ... the response marks
// it fixable so the UI can offer one-click setup; otherwise the response carries
// instruct-only guidance". Only the instruct-only fallback shipped, and the
// probe never checked permission at all — it reported `fixable` purely on
// availability, so a managed database (RDS/Cloud SQL) where the app user cannot
// CREATE EXTENSION would have been offered a button that always fails.
import { describe, it, expect } from 'bun:test';
import { probeConnection } from '../../../src/server/convert/connection-probe.js';
import { applyPgvectorFix } from '../../../src/server/convert/apply-fix.js';

type Q = (url: string, sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;

// Minimal fake Postgres: answers the probe's queries from a described state.
function pg(opts: { installed?: boolean; available?: boolean; superuser?: boolean; createFails?: string }): Q {
  return async (_url, sql) => {
    if (/FROM pg_extension/i.test(sql)) return { rows: opts.installed ? [{ extname: 'vector' }] : [] };
    if (/pg_available_extensions/i.test(sql)) return { rows: opts.available === false ? [] : [{ name: 'vector' }] };
    if (/usesuper|has_database_privilege|pg_has_role/i.test(sql)) {
      return { rows: [{ allowed: opts.superuser !== false }] };
    }
    if (/CREATE EXTENSION/i.test(sql)) {
      if (opts.createFails) throw new Error(opts.createFails);
      return { rows: [] };
    }
    if (/server_version_num/i.test(sql)) return { rows: [{ server_version_num: '160000' }] };
    return { rows: [] };
  };
}

describe('probe reports fixable only when MemSmith can actually fix it', () => {
  it('marks pgvector fixable when it is available AND we have permission', async () => {
    const r = await probeConnection('postgres://x', { runQuery: pg({ available: true, superuser: true }) });
    expect(r.fitness.pgvector).toBe(false);
    expect(r.fixable).toContain('pgvector');
  });

  it('does NOT offer a fix we lack permission to apply', async () => {
    // A managed Postgres (RDS, Cloud SQL) commonly refuses CREATE EXTENSION to
    // the app user. Offering a button that always fails is worse than saying so.
    const r = await probeConnection('postgres://x', { runQuery: pg({ available: true, superuser: false }) });
    expect(r.fixable).not.toContain('pgvector');
  });

  it('does not offer a fix when the extension is not even available on the server', async () => {
    const r = await probeConnection('postgres://x', { runQuery: pg({ available: false, superuser: true }) });
    expect(r.fixable).not.toContain('pgvector');
  });

  it('reports nothing fixable once the extension is installed', async () => {
    const r = await probeConnection('postgres://x', { runQuery: pg({ installed: true }) });
    expect(r.fitness.pgvector).toBe(true);
    expect(r.fixable).not.toContain('pgvector');
  });
});

describe('applying the fix', () => {
  it('creates the extension and reports success', async () => {
    const ran: string[] = [];
    const q: Q = async (_u, sql) => { ran.push(sql); return { rows: [] }; };
    const res = await applyPgvectorFix('postgres://x', { runQuery: q });
    expect(res.ok).toBe(true);
    expect(ran.some(s => /CREATE EXTENSION IF NOT EXISTS vector/i.test(s))).toBe(true);
  });

  it('is idempotent — re-running on an installed database still succeeds', async () => {
    const res = await applyPgvectorFix('postgres://x', { runQuery: pg({ installed: true }) });
    expect(res.ok).toBe(true);
  });

  it('surfaces the real error instead of failing silently', async () => {
    const res = await applyPgvectorFix('postgres://x', {
      runQuery: pg({ createFails: 'permission denied to create extension "vector"' }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('permission denied');
  });
});
