// SPDX-License-Identifier: Apache-2.0

import type { Application } from 'express';
import type { Database } from 'bun:sqlite';
import type { RouteHandler } from '../../services/server/Server.js';
import { logger } from '../../utils/logger.js';

type NodeHandler = ReturnType<typeof import('better-auth/node').toNodeHandler>;

const cachedHandlers = new WeakMap<Database, NodeHandler>();

async function getBetterAuthHandler(database: Database): Promise<NodeHandler> {
  const cachedHandler = cachedHandlers.get(database);
  if (cachedHandler) {
    return cachedHandler;
  }

  const [{ toNodeHandler }, { createAuth }, { initBetterAuthProvider }] = await Promise.all([
    import('better-auth/node'),
    import('./auth.js'),
    import('../identity/providers/better-auth-provider.js'),
  ]);
  const auth = createAuth(database);
  // Task 8 (identity-core): initialise the singleton betterAuthProvider so it
  // can validate sessions when MEMSMITH_IDENTITY_PROVIDER=better-auth. Called
  // here because this is the only site where a real auth instance is built;
  // calling it unconditionally is safe — the provider's fail-safe returns null
  // if invoked before init (but this fires on the first auth request anyway).
  initBetterAuthProvider(auth.api as Parameters<typeof initBetterAuthProvider>[0]);
  const handler = toNodeHandler(auth);
  cachedHandlers.set(database, handler);
  return handler;
}

export class BetterAuthRoutes implements RouteHandler {
  constructor(private readonly getDatabase: () => Database) {}

  setupRoutes(app: Application): void {
    app.all('/api/auth/*splat', async (req, res, next) => {
      try {
        const handler = await getBetterAuthHandler(this.getDatabase());
        await handler(req, res);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('HTTP', 'better-auth handler failed', { path: req.path }, err);
        next(error);
      }
    });
  }
}
