// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { requireDirectory, resolveLocalTarget } from '../../scripts/lib/local-target.js';

const PROJECT = '6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const TEAM = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'ms-target-'))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeMarker(fields: Record<string, unknown>) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify({ teamId: TEAM, projectId: PROJECT, ...fields }));
}

describe('resolveLocalTarget', () => {
  it('targets the per-project database when the marker has no database stamp', () => {
    writeMarker({});
    const t = resolveLocalTarget(dir, {});
    expect(t.databaseName).toBe('msp_6f1c2a3b4d5e4f608a9b0c1d2e3f4a5b');
    expect(t.dsn).toBe('postgres://memsmith:memsmith-local@127.0.0.1:55433/msp_6f1c2a3b4d5e4f608a9b0c1d2e3f4a5b');
    expect(t.projectId).toBe(PROJECT);
    expect(t.teamId).toBe(TEAM);
  });

  it('keeps the server\'s boot project on the database its marker names', () => {
    writeMarker({ databaseName: 'postgres' });
    expect(resolveLocalTarget(dir, {}, () => 'postgres').dsn).toBe('postgres://memsmith:memsmith-local@127.0.0.1:55433/postgres');
  });

  it('refuses a stamped database the server does not read for this project', () => {
    writeMarker({ databaseName: 'postgres' });
    expect(() => resolveLocalTarget(dir, {}, () => 'msp_somethingelse')).toThrow(/reads this project from msp_6f1c/);
  });

  it('ignores an explicit server DSN so a team database is never the target', () => {
    writeMarker({});
    const t = resolveLocalTarget(dir, { MEMSMITH_SERVER_DATABASE_URL: 'postgres://u:p@rds.example:5432/acct' });
    expect(t.dsn).toStartWith('postgres://memsmith:memsmith-local@127.0.0.1:55433/');
  });

  it('honors a custom embedded Postgres port', () => {
    writeMarker({});
    expect(resolveLocalTarget(dir, { MEMSMITH_LOCAL_PG_PORT: '55499' }).dsn).toContain('127.0.0.1:55499/');
  });

  it('resolves from a subfolder of the repo to the project root', () => {
    execFileSync('git', ['init', '-q', dir]);
    writeMarker({});
    mkdirSync(join(dir, 'ios', 'App'), { recursive: true });
    expect(resolveLocalTarget(join(dir, 'ios', 'App'), {}).root).toBe(dir);
  });

  it('refuses a directory with no MemSmith project', () => {
    expect(() => resolveLocalTarget(dir, {})).toThrow(/no MemSmith project/);
  });

  it('refuses a team project', () => {
    writeMarker({ runtime: 'server', serverUrl: 'https://team.example' });
    expect(() => resolveLocalTarget(dir, {})).toThrow(/team project/);
  });
});

describe('requireDirectory', () => {
  it('rejects a missing value, as from an unset shell variable', () => {
    expect(() => requireDirectory(undefined)).toThrow(/needs a project directory/);
    expect(() => requireDirectory('')).toThrow(/needs a project directory/);
  });

  it('rejects the next flag taken as the value', () => {
    expect(() => requireDirectory('--execute')).toThrow(/needs a project directory/);
  });

  it('rejects a path that does not exist', () => {
    expect(() => requireDirectory(join(tmpdir(), 'ms-no-such-dir-xyz'))).toThrow(/not a directory/);
  });

  it('accepts an existing directory', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'ms-dir-')));
    try { expect(requireDirectory(d)).toBe(d); } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
