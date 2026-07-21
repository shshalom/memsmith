import { describe, it, expect } from 'bun:test';
import { getSettingKey } from '../../../src/server/settings/settingKeys.js';

describe('incognitoReminderTurns setting', () => {
  it('is registered with env MEMSMITH_INCOGNITO_REMINDER_TURNS and default 10', () => {
    const k = getSettingKey('incognitoReminderTurns');
    expect(k).toBeDefined();
    expect(k?.env).toBe('MEMSMITH_INCOGNITO_REMINDER_TURNS');
    expect(k?.type).toBe('number');
    expect(k?.default).toBe(10);
  });
});
