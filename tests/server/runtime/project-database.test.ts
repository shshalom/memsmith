import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readProjectMarker, writeProjectDatabaseName } from '../../../src/services/identity/project-identity.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ms-dbmarker-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function seedMarker(m: Record<string, unknown>) {
  mkdirSync(join(root, '.memsmith'), { recursive: true });
  writeFileSync(join(root, '.memsmith', 'project.json'), JSON.stringify({ teamId: 't', projectId: 'p', note: 'n', ...m }), 'utf-8');
}

describe('marker databaseName', () => {
  it('readProjectMarker preserves databaseName', () => {
    seedMarker({ databaseName: 'msp_p' });
    expect(readProjectMarker(root)?.databaseName).toBe('msp_p');
  });
  it('writeProjectDatabaseName merges into existing marker without dropping fields', () => {
    seedMarker({ runtime: 'local', serverUrl: 'http://x' });
    writeProjectDatabaseName(root, 'msp_p');
    const m = readProjectMarker(root)!;
    expect(m.databaseName).toBe('msp_p');
    expect(m.runtime).toBe('local');
    expect(m.serverUrl).toBe('http://x');
    expect(m.teamId).toBe('t');
    expect(m.projectId).toBe('p');
  });
  it('writeProjectDatabaseName throws when no marker exists', () => {
    expect(() => writeProjectDatabaseName(root, 'msp_p')).toThrow();
  });
});
