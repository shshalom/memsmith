import { describe, it, expect, beforeEach } from 'bun:test';
import { isIncognito, setIncognito, bumpTurn, resetSession } from '../../src/cli/incognito.js';

const S = 'test-session-incognito';

describe('incognito session flag', () => {
  beforeEach(() => resetSession(S));

  it('defaults to OFF', () => {
    expect(isIncognito(S)).toBe(false);
  });

  it('turns ON and OFF', () => {
    setIncognito(S, true);
    expect(isIncognito(S)).toBe(true);
    setIncognito(S, false);
    expect(isIncognito(S)).toBe(false);
  });

  it('counts turns independently of the flag', () => {
    expect(bumpTurn(S)).toBe(1);
    expect(bumpTurn(S)).toBe(2);
    expect(bumpTurn(S)).toBe(3);
  });

  it('resetSession clears flag and counter', () => {
    setIncognito(S, true);
    bumpTurn(S);
    resetSession(S);
    expect(isIncognito(S)).toBe(false);
    expect(bumpTurn(S)).toBe(1);
  });
});
