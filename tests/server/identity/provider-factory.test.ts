// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { resolveIdentityProvider } from '../../../src/server/identity/provider-factory';
import { localProvider } from '../../../src/server/identity/providers/local-provider';

describe('resolveIdentityProvider', () => {
  it("returns localProvider (id 'local') when env is empty", () => {
    const provider = resolveIdentityProvider({});
    expect(provider.id).toBe('local');
    expect(provider).toBe(localProvider);
  });

  it("returns provider with id 'better-auth' when MEMSMITH_IDENTITY_PROVIDER=better-auth", () => {
    const provider = resolveIdentityProvider({ MEMSMITH_IDENTITY_PROVIDER: 'better-auth' });
    expect(provider.id).toBe('better-auth');
  });

  it("falls back to localProvider on unknown MEMSMITH_IDENTITY_PROVIDER value", () => {
    const provider = resolveIdentityProvider({ MEMSMITH_IDENTITY_PROVIDER: 'mystery' });
    expect(provider.id).toBe('local');
    expect(provider).toBe(localProvider);
  });
});
