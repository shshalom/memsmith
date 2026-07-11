// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { runFirstRunImport } from '../../src/server/runtime/import/firstRunImport.js';

function baseDeps(over: Partial<Parameters<typeof runFirstRunImport>[0]> = {}) {
  const inserted: any[] = [];
  let marker = false;
  return {
    inserted,
    deps: {
      sqliteExists: () => true,
      observationsEmpty: async () => true,
      markerExists: () => marker,
      writeMarker: () => { marker = true; },
      readSourceRows: async () => [
        { id: '1', type: 'decision', content: 'chose PG' },
        { id: '2', type: 'note', content: 'misc note' },
      ],
      insertRow: async (r: any) => { inserted.push(r); },
      classifier: { classify: async () => 'discovery' },
      ...over,
    },
    getMarker: () => marker,
  };
}

describe('runFirstRunImport', () => {
  it('imports rows and reclassifies unknown types', async () => {
    const { deps, inserted } = baseDeps();
    const res = await runFirstRunImport(deps as any);
    expect(res.imported).toBe(2);
    expect(inserted.find((r) => r.id === '1').obsType).toBe('decision');   // canonical kept
    expect(inserted.find((r) => r.id === '2').obsType).toBe('discovery');  // model-classified
  });
  it('skips when marker exists', async () => {
    const { deps } = baseDeps({ markerExists: () => true });
    const res = await runFirstRunImport(deps as any);
    expect(res.skipped).toBe(true);
  });
  it('skips when observations table is non-empty', async () => {
    const { deps } = baseDeps({ observationsEmpty: async () => false });
    const res = await runFirstRunImport(deps as any);
    expect(res.skipped).toBe(true);
  });
  it('skips when no sqlite file', async () => {
    const { deps } = baseDeps({ sqliteExists: () => false });
    const res = await runFirstRunImport(deps as any);
    expect(res.skipped).toBe(true);
  });
});
