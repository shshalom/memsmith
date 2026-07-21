export type WizardStep = 'welcome' | 'destination' | 'convert' | 'signin' | 'invite' | 'done';
export const WIZARD_ORDER: WizardStep[] = ['welcome', 'destination', 'convert', 'signin', 'invite', 'done'];

export function nextStep(cur: WizardStep): WizardStep {
  const i = WIZARD_ORDER.indexOf(cur);
  return WIZARD_ORDER[Math.min(i + 1, WIZARD_ORDER.length - 1)];
}
export function prevStep(cur: WizardStep): WizardStep {
  const i = WIZARD_ORDER.indexOf(cur);
  return WIZARD_ORDER[Math.max(i - 1, 0)];
}
export function canAdvance(step: WizardStep, state: { probeAllGreen: boolean; signedIn: boolean }): boolean {
  if (step === 'destination') return state.probeAllGreen;
  if (step === 'convert') return state.signedIn;
  if (step === 'signin') return state.signedIn;
  return true;
}
