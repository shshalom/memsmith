
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

// Capture the REAL modules BEFORE mocking so afterAll can restore them.
// bun's `mock.module` is process-global and sticky; `mock.restore()` does NOT
// undo it, so we must explicitly re-register the real implementations to keep
// the suite order-independent (otherwise these mocks leak into later files).
import * as realSettingsDefaultsManager from '../../src/shared/SettingsDefaultsManager.js';
import * as realProjectName from '../../src/utils/project-name.js';
import * as realProjectFilter from '../../src/utils/project-filter.js';

// Snapshot the real exports into plain objects NOW, before mock.module mutates
// the live ESM namespace bindings. These snapshots are re-registered in afterAll.
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realProjectNameSnapshot = { ...realProjectName };
const realProjectFilterSnapshot = { ...realProjectFilter };

mock.module('../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'MEMSMITH_DATA_DIR') return join(homedir(), '.memsmith');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ MEMSMITH_EXCLUDED_PROJECTS: [] }),
  },
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: () => 'test-project',
  getProjectContext: () => ({ allProjects: ['test-project'] }),
}));

mock.module('../../src/utils/project-filter.js', () => ({
  isProjectExcluded: () => false,
}));

import { fileContextHandler } from '../../src/cli/handlers/file-context.js';
import { logger } from '../../src/utils/logger.js';

const PADDING = 'x'.repeat(2_000);

let tmpDir: string;
let testFile: string;
let loggerSpies: ReturnType<typeof spyOn>[] = [];
let fetchSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'file-context-test-'));
  testFile = join(tmpDir, 'test.md');
  writeFileSync(testFile, PADDING);

  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(s => s.mockRestore());
  if (fetchSpy) {
    fetchSpy.mockRestore();
    fetchSpy = null;
  }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterAll(() => {
  mock.module('../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../src/utils/project-filter.js', () => realProjectFilterSnapshot);
});

// C1 (worker retirement) — the PreToolUse file-timeline injection was served by
// the deleted worker route `/api/observations/by-file`. The `/v1` Postgres server
// has NO equivalent by-file endpoint (files_read/files_modified live in
// observation metadata JSONB, but no route/repo query exposes a file-path
// filter). Repointing needs NEW server infrastructure, out of scope for the
// repoint/delete fix, so the feature is currently DISABLED — buildFileContextTimeline
// always returns null. These tests pin the CURRENT contract: the handler stays
// graceful (never blocks a Read, never mutates the tool input, never dispatches
// to a worker) and simply injects nothing. See final-fix-report.md (STOPPED item).
describe('fileContextHandler — file-timeline disabled after worker retirement', () => {
  it('injects nothing for a Read (feature disabled: no by-file endpoint)', async () => {
    // The handler no longer performs any network fetch for file history — the
    // by-file worker route was retired and has no `/v1` replacement. We assert
    // the observable contract (graceful no-injection) rather than spying on
    // `fetch`, whose global mock can leak across suites.
    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it('never sets updatedInput on an unconstrained Read (#2094 still honored)', async () => {
    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile },
    });

    expect((result.hookSpecificOutput as any)?.updatedInput).toBeUndefined();
  });

  it('never sets updatedInput on a targeted Read either (#2094 still honored)', async () => {
    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: { file_path: testFile, offset: 289, limit: 140 },
    });

    expect((result.hookSpecificOutput as any)?.updatedInput).toBeUndefined();
  });

  it('gracefully skips a Codex filePaths array (no injection, no throw)', async () => {
    const otherFile = join(tmpDir, 'other.md');
    writeFileSync(otherFile, PADDING);

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Bash',
      toolInput: { filePaths: [testFile, otherFile] },
    });

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it('returns no context with no candidate paths', async () => {
    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Read',
      toolInput: {},
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it('skips directories (no injection)', async () => {
    const directoryPath = join(tmpDir, 'large-dir');
    mkdirSync(directoryPath);

    const result = await fileContextHandler.execute({
      sessionId: 'sess',
      cwd: tmpDir,
      toolName: 'Bash',
      toolInput: { filePaths: [directoryPath] },
    });

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });
});
