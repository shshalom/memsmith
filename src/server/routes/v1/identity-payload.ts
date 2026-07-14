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
}

export function buildIdentityPayload(
  ids: { teamId: string; projectId: string },
  store: CredentialStore,
  opts: { reveal: boolean },
): IdentityPayload {
  const key = store.resolveKeyForTeam(ids.teamId);
  const payload: IdentityPayload = {
    teamId: ids.teamId,
    projectId: ids.projectId,
    keyPresent: Boolean(key),
    keyMasked: key ? maskKey(key) : '',
  };
  if (opts.reveal && key) payload.keyPlaintext = key;
  return payload;
}
