// SPDX-License-Identifier: Apache-2.0
//
// A CONVERT MUST PRESERVE THE PROJECT'S OWN KEY.
//
// A project's key is minted when the project is created and never changes: converting to
// team changes WHERE the project points, not WHO it is. The direct-Postgres convert path
// already does this via ensureBaseKey, whose comment is explicit — "minting a second key
// would be the actual bug — it orphans a credential whose plaintext is gone, which can be
// neither used nor revoked."
//
// The HTTPS convert path had no equivalent, so it passed the DESTINATION team key (the
// one pasted into the wizard) as the project's identity. applyConvertJoin then cached
// that under the team, overwriting the project's own key — and the local server cannot
// verify a key minted on the remote, so the dashboard returned
// "Invalid API key or insufficient scope" on a convert that had otherwise succeeded.
//
// The destination key is AUTHORIZATION to write during the copy. It is not the project's
// new identity.

import { describe, expect, it } from 'bun:test';
import { registerProjectKeyHash } from '../../../src/server/convert/register-project-key.js';

function recorder(status = 200, body: unknown = { status: 'registered' }) {
  const seen: Array<{ url: string; body: any; auth?: string }> = [];
  const fake = async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    return new Response(JSON.stringify(body), { status });
  };
  return { seen, fake };
}

const BASE = {
  serverUrl: 'https://team.example/prod',
  teamKey: 'cmem_destination',
  projectId: 'p1',
  projectKeyHash: 'a'.repeat(64),
};

describe('registerProjectKeyHash', () => {
  it('POSTs the hash to the remote, authorized by the destination key', async () => {
    const { seen, fake } = recorder();
    await registerProjectKeyHash({ ...BASE, fetchImpl: fake as never });
    expect(seen[0]!.url).toBe('https://team.example/prod/v1/convert/register-key');
    expect(seen[0]!.auth).toBe('Bearer cmem_destination');
    expect(seen[0]!.body).toMatchObject({ projectId: 'p1', keyHash: 'a'.repeat(64) });
  });

  it('NEVER sends the plaintext key', async () => {
    // The remote stores hashes. Sending plaintext would put a live credential on the
    // wire and in the remote's logs for no benefit.
    const { seen, fake } = recorder();
    await registerProjectKeyHash({ ...BASE, fetchImpl: fake as never });
    const wire = JSON.stringify(seen[0]!.body);
    expect(wire).not.toMatch(/cmem_/);
  });

  it('reports failure rather than throwing, so a copy is not lost to bookkeeping', async () => {
    const { fake } = recorder(500, { error: 'boom' });
    const r = await registerProjectKeyHash({ ...BASE, fetchImpl: fake as never });
    expect(r.ok).toBe(false);
  });

  it('never echoes the request in an error, because it carries credentials', async () => {
    const throwing = (async () => { throw new Error('socket hang up cmem_destination'); }) as never;
    const r = await registerProjectKeyHash({ ...BASE, fetchImpl: throwing });
    expect(r.ok).toBe(false);
    expect(r.reason ?? '').not.toMatch(/cmem_destination/);
  });

  it('succeeds when the remote reports the hash already present', async () => {
    // Idempotent across retries and re-converts, matching ensureBaseKey's contract.
    const { fake } = recorder(200, { status: 'already_registered' });
    const r = await registerProjectKeyHash({ ...BASE, fetchImpl: fake as never });
    expect(r.ok).toBe(true);
  });
});
