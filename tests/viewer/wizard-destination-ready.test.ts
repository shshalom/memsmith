// SPDX-License-Identifier: Apache-2.0
//
// REGRESSION: the Test Connection button was gated on `databaseUrl` unconditionally.
//
// When the destination step gained the HTTPS fields (team server URL + team key), the
// gate was not updated — so filling in the HTTPS fields left the button DEAD, and the
// only path that works for a managed database could not be exercised at all. Found by
// the user on the first real run of the wizard, not by any test.
//
// The rule under test is pure: "is there enough input to probe THIS destination?"

import { describe, expect, it } from 'bun:test';

/**
 * Mirrors `destinationReady()` in DestinationCard.tsx. Kept as a pure function here so
 * the branch logic is pinned without rendering React — the component only wires this to
 * the button's `disabled` prop.
 */
function destinationReady(input: {
  useDirect: boolean; databaseUrl: string; serverUrl: string; teamKey: string;
}): boolean {
  return input.useDirect
    ? input.databaseUrl.trim().length > 0
    : input.serverUrl.trim().length > 0 && input.teamKey.trim().length > 0;
}

const EMPTY = { useDirect: false, databaseUrl: '', serverUrl: '', teamKey: '' };

describe('destinationReady', () => {
  it('enables on the HTTPS path when both server URL and key are present', () => {
    // The exact case that was broken: HTTPS fields filled, button still disabled.
    expect(destinationReady({
      ...EMPTY, serverUrl: 'https://team.example/prod', teamKey: 'cmem_x',
    })).toBe(true);
  });

  it('stays disabled on the HTTPS path with a server URL but no key', () => {
    // The key IS the authorization on this path, so a URL alone cannot be probed.
    expect(destinationReady({ ...EMPTY, serverUrl: 'https://team.example/prod' })).toBe(false);
  });

  it('stays disabled on the HTTPS path with a key but no server URL', () => {
    expect(destinationReady({ ...EMPTY, teamKey: 'cmem_x' })).toBe(false);
  });

  it('ignores databaseUrl entirely on the HTTPS path', () => {
    // The old gate read databaseUrl even here, which is what killed the button.
    expect(destinationReady({
      ...EMPTY, databaseUrl: 'postgres://u:p@h:5432/db',
    })).toBe(false);
  });

  it('enables on the direct path with a database URL alone', () => {
    expect(destinationReady({
      ...EMPTY, useDirect: true, databaseUrl: 'postgres://u:p@h:5432/db',
    })).toBe(true);
  });

  it('ignores the HTTPS fields on the direct path', () => {
    expect(destinationReady({
      ...EMPTY, useDirect: true, serverUrl: 'https://team.example', teamKey: 'cmem_x',
    })).toBe(false);
  });

  it('treats whitespace as empty on both paths', () => {
    expect(destinationReady({ ...EMPTY, serverUrl: '   ', teamKey: '  ' })).toBe(false);
    expect(destinationReady({ ...EMPTY, useDirect: true, databaseUrl: '   ' })).toBe(false);
  });
});
