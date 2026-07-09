// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { buildInjectionBlock } from '../../src/server/retrieval/inject.js';
import { SettingsResolver } from '../../src/server/settings/SettingsResolver.js';

function fakeStore(overrides: Record<string, unknown>) {
  return { getTeamOverrides: async () => overrides, putTeamOverrides: async () => {} } as any;
}

// A single observation whose full `content` is far larger than the char budget,
// but whose structured metadata (title/facts/why) is small. Under tiering the
// block steps down to the structured fields and includes the distinctive
// "Why:" line; under the legacy whole-item path the oversized content is
// dropped/hard-sliced and the "Why:" line never appears. That difference is
// what lets these tests prove WHICH branch ran — not merely that a block built.
const deps = {
  hybridSearch: async () => [
    {
      content: 'X'.repeat(4000),
      metadata: { title: 'Short Title', facts: ['fact-one'], why: 'DISTINCTIVE_WHY_MARKER' },
    },
  ],
};
const input = { projectId: 'p', teamId: 't', query: 'q', maxItems: 1, maxChars: 200 };

describe('buildInjectionBlock honors the resolver over the env value', () => {
  it('tiering ON via team override -> structured fields (contains the Why marker)', async () => {
    // env says tiering OFF, but the team override says ON; the override must win.
    process.env.MEMSMITH_TIERING = '0';
    const resolver = new SettingsResolver(fakeStore({ tiering: true }));
    const block = await buildInjectionBlock(deps as any, { ...input, resolver } as any);
    delete process.env.MEMSMITH_TIERING;
    expect(block).toContain('DISTINCTIVE_WHY_MARKER');
    expect(block).toContain('Short Title');
  });

  it('tiering OFF via team override -> legacy path (no structured Why marker)', async () => {
    // env says tiering ON, but the team override says OFF; the override must win.
    process.env.MEMSMITH_TIERING = '1';
    const resolver = new SettingsResolver(fakeStore({ tiering: false }));
    const block = await buildInjectionBlock(deps as any, { ...input, resolver } as any);
    delete process.env.MEMSMITH_TIERING;
    // Legacy path renders whole content (hard-sliced to budget); it never emits
    // the structured "Why:" line, so the marker is absent.
    expect(block).not.toContain('DISTINCTIVE_WHY_MARKER');
  });
});
