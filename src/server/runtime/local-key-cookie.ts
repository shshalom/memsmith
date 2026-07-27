// SPDX-License-Identifier: Apache-2.0
//
// Loopback credential handoff for the local dashboard.
//
// Local runtime mints a base API key into CredentialStore at session start, and
// that key authenticates against every route. The browser, however, was never
// given it: the viewer sends no Authorization header and the server injected no
// credential, so under the shipped `api-key` default the dashboard 401'd on its
// own data. This module carries that already-minted key to the browser.
//
// A cookie rather than an injected global plus a header, for two reasons:
// EventSource cannot set custom headers, so a header-only scheme would leave
// SSE broken; and HttpOnly keeps the key unreadable from page scripts.
//
// This is NOT a new credential and NOT an auth bypass. It is the existing key,
// handed to a loopback client, still verified by the normal api-key path.

export const LOCAL_KEY_COOKIE = 'memsmith_local_key';

// Serialize the Set-Cookie value. The key is percent-encoded so no value can
// smuggle a `;` and forge cookie attributes. Session cookie (no Max-Age): it
// dies with the browser session, and `/` reloads issue a fresh one.
export function buildLocalKeyCookie(key: string): string {
  return [
    `${LOCAL_KEY_COOKIE}=${encodeURIComponent(key)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ].join('; ');
}

// Pull our key out of a raw Cookie header. Returns null when absent or empty.
export function readLocalKeyCookie(header: string | undefined | null): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    // Exact name match — `evil_memsmith_local_key=...` must not satisfy this.
    if (part.slice(0, eq).trim() !== LOCAL_KEY_COOKIE) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try { return decodeURIComponent(raw) || null; } catch { return raw || null; }
  }
  return null;
}
