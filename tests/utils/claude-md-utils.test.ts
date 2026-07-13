import { describe, it, expect, mock, afterEach, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import path, { join } from 'path';
import { tmpdir } from 'os';

// Snapshot the real modules BEFORE mock.module mutates the live namespace, then
// re-register them in afterAll. bun's mock.module is process-global and
// mock.restore() does NOT undo it, so a partial logger mock here would
// otherwise leak into later test files (e.g. summarize-tag-stripping, which
// needs logger.dataIn).
//
// Worker retirement (dead-route sweep) — claude-md-utils no longer imports
// worker-utils. The per-folder CLAUDE.md timeline was served by the deleted
// worker route `/api/search/by-file`; there is no by-file `/v1` endpoint, so
// `updateFolderClaudeMdFiles` is gracefully disabled (runs all its
// path-validation, then returns without ever fetching or writing). The
// integration tests below therefore assert the disabled contract: never fetch,
// never write. The pure helpers (`formatTimelineForClaudeMd`,
// `writeClaudeMdToFolder`, `replaceTaggedContent`, `getTargetFilename`) are
// unchanged and keep their full coverage.
import * as realLogger from '../../src/utils/logger.js';
const realLoggerSnapshot = { ...realLogger };

mock.module('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    formatTool: (toolName: string, toolInput?: any) => toolInput ? `${toolName}(...)` : toolName,
  },
}));

afterAll(() => {
  mock.module('../../src/utils/logger.js', () => realLoggerSnapshot);
});

import {
  replaceTaggedContent,
  formatTimelineForClaudeMd,
  writeClaudeMdToFolder,
  updateFolderClaudeMdFiles,
  getTargetFilename
} from '../../src/utils/claude-md-utils.js';

let tempDir: string;
const originalFetch = global.fetch;

beforeEach(() => {
  tempDir = join(tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  mock.restore();
  global.fetch = originalFetch;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('replaceTaggedContent', () => {
  it('should wrap new content in tags when existing content is empty', () => {
    const result = replaceTaggedContent('', 'New content here');

    expect(result).toBe('<memsmith-context>\nNew content here\n</memsmith-context>');
  });

  it('should replace only tagged section when existing content has tags', () => {
    const existingContent = 'User content before\n<memsmith-context>\nOld generated content\n</memsmith-context>\nUser content after';
    const newContent = 'New generated content';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('User content before\n<memsmith-context>\nNew generated content\n</memsmith-context>\nUser content after');
  });

  it('should append tagged content with separator when no tags exist in existing content', () => {
    const existingContent = 'User written documentation';
    const newContent = 'Generated timeline';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('User written documentation\n\n<memsmith-context>\nGenerated timeline\n</memsmith-context>');
  });

  it('should append when only opening tag exists (no matching end tag)', () => {
    const existingContent = 'Some content\n<memsmith-context>\nIncomplete tag section';
    const newContent = 'New content';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('Some content\n<memsmith-context>\nIncomplete tag section\n\n<memsmith-context>\nNew content\n</memsmith-context>');
  });

  it('should append when only closing tag exists (no matching start tag)', () => {
    const existingContent = 'Some content\n</memsmith-context>\nMore content';
    const newContent = 'New content';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('Some content\n</memsmith-context>\nMore content\n\n<memsmith-context>\nNew content\n</memsmith-context>');
  });

  it('should preserve newlines in new content', () => {
    const existingContent = '<memsmith-context>\nOld content\n</memsmith-context>';
    const newContent = 'Line 1\nLine 2\nLine 3';

    const result = replaceTaggedContent(existingContent, newContent);

    expect(result).toBe('<memsmith-context>\nLine 1\nLine 2\nLine 3\n</memsmith-context>');
  });
});

describe('formatTimelineForClaudeMd', () => {
  it('should return empty string for empty input', () => {
    const result = formatTimelineForClaudeMd('');

    expect(result).toBe('');
  });

  it('should return empty string when no table rows exist', () => {
    const input = 'Just some plain text without table rows';

    const result = formatTimelineForClaudeMd(input);

    expect(result).toBe('');
  });

  it('should parse single observation row correctly', () => {
    const input = '| #123 | 4:30 PM | 🔵 | User logged in | ~100 |';

    const result = formatTimelineForClaudeMd(input);

    expect(result).toContain('#123');
    expect(result).toContain('4:30 PM');
    expect(result).toContain('🔵');
    expect(result).toContain('User logged in');
    expect(result).toContain('~100');
  });

  it('should parse ditto mark for repeated time correctly', () => {
    const input = `| #123 | 4:30 PM | 🔵 | First action | ~100 |
| #124 | ″ | 🔵 | Second action | ~150 |`;

    const result = formatTimelineForClaudeMd(input);

    expect(result).toContain('#123');
    expect(result).toContain('#124');
    expect(result).toContain('4:30 PM');
    expect(result).toContain('"');
  });

  it('should parse session ID format (#S123) correctly', () => {
    const input = '| #S123 | 4:30 PM | 🟣 | Session started | ~200 |';

    const result = formatTimelineForClaudeMd(input);

    expect(result).toContain('#S123');
    expect(result).toContain('4:30 PM');
    expect(result).toContain('🟣');
    expect(result).toContain('Session started');
  });
});

describe('writeClaudeMdToFolder', () => {
  it('should skip non-existent folders (fix for spurious directory creation)', () => {
    const folderPath = join(tempDir, 'non-existent-folder');
    const content = '# Recent Activity\n\nTest content';

    writeClaudeMdToFolder(folderPath, content);

    expect(existsSync(folderPath)).toBe(false);
    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(false);
  });

  it('should create CLAUDE.md in existing folder', () => {
    const folderPath = join(tempDir, 'existing-folder');
    mkdirSync(folderPath, { recursive: true });
    const content = '# Recent Activity\n\nTest content';

    writeClaudeMdToFolder(folderPath, content);

    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);

    const fileContent = readFileSync(claudeMdPath, 'utf-8');
    expect(fileContent).toContain('<memsmith-context>');
    expect(fileContent).toContain('Test content');
    expect(fileContent).toContain('</memsmith-context>');
  });

  it('should preserve user content outside tags', () => {
    const folderPath = join(tempDir, 'preserve-test');
    mkdirSync(folderPath, { recursive: true });

    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    const userContent = 'User-written docs\n<memsmith-context>\nOld content\n</memsmith-context>\nMore user docs';
    writeFileSync(claudeMdPath, userContent);

    const newContent = 'New generated content';
    writeClaudeMdToFolder(folderPath, newContent);

    const fileContent = readFileSync(claudeMdPath, 'utf-8');
    expect(fileContent).toContain('User-written docs');
    expect(fileContent).toContain('New generated content');
    expect(fileContent).toContain('More user docs');
    expect(fileContent).not.toContain('Old content');
  });

  it('should not create nested directories (fix for spurious directory creation)', () => {
    const folderPath = join(tempDir, 'deep', 'nested', 'folder');
    const content = 'Nested content';

    writeClaudeMdToFolder(folderPath, content);

    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(false);
    expect(existsSync(join(tempDir, 'deep'))).toBe(false);
  });

  it('should not leave .tmp file after write (atomic write)', () => {
    const folderPath = join(tempDir, 'atomic-test');
    mkdirSync(folderPath, { recursive: true });
    const content = 'Atomic write test';

    writeClaudeMdToFolder(folderPath, content);

    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    const tempFilePath = `${claudeMdPath}.tmp`;

    expect(existsSync(claudeMdPath)).toBe(true);
    expect(existsSync(tempFilePath)).toBe(false);
  });
});

describe('issue #1165 - prevent CLAUDE.md inside .git directories', () => {
  it('should not write CLAUDE.md when folder is inside .git/', () => {
    const gitRefsFolder = join(tempDir, '.git', 'refs');
    mkdirSync(gitRefsFolder, { recursive: true });

    writeClaudeMdToFolder(gitRefsFolder, 'Should not be written');

    const claudeMdPath = join(gitRefsFolder, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(false);
  });

  it('should not write CLAUDE.md when folder is .git itself', () => {
    const gitFolder = join(tempDir, '.git');
    mkdirSync(gitFolder, { recursive: true });

    writeClaudeMdToFolder(gitFolder, 'Should not be written');

    const claudeMdPath = join(gitFolder, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(false);
  });

  it('should not write CLAUDE.md to deeply nested .git path', () => {
    const deepGitPath = join(tempDir, 'project', '.git', 'hooks');
    mkdirSync(deepGitPath, { recursive: true });

    writeClaudeMdToFolder(deepGitPath, 'Should not be written');

    const claudeMdPath = join(deepGitPath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(false);
  });

  it('should still write CLAUDE.md to normal folders', () => {
    const normalFolder = join(tempDir, 'src', 'git-utils');
    mkdirSync(normalFolder, { recursive: true });

    writeClaudeMdToFolder(normalFolder, 'Should be written');

    const claudeMdPath = join(normalFolder, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);
  });
});

describe('updateFolderClaudeMdFiles (worker retirement — folder CLAUDE.md generation disabled)', () => {
  // The per-folder CLAUDE.md timeline was served by the deleted worker route
  // `/api/search/by-file`. There is NO by-file `/v1` endpoint (files live inside
  // observation metadata JSONB with no path-filter route, and no `/v1` route
  // emits the markdown timeline table `formatTimelineForClaudeMd` parses), so the
  // feature is gracefully disabled: `updateFolderClaudeMdFiles` still runs its
  // path validation but NEVER fetches and NEVER writes a CLAUDE.md. These tests
  // pin that disabled contract. The pure helpers keep their full coverage in the
  // describes above. Re-enabling only needs a by-file timeline fetch wired back
  // into the (currently inert) folder loop.
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: '| #123 | 4:30 PM | 🔵 | Test | ~100 |' }] }),
    } as Response));
    global.fetch = fetchMock;
  });

  it('resolves cleanly and never fetches when filePaths is empty', async () => {
    await expect(updateFolderClaudeMdFiles([], 'test-project', 37777)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never fetches and never writes a CLAUDE.md for a valid source file', async () => {
    const folderPath = join(tempDir, 'disabled-write-test');
    mkdirSync(folderPath, { recursive: true });
    const filePath = join(folderPath, 'test.ts');

    await expect(updateFolderClaudeMdFiles([filePath], 'test-project', 37777)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(folderPath, 'CLAUDE.md'))).toBe(false);
  });

  it('never fetches for a valid relative path resolved against projectRoot', async () => {
    await expect(
      updateFolderClaudeMdFiles(['src/utils/file.ts'], 'test-project', 37777, tempDir),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still rejects invalid paths (validation preserved) and never fetches', async () => {
    for (const bad of [
      '~/.memsmith/logs/worker.log',
      'https://example.com/file.ts',
      'PR #610 on shshalom/CLAUDE.md',
      'issue#123/file.ts',
      '../../../etc/passwd',
      '/etc/passwd',
    ]) {
      await expect(
        updateFolderClaudeMdFiles([bad], 'test-project', 37777, tempDir),
      ).resolves.toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still skips unsafe/excluded folders (validation preserved) and never fetches', async () => {
    for (const unsafe of [
      'node_modules/lodash/index.js',
      '.git/refs/heads/main',
      'app/src/main/res/layout/activity_main.xml',
      'build/outputs/apk/debug/app-debug.apk',
      'src/__pycache__/module.cpython-311.pyc',
    ]) {
      await expect(
        updateFolderClaudeMdFiles([unsafe], 'test-project', 37777, tempDir),
      ).resolves.toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still skips folders with an active CLAUDE.md and never fetches', async () => {
    await expect(
      updateFolderClaudeMdFiles(['/project/src/utils/CLAUDE.md'], 'test-project', 37777, '/project'),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getTargetFilename', () => {
  it('should return CLAUDE.md by default', () => {
    const settings = { MEMSMITH_FOLDER_USE_LOCAL_MD: 'false' } as any;
    expect(getTargetFilename(settings)).toBe('CLAUDE.md');
  });

  it('should return CLAUDE.local.md when USE_LOCAL_MD is true', () => {
    const settings = { MEMSMITH_FOLDER_USE_LOCAL_MD: 'true' } as any;
    expect(getTargetFilename(settings)).toBe('CLAUDE.local.md');
  });

  it('should return CLAUDE.md when USE_LOCAL_MD is undefined', () => {
    const settings = {} as any;
    expect(getTargetFilename(settings)).toBe('CLAUDE.md');
  });
});

describe('CLAUDE.local.md support', () => {
  it('should write CLAUDE.local.md when targetFilename is specified', () => {
    const folderPath = join(tempDir, 'local-md-test');
    mkdirSync(folderPath, { recursive: true });
    const content = '# Recent Activity\n\nTest content';

    writeClaudeMdToFolder(folderPath, content, 'CLAUDE.local.md');

    const localMdPath = join(folderPath, 'CLAUDE.local.md');
    const regularMdPath = join(folderPath, 'CLAUDE.md');

    expect(existsSync(localMdPath)).toBe(true);
    expect(existsSync(regularMdPath)).toBe(false);

    const fileContent = readFileSync(localMdPath, 'utf-8');
    expect(fileContent).toContain('<memsmith-context>');
    expect(fileContent).toContain('Test content');
    expect(fileContent).toContain('</memsmith-context>');
  });

  it('should preserve user content in CLAUDE.local.md outside tags', () => {
    const folderPath = join(tempDir, 'local-preserve-test');
    mkdirSync(folderPath, { recursive: true });

    const localMdPath = join(folderPath, 'CLAUDE.local.md');
    const userContent = 'My personal notes\n<memsmith-context>\nOld content\n</memsmith-context>\nMore notes';
    writeFileSync(localMdPath, userContent);

    writeClaudeMdToFolder(folderPath, 'New generated content', 'CLAUDE.local.md');

    const fileContent = readFileSync(localMdPath, 'utf-8');
    expect(fileContent).toContain('My personal notes');
    expect(fileContent).toContain('New generated content');
    expect(fileContent).toContain('More notes');
    expect(fileContent).not.toContain('Old content');
  });

  it('should not leave .tmp file after writing CLAUDE.local.md', () => {
    const folderPath = join(tempDir, 'local-atomic-test');
    mkdirSync(folderPath, { recursive: true });

    writeClaudeMdToFolder(folderPath, 'Atomic write test', 'CLAUDE.local.md');

    const localMdPath = join(folderPath, 'CLAUDE.local.md');
    const tempFilePath = `${localMdPath}.tmp`;

    expect(existsSync(localMdPath)).toBe(true);
    expect(existsSync(tempFilePath)).toBe(false);
  });

  it('never writes a folder CLAUDE.local.md (folder generation disabled)', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    const folderPath = join(tempDir, 'local-disabled-test');
    mkdirSync(folderPath, { recursive: true });

    await expect(
      updateFolderClaudeMdFiles([join(folderPath, 'file.ts')], 'test-project', 37777, tempDir),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(folderPath, 'CLAUDE.local.md'))).toBe(false);
  });
});

describe('skeleton CLAUDE.md deny-list (#2400) — folder generation disabled', () => {
  // Worker retirement — the #2400 deny-list only gated which folders received a
  // generated CLAUDE.md. Folder generation is now disabled wholesale (no by-file
  // `/v1` endpoint), so nothing is ever written or overwritten regardless of the
  // deny-list. The deny-list parsing + `matchesAnyGlob` wiring stays in the
  // source for when the feature is re-enabled; here we pin the "never writes,
  // never overwrites" contract.
  const ENV_KEY = 'MEMSMITH_FOLDER_MD_SKELETON_DENYLIST';
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
  });

  it('never overwrites an existing CLAUDE.md, deny-list set or not', async () => {
    process.env[ENV_KEY] = JSON.stringify(['**/transient']);

    const folderPath = join(tempDir, 'transient');
    mkdirSync(folderPath, { recursive: true });
    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    const userContent = 'USER CONTENT — must be preserved';
    writeFileSync(claudeMdPath, userContent);

    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles([join(folderPath, 'file.ts')], 'test-project', 37777, tempDir);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(claudeMdPath, 'utf-8')).toBe(userContent);
  });

  it('never creates a new CLAUDE.md when the deny-list does not match', async () => {
    process.env[ENV_KEY] = JSON.stringify(['**/some-other-dir']);

    const folderPath = join(tempDir, 'content-dir');
    mkdirSync(folderPath, { recursive: true });

    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles([join(folderPath, 'file.ts')], 'test-project', 37777, tempDir);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(folderPath, 'CLAUDE.md'))).toBe(false);
  });

  it('leaves an existing file untouched when the deny-list is unset', async () => {
    delete process.env[ENV_KEY];

    const folderPath = join(tempDir, 'no-denylist');
    mkdirSync(folderPath, { recursive: true });
    const claudeMdPath = join(folderPath, 'CLAUDE.md');
    writeFileSync(claudeMdPath, 'PRE-EXISTING');

    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
    global.fetch = fetchMock;

    await updateFolderClaudeMdFiles([join(folderPath, 'file.ts')], 'test-project', 37777, tempDir);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(claudeMdPath, 'utf-8')).toBe('PRE-EXISTING');
  });
});
