// SPDX-License-Identifier: Apache-2.0
//
// Applying one imported batch, server-side.
//
// Two properties here are security properties, not conveniences:
//   1. project_id and team_id come from the CREDENTIAL, never the row. Rows arrive over
//      the network carrying their own scope columns; trusting them would let an
//      authenticated caller write into another tenant by editing a payload.
//   2. Generated columns are stripped HERE, because discoverGeneratedColumns queries
//      information_schema on the DESTINATION connection by design — an HTTPS client has
//      no such connection, and hardcoding the list would reintroduce the silent insert
//      crash that check exists to prevent.

import { describe, expect, it } from 'bun:test';
import { applyImportBatch, DEFERRED_COLUMNS } from '../../../src/server/convert/import-apply.js';

function makeDeps(opts: { tokenSeen?: boolean; rowsPresent?: boolean } = {}) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  return {
    statements,
    query: async (text: string, values?: unknown[]) => {
      statements.push({ text, values: values ?? [] });
      if (/FROM convert_import_batches/i.test(text)) {
        return { rows: opts.tokenSeen ? [{ batch_token: 'tok' }] : [] };
      }
      // The "do the rows this token claims actually exist?" probe.
      if (/count\(\*\)/i.test(text) && /observations/i.test(text)) {
        return { rows: [{ count: opts.rowsPresent === false ? '0' : '5' }] };
      }
      if (/information_schema/i.test(text)) {
        // content_search is GENERATED ALWAYS (schema.ts:380) and must never be named
        // in an INSERT — Postgres rejects the whole statement if it is.
        return { rows: [{ table_name: 'observations', column_name: 'content_search' }] };
      }
      return { rows: [] };
    },
  };
}

const BASE = { projectId: 'p1', teamId: 't1', batchToken: 'tok' };

describe('applyImportBatch', () => {
  it('returns already_applied for a token it has seen, without inserting', async () => {
    const deps = makeDeps({ tokenSeen: true });
    const r = await applyImportBatch(deps, {
      ...BASE, table: 'observations', rows: [{ id: 'o1', content: 'x' }],
    });
    expect(r.status).toBe('already_applied');
    expect(r.applied).toBe(0);
    expect(deps.statements.some(s => /INSERT INTO observations/i.test(s.text))).toBe(false);
  });

  it('strips generated columns before inserting', async () => {
    const deps = makeDeps();
    await applyImportBatch(deps, {
      ...BASE, table: 'observations',
      rows: [{ id: 'o1', content: 'x', content_search: "'tsvector-junk'" }],
    });
    const insert = deps.statements.find(s => /INSERT INTO observations/i.test(s.text))!;
    expect(insert.text).not.toMatch(/content_search/);
    expect(insert.text).toMatch(/content/);
  });

  it('defers supersedes so a superseding row can precede its target', async () => {
    // observations.supersedes is a SELF-FK (schema.ts:471-472): within one table a
    // superseding row can arrive in an earlier batch than the row it points at, which
    // table ordering cannot fix because the conflict is inside a single table.
    expect(DEFERRED_COLUMNS.observations).toContain('supersedes');

    const deps = makeDeps();
    await applyImportBatch(deps, {
      ...BASE, table: 'observations',
      rows: [{ id: 'o2', content: 'x', supersedes: 'o1' }],
    });
    const insert = deps.statements.find(s => /INSERT INTO observations/i.test(s.text))!;
    expect(insert.text).not.toMatch(/supersedes/);
    // The link must be recorded for the deferred pass, not discarded.
    expect(deps.statements.some(s => /UPDATE observations SET supersedes/i.test(s.text))).toBe(true);
  });

  it('RE-APPLIES a seen token when its rows are gone', async () => {
    // A token means "this batch was applied". If the rows are later deleted, the token
    // still says applied — so a retry became a permanent no-op and convert reported
    // verify_failed forever with no way out from the UI. Idempotency must not outlive
    // the data it protects.
    const deps = makeDeps({ tokenSeen: true, rowsPresent: false });
    const r = await applyImportBatch(deps, {
      ...BASE, table: 'observations', rows: [{ id: 'o1', content: 'x' }],
    });
    expect(r.status).toBe('applied');
    expect(deps.statements.some(s => /INSERT INTO observations/i.test(s.text))).toBe(true);
  });

  it('records the batch token so a retry is a no-op', async () => {
    const deps = makeDeps();
    await applyImportBatch(deps, {
      ...BASE, table: 'observations', rows: [{ id: 'o1', content: 'x' }],
    });
    expect(deps.statements.some(s => /INSERT INTO convert_import_batches/i.test(s.text))).toBe(true);
  });

  it('forces team_id to the authenticated team, ignoring the value in the row', async () => {
    const deps = makeDeps();
    await applyImportBatch(deps, {
      ...BASE, table: 'observations',
      rows: [{ id: 'o1', content: 'x', team_id: 'SOMEONE-ELSES-TEAM' }],
    });
    const insert = deps.statements.find(s => /INSERT INTO observations/i.test(s.text))!;
    expect(insert.values).toContain('t1');
    expect(insert.values).not.toContain('SOMEONE-ELSES-TEAM');
  });

  it('forces project_id to the authenticated project', async () => {
    const deps = makeDeps();
    await applyImportBatch(deps, {
      ...BASE, table: 'observations',
      rows: [{ id: 'o1', content: 'x', project_id: 'ANOTHER-PROJECT' }],
    });
    const insert = deps.statements.find(s => /INSERT INTO observations/i.test(s.text))!;
    expect(insert.values).toContain('p1');
    expect(insert.values).not.toContain('ANOTHER-PROJECT');
  });

  it('records the token even for an empty batch, so a retry stays a no-op', async () => {
    const deps = makeDeps();
    const r = await applyImportBatch(deps, { ...BASE, table: 'observations', rows: [] });
    expect(r.status).toBe('applied');
    expect(r.applied).toBe(0);
    expect(deps.statements.some(s => /INSERT INTO convert_import_batches/i.test(s.text))).toBe(true);
  });
});
