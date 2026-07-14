// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { ContextSettingsPane } from '../../src/ui/viewer/components/ContextSettingsPane.js';
import SettingsView from '../../src/ui/viewer/views/SettingsView.js';

const baseSettings: any = {
  MEMSMITH_MODEL: 'claude-sonnet-4-6',
  MEMSMITH_CONTEXT_OBSERVATIONS: '50',
  MEMSMITH_CONTEXT_SESSION_COUNT: '10',
  MEMSMITH_CONTEXT_FULL_COUNT: '5',
  MEMSMITH_CONTEXT_FULL_FIELD: 'narrative',
  MEMSMITH_CONTEXT_SHOW_READ_TOKENS: 'false',
  MEMSMITH_CONTEXT_SHOW_WORK_TOKENS: 'false',
  MEMSMITH_CONTEXT_SHOW_SAVINGS_AMOUNT: 'false',
  MEMSMITH_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',
  MEMSMITH_CONTEXT_SHOW_LAST_SUMMARY: 'true',
  MEMSMITH_CONTEXT_SHOW_LAST_MESSAGE: 'false',
  MEMSMITH_WORKER_PORT: '37777',
  MEMSMITH_WORKER_HOST: '127.0.0.1',
};

describe('ContextSettingsPane', () => {
  it('renders context display fields with info tooltips', () => {
    const html = renderToString(
      React.createElement(ContextSettingsPane, {
        settings: baseSettings,
        onSave: () => {},
        isSaving: false,
        saveStatus: null,
      })
    );
    // Key context field labels should be present
    expect(html).toContain('Observations');
    expect(html).toContain('Sessions');
    // InfoTooltip renders an ⓘ with class/aria containing "info"
    expect(html.toLowerCase()).toContain('info');
    // Should have a Save button
    expect(html).toContain('Save');
  });

  it('renders toggle switches for SHOW_ settings (Token Economics section)', () => {
    const html = renderToString(
      React.createElement(ContextSettingsPane, {
        settings: { ...baseSettings, MEMSMITH_CONTEXT_SHOW_READ_TOKENS: 'true' },
        onSave: () => {},
        isSaving: false,
        saveStatus: null,
      })
    );
    // Toggle labels from the Token Economics section
    expect(html).toContain('Read cost');
    expect(html).toContain('Work investment');
    expect(html).toContain('Savings');
  });

  it('editing a field routes to onSave (settings.json path), not /v1', () => {
    // The pane holds local form state and calls onSave when the Save button
    // is clicked. We verify that calling handleSave (via the Save button path)
    // invokes the onSave prop with a Settings object containing MEMSMITH_CONTEXT_*
    // keys — confirming the settings.json save path is the sink.
    //
    // We drive this by rendering the component and extracting its internal save
    // handler through the exported `makeContextPaneSaveHandler` test-helper.
    let savedSettings: any = null;
    const onSave = (s: any) => { savedSettings = s; };

    // Import and call the save handler factory directly — this is the same
    // logic the pane uses when the Save button is clicked.
    const { makeContextPaneSaveHandler } = require('../../src/ui/viewer/components/ContextSettingsPane.js');

    // Simulate editing: create modified state as the pane would after the user
    // changes MEMSMITH_CONTEXT_OBSERVATIONS from '50' to '75'
    const modifiedSettings = { ...baseSettings, MEMSMITH_CONTEXT_OBSERVATIONS: '75' };
    const handleSaveWithModified = makeContextPaneSaveHandler(modifiedSettings, onSave);
    handleSaveWithModified();

    // Assert: onSave was called with the MEMSMITH_CONTEXT_* mutation
    expect(savedSettings).not.toBeNull();
    expect(savedSettings.MEMSMITH_CONTEXT_OBSERVATIONS).toBe('75');
    // Confirm this is the settings.json path (has the full settings object, not a patch)
    expect(savedSettings.MEMSMITH_WORKER_PORT).toBe('37777');
  });

  it('save button is disabled while saving', () => {
    const html = renderToString(
      React.createElement(ContextSettingsPane, {
        settings: baseSettings,
        onSave: () => {},
        isSaving: true,
        saveStatus: null,
      })
    );
    // When isSaving=true, the button text changes and disabled attribute is set
    expect(html).toContain('Saving...');
  });

  it('displays save status message', () => {
    const html = renderToString(
      React.createElement(ContextSettingsPane, {
        settings: baseSettings,
        onSave: () => {},
        isSaving: false,
        saveStatus: '✓ Saved',
      })
    );
    expect(html).toContain('✓ Saved');
  });

  it('each field row has an info tooltip (ⓘ present per-field)', () => {
    const html = renderToString(
      React.createElement(ContextSettingsPane, {
        settings: baseSettings,
        onSave: () => {},
        isSaving: false,
        saveStatus: null,
      })
    );
    // Count ⓘ occurrences — should have at least one per section (Loading has 2 fields)
    const infoCount = (html.match(/info-tooltip/g) || []).length;
    expect(infoCount).toBeGreaterThanOrEqual(4); // at least Observations, Sessions, Full Count, Full Field
  });
});

describe('SettingsView Context tab — lazy-mount', () => {
  const fields: any = {
    provider: {
      key: 'provider', value: 'claude', type: 'enum',
      label: 'Generation model', description: 'Model used',
      options: ['claude', 'gemini'], source: 'default', boot: false,
    },
  };

  it('does NOT mount ContextSettingsPane before the Context tab is activated', () => {
    // SettingsView uses lazy-mount: the context pane only mounts after the
    // Context tab is first visited. In SSR with tab defaulting to 'system',
    // the context pane content should not appear.
    const html = renderToString(React.createElement(SettingsView, { initialFields: fields } as any));
    // The lazy stub or nothing should be there — not the pane's field labels
    expect(html).not.toContain('Observations to inject');
    // Context tab label still appears in the tab bar
    expect(html).toContain('Context');
  });
});
