// SPDX-License-Identifier: Apache-2.0
// Task 3: Extracted from ContextSettingsModal — context-display settings pane.
// Lazy-mount approach: SettingsView tracks `hasBeenActive` for the Context tab
// and only mounts this component once the user first visits that tab, preventing
// useContextPreview (and any future live fetch) from running until needed.
import React, { useState, useCallback, useEffect } from 'react';
import type { Settings } from '../types.js';
import { InfoTooltip } from './InfoTooltip.js';
import { TerminalPreview } from './TerminalPreview.js';
import { useContextPreview } from '../hooks/useContextPreview.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContextSettingsPaneProps {
  settings: Settings;
  onSave: (settings: Settings) => void;
  isSaving: boolean;
  saveStatus: string | null;
}

// ── Test helper ───────────────────────────────────────────────────────────────

/**
 * Returns a save handler closure that calls `onSave` with the given settings
 * object. Exported for unit tests so they can verify the settings.json save
 * path is called (not /v1) without needing to drive DOM events in SSR.
 */
export function makeContextPaneSaveHandler(
  formState: Settings,
  onSave: (s: Settings) => void
): () => void {
  return () => onSave(formState);
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CollapsibleSection({
  title,
  description,
  children,
  defaultOpen = true,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`settings-section-collapsible ${isOpen ? 'open' : ''}`}>
      <button
        className="section-header-btn"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <div className="section-header-content">
          <span className="section-title">{title}</span>
          {description && <span className="section-description">{description}</span>}
        </div>
        <svg
          className={`chevron-icon ${isOpen ? 'rotated' : ''}`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {isOpen && <div className="section-content">{children}</div>}
    </div>
  );
}

function FormField({
  label,
  tooltip,
  children,
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form-field">
      <label className="form-field-label">
        {label}
        <InfoTooltip text={tooltip} />
      </label>
      {children}
    </div>
  );
}

function ToggleSwitch({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-info">
        <label htmlFor={id} className="toggle-label">{label}</label>
        {description && <span className="toggle-description">{description}</span>}
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        className={`toggle-switch ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ContextSettingsPane({
  settings,
  onSave,
  isSaving,
  saveStatus,
}: ContextSettingsPaneProps) {
  const [formState, setFormState] = useState<Settings>(settings);

  useEffect(() => {
    setFormState(settings);
  }, [settings]);

  const {
    preview,
    isLoading,
    error,
    projects,
    sources,
    selectedSource,
    setSelectedSource,
    selectedProject,
    setSelectedProject,
  } = useContextPreview(formState);

  const updateSetting = useCallback(
    (key: keyof Settings, value: string) => {
      setFormState(prev => ({ ...prev, [key]: value }));
    },
    []
  );

  const toggleBoolean = useCallback(
    (key: keyof Settings) => {
      setFormState(prev => ({
        ...prev,
        [key]: prev[key] === 'true' ? 'false' : 'true',
      }));
    },
    []
  );

  const handleSave = useCallback(() => {
    onSave(formState);
  }, [formState, onSave]);

  return (
    <div className="context-settings-pane">
      {/* Preview selectors row */}
      <div className="context-pane-header">
        <label className="preview-selector">
          Source:
          <select
            value={selectedSource || ''}
            onChange={(e) => setSelectedSource(e.target.value)}
            disabled={sources.length === 0}
          >
            {sources.map(source => (
              <option key={source} value={source}>{source}</option>
            ))}
          </select>
        </label>
        <label className="preview-selector">
          Project:
          <select
            value={selectedProject || ''}
            onChange={(e) => setSelectedProject(e.target.value)}
            disabled={projects.length === 0}
          >
            {projects.map(project => (
              <option key={project} value={project}>{project}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Body — 2 columns matching the modal layout */}
      <div className="context-pane-body">
        {/* Left: Live preview */}
        <div className="preview-column">
          <div className="preview-content">
            {error ? (
              <div style={{ color: '#ff6b6b' }}>
                {error}
              </div>
            ) : (
              <TerminalPreview content={preview} isLoading={isLoading} />
            )}
          </div>
        </div>

        {/* Right: Settings fields */}
        <div className="settings-column">
          {/* Section 1: Loading */}
          <CollapsibleSection
            title="Loading"
            description="How many observations to inject"
          >
            <FormField
              label="Observations"
              tooltip="Number of recent observations to include in context (1-200)"
            >
              <input
                type="number"
                min="1"
                max="200"
                value={formState.MEMSMITH_CONTEXT_OBSERVATIONS || '50'}
                onChange={(e) => updateSetting('MEMSMITH_CONTEXT_OBSERVATIONS', e.target.value)}
              />
            </FormField>
            <FormField
              label="Sessions"
              tooltip="Number of recent sessions to pull observations from (1-50)"
            >
              <input
                type="number"
                min="1"
                max="50"
                value={formState.MEMSMITH_CONTEXT_SESSION_COUNT || '10'}
                onChange={(e) => updateSetting('MEMSMITH_CONTEXT_SESSION_COUNT', e.target.value)}
              />
            </FormField>
          </CollapsibleSection>

          {/* The "Display" section is gone entirely. It held five controls, all
              dead since the worker was deleted (a41c8578):

                - Full Observations count/field — chose how much of each
                  observation the worker's banner expanded. The equivalent today
                  is src/server/retrieval/tiering.ts, which already renders L0–L3
                  against a character budget. Wiring these to it would be a new
                  feature, not a repair.
                - Token Economics (read cost / work investment / savings) —
                  rendered lines in that same banner. The dashboard reports cost
                  and savings properly now.

              An empty section header is its own small lie, so the header went
              with its contents rather than staying as a hollow affordance. */}

          {/* Advanced */}
          <CollapsibleSection
            title="Advanced"
            description="Session context inclusions"
            defaultOpen={false}
          >
            <div className="toggle-group">
              {/* "Include last summary" and "Include last message" lived here.
                  Both were read only by the worker's context-generator and have
                  controlled nothing since it was deleted.

                  This one is the inverse case: MEMSMITH_CONTEXT_SHOW_TERMINAL_OUTPUT
                  is genuinely read (context.ts:149) but had no control at all —
                  a working setting with no way to reach it, sitting beside
                  controls that reached nothing. */}
              <ToggleSwitch
                id="ctx-show-terminal-output"
                label="Include terminal output"
                description="Add recent terminal output to session-start context"
                checked={formState.MEMSMITH_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true'}
                onChange={() => toggleBoolean('MEMSMITH_CONTEXT_SHOW_TERMINAL_OUTPUT')}
              />
            </div>
          </CollapsibleSection>
        </div>
      </div>

      {/* Footer with Save button */}
      <div className="context-pane-footer modal-footer">
        <div className="save-status">
          {saveStatus && (
            <span
              className={
                saveStatus.includes('✓')
                  ? 'success'
                  : saveStatus.includes('✗')
                  ? 'error'
                  : ''
              }
            >
              {saveStatus}
            </span>
          )}
        </div>
        <button
          className="save-btn"
          onClick={handleSave}
          disabled={isSaving}
        >
          {isSaving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
