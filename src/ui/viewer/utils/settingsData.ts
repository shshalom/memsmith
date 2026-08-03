// SPDX-License-Identifier: Apache-2.0
import { V1_ENDPOINTS } from '../constants/api.js';
import { readProjectParam } from './projectScope.js';

export interface IdentityPayload {
  teamId: string;
  projectId: string;
  keyPresent: boolean;
  keyMasked: string;
  keyPlaintext?: string;
  /** Optional so an older server response still parses; absent means 'local'. */
  runtime?: 'local' | 'team';
  /**
   * Team role resolved by postgres-auth (api_keys.user_id -> team_members).
   * Order: viewer < member < admin < owner. Null when unresolvable — which is
   * exactly the new-member case, since no membership row exists yet.
   */
  role?: string | null;
}

export async function fetchIdentity(reveal?: boolean): Promise<IdentityPayload | null> {
  try {
    // Carry the project from the URL. The server now treats the REQUEST as
    // authoritative for scope (verified against the key's entitlement), so the
    // answer no longer depends on whichever key last landed in the cookie. Without
    // this the viewer would still be asking "what project is my credential for?"
    // instead of "what project am I looking at?".
    const project = typeof location !== 'undefined' ? readProjectParam(location.search) : '';
    const params = new URLSearchParams();
    if (reveal) params.set('reveal', 'true');
    if (project) params.set('projectId', project);
    const qs = params.toString();
    const url = qs ? `${V1_ENDPOINTS.IDENTITY}?${qs}` : V1_ENDPOINTS.IDENTITY;
    // credentials:'include' is REQUIRED. /v1/identity authenticates via the
    // viewer's project cookie; without it the browser sends nothing and the
    // route answers 401 "Missing API key". Every other identity caller in the
    // bundle already passes this — this one did not, so it silently returned
    // null. Settings tolerated that (it renders a placeholder pane), which is
    // why the omission survived; the dashboard Runtime tile then read "—
    // runtime unavailable" on a project whose runtime the server knew perfectly
    // well.
    const res = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json() as IdentityPayload;
  } catch {
    return null;
  }
}

export interface SettingField {
  value: unknown;
  source: string;
  boot: boolean;
  type: string;
  options?: string[];
  min?: number;
  max?: number;
  label: string;
  description: string;
  /** Fuller explanation for the ⓘ tooltip (distinct from the terse description). */
  help?: string;
}

export async function fetchSettings(): Promise<Record<string, SettingField>> {
  try {
    // credentials:'include' — /v1/settings is scope-gated the same way
    // /v1/identity is, so without the cookie it 401s and this returns {}, which
    // renders as "no settings" rather than as an error.
    const res = await fetch(V1_ENDPOINTS.SETTINGS, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return {};
    const body = await res.json();
    return (body?.settings ?? {}) as Record<string, SettingField>;
  } catch {
    return {};
  }
}

export async function patchSettings(
  patch: Record<string, unknown>,
  confirm?: boolean,
): Promise<{ settings?: Record<string, SettingField>; confirmationRequired?: boolean; error?: string; message?: string }> {
  try {
    const res = await fetch(V1_ENDPOINTS.SETTINGS, {
      method: 'PATCH',
      // Writes need the cookie too — PATCH /v1/settings requires settings:admin
      // scope, so without it the save silently fails with an auth error the pane
      // reports as a generic "Error".
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch, confirm }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body?.error ?? 'Error', message: body?.message };
    return body;
  } catch (e) {
    return { error: 'NetworkError', message: String(e) };
  }
}
