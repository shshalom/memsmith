// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState } from 'react';

interface SignInCardProps {
  onNext: () => void;
  onBack: () => void;
  signedIn: boolean;
  onSignedIn: (value: boolean) => void;
  /**
   * True when a real owner identity already exists for this install.
   *
   * The wizard normally drops this card from its order entirely in that case,
   * so this is a belt-and-braces guard: if the card is reached anyway, it must
   * not poll a login endpoint that does not exist. There is no mounted
   * better-auth HTTP surface, and there is deliberately never going to be —
   * OIDC/Cognito owns human login.
   */
  ownerEstablished?: boolean | null;
}

async function checkSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    if (!res.ok) return false;
    const data = await res.json() as { user?: unknown };
    return Boolean(data?.user);
  } catch {
    return false;
  }
}

export default function SignInCard({
  onNext, onBack, signedIn, onSignedIn, ownerEstablished = null,
}: SignInCardProps) {
  const [checking, setChecking] = useState(false);
  const owner = ownerEstablished === true;

  // Poll for session after user has opened the sign-in page in a new tab.
  //
  // Never poll when an owner is already established: identity is settled, and
  // the endpoint would 404 forever (no login surface is mounted).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    if (!signedIn && !owner) {
      timer = setInterval(async () => {
        const ok = await checkSession();
        if (cancelled) return;
        if (ok) {
          onSignedIn(true);
          if (timer) clearInterval(timer);
        }
      }, 2000);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [signedIn, owner, onSignedIn]);

  async function handleCheckNow() {
    setChecking(true);
    const ok = await checkSession();
    if (ok) onSignedIn(true);
    setChecking(false);
  }

  return (
    <div className="wizard-card">
      <h2 className="wizard-card-title">Sign In as Owner</h2>
      <p className="wizard-card-body">
        Sign in to establish yourself as the team owner. This links your identity
        to the shared workspace so your observations are attributed correctly.
      </p>

      {owner && !signedIn ? (
        <div className="wizard-success" role="status">
          You are the owner of this machine’s MemSmith install — no sign-in needed.
          Your identity is already established, and it will be recorded as the
          owner of the converted team.
        </div>
      ) : signedIn ? (
        <div className="wizard-success" role="status">
          You are signed in. Ready to proceed.
        </div>
      ) : (
        <>
          <p className="wizard-card-body wizard-card-body--muted">
            Click the button below to open the sign-in page. After signing in, return
            here — this wizard will detect your session automatically.
          </p>
          <a
            href="/api/auth"
            target="_blank"
            rel="noreferrer"
            className="wizard-btn wizard-btn--teal wizard-btn--link"
          >
            Open Sign-In Page
          </a>
          <button
            type="button"
            className="wizard-btn wizard-btn--ghost"
            onClick={handleCheckNow}
            disabled={checking}
          >
            {checking ? 'Checking…' : 'I’ve signed in — check now'}
          </button>
        </>
      )}

      <div className="wizard-actions">
        <button type="button" className="wizard-btn wizard-btn--ghost" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="wizard-btn wizard-btn--terracotta"
          onClick={onNext}
          disabled={!signedIn && !owner}
        >
          Next
        </button>
      </div>
    </div>
  );
}
