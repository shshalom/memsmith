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

const baseInput = {
  databaseUrl: 'postgres://team',
  ownerUserId: 'u1',
  cwd: '/proj/a',
  teamId: 'team-a',
  serverUrl: 'http://team-a:38890',
  apiKey: 'cmem_test',
  projectId: 'p1',
};

describe('runConvert', () => {
  it('copies, verifies, flips, and reports restartRequired on success', async () => {
    let flippedUrl: string | null = null;
    const deps: ConvertDeps = { copyDeps: baseCopyDeps(false), flip: (fi) => { flippedUrl = fi.databaseUrl; } };
    const phases: string[] = [];
    const r = await runConvert(deps, baseInput, p => phases.push(p.phase));
    expect(r.status).toBe('converted');
    expect(r.restartRequired).toBe(true);
    expect(flippedUrl).toBe('postgres://team');
    expect(phases).toContain('copying');
    expect(phases).toContain('verifying');
    expect(phases).toContain('switching');
  });

  it('passes full flip input to the flip callback', async () => {
    let flipInput: ReturnType<ConvertDeps['flip']> | null = null;
    const deps: ConvertDeps = { copyDeps: baseCopyDeps(false), flip: (fi) => { flipInput = fi; } };
    await runConvert(deps, baseInput);
    expect((flipInput as any)?.cwd).toBe('/proj/a');
    expect((flipInput as any)?.teamId).toBe('team-a');
    expect((flipInput as any)?.serverUrl).toBe('http://team-a:38890');
    expect((flipInput as any)?.apiKey).toBe('cmem_test');
  });

  it('does NOT flip when verify fails (stays on local)', async () => {
    let flippedUrl: string | null = null;
    const deps: ConvertDeps = { copyDeps: baseCopyDeps(true), flip: (fi) => { flippedUrl = fi.databaseUrl; } };
    const r = await runConvert(deps, baseInput);
    expect(r.status).toBe('verify_failed');
    expect(r.restartRequired).toBe(false);
    expect(flippedUrl).toBeNull();
    expect(r.mismatches?.length).toBeGreaterThan(0);
  });
});
