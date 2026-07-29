// SPDX-License-Identifier: Apache-2.0
import { V1_ENDPOINTS } from '../constants/api.js';

export interface IdentityPayload {
  teamId: string;
  projectId: string;
  keyPresent: boolean;
  keyMasked: string;
  keyPlaintext?: string;
  /** Optional so an older server response still parses; absent means 'local'. */
  runtime?: 'local' | 'team';
}

export async function fetchIdentity(reveal?: boolean): Promise<IdentityPayload | null> {
  try {
    const url = reveal ? `${V1_ENDPOINTS.IDENTITY}?reveal=true` : V1_ENDPOINTS.IDENTITY;
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
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
    const res = await fetch(V1_ENDPOINTS.SETTINGS, { headers: { 'Content-Type': 'application/json' } });
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
