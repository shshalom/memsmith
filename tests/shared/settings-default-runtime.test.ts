// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('default runtime', () => {
  it('defaults MEMSMITH_RUNTIME to local (embedded), not worker', () => {
    // getAllDefaults() returns a clean copy of DEFAULTS with no env overrides,
    // making it the most direct accessor for verifying the shipped default value.
    // loadFromFile('/nonexistent/...') also works (returns defaults when file is
    // missing), but getAllDefaults() avoids file-system side effects and env
    // variable interference.
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.MEMSMITH_RUNTIME).toBe('local');
  });
});
