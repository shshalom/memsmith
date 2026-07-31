// SPDX-License-Identifier: Apache-2.0
//
// Every /v1 fetch from the viewer MUST pass credentials:'include'.
//
// /v1/identity and /v1/settings authenticate via the viewer's project cookie.
// Omit credentials and the browser sends nothing, the route answers
// 401 "Missing API key", and the caller's catch-all returns null/{} — so the UI
// renders "unavailable" or "no settings" instead of surfacing an auth failure.
//
// fetchIdentity had this exact omission. Settings tolerated it (it renders a
// placeholder pane when identity is null), which is why it survived unnoticed.
// It only became visible when the dashboard Runtime tile started reading
// identity: the tile showed "— runtime unavailable" for a project whose runtime
// the server knew perfectly well and returned correctly to curl.
//
// The failure is silent by construction: a 401 is indistinguishable from "no
// data" once the catch swallows it. So this is asserted structurally — every
// fetch in the module, not just the ones we remember.
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(import.meta.dir, '..', '..');
const SRC = readFileSync(join(REPO, 'src/ui/viewer/utils/settingsData.ts'), 'utf-8');

/** Each `fetch(` call plus the option object that follows it. */
function fetchCalls(src: string): string[] {
  const calls: string[] = [];
  let idx = src.indexOf('fetch(');
  while (idx !== -1) {
    // A fetch's options object closes well within this window; generous enough
    // to survive comments inside the call.
    calls.push(src.slice(idx, idx + 500));
    idx = src.indexOf('fetch(', idx + 1);
  }
  return calls;
}

describe('settingsData /v1 fetches carry the project cookie', () => {
  it('finds the fetch call sites at all (guard against a silent rename)', () => {
    expect(fetchCalls(SRC).length).toBeGreaterThanOrEqual(3);
  });

  it('EVERY fetch passes credentials: include', () => {
    const missing = fetchCalls(SRC).filter(call => !call.includes("credentials: 'include'"));
    // Named in the failure so a new offender is obvious, not just a count.
    expect(missing.map(c => c.slice(0, 70))).toEqual([]);
  });

  it('fetchIdentity specifically — the one that regressed', () => {
    const fn = SRC.slice(SRC.indexOf('export async function fetchIdentity'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain("credentials: 'include'");
  });

  it('the settings WRITE path carries it too', () => {
    // A read failing degrades to empty; a write failing loses the user's edit.
    const fn = SRC.slice(SRC.indexOf('export async function patchSettings'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain("credentials: 'include'");
    expect(body).toContain("method: 'PATCH'");
  });
});
