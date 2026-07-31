// SPDX-License-Identifier: Apache-2.0
//
// A BARE viewer request must not overwrite an existing scoped cookie.
//
// The viewer authenticates via a loopback cookie carrying a project's base key.
// `?project=<id>` selects which project's key is issued. Without that param,
// resolveLocalKey falls back to the SERVER's own project — so every plain `/`
// load silently re-scoped the entire dashboard back to the server's project.
//
// Measured live: GET /?project=<run2> then /v1/identity -> run2, runtime "team".
// One bare GET / later -> the dogfood project, runtime "local". The sidebar still
// read "ms-p3-run2 · Team" while the Runtime tile showed the DOGFOOD's runtime.
// Two panels describing different projects, with no error anywhere.
//
// This is worse than a display bug. The Go Team wizard converts whatever the
// request authenticates as, so a bare reload before pressing GO TEAM would have
// aimed the convert at the server's project instead of the one on screen — the
// convert-scope leak again, this time reachable from the UI.
//
// Three properties, and the third is the one that makes it safe:
//   1. A bare request with an existing cookie issues NOTHING.
//   2. An explicit ?project= always wins — a deliberate switch must work.
//   3. A bare request with NO cookie still issues one — a first visit must
//      authenticate, or the dashboard 401s on its own data.
import { describe, it, expect } from 'bun:test';
import { buildLocalKeyCookie, readLocalKeyCookie, LOCAL_KEY_COOKIE } from '../../src/server/runtime/local-key-cookie.js';

/**
 * The route's decision, extracted. Mirrors ServerViewerRoutes: given the
 * requested project and the incoming Cookie header, should a new cookie be
 * issued, and for which project?
 */
function cookieDecision(
  requested: string | undefined,
  cookieHeader: string | undefined,
): { issue: boolean; forProject: string | undefined } {
  const existing = readLocalKeyCookie(cookieHeader);
  if (!requested && existing) return { issue: false, forProject: undefined };
  return { issue: true, forProject: requested };
}

const SCOPED = buildLocalKeyCookie('cmem_run2key');

describe('viewer scoped cookie', () => {
  it('a BARE request does not overwrite an existing cookie', () => {
    // The regression: this is a refresh, or any navigation that drops the query.
    const d = cookieDecision(undefined, SCOPED);
    expect(d.issue).toBe(false);
  });

  it('an explicit ?project= still wins — switching must work', () => {
    const d = cookieDecision('project-b', SCOPED);
    expect(d.issue).toBe(true);
    expect(d.forProject).toBe('project-b');
  });

  it('re-selecting the SAME project still reissues, so a stale key self-heals', () => {
    const d = cookieDecision('project-a', SCOPED);
    expect(d.issue).toBe(true);
  });

  it('a first visit with NO cookie still gets one', () => {
    // Otherwise the dashboard has no credential and 401s on its own data —
    // trading a scoping bug for a total auth failure.
    const d = cookieDecision(undefined, undefined);
    expect(d.issue).toBe(true);
    expect(d.forProject).toBeUndefined();
  });

  it('an empty cookie header counts as no cookie', () => {
    expect(cookieDecision(undefined, '').issue).toBe(true);
    expect(cookieDecision(undefined, `${LOCAL_KEY_COOKIE}=`).issue).toBe(true);
  });

  it('an unrelated cookie does not count as ours', () => {
    // Another cookie on localhost must not suppress issuance and leave the
    // viewer unauthenticated.
    expect(cookieDecision(undefined, 'some_other=value').issue).toBe(true);
  });
});

describe('the route wires that decision', () => {
  it('ServerViewerRoutes reads the existing cookie before issuing', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const src = readFileSync(
      join(import.meta.dir, '..', '..', 'src/server/runtime/ServerViewerRoutes.ts'),
      'utf-8',
    );
    // Guard: an unconditional setHeader here is exactly the bug.
    expect(src).toContain('readLocalKeyCookie');
    expect(src).toMatch(/if \(!requested && existing\)/);
  });
});
