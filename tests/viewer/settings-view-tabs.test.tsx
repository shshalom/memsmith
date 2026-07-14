// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import React from 'react';
import SettingsView from '../../src/ui/viewer/views/SettingsView.js';

const fields: any = {
  provider: {
    key: 'provider', value: 'ollama', type: 'enum',
    label: 'Generation model',
    description: 'Who distills your memory.',
    help: 'FULLER-PROVIDER-HELP: the provider that distills sessions into observations.',
    options: ['ollama', 'claude'], source: 'default', boot: false,
  },
  searchHybrid: {
    key: 'searchHybrid', value: true, type: 'boolean',
    label: 'Hybrid search',
    description: 'Blend keyword + semantic ranking.',
    help: 'FULLER-HYBRID-HELP: blends keyword + semantic recall.',
    source: 'default', boot: false,
  },
};

describe('SettingsView tabs', () => {
  it('renders System, Context, Identity tab labels', () => {
    const html = renderToString(React.createElement(SettingsView, { initialFields: fields } as any));
    expect(html).toContain('System');
    expect(html).toContain('Context');
    expect(html).toContain('Identity');
  });

  it('shows the terse description on the row AND the fuller help in the ⓘ tooltip (distinct text)', () => {
    const html = renderToString(React.createElement(SettingsView, { initialFields: fields } as any));
    // Row keeps the short description (always-visible row-desc line)…
    expect(html).toContain('Who distills your memory.');
    // …and the ⓘ carries the DISTINCT fuller help (regression guard: the ⓘ
    // must NOT just echo the description — it uses field.help).
    expect(html).toContain('FULLER-PROVIDER-HELP');
    expect(html).toContain('info-tooltip-text');
  });

  it('has the System pane active by default and renders field labels', () => {
    const html = renderToString(React.createElement(SettingsView, { initialFields: fields } as any));
    expect(html).toContain('Generation model');
    expect(html).toContain('Hybrid search');
  });

  it('shows the Context pane wrapper but NOT the pane content before first tab activation (lazy-mount)', () => {
    // With lazy-mount, ContextSettingsPane only renders after the Context tab
    // is first visited. In SSR the default tab is 'system', so the pane body
    // should be absent from the initial render.
    const html = renderToString(React.createElement(SettingsView, { initialFields: fields } as any));
    // The settings-pane--context wrapper div is always present (for the hidden attr)
    expect(html).toContain('settings-pane--context');
    // But the pane's field content should NOT be present yet
    expect(html).not.toContain('data-testid="context-pane-stub"');
  });
});
