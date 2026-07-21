// SPDX-License-Identifier: Apache-2.0
import React from 'react';

interface WelcomeCardProps {
  onNext: () => void;
}

export default function WelcomeCard({ onNext }: WelcomeCardProps) {
  return (
    <div className="wizard-card">
      <div className="wizard-logo-placeholder" aria-hidden="true">
        <span className="wizard-logo-mark">M</span>
      </div>
      <h2 className="wizard-card-title">Welcome to Go Team</h2>
      <p className="wizard-card-body">
        Switch MemSmith from solo local mode to a shared team workspace. Your existing
        memory moves with you — nothing is lost. This wizard walks you through each step.
      </p>
      <div className="wizard-actions wizard-actions--single">
        <button
          type="button"
          className="wizard-btn wizard-btn--teal"
          onClick={onNext}
        >
          Begin
        </button>
      </div>
    </div>
  );
}
