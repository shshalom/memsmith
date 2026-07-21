// SPDX-License-Identifier: Apache-2.0
import type { IdentityProvider } from './identity-provider.js';
import { resolveIdentityProviderId } from './identity-provider.js';
import { localProvider } from './providers/local-provider.js';
import { betterAuthProvider } from './providers/better-auth-provider.js';

/**
 * Factory that maps the configured provider ID (from env) to the matching
 * IdentityProvider singleton instance.
 *
 * Unknown IDs fall back to localProvider — the same default as
 * resolveIdentityProviderId itself.
 */
export function resolveIdentityProvider(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): IdentityProvider {
  const id = resolveIdentityProviderId(env);
  switch (id) {
    case 'better-auth':
      return betterAuthProvider;
    case 'local':
    default:
      return localProvider;
  }
}
