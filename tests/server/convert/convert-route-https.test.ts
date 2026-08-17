// SPDX-License-Identifier: Apache-2.0
//
// The wizard must be able to convert to a destination the machine cannot open a Postgres
// socket to. That means choosing a transport from the shape of the input — and refusing
// the one combination that would silently fall back to the path that times out.

import { describe, expect, it } from 'bun:test';
import { selectConvertTransport } from '../../../src/server/routes/v1/ConvertRoutes.js';

describe('selectConvertTransport', () => {
  it('chooses https when a server URL and key are given', () => {
    expect(selectConvertTransport({ serverUrl: 'https://team.example', teamKey: 'k' }))
      .toMatchObject({ kind: 'https' });
  });

  it('chooses postgres when a database URL is given', () => {
    expect(selectConvertTransport({ databaseUrl: 'postgres://u:p@127.0.0.1:5432/db' }))
      .toMatchObject({ kind: 'postgres' });
  });

  it('rejects a postgres:// value supplied as the server URL', () => {
    // A silent fallback here would reintroduce the exact timeout the HTTPS path exists
    // to remove — the user would see a hang instead of a message naming the mistake.
    const r = selectConvertTransport({ serverUrl: 'postgres://u:p@host:5432/db', teamKey: 'k' });
    expect(r.kind).toBe('error');
    expect((r as { message: string }).message).toMatch(/https/i);
  });

  it('rejects a server URL with no team key', () => {
    // The key IS the authorization on this path; without it the request cannot be made.
    expect(selectConvertTransport({ serverUrl: 'https://team.example' }))
      .toMatchObject({ kind: 'error' });
  });

  it('rejects a server URL that is not http(s)', () => {
    expect(selectConvertTransport({ serverUrl: 'team.example', teamKey: 'k' }))
      .toMatchObject({ kind: 'error' });
  });

  it('rejects an empty input', () => {
    expect(selectConvertTransport({})).toMatchObject({ kind: 'error' });
  });

  it('prefers the https path when both are supplied', () => {
    // Ambiguity resolves toward the path that works for a managed database.
    expect(selectConvertTransport({
      serverUrl: 'https://team.example', teamKey: 'k',
      databaseUrl: 'postgres://u:p@127.0.0.1:5432/db',
    })).toMatchObject({ kind: 'https' });
  });
});
