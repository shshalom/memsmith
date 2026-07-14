import { describe, it, expect, afterEach } from 'bun:test';
import { resolveDashboardUrl } from '../../src/shared/dashboard-url.js';

describe('resolveDashboardUrl', () => {
  afterEach(() => { delete process.env.MEMSMITH_SERVER_PORT; });

  it('uses the UID-derived port when MEMSMITH_SERVER_PORT is unset', () => {
    delete process.env.MEMSMITH_SERVER_PORT;
    const expectedPort = 38877 + ((process.getuid?.() ?? 77) % 100);
    expect(resolveDashboardUrl()).toBe(`http://127.0.0.1:${expectedPort}`);
  });

  it('honors MEMSMITH_SERVER_PORT when set to a positive integer', () => {
    process.env.MEMSMITH_SERVER_PORT = '45123';
    expect(resolveDashboardUrl()).toBe('http://127.0.0.1:45123');
  });

  it('ignores a non-integer MEMSMITH_SERVER_PORT and falls back to UID-derived', () => {
    process.env.MEMSMITH_SERVER_PORT = 'not-a-number';
    const expectedPort = 38877 + ((process.getuid?.() ?? 77) % 100);
    expect(resolveDashboardUrl()).toBe(`http://127.0.0.1:${expectedPort}`);
  });

  it('ignores an empty MEMSMITH_SERVER_PORT and falls back to UID-derived', () => {
    process.env.MEMSMITH_SERVER_PORT = '';
    const expectedPort = 38877 + ((process.getuid?.() ?? 77) % 100);
    expect(resolveDashboardUrl()).toBe(`http://127.0.0.1:${expectedPort}`);
  });
});
