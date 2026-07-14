// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { InfoTooltip } from '../../src/ui/viewer/components/InfoTooltip.js';

describe('InfoTooltip', () => {
  it('renders the info icon and the tooltip text when text is provided', () => {
    const html = renderToString(React.createElement(InfoTooltip, { text: 'Blends keyword + semantic ranking.' }));
    expect(html).toContain('Blends keyword + semantic ranking.');
    // the icon marker (class or aria) is present
    expect(html.toLowerCase()).toContain('info');
  });

  it('renders nothing when text is empty', () => {
    expect(renderToString(React.createElement(InfoTooltip, { text: '' }))).toBe('');
  });

  it('renders nothing when text is undefined', () => {
    expect(renderToString(React.createElement(InfoTooltip, { text: undefined }))).toBe('');
  });
});
