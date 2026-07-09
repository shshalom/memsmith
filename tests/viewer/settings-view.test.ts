// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import React from 'react';
import SettingsView from '../../src/ui/viewer/views/SettingsView.js';

describe('SettingsView', () => {
  it('renders provider options and provenance from fields', () => {
    const fields: any = {
      provider: { value: 'ollama', source: 'team', boot: false, type: 'enum', options: ['ollama','claude'], label: 'Generation model', description: 'who distills' },
      tiering: { value: true, source: 'default', boot: false, type: 'boolean', label: 'Compression', description: 'squeeze' },
      monthlyTokenCap: { value: 0, source: 'env', boot: true, type: 'number', label: 'Monthly token cap', description: 'cap' },
    };
    const html = renderToString(React.createElement(SettingsView, { initialFields: fields } as any));
    expect(html).toContain('Generation model');
    expect(html).toContain('Compression');
    expect(html).toContain('team');       // provenance tag
    expect(html).toContain('after restart'); // boot note on the cap
  });
});
