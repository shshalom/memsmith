// SPDX-License-Identifier: Apache-2.0
import React from 'react';

interface InviteCardProps {
  baseKey: string | null;
  onNext: () => void;
  onBack: () => void;
}

export default function InviteCard({ baseKey, onNext, onBack }: InviteCardProps) {
  const displayKey = baseKey ?? '(base key not available — check Identity settings)';

  async function handleCopy() {
    if (baseKey) {
      await navigator.clipboard.writeText(baseKey);
    }
  }

  return (
    <div className="wizard-card">
      <h2 className="wizard-card-title">Invite Teammates</h2>
      <p className="wizard-card-body">
        Share your base key with teammates. Anyone with this key can connect their
        MemSmith installation to the same team workspace.
      </p>

      <div className="wizard-key-block">
        <span className="wizard-key-value">{displayKey}</span>
        {baseKey && (
          <button
            type="button"
            className="wizard-btn wizard-btn--ghost wizard-btn--small"
            onClick={handleCopy}
          >
            Copy
          </button>
        )}
      </div>

      <div className="wizard-invite-steps">
        <h3 className="wizard-invite-steps-title">How teammates join</h3>
        <ol className="wizard-invite-list">
          {/* These steps previously said to run
              `memsmith join --key <k> --url <u>` — a command that does not exist
              in the CLI, so every teammate following them hit "unknown command".
              Joining now happens in the dashboard, on the Runtime tile, which is
              also where they can see which mode they are in. */}
          <li>Install MemSmith on their machine.</li>
          <li>Open their MemSmith dashboard.</li>
          <li>
            Press <strong>Join</strong> on the <strong>Runtime</strong> tile, then paste
            the key above and the database URL.
          </li>
          <li>Their observations will be scoped to this team automatically.</li>
        </ol>
      </div>

      {/* Extension point: email-invite (Spec #3 — growable component seam).
          Future implementation attaches here: a form that sends an invite email
          containing the base key + a magic sign-in link, so teammates can join
          without manual key distribution. The contract is:
            POST /v1/team/invite { email: string } → { sent: boolean }
          Insert the <InviteByEmail /> sub-component below this comment. */}

      <p className="wizard-card-body wizard-card-body--muted">
        Manage team members and revoke access from the{' '}
        <a href="#members" className="wizard-link">Members view</a>.
      </p>

      <div className="wizard-actions">
        <button type="button" className="wizard-btn wizard-btn--ghost" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="wizard-btn wizard-btn--terracotta"
          onClick={onNext}
        >
          Next
        </button>
      </div>
    </div>
  );
}
