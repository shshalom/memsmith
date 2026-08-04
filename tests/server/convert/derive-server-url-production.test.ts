// SPDX-License-Identifier: Apache-2.0
//
// deriveServerUrl's PRODUCTION branch — the one no local rig exercises.
//
// convert-context.test.ts already covers the function's three branches. What it
// does not do is record WHICH of them production takes, or what that costs. That
// gap is why "verified locally" has been misleading here: the local rig always
// hits the localhost branch, so the branch a real deployment uses has never run
// in anger.
//
// deriveServerUrl (convert-context.ts:25-32) resolves in this order:
//   1. `existingServerUrl` argument non-empty  -> returned VERBATIM
//   2. host is localhost / 127.0.0.1           -> `http://${host}:38879` (port HARD-CODED)
//   3. anything else                           -> `https://${host}`      (port DROPPED)
//
// Branch 3 is production. These tests pin its exact output — including the two
// cases where it is actively wrong — so that a future reader finds the hazard
// documented rather than discovering it against a live deployment.
//
// WHO REACHES BRANCH 3 (traced, not assumed):
//   - CONVERT does, always: ServerV1PostgresRoutes.ts:1866 calls
//     deriveServerUrl(input.databaseUrl) with the team's postgres:// URL.
//   - JOIN reaches it ONLY on the retained postgres:// fallback
//     (join-service.ts:201). The HTTPS join path returns before it and uses the
//     invite URL verbatim, which is why join-over-https.test.ts stubs this
//     function with a sentinel instead of the real thing.
import { describe, it, expect } from 'bun:test';
import { deriveServerUrl } from '../../../src/server/convert/convert-context.js';

describe('deriveServerUrl branch 3 — the production branch', () => {
  it('maps a remote database host to https, dropping the database port', () => {
    // Dropping :5432 is correct and intended: the API does not live on the
    // Postgres port. This is the sane half of branch 3.
    expect(deriveServerUrl('postgres://u:p@team.example.com:5432/db'))
      .toBe('https://team.example.com');
  });

  it('assumes the API is on 443 of the DATABASE host — the AWS hazard', () => {
    // THE TRAP, and the reason this file exists. On a real AWS deployment the
    // database is RDS and the API is behind an ALB on a DIFFERENT hostname, so
    // this derives a URL that points at the database host and will not serve
    // /v1 at all. Recorded as an assertion rather than a comment so it cannot be
    // rediscovered the hard way.
    //
    // THE FIX IS NOT TO CHANGE THIS FUNCTION: it is to supply
    // `existingServerUrl` (branch 1) from the project marker's serverUrl, which
    // takes precedence and is returned verbatim. The code comment at
    // convert-context.ts:30 says exactly this.
    expect(deriveServerUrl('postgres://u:p@memsmith-prod.abc123.us-east-1.rds.amazonaws.com:5432/memsmith'))
      .toBe('https://memsmith-prod.abc123.us-east-1.rds.amazonaws.com');
  });

  it('STRIPS a nonstandard port from an already-HTTP(S) url', () => {
    // Feeding this function a URL that is ALREADY an http(s) base url silently
    // discards the port, because branch 3 rebuilds from the hostname alone. A
    // team server on :8443 becomes unreachable.
    //
    // This is not currently reachable from the HTTPS join path — that path uses
    // the invite URL verbatim and never calls deriveServerUrl (verified: the
    // HTTPS branch in runJoin returns before join-service.ts:201). The
    // assertion exists so that if anyone ever routes an https:// invite through
    // here, this test names the consequence immediately.
    expect(deriveServerUrl('https://team.example.com:8443')).toBe('https://team.example.com');
  });

  it('upgrades http to https for a remote host', () => {
    // Any non-localhost input comes back https regardless of input scheme —
    // correct for a real deployment (TLS terminates at the load balancer), but
    // worth pinning because it means an http:// remote cannot be expressed.
    expect(deriveServerUrl('http://team.example.com:38879')).toBe('https://team.example.com');
  });

  it('branch 1 overrides branch 3 verbatim, INCLUDING a nonstandard port', () => {
    // The escape hatch, and the supported way to point at a real API host that
    // differs from the database host. Verbatim means the port survives.
    expect(deriveServerUrl('postgres://u:p@rds.amazonaws.com:5432/db', 'https://api.example.com:8443'))
      .toBe('https://api.example.com:8443');
  });

  it('branch 1 wins even when the derived value would be identical', () => {
    expect(deriveServerUrl('postgres://u:p@team.example.com/db', 'https://team.example.com'))
      .toBe('https://team.example.com');
  });

  it('an empty existingServerUrl does NOT override — it falls through', () => {
    // Guards the `existingServerUrl && length > 0` condition: a marker with an
    // empty serverUrl must not produce an empty base url, which would make every
    // request go to a relative path.
    expect(deriveServerUrl('postgres://u:p@team.example.com/db', '')).toBe('https://team.example.com');
  });
});

describe('deriveServerUrl branch 2 — the local rig branch', () => {
  it('hard-codes :38879 for localhost, IGNORING the real port', () => {
    // Why a second local server on another port is unreachable through this
    // function, and why an integration test must thread existingServerUrl
    // instead. A rig that relies on deriveServerUrl silently addresses the FIRST
    // server and reports a false pass.
    expect(deriveServerUrl('postgres://u:p@127.0.0.1:55433/postgres')).toBe('http://127.0.0.1:38879');
    expect(deriveServerUrl('http://127.0.0.1:38880')).toBe('http://127.0.0.1:38879');
  });

  it('keeps the hostname form it was given', () => {
    // localhost and 127.0.0.1 are not normalised to each other; the cookie and
    // CORS origin are per-host, so they are not interchangeable.
    expect(deriveServerUrl('postgres://u:p@localhost:5432/db')).toBe('http://localhost:38879');
  });
});
