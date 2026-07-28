// SPDX-License-Identifier: Apache-2.0
//
// Third crash in the Go Team convert, found only after the error-surfacing fix
// made it visible:
//
//   cannot insert a non-DEFAULT value into column "content_search"
//
// readRows does SELECT *, so every column comes back — including
// observations.content_search, which is GENERATED ALWAYS AS
// to_tsvector('english', content) STORED. Postgres refuses any INSERT that names
// a generated column, so the observations copy died even though teams, projects,
// server_sessions and agent_events had all copied cleanly.
//
// The column list is discovered from the DESTINATION schema rather than
// hardcoded: the generated set is a property of the schema, and a future
// migration adding one would otherwise reintroduce this exact crash silently.
import { describe, it, expect } from 'bun:test';
import { stripGeneratedColumns, discoverGeneratedColumns } from '../../../src/server/convert/generated-columns.js';

describe('discoverGeneratedColumns', () => {
  it('reads the generated column set from the destination schema', async () => {
    const pool = {
      query: async () => ({
        rows: [
          { table_name: 'observations', column_name: 'content_search' },
        ],
      }),
    };
    const map = await discoverGeneratedColumns(pool as any);
    expect(map.get('observations')).toEqual(new Set(['content_search']));
  });

  it('groups multiple generated columns per table', async () => {
    const pool = {
      query: async () => ({
        rows: [
          { table_name: 'observations', column_name: 'content_search' },
          { table_name: 'observations', column_name: 'title_search' },
          { table_name: 'agent_events', column_name: 'payload_search' },
        ],
      }),
    };
    const map = await discoverGeneratedColumns(pool as any);
    expect(map.get('observations')).toEqual(new Set(['content_search', 'title_search']));
    expect(map.get('agent_events')).toEqual(new Set(['payload_search']));
  });

  it('returns an empty map when the schema has no generated columns', async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const map = await discoverGeneratedColumns(pool as any);
    expect(map.size).toBe(0);
  });
});

describe('stripGeneratedColumns', () => {
  const generated = new Map([['observations', new Set(['content_search'])]]);

  it('drops the generated column so the INSERT never names it', () => {
    const rows = [{ id: 'o1', content: 'hello', content_search: "'hello':1" }];
    const out = stripGeneratedColumns('observations', rows, generated);
    expect(out[0]).toEqual({ id: 'o1', content: 'hello' });
    expect('content_search' in out[0]!).toBe(false);
  });

  it('preserves every non-generated column, including nulls and falsy values', () => {
    // A dropped column silently loses data; only the generated one may go.
    const rows = [{
      id: 'o1', content: '', team_id: null, pinned: false, score: 0,
      content_search: 'x',
    }];
    const out = stripGeneratedColumns('observations', rows, generated);
    expect(out[0]).toEqual({ id: 'o1', content: '', team_id: null, pinned: false, score: 0 });
  });

  it('leaves tables with no generated columns untouched', () => {
    const rows = [{ id: 'p1', name: 'proj', content_search: 'kept-here' }];
    const out = stripGeneratedColumns('projects', rows, generated);
    expect(out[0]).toEqual(rows[0]);
  });

  it('handles an empty row set', () => {
    expect(stripGeneratedColumns('observations', [], generated)).toEqual([]);
  });

  it('does not mutate the caller\'s rows', () => {
    const rows = [{ id: 'o1', content_search: 'x' }];
    stripGeneratedColumns('observations', rows, generated);
    expect(rows[0]).toHaveProperty('content_search');
  });

  it('is a no-op when the generated map is empty', () => {
    const rows = [{ id: 'o1', content_search: 'x' }];
    const out = stripGeneratedColumns('observations', rows, new Map());
    expect(out[0]).toEqual(rows[0]);
  });
});
