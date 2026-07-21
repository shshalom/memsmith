import { describe, it, expect } from 'bun:test';
import { makeBetterAuthProvider } from '../../../src/server/identity/providers/better-auth-provider';

describe('betterAuthProvider', () => {
  it('returns the user when the session validates', async () => {
    const p = makeBetterAuthProvider({ getSession: async () => ({ user: { id: 'u1', email: 'dana@x.com', name: 'Dana' } }) } as any);
    expect(await p.authenticate({ headers: {} } as any)).toEqual({ userId: 'u1', email: 'dana@x.com', displayName: 'Dana' });
  });
  it('returns null when there is no session', async () => {
    const p = makeBetterAuthProvider({ getSession: async () => null } as any);
    expect(await p.authenticate({ headers: {} } as any)).toBeNull();
  });
  it('returns null (never throws) when the validator throws', async () => {
    const p = makeBetterAuthProvider({ getSession: async () => { throw new Error('boom'); } } as any);
    expect(await p.authenticate({ headers: {} } as any)).toBeNull();
  });
});
