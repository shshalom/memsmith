// SPDX-License-Identifier: Apache-2.0
import type { IdentityProvider, AuthnResult } from '../identity-provider.js';

export const LOCAL_OWNER_USER_ID = 'local-owner';

// Solo local mode: one implicit owner, no login. Only reached under the existing
// loopback + local-dev bypass gate (enforced by the middleware, not here).
export const localProvider: IdentityProvider = {
  id: 'local',
  async authenticate(): Promise<AuthnResult | null> {
    return { userId: LOCAL_OWNER_USER_ID };
  },
};
