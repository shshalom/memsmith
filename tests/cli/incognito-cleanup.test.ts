// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'bun:test';
import { existsSync, readdirSync, rmSync, utimesSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../../src/shared/paths.js';
import {
  isIncognito, setIncognito, bumpTurn, pruneStaleIncognito, captureSuppressed, INCOGNITO_STATE_MAX_AGE_MS,
} from '../../src/cli/incognito.js';

const DIR = join(DATA_DIR, 'incognito');
const stateFile = (id: string) => join(DIR, `${encodeURIComponent(id)}.json`);
const age = (id: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  utimesSync(stateFile(id), t, t);
};

describe('incognito state cleanup', () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  });

  it('removes the state file when incognito turns off', () => {
    setIncognito('s-off', true);
    expect(existsSync(stateFile('s-off'))).toBe(true);
    setIncognito('s-off', false);
    expect(existsSync(stateFile('s-off'))).toBe(false);
  });

  it('prunes abandoned state files and keeps an active session', () => {
    setIncognito('abandoned', true);
    setIncognito('active', true);
    age('abandoned', INCOGNITO_STATE_MAX_AGE_MS + 60_000);
    age('active', INCOGNITO_STATE_MAX_AGE_MS + 60_000);
    bumpTurn('active');

    expect(pruneStaleIncognito()).toBe(1);
    expect(isIncognito('abandoned')).toBe(false);
    expect(isIncognito('active')).toBe(true);
  });

  it('prunes on the next toggle without disturbing the session being toggled', () => {
    setIncognito('old', true);
    age('old', INCOGNITO_STATE_MAX_AGE_MS + 60_000);
    setIncognito('new', true);
    expect(readdirSync(DIR)).toEqual([`${encodeURIComponent('new')}.json`]);
    expect(isIncognito('new')).toBe(true);
  });

  it('ignores unrelated files and a missing directory', () => {
    writeFileSync(join(DIR, 'notes.txt'), 'x');
    expect(pruneStaleIncognito(0, Date.now() + 1000)).toBe(0);
    rmSync(DIR, { recursive: true, force: true });
    expect(pruneStaleIncognito()).toBe(0);
  });

  it('captureSuppressed is false without a session id', () => {
    expect(captureSuppressed(undefined)).toBe(false);
    expect(captureSuppressed('')).toBe(false);
  });
});
