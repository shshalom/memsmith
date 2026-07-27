// SPDX-License-Identifier: Apache-2.0
//
// Item 2 (design doc 2026-07-27-local-fresh-install-readiness-design.md):
// the SPA must never drop `?project=` once it has it. These are the pure
// functions the app builds its scope-persistence on -- see
// hooks/useProjectScope.ts and components/ProjectSwitcher.tsx for the
// DOM-touching callers, which cannot be exercised without a real browser
// (bun test has no `location`/`window`; see report for what that leaves
// unverified).
import { describe, it, expect } from 'bun:test';
import { readProjectParam, withProjectParam, projectSwitchUrl, PROJECT_PARAM } from '../../src/ui/viewer/utils/projectScope.js';

describe('readProjectParam', () => {
  it('reads ?project= from a search string', () => {
    expect(readProjectParam('?project=42d7997d-5708-4e26-9e7c-b6f2247085a8')).toBe('42d7997d-5708-4e26-9e7c-b6f2247085a8');
  });

  it('returns empty string when absent -- a load with no parameter behaves as today', () => {
    expect(readProjectParam('')).toBe('');
    expect(readProjectParam('?other=1')).toBe('');
  });

  it('reads project alongside other params', () => {
    expect(readProjectParam('?offset=0&project=abc&limit=50')).toBe('abc');
  });

  it('param name is exactly "project"', () => {
    expect(PROJECT_PARAM).toBe('project');
  });
});

describe('withProjectParam', () => {
  it('sets project while preserving other existing parameters', () => {
    expect(withProjectParam('?offset=0&limit=50', 'abc')).toBe('?offset=0&limit=50&project=abc');
  });

  it('overwrites an existing project value rather than duplicating it', () => {
    expect(withProjectParam('?project=old&limit=50', 'new')).toBe('?project=new&limit=50');
  });

  it('removes the parameter entirely when given an empty id, keeping bare "/" truly bare', () => {
    expect(withProjectParam('?project=abc', '')).toBe('');
    expect(withProjectParam('', '')).toBe('');
  });

  it('produces no leading "?" when the result has no parameters', () => {
    expect(withProjectParam('?project=abc', '')).toBe('');
  });
});

describe('projectSwitchUrl', () => {
  it('builds a navigable URL carrying the selected project, preserving path', () => {
    expect(projectSwitchUrl('/', '', 'abc')).toBe('/?project=abc');
  });

  it('preserves unrelated query params on the target URL', () => {
    expect(projectSwitchUrl('/', '?theme=dark', 'abc')).toBe('/?theme=dark&project=abc');
  });

  it('a view change must not drop the project param: simulating navigation twice with the same id is idempotent', () => {
    const first = projectSwitchUrl('/', '', 'abc');
    const secondSearch = first.slice(first.indexOf('?'));
    const second = projectSwitchUrl('/', secondSearch, 'abc');
    expect(second).toBe(first);
  });
});
