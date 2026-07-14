// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState, useCallback } from 'react';
import { fetchSettings, patchSettings, fetchIdentity, IdentityPayload, SettingField } from '../utils/settingsData.js';
import { V1_ENDPOINTS } from '../constants/api.js';
import { InfoTooltip } from '../components/InfoTooltip.js';
import { ContextSettingsPane } from '../components/ContextSettingsPane.js';
import { useSettings } from '../hooks/useSettings.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SettingsFields {
  [key: string]: SettingField;
}

interface SettingsViewProps {
  /** Pass pre-loaded fields to skip the fetch (used in tests). */
  initialFields?: SettingsFields;
}

interface CostData {
  estUsdSaved?: number;
  savedTokens?: number;
  pctSmaller?: number;
  preTokens?: number;
}

type SettingsTab = 'system' | 'context' | 'identity';

// ── Groups ────────────────────────────────────────────────────────────────────

const GROUP_DEFS: Array<{ label: string; keys: string[] }> = [
  { label: 'Generation', keys: ['provider', 'model'] },
  { label: 'Retrieval', keys: ['searchHybrid', 'tiering', 'ftsWeight', 'vecWeight', 'rrfK', 'supersedeMaxDepth'] },
  { label: 'Quality', keys: ['qualityFloor', 'reformatRetries'] },
  { label: 'Limits', keys: ['monthlyTokenCap', 'monthlyRequestCap', 'rateLimitPerMin'] },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function ProvenanceTag({ source }: { source: string }) {
  return (
    <span className="settings-provenance" data-source={source}>
      {source}
    </span>
  );
}

function BootNote() {
  return (
    <span className="settings-boot-note" aria-label="Requires server restart">
      applies after restart
    </span>
  );
}

// ── Control renderers ─────────────────────────────────────────────────────────

function EnumControl({
  field, name, onChange,
}: { field: SettingField; name: string; onChange: (key: string, val: string) => void }) {
  const options = field.options ?? [];
  const current = String(field.value);
  return (
    <div className="settings-enum-group" role="group" aria-label={field.label}>
      {options.map(opt => (
        <button
          key={opt}
          type="button"
          className={`settings-enum-btn${current === opt ? ' settings-enum-btn--active' : ''}`}
          onClick={() => onChange(name, opt)}
          aria-pressed={current === opt}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function BooleanControl({
  field, name, onChange,
}: { field: SettingField; name: string; onChange: (key: string, val: boolean) => void }) {
  const checked = Boolean(field.value);
  return (
    <button
      type="button"
      className={`settings-toggle${checked ? ' settings-toggle--on' : ''}`}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(name, !checked)}
    >
      <span className="settings-toggle-thumb" />
    </button>
  );
}

function NumberControl({
  field, name, onChange,
}: { field: SettingField; name: string; onChange: (key: string, val: number) => void }) {
  return (
    <input
      type="number"
      className="settings-number-input"
      value={field.value as number}
      min={field.min}
      max={field.max}
      onChange={e => onChange(name, Number(e.target.value))}
      aria-label={field.label}
    />
  );
}

// ── Row ────────────────────────────────────────────────────────────────────────

function SettingRow({
  name, field, onChange,
}: {
  name: string;
  field: SettingField;
  onChange: (key: string, val: unknown) => void;
}) {
  let control: React.ReactNode = null;
  if (field.type === 'enum') {
    control = <EnumControl field={field} name={name} onChange={onChange} />;
  } else if (field.type === 'boolean') {
    control = <BooleanControl field={field} name={name} onChange={onChange} />;
  } else if (field.type === 'number') {
    control = <NumberControl field={field} name={name} onChange={onChange} />;
  }

  return (
    <div className="settings-row">
      <div className="settings-row-meta">
        <span className="settings-row-label">
          {field.label}
          <InfoTooltip text={field.description} />
        </span>
        <span className="settings-row-desc">{field.description}</span>
        <div className="settings-row-tags">
          <ProvenanceTag source={field.source} />
          {field.boot && <BootNote />}
        </div>
      </div>
      <div className="settings-row-control">
        {control}
      </div>
    </div>
  );
}

// ── Savings strip ─────────────────────────────────────────────────────────────

function SavingsStrip({ cost }: { cost: CostData | null }) {
  if (!cost) return null;
  const usd = typeof cost.estUsdSaved === 'number' ? cost.estUsdSaved : null;
  const pct = typeof cost.pctSmaller === 'number' && typeof cost.preTokens === 'number' && cost.preTokens > 0
    ? cost.pctSmaller
    : null;
  if (usd === null && pct === null) return null;
  return (
    <div className="savings-strip">
      <span className="savings-strip-label">Compression savings</span>
      {usd !== null && (
        <span className="savings-strip-value savings-strip-value--usd">
          ${usd.toFixed(4)} saved
        </span>
      )}
      {pct !== null && (
        <span className="savings-strip-value savings-strip-value--pct">
          {(pct * 100).toFixed(1)}% smaller
        </span>
      )}
    </div>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

function SettingsTabBar({
  tab, setTab,
}: { tab: SettingsTab; setTab: (t: SettingsTab) => void }) {
  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'system', label: 'System' },
    { id: 'context', label: 'Context' },
    { id: 'identity', label: 'Identity' },
  ];
  return (
    <nav className="settings-tabs" aria-label="Settings sections">
      {tabs.map(t => (
        <button
          key={t.id}
          type="button"
          className={`settings-tab${tab === t.id ? ' settings-tab--active' : ''}`}
          aria-current={tab === t.id ? 'page' : undefined}
          onClick={() => setTab(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

// ── Panes ─────────────────────────────────────────────────────────────────────

function SystemPane({
  fields, cost, confirmKey, confirmMessage, providerError, handleChange, handleConfirm, handleCancelConfirm, hidden,
}: {
  fields: SettingsFields;
  cost: CostData | null;
  confirmKey: string | null;
  confirmMessage: string | null;
  providerError: string | null;
  handleChange: (key: string, val: unknown) => void;
  handleConfirm: () => void;
  handleCancelConfirm: () => void;
  hidden?: boolean;
}) {
  return (
    <div className="settings-pane settings-pane--system" hidden={hidden}>
      <SavingsStrip cost={cost} />

      {confirmKey && confirmMessage && (
        <div className="settings-confirm-banner">
          <span className="settings-confirm-message">{confirmMessage}</span>
          <div className="settings-confirm-actions">
            <button type="button" className="settings-confirm-btn settings-confirm-btn--cancel" onClick={handleCancelConfirm}>
              Cancel
            </button>
            <button type="button" className="settings-confirm-btn settings-confirm-btn--ok" onClick={handleConfirm}>
              Confirm
            </button>
          </div>
        </div>
      )}

      {providerError && (
        <div className="settings-provider-error" role="alert">
          {providerError}
        </div>
      )}

      {GROUP_DEFS.map(group => {
        const rows = group.keys.filter(k => fields[k]);
        if (rows.length === 0) return null;
        return (
          <section key={group.label} className="settings-card">
            <h2 className="settings-card-title">{group.label}</h2>
            <div className="settings-rows">
              {rows.map(key => (
                <SettingRow
                  key={key}
                  name={key}
                  field={fields[key]}
                  onChange={handleChange}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// Lazy-mount approach: ContextSettingsPane is only rendered after the user
// first visits the Context tab. This prevents useContextPreview (and any
// future live fetch) from running until the tab is actually opened.
// The pane stays mounted after first activation (hidden via the `hidden`
// attribute) so state is not lost when the user switches back to System/Identity.
function ContextPane({
  hidden,
  hasBeenActive,
  settings,
  onSave,
  isSaving,
  saveStatus,
}: {
  hidden?: boolean;
  hasBeenActive: boolean;
  settings: import('../types.js').Settings;
  onSave: (s: import('../types.js').Settings) => void;
  isSaving: boolean;
  saveStatus: string;
}) {
  return (
    <div className="settings-pane settings-pane--context" hidden={hidden}>
      {hasBeenActive ? (
        <ContextSettingsPane
          settings={settings}
          onSave={onSave}
          isSaving={isSaving}
          saveStatus={saveStatus}
        />
      ) : null}
    </div>
  );
}

function IdentityPane({
  identity, revealKey, handleRevealToggle, hidden,
}: {
  identity: IdentityPayload | null;
  revealKey: boolean;
  handleRevealToggle: () => void;
  hidden?: boolean;
}) {
  if (!identity) {
    return (
      <div className="settings-pane settings-pane--identity" hidden={hidden}>
        <p className="settings-row-desc">Identity information not available.</p>
      </div>
    );
  }

  return (
    <div className="settings-pane settings-pane--identity" hidden={hidden}>
      <section className="settings-card">
        <h2 className="settings-card-title">Project Identity</h2>
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-meta">
              <span className="settings-row-label">
                Team ID
                <InfoTooltip text="The durable team this project's memory is scoped to; the base key grants access to it." />
              </span>
              <span className="settings-row-desc">Durable team identifier for this installation.</span>
            </div>
            <div className="settings-row-control">
              <span className="settings-row-label">{identity.teamId}</span>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-meta">
              <span className="settings-row-label">
                Project ID
                <InfoTooltip text="The isolation boundary — every observation is scoped to this project_id." />
              </span>
              <span className="settings-row-desc">Durable project identifier for this directory.</span>
            </div>
            <div className="settings-row-control">
              <span className="settings-row-label">{identity.projectId}</span>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-meta">
              <span className="settings-row-label">
                Base Key
                <InfoTooltip text="The credential that reaches this memory. Stored locally (0600), never in the repo." />
              </span>
              <span className="settings-row-desc">
                {identity.keyPresent ? (revealKey && identity.keyPlaintext ? identity.keyPlaintext : identity.keyMasked) : 'No key stored.'}
              </span>
            </div>
            <div className="settings-row-control">
              {identity.keyPresent && (
                <button
                  type="button"
                  className={`settings-toggle${revealKey ? ' settings-toggle--on' : ''}`}
                  role="switch"
                  aria-checked={revealKey}
                  onClick={handleRevealToggle}
                >
                  <span className="settings-toggle-thumb" />
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SettingsView({ initialFields }: SettingsViewProps) {
  const [fields, setFields] = useState<SettingsFields>(initialFields ?? {});
  const [cost, setCost] = useState<CostData | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [confirmPatch, setConfirmPatch] = useState<Record<string, unknown> | null>(null);
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialFields);
  const [identity, setIdentity] = useState<IdentityPayload | null>(null);
  const [revealKey, setRevealKey] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('system');
  // Lazy-mount: track whether the Context tab has ever been visited.
  // ContextSettingsPane (and useContextPreview) only mounts on first activation.
  const [contextTabHasBeenActive, setContextTabHasBeenActive] = useState(false);

  // Settings for the context pane — the settings.json save path (not /v1)
  const { settings: contextSettings, saveSettings: saveContextSettings, isSaving: isContextSaving, saveStatus: contextSaveStatus } = useSettings();

  // Fetch on mount unless initialFields provided
  useEffect(() => {
    if (initialFields) return;
    let cancelled = false;
    setLoading(true);

    Promise.all([
      fetchSettings(),
      fetch(V1_ENDPOINTS.DASH_COST, { headers: { Accept: 'application/json' } })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null),
      fetchIdentity(),
    ]).then(([s, c, id]) => {
      if (cancelled) return;
      setFields(s);
      setCost(c as CostData | null);
      setIdentity(id);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyPatch = useCallback(async (patch: Record<string, unknown>, confirm?: boolean) => {
    setProviderError(null);
    const result = await patchSettings(patch, confirm);
    if (result.confirmationRequired) {
      setConfirmKey(Object.keys(patch)[0] ?? null);
      setConfirmPatch(patch);
      setConfirmMessage(result.message ?? 'This change requires confirmation.');
      return;
    }
    if (result.error === 'MissingProviderKey') {
      setProviderError(result.message ?? 'Provider key is missing.');
      return;
    }
    if (result.error) {
      // other error — surface inline if desired; for now swallow silently
      return;
    }
    if (result.settings) {
      setFields(result.settings);
    } else {
      // optimistic update: merge single patch value
      setFields(prev => {
        const key = Object.keys(patch)[0];
        if (!key || !prev[key]) return prev;
        return { ...prev, [key]: { ...prev[key], value: patch[key] } };
      });
    }
  }, []);

  const handleChange = useCallback((key: string, val: unknown) => {
    applyPatch({ [key]: val });
  }, [applyPatch]);

  const handleConfirm = useCallback(() => {
    if (!confirmPatch) return;
    setConfirmKey(null);
    setConfirmMessage(null);
    applyPatch(confirmPatch, true);
    setConfirmPatch(null);
  }, [confirmPatch, applyPatch]);

  const handleCancelConfirm = useCallback(() => {
    setConfirmKey(null);
    setConfirmPatch(null);
    setConfirmMessage(null);
  }, []);

  const handleRevealToggle = useCallback(async () => {
    if (revealKey) {
      // Hide: refetch without reveal to drop plaintext from state
      setRevealKey(false);
      const fresh = await fetchIdentity(false);
      setIdentity(fresh);
    } else {
      const revealed = await fetchIdentity(true);
      if (revealed) {
        setRevealKey(true);
        setIdentity(revealed);
      }
    }
  }, [revealKey]);

  if (loading) {
    return <div className="settings-loading">Loading settings…</div>;
  }

  return (
    <div className="settings-view">
      <div className="settings-header">
        <h1 className="settings-title">Settings</h1>
        <p className="settings-subtitle">Live knobs for this MemSmith server. Changes take effect immediately unless noted.</p>
      </div>

      <SettingsTabBar
        tab={tab}
        setTab={(t: SettingsTab) => {
          setTab(t);
          if (t === 'context') setContextTabHasBeenActive(true);
        }}
      />

      <SystemPane
        fields={fields}
        cost={cost}
        confirmKey={confirmKey}
        confirmMessage={confirmMessage}
        providerError={providerError}
        handleChange={handleChange}
        handleConfirm={handleConfirm}
        handleCancelConfirm={handleCancelConfirm}
        hidden={tab !== 'system'}
      />
      <ContextPane
        hidden={tab !== 'context'}
        hasBeenActive={contextTabHasBeenActive}
        settings={contextSettings}
        onSave={saveContextSettings}
        isSaving={isContextSaving}
        saveStatus={contextSaveStatus}
      />
      <IdentityPane
        identity={identity}
        revealKey={revealKey}
        handleRevealToggle={handleRevealToggle}
        hidden={tab !== 'identity'}
      />
    </div>
  );
}
