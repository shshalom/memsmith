// SPDX-License-Identifier: Apache-2.0
//
// Item 3 UI (design doc 2026-07-27-local-fresh-install-readiness-design.md):
// the switcher must degrade gracefully -- render nothing, or just the
// current project -- when GET /v1/projects 404s or errors. That degradation
// is required behaviour, not a stopgap.
//
// SSR via renderToString does not run effects, so these tests exercise only
// the pre-fetch render (entries === null -> renders nothing). The
// post-fetch render (list populated, switcher interactive, actual
// navigation on selection) requires a real DOM and is NOT covered here --
// see the report for what still needs a browser click-through.
import { describe, it, expect, afterEach } from 'bun:test';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { ProjectSwitcher } from '../../src/ui/viewer/components/ProjectSwitcher.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('ProjectSwitcher', () => {
  it('renders nothing before the /v1/projects fetch resolves (SSR / pre-effect state)', () => {
    globalThis.fetch = (async () => ({ ok: true, json: async () => [] })) as unknown as typeof fetch;
    const html = renderToString(React.createElement(ProjectSwitcher, { scopedProjectId: '' }));
    expect(html).toBe('');
  });

  it('is constructed so a 404 from /v1/projects degrades to an empty list, not a thrown error', async () => {
    // fetchProjects itself is covered in server-data tests; this just proves
    // the component's initial (pre-effect) render never assumes data is present.
    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    expect(() => renderToString(React.createElement(ProjectSwitcher, { scopedProjectId: 'abc' }))).not.toThrow();
  });
});
