// tests/server/generation/embed-for-persist.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, mock, afterEach } from 'bun:test';

// Mock the embedder module BEFORE importing the subject.
const embedMock = mock(async (_t: string) => Array.from({ length: 384 }, () => 0.1));
mock.module('../../../src/server/generation/embedder.js', () => ({ embed: embedMock }));

import { embedForPersist } from '../../../src/server/generation/embed-for-persist.js';

afterEach(() => { embedMock.mockClear(); });

describe('embedForPersist', () => {
  it('embeds non-blank content to a vector', async () => {
    const v = await embedForPersist('why did we pick postgres');
    expect(Array.isArray(v)).toBe(true);
    expect(v).toHaveLength(384);
    expect(embedMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for blank/whitespace content without calling embed', async () => {
    expect(await embedForPersist('   ')).toBeNull();
    expect(await embedForPersist('')).toBeNull();
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('returns null and NEVER throws when embed throws', async () => {
    embedMock.mockImplementationOnce(async () => { throw new Error('embedder down'); });
    let threw = false;
    let result: number[] | null = [];
    try { result = await embedForPersist('some content'); } catch { threw = true; }
    expect(threw).toBe(false);
    expect(result).toBeNull();
  });
});
