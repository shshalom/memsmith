// SPDX-License-Identifier: Apache-2.0
import type { Request } from 'express';
import type { IdentityProvider, AuthnResult } from '../identity-provider.js';

/**
 * Minimal interface for the better-auth session API seam.
 *
 * The real better-auth instance exposes `auth.api.getSession({ headers })`.
 * We inject `auth.api` (or a fake with the same shape) so unit tests never
 * touch a live auth instance.
 *
 * Confirmed from better-auth dist/api/routes/session.d.mts:
 *   getSession(): StrictEndpoint<"/get-session", ...> returning { session, user } | null
 * Called as: auth.api.getSession({ headers: <Headers> })
 */
export interface BetterAuthLike {
  getSession(opts: { headers: unknown }): Promise<{ user: { id: string; email?: string; name?: string } } | null>;
}

/**
 * Factory that builds a `better-auth` IdentityProvider around an injectable
 * session-validator. Unit tests pass a fake; the default export binds the real
 * `auth.api` from `src/server/auth/auth.ts`.
 */
export function makeBetterAuthProvider(authLike: BetterAuthLike): IdentityProvider {
  return {
    id: 'better-auth',
    async authenticate(req: Request): Promise<AuthnResult | null> {
      try {
        const result = await authLike.getSession({ headers: req.headers });
        if (!result) return null;
        const { user } = result;
        return {
          userId: user.id,
          ...(user.email !== undefined ? { email: user.email } : {}),
          ...(user.name !== undefined ? { displayName: user.name } : {}),
        };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Default provider bound to the real better-auth instance.
 *
 * Lazily imported so the module can be required in environments where the
 * database is not yet initialised (e.g. during testing). The real auth instance
 * is created via `createAuth` in src/server/auth/auth.ts; here we import and
 * re-export a singleton bound to `auth.api` so callers never have to import
 * auth directly.
 *
 * Actual session call: `auth.api.getSession({ headers: req.headers })`
 * Confirmed from: node_modules/better-auth/dist/api/routes/session.d.mts
 *   → StrictEndpoint with requireHeaders: true, returning { session, user } | null
 */
let _betterAuthProvider: IdentityProvider | undefined;

export function getBetterAuthProvider(): IdentityProvider {
  if (!_betterAuthProvider) {
    // Dynamic import is intentional: avoids circular deps and defers DB init.
    // We use a synchronous require-style pattern via a lazy singleton.
    throw new Error(
      'betterAuthProvider must be initialised with initBetterAuthProvider(auth) before use',
    );
  }
  return _betterAuthProvider;
}

/**
 * Bind the provider to a real auth instance. Call once at server startup, e.g.:
 *   import { initBetterAuthProvider } from '.../better-auth-provider.js';
 *   initBetterAuthProvider(auth.api);
 */
export function initBetterAuthProvider(authApi: BetterAuthLike): void {
  _betterAuthProvider = makeBetterAuthProvider(authApi);
}

// Named export for symmetry with local-provider.ts.
// In production, call initBetterAuthProvider(auth.api) at startup first.
export const betterAuthProvider: IdentityProvider = {
  id: 'better-auth',
  async authenticate(req: Request): Promise<AuthnResult | null> {
    return getBetterAuthProvider().authenticate(req);
  },
};
