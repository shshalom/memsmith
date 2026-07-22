// SPDX-License-Identifier: Apache-2.0
import type { AuthContext } from '../../middleware/postgres-auth.js';
import { roleSatisfies } from '../../middleware/postgres-auth.js';

export interface DeletableRow {
  kind: string;
  createdByUserId: string | null;
}

export type DeleteDecision =
  | { allow: true }
  | { allow: false; reason: 'wrong_kind' | 'wrong_owner' };

/**
 * Row-level authorization for DELETE /v1/memories/:id, applied AFTER writeAuth +
 * requireWriteRole. Only *tightens* an explicit member; null-role (legacy
 * scope-only key) and admin+ are unaffected.
 *
 *   - role >= admin (admin | owner) → allow (moderation authority, any kind)
 *   - role == null (legacy key)     → allow (back-compat; matches requireWriteRole)
 *   - role == member:
 *        allow only when kind === 'user_note' AND createdByUserId === userId
 *        deny 'wrong_kind'  when kind !== 'user_note'
 *        deny 'wrong_owner' otherwise
 *   - viewer never reaches here (requireWriteRole already 403'd).
 */
export function authorizeObservationDelete(
  authContext: Pick<AuthContext, 'role' | 'userId'>,
  row: DeletableRow,
): DeleteDecision {
  const { role, userId } = authContext;
  if (roleSatisfies(role, 'admin')) return { allow: true };
  if (role == null) return { allow: true };
  if (row.kind !== 'user_note') return { allow: false, reason: 'wrong_kind' };
  if (!userId || row.createdByUserId !== userId) return { allow: false, reason: 'wrong_owner' };
  return { allow: true };
}
