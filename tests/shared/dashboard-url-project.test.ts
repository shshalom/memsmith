// SPDX-License-Identifier: Apache-2.0
//
// The SessionStart welcome link pointed at the bare dashboard, which always
// showed the project the SERVER booted from. Opening a session in any other
// project therefore linked you to someone else's memory -- and the Go Team
// wizard converts whatever the dashboard is scoped to, so acting on that link
// from a second project would have targeted the first project's data.
//
// The link now carries the session's own projectId.
import { describe, it, expect } from 'bun:test';
import { resolveDashboardUrl } from '../../src/shared/dashboard-url.js';

describe('resolveDashboardUrl project scoping', () => {
  it('returns the bare dashboard when no project is given', () => {
    expect(resolveDashboardUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('appends ?project= when a projectId is given', () => {
    const url = resolveDashboardUrl('2614487e-553e-4b5a-b0ab-52ee8f7fd17f');
    expect(url).toContain('?project=2614487e-553e-4b5a-b0ab-52ee8f7fd17f');
  });

  it('percent-encodes the project id', () => {
    expect(resolveDashboardUrl('a b&c')).toContain(`?project=${encodeURIComponent('a b&c')}`);
  });

  it('ignores an empty or whitespace-only project id', () => {
    expect(resolveDashboardUrl('')).not.toContain('?project=');
    expect(resolveDashboardUrl('   ')).not.toContain('?project=');
  });

  it('keeps the same host and port as the unscoped form', () => {
    const bare = new URL(resolveDashboardUrl());
    const scoped = new URL(resolveDashboardUrl('p1'));
    expect(scoped.host).toBe(bare.host);
  });
});
