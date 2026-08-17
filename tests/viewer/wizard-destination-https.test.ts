// SPDX-License-Identifier: Apache-2.0
//
// The wizard's destination is now the team server's HTTPS endpoint plus the team key,
// because a managed database cannot be reached from the machine running convert — the
// direct probe of a real private RDS times out even on VPN.
//
// The database-URL shape is retained for a self-hosted database the owner CAN reach, so
// both request shapes must keep working.

import { describe, expect, it } from 'bun:test';
import { testConnection, migrate } from '../../src/ui/viewer/views/wizard/wizardData.js';

function recorder(payload: unknown = { allGreen: true }) {
  const seen: Array<{ url: string; body: any }> = [];
  const fake = async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  return { seen, fake };
}

describe('wizard testConnection', () => {
  it('posts serverUrl and teamKey for an HTTPS destination', async () => {
    const { seen, fake } = recorder();
    await testConnection(
      { serverUrl: 'https://team.example/prod', teamKey: 'cmem_x' },
      fake as never,
    );
    expect(seen[0]!.body).toMatchObject({
      serverUrl: 'https://team.example/prod', teamKey: 'cmem_x',
    });
    // No database URL on this path: the whole point is that no password is involved.
    expect(Object.keys(seen[0]!.body)).not.toContain('databaseUrl');
  });

  it('still posts databaseUrl for a direct destination', async () => {
    const { seen, fake } = recorder();
    await testConnection({ databaseUrl: 'postgres://u:p@127.0.0.1:5432/db' }, fake as never);
    expect(seen[0]!.body).toMatchObject({ databaseUrl: 'postgres://u:p@127.0.0.1:5432/db' });
  });

  it('keeps posting to the LOCAL relative path', async () => {
    // The request goes to the local server, which holds the credential and makes any
    // outbound call. The browser never talks to the team server directly.
    const { seen, fake } = recorder();
    await testConnection({ serverUrl: 'https://team.example', teamKey: 'k' }, fake as never);
    expect(seen[0]!.url).toBe('/v1/convert/test-connection');
  });
});

describe('wizard migrate', () => {
  it('posts serverUrl and teamKey for an HTTPS destination', async () => {
    const { seen, fake } = recorder({ status: 'converted' });
    await migrate({ serverUrl: 'https://team.example/prod', teamKey: 'cmem_x' }, fake as never);
    expect(seen[0]!.url).toBe('/v1/convert/migrate');
    expect(seen[0]!.body).toMatchObject({ serverUrl: 'https://team.example/prod' });
  });

  it('still posts databaseUrl for a direct destination', async () => {
    const { seen, fake } = recorder({ status: 'converted' });
    await migrate({ databaseUrl: 'postgres://u:p@127.0.0.1:5432/db' }, fake as never);
    expect(seen[0]!.body).toMatchObject({ databaseUrl: 'postgres://u:p@127.0.0.1:5432/db' });
  });
});
