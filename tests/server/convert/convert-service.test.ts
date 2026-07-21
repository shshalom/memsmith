import { describe, it, expect } from 'bun:test';
import { runConvert, type ConvertDeps } from '../../../src/server/convert/convert-service.js';
import { COPY_TABLES, type CopyDeps } from '../../../src/server/convert/copy-engine.js';

function baseCopyDeps(remoteShort = false): CopyDeps {
  const local: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(COPY_TABLES.map(t => [t, []]));
  local.observations = [{ id: 'o1', metadata: {}, content: 'a' }];
  const remote: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(COPY_TABLES.map(t => [t, []]));
  return {
    readRows: async (t) => local[t] ?? [],
    upsertRows: async (t, rows) => { if (!(remoteShort && t === 'observations')) remote[t].push(...rows); },
    countRows: async (which, t) => (which === 'local' ? local[t] : remote[t]).length,
  };
}

describe('runConvert', () => {
  it('copies, verifies, flips, and reports restartRequired on success', async () => {
    let flipped: string | null = null;
    const deps: ConvertDeps = { copyDeps: baseCopyDeps(false), flip: (url) => { flipped = url; } };
    const phases: string[] = [];
    const r = await runConvert(deps, { databaseUrl: 'postgres://team', ownerUserId: 'u1' }, p => phases.push(p.phase));
    expect(r.status).toBe('converted');
    expect(r.restartRequired).toBe(true);
    expect(flipped).toBe('postgres://team');
    expect(phases).toContain('copying');
    expect(phases).toContain('verifying');
    expect(phases).toContain('switching');
  });

  it('does NOT flip when verify fails (stays on local)', async () => {
    let flipped: string | null = null;
    const deps: ConvertDeps = { copyDeps: baseCopyDeps(true), flip: (url) => { flipped = url; } };
    const r = await runConvert(deps, { databaseUrl: 'postgres://team', ownerUserId: 'u1' });
    expect(r.status).toBe('verify_failed');
    expect(r.restartRequired).toBe(false);
    expect(flipped).toBeNull();
    expect(r.mismatches?.length).toBeGreaterThan(0);
  });
});
