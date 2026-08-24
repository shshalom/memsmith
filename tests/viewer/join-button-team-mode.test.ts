// SPDX-License-Identifier: Apache-2.0
//
// The Join button was on the WRONG tile.
//
// It was gated `canJoin = runtime === 'local'`, on the reasoning that "a project
// already in team mode has nothing to join". That reasoning is backwards, and it
// was mine, not the user's — the mockup showed the button on the tile reading
// **Team**.
//
// The user's rule, stated plainly:
//
//   "when project is on local mode (Not team) - there's nothing to join to.
//    the moment the project gets converted to team, the join button should
//    appear to new members (not to the owner - the owner is by nature already in)"
//
// Which is right, and the old gating was exactly inverted:
//
//   LOCAL     -> there is no team yet. Nothing to join. NO button.
//               (the local path to a team is GO TEAM / convert, in Settings)
//   TEAM      -> a workspace exists. A NEW MEMBER on this machine can join it.
//               The OWNER is already in it by construction — no button for them.
//
// The old gating showed the button precisely where there was nothing to join,
// and hid it precisely where joining is the point.
//
// Distinguishing owner from new member is already possible: /v1/identity returns
// `role` (resolved by postgres-auth from api_keys.user_id -> team_members) and
// role order is viewer < member < admin < owner. The dashboard simply was not
// reading it.
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { canJoinFromIdentity } from '../../src/ui/viewer/views/DashboardView.js';

const REPO = join(import.meta.dir, '..', '..');

// NOTE ON THE SIGNATURE. The rule above is unchanged — Join belongs in team
// mode, to people who are not already in. What changed is how "already in" is
// measured: `keyPresent` (does THIS MACHINE hold the team's key) instead of
// `role !== 'owner'`.
//
// Role was a proxy, and it broke on the machine that matters most. A teammate
// who has not joined has no api_keys row, so postgres-auth resolves role to
// null — and null was read as "not the owner", which is right by accident. The
// runtime half then failed independently: /v1/identity derives runtime from
// `projects.metadata` in the LOCAL database, and a fresh clone has no such row,
// so runtime came back 'local' and the button never rendered. See
// join-button-fresh-clone.test.ts.
//
// The owner still never sees the button, now for the honest reason: they hold
// their project's key, so keyPresent is true.
const asOwner = { keyPresent: true };      // holds the team's key
const asNewcomer = { keyPresent: false };  // does not

describe('Join is offered in TEAM mode, to non-owners', () => {
  it('offers Join to a non-owner on a team project', () => {
    // The case the whole feature exists for.
    expect(canJoinFromIdentity('team', asNewcomer)).toBe(true);
    expect(canJoinFromIdentity('team', null)).toBe(true);
  });

  it('does NOT offer Join to the owner — they are already in', () => {
    expect(canJoinFromIdentity('team', asOwner)).toBe(false);
  });

  it('treats the server/server-beta runtime wire values as team', () => {
    // /v1/identity reports 'team', but the marker and older responses use
    // 'server'/'server-beta'. The runtime tile already normalises all three; the
    // gate must agree or the button appears on some team projects and not others.
    expect(canJoinFromIdentity('server', asNewcomer)).toBe(true);
    expect(canJoinFromIdentity('server-beta', asNewcomer)).toBe(true);
    expect(canJoinFromIdentity('server', asOwner)).toBe(false);
  });
});

describe('Join is NOT offered on a local project', () => {
  it('hides Join in local mode — there is no team to join yet', () => {
    // THE INVERSION. This is where the button used to be, and it is the one
    // place it makes no sense: no workspace exists. The local route to a team is
    // GO TEAM (convert), which lives in Settings.
    expect(canJoinFromIdentity('local', null)).toBe(false);
    expect(canJoinFromIdentity('local', asOwner)).toBe(false);
    expect(canJoinFromIdentity('local', asNewcomer)).toBe(false);
  });

  it('hides Join when the runtime could not be read', () => {
    // The tile renders "runtime unavailable" here. Offering an action based on a
    // runtime we failed to read is how the tile became misleading before.
    expect(canJoinFromIdentity(null, asNewcomer)).toBe(false);
    expect(canJoinFromIdentity(undefined as never, asNewcomer)).toBe(false);
    expect(canJoinFromIdentity('', asNewcomer)).toBe(false);
  });
});

describe('the gate is wired, not just defined', () => {
  const dash = readFileSync(join(REPO, 'src/ui/viewer/views/DashboardView.tsx'), 'utf-8');
  const code = dash.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

  it('no longer gates on runtime === local', () => {
    // A source guard because the unit tests above exercise the exported helper;
    // without this, reverting the call site would keep them green while the UI
    // regressed. Comment-stripped: the explanation above quotes the old gating,
    // and a naive scan flags the FIX as the bug (this has bitten several guards
    // in this repo).
    expect(code).not.toMatch(/canJoin\s*=\s*runtime === 'local'/);
  });

  it('calls the helper and reads keyPresent from identity', () => {
    // Guards the WIRING, not just the helper. The gate is only as good as the
    // value fed to it: reading the wrong field would leave every unit test above
    // green while the button misbehaved in the browser.
    expect(code).toContain('canJoinFromIdentity');
    expect(code).toMatch(/setKeyPresent/);
    expect(code).toMatch(/keyPresent/);
  });

  it('still renders the action on the Runtime tile', () => {
    // Placement is unchanged — only WHEN it shows. The user's mockup put it on
    // the Runtime tile, right of the value.
    expect(code).toContain('dash-kpi-action');
    expect(code).toMatch(/k\.l === 'Runtime'/);
  });
});
