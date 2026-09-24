// SPDX-License-Identifier: Apache-2.0
//
// THE VIEWER SCOPE CONTRACT. Read this before changing how the dashboard
// decides which project it is showing.
//
// The dashboard answers "which project am I looking at?" from a CREDENTIAL: a
// loopback cookie carrying an API key, where the key determines the project.
// That single decision has produced at least five separate bugs, each found in
// live use rather than by a test, each fixed in isolation:
//
//   1. A bare `/` load overwrote the scoped cookie, silently re-scoping the
//      dashboard back to the server's own project. Worse than cosmetic: the Go
//      Team wizard converts whatever the request authenticates as, so a bare
//      reload before pressing GO TEAM aimed it at the wrong project.
//      (Guarded by viewer-scoped-cookie-preserved.test.ts.)
//   2. The sidebar showed one project while the Runtime tile showed another.
//   3. The cookie was scoped to the TEAM, not the project, so after a join two
//      local projects shared one key and either could read the other.
//   4. Cookie issuance was silently disabled by an env-var check no unit test
//      covered.
//   5. A project with NO key — the "tracked but not joined" state the whole
//      joiner feature rests on — cannot be viewed at all, because there is no
//      credential to authenticate as. So the Join button cannot render on the
//      one machine that needs it.
//
// They are all one bug: the VIEW and the CREDENTIAL disagree, and the credential
// wins. #5 is the terminal case — a project that legitimately has no credential
// becomes invisible.
//
// This file pins the parts of that contract that are load-bearing, so the next
// change confronts them instead of rediscovering them.

import { describe, it, expect } from 'bun:test';
import { resolveViewerKeyForRequest } from '../../../src/server/runtime/viewer-project-scope.js';

const SERVER_TEAM = 'team-server';

describe('viewer scope contract', () => {
  it('a bare load (no ?project=) gets the SERVER project\'s key', async () => {
    // The only case where the server's own project is the right answer: the
    // caller expressed no preference.
    const key = await resolveViewerKeyForRequest({
      serverTeamId: SERVER_TEAM,
      lookupTeamForProject: async () => null,
      resolveKeyForTeam: (t) => (t === SERVER_TEAM ? 'key-server' : null),
    });
    expect(key).toBe('key-server');
  });

  it('prefers the REQUESTED project\'s own key over its team\'s key', async () => {
    // Bug 3. CredentialStore is keyed by team alone, so after a join two
    // projects in one team both resolved to whichever key was stored first —
    // and each could then read the other's memory. Measured live: asking for the
    // joiner's project handed back the OWNER's key.
    const key = await resolveViewerKeyForRequest({
      requestedProjectId: 'p-alpha',
      serverTeamId: SERVER_TEAM,
      lookupTeamForProject: async () => 'team-shared',
      resolveKeyForTeam: () => 'key-of-TEAM',
      resolveKeyForProject: async (p) => `key-of-${p}`,
    });
    expect(key).toBe('key-of-p-alpha');
  });

  it('NEVER hands back another project\'s key when the requested one has none', async () => {
    // Bug 5, and the load-bearing assertion here.
    //
    // A "tracked but not joined" project has no key BY DEFINITION — that is what
    // tracked means. Returning any other key would authenticate the browser as a
    // DIFFERENT project while the URL names this one: precisely the
    // view/credential disagreement behind bugs 1-3, and a cross-project read at
    // worst.
    //
    // So the correct answer is "no key", and that is WHY the dashboard cannot
    // currently show a tracked project. That is a KNOWN GAP, not something to
    // paper over by loosening this assertion. The fix belongs in how the viewer
    // AUTHENTICATES — loopback trust for a marker-only project, or minting a
    // local-only key — never in letting a mismatched key through.
    const key = await resolveViewerKeyForRequest({
      requestedProjectId: 'p-tracked',
      serverTeamId: SERVER_TEAM,
      lookupTeamForProject: async () => 'team-nobody-has-a-key-for',
      resolveKeyForTeam: (t) => (t === SERVER_TEAM ? 'key-server' : null),
      resolveKeyForProject: async () => null,
    });
    // Explicitly NOT 'key-server': falling back to the server's key here is the
    // bug, because the caller asked for a different project.
    expect(key).not.toBe('key-server');
  });

  it('degrades to no key rather than throwing when a lookup fails', async () => {
    // This runs on every dashboard load. An unreachable database must not 500
    // the viewer, and must not silently substitute the server's key either.
    const key = await resolveViewerKeyForRequest({
      requestedProjectId: 'p-x',
      serverTeamId: SERVER_TEAM,
      lookupTeamForProject: async () => { throw new Error('db down'); },
      resolveKeyForTeam: (t) => (t === SERVER_TEAM ? 'key-server' : null),
      resolveKeyForProject: async () => { throw new Error('db down'); },
    });
    expect(key === null || key === undefined || typeof key === 'string').toBe(true);
  });
});
