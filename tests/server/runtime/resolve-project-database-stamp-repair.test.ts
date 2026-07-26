// SPDX-License-Identifier: Apache-2.0
//
// Guards the stamped-marker repair path. A marker stamped with an msp_ database
// that does not exist, while the legacy `postgres` DB still holds that
// project's rows, must re-adopt `postgres` instead of booting an empty DB.
//
// This is the defect that nearly orphaned the live dogfood store: the stamp
// short-circuited resolveProjectDatabaseName before the adopt-legacy probe
// could run, so a wrong stamp was permanent and silent.
import { describe, it, expect } from 'bun:test';
import {
  resolveProjectDatabaseName,
  projectDatabaseName,
} from '../../../src/server/runtime/resolve-project-database.js';

const PROJECT_ID = '5fc024f0-0994-4f1d-baed-300d9b4d3416';
const STAMPED = projectDatabaseName(PROJECT_ID);

function deps(overrides: Partial<Parameters<typeof resolveProjectDatabaseName>[0]> = {}) {
  const written: string[] = [];
  const base = {
    cwd: '/tmp/does-not-matter',
    readMarker: () => ({ teamId: 't', projectId: PROJECT_ID, databaseName: STAMPED }) as never,
    writeName: (_cwd: string, name: string) => { written.push(name); },
    probeHasProjectRows: async () => true,
    databaseExists: async () => false,
    ...overrides,
  };
  return { deps: base, written };
}

describe('resolveProjectDatabaseName — stamped-marker repair', () => {
  it('re-adopts postgres when the stamped msp_ DB is missing and legacy rows exist', async () => {
    const { deps: d, written } = deps();
    expect(await resolveProjectDatabaseName(d)).toBe('postgres');
    // The repair must be persisted, or every boot pays the probe again.
    expect(written).toEqual(['postgres']);
  });

  it('keeps the stamp when the stamped DB actually exists', async () => {
    const { deps: d, written } = deps({ databaseExists: async () => true });
    expect(await resolveProjectDatabaseName(d)).toBe(STAMPED);
    expect(written).toEqual([]);
  });

  it('keeps the stamp when the DB is missing but there are no legacy rows (genuinely new project)', async () => {
    const { deps: d, written } = deps({ probeHasProjectRows: async () => false });
    expect(await resolveProjectDatabaseName(d)).toBe(STAMPED);
    expect(written).toEqual([]);
  });

  it('never second-guesses a postgres stamp', async () => {
    const { deps: d } = deps({
      readMarker: () => ({ teamId: 't', projectId: PROJECT_ID, databaseName: 'postgres' }) as never,
      databaseExists: async () => { throw new Error('must not probe for a postgres stamp'); },
    });
    expect(await resolveProjectDatabaseName(d)).toBe('postgres');
  });

  it('is backward compatible: omitting databaseExists trusts the stamp', async () => {
    const { deps: d } = deps();
    const { databaseExists: _omitted, ...withoutProbe } = d;
    expect(await resolveProjectDatabaseName(withoutProbe as never)).toBe(STAMPED);
  });

  it('trusts the stamp when the existence probe itself fails (never boot the wrong DB on a probe error)', async () => {
    const { deps: d, written } = deps({
      databaseExists: async () => { throw new Error('admin pool down'); },
    });
    expect(await resolveProjectDatabaseName(d)).toBe(STAMPED);
    expect(written).toEqual([]);
  });
});
