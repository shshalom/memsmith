// SPDX-License-Identifier: Apache-2.0
//
// Convert must recover from "requires role owner" on its own.
//
// register-key is owner-gated on the remote. A user's team key authenticates but
// has no team_members row there, so its role is null and the call 403s —
// measured live against AWS, and it is what blocked a real convert:
//
//   {"error":"Forbidden","message":"requires role owner"}
//
// The bootstrap route exists to fix exactly this, but a user cannot be expected
// to know it exists, let alone curl it between two halves of a wizard step. If
// convert does not call it, the feature is only reachable by someone who reads
// the source — which is the same as not shipping it.
//
// ONE retry, and only for that specific failure. A 403 that persists after
// bootstrap is genuine (the team has an owner and it is not you), so looping
// would turn a clear refusal into a hang.

import { describe, it, expect } from 'bun:test';
import { registerProjectKeyHash } from '../../../src/server/convert/register-project-key.js';

const BASE = 'https://team.example.com/prod';

/** Scripted fetch: returns queued responses in order and records the calls. */
function scriptedFetch(steps: Array<{ status: number; body?: unknown }>) {
  const calls: string[] = [];
  const impl = async (url: string | URL): Promise<Response> => {
    calls.push(String(url));
    const step = steps.shift() ?? { status: 500 };
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('registerProjectKeyHash bootstrap retry', () => {
  it('bootstraps and retries when the remote says "requires role owner"', async () => {
    const f = scriptedFetch([
      { status: 403, body: { error: 'Forbidden', message: 'requires role owner' } },
      { status: 200, body: { userId: 'owner-team-a', role: 'owner' } },  // bootstrap
      { status: 200, body: {} },                                         // retry
    ]);
    const r = await registerProjectKeyHash({
      serverUrl: BASE, teamKey: 'k', teamId: 'team-a',
      projectId: 'p1', projectKeyHash: 'h', fetchImpl: f.impl,
    });
    expect(r.ok).toBe(true);
    expect(f.calls[1]).toContain('/v1/teams/team-a/bootstrap-owner');
    expect(f.calls.length).toBe(3);
  });

  it('does NOT retry when the first call succeeds', async () => {
    // The common path must not pay for the recovery path.
    const f = scriptedFetch([{ status: 200, body: {} }]);
    const r = await registerProjectKeyHash({
      serverUrl: BASE, teamKey: 'k', teamId: 'team-a',
      projectId: 'p1', projectKeyHash: 'h', fetchImpl: f.impl,
    });
    expect(r.ok).toBe(true);
    expect(f.calls.length).toBe(1);
  });

  it('gives up after ONE retry rather than looping', async () => {
    // A 403 that survives bootstrap is genuine. Looping would turn a clear
    // refusal into a hang.
    const f = scriptedFetch([
      { status: 403, body: { message: 'requires role owner' } },
      { status: 200, body: {} },                                  // bootstrap ok
      { status: 403, body: { message: 'requires role owner' } },  // still refused
    ]);
    const r = await registerProjectKeyHash({
      serverUrl: BASE, teamKey: 'k', teamId: 'team-a',
      projectId: 'p1', projectKeyHash: 'h', fetchImpl: f.impl,
    });
    expect(r.ok).toBe(false);
    expect(f.calls.length).toBe(3);
  });

  it('does not bootstrap when bootstrap itself is unavailable (404)', async () => {
    // The deployment did not opt in. Reporting the ORIGINAL 403 is the useful
    // answer; "404 on a route you never heard of" would send the user chasing
    // the wrong thing.
    const f = scriptedFetch([
      { status: 403, body: { message: 'requires role owner' } },
      { status: 404, body: { message: 'not found' } },
    ]);
    const r = await registerProjectKeyHash({
      serverUrl: BASE, teamKey: 'k', teamId: 'team-a',
      projectId: 'p1', projectKeyHash: 'h', fetchImpl: f.impl,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/owner/i);
    expect(f.calls.length).toBe(2);
  });

  it('does not attempt bootstrap for an unrelated failure', async () => {
    // A 500 is not an authorization problem; bootstrapping would be noise.
    const f = scriptedFetch([{ status: 500, body: { error: 'InternalError' } }]);
    const r = await registerProjectKeyHash({
      serverUrl: BASE, teamKey: 'k', teamId: 'team-a',
      projectId: 'p1', projectKeyHash: 'h', fetchImpl: f.impl,
    });
    expect(r.ok).toBe(false);
    expect(f.calls.length).toBe(1);
  });

  it('uses the SELF-SCOPED route when teamId is empty', async () => {
    // The production path. A converting client holds the destination team's KEY
    // but not its ID — the only id it has is its own LOCAL team, and sending
    // that would fail the remote's keyTeamId !== requestedTeamId check every
    // time. Empty string means "the team this key belongs to".
    const f = scriptedFetch([
      { status: 403, body: { message: 'requires role owner' } },
      { status: 200, body: { role: 'owner' } },
      { status: 200, body: {} },
    ]);
    const r = await registerProjectKeyHash({
      serverUrl: BASE, teamKey: 'k', teamId: '',
      projectId: 'p1', projectKeyHash: 'h', fetchImpl: f.impl,
    });
    expect(r.ok).toBe(true);
    expect(f.calls[1]).toBe(`${BASE}/v1/teams/bootstrap-owner`);
    expect(f.calls[1]).not.toContain('/v1/teams//');
  });

  it('does not attempt bootstrap when teamId is omitted entirely', async () => {
    // The route is /v1/teams/:teamId/bootstrap-owner; with no team there is
    // nothing to call. Older callers that omit it keep the previous behaviour.
    const f = scriptedFetch([{ status: 403, body: { message: 'requires role owner' } }]);
    const r = await registerProjectKeyHash({
      serverUrl: BASE, teamKey: 'k',
      projectId: 'p1', projectKeyHash: 'h', fetchImpl: f.impl,
    });
    expect(r.ok).toBe(false);
    expect(f.calls.length).toBe(1);
  });
});
