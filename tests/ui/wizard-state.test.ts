import { describe, it, expect } from 'bun:test';
import { nextStep, prevStep, canAdvance, WIZARD_ORDER } from '../../src/ui/viewer/views/wizard/wizardState.js';

describe('wizard state', () => {
  it('advances and clamps at done', () => {
    expect(nextStep('welcome')).toBe('destination');
    expect(nextStep('done')).toBe('done');
    expect(prevStep('welcome')).toBe('welcome');
  });
  it('gates destination on probe all-green', () => {
    expect(canAdvance('destination', { probeAllGreen: false, signedIn: false })).toBe(false);
    expect(canAdvance('destination', { probeAllGreen: true, signedIn: false })).toBe(true);
  });
  it('gates signin and convert on signed-in identity', () => {
    expect(canAdvance('signin', { probeAllGreen: true, signedIn: false })).toBe(false);
    expect(canAdvance('signin', { probeAllGreen: true, signedIn: true })).toBe(true);
    expect(canAdvance('convert', { probeAllGreen: true, signedIn: false })).toBe(false);
    expect(canAdvance('convert', { probeAllGreen: true, signedIn: true })).toBe(true);
  });
  it('order is welcome→destination→signin→convert→invite→done', () => {
    expect(WIZARD_ORDER).toEqual(['welcome', 'destination', 'signin', 'convert', 'invite', 'done']);
  });
  it('wizard is completable end-to-end with probeAllGreen+signedIn', () => {
    // Simulate walking through all steps with the fulfilled state
    const fullState = { probeAllGreen: true, signedIn: true };
    expect(canAdvance('destination', fullState)).toBe(true);
    expect(canAdvance('signin', fullState)).toBe(true);
    expect(canAdvance('convert', fullState)).toBe(true);
    // Verify the step transitions follow the new order
    expect(nextStep('welcome')).toBe('destination');
    expect(nextStep('destination')).toBe('signin');
    expect(nextStep('signin')).toBe('convert');
    expect(nextStep('convert')).toBe('invite');
    expect(nextStep('invite')).toBe('done');
  });
});
