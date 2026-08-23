// SPDX-License-Identifier: Apache-2.0
import React, { useState, useEffect } from 'react';
import { testConnection, applyFix, ProbeResult, type Destination } from '../wizardData.js';

interface DestinationCardProps {
  onNext: () => void;
  onBack: () => void;
  onProbeGreen: (green: boolean) => void;
  onUrlChange: (url: string) => void;
  /**
   * Report the destination upward. The CONVERT step is what posts it, so it cannot live
   * only in this card — otherwise convert would target a different destination than the
   * one the probe went green against.
   */
  onDestinationChange: (dest: Destination) => void;
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

export default function DestinationCard({ onNext, onBack, onProbeGreen, onUrlChange, onDestinationChange, databaseUrl, probeAllGreen }: DestinationCardProps) {
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // HTTPS is the default because it is the only shape that works for a managed
  // database: a private RDS is unreachable from this machine, so a database URL
  // would simply time out. The direct shape stays available behind the toggle for a
  // self-hosted Postgres the owner can actually reach.
  const [serverUrl, setServerUrl] = useState('');
  const [teamKey, setTeamKey] = useState('');
  const [useDirect, setUseDirect] = useState(false);

  /** The destination as the server expects it — see wizardData's Destination union. */
  function destination(): Destination {
    return useDirect ? { databaseUrl } : { serverUrl, teamKey };
  }

  /**
   * Enough input to probe? Depends on WHICH destination is selected: the direct path
   * needs a database URL, the HTTPS path needs both a server URL and a team key (the key
   * is the authorization, so a URL alone cannot be tested).
   */
  function destinationReady(): boolean {
    return useDirect
      ? databaseUrl.trim().length > 0
      : serverUrl.trim().length > 0 && teamKey.trim().length > 0;
  }

  // Report on every edit rather than only on a successful probe: the convert step reads
  // this, and a stale value there is the scope-leak class of bug.
  useEffect(() => {
    onDestinationChange(useDirect ? { databaseUrl } : { serverUrl, teamKey });
  }, [useDirect, databaseUrl, serverUrl, teamKey, onDestinationChange]);

  async function handleTest() {
    setTesting(true);
    setError(null);
    setProbe(null);
    const result = await testConnection(destination());
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
    const reprobed = await testConnection(destination());
    setProbe(reprobed);
    onProbeGreen(reprobed.allGreen);
    if (reprobed.error) setError(reprobed.error);
    setFixing(null);
  }

  const fixableSet = new Set(probe?.fixable ?? []);

  return (
    <div className="wizard-card">
      <h2 className="wizard-card-title">Destination</h2>
      <p className="wizard-card-body">
        {useDirect
          ? 'Enter the Postgres connection URL. Only works if this machine can reach the database directly.'
          : 'Enter your team server’s address and team key. MemSmith checks that the server is reachable and the key is valid before proceeding.'}
      </p>

      {useDirect ? (
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
      ) : (
        <>
          <div className="wizard-field">
            <label className="wizard-field-label" htmlFor="wizard-server-url">
              Team server URL
            </label>
            <input
              id="wizard-server-url"
              type="text"
              className="wizard-input"
              placeholder="https://your-team-server.example.com"
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="wizard-field">
            <label className="wizard-field-label" htmlFor="wizard-team-key">
              Team key
            </label>
            <input
              id="wizard-team-key"
              type="password"
              className="wizard-input"
              placeholder="cmem_…"
              value={teamKey}
              onChange={e => setTeamKey(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </>
      )}

      <button
        type="button"
        className="wizard-text-button"
        onClick={() => {
          // Switching destination invalidates any probe result, and Next unlocks only
          // on all-green — leaving a stale green would let a user proceed on evidence
          // gathered about a different destination.
          setUseDirect(!useDirect);
          setProbe(null);
          setError(null);
          onProbeGreen(false);
        }}
      >
        {useDirect
          ? 'Use a team server URL instead'
          : 'I have a database URL instead'}
      </button>

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
          // Gate on whichever destination is actually selected. This checked
          // databaseUrl unconditionally, so filling in the HTTPS fields left the
          // button dead — the one path a managed database can use.
          disabled={testing || !destinationReady()}
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
