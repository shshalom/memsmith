// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { buildOllamaClassifier } from '../../../../src/server/runtime/import/ollamaClassifier.js';

const config = () => ({ apiKey: 'ollama-local', model: 'gemma4:12b', apiUrl: 'http://localhost:11434/api/chat' });
const input = { content: 'Chose Postgres over SQLite', sourceType: 'decision' };

describe('buildOllamaClassifier', () => {
  it('posts to the native chat endpoint with num_ctx pinned and thinking off', async () => {
    let url = '';
    let body: any;
    const fetchImpl = (async (u: any, init: any) => {
      url = String(u);
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ message: { content: 'Decision.' } }), { status: 200 });
    }) as any;

    const label = await buildOllamaClassifier(undefined, { fetchImpl, config }).classify(input);

    expect(label).toBe('decision');
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(body).toMatchObject({ model: 'gemma4:12b', stream: false, think: false, options: { num_ctx: 20480 } });
  });

  it('retries without the think flag when an older Ollama rejects it', async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if ('think' in body) return new Response('unknown field "think"', { status: 400 });
      return new Response(JSON.stringify({ message: { content: 'change' } }), { status: 200 });
    }) as any;

    expect(await buildOllamaClassifier(undefined, { fetchImpl, config }).classify(input)).toBe('change');
    expect(bodies).toHaveLength(2);
    expect(bodies[1].options.num_ctx).toBe(20480);
  });

  it('returns null on an error status', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as any;
    expect(await buildOllamaClassifier(undefined, { fetchImpl, config }).classify(input)).toBeNull();
  });
});
