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
  it('gates convert + signin on signed-in identity', () => {
    expect(canAdvance('convert', { probeAllGreen: true, signedIn: false })).toBe(false);
    expect(canAdvance('convert', { probeAllGreen: true, signedIn: true })).toBe(true);
    expect(canAdvance('signin', { probeAllGreen: true, signedIn: true })).toBe(true);
  });
  it('order is welcome→destination→convert→signin→invite→done', () => {
    expect(WIZARD_ORDER).toEqual(['welcome', 'destination', 'convert', 'signin', 'invite', 'done']);
  });
});
