// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { requireRole, roleSatisfies } from '../../../src/server/middleware/postgres-auth';

describe('role ordering', () => {
  it('viewer<member<admin<owner', () => {
    expect(roleSatisfies('owner', 'member')).toBe(true);
    expect(roleSatisfies('member', 'member')).toBe(true);
    expect(roleSatisfies('viewer', 'member')).toBe(false);
    expect(roleSatisfies('admin', 'owner')).toBe(false);
    expect(roleSatisfies(null, 'viewer')).toBe(false); // no membership → denied
  });
});
describe('requireRole middleware', () => {
  function run(role: any) {
    let status = 0; const res: any = { status: (c: number) => { status = c; return res; }, json: () => res };
    let nexted = false;
    requireRole('member')({ authContext: { role } } as any, res, () => { nexted = true; });
    return { status, nexted };
  }
  it('allows when role satisfies', () => { expect(run('admin').nexted).toBe(true); });
  it('403s when insufficient', () => { const r = run('viewer'); expect(r.nexted).toBe(false); expect(r.status).toBe(403); });
  it('403s when no membership (null)', () => { expect(run(null).status).toBe(403); });
});
