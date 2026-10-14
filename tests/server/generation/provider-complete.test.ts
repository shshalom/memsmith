// tests/server/generation/provider-complete.test.ts
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { providerComplete } from '../../../src/server/generation/provider-complete.js';

const ollamaProvider = { providerLabel: 'ollama' } as any;
const fakeProvider = (label: string) => ({ providerLabel: label } as any);

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

  it('openrouter: posts to /chat/completions and returns content', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    let calledUrl = '';
    const fetchImpl = (async (url: any, _init: any) => {
      calledUrl = String(url);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'OR-REPLY' } }] }) };
    }) as any;
    const out = await providerComplete({ provider: fakeProvider('openrouter'), system: 's', user: 'u' }, { fetchImpl });
    delete process.env.OPENROUTER_API_KEY;
    expect(calledUrl).toContain('/chat/completions');
    expect(out).toBe('OR-REPLY');
  });

  it('claude: posts to /v1/messages and returns text', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let calledUrl = '';
    const fetchImpl = (async (url: any, _init: any) => {
      calledUrl = String(url);
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'CLAUDE-REPLY' }] }) };
    }) as any;
    const out = await providerComplete({ provider: fakeProvider('claude'), system: 's', user: 'u' }, { fetchImpl });
    delete process.env.ANTHROPIC_API_KEY;
    expect(calledUrl).toContain('/v1/messages');
    expect(out).toBe('CLAUDE-REPLY');
  });

  it('gemini: posts to generateContent and returns text', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    let calledUrl = '';
    const fetchImpl = (async (url: any, _init: any) => {
      calledUrl = String(url);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'GEMINI-REPLY' }] } }] }) };
    }) as any;
    const out = await providerComplete({ provider: fakeProvider('gemini'), system: 's', user: 'u' }, { fetchImpl });
    delete process.env.GEMINI_API_KEY;
    expect(calledUrl).toContain('generateContent');
    expect(out).toBe('GEMINI-REPLY');
  });

  it('non-ok response returns null (fail-open) for any provider', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
    for (const label of ['ollama', 'openrouter', 'claude', 'gemini']) {
      expect(await providerComplete({ provider: fakeProvider(label), system: 's', user: 'u' }, { fetchImpl })).toBeNull();
    }
  });

  it('unknown provider returns null', async () => {
    expect(await providerComplete({ provider: fakeProvider('mystery'), system: 's', user: 'u' })).toBeNull();
  });

  // The record-intent backstop read keys from the process environment only, so
  // a key the installer saved never reached it even after generation could use it.
  it('gemini: uses the key saved in settings.json', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: any) => {
      calledUrl = String(url);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }) };
    }) as any;
    const sources = { env: {}, settings: { MEMSMITH_GEMINI_API_KEY: 'saved-gemini' }, dotEnv: {} };
    expect(await providerComplete({ provider: fakeProvider('gemini'), system: 's', user: 'u' }, { fetchImpl, sources })).toBe('OK');
    expect(calledUrl).toContain('key=saved-gemini');
  });

  it('claude: uses the key saved in ~/.memsmith/.env over a shell key', async () => {
    let sentKey = '';
    const fetchImpl = (async (_url: any, init: any) => {
      sentKey = init.headers['x-api-key'];
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'OK' }] }) };
    }) as any;
    const sources = { env: { ANTHROPIC_API_KEY: 'shell' }, settings: {}, dotEnv: { ANTHROPIC_API_KEY: 'saved-anthropic' } };
    await providerComplete({ provider: fakeProvider('claude'), system: 's', user: 'u' }, { fetchImpl, sources });
    expect(sentKey).toBe('saved-anthropic');
  });

  it('ollama: posts to the URL saved in settings.json', async () => {
    let calledUrl = '';
    const fetchImpl = (async (url: any) => {
      calledUrl = String(url);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
    }) as any;
    const sources = { env: {}, settings: { MEMSMITH_OLLAMA_URL: 'http://gpu-box:11434/v1' }, dotEnv: {} };
    await providerComplete({ provider: ollamaProvider, system: 's', user: 'u' }, { fetchImpl, sources });
    expect(calledUrl).toBe('http://gpu-box:11434/v1/chat/completions');
  });
});
