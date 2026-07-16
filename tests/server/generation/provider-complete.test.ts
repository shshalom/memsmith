// tests/server/generation/provider-complete.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { providerComplete } from '../../../src/server/generation/provider-complete.js';

const ollamaProvider = { providerLabel: 'ollama' } as any;

describe('providerComplete', () => {
  it('returns the completion text for a chat-completions response', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'YES: composed note' } }] }), { status: 200 });
    const out = await providerComplete({ provider: ollamaProvider, system: 's', user: 'u' }, { fetchImpl } as any);
    expect(out).toBe('YES: composed note');
  });
  it('returns null on HTTP error, never throws', async () => {
    const fetchImpl = async () => new Response('nope', { status: 500 });
    const out = await providerComplete({ provider: ollamaProvider, system: 's', user: 'u' }, { fetchImpl } as any);
    expect(out).toBeNull();
  });
  it('returns null when fetch throws, never throws', async () => {
    const fetchImpl = async () => { throw new Error('down'); };
    let threw = false; let out: string | null = 'x';
    try { out = await providerComplete({ provider: ollamaProvider, system: 's', user: 'u' }, { fetchImpl } as any); } catch { threw = true; }
    expect(threw).toBe(false); expect(out).toBeNull();
  });
  it('returns null for a provider it does not support (fail-open to Layer 1)', async () => {
    const out = await providerComplete({ provider: { providerLabel: 'gemini' } as any, system: 's', user: 'u' }, {} as any);
    expect(out).toBeNull();
  });
});
