// SPDX-License-Identifier: Apache-2.0
//
// The Go Team wizard's Sign-In card was a permanent dead end on a local
// install: it polls /api/auth/session, which is 404 because better-auth's HTTP
// login surface is not mounted — and is now intentionally never going to be
// (memory 67759157: it is bound to a retired bun:sqlite handle, its account
// tables do not exist in Postgres, and OIDC/Cognito owns that seam). Next is
// `disabled={!signedIn}`, so the user could neither advance nor escape forward.
//
// The fix is a product decision, not a bypass: the owner of this machine,
// converting their own project over loopback, should not be asked to log in —
// there is nobody else to be. Local mode is single-user by design, and
// `local-owner` is a REAL identity (a team_members row with role='owner',
// commit 8cf485ea) that convert's createdByUserId re-stamp resolves against.
//
// So the step is not "skipped" by loosening a gate — it is ABSENT from the
// wizard's order when an owner is already established. That distinction is what
// these tests pin: a loosened gate would still render a card asking you to sign
// in and then let you past it, which is worse than not asking.
import { describe, it, expect } from 'bun:test';
import {
  buildWizardOrder,
  nextStep,
  prevStep,
  canAdvance,
  resolveOrphanedStep,
  WIZARD_ORDER,
} from '../../src/ui/viewer/views/wizard/wizardState.js';

describe('wizard order adapts to an already-established owner', () => {
  it('omits the signin step entirely when an owner is established', () => {
    const order = buildWizardOrder({ ownerEstablished: true });
    expect(order).toEqual(['welcome', 'destination', 'convert', 'invite', 'done']);
    expect(order).not.toContain('signin');
  });

  it('keeps the signin step when no owner is established', () => {
    const order = buildWizardOrder({ ownerEstablished: false });
    expect(order).toEqual(['welcome', 'destination', 'signin', 'convert', 'invite', 'done']);
  });

  it('defaults to including signin when ownership is unknown', () => {
    // Fail-safe: until /v1/identity answers, assume we must ask. Never show a
    // shorter path and then discover the owner does not exist.
    expect(buildWizardOrder({ ownerEstablished: null })).toContain('signin');
    expect(buildWizardOrder({})).toContain('signin');
  });

  it('keeps the legacy exported order unchanged for existing callers', () => {
    expect(WIZARD_ORDER).toEqual(['welcome', 'destination', 'signin', 'convert', 'invite', 'done']);
  });
});

describe('navigation follows the derived order', () => {
  const ownerOrder = buildWizardOrder({ ownerEstablished: true });

  it('steps destination straight to convert, never through signin', () => {
    expect(nextStep('destination', ownerOrder)).toBe('convert');
  });

  it('steps back from convert to destination, never through signin', () => {
    // The reverse direction matters just as much: landing on an absent card
    // via Back is the same dead end, reached from the other side.
    expect(prevStep('convert', ownerOrder)).toBe('destination');
  });

  it('still clamps at both ends', () => {
    expect(nextStep('done', ownerOrder)).toBe('done');
    expect(prevStep('welcome', ownerOrder)).toBe('welcome');
  });

  it('preserves the signin path when the order includes it', () => {
    const guestOrder = buildWizardOrder({ ownerEstablished: false });
    expect(nextStep('destination', guestOrder)).toBe('signin');
    expect(nextStep('signin', guestOrder)).toBe('convert');
    expect(prevStep('convert', guestOrder)).toBe('signin');
  });

  it('defaults to the legacy order when none is passed', () => {
    // Existing callers pass no order; they must behave exactly as before.
    expect(nextStep('destination')).toBe('signin');
    expect(prevStep('convert')).toBe('signin');
  });
});

describe('a step removed underfoot resolves forward, never backward', () => {
  // Ownership resolves asynchronously, so the user can already be standing on
  // the sign-in card when the answer arrives and that card disappears. Sending
  // them to order[0] would silently discard the destination URL and probe they
  // had already completed.
  const ownerOrder = buildWizardOrder({ ownerEstablished: true });

  it('moves signin forward to convert, not back to welcome', () => {
    expect(resolveOrphanedStep('signin', ownerOrder)).toBe('convert');
  });

  it('leaves a step that is still present exactly where it is', () => {
    for (const step of ownerOrder) {
      expect(resolveOrphanedStep(step, ownerOrder)).toBe(step);
    }
  });

  it('falls back to the last step when nothing after it survives', () => {
    // Degenerate order: the orphaned step has no surviving successor.
    expect(resolveOrphanedStep('invite', ['welcome', 'destination'])).toBe('destination');
  });
});

describe('convert is gated on a real owner, not on a session flag', () => {
  it('lets an established owner convert without ever signing in', () => {
    // This is the assertion that would fail under the old code: signedIn is
    // false (no session exists, and none can), yet convert must be reachable
    // because a genuine owner identity is already established.
    expect(canAdvance('convert', {
      probeAllGreen: true,
      signedIn: false,
      ownerEstablished: true,
    })).toBe(true);
  });

  it('still blocks convert when there is neither an owner nor a session', () => {
    expect(canAdvance('convert', {
      probeAllGreen: true,
      signedIn: false,
      ownerEstablished: false,
    })).toBe(false);
  });

  it('still accepts a real session as sufficient for convert', () => {
    // If a login surface ever does exist, a session remains a valid route in.
    expect(canAdvance('convert', {
      probeAllGreen: true,
      signedIn: true,
      ownerEstablished: false,
    })).toBe(true);
  });

  it('does not let an established owner bypass the destination probe', () => {
    // Ownership says who you are. It says nothing about whether the target
    // database is fit — that gate must stay exactly as strict as it was.
    expect(canAdvance('destination', {
      probeAllGreen: false,
      signedIn: true,
      ownerEstablished: true,
    })).toBe(false);
  });

  it('remains backward compatible when ownerEstablished is absent', () => {
    expect(canAdvance('convert', { probeAllGreen: true, signedIn: true })).toBe(true);
    expect(canAdvance('convert', { probeAllGreen: true, signedIn: false })).toBe(false);
  });
});
