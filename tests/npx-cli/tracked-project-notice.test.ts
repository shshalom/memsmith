// SPDX-License-Identifier: Apache-2.0
//
// Install must RECOGNISE a project that already has an identity.
//
// The product owner's requirement, in their words: "they going to check out the
// project, and if it their first time they going to install memsmith. During
// install memsmith should identify whether or not it has memsmith configuration
// and identity, so it will pick things up."
//
// install.ts had zero references to the marker — 1,922 lines that never asked
// whether the directory it was run in already belonged to a team. A teammate
// cloning a converted project got the generic "you're all set" and no
// indication that a team workspace existed, let alone how to join it.
//
// The notice is informational only. It must never claim the user has joined,
// because they have not: the marker carries no credential, so capture stays
// local until they supply the team key.

import { describe, it, expect } from 'bun:test';
import { trackedProjectNotice } from '../../src/npx-cli/install/tracked-project-notice.js';

describe('trackedProjectNotice', () => {
  it('returns null for a directory with no MemSmith identity', () => {
    // The overwhelmingly common case: a plain install. Say nothing.
    expect(trackedProjectNotice({ state: 'untracked', marker: null })).toBeNull();
  });

  it('returns null for a purely local project', () => {
    // An existing local project has an identity but no team. Nothing to join,
    // so announcing a team here would be a lie.
    const marker = { teamId: 't', projectId: 'p' };
    expect(trackedProjectNotice({ state: 'untracked', marker })).toBeNull();
  });

  it('announces the team and how to join when tracked', () => {
    const marker = {
      teamId: 'team-a', projectId: 'acme-api', runtime: 'server',
      serverUrl: 'https://memsmith.example.com',
    };
    const notice = trackedProjectNotice({ state: 'tracked', marker });
    expect(notice).not.toBeNull();
    expect(notice!.title).toMatch(/team/i);
    // The teammate needs to know WHICH project and WHERE before handing over a
    // key — a prompt naming neither is a prompt to trust an unknown server.
    expect(notice!.body).toContain('acme-api');
    expect(notice!.body).toContain('https://memsmith.example.com');
    expect(notice!.actionable).toBe(true);
  });

  it('states plainly that capture stays local until the user joins', () => {
    // The single most important line. Without it the teammate assumes their
    // work is already reaching the team, and silently accumulates local-only
    // observations believing otherwise.
    const marker = { teamId: 't', projectId: 'p', runtime: 'server', serverUrl: 'https://x' };
    const notice = trackedProjectNotice({ state: 'tracked', marker });
    expect(notice!.body).toMatch(/local/i);
    expect(notice!.body).toMatch(/join/i);
  });

  it('never claims the user has joined', () => {
    const marker = { teamId: 't', projectId: 'p', runtime: 'server', serverUrl: 'https://x' };
    const body = trackedProjectNotice({ state: 'tracked', marker })!.body;
    expect(body).not.toMatch(/you (are|have) (now )?joined/i);
    expect(body).not.toMatch(/connected to the team/i);
  });

  it('confirms membership without prompting when already joined', () => {
    // A machine that holds the key is already in. Report it, but offer nothing
    // — prompting to join a team you are in is noise.
    const marker = { teamId: 't', projectId: 'acme-api', runtime: 'server', serverUrl: 'https://x' };
    const notice = trackedProjectNotice({ state: 'joined', marker });
    expect(notice).not.toBeNull();
    expect(notice!.actionable).toBe(false);
    expect(notice!.body).toContain('acme-api');
  });

  it('omits the server line when the marker carries no URL', () => {
    // A marker written before serverUrl was recorded. Report what is known
    // rather than printing "undefined" at the user.
    const marker = { teamId: 't', projectId: 'p', runtime: 'server' };
    const body = trackedProjectNotice({ state: 'tracked', marker })!.body;
    expect(body).not.toContain('undefined');
  });

  it('never includes anything key-shaped', () => {
    // The marker holds no credential by construction; this guards against a
    // future field leaking one into terminal output and shell history.
    const marker = {
      teamId: 't', projectId: 'p', runtime: 'server', serverUrl: 'https://x',
    };
    const body = trackedProjectNotice({ state: 'tracked', marker })!.body;
    expect(body).not.toMatch(/cmem_/);
  });
});
