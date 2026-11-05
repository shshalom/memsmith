import { describe, it, expect } from 'bun:test';
import { buildRemovalTasks, type RemovalSeams } from '../../src/npx-cli/commands/uninstall.js';

function seams(order: string[], overrides: Partial<RemovalSeams> = {}): RemovalSeams {
  return {
    disableLoginAutostart: () => { order.push('autostart'); return { ok: true, message: 'ok' }; },
    removeMarketplaceDirectory: () => { order.push('marketplace'); return true; },
    removeCacheDirectory: () => { order.push('cache'); return true; },
    removeFromKnownMarketplaces: () => { order.push('known'); },
    removeFromInstalledPlugins: () => { order.push('installed'); },
    removeFromClaudeSettings: () => { order.push('claude'); },
    stripLegacyMemSmithAlias: () => { order.push('alias'); },
    removeStrayMemSmithPaths: () => { order.push('stray'); return 0; },
    warn: (line) => { order.push(`warn:${line}`); },
    ...overrides,
  };
}

async function run(s: RemovalSeams): Promise<void> {
  for (const t of buildRemovalTasks(s)) await t.task(() => {});
}

describe('uninstall login autostart', () => {
  it('disables login autostart before removing the marketplace directory', async () => {
    const order: string[] = [];
    await run(seams(order));
    expect(order.indexOf('autostart')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('autostart')).toBeLessThan(order.indexOf('marketplace'));
  });

  it('a failed disable warns and the removal continues', async () => {
    const order: string[] = [];
    await run(seams(order, { disableLoginAutostart: () => ({ ok: false, message: 'launchctl bootout failed' }) }));
    expect(order.some((l) => l.startsWith('warn:') && l.includes('launchctl bootout failed'))).toBe(true);
    expect(order).toContain('marketplace');
  });

  it('a throwing disable warns and the removal continues', async () => {
    const order: string[] = [];
    await run(seams(order, { disableLoginAutostart: () => { throw new Error('boom'); } }));
    expect(order.some((l) => l.startsWith('warn:') && l.includes('boom'))).toBe(true);
    expect(order).toContain('marketplace');
  });
});
