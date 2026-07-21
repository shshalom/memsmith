// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState } from 'react';

interface SignInCardProps {
  onNext: () => void;
  onBack: () => void;
  signedIn: boolean;
  onSignedIn: (value: boolean) => void;
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

export default function SignInCard({ onNext, onBack, signedIn, onSignedIn }: SignInCardProps) {
  const [checking, setChecking] = useState(false);

  // Poll for session after user has opened the sign-in page in a new tab.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    if (!signedIn) {
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
  }, [signedIn, onSignedIn]);

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

      {signedIn ? (
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
          disabled={!signedIn}
        >
          Next
        </button>
      </div>
    </div>
  );
}
