// SPDX-License-Identifier: Apache-2.0
import React, { useState } from 'react';
import { migrate, ConvertResult } from '../wizardData.js';

// 'failed' = the copy ran but verification found missing rows.
// 'errored' = the request itself did not complete (crash, 403, transport).
// Keeping them apart is the whole point: the card used to report a crash as a
// verification failure, which is a different problem with a different fix.
type Phase = 'idle' | 'copying' | 'verifying' | 'flipping' | 'done' | 'failed' | 'errored';

interface ConvertCardProps {
  databaseUrl: string;
  onNext: () => void;
  onBack: () => void;
  onRestartRequired: (required: boolean) => void;
}

const PHASE_LABELS: Record<Phase, string> = {
  idle:      '',
  copying:   'Copying observations to remote…',
  verifying: 'Verifying row counts…',
  flipping:  'Switching runtime to server mode…',
  done:      'Conversion complete.',
  failed:    'Conversion did not pass verification. Local data is unchanged.',
  errored:   'Conversion could not run. Local data is unchanged.',
};

export default function ConvertCard({ databaseUrl, onNext, onBack, onRestartRequired }: ConvertCardProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  async function handleMigrate() {
    setPhase('copying');
    // Animate phase labels as the request is in-flight; the server does all phases.
    const phaseTimer = setTimeout(() => setPhase('verifying'), 1500);
    const flipTimer  = setTimeout(() => setPhase('flipping'),  3000);

    const res = await migrate(databaseUrl);

    clearTimeout(phaseTimer);
    clearTimeout(flipTimer);

    setResult(res);
    onRestartRequired(res.restartRequired);

    if (res.status === 'converted') {
      setPhase('done');
    } else if (res.status === 'failed') {
      setPhase('errored');
    } else {
      setPhase('failed');
    }
  }

  const copiedTotal = result?.copiedByTable
    ? Object.values(result.copiedByTable).reduce((a, b) => a + b, 0)
    : null;

  return (
    <div className="wizard-card">
      <h2 className="wizard-card-title">Convert Memory</h2>
      <p className="wizard-card-body">
        MemSmith will copy all your local observations to the remote database, verify
        row counts match, then flip the runtime to server mode. Your local data is
        never deleted — it stays as a backup at <code>~/.memsmith/pgdata</code>.
      </p>

      {phase === 'idle' && (
        <div className="wizard-warning">
          <strong>Before you proceed:</strong> this operation copies all memory to
          the remote and changes the active runtime. The server must restart to
          complete the switch. Make sure you have reviewed the destination first.
        </div>
      )}

      {phase !== 'idle' && (
        <div className="wizard-progress">
          <div className={`wizard-progress-step${['copying','verifying','flipping','done'].includes(phase) ? ' wizard-progress-step--active' : ''}`}>
            Copy
          </div>
          <div className={`wizard-progress-step${['verifying','flipping','done'].includes(phase) ? ' wizard-progress-step--active' : ''}`}>
            Verify
          </div>
          <div className={`wizard-progress-step${['flipping','done'].includes(phase) ? ' wizard-progress-step--active' : ''}`}>
            Flip
          </div>
        </div>
      )}

      {phase !== 'idle' && (
        <p className="wizard-phase-label" role="status">{PHASE_LABELS[phase]}</p>
      )}

      {result?.copiedByTable && copiedTotal !== null && (
        <p className="wizard-card-body wizard-card-body--muted">
          {copiedTotal.toLocaleString()} rows copied across {Object.keys(result.copiedByTable).length} table(s).
        </p>
      )}

      {result?.status === 'failed' && result.error && (
        <div className="wizard-error" role="alert">
          The conversion could not run, so nothing was copied and the runtime was
          NOT switched. Your local data is unchanged.
          <br />
          <code>{result.error}</code>
        </div>
      )}

      {result?.mismatches && result.mismatches.length > 0 && (
        <div className="wizard-error" role="alert">
          Verification mismatches:{' '}
          {result.mismatches.map(m => `${m.table} (local ${m.local} vs remote ${m.remote})`).join(', ')}.
          The runtime was NOT switched. You can retry safely.
        </div>
      )}

      {phase === 'idle' && (
        <label className="wizard-confirm-check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={e => setConfirmed(e.target.checked)}
          />
          {' '}I understand this will copy all memory and require a server restart.
        </label>
      )}

      <div className="wizard-actions">
        <button
          type="button"
          className="wizard-btn wizard-btn--ghost"
          onClick={onBack}
          disabled={phase !== 'idle' && phase !== 'done' && phase !== 'failed' && phase !== 'errored'}
        >
          Back
        </button>
        {(phase === 'idle' || phase === 'failed' || phase === 'errored') && (
          <button
            type="button"
            className="wizard-btn wizard-btn--terracotta"
            onClick={handleMigrate}
            disabled={!confirmed && phase === 'idle'}
          >
            {phase === 'failed' || phase === 'errored' ? 'Retry' : 'Convert All'}
          </button>
        )}
        {phase === 'done' && (
          <button
            type="button"
            className="wizard-btn wizard-btn--terracotta"
            onClick={onNext}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}
