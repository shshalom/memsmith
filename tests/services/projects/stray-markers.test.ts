import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findStrayMarkers } from '../../../src/services/projects/stray-markers.js';

function marker(dir: string, projectId: string, extra: object = {}) {
  mkdirSync(join(dir, '.memsmith'), { recursive: true });
  writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify({ teamId: `t-${projectId}`, projectId, note: 'n', ...extra }));
}

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ms-stray-')));
  mkdirSync(join(root, '.git'));
  marker(root, 'p-root');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('findStrayMarkers', () => {
  it('reports a subfolder marker that names another project', () => {
    mkdirSync(join(root, 'src', 'cli'), { recursive: true });
    marker(join(root, 'src', 'cli'), 'p-cli');
    const found = findStrayMarkers(root, 'p-root');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ dir: join(root, 'src', 'cli'), root, rootProjectId: 'p-root' });
    expect(found[0].marker.projectId).toBe('p-cli');
  });

  it('ignores a subfolder marker that names the root project', () => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    marker(join(root, 'docs'), 'p-root');
    expect(findStrayMarkers(root, 'p-root')).toEqual([]);
  });

  it('skips a nested repository, which is a project of its own', () => {
    mkdirSync(join(root, 'vendor-lib', '.git'), { recursive: true });
    marker(join(root, 'vendor-lib'), 'p-lib');
    mkdirSync(join(root, 'packages', 'app', '.git'), { recursive: true });
    mkdirSync(join(root, 'packages', 'app', 'src'), { recursive: true });
    marker(join(root, 'packages', 'app', 'src'), 'p-app-src');
    expect(findStrayMarkers(root, 'p-root')).toEqual([]);
  });

  it('skips dependency and build folders', () => {
    for (const skipped of ['node_modules', 'build', 'dist']) {
      mkdirSync(join(root, skipped, 'pkg'), { recursive: true });
      marker(join(root, skipped, 'pkg'), `p-${skipped}`);
    }
    expect(findStrayMarkers(root, 'p-root')).toEqual([]);
  });

  it('returns nothing for a root that does not exist', () => {
    expect(findStrayMarkers(join(root, 'gone'), 'p-root')).toEqual([]);
  });
});
