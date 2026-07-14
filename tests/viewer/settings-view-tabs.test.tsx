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
    options: ['ollama', 'claude'], source: 'default', boot: false,
  },
  searchHybrid: {
    key: 'searchHybrid', value: true, type: 'boolean',
    label: 'Hybrid search',
    description: 'Blend keyword + semantic ranking.',
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

  it('surfaces a System field description as tooltip text on the System tab', () => {
    const html = renderToString(React.createElement(SettingsView, { initialFields: fields } as any));
    // The InfoTooltip renders the description as aria-label + title attributes
    expect(html).toContain('Who distills your memory.');
  });

  it('has the System pane active by default and renders field labels', () => {
    const html = renderToString(React.createElement(SettingsView, { initialFields: fields } as any));
    expect(html).toContain('Generation model');
    expect(html).toContain('Hybrid search');
  });

  it('includes the context-pane stub element', () => {
    const html = renderToString(React.createElement(SettingsView, { initialFields: fields } as any));
    expect(html).toContain('context-pane-stub');
  });
});
