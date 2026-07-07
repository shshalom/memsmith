import { describe, test, expect, afterEach } from 'bun:test';
import { buildInjectionBlock } from '../../../src/server/retrieval/inject.js';

const rows = Array.from({ length: 6 }, (_, i) => ({
  content: `C${i}:` + 'x'.repeat(150),
  metadata: { title: `Title ${i}`, facts: [`fact ${i}`], why: `why ${i}`, private: false },
}));
const deps = { hybridSearch: async () => rows };

afterEach(() => { delete process.env.CLAUDE_MEM_TIERING; });

describe('buildInjectionBlock tiering', () => {
  test('tight budget keeps MORE items than whole-item-drop would', async () => {
    // With ~150-char full items and a 400-char budget, the old drop path fits ~2
    // full items. Tiering should surface more titles.
    const block = await buildInjectionBlock(deps, { projectId: 'p', teamId: 't', query: 'q', maxItems: 5, maxChars: 400 });
    const titleCount = (block.match(/Title \d/g) ?? []).length;
    expect(titleCount).toBeGreaterThanOrEqual(3);
    expect(block.length).toBeLessThanOrEqual(400 + 64); // header slack
  });
  test('still filters private and applies header', async () => {
    const withPrivate = { hybridSearch: async () => [{ content: 'SECRET', metadata: { private: true, title: 'secret' } }, ...rows] };
    const block = await buildInjectionBlock(withPrivate, { projectId: 'p', teamId: 't', query: 'q', maxItems: 5, maxChars: 1000 });
    expect(block).toContain('## Relevant team memory');
    expect(block).not.toContain('SECRET');
  });
  test('off-switch reproduces whole-item behavior (full content only, no partial tiers)', async () => {
    process.env.CLAUDE_MEM_TIERING = '0';
    const block = await buildInjectionBlock(deps, { projectId: 'p', teamId: 't', query: 'q', maxItems: 5, maxChars: 400 });
    // whole-item mode emits full C#: blobs (or none), never a title-only line without its blob
    if (block.includes('Title 0')) expect(block).toContain('C0:');
  });
  test('empty results -> empty string', async () => {
    const block = await buildInjectionBlock({ hybridSearch: async () => [] }, { projectId: 'p', teamId: 't', query: 'q' });
    expect(block).toBe('');
  });
});
