// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { SETTING_KEYS, getSettingKey, validateSettingValue, coerceEnvValue } from '../../src/server/settings/settingKeys.js';

describe('settingKeys registry', () => {
  it('includes the core knobs with correct types and boot flags', () => {
    const provider = getSettingKey('provider')!;
    expect(provider.type).toBe('enum');
    expect(provider.options).toEqual(['ollama', 'claude', 'gemini', 'openrouter']);
    expect(provider.boot).toBe(false);
    expect(getSettingKey('tiering')!.type).toBe('boolean');
    expect(getSettingKey('ftsWeight')!.type).toBe('number');
    // Quotas remain boot (middleware wired at setupRoutes).
    expect(getSettingKey('monthlyTokenCap')!.boot).toBe(true);
    expect(getSettingKey('rrfK')!.boot).toBe(false); // was module const, now live
  });

  it('every key has env, default, label, description', () => {
    for (const k of SETTING_KEYS) {
      expect(typeof k.env).toBe('string');
      expect(k.default !== undefined).toBe(true);
      expect(k.label.length).toBeGreaterThan(0);
      expect(k.description.length).toBeGreaterThan(0);
    }
  });

  it('validateSettingValue enforces enum membership', () => {
    const p = getSettingKey('provider')!;
    expect(validateSettingValue(p, 'ollama')).toEqual({ ok: true, value: 'ollama' });
    expect(validateSettingValue(p, 'gpt').ok).toBe(false);
  });

  it('validateSettingValue enforces number range', () => {
    const w = getSettingKey('ftsWeight')!; // min 0 max 1
    expect(validateSettingValue(w, 0.5)).toEqual({ ok: true, value: 0.5 });
    expect(validateSettingValue(w, 2).ok).toBe(false);
    expect(validateSettingValue(w, 'x').ok).toBe(false);
  });

  it('validateSettingValue coerces boolean', () => {
    const t = getSettingKey('tiering')!;
    expect(validateSettingValue(t, true)).toEqual({ ok: true, value: true });
    expect(validateSettingValue(t, 'nope').ok).toBe(false);
  });

  it('coerceEnvValue parses per type', () => {
    expect(coerceEnvValue(getSettingKey('tiering')!, '0')).toBe(false);
    expect(coerceEnvValue(getSettingKey('tiering')!, 'on')).toBe(true);
    expect(coerceEnvValue(getSettingKey('ftsWeight')!, '0.3')).toBe(0.3);
    expect(coerceEnvValue(getSettingKey('provider')!, 'Ollama')).toBe('ollama');
  });
});
