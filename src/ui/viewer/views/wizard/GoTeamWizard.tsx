// SPDX-License-Identifier: Apache-2.0
import React, { useState, useCallback } from 'react';
import { WizardStep, nextStep, prevStep, canAdvance } from './wizardState.js';
import WelcomeCard    from './cards/WelcomeCard.js';
import DestinationCard from './cards/DestinationCard.js';
import ConvertCard    from './cards/ConvertCard.js';
import SignInCard     from './cards/SignInCard.js';
import InviteCard     from './cards/InviteCard.js';
import DoneCard       from './cards/DoneCard.js';

// ── Pure step→card mapping (exported for unit tests — no DOM needed) ──────────

export function pickCard(step: WizardStep): React.ComponentType<any> {
  switch (step) {
    case 'welcome':     return WelcomeCard;
    case 'destination': return DestinationCard;
    case 'convert':     return ConvertCard;
    case 'signin':      return SignInCard;
    case 'invite':      return InviteCard;
    case 'done':        return DoneCard;
  }
}

// ── Shared wizard state ────────────────────────────────────────────────────────

interface WizardState {
  probeAllGreen: boolean;
  signedIn: boolean;
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface GoTeamWizardProps {
  open: boolean;
  onClose: () => void;
  /** Optional base key forwarded from the Identity pane for the InviteCard. */
  baseKey?: string | null;
}

// ── Container ─────────────────────────────────────────────────────────────────

export default function GoTeamWizard({ open, onClose, baseKey = null }: GoTeamWizardProps) {
  const [step, setStep]               = useState<WizardStep>('welcome');
  const [databaseUrl, setDatabaseUrl] = useState('');
  const [wizardState, setWizardState] = useState<WizardState>({ probeAllGreen: false, signedIn: false });
  const [restartRequired, setRestartRequired] = useState(false);

  const handleNext = useCallback(() => {
    if (canAdvance(step, wizardState)) {
      setStep(s => nextStep(s));
    }
  }, [step, wizardState]);

  const handleBack = useCallback(() => {
    setStep(s => prevStep(s));
  }, []);

  const handleProbeGreen = useCallback((green: boolean) => {
    setWizardState(s => ({ ...s, probeAllGreen: green }));
  }, []);

  const handleSignedIn = useCallback((value: boolean) => {
    setWizardState(s => ({ ...s, signedIn: value }));
  }, []);

  const handleRestartRequired = useCallback((required: boolean) => {
    setRestartRequired(required);
  }, []);

  const handleUrlChange = useCallback((url: string) => {
    setDatabaseUrl(url);
  }, []);

  // Dismiss on backdrop click
  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  if (!open) return null;

  // Render the current card with its specific props
  function renderCard() {
    switch (step) {
      case 'welcome':
        return <WelcomeCard onNext={handleNext} />;
      case 'destination':
        return (
          <DestinationCard
            onNext={handleNext}
            onBack={handleBack}
            onProbeGreen={handleProbeGreen}
            onUrlChange={handleUrlChange}
            databaseUrl={databaseUrl}
            probeAllGreen={wizardState.probeAllGreen}
          />
        );
      case 'convert':
        return (
          <ConvertCard
            databaseUrl={databaseUrl}
            onNext={handleNext}
            onBack={handleBack}
            onRestartRequired={handleRestartRequired}
          />
        );
      case 'signin':
        return (
          <SignInCard
            onNext={handleNext}
            onBack={handleBack}
            signedIn={wizardState.signedIn}
            onSignedIn={handleSignedIn}
          />
        );
      case 'invite':
        return (
          <InviteCard
            baseKey={baseKey}
            onNext={handleNext}
            onBack={handleBack}
          />
        );
      case 'done':
        return <DoneCard restartRequired={restartRequired} onClose={onClose} />;
    }
  }

  return (
    <div
      className="wizard-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Go Team setup wizard"
      onClick={handleBackdropClick}
    >
      <div className="wizard-container">
        {renderCard()}
      </div>
    </div>
  );
}
