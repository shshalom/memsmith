// SPDX-License-Identifier: Apache-2.0
import React, { useState } from 'react';
import { testConnection, applyFix, ProbeResult } from '../wizardData.js';

interface DestinationCardProps {
  onNext: () => void;
  onBack: () => void;
  onProbeGreen: (green: boolean) => void;
  onUrlChange: (url: string) => void;
  databaseUrl: string;
  probeAllGreen: boolean;
}

const CHECK_LABELS: Record<string, string> = {
  reachable: 'Reachable',
  authenticates: 'Authenticates',
  writable: 'Writable',
  pgvector: 'pgvector extension',
  versionOk: 'Postgres version ≥ 14',
  schemaReady: 'Schema ready',
};

function CheckRow({ name, ok, fixable, onFix, fixing }: {
  name: string; ok: boolean; fixable: boolean;
  onFix?: () => void; fixing?: boolean;
}) {
  return (
    <div className={`wizard-check-row${ok ? ' wizard-check-row--ok' : ' wizard-check-row--fail'}`}>
      <span className="wizard-check-icon" aria-hidden="true">{ok ? '✓' : '✗'}</span>
      <span className="wizard-check-label">{CHECK_LABELS[name] ?? name}</span>
      {/* `fixable` means the probe confirmed MemSmith can actually apply the
          fix — it is available on the server AND this connection has permission.
          When it cannot, we fall back to instructions for a DBA rather than
          offering a button that would fail. */}
      {!ok && fixable && onFix && (
        <button
          type="button"
          className="wizard-check-fix"
          onClick={onFix}
          disabled={fixing}
        >
          {fixing ? 'Fixing…' : 'Fix'}
        </button>
      )}
      {!ok && !fixable && (
        <span className="wizard-check-hint">
          {name === 'pgvector'
            ? 'Ask your DBA to run: CREATE EXTENSION vector;'
            : 'Check connection credentials and permissions.'}
        </span>
      )}
    </div>
  );
}

export default function DestinationCard({ onNext, onBack, onProbeGreen, onUrlChange, databaseUrl, probeAllGreen }: DestinationCardProps) {
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleTest() {
    setTesting(true);
    setError(null);
    setProbe(null);
    const result = await testConnection(databaseUrl);
    setProbe(result);
    onProbeGreen(result.allGreen);
    if (result.error) setError(result.error);
    setTesting(false);
  }

  // Apply a remediation the probe said we can actually perform, then re-probe so
  // the checklist (and the Next button, which unlocks only on all-green)
  // reflects reality instead of a stale result.
  async function handleFix(fix: string) {
    setFixing(fix);
    setError(null);
    const result = await applyFix(databaseUrl, fix);
    if (!result.ok) {
      setError(result.error ?? 'Could not apply the fix.');
      setFixing(null);
      return;
    }
    const reprobed = await testConnection(databaseUrl);
    setProbe(reprobed);
    onProbeGreen(reprobed.allGreen);
    if (reprobed.error) setError(reprobed.error);
    setFixing(null);
  }

  const fixableSet = new Set(probe?.fixable ?? []);

  return (
    <div className="wizard-card">
      <h2 className="wizard-card-title">Destination Database</h2>
      <p className="wizard-card-body">
        Enter your remote Postgres connection URL. MemSmith will test connectivity
        and verify the database meets all requirements before proceeding.
      </p>

      <div className="wizard-field">
        <label className="wizard-field-label" htmlFor="wizard-pg-url">
          Postgres URL
        </label>
        <input
          id="wizard-pg-url"
          type="text"
          className="wizard-input"
          placeholder="postgres://user:pass@host:5432/db"
          value={databaseUrl}
          onChange={e => onUrlChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {error && (
        <div className="wizard-error" role="alert">{error}</div>
      )}

      {probe && (
        <div className="wizard-checklist">
          <CheckRow name="reachable"    ok={probe.connectivity.reachable}    fixable={false} />
          <CheckRow name="authenticates" ok={probe.connectivity.authenticates} fixable={false} />
          <CheckRow name="writable"     ok={probe.fitness.writable}          fixable={false} />
          <CheckRow name="pgvector"     ok={probe.fitness.pgvector}          fixable={fixableSet.has('pgvector')}
                    onFix={() => handleFix('pgvector')} fixing={fixing === 'pgvector'} />
          <CheckRow name="versionOk"    ok={probe.fitness.versionOk}         fixable={false} />
          <CheckRow name="schemaReady"  ok={probe.fitness.schemaReady}       fixable={fixableSet.has('schemaReady')} />
        </div>
      )}

      <div className="wizard-actions">
        <button type="button" className="wizard-btn wizard-btn--ghost" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="wizard-btn wizard-btn--teal"
          onClick={handleTest}
          disabled={testing || !databaseUrl.trim()}
        >
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
        <button
          type="button"
          className="wizard-btn wizard-btn--terracotta"
          onClick={onNext}
          disabled={!probeAllGreen}
        >
          Next
        </button>
      </div>
    </div>
  );
}
