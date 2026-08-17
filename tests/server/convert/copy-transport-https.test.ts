// SPDX-License-Identifier: Apache-2.0
//
// The HTTPS CopyDeps transport — what lets convert reach a managed database.
//
// A private RDS is unreachable from a developer machine (PubliclyAccessible=false, the
// hostname resolves to a VPC-internal address), so the direct pool times out even on
// VPN. Measured with the same code path and only the destination changed:
//   127.0.0.1:55441 -> {"reachable":true}
//   the real RDS    -> {"error":"Connection terminated due to connection timeout"}

import { describe, expect, it } from 'bun:test';
import { makeHttpsCopyDeps } from '../../../src/server/convert/copy-transport-https.js';

function fakeFetch(
  record: Array<{ url: string; body: unknown }>,
  opts: { failFirstWith413?: boolean } = {},
) {
  let calls = 0;
  return async (url: string | URL, init?: RequestInit) => {
    calls += 1;
    record.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (opts.failFirstWith413 && calls === 1) {
      return new Response(JSON.stringify({ error: 'too large' }), { status: 413 });
    }
    if (String(url).includes('/v1/convert/verify')) {
      return new Response(JSON.stringify({ counts: { observations: 3 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 'applied', applied: 1 }), { status: 200 });
  };
}

const BASE = {
  serverUrl: 'https://team.example/prod',
  teamKey: 'cmem_test',
  projectId: 'p1',
  readLocalRows: async () => [{ id: 'o1' }],
  countLocalRows: async () => 3,
};

describe('makeHttpsCopyDeps', () => {
  it('POSTs to /v1/convert/import with a Bearer key', async () => {
    const record: Array<{ url: string; body: unknown }> = [];
    const deps = makeHttpsCopyDeps({ ...BASE, fetchImpl: fakeFetch(record) as never });
    await deps.upsertRows('observations', [{ id: 'o1' }]);
    expect(record[0]!.url).toBe('https://team.example/prod/v1/convert/import');
    expect(record[0]!.body).toMatchObject({ table: 'observations' });
  });

  it('sends a batchToken that is distinct per batch', async () => {
    const record: Array<{ url: string; body: unknown }> = [];
    const deps = makeHttpsCopyDeps({ ...BASE, fetchImpl: fakeFetch(record) as never });
    await deps.upsertRows('observations', [{ id: 'o1' }]);
    await deps.upsertRows('observations', [{ id: 'o2' }]);
    const tokens = record.map(r => (r.body as { batchToken: string }).batchToken);
    // Distinct, or a retry of batch 2 would be mistaken for batch 1 and skipped.
    expect(new Set(tokens).size).toBe(2);
    expect(tokens[0]).toContain('p1');
    expect(tokens[0]).toContain('observations');
  });

  it('halves the batch and retries on 413', async () => {
    // The byte budget is an estimate; the server's limit is authoritative.
    const record: Array<{ url: string; body: unknown }> = [];
    const deps = makeHttpsCopyDeps({
      ...BASE, fetchImpl: fakeFetch(record, { failFirstWith413: true }) as never,
    });
    await deps.upsertRows('observations', [{ id: 'a' }, { id: 'b' }]);
    expect(record.length).toBeGreaterThanOrEqual(3);
  });

  it('reads remote counts from the verify endpoint', async () => {
    const record: Array<{ url: string; body: unknown }> = [];
    const deps = makeHttpsCopyDeps({ ...BASE, fetchImpl: fakeFetch(record) as never });
    expect(await deps.countRows('remote', 'observations')).toBe(3);
    expect(record.some(r => r.url.includes('/v1/convert/verify'))).toBe(true);
  });

  it('reads local counts locally, never over the wire', async () => {
    const record: Array<{ url: string; body: unknown }> = [];
    const deps = makeHttpsCopyDeps({ ...BASE, fetchImpl: fakeFetch(record) as never });
    expect(await deps.countRows('local', 'observations')).toBe(3);
    expect(record).toHaveLength(0);
  });

  it('never puts the team key in a thrown message', async () => {
    // A fetch error can echo the request, and the request body carries the key. The
    // join transport made the same choice for the same reason.
    const deps = makeHttpsCopyDeps({
      ...BASE,
      fetchImpl: (async () => { throw new Error('socket hang up cmem_test'); }) as never,
    });
    let message = '';
    try {
      await deps.upsertRows('observations', [{ id: 'o1' }]);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/cannot reach/i);
    expect(message).not.toMatch(/cmem_test/);
  });
});
