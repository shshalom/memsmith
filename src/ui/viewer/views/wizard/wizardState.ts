export type WizardStep = 'welcome' | 'destination' | 'convert' | 'signin' | 'invite' | 'done';

/**
 * The full step order, including the sign-in step.
 *
 * Kept exported and unchanged so existing callers and tests keep their
 * behaviour; new code should derive an order with `buildWizardOrder` instead of
 * assuming this one.
 */
export const WIZARD_ORDER: WizardStep[] = ['welcome', 'destination', 'signin', 'convert', 'invite', 'done'];

export interface WizardOrderInput {
  /**
   * Whether this install already has an established team owner.
   *
   * `null`/absent means "not yet known" — the wizard has not heard back from
   * /v1/identity. That case keeps the sign-in step, because showing a shorter
   * path and then discovering there is no owner is worse than asking.
   */
  ownerEstablished?: boolean | null;
}

/**
 * Build the step order for this install.
 *
 * When an owner is already established, the sign-in step is ABSENT rather than
 * merely passable. That distinction is deliberate: a loosened gate would still
 * render a card asking the machine's owner to log in — and then wave them past
 * it — which is worse than not asking. Local mode is single-user by design, so
 * the owner converting their own project over loopback has nobody else to be.
 *
 * `local-owner` is a real identity (a team_members row with role='owner'), not
 * a placeholder, which is what convert's createdByUserId re-stamp resolves
 * against. Nothing here fakes a session.
 */
export function buildWizardOrder(input: WizardOrderInput = {}): WizardStep[] {
  if (input.ownerEstablished !== true) return [...WIZARD_ORDER];
  return WIZARD_ORDER.filter(step => step !== 'signin');
}

export function nextStep(cur: WizardStep, order: WizardStep[] = WIZARD_ORDER): WizardStep {
  const i = order.indexOf(cur);
  // A step absent from this order (e.g. 'signin' once an owner exists) must not
  // resolve to index 0 and silently send the user back to the start.
  if (i === -1) return cur;
  return order[Math.min(i + 1, order.length - 1)];
}

export function prevStep(cur: WizardStep, order: WizardStep[] = WIZARD_ORDER): WizardStep {
  const i = order.indexOf(cur);
  if (i === -1) return cur;
  return order[Math.max(i - 1, 0)];
}

/**
 * Where to land when `cur` is no longer part of `order`.
 *
 * This happens when ownership resolves while the user is already standing on
 * the sign-in step. Sending them to `order[0]` would discard the progress they
 * had made, so resolve FORWARD to the first step that survives — falling back
 * to the last step only if nothing after `cur` remains.
 */
export function resolveOrphanedStep(cur: WizardStep, order: WizardStep[]): WizardStep {
  if (order.includes(cur)) return cur;
  const idx = WIZARD_ORDER.indexOf(cur);
  if (idx !== -1) {
    const successor = WIZARD_ORDER.slice(idx + 1).find(candidate => order.includes(candidate));
    if (successor) return successor;
  }
  return order[order.length - 1];
}

export interface WizardAdvanceState {
  probeAllGreen: boolean;
  signedIn: boolean;
  /** True when a real owner identity already exists for this install. */
  ownerEstablished?: boolean | null;
}

export function canAdvance(step: WizardStep, state: WizardAdvanceState): boolean {
  // Ownership says who you are; it says nothing about whether the destination
  // database is fit. This gate stays exactly as strict as before.
  if (step === 'destination') return state.probeAllGreen;
  // An established owner is sufficient identity to convert. A real session
  // remains valid too, so a future login surface needs no change here.
  if (step === 'convert' || step === 'signin') {
    return state.signedIn || state.ownerEstablished === true;
  }
  return true;
}
