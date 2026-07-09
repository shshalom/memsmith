// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { buildInjectionBlock } from '../../src/server/retrieval/inject.js';

function fakeStore(overrides: Record<string, unknown>) {
  return { getTeamOverrides: async () => overrides, putTeamOverrides: async () => {} } as any;
}

describe('inject reads tiering via resolver when provided', () => {
  it('honors a team override that disables tiering', async () => {
    const { SettingsResolver } = await import('../../src/server/settings/SettingsResolver.js');
    const resolver = new SettingsResolver(fakeStore({ tiering: false }));
    const deps = {
      hybridSearch: async () => [
        { content: 'A'.repeat(50), metadata: { title: 'x', facts: ['f'], why: 'w' } },
      ],
    };
    // With tiering disabled via the override, the block still builds (legacy path).
    const block = await buildInjectionBlock(deps as any, {
      projectId: 'p', teamId: 't', query: 'q', maxItems: 3, maxChars: 500, resolver,
    } as any);
    expect(block.length).toBeGreaterThan(0);
  });
});
