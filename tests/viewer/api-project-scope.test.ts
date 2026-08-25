// SPDX-License-Identifier: Apache-2.0
//
// EVERY viewer API call must carry the page's project.
//
// The page URL says `?project=<id>` (the SPA's spelling); the server reads
// `projectId` (the /v1 API's spelling). A request that omits it is UNSCOPED, so
// the server answers for whatever the cookie names — or, for a project whose
// credential it cannot validate, 401s and the panel renders empty.
//
// This was fixed one call site at a time, each time a different panel was
// reported broken: the metrics tile, then the Observations tab, then Settings.
// Same omission every time, three separate round trips. Measured live on
// Settings: /v1/settings without the param -> 401, with it -> 200 and real data.
//
// So the translation now lives in ONE helper and this file guards two things:
// the helper's behaviour, and that no fetch site hand-rolls the query string
// again. A source scan is the only way to catch the latter — a unit test of
// apiUrl cannot notice a caller that never invokes it.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { withApiProject } from '../../src/ui/viewer/utils/projectScope.js';

const REPO = join(import.meta.dir, '..', '..');

describe('withApiProject', () => {
  it('translates the page param to the API param', () => {
    // project -> projectId. The mismatch is the whole point: a request can look
    // scoped while arriving unscoped.
    expect(withApiProject('/v1/settings', '?project=p1')).toBe('/v1/settings?projectId=p1');
  });

  it('leaves the endpoint alone when the page has no project', () => {
    // A bare `/` is a legitimate first visit; pinning an empty value would make
    // the URL lie about being scoped.
    expect(withApiProject('/v1/settings', '')).toBe('/v1/settings');
    expect(withApiProject('/v1/settings', '?other=1')).toBe('/v1/settings');
  });

  it('appends with & when the endpoint already has a query', () => {
    expect(withApiProject('/v1/x?a=1', '?project=p1')).toBe('/v1/x?a=1&projectId=p1');
  });

  it('encodes the project id', () => {
    expect(withApiProject('/v1/x', '?project=a%2Fb')).toContain('projectId=a%2Fb');
  });

  it('preserves other page params without forwarding them', () => {
    // Only the project crosses over; page-level state is not the API's business.
    expect(withApiProject('/v1/x', '?project=p1&page=3')).toBe('/v1/x?projectId=p1');
  });
});

describe('no fetch site hand-rolls the project param', () => {
  const files = ['src/ui/viewer/utils/serverData.ts', 'src/ui/viewer/utils/settingsData.ts'];

  it('routes every fetch through apiUrl rather than building the query inline', () => {
    // The regression guard. Three panels broke in a row because each call site
    // solved this separately — or forgot to. Any new `projectId=` template
    // literal here means someone bypassed the shared helper again.
    for (const f of files) {
      const src = readFileSync(join(REPO, f), 'utf-8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
      expect(code).not.toMatch(/`\$\{[^}]*\}\?projectId=/);
      expect(code).toContain('apiUrl(');
    }
  });

  it('still sends credentials on every viewer fetch', () => {
    // The other half of the same class of bug: without credentials:'include'
    // the browser attaches no cookie and every call 401s, which the UI renders
    // as "Not authenticated". fetchProjects is exempt — it is loopback-gated and
    // degrades to an empty list by design.
    const src = readFileSync(join(REPO, 'src/ui/viewer/utils/settingsData.ts'), 'utf-8');
    const fetches = (src.match(/await fetch\(/g) ?? []).length;
    const creds = (src.match(/credentials: 'include'/g) ?? []).length;
    expect(creds).toBe(fetches);
  });
});
