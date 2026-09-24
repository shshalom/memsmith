// SPDX-License-Identifier: Apache-2.0
//
// A scope COOKIE must not answer for a project the request did not ask for.
//
// The viewer authenticates with a loopback cookie carrying an API key, and
// postgres-auth accepts that key unconditionally:
//
//   const cookieKey = (loopback checks) ? readLocalKeyCookie(...) : null;
//   const rawKey = bearer || xApiKey || cookieKey || null;
//
// So a request that EXPLICITLY names project B while holding a cookie for
// project A authenticates as A, silently. Measured live, repeatedly:
// /v1/identity?projectId=<tracked> with a dogfood cookie present returned the
// DOGFOOD's identity — projectId 5fc024f0…, keyPresent:true, role:owner — with
// the requested project absent from the answer. The user reloaded the dashboard
// several times and kept seeing the dogfood.
//
// Clearing the cookie on the `GET /` page load was not enough: it fixes the
// NEXT request only if the browser honours the expiry, and the API calls the
// dashboard fires carry the old cookie regardless. The decision has to be made
// where the credential is trusted, not upstream of it.
//
// This is the same view/credential disagreement behind every other bug in this
// area (bare-load re-scoping, sidebar vs Runtime tile, team-scoped keys leaking
// across a join): a request names one project, a credential names another, and
// the credential wins. A BEARER token is different — that is a deliberate,
// per-request credential, and its own project scope is already enforced by
// ensureProjectAllowed. This rule is for the ambient cookie only.

import { describe, it, expect } from 'bun:test';
import { cookieAppliesToRequest } from '../../../src/server/middleware/postgres-auth.js';

describe('cookieAppliesToRequest', () => {
  it('applies when the request names no project', () => {
    // A bare dashboard load: the cookie IS the scope. Nothing contradicts it.
    expect(cookieAppliesToRequest({ requestedProjectId: undefined, cookieProjectId: 'p-a' }))
      .toBe(true);
  });

  it('applies when the cookie belongs to the requested project', () => {
    expect(cookieAppliesToRequest({ requestedProjectId: 'p-a', cookieProjectId: 'p-a' }))
      .toBe(true);
  });

  it('DOES NOT apply when the request names a different project', () => {
    // THE BUG. The cookie answered for the dogfood while the URL named a tracked
    // project, so the dashboard rendered the wrong project's data under the right
    // project's name — and the Join button never appeared.
    expect(cookieAppliesToRequest({ requestedProjectId: 'p-tracked', cookieProjectId: 'p-dogfood' }))
      .toBe(false);
  });

  it('applies when the cookie\'s project cannot be determined', () => {
    // Fail OPEN here, deliberately. If we cannot resolve which project a cookie
    // belongs to, refusing it would break every existing dashboard session on
    // this machine. The narrower rule — drop it only when we KNOW it names a
    // different project — fixes the observed bug without that risk.
    expect(cookieAppliesToRequest({ requestedProjectId: 'p-tracked', cookieProjectId: null }))
      .toBe(true);
  });

  it('treats a whitespace-only requested project as absent', () => {
    expect(cookieAppliesToRequest({ requestedProjectId: '   ', cookieProjectId: 'p-a' }))
      .toBe(true);
  });
});
