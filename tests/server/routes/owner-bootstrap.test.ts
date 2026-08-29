// SPDX-License-Identifier: Apache-2.0
//
// Can this caller become the owner of this team?
//
// A user converting a local project to a team server hits
// POST /v1/convert/register-key → 403 "requires role owner". The team key they
// hold authenticates but has no team_members row on the remote, so its role is
// null and every role-gated route is shut. Minting a role-bearing key needs
// admin; becoming admin needs a role-bearing key. The only existing escape is a
// CLI that talks straight to Postgres — which against a private RDS means VPN or
// an in-VPC task. That contradicts the requirement outright: a user must not
// need AWS access to use their own team.
//
// This carries the rule that already governs locally —
// first-writer-establishes-owner (project-identity.ts:212) — across the wire.
//
// WHAT THIS GRANTS, measured rather than assumed. A leaked team key ALREADY
// reads (/v1/search → 200) and writes (/v1/events → 201) the team's memory. It
// cannot mint keys, manage members, or DELETE /v1/projects/:id/memory —
// ownership hands over all of those. Minting is persistence that outlives
// revoking the leaked key; the delete is destruction. So this is a real
// escalation, and BOTH gates below are required, not belt-and-braces.

import { describe, it, expect } from 'bun:test';
import {
  evaluateOwnerBootstrap,
  parseWindowMinutes,
  DEFAULT_OWNER_BOOTSTRAP_WINDOW_MINUTES as DEFAULT_WINDOW,
  type OwnerBootstrapInput,
} from '../../../src/server/routes/v1/owner-bootstrap.js';

const NOW = 1_800_000_000_000;

/** Every gate open: enabled, team is 5 minutes old, no owner, key matches. */
function ok(): OwnerBootstrapInput {
  return {
    enabled: true,
    windowMinutes: 60,
    now: NOW,
    teamCreatedAtEpoch: NOW - 5 * 60_000,
    requestedTeamId: 'team-a',
    keyTeamId: 'team-a',
    keyUserId: null,
    teamHasOwner: false,
  };
}

describe('parseWindowMinutes', () => {
  // A MALFORMED WINDOW MUST NOT BECOME AN UNLIMITED ONE.
  //
  // The route read this with a bare `Number(raw)`, which turned an operator typo
  // into a DISABLED GATE: a non-numeric value yields NaN, and the comparison
  // `ageMinutes > NaN` is always false, so every team of any age passed the
  // window check. That silently removed one of the two gates this feature rests
  // on — found while preparing the env for a real ECS task definition, which is
  // exactly where such a typo would live.

  it('uses the value when it is a positive number', () => {
    expect(parseWindowMinutes('30')).toBe(30);
  });

  it('defaults when unset', () => {
    expect(parseWindowMinutes(undefined)).toBe(DEFAULT_WINDOW);
  });

  it('defaults on a NON-NUMERIC value rather than opening the window forever', () => {
    // The bug. `Number('sixty')` is NaN and `age > NaN` is false, so this would
    // have admitted a team created any number of weeks ago.
    expect(parseWindowMinutes('sixty')).toBe(DEFAULT_WINDOW);
    expect(Number.isFinite(parseWindowMinutes('sixty'))).toBe(true);
  });

  it('defaults on an EMPTY value rather than closing the window instantly', () => {
    // The opposite failure: `Number('')` is 0, refusing even a brand-new team.
    expect(parseWindowMinutes('')).toBe(DEFAULT_WINDOW);
    expect(parseWindowMinutes('   ')).toBe(DEFAULT_WINDOW);
  });

  it('defaults on zero and negatives', () => {
    // A window that can admit nobody is indistinguishable from the feature being
    // off, and the flag already expresses that intent unambiguously.
    expect(parseWindowMinutes('0')).toBe(DEFAULT_WINDOW);
    expect(parseWindowMinutes('-5')).toBe(DEFAULT_WINDOW);
  });

  it('defaults on Infinity — the unbounded window spelled out', () => {
    expect(parseWindowMinutes('Infinity')).toBe(DEFAULT_WINDOW);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseWindowMinutes(' 45 ')).toBe(45);
  });

  it('composes with evaluateOwnerBootstrap: a typo cannot admit an old team', () => {
    // The end-to-end statement of the bug, at the layer that matters: a
    // weeks-old team must still be refused when the window env var is garbage.
    const weeksOld = NOW - 21 * 24 * 60 * 60_000;
    const r = evaluateOwnerBootstrap({
      ...ok(),
      windowMinutes: parseWindowMinutes('not-a-number'),
      teamCreatedAtEpoch: weeksOld,
    });
    expect(r.outcome).toBe('window-closed');
  });
});

describe('evaluateOwnerBootstrap', () => {
  it('grants ownership when every gate is open', () => {
    const r = evaluateOwnerBootstrap(ok());
    expect(r.outcome).toBe('grant');
  });

  it('ASSIGNS a userId when the key has none', () => {
    // The review catch. POST /v1/keys takes only {label, expiresInDays} and
    // createApiKey writes `input.userId ?? null` (auth.ts:91), so every key
    // minted without --user has a NULL user_id — including the live AWS key this
    // feature exists to unblock. An earlier draft REFUSED those with a 400, which
    // would have shipped a route that fails on the only case it is for.
    const r = evaluateOwnerBootstrap({ ...ok(), keyUserId: null });
    expect(r.outcome).toBe('grant');
    if (r.outcome !== 'grant') throw new Error('unreachable');
    expect(r.userId).toBeTruthy();
    expect(r.stampKeyUserId).toBe(true);   // the api_keys row must be updated
  });

  it('REUSES an existing userId rather than replacing it', () => {
    // Replacing it would orphan whatever membership that id already has.
    const r = evaluateOwnerBootstrap({ ...ok(), keyUserId: 'existing-user' });
    expect(r.outcome).toBe('grant');
    if (r.outcome !== 'grant') throw new Error('unreachable');
    expect(r.userId).toBe('existing-user');
    expect(r.stampKeyUserId).toBe(false);
  });

  it('is DISABLED by default — 404, not 403', () => {
    // 404 so a deployment that never opted in does not advertise that the
    // endpoint exists. Default off means a managed deployment must choose this
    // escalation deliberately.
    const r = evaluateOwnerBootstrap({ ...ok(), enabled: false });
    expect(r.outcome).toBe('disabled');
    expect(r.status).toBe(404);
  });

  it('refuses once the team already has an owner', () => {
    // The condition that makes this a BOOTSTRAP and not a hijack: dead the
    // moment a team is properly set up. Without it any key holder could seize an
    // established team and demote its real owner.
    const r = evaluateOwnerBootstrap({ ...ok(), teamHasOwner: true });
    expect(r.outcome).toBe('already-owned');
    expect(r.status).toBe(409);
  });

  it('refuses after the bootstrap window closes', () => {
    // Ownership is a setup-time act. A team that has existed for days with no
    // owner is not mid-setup, it is misconfigured — and an open door there is a
    // standing vulnerability rather than a narrow window.
    const r = evaluateOwnerBootstrap({
      ...ok(), teamCreatedAtEpoch: NOW - 61 * 60_000,
    });
    expect(r.outcome).toBe('window-closed');
    expect(r.status).toBe(410);
  });

  it('accepts a request exactly at the window boundary', () => {
    const r = evaluateOwnerBootstrap({
      ...ok(), teamCreatedAtEpoch: NOW - 60 * 60_000,
    });
    expect(r.outcome).toBe('grant');
  });

  it('refuses a key issued for a DIFFERENT team', () => {
    // No cross-team escalation: a key carries one team_id.
    const r = evaluateOwnerBootstrap({ ...ok(), keyTeamId: 'team-other' });
    expect(r.outcome).toBe('wrong-team');
    expect(r.status).toBe(403);
  });

  it('refuses a key with no team at all', () => {
    const r = evaluateOwnerBootstrap({ ...ok(), keyTeamId: null });
    expect(r.outcome).toBe('wrong-team');
  });

  it('refuses when the team creation time is unknown', () => {
    // Cannot prove we are inside the window, so we are not. Failing closed here
    // matters: an unreadable timestamp must not become an unlimited window.
    const r = evaluateOwnerBootstrap({ ...ok(), teamCreatedAtEpoch: null });
    expect(r.outcome).toBe('window-closed');
  });

  it('checks the flag BEFORE anything else', () => {
    // A disabled deployment must not reveal whether a team exists or is owned.
    const r = evaluateOwnerBootstrap({
      ...ok(), enabled: false, teamHasOwner: true, keyTeamId: 'team-other',
    });
    expect(r.outcome).toBe('disabled');
  });
});
