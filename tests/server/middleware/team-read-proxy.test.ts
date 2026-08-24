// SPDX-License-Identifier: Apache-2.0
//
// A JOINED project's dashboard reads must reach the TEAM server.
//
// After a successful join the marker says `runtime: 'server'` and names the
// team's serverUrl, and the team key is cached locally — but the dashboard only
// ever talks to 127.0.0.1, and the LOCAL server rejects that key: it validates
// against its own api_keys table, where a team-issued credential does not exist.
// Verified live: /dashboard/metrics with the team key -> 403, and the same key
// -> 200 against AWS. So a joined project could not be viewed at all, and the
// user saw "Not authenticated" with no data immediately after a join that had
// actually succeeded.
//
// Chosen shape: the LOCAL SERVER PROXIES. The browser keeps calling localhost,
// the local server forwards to marker.serverUrl with the cached key, and the
// team credential never enters browser JavaScript. The alternative — handing the
// key to the page — would put a live team credential in devtools and require
// CORS on the team server.
//
// This module decides ONLY whether a request should be proxied and where to.
// Keeping that judgement separate from the forwarding means the routing rules
// are testable without a network.

import { describe, it, expect } from 'bun:test';
import { resolveTeamProxyTarget } from '../../../src/server/middleware/team-read-proxy.js';

const TEAM_URL = 'https://team.example.com/prod';

describe('resolveTeamProxyTarget', () => {
  it('proxies a joined team project to its own serverUrl', () => {
    const t = resolveTeamProxyTarget({
      marker: { teamId: 't1', projectId: 'p1', runtime: 'server', serverUrl: TEAM_URL },
      teamKey: 'cmem_team',
      path: '/dashboard/metrics',
      search: '?projectId=p1',
    });
    expect(t).toEqual({
      url: `${TEAM_URL}/dashboard/metrics?projectId=p1`,
      key: 'cmem_team',
    });
  });

  it('does NOT proxy a local project', () => {
    // A local project's data is local. Forwarding it would send a local read to
    // someone else's server.
    expect(resolveTeamProxyTarget({
      marker: { teamId: 't1', projectId: 'p1', runtime: 'local' },
      teamKey: 'cmem_team', path: '/dashboard/metrics', search: '',
    })).toBeNull();
  });

  it('does NOT proxy when there is no marker', () => {
    expect(resolveTeamProxyTarget({
      marker: null, teamKey: 'cmem_team', path: '/dashboard/metrics', search: '',
    })).toBeNull();
  });

  it('does NOT proxy a team project with no cached key', () => {
    // The TRACKED state: recognized but not joined. There is no credential to
    // forward, and capture is deliberately local until the user joins — so the
    // dashboard must keep reading locally rather than 401 against the team.
    expect(resolveTeamProxyTarget({
      marker: { teamId: 't1', projectId: 'p1', runtime: 'server', serverUrl: TEAM_URL },
      teamKey: null, path: '/dashboard/metrics', search: '',
    })).toBeNull();
  });

  it('does NOT proxy when the marker carries no serverUrl', () => {
    // Nowhere to send it. Falling back to localhost is strictly better than
    // guessing a host.
    expect(resolveTeamProxyTarget({
      marker: { teamId: 't1', projectId: 'p1', runtime: 'server' },
      teamKey: 'cmem_team', path: '/dashboard/metrics', search: '',
    })).toBeNull();
  });

  it('accepts the legacy server-beta runtime literal', () => {
    const t = resolveTeamProxyTarget({
      marker: { teamId: 't1', projectId: 'p1', runtime: 'server-beta', serverUrl: TEAM_URL },
      teamKey: 'k', path: '/dashboard/cost', search: '',
    });
    expect(t?.url).toBe(`${TEAM_URL}/dashboard/cost`);
  });

  it('strips a trailing slash from the serverUrl so the path is not doubled', () => {
    const t = resolveTeamProxyTarget({
      marker: { teamId: 't1', projectId: 'p1', runtime: 'server', serverUrl: 'https://x.example/prod/' },
      teamKey: 'k', path: '/dashboard/metrics', search: '',
    });
    expect(t?.url).toBe('https://x.example/prod/dashboard/metrics');
  });

  it('never proxies to a non-HTTP scheme', () => {
    // A marker is a file on disk and could name anything; only http(s) is a
    // team server. This refuses file:// and similar outright.
    expect(resolveTeamProxyTarget({
      marker: { teamId: 't1', projectId: 'p1', runtime: 'server', serverUrl: 'file:///etc/passwd' },
      teamKey: 'k', path: '/dashboard/metrics', search: '',
    })).toBeNull();
  });
});
