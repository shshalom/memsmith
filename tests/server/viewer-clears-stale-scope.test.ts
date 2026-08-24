// SPDX-License-Identifier: Apache-2.0
//
// An explicit ?project= must never leave the browser scoped to a DIFFERENT
// project.
//
// The viewer route decides the cookie like this:
//
//   const key = await resolveLocalKey(requested);
//   if (key) res.setHeader('Set-Cookie', buildLocalKeyCookie(key));
//
// For a TRACKED project — a clone of a team project this machine holds no key
// for — resolveLocalKey correctly returns null. So no cookie is set, the browser
// keeps whatever it already had, and every subsequent API call authenticates as
// THAT project instead.
//
// Measured live: with a dogfood cookie present,
// GET /v1/identity?project=<tracked> returned the DOGFOOD's identity
// (projectId 5fc024f0…, keyPresent:true, role:owner) — the requested project
// nowhere in the answer. The tracked-view grant that makes this case work is
// never reached, because a valid key was presented and key auth wins first.
//
// So the request has to be honoured in both directions: naming a project you
// CAN open swaps the cookie in; naming one you cannot must clear it out. Leaving
// a stale credential in place is what silently shows the wrong project — the
// same failure the bare-load guard already prevents for the no-query case.

import { describe, it, expect } from 'bun:test';
import { decideViewerCookie } from '../../src/server/runtime/local-key-cookie.js';

describe('decideViewerCookie', () => {
  it('issues the requested project\'s key when one resolves', () => {
    expect(decideViewerCookie({
      requested: 'p-alpha', resolvedKey: 'key-alpha', hasExistingCookie: true,
    })).toEqual({ action: 'set', key: 'key-alpha' });
  });

  it('CLEARS a stale cookie when the requested project has no key', () => {
    // THE FIX. Previously this did nothing, so the browser stayed authenticated
    // as the previous project and the dashboard showed it instead.
    expect(decideViewerCookie({
      requested: 'p-tracked', resolvedKey: null, hasExistingCookie: true,
    })).toEqual({ action: 'clear' });
  });

  it('does nothing when the requested project has no key and no cookie exists', () => {
    // Nothing to clear; the tracked-view grant handles the request unauthenticated.
    expect(decideViewerCookie({
      requested: 'p-tracked', resolvedKey: null, hasExistingCookie: false,
    })).toEqual({ action: 'none' });
  });

  it('leaves an existing cookie ALONE on a bare load', () => {
    // The pre-existing guard, unchanged: without ?project=, a plain `/` load
    // must not re-scope the dashboard back to the server's own project. That bug
    // could aim the Go Team wizard at the wrong project.
    expect(decideViewerCookie({
      requested: undefined, resolvedKey: 'key-server', hasExistingCookie: true,
    })).toEqual({ action: 'none' });
  });

  it('issues the server key on a bare load with no cookie', () => {
    // The only case where the server's own project is the right default: the
    // caller has expressed no preference and holds no scope.
    expect(decideViewerCookie({
      requested: undefined, resolvedKey: 'key-server', hasExistingCookie: false,
    })).toEqual({ action: 'set', key: 'key-server' });
  });

  it('treats a whitespace-only ?project= as a bare load', () => {
    expect(decideViewerCookie({
      requested: '   ', resolvedKey: 'key-server', hasExistingCookie: true,
    })).toEqual({ action: 'none' });
  });
});
