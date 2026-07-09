import { describe, test, expect } from 'bun:test';
import { shouldFallbackToPolling } from '../../src/ui/viewer/hooks/sse-fallback.js';
describe('sse fallback', () => {
  test('falls back after a stream error', () => {
    expect(shouldFallbackToPolling({ streamErrored: true, reconnecting: true })).toBe(true);
  });
  test('no fallback while stream is healthy', () => {
    expect(shouldFallbackToPolling({ streamErrored: false, reconnecting: false })).toBe(false);
  });
});
