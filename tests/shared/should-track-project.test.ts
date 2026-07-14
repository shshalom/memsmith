import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { OBSERVER_SESSIONS_DIR } from '../../src/shared/paths.js';
import { normalize } from 'path';

// Snapshot real module BEFORE mock.module mutates the live namespace.
// Bun's mock.module is process-global and survives mock.restore(), so we
// must re-register the real exports in afterAll to avoid poisoning later
// test files that import hook-settings.js.
import * as realHookSettings from '../../src/shared/hook-settings.js';
const realHookSettingsSnapshot = { ...realHookSettings };

// Mutable settings object — individual tests mutate this to control behavior
// without re-importing or re-mocking the module.
const mockSettings = {
  MEMSMITH_EXCLUDED_PROJECTS: '',
  MEMSMITH_INCLUDED_PROJECTS: '',
};

// Mock loadFromFileOnce to avoid real file I/O and settings-dependent results
mock.module('../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => mockSettings,
}));

afterAll(() => {
  mock.module('../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
});

// Import after mock so the module picks up the mocked dependency
const { shouldTrackProject } = await import('../../src/shared/should-track-project.js');

describe('shouldTrackProject — path normalization', () => {
  let savedInternal: string | undefined;

  beforeEach(() => {
    savedInternal = process.env.MEMSMITH_INTERNAL;
    delete process.env.MEMSMITH_INTERNAL;
    // Reset to empty (capture-all) defaults before each test
    mockSettings.MEMSMITH_EXCLUDED_PROJECTS = '';
    mockSettings.MEMSMITH_INCLUDED_PROJECTS = '';
  });

  afterEach(() => {
    if (savedInternal !== undefined) {
      process.env.MEMSMITH_INTERNAL = savedInternal;
    } else {
      delete process.env.MEMSMITH_INTERNAL;
    }
  });

  it('returns false when cwd matches OBSERVER_SESSIONS_DIR with forward slashes', () => {
    // Hooks may pass forward-slash paths on Windows; normalize() handles this
    const forwardSlash = OBSERVER_SESSIONS_DIR.replace(/\\/g, '/');
    expect(shouldTrackProject(forwardSlash)).toBe(false);
  });

  it('returns false when cwd is a subdirectory of OBSERVER_SESSIONS_DIR (mixed separators)', () => {
    const forwardSlash = OBSERVER_SESSIONS_DIR.replace(/\\/g, '/');
    expect(shouldTrackProject(forwardSlash + '/some-session')).toBe(false);
  });

  it('returns false when cwd matches OBSERVER_SESSIONS_DIR exactly (native separators)', () => {
    expect(shouldTrackProject(OBSERVER_SESSIONS_DIR)).toBe(false);
  });

  it('returns true for an unrelated project path', () => {
    const unrelated = normalize('/tmp/my-project');
    expect(shouldTrackProject(unrelated)).toBe(true);
  });

  it('returns false when MEMSMITH_INTERNAL is set', () => {
    process.env.MEMSMITH_INTERNAL = '1';
    expect(shouldTrackProject('/any/path')).toBe(false);
  });
});

describe('shouldTrackProject — MEMSMITH_INCLUDED_PROJECTS allowlist', () => {
  let savedInternal: string | undefined;

  beforeEach(() => {
    savedInternal = process.env.MEMSMITH_INTERNAL;
    delete process.env.MEMSMITH_INTERNAL;
    // Reset to empty (capture-all) defaults before each test
    mockSettings.MEMSMITH_EXCLUDED_PROJECTS = '';
    mockSettings.MEMSMITH_INCLUDED_PROJECTS = '';
  });

  afterEach(() => {
    if (savedInternal !== undefined) {
      process.env.MEMSMITH_INTERNAL = savedInternal;
    } else {
      delete process.env.MEMSMITH_INTERNAL;
    }
  });

  // (a) empty INCLUDED → captures all (backward compat)
  it('(a) empty INCLUDED_PROJECTS captures all cwds (backward compat)', () => {
    mockSettings.MEMSMITH_INCLUDED_PROJECTS = '';
    expect(shouldTrackProject('/home/user/some-arbitrary-project')).toBe(true);
    expect(shouldTrackProject('/Users/dev/random-repo')).toBe(true);
  });

  // (b) INCLUDED set to a glob matching cwd → true
  it('(b) INCLUDED glob matching cwd → tracked (returns true)', () => {
    mockSettings.MEMSMITH_INCLUDED_PROJECTS = '/Users/shwaits/Workspace/**';
    expect(shouldTrackProject('/Users/shwaits/Workspace/MemSmith')).toBe(true);
    expect(shouldTrackProject('/Users/shwaits/Workspace/MemSmith/src')).toBe(true);
  });

  // (c) INCLUDED set but cwd does NOT match → false
  it('(c) INCLUDED set but cwd does not match any pattern → not tracked (returns false)', () => {
    mockSettings.MEMSMITH_INCLUDED_PROJECTS = '/Users/shwaits/Workspace/MemSmith/**';
    expect(shouldTrackProject('/Users/otheruser/FormaFieldAgent')).toBe(false);
    expect(shouldTrackProject('/home/dev/some-other-project')).toBe(false);
  });

  // (d) cwd matches INCLUDED but ALSO matches EXCLUDED → false (exclusion wins)
  it('(d) cwd matches INCLUDED but also matches EXCLUDED → exclusion wins (returns false)', () => {
    mockSettings.MEMSMITH_INCLUDED_PROJECTS = '/Users/shwaits/Workspace/**';
    mockSettings.MEMSMITH_EXCLUDED_PROJECTS = '/Users/shwaits/Workspace/FormaFieldAgent';
    // This path matches both the included glob and the excluded pattern
    expect(shouldTrackProject('/Users/shwaits/Workspace/FormaFieldAgent')).toBe(false);
    // But a different workspace project should still be tracked
    expect(shouldTrackProject('/Users/shwaits/Workspace/MemSmith')).toBe(true);
  });

  // (e) MEMSMITH_INTERNAL=1 → false regardless of INCLUDED
  it('(e) MEMSMITH_INTERNAL=1 → always false regardless of INCLUDED', () => {
    process.env.MEMSMITH_INTERNAL = '1';
    mockSettings.MEMSMITH_INCLUDED_PROJECTS = '/Users/shwaits/Workspace/**';
    expect(shouldTrackProject('/Users/shwaits/Workspace/MemSmith')).toBe(false);
  });

  // Additional: semicolon-separated patterns also work
  it('semicolon-separated INCLUDED patterns are parsed correctly', () => {
    mockSettings.MEMSMITH_INCLUDED_PROJECTS = '/Users/shwaits/Workspace/MemSmith;/Users/shwaits/Workspace/OtherProject';
    expect(shouldTrackProject('/Users/shwaits/Workspace/MemSmith')).toBe(true);
    expect(shouldTrackProject('/Users/shwaits/Workspace/OtherProject')).toBe(true);
    expect(shouldTrackProject('/Users/shwaits/Workspace/FormaFieldAgent')).toBe(false);
  });

  // Additional: whitespace-only INCLUDED treated as empty (capture-all)
  it('whitespace-only INCLUDED_PROJECTS treated as empty → capture all', () => {
    mockSettings.MEMSMITH_INCLUDED_PROJECTS = '   ';
    expect(shouldTrackProject('/home/user/any-project')).toBe(true);
  });
});
