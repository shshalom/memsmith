// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import { normalizeRuntimeFlag } from '../../src/npx-cli/commands/server-runtime-setup.js';

describe('server-runtime-setup — install planning (#2543)', () => {
  it('normalizeRuntimeFlag maps local, the legacy worker alias, and the default to local', () => {
    expect(normalizeRuntimeFlag(undefined)).toBe('local');
    expect(normalizeRuntimeFlag('')).toBe('local');
    expect(normalizeRuntimeFlag('local')).toBe('local');
    expect(normalizeRuntimeFlag('LOCAL')).toBe('local');
    expect(normalizeRuntimeFlag('worker')).toBe('local');
  });

  it('normalizeRuntimeFlag maps server and the legacy server-beta alias to server', () => {
    expect(normalizeRuntimeFlag('server')).toBe('server');
    expect(normalizeRuntimeFlag('server-beta')).toBe('server');
    expect(normalizeRuntimeFlag('SERVER')).toBe('server');
    expect(normalizeRuntimeFlag('bogus')).toBeNull();
  });
});
