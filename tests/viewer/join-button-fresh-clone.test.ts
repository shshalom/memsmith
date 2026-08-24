// SPDX-License-Identifier: Apache-2.0
//
// The Join button was invisible on the one machine that needed it.
//
// Gating moved from `runtime === 'local'` to "team mode, and not the owner",
// which is right. But the ROLE half is a proxy, and on a fresh clone it is the
// wrong proxy: a teammate who has not joined has no api_keys row, so
// postgres-auth resolves role to null. Null reads as "not the owner", which
// happens to be correct — while the RUNTIME half fails independently, because
// /v1/identity resolves runtime from `projects.metadata` in the LOCAL database
// and a fresh clone has no such row. Runtime comes back 'local', the gate says
// "nothing to join", and the button never renders.
//
// The honest question is not "what role does this person have" but "is there a
// team here that this machine cannot yet open" — which is exactly `keyPresent`,
// already carried by the /v1/identity payload and computed straight from the
// credential store. An owner holds the key, so they are excluded by the real
// reason instead of by inferring intent from a role.

import { describe, it, expect } from 'bun:test';
import { canJoinFromIdentity } from '../../src/ui/viewer/views/DashboardView.js';

describe('Join on a freshly cloned team project', () => {
  it('offers Join when the project is team and this machine holds NO key', () => {
    // THE REGRESSION. The clone's marker says team; the credential store is
    // empty; this is precisely the person the button exists for.
    expect(canJoinFromIdentity('team', { keyPresent: false })).toBe(true);
    expect(canJoinFromIdentity('server', { keyPresent: false })).toBe(true);
    expect(canJoinFromIdentity('server-beta', { keyPresent: false })).toBe(true);
  });

  it('hides Join once this machine holds the key — including for the owner', () => {
    // The owner converted the project, so they hold its key. They are excluded
    // by the fact that they can already open it, not by a role lookup.
    expect(canJoinFromIdentity('team', { keyPresent: true })).toBe(false);
    expect(canJoinFromIdentity('server', { keyPresent: true })).toBe(false);
  });

  it('hides Join on a local project regardless of key state', () => {
    // No team exists yet — the local route to a team is GO TEAM (convert).
    expect(canJoinFromIdentity('local', { keyPresent: false })).toBe(false);
    expect(canJoinFromIdentity('local', { keyPresent: true })).toBe(false);
  });

  it('hides Join when the runtime could not be read', () => {
    // Offering an action based on a runtime we failed to read is how the tile
    // became misleading before.
    expect(canJoinFromIdentity(null, { keyPresent: false })).toBe(false);
    expect(canJoinFromIdentity('', { keyPresent: false })).toBe(false);
    expect(canJoinFromIdentity(undefined as never, { keyPresent: false })).toBe(false);
  });

  it('treats an unreported keyPresent as "no key" so the button still shows', () => {
    // An older server, or a payload that failed to parse, must not hide the
    // action on a team project: showing Join to someone already joined is a
    // harmless no-op, whereas hiding it from a new teammate strands them with
    // no way in — which is the bug this file exists for. Fail toward offering.
    expect(canJoinFromIdentity('team', {})).toBe(true);
    expect(canJoinFromIdentity('team', undefined as never)).toBe(true);
  });
});
