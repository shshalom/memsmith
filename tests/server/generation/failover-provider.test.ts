// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  FAILOVER_COOLDOWN_MS,
  FailoverGenerationProvider,
} from '../../../src/server/generation/providers/FailoverGenerationProvider.js';
import { ServerClassifiedProviderError } from '../../../src/server/generation/providers/shared/error-classification.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from '../../../src/server/generation/providers/shared/types.js';

const context = { job: { id: 'job-1' }, events: [], project: { projectId: 'p', teamId: 't', serverSessionId: null } } as unknown as ServerGenerationContext;

interface Stub extends ServerGenerationProvider {
  calls: Array<{ context: ServerGenerationContext; reformatReason?: string }>;
  failing: boolean;
  error: Error;
}

function stub(label: ServerGenerationProvider['providerLabel'], failing = false): Stub {
  const s: Stub = {
    providerLabel: label,
    calls: [],
    failing,
    error: new ServerClassifiedProviderError(`${label} down`, { kind: 'transient', cause: null }),
    async generate(ctx, _signal, opts): Promise<ServerGenerationResult> {
      s.calls.push({ context: ctx, reformatReason: opts?.reformatReason });
      if (s.failing) throw s.error;
      return { rawText: `from ${label}`, providerLabel: label };
    },
  };
  return s;
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('FailoverGenerationProvider', () => {
  it('uses the primary when it succeeds', async () => {
    const primary = stub('claude');
    const fallback = stub('ollama');
    const provider = new FailoverGenerationProvider({ primary, fallback });
    const result = await provider.generate(context);
    expect(result.providerLabel).toBe('claude');
    expect(fallback.calls).toHaveLength(0);
  });

  it('sends the same job to the fallback when the primary throws', async () => {
    const primary = stub('claude', true);
    const fallback = stub('ollama');
    const provider = new FailoverGenerationProvider({ primary, fallback });
    const result = await provider.generate(context, undefined, { reformatReason: 'bad xml' });
    expect(result.providerLabel).toBe('ollama');
    expect(fallback.calls).toEqual([{ context, reformatReason: 'bad xml' }]);
  });

  it('rethrows the primary error when both fail', async () => {
    const primary = stub('claude', true);
    const fallback = stub('ollama', true);
    const provider = new FailoverGenerationProvider({ primary, fallback });
    let thrown: unknown;
    try {
      await provider.generate(context);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(primary.error);
    expect((thrown as ServerClassifiedProviderError).kind).toBe('transient');
  });

  it('skips the primary during the cooldown, then retries it', async () => {
    const c = clock();
    const primary = stub('claude', true);
    const fallback = stub('ollama');
    const provider = new FailoverGenerationProvider({ primary, fallback, now: c.now });
    await provider.generate(context);
    expect(primary.calls).toHaveLength(1);

    c.advance(60_000);
    const during = await provider.generate(context);
    expect(during.providerLabel).toBe('ollama');
    expect(primary.calls).toHaveLength(1);

    c.advance(FAILOVER_COOLDOWN_MS - 60_000 + 1);
    await provider.generate(context);
    expect(primary.calls).toHaveLength(2);
  });

  it('in cooldown, falls back to the primary when the fallback fails', async () => {
    const c = clock();
    const primary = stub('claude', true);
    const fallback = stub('ollama');
    const provider = new FailoverGenerationProvider({ primary, fallback, now: c.now });
    await provider.generate(context);

    primary.failing = false;
    fallback.failing = true;
    c.advance(60_000);
    const result = await provider.generate(context);
    expect(result.providerLabel).toBe('claude');
  });

  it('uses only the fallback when there is no primary', async () => {
    const fallback = stub('ollama');
    const provider = new FailoverGenerationProvider({ primary: null, fallback });
    expect(provider.providerLabel).toBe('ollama');
    const result = await provider.generate(context);
    expect(result.providerLabel).toBe('ollama');

    fallback.failing = true;
    let thrown: unknown;
    try {
      await provider.generate(context);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(fallback.error);
  });

  it('does not fail over when the job was aborted', async () => {
    const primary = stub('claude', true);
    const fallback = stub('ollama');
    const provider = new FailoverGenerationProvider({ primary, fallback });
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      await provider.generate(context, controller.signal);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(primary.error);
    expect(fallback.calls).toHaveLength(0);
  });
});
