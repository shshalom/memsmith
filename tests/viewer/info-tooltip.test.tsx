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

  it('renders the text in a real popover element (not just a native title attribute)', () => {
    // Regression guard: the original relied on `title=`, which the browser
    // shows unreliably. The text must live in a styleable .info-tooltip-text
    // child so the CSS hover popover works.
    const html = renderToString(React.createElement(InfoTooltip, { text: 'Squeeze older memory.' }));
    expect(html).toContain('info-tooltip-text');
    expect(html).toContain('>Squeeze older memory.<'); // text is element content, not an attribute value
  });

  it('renders nothing when text is empty', () => {
    expect(renderToString(React.createElement(InfoTooltip, { text: '' }))).toBe('');
  });

  it('renders nothing when text is undefined', () => {
    expect(renderToString(React.createElement(InfoTooltip, { text: undefined }))).toBe('');
  });
});
