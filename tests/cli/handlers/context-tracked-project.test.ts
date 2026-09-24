// SPDX-License-Identifier: Apache-2.0
//
// Recognition must not depend on HOW MemSmith was installed.
//
// The first version of this lived in `npx memsmith install`. The product owner
// installed via Claude Code's `/plugin` instead — "that how anyone else going
// to do it" — which never calls the npx CLI, so the code never ran and no
// notice appeared. Recognition was attached to the wrong event.
//
// Installing is a one-time act, often in some other directory. OPENING THE
// PROJECT is what actually reveals which project you are in, it happens every
// session, and it is identical across `/plugin`, `npx memsmith install`, and
// any future installer. So the notice belongs on SessionStart, which is also
// where MemSmith already reads the marker to build the dashboard link.
//
// The requirement, verbatim: "match behaviours regardless how the user is
// choosing to install memsmith."

import { describe, it, expect } from 'bun:test';
import { trackedProjectBanner } from '../../../src/cli/handlers/tracked-project-banner.js';

describe('trackedProjectBanner (SessionStart)', () => {
  it('says nothing for an untracked project', () => {
    // The overwhelmingly common session. A banner here would be noise on every
    // local project, every session, forever.
    expect(trackedProjectBanner({ state: 'untracked', marker: null })).toBe('');
  });

  it('says nothing once this machine has joined', () => {
    // A joined project is just a working team project. Repeating "you are in a
    // team" every session is noise, and the runtime tile already shows it.
    const marker = { teamId: 't', projectId: 'p', runtime: 'server' };
    expect(trackedProjectBanner({ state: 'joined', marker })).toBe('');
  });

  it('announces a tracked project and says capture is LOCAL until join', () => {
    // The case the whole feature exists for: the marker names a team this
    // machine holds no key for.
    const marker = {
      teamId: 't', projectId: 'acme-api', runtime: 'server',
      serverUrl: 'https://memsmith.example.com',
    };
    const out = trackedProjectBanner({ state: 'tracked', marker });
    expect(out).toContain('acme-api');
    expect(out).toContain('https://memsmith.example.com');
    // Without this line the teammate assumes their work already reaches the
    // team and silently accumulates local-only observations.
    expect(out).toMatch(/local/i);
    expect(out).toMatch(/join/i);
  });

  it('never claims the user has joined', () => {
    const marker = { teamId: 't', projectId: 'p', runtime: 'server', serverUrl: 'https://x' };
    const out = trackedProjectBanner({ state: 'tracked', marker });
    expect(out).not.toMatch(/you (are|have) (now )?joined/i);
    expect(out).not.toMatch(/connected to the team/i);
  });

  it('omits the server line rather than printing undefined', () => {
    const marker = { teamId: 't', projectId: 'p', runtime: 'server' };
    expect(trackedProjectBanner({ state: 'tracked', marker })).not.toContain('undefined');
  });

  it('never emits anything key-shaped', () => {
    // The marker carries no credential by construction; this guards a future
    // field from leaking one into the session transcript.
    const marker = { teamId: 't', projectId: 'p', runtime: 'server', serverUrl: 'https://x' };
    expect(trackedProjectBanner({ state: 'tracked', marker })).not.toMatch(/cmem_/);
  });

  it('produces the SAME facts the npx installer reports', () => {
    // THE POINT OF THIS FILE. Both surfaces are driven by one classification,
    // so a teammate is told the same thing whether they ran `/plugin` or
    // `npx memsmith install`. Wording differs (a banner is terser than an
    // install panel); the facts must not.
    const marker = {
      teamId: 't', projectId: 'acme-api', runtime: 'server',
      serverUrl: 'https://memsmith.example.com',
    };
    const banner = trackedProjectBanner({ state: 'tracked', marker });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { trackedProjectNotice } = require('../../../src/npx-cli/install/tracked-project-notice.js');
    const notice = trackedProjectNotice({ state: 'tracked', marker });
    for (const fact of ['acme-api', 'https://memsmith.example.com']) {
      expect(banner).toContain(fact);
      expect(notice.body).toContain(fact);
    }
    // Both must carry the local-until-join warning.
    expect(banner).toMatch(/local/i);
    expect(notice.body).toMatch(/local/i);
  });
});
