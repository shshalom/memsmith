import { describe, it, expect } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

// MemSmith must never derive a port in claude-mem's bands (377xx worker / 378xx
// server). claude-mem uses 37700+uid%100 and 37877+uid%100; MemSmith uses
// 38700+uid%100 and 38877+uid%100 (claude-mem + 1000). Same-machine collision
// with claude-mem's dashboard/server is the bug this guards against.
describe('port separation from claude-mem', () => {
  const uid = process.getuid?.() ?? 77;
  const defaults = SettingsDefaultsManager.getAllDefaults();

  it('worker port is in the 387xx band, not claude-mem 377xx', () => {
    expect(defaults.MEMSMITH_WORKER_PORT).toBe(String(38700 + (uid % 100)));
    expect(Number(defaults.MEMSMITH_WORKER_PORT)).toBeGreaterThanOrEqual(38700);
    expect(Number(defaults.MEMSMITH_WORKER_PORT)).toBeLessThan(38800);
  });

  it('server runtime URL uses the 388xx band, not claude-mem 378xx', () => {
    const port = new URL(defaults.MEMSMITH_SERVER_URL).port;
    expect(port).toBe(String(38877 + (uid % 100)));
    expect(defaults.MEMSMITH_SERVER_BETA_URL).toBe(defaults.MEMSMITH_SERVER_URL);
  });

  it('redis prefix embeds the new worker port', () => {
    expect(defaults.MEMSMITH_QUEUE_REDIS_PREFIX).toBe(`memsmith_${38700 + (uid % 100)}`);
  });

  it('no default value contains a claude-mem port base', () => {
    const all = JSON.stringify(defaults);
    expect(all).not.toContain('37700');
    expect(all).not.toContain('37877');
  });
});
