// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { normalizeRuntime } from '../../../src/services/hooks/runtime-selector.js';

describe('selectRuntime normalization', () => {
  it('maps server and server-beta to server', () => {
    expect(normalizeRuntime('server')).toBe('server');
    expect(normalizeRuntime('server-beta')).toBe('server');
  });
  it('maps legacy worker to local (smooth remap)', () => {
    expect(normalizeRuntime('worker')).toBe('local');
  });
  it('maps unset/unknown to local', () => {
    expect(normalizeRuntime(undefined)).toBe('local');
    expect(normalizeRuntime('banana')).toBe('local');
  });
});
