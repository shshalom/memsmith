import { describe, it, expect } from 'bun:test';
import { requireWriteRole } from '../../../src/server/middleware/postgres-auth.js';

function mockRes() {
  const r: any = { statusCode: 0, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  return r;
}
function run(role: unknown) {
  const guard = requireWriteRole();
  const req: any = role === 'ABSENT' ? {} : { authContext: { role } };
  const res = mockRes();
  let nexted = false;
  guard(req, res, () => { nexted = true; });
  return { nexted, status: res.statusCode };
}

describe('requireWriteRole', () => {
  it('denies an explicit viewer (403)', () => {
    const r = run('viewer');
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });
  it('allows null role (legacy/scope-only key — member-equivalent)', () => {
    const r = run(null);
    expect(r.nexted).toBe(true);
    expect(r.status).toBe(0);
  });
  it('allows member, admin, owner', () => {
    for (const role of ['member', 'admin', 'owner']) {
      const r = run(role);
      expect(r.nexted).toBe(true);
    }
  });
  it('denies when authContext is absent (fail-safe)', () => {
    const r = run('ABSENT');
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });
});
