// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildServerContext } from '../../../src/services/hooks/runtime-selector.js';
import { CredentialStore } from '../../../src/services/identity/credential-store.js';

let dir: string;
let credPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ms-ctx-'));
  credPath = join(dir, 'credentials.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeMarker(m: Record<string, unknown>) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify(m), 'utf-8');
}

describe('buildServerContext with per-project marker', () => {
  it('prefers marker serverUrl and resolves key by teamId from CredentialStore', () => {
    writeMarker({
      teamId: 'team-b',
      projectId: 'proj-b',
      runtime: 'server',
      serverUrl: 'http://team-b:38890',
    });
    const store = new CredentialStore(credPath);
    store.storeKeyForTeam('team-b', 'cmem_teambkey');

    const ctx = buildServerContext({ cwd: dir, credentialStore: store });

    expect(ctx).not.toBeNull();
    // ServerRuntimeContext exposes serverBaseUrl directly
    expect(ctx!.serverBaseUrl).toBe('http://team-b:38890');
    // The API key is held inside ctx.client (ServerClientConfig) — assert it appears
    // somewhere in the serialized context object
    expect(JSON.stringify(ctx)).toContain('cmem_teambkey');
    // Project ID should come from the marker
    expect(ctx!.projectId).toBe('proj-b');
  });

  it('returns null (server-not-reachable) when marker says server but no key for team', () => {
    writeMarker({
      teamId: 'team-c',
      projectId: 'proj-c',
      runtime: 'server',
      serverUrl: 'http://team-c:1',
    });
    const store = new CredentialStore(credPath); // empty — no key for team-c

    const ctx = buildServerContext({ cwd: dir, credentialStore: store });

    expect(ctx).toBeNull();
  });
});
