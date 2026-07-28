// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { canAdvance, buildWizardOrder } from '../../src/ui/viewer/views/wizard/wizardState.js';
// This task's testable seam is the container's advance logic + card selection.
// Assert the pure gating the container relies on (full DOM render is covered by
// manual acceptance; keep the automated test at the logic boundary).
import { pickCard } from '../../src/ui/viewer/views/wizard/GoTeamWizard.js';

describe('wizard container', () => {
  it('pickCard maps each step to a distinct card component', () => {
    const steps = ['welcome', 'destination', 'convert', 'signin', 'invite', 'done'] as const;
    const comps = steps.map(pickCard);
    expect(new Set(comps).size).toBe(steps.length); // all distinct, none undefined
    for (const c of comps) expect(c).toBeDefined();
  });
  it('reuses canAdvance for Next gating (destination needs green)', () => {
    expect(canAdvance('destination', { probeAllGreen: false, signedIn: false })).toBe(false);
  });
  it('every step in the owner-skip order still maps to a card', () => {
    // Guards the container's invariant: it renders whatever step the derived
    // order hands it, so a shortened order must never contain a step that
    // pickCard cannot resolve.
    for (const step of buildWizardOrder({ ownerEstablished: true })) {
      expect(pickCard(step)).toBeDefined();
    }
  });
});
