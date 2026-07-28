// SPDX-License-Identifier: Apache-2.0
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  WizardStep, nextStep, prevStep, canAdvance, buildWizardOrder, resolveOrphanedStep,
} from './wizardState.js';
import { fetchOwnerEstablished } from './wizardData.js';
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
  /** null until /v1/identity answers; see buildWizardOrder for the fail-safe. */
  ownerEstablished: boolean | null;
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
  const [wizardState, setWizardState] = useState<WizardState>({
    probeAllGreen: false, signedIn: false, ownerEstablished: null,
  });
  const [restartRequired, setRestartRequired] = useState(false);

  // Ask once per opening whether a real owner already exists. If so, the
  // Sign-In card is dropped from the order entirely rather than merely made
  // passable — the owner of a single-user local install has nobody else to be.
  // Any failure leaves this false, which keeps the sign-in step.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchOwnerEstablished().then(established => {
      if (!cancelled) {
        setWizardState(s => ({ ...s, ownerEstablished: established }));
      }
    });
    return () => { cancelled = true; };
  }, [open]);

  const order = useMemo(
    () => buildWizardOrder({ ownerEstablished: wizardState.ownerEstablished }),
    [wizardState.ownerEstablished],
  );

  // If the order shrinks while the user is standing on the step that was
  // removed, move them FORWARD to where that step would have led — not back to
  // the start, which would discard the progress they had already made.
  useEffect(() => {
    setStep(s => resolveOrphanedStep(s, order));
  }, [order]);

  const handleNext = useCallback(() => {
    if (canAdvance(step, wizardState)) {
      setStep(s => nextStep(s, order));
    }
  }, [step, wizardState, order]);

  const handleBack = useCallback(() => {
    setStep(s => prevStep(s, order));
  }, [order]);

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
            ownerEstablished={wizardState.ownerEstablished}
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
