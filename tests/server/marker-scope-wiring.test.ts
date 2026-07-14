// SPDX-License-Identifier: Apache-2.0
//
// Task 5 wiring test: proves that readLocalScopeFromMarkerOrEnv (the function
// wired into create-server-service.ts) returns the marker-derived teamId/projectId
// when env vars are unset, and that env still wins when set.
//
// We also assert structurally that create-server-service.ts calls the function,
// so the two halves of the proof are: (a) the function returns the right value,
// (b) create-server-service.ts is wired to call it.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readLocalScopeFromMarkerOrEnv } from '../../src/server/runtime/resolve-local-scope.js';

function withEnvUnset(keys: string[], fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  try { fn(); } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('marker-scope-wiring: readLocalScopeFromMarkerOrEnv', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'marker-scope-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.MEMSMITH_LOCAL_DEV_TEAM_ID;
    delete process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID;
  });

  it('returns marker teamId/projectId when env vars are unset', () => {
    const markerTeamId = 'marker-team-abc';
    const markerProjectId = 'marker-proj-xyz';
    mkdirSync(join(tempDir, '.memsmith'), { recursive: true });
    writeFileSync(
      join(tempDir, '.memsmith', 'project.json'),
      JSON.stringify({ teamId: markerTeamId, projectId: markerProjectId }),
    );

    let result!: ReturnType<typeof readLocalScopeFromMarkerOrEnv>;
    withEnvUnset(['MEMSMITH_LOCAL_DEV_TEAM_ID', 'MEMSMITH_LOCAL_DEV_PROJECT_ID'], () => {
      result = readLocalScopeFromMarkerOrEnv(tempDir);
    });

    expect(result).not.toBeNull();
    expect(result!.teamId).toBe(markerTeamId);
    expect(result!.projectId).toBe(markerProjectId);
  });

  it('returns null when env is unset and no marker file present', () => {
    let result!: ReturnType<typeof readLocalScopeFromMarkerOrEnv>;
    withEnvUnset(['MEMSMITH_LOCAL_DEV_TEAM_ID', 'MEMSMITH_LOCAL_DEV_PROJECT_ID'], () => {
      result = readLocalScopeFromMarkerOrEnv(tempDir);
    });
    expect(result).toBeNull();
  });

  it('env wins over marker when both are set', () => {
    mkdirSync(join(tempDir, '.memsmith'), { recursive: true });
    writeFileSync(
      join(tempDir, '.memsmith', 'project.json'),
      JSON.stringify({ teamId: 'marker-team', projectId: 'marker-proj' }),
    );
    process.env.MEMSMITH_LOCAL_DEV_TEAM_ID = 'env-team';
    process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID = 'env-proj';

    const result = readLocalScopeFromMarkerOrEnv(tempDir);

    expect(result).not.toBeNull();
    expect(result!.teamId).toBe('env-team');
    expect(result!.projectId).toBe('env-proj');
  });
});

describe('marker-scope-wiring: create-server-service.ts structural wiring check', () => {
  it('create-server-service.ts imports and calls readLocalScopeFromMarkerOrEnv', () => {
    // Structural assertion: the source file must contain the call site that
    // wires the marker-aware helper into the server/viewer scope.
    const src = readFileSync(
      join(import.meta.dir, '../../src/server/runtime/create-server-service.ts'),
      'utf-8',
    );
    expect(src).toContain("import { readLocalScopeFromMarkerOrEnv } from './resolve-local-scope.js'");
    expect(src).toContain('readLocalScopeFromMarkerOrEnv(');
    expect(src).toContain('_localScope?.teamId');
    expect(src).toContain('_localScope?.projectId');
  });
});
