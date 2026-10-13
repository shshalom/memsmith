import { describe, it, expect, afterEach } from 'bun:test';
import { checkGenerationReadiness } from '../../../src/cli/handlers/generation-readiness.js';

// A fresh install generates with Ollama by default; without Ollama or its model,
// every captured event failed generation and nothing was ever remembered, with
// no sign of it in the session (fresh-install rehearsal, 2026-10-07).

let server: ReturnType<typeof Bun.serve> | null = null;

function fakeOllama(models: string[]) {
  server = Bun.serve({
    port: 0,
    fetch: (req) => new URL(req.url).pathname === '/api/tags'
      ? Response.json({ models: models.map((name) => ({ name })) })
      : new Response('not found', { status: 404 }),
  });
  return `http://127.0.0.1:${server.port}/v1`;
}

afterEach(() => { server?.stop(true); server = null; });

describe('checkGenerationReadiness', () => {
  it('reports nothing when Ollama has the configured model', async () => {
    const url = fakeOllama(['qwen2.5:14b', 'llama3.1:8b']);
    expect(await checkGenerationReadiness({ MEMSMITH_OLLAMA_URL: url }, {})).toBeNull();
  });

  it('tells the user which model to pull when it is missing', async () => {
    const url = fakeOllama(['llama3.1:8b']);
    const message = await checkGenerationReadiness({ MEMSMITH_OLLAMA_URL: url }, {});
    expect(message).toContain('ollama pull qwen2.5:14b');
  });

  it('tells the user to install and start Ollama when nothing is listening', async () => {
    const url = fakeOllama([]);
    server!.stop(true);
    server = null;
    const message = await checkGenerationReadiness({ MEMSMITH_OLLAMA_URL: url }, {});
    expect(message).toContain('Ollama is not running');
    expect(message).toContain('https://ollama.com');
  });

  it('trusts the provider the server resolved over the settings file', async () => {
    // The dashboard stores a provider override on the server; the settings file
    // still says nothing, so it alone would wrongly default to Ollama.
    let probed = false;
    const message = await checkGenerationReadiness({}, {}, {
      fetch: async () => { probed = true; return { ok: true, json: async () => ({ models: [] }) }; },
    }, { provider: 'claude' });
    expect(message).toBeNull();
    expect(probed).toBe(false);
  });

  it('checks for the model the server resolved', async () => {
    const url = fakeOllama(['qwen2.5:14b']);
    const message = await checkGenerationReadiness({ MEMSMITH_OLLAMA_URL: url }, {}, {}, { provider: 'ollama', model: 'llama3.1:8b' });
    expect(message).toContain('ollama pull llama3.1:8b');
  });

  it('does not probe Ollama when another provider is configured', async () => {
    let probed = false;
    const message = await checkGenerationReadiness({ MEMSMITH_SERVER_PROVIDER: 'claude' }, {}, {
      fetch: async () => { probed = true; return { ok: true, json: async () => ({ models: [] }) }; },
    });
    expect(message).toBeNull();
    expect(probed).toBe(false);
  });
});
