import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureProjectIdentity } from '../../../src/services/identity/project-identity.js';

// A fake account pool: answers the merge-chain lookup and records every other
// statement, so nothing here can reach a real database.
function fakePool(projects: Record<string, { team: string; mergedInto?: string }>) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  return {
    statements,
    query: async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (/merged_into/.test(sql)) {
        const p = projects[String(values[0])];
        return { rows: p ? [{ team_id: p.team, merged_into: p.mergedInto ?? null }] : [], rowCount: p ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function marker(dir: string, body: object) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify(body));
}
const read = (dir: string) => JSON.parse(readFileSync(join(dir, '.memsmith', 'project.json'), 'utf-8'));

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ms-merged-marker-')));
  mkdirSync(join(dir, '.git'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ensureProjectIdentity for a merged project', () => {
  it('rewrites a local marker that names an archived project to the project it was merged into', async () => {
    marker(dir, { teamId: 't-old', projectId: 'old', note: 'n', databaseName: 'msp_old' });
    const pool = fakePool({ old: { team: 't-old', mergedInto: 'new' }, new: { team: 't-new' } });
    const ids = await ensureProjectIdentity(pool as never, dir);
    expect(ids).toMatchObject({ teamId: 't-new', projectId: 'new' });
    expect(read(dir)).toMatchObject({ teamId: 't-new', projectId: 'new' });
    expect(read(dir).databaseName).toBeUndefined();
    const upsert = pool.statements.find((s) => s.sql.includes('INSERT INTO projects'));
    expect(upsert?.values[0]).toBe('new');
    expect(upsert?.values[3]).toBeNull();
  });

  it('never rewrites a team marker', async () => {
    const team = { teamId: 't-old', projectId: 'old', note: 'n', runtime: 'server', serverUrl: 'https://team.example.com' };
    marker(dir, team);
    const ids = await ensureProjectIdentity(fakePool({ old: { team: 't-old', mergedInto: 'new' }, new: { team: 't-new' } }) as never, dir);
    expect(ids.projectId).toBe('old');
    expect(read(dir)).toEqual(team);
  });

  it('leaves the marker alone when the merges form a cycle', async () => {
    marker(dir, { teamId: 't', projectId: 'a', note: 'n' });
    const ids = await ensureProjectIdentity(fakePool({ a: { team: 't', mergedInto: 'b' }, b: { team: 't', mergedInto: 'a' } }) as never, dir);
    expect(ids.projectId).toBe('a');
    expect(read(dir).projectId).toBe('a');
  });
});
