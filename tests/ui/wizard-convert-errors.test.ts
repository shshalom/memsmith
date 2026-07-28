// SPDX-License-Identifier: Apache-2.0
//
// The Convert card told the user "Conversion did not pass verification" when the
// server had actually returned HTTP 500 with a hard crash:
//
//   insert or update on table "projects" violates foreign key
//   constraint "projects_team_id_fkey"
//
// wizardData.migrate() flattened EVERY non-2xx into {status:'verify_failed'} and
// discarded the response body, so a crash was indistinguishable from a genuine
// row-count mismatch — and the real reason was unreachable from the UI. That is
// worse than the underlying bug: it makes every future convert failure blind.
//
// These tests pin the distinction that was missing: a crash reports why, and a
// real verification mismatch stays a verification mismatch.
import { describe, it, expect } from 'bun:test';
import { migrate } from '../../src/ui/viewer/views/wizard/wizardData.js';

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('migrate surfaces the real failure instead of mislabelling it', () => {
  it('reports a server crash with the database error verbatim', async () => {
    // The exact shape that produced the misleading screen.
    const r = await migrate('postgres://x', jsonFetch(500, {
      error: 'insert or update on table "projects" violates foreign key constraint "projects_team_id_fkey"',
    }));
    expect(r.status).toBe('failed');
    expect(r.error).toContain('projects_team_id_fkey');
    expect(r.restartRequired).toBe(false);
  });

  it('does not label a crash as a verification failure', async () => {
    // The whole point: verification never ran, so saying it failed is a lie.
    const r = await migrate('postgres://x', jsonFetch(500, { error: 'boom' }));
    expect(r.status).not.toBe('verify_failed');
  });

  it('surfaces an authorization failure as itself', async () => {
    const r = await migrate('postgres://x', jsonFetch(403, { error: 'no owner identity' }));
    expect(r.status).toBe('failed');
    expect(r.error).toContain('no owner identity');
  });

  it('surfaces a bad-request failure as itself', async () => {
    const r = await migrate('postgres://x', jsonFetch(400, { error: 'databaseUrl required' }));
    expect(r.status).toBe('failed');
    expect(r.error).toContain('databaseUrl required');
  });

  it('still reports a genuine verification mismatch as verify_failed', async () => {
    // A 200 carrying verify_failed is the real thing — it must NOT be recast as
    // a crash, and its mismatch detail must survive for the UI to render.
    const r = await migrate('postgres://x', jsonFetch(200, {
      status: 'verify_failed',
      mismatches: [{ table: 'observations', local: 13, remote: 0 }],
      restartRequired: false,
    }));
    expect(r.status).toBe('verify_failed');
    expect(r.mismatches?.[0]).toEqual({ table: 'observations', local: 13, remote: 0 });
  });

  it('passes a successful conversion through unchanged', async () => {
    const r = await migrate('postgres://x', jsonFetch(200, {
      status: 'converted',
      copiedByTable: { observations: 13 },
      restartRequired: true,
    }));
    expect(r.status).toBe('converted');
    expect(r.copiedByTable).toEqual({ observations: 13 });
    expect(r.restartRequired).toBe(true);
  });

  it('falls back to the status code when the body carries no error text', async () => {
    const r = await migrate('postgres://x', jsonFetch(502, {}));
    expect(r.status).toBe('failed');
    expect(r.error).toContain('502');
  });

  it('survives a non-JSON error body without throwing', async () => {
    const badJson = (async () => ({
      ok: false, status: 500, json: async () => { throw new Error('not json'); },
    })) as unknown as typeof fetch;
    const r = await migrate('postgres://x', badJson);
    expect(r.status).toBe('failed');
    expect(r.error).toBeDefined();
  });

  it('reports a network error rather than silently claiming verification failed', async () => {
    const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const r = await migrate('postgres://x', boom);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('ECONNREFUSED');
    expect(r.restartRequired).toBe(false);
  });
});
