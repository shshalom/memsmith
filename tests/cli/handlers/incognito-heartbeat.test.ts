// tests/cli/handlers/incognito-heartbeat.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { incognitoHeartbeat } from '../../../src/cli/handlers/session-init.js';
import { setIncognito, resetSession } from '../../../src/cli/incognito.js';

const S = 'incognito-heartbeat-session';

describe('incognitoHeartbeat', () => {
  beforeEach(() => resetSession(S));

  it('returns null when incognito is OFF regardless of turns', () => {
    for (let i = 0; i < 25; i++) {
      expect(incognitoHeartbeat(S, { MEMSMITH_INCOGNITO_REMINDER_TURNS: '10' } as never)).toBeNull();
    }
  });

  it('fires every 10th turn while incognito is ON (default)', () => {
    setIncognito(S, true);
    const env = {} as never; // no override → default 10
    const fired: number[] = [];
    for (let t = 1; t <= 20; t++) {
      const r = incognitoHeartbeat(S, env);
      if (r) { fired.push(t); expect(r).toContain('still incognito'); }
    }
    expect(fired).toEqual([10, 20]);
  });

  it('honors a custom cadence from env', () => {
    setIncognito(S, true);
    const env = { MEMSMITH_INCOGNITO_REMINDER_TURNS: '5' } as never;
    const fired: number[] = [];
    for (let t = 1; t <= 12; t++) {
      if (incognitoHeartbeat(S, env)) fired.push(t);
    }
    expect(fired).toEqual([5, 10]);
  });
});
