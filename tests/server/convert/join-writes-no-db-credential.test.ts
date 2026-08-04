// SPDX-License-Identifier: Apache-2.0
//
// THE CENTRAL SECURITY CLAIM of join-over-HTTPS: a teammate's machine never
// holds a database credential, at any point in the project's lifecycle.
//
// It is true today, but it sits next to a loaded gun. settings-writer.ts
// writeServerModeSettings() persists MEMSMITH_SERVER_DATABASE_URL into
// ~/.memsmith/settings.json, and it currently has ZERO call sites. If a future
// change wires it into the join path, every teammate would get a database
// password on disk and nothing else would notice.
//
// These assert on applyConvertJoin — the function the JOIN path actually calls
// (ServerV1PostgresRoutes wires it in the join success branch). NOT flipToTeam:
// apply-join.ts:11-15 records that the server used to flip via flipToTeam(cwd,…)
// and that it was wrong, because it used the SERVER's cwd. Asserting on
// flipToTeam would guard a path join never takes.
import { describe, it, expect } from 'bun:test';
import { applyConvertJoin } from '../../../src/server/convert/apply-join.js';

const JOIN = {
  teamId: 'team-1',
  projectId: 'p1',
  serverUrl: 'https://team.example.com',
  apiKey: 'super-secret-key',
};
const MARKER = { projectId: 'p1', teamId: 'old-team' };

describe('the join path writes no database credential', () => {
  it('writes a marker containing no credential and no database URL', async () => {
    let written: any = null;
    const out = applyConvertJoin(
      {
        readProjectMarker: () => MARKER,
        writeProjectRuntime: (_cwd, runtime) => { written = runtime; },
        storeKeyForTeam: () => {},
      },
      '/tmp/p',
      JOIN as never,
    );
    expect(out.applied).toBe(true);
    const json = JSON.stringify(written);
    expect(json).not.toContain('super-secret-key');
    expect(json).not.toContain('postgres://');
    expect(json).not.toContain('password');
    expect(written.runtime).toBe('server');
    // The marker legitimately carries the team and the HTTP server URL.
    expect(written.teamId).toBe('team-1');
    expect(written.serverUrl).toBe('https://team.example.com');
  });

  it('routes the key to the CredentialStore and nowhere else', async () => {
    const stored: Array<[string, string]> = [];
    let written: any = null;
    applyConvertJoin(
      {
        readProjectMarker: () => MARKER,
        writeProjectRuntime: (_cwd, runtime) => { written = runtime; },
        storeKeyForTeam: (teamId, key) => { stored.push([teamId, key]); },
      },
      '/tmp/p',
      JOIN as never,
    );
    // Cached under the NEW team — buildServerContext looks the key up by the
    // marker's teamId, so caching under the old team would leave the project in
    // team mode with no resolvable credential.
    expect(stored).toEqual([['team-1', 'super-secret-key']]);
    expect(JSON.stringify(written)).not.toContain('super-secret-key');
  });

  it('refuses to flip when the join carries no key, so no half state is written', async () => {
    // The ordering guarantee: selectRuntime() follows the marker on its very
    // next call, so a marker written without a resolvable key means team mode
    // authenticated as nobody, silently dropping every observation.
    let wrote = false;
    const out = applyConvertJoin(
      {
        readProjectMarker: () => MARKER,
        writeProjectRuntime: () => { wrote = true; },
        storeKeyForTeam: () => {},
      },
      '/tmp/p',
      { ...JOIN, apiKey: '' } as never,
    );
    expect(out.applied).toBe(false);
    expect(wrote).toBe(false);
  });

  it('writeServerModeSettings has no call sites in src/', async () => {
    // The structural guard. A grep-based test is unusual, but this invariant is
    // about the ABSENCE of a call anywhere in the tree, which no unit test of a
    // single module can express.
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        if (p.endsWith('settings-writer.ts')) continue; // its own definition
        const text = readFileSync(p, 'utf8');
        if (text.includes('writeServerModeSettings(')) hits.push(p);
      }
    };
    walk('src');
    expect(hits).toEqual([]);
  });
});
