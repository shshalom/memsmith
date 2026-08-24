// SPDX-License-Identifier: Apache-2.0
//
// Read-only view of a TRACKED project — the six conditions, each denied alone.
//
// A cloned team project has a committed marker and no key. The viewer
// authenticates by API key, so such a project cannot be displayed at all, and
// the Join button — the whole point of the tracked state — never renders.
//
// Two approaches were rejected before this one (see the design doc): a
// viewer-level special case reproduces the view/credential disagreement behind
// six previous cookie bugs, and deriving scope from the request is the
// cross-tenant vulnerability resolve-request-database.ts explicitly prohibits.
//
// This extends the pattern that prohibition itself names: the auth layer decides
// what a request may CLAIM, and everything downstream reads authContext only.
// So the grant lives here, behind conditions strict enough to be worth the
// trust, and the rest of the system is untouched.
//
// EVERY condition is load-bearing. Each test removes exactly one and asserts the
// grant is refused, because a gate that passes when any single guard fails is
// not a gate.

import { describe, it, expect } from 'bun:test';
import { evaluateTrackedViewGrant, type TrackedViewInput } from '../../../src/server/middleware/tracked-view-grant.js';

/** All six conditions satisfied. Each test breaks exactly one. */
function ok(): TrackedViewInput {
  return {
    hasKey: false,
    isLoopbackIp: true,
    isLoopbackHost: true,
    hasForwardedHeaders: false,
    requestedProjectId: 'acme-api',
    marker: { teamId: 'team-a', projectId: 'acme-api', runtime: 'server' },
    machineHoldsTeamKey: false,
  };
}

describe('evaluateTrackedViewGrant', () => {
  it('grants a read-only view when all six conditions hold', () => {
    const grant = evaluateTrackedViewGrant(ok());
    expect(grant).not.toBeNull();
    expect(grant!.projectId).toBe('acme-api');
    expect(grant!.teamId).toBe('team-a');
  });

  it('grants memories:read and NEVER memories:write', () => {
    // The enforcement. Writes are blocked by the ABSENT scope, because baseWrite
    // is constructed with requiredScopes:['memories:write'].
    //
    // NOT by the role: requireWriteRole treats `role == null` as ALLOWED
    // (`const allow = role == null || roleSatisfies(role, 'member')`), so a null
    // role would have permitted writes. An earlier draft of this design claimed
    // otherwise and would have shipped a writable "read-only" grant.
    const grant = evaluateTrackedViewGrant(ok())!;
    expect(grant.scopes).toContain('memories:read');
    expect(grant.scopes).not.toContain('memories:write');
    expect(grant.scopes).not.toContain('settings:admin');
  });

  it('refuses when a key was presented — normal auth owns that request', () => {
    expect(evaluateTrackedViewGrant({ ...ok(), hasKey: true })).toBeNull();
  });

  it('refuses a non-loopback client IP', () => {
    expect(evaluateTrackedViewGrant({ ...ok(), isLoopbackIp: false })).toBeNull();
  });

  it('refuses a non-loopback Host header', () => {
    // Guards DNS-rebinding: the socket can be loopback while the Host names an
    // attacker's domain.
    expect(evaluateTrackedViewGrant({ ...ok(), isLoopbackHost: false })).toBeNull();
  });

  it('refuses anything carrying forwarded-client headers', () => {
    // A proxy in front means the loopback socket says nothing about the caller.
    expect(evaluateTrackedViewGrant({ ...ok(), hasForwardedHeaders: true })).toBeNull();
  });

  it('refuses when the request names no project', () => {
    expect(evaluateTrackedViewGrant({ ...ok(), requestedProjectId: undefined })).toBeNull();
    expect(evaluateTrackedViewGrant({ ...ok(), requestedProjectId: '   ' })).toBeNull();
  });

  it('refuses when there is no marker on this machine', () => {
    // The anti-escalation condition: without it, a caller could name any project
    // id. With it, the only reachable projects are ones already on this disk.
    expect(evaluateTrackedViewGrant({ ...ok(), marker: null })).toBeNull();
  });

  it('refuses when the marker names a DIFFERENT project', () => {
    // Otherwise a marker for project A would unlock a view of project B.
    const grant = evaluateTrackedViewGrant({
      ...ok(),
      marker: { teamId: 'team-a', projectId: 'someone-else', runtime: 'server' },
    });
    expect(grant).toBeNull();
  });

  it('refuses a LOCAL project — there is no team, so nothing to view this way', () => {
    // A local project already has its own key; it must go through normal auth.
    expect(evaluateTrackedViewGrant({
      ...ok(), marker: { teamId: 'team-a', projectId: 'acme-api' },
    })).toBeNull();
    expect(evaluateTrackedViewGrant({
      ...ok(), marker: { teamId: 'team-a', projectId: 'acme-api', runtime: 'local' },
    })).toBeNull();
  });

  it('refuses when this machine ALREADY holds the team key', () => {
    // Then the project is joined and normal auth applies. This branch exists
    // only for the gap where no credential can possibly work.
    expect(evaluateTrackedViewGrant({ ...ok(), machineHoldsTeamKey: true })).toBeNull();
  });

  it('accepts the legacy server-beta marker literal', () => {
    const grant = evaluateTrackedViewGrant({
      ...ok(), marker: { teamId: 'team-a', projectId: 'acme-api', runtime: 'server-beta' },
    });
    expect(grant).not.toBeNull();
  });

  it('reports a distinct mode so the grant is auditable', () => {
    // A request served by this branch must be distinguishable in logs and in
    // any downstream check from one that presented a real credential.
    expect(evaluateTrackedViewGrant(ok())!.mode).toBe('tracked-local-view');
  });
});
