// SPDX-License-Identifier: Apache-2.0
import { CredentialStore } from '../../../services/identity/credential-store.js';

export function maskKey(key: string): string {
  if (!key) return '';
  const last4 = key.slice(-4);
  const prefix = key.includes('_') ? key.slice(0, key.indexOf('_') + 1) : '';
  return `${prefix}${'•'.repeat(8)}${last4}`;
}

export interface IdentityPayload {
  teamId: string;
  projectId: string;
  keyPresent: boolean;
  keyMasked: string;
  keyPlaintext?: string;
  /** The caller's role in this team, or null when none could be resolved. */
  role: string | null;
  /**
   * True only when the caller is a confirmed team owner.
   *
   * The Go Team wizard reads this to decide whether it must ask for a sign-in.
   * It is deliberately strict: anything other than a resolved 'owner' role —
   * including the null role a session produces — reports false, so an unknown
   * state keeps the sign-in step instead of silently skipping it.
   */
  ownerEstablished: boolean;
}

export function buildIdentityPayload(
  ids: { teamId: string; projectId: string },
  store: CredentialStore,
  opts: { reveal: boolean; role?: string | null },
): IdentityPayload {
  const key = store.resolveKeyForTeam(ids.teamId);
  const role = opts.role ?? null;
  const payload: IdentityPayload = {
    teamId: ids.teamId,
    projectId: ids.projectId,
    keyPresent: Boolean(key),
    keyMasked: key ? maskKey(key) : '',
    role,
    ownerEstablished: role === 'owner',
  };
  if (opts.reveal && key) payload.keyPlaintext = key;
  return payload;
}
