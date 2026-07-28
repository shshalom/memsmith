// SPDX-License-Identifier: Apache-2.0
import React from 'react';

interface DoneCardProps {
  restartRequired: boolean;
  onClose: () => void;
}

export default function DoneCard({ restartRequired, onClose }: DoneCardProps) {
  return (
    <div className="wizard-card">
      <div className="wizard-done-icon" aria-hidden="true">✓</div>
      <h2 className="wizard-card-title">Go Team — Setup Complete</h2>
      <p className="wizard-card-body">
        Your memory has been migrated to the shared workspace. Teammates can now
        join using the base key you shared in the previous step.
      </p>

      {restartRequired && (
        <div className="wizard-restart-notice" role="alert">
          <strong>Restart required.</strong> The runtime has been switched to server
          mode, but the settings cache needs a restart to take full effect. Stop and
          restart the MemSmith server to complete the switch.
          <br />
          <code>memsmith stop &amp;&amp; memsmith start</code>
        </div>
      )}

      {!restartRequired && (
        // No restart: selectRuntime() re-reads the project marker on every call
        // and the marker's serverUrl wins over cached settings, both verified
        // against a running server. The project switches over on its next
        // session, when its own hook applies the join the server returned.
        <div className="wizard-restart-notice" role="status">
          <strong>Almost there.</strong> Your memory is now on the shared database.
          This project finishes switching over on its next session — no restart
          needed.
        </div>
      )}

      <p className="wizard-card-body wizard-card-body--muted">
        You can manage team members, view observations, and adjust settings from
        the dashboard at any time.
      </p>

      <div className="wizard-actions wizard-actions--single">
        <button
          type="button"
          className="wizard-btn wizard-btn--terracotta"
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </div>
  );
}
