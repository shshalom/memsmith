// SPDX-License-Identifier: Apache-2.0
//
// The handoff between the two processes involved in a Go Team convert.
//
// The server copies the data (it knows the remote URL) but must NOT write the
// project's marker — doing so is what let a convert of one project flip another,
// because the server can only guess at directories. The project's own session
// hook must write it, but that hook has no idea a conversion happened.
//
// So the server records a pending join ON THE DESTINATION DATABASE, in that
// project's own `projects.metadata`. The hook already authenticates there with
// this team's key, so it can claim its own note on next session and apply it
// locally via applyConvertJoin.
//
// SECURITY PROPERTY THAT DRIVES THE SHAPE: the note carries NO api key. The hook
// already resolves the team key from CredentialStore by teamId (runtime-selector
// lines 118-127), and ensureBaseKey cached it during the convert's mint
// (project-identity line 246). Putting a credential in a database row would be
// storing a secret that nothing needs.
import { describe, it, expect } from 'bun:test';
import {
  recordPendingJoin,
  readPendingJoin,
  clearPendingJoin,
  PENDING_JOIN_KEY,
} from '../../../src/server/convert/pending-join.js';

type Call = { text: string; values: unknown[] };

function fakePool(initialMetadata: Record<string, unknown> | null = null) {
  const calls: Call[] = [];
  let metadata = initialMetadata;
  return {
    calls,
    getMetadata: () => metadata,
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (/UPDATE projects/i.test(text)) {
        // Mimic jsonb merge: the patch is values[0].
        const patch = typeof values[0] === 'string' ? JSON.parse(values[0]) : values[0];
        metadata = { ...(metadata ?? {}), ...(patch as Record<string, unknown>) };
        return { rows: [] };
      }
      if (/SELECT metadata/i.test(text)) {
        return { rows: metadata === null ? [] : [{ metadata }] };
      }
      return { rows: [] };
    },
  };
}

const SERVER_URL = 'http://team-a:38890';

describe('recordPendingJoin', () => {
  it('records the pending join for the given project', async () => {
    const pool = fakePool({});
    await recordPendingJoin(pool as any, {
      projectId: 'proj-a', teamId: 'team-a', serverUrl: SERVER_URL,
    });
    const update = pool.calls.find(c => /UPDATE projects/i.test(c.text));
    expect(update).toBeDefined();
    expect(update!.values).toContain('proj-a');
  });

  it('NEVER stores an api key in the note', async () => {
    // The hook resolves the key from CredentialStore by teamId; a credential in a
    // database row would be a secret nothing reads.
    const pool = fakePool({});
    await recordPendingJoin(pool as any, {
      projectId: 'proj-a', teamId: 'team-a', serverUrl: SERVER_URL,
      // Extra field: proving it is neither accepted into the note nor persisted.
      ...({ apiKey: 'cmem_shouldNeverAppear' } as Record<string, never>),
    });
    const serialized = JSON.stringify(pool.calls);
    expect(serialized).not.toContain('cmem_shouldNeverAppear');
    expect(serialized).not.toContain('apiKey');
  });

  it('scopes the write to the project row, not the whole table', async () => {
    const pool = fakePool({});
    await recordPendingJoin(pool as any, {
      projectId: 'proj-a', teamId: 'team-a', serverUrl: SERVER_URL,
    });
    const update = pool.calls.find(c => /UPDATE projects/i.test(c.text))!;
    expect(update.text).toMatch(/WHERE\s+id\s*=\s*\$/i);
  });

  it('preserves other metadata keys instead of replacing the object', async () => {
    const pool = fakePool({ existing: 'keep-me' });
    await recordPendingJoin(pool as any, {
      projectId: 'proj-a', teamId: 'team-a', serverUrl: SERVER_URL,
    });
    expect(pool.getMetadata()).toHaveProperty('existing', 'keep-me');
  });

  it('rejects an empty projectId or serverUrl rather than writing a useless note', async () => {
    const pool = fakePool({});
    await expect(recordPendingJoin(pool as any, {
      projectId: '', teamId: 'team-a', serverUrl: SERVER_URL,
    })).rejects.toThrow();
    await expect(recordPendingJoin(pool as any, {
      projectId: 'proj-a', teamId: 'team-a', serverUrl: '',
    })).rejects.toThrow();
    expect(pool.calls.filter(c => /UPDATE projects/i.test(c.text))).toHaveLength(0);
  });
});

describe('readPendingJoin', () => {
  it('returns the note the server left', async () => {
    const pool = fakePool({
      [PENDING_JOIN_KEY]: { teamId: 'team-a', serverUrl: SERVER_URL },
    });
    const found = await readPendingJoin(pool as any, 'proj-a');
    expect(found).toEqual({ teamId: 'team-a', serverUrl: SERVER_URL });
  });

  it('returns null when there is no note', async () => {
    expect(await readPendingJoin(fakePool({}) as any, 'proj-a')).toBeNull();
  });

  it('returns null when the project row does not exist', async () => {
    expect(await readPendingJoin(fakePool(null) as any, 'proj-a')).toBeNull();
  });

  it('returns null for a malformed note instead of throwing', async () => {
    // A half-written or hand-edited row must not break every session start.
    for (const bad of [{}, { teamId: 'team-a' }, { serverUrl: SERVER_URL }, 'nonsense', 42]) {
      const pool = fakePool({ [PENDING_JOIN_KEY]: bad });
      expect(await readPendingJoin(pool as any, 'proj-a')).toBeNull();
    }
  });

  it('never throws when the query itself fails — session start must survive', async () => {
    const boom = { query: async () => { throw new Error('remote unreachable'); } };
    expect(await readPendingJoin(boom as any, 'proj-a')).toBeNull();
  });
});

describe('clearPendingJoin', () => {
  it('removes the note so it is applied exactly once', async () => {
    const pool = fakePool({
      [PENDING_JOIN_KEY]: { teamId: 'team-a', serverUrl: SERVER_URL },
      other: 'keep',
    });
    await clearPendingJoin(pool as any, 'proj-a');
    const update = pool.calls.find(c => /UPDATE projects/i.test(c.text));
    expect(update).toBeDefined();
    expect(update!.text).toMatch(/WHERE\s+id\s*=\s*\$/i);
  });

  it('does not throw when there is nothing to clear', async () => {
    await clearPendingJoin(fakePool({}) as any, 'proj-a');
  });
});
