import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CredentialStore } from '../../src/services/identity/credential-store.js';
import { buildServerContext } from '../../src/services/hooks/runtime-selector.js';

// Assumes buildServerContext accepts an options bag { cwd, credentialStore } for
// testability (the real hook passes the session cwd + default store). If the
// implementer instead reads process.env.MEMSMITH_PROJECT_CWD, set that here.
describe('buildServerContext in local mode with a project key', () => {
  let cwd: string; let credPath: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'memsmith-ctx-'));
    mkdirSync(join(cwd, '.memsmith'), { recursive: true });
    writeFileSync(join(cwd, '.memsmith', 'project.json'),
      JSON.stringify({ teamId: 'team-ctx', projectId: 'proj-ctx', note: 'x' }), 'utf-8');
    credPath = join(cwd, 'credentials.json');
    new CredentialStore(credPath).storeKeyForTeam('team-ctx', 'msk_ctx');
    process.env.MEMSMITH_SERVER_URL = 'http://127.0.0.1:38879';
    process.env.MEMSMITH_SERVER_API_KEY = ''; // empty — the whole point
  });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); delete process.env.MEMSMITH_SERVER_URL; });

  it('builds a context from the resolved project key (no longer returns null)', () => {
    const ctx = buildServerContext({ cwd, credentialStore: new CredentialStore(credPath) });
    expect(ctx).not.toBeNull();
    expect(ctx!.projectId).toBe('proj-ctx');
    expect(ctx!.runtime).toBe('server'); // local uses the server client shape
  });

  it('returns null (falls back) when no key and no marker', () => {
    const empty = mkdtempSync(join(tmpdir(), 'memsmith-empty-'));
    const ctx = buildServerContext({ cwd: empty, credentialStore: new CredentialStore(join(empty, 'c.json')) });
    expect(ctx).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });
});
