// SPDX-License-Identifier: Apache-2.0
import type { Request } from 'express';

export type ProviderId = 'local' | 'better-auth'; // 'oidc' added by a later spec

export interface AuthnResult {
  userId: string;
  email?: string;
  displayName?: string;
}

// Authn ONLY: resolve who this request is, or null. NEVER decides access.
export interface IdentityProvider {
  readonly id: ProviderId;
  authenticate(req: Request): Promise<AuthnResult | null>;
}

const KNOWN: ProviderId[] = ['local', 'better-auth'];

export function resolveIdentityProviderId(env: NodeJS.ProcessEnv | Record<string, string | undefined>): ProviderId {
  const v = (env.MEMSMITH_IDENTITY_PROVIDER ?? '').trim();
  return (KNOWN as string[]).includes(v) ? (v as ProviderId) : 'local';
}
