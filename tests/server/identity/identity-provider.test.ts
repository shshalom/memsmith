import { describe, it, expect } from 'bun:test';
import { resolveIdentityProviderId } from '../../../src/server/identity/identity-provider';

describe('resolveIdentityProviderId', () => {
  it("defaults to 'local' when unset", () => {
    expect(resolveIdentityProviderId({})).toBe('local');
  });
  it("returns 'better-auth' when configured", () => {
    expect(resolveIdentityProviderId({ MEMSMITH_IDENTITY_PROVIDER: 'better-auth' })).toBe('better-auth');
  });
  it("falls back to 'local' on unknown value", () => {
    expect(resolveIdentityProviderId({ MEMSMITH_IDENTITY_PROVIDER: 'mystery' })).toBe('local');
  });
});
