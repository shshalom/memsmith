// SPDX-License-Identifier: Apache-2.0
//
// A reachable Ollama is not necessarily a WORKING Ollama.
//
// ensureOllamaRunning probes `GET /api/tags` and treats `r.ok` as "ollama is
// fine". That is a LIVENESS check — is the HTTP daemon answering — and the
// design behind it (recorded in memory) assumed the only failure mode was
// ollama being DOWN: "probed and started if it's down on every attempt", with
// connection-refused classified transient/retryable.
//
// The real outage was neither. Ollama was up, /api/tags returned 200 with the
// full model list, and every single generate call returned HTTP 500:
//
//   Unable to reach MTLCompilerService ... the compiler is no longer active
//   error: failed to initialize the Metal library
//   error: failed to allocate context
//
// So the probe passed, recovery reported success, and the job walked straight
// into the 500. Measured on the dogfood install: 1,187,422 consecutive
// failures, 644 jobs queued, nothing generated for 6.4 days. Restarting ollama
// fixes it instantly — but nothing ever decided to restart it, because by the
// only question being asked, ollama was healthy.
//
// The probe must ask the question the caller actually needs answered: can this
// thing GENERATE? A liveness probe standing in for a readiness probe is how a
// recovery mechanism sleeps through the outage it exists to fix.

import { describe, it, expect } from 'bun:test';
import { ollamaCanGenerate } from '../../../src/server/generation/providers/ollama-ensure-running.js';

/** A fetch stub: /api/tags is healthy, /api/generate behaves as configured. */
function fakeFetch(generate: { status: number; body?: string }) {
  return async (url: string | URL): Promise<Response> => {
    const u = String(url);
    if (u.includes('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:14b' }] }), { status: 200 });
    }
    return new Response(generate.body ?? '{}', { status: generate.status });
  };
}

describe('ollamaCanGenerate', () => {
  it('is false when the daemon is up but generation 500s', async () => {
    // THE OUTAGE. /api/tags is 200 — the old probe returned "healthy" here and
    // recovery did nothing for six days.
    const ok = await ollamaCanGenerate({
      origin: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      fetchImpl: fakeFetch({
        status: 500,
        body: JSON.stringify({ error: 'failed to initialize the Metal library' }),
      }) as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });

  it('is true when generation succeeds', async () => {
    const ok = await ollamaCanGenerate({
      origin: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      fetchImpl: fakeFetch({ status: 200, body: JSON.stringify({ response: 'ok' }) }) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
  });

  it('is true when the model is missing, so a healthy daemon is not restarted', async () => {
    // Restarting cannot pull a model; it only kills whatever ollama is serving.
    const ok = await ollamaCanGenerate({
      origin: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      fetchImpl: fakeFetch({ status: 404, body: JSON.stringify({ error: "model 'qwen2.5:14b' not found" }) }) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
  });

  it('is false when the daemon is unreachable', async () => {
    // The failure mode the original design DID handle. It must keep working.
    const ok = await ollamaCanGenerate({
      origin: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      fetchImpl: (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });

  it('never throws — it sits in the hot path of every generation', async () => {
    // A probe that throws would fail the job for a reason unrelated to the job.
    const ok = await ollamaCanGenerate({
      origin: 'not a url',
      model: 'm',
      fetchImpl: (async () => { throw new Error('boom'); }) as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });

  // Every request hangs until its signal fires; /api/ps answers only when `psAnswers`.
  function hangingGenerate(psAnswers: boolean) {
    return ((u: unknown, init?: { signal?: AbortSignal }) => {
      if (psAnswers && String(u).endsWith('/api/ps')) {
        return Promise.resolve(new Response(JSON.stringify({ models: [{ name: 'qwen2.5:14b' }] }), { status: 200 }));
      }
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(init.signal!.reason));
      });
    }) as unknown as typeof fetch;
  }

  it('bounds how long it waits and reports a wedged daemon as unable to generate', async () => {
    // A wedged backend can hang rather than 500: generate AND /api/ps hang.
    const started = Date.now();
    const ok = await ollamaCanGenerate({
      origin: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      timeoutMs: 50,
      fetchImpl: hangingGenerate(false),
    });
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('treats a busy daemon as healthy so it is not killed mid-generation', async () => {
    // Observed 2026-10-07: the probe queued behind an in-flight generation, timed
    // out, and the caller killed ollama every few minutes. /api/ps still answers.
    const ok = await ollamaCanGenerate({
      origin: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      timeoutMs: 50,
      fetchImpl: hangingGenerate(true),
    });
    expect(ok).toBe(true);
  });
});
