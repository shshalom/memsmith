import { describe, it, expect, beforeEach } from 'bun:test';
import { handleIncognitoCommand } from '../../../src/cli/handlers/incognito-command.js';
import { isIncognito, resetSession } from '../../../src/cli/incognito.js';

const S = 'incognito-cmd-session';

describe('handleIncognitoCommand', () => {
  beforeEach(() => resetSession(S));

  it('turns ON with "on" and returns the ON confirmation', () => {
    const r = handleIncognitoCommand(S, 'on');
    expect(r.on).toBe(true);
    expect(isIncognito(S)).toBe(true);
    expect(r.message).toContain('Incognito ON');
    expect(r.message).toContain('nothing from this session will be recorded');
  });

  it('turns OFF with "off" and returns the OFF confirmation', () => {
    handleIncognitoCommand(S, 'on');
    const r = handleIncognitoCommand(S, 'off');
    expect(r.on).toBe(false);
    expect(isIncognito(S)).toBe(false);
    expect(r.message).toContain('Incognito OFF');
    expect(r.message).toContain('recording resumed');
  });

  it('bare arg toggles current state', () => {
    expect(handleIncognitoCommand(S, undefined).on).toBe(true);
    expect(handleIncognitoCommand(S, undefined).on).toBe(false);
  });
});
