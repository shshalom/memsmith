// SPDX-License-Identifier: Apache-2.0
//
// Join an existing team workspace, from the dashboard.
//
// The only documented path was `memsmith join --key <k> --url <u>` — a command
// that does not exist in the CLI, so every teammate following the wizard's final
// step hit "unknown command". It was also the wrong shape even if implemented:
// it asks a person to paste a full-access credential and a raw Postgres URL into
// a terminal.
//
// Two fields, one button, inline errors. The server verifies the key against the
// remote's api_keys and rejects unknown / revoked / expired / teamless keys, so
// this form only has to render the reason it gives back.
import React, { useState } from 'react';

interface JoinResponse {
  status?: 'joined' | 'failed';
  error?: string;
  /**
   * Set when the team accepted the join but this machine's marker was NOT
   * flipped. status is still 'joined' — the remote side is committed — but
   * treating it as unqualified success is what made the underlying bug
   * invisible: the project would sit in team mode with no resolvable credential
   * and silently drop observations while the user had been told it worked.
   */
  localApplied?: false;
  localReason?: string;
}

export function JoinTeamModal({ open, onClose, onJoined }: {
  open: boolean;
  onClose: () => void;
  onJoined: () => void;
}) {
  const [databaseUrl, setDatabaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/v1/join', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ databaseUrl, apiKey }),
      });
      const body = (await res.json().catch(() => ({}))) as JoinResponse;
      if (res.ok && body.status === 'joined') {
        // Joined the team, but this machine's marker was not updated. Do NOT
        // call onJoined() — that closes the modal and reports success, and the
        // project is not actually usable in team mode yet. Show what happened
        // and what to do about it, keeping the form open.
        if (body.localApplied === false) {
          setError(
            `Joined the team, but this project could not be switched over on this machine: `
            + `${body.localReason ?? 'the local apply did not complete'}`,
          );
          return;
        }
        onJoined();
        return;
      }
      // The server returns a sentence a person can act on ("that key has been
      // revoked", "cannot reach that database: ..."). Show it verbatim rather
      // than replacing it with a generic failure.
      setError(body.error ?? `join failed (${res.status})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const ready = databaseUrl.trim().length > 0 && apiKey.trim().length > 0 && !busy;

  return (
    <div className="wizard-overlay" role="dialog" aria-modal="true" aria-label="Join a team workspace">
      <div className="wizard-card">
        <h2 className="wizard-card-title">Join a Team Workspace</h2>
        <p className="wizard-card-body">
          Paste the database URL and team key from your invite. This project&rsquo;s
          memory will be served from the shared workspace; your local data stays
          intact as a backup.
        </p>

        <label className="wizard-field-label" htmlFor="join-url">Database URL</label>
        <input
          id="join-url"
          className="wizard-input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="postgres://user:password@host:5432/memsmith"
          value={databaseUrl}
          onChange={e => setDatabaseUrl(e.target.value)}
        />

        <label className="wizard-field-label" htmlFor="join-key">Team Key</label>
        <input
          id="join-key"
          className="wizard-input"
          // type=password: this is a full-access credential and the dashboard is
          // frequently on a shared screen.
          type="password"
          spellCheck={false}
          autoComplete="off"
          placeholder="cmem_…"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
        />

        {error && <div className="wizard-error" role="alert">{error}</div>}

        <div className="wizard-actions">
          <button type="button" className="wizard-btn wizard-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="wizard-btn wizard-btn--terracotta" onClick={submit} disabled={!ready}>
            {busy ? 'Joining…' : 'Join'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default JoinTeamModal;
