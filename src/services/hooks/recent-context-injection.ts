// SPDX-License-Identifier: Apache-2.0
//
// Worker-retirement sweep — shared recent-mode context injection.
//
// The retired worker route `/api/context/inject` used to serve prompt-injection
// context as a string. Its replacement is the SAME mechanism the C1 SessionStart
// fix established (see src/cli/handlers/context.ts): resolve the server/local
// runtime via `resolveRuntimeContext()`, pull the most recent observations for
// the project scope with the empty-query "list recent" mode of POST /v1/search,
// and pack their content into a string the same way POST /v1/context does
// server-side (`content.join('\n\n')`).
//
// This module centralizes that packing so every non-hook consumer (transcript
// watcher AGENTS.md, Cursor install-time preview, etc.) shares one contract and
// none of them depend on the retired worker HTTP/spawn machinery.
//
// Graceful-empty contract: returns '' (never throws) when no server runtime is
// reachable, no observations exist, or any error occurs — callers treat '' as
// "skip this injection cleanly."

import {
  resolveRuntimeContext as defaultResolveRuntimeContext,
  type RuntimeContext,
} from './runtime-selector.js';
import { logger } from '../../utils/logger.js';

// Default budget: recent project context, not query-driven.
export const RECENT_INJECTION_LIMIT = 10;

export interface FetchRecentContextArgs {
  projectId: string;
  platformSource?: string;
  limit?: number;
}

/**
 * Pull recent project context off the given runtime and pack it into a string.
 * Pure with respect to the injected runtime; never throws.
 */
export async function packRecentContext(
  runtime: RuntimeContext,
  args: FetchRecentContextArgs,
): Promise<string> {
  if (runtime.runtime !== 'server') {
    // No server context reachable (embedded PG not yet available). Skip cleanly.
    return '';
  }
  try {
    const response = await runtime.client.searchObservations({
      projectId: args.projectId,
      query: '', // empty query = "list recent" (ServerV1PostgresRoutes /v1/search)
      limit: args.limit ?? RECENT_INJECTION_LIMIT,
      ...(args.platformSource !== undefined ? { platformSource: args.platformSource } : {}),
    });
    const observations = Array.isArray(response?.observations) ? response.observations : [];
    // Same context-packing rule as POST /v1/context: join non-empty contents.
    return observations
      .map(observation => observation.content)
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
      .join('\n\n');
  } catch (error: unknown) {
    logger.warn('HOOK', 'recent-mode context injection failed; continuing without it', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

/**
 * Convenience wrapper that resolves the runtime itself. Consumers that already
 * hold a `RuntimeContext` should call `packRecentContext` directly.
 */
export async function fetchRecentContextString(
  args: FetchRecentContextArgs,
  resolveRuntimeContext: () => RuntimeContext = defaultResolveRuntimeContext,
): Promise<string> {
  return packRecentContext(resolveRuntimeContext(), args);
}
