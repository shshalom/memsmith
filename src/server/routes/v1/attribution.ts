// SPDX-License-Identifier: Apache-2.0

import type { AuthContext } from '../../middleware/postgres-auth.js';

/**
 * Stamps `createdByUserId` attribution onto an observation metadata object.
 *
 * Returns a NEW object (never mutates the input) with `createdByUserId` added
 * when `authContext.userId` is a non-empty string. Returns the input metadata
 * unchanged (same reference) when userId is null/undefined/empty (legacy
 * null-owner key or unauthenticated path) — back-compat writes still succeed.
 */
export function stampAttribution(
  metadata: Record<string, unknown>,
  authContext: Pick<AuthContext, 'userId'>,
): Record<string, unknown> {
  const userId = authContext.userId;
  if (!userId) {
    return metadata;
  }
  return { ...metadata, createdByUserId: userId };
}
