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

/** Expire the cookie immediately. Same attributes, so the browser matches it. */
export function buildClearedLocalKeyCookie(): string {
  return [
    `${LOCAL_KEY_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ].join('; ');
}

export interface ViewerCookieDecision {
  action: 'set' | 'clear' | 'none';
  key?: string;
}

/**
 * What should the viewer do with the scope cookie on this request?
 *
 * Extracted so the rule is one testable function instead of an if/else inside a
 * route handler — this decision has produced six separate bugs (see
 * tests/server/runtime/viewer-scope-contract.test.ts).
 *
 * THE CASE THAT WAS MISSING: an explicit ?project= naming a project this machine
 * holds NO key for. resolveLocalKey correctly returns null, the route did
 * nothing, and the browser kept its previous cookie — so every API call
 * authenticated as the OLD project. Measured live: with a dogfood cookie
 * present, /v1/identity?project=<tracked> answered with the dogfood's identity,
 * the requested project absent from the response. The tracked-view grant that
 * handles exactly this case is never reached, because a valid key was presented
 * and key auth wins first.
 *
 * So an explicit request is honoured in BOTH directions: a project you can open
 * swaps the cookie in, one you cannot clears it out. A bare load still never
 * re-scopes an existing cookie — that guard prevents a plain `/` reload from
 * aiming the Go Team wizard at the server's own project.
 */
export function decideViewerCookie(input: {
  requested: string | undefined;
  resolvedKey: string | null;
  hasExistingCookie: boolean;
}): ViewerCookieDecision {
  const requested = input.requested?.trim();

  // Bare load: keep whatever scope the caller already has.
  if (!requested) {
    if (input.hasExistingCookie) return { action: 'none' };
    return input.resolvedKey ? { action: 'set', key: input.resolvedKey } : { action: 'none' };
  }

  // Explicit request, and we hold that project's key: switch to it.
  if (input.resolvedKey) return { action: 'set', key: input.resolvedKey };

  // Explicit request, no key for it. Leaving the old cookie in place is what
  // silently displayed the wrong project; drop it so the request is answered as
  // the project that was actually asked for (unauthenticated, read-only).
  return input.hasExistingCookie ? { action: 'clear' } : { action: 'none' };
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
