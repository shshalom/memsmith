// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { GenerationProviderHolder } from '../../../src/server/generation/GenerationProviderHolder.js';
import { FailoverGenerationProvider } from '../../../src/server/generation/providers/FailoverGenerationProvider.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from '../../../src/server/generation/providers/shared/types.js';
import { buildGenerationProvider } from '../../../src/server/runtime/create-server-service.js';
import type { GenerationConfigSources } from '../../../src/server/runtime/generation-credentials.js';
import { SettingsResolver } from '../../../src/server/settings/SettingsResolver.js';

const ENV_KEYS = [
  'MEMSMITH_SERVER_PROVIDER',
  'MEMSMITH_SERVER_MODEL',
  'MEMSMITH_SERVER_FALLBACK',
  'MEMSMITH_SERVER_FALLBACK_MODEL',
];
const sources: GenerationConfigSources = { env: {}, settings: {}, dotEnv: {} };
const context = { job: { id: 'job-1' }, events: [], project: { projectId: 'p', teamId: 't', serverSessionId: null } } as unknown as ServerGenerationContext;

interface StubProvider extends ServerGenerationProvider {
  calls: number;
  failing: boolean;
}

function stubProvider(label: ServerGenerationProvider['providerLabel'], failing = false): StubProvider {
  const s: StubProvider = {
    providerLabel: label,
    calls: 0,
    failing,
    async generate(): Promise<ServerGenerationResult> {
      s.calls++;
      if (s.failing) throw new Error(`${label} down`);
      return { rawText: `from ${label}`, providerLabel: label };
    },
  };
  return s;
}

function harness(opts: {
  file?: Record<string, unknown>;
  team?: Record<string, unknown>;
  claude?: StubProvider | null;
} = {}) {
  const calls: Array<[string, string | undefined]> = [];
  const claude = opts.claude === undefined ? stubProvider('claude') : opts.claude;
  const ollama = stubProvider('ollama');
  const instantiate = (provider: string, model?: string) => {
    calls.push([provider, model]);
    return provider === 'claude' ? claude : provider === 'ollama' ? ollama : null;
  };
  const store = { getTeamOverrides: async () => opts.team ?? {}, putTeamOverrides: async () => {} } as never;
  const resolver = new SettingsResolver(store, { fileSettings: () => opts.file ?? {}, ttlMs: 0 });
  const holder = new GenerationProviderHolder(
    resolver,
    spec => buildGenerationProvider(spec, sources, instantiate),
    () => ({ env: {}, settings: opts.file ?? {} }),
  );
  return { holder, calls, claude, ollama };
}

describe('GenerationProviderHolder failover wiring', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('holder builds Claude with an Ollama gemma4:12b fallback by default', async () => {
    const { holder, calls } = harness();
    const provider = await holder.current('t');
    expect(provider).toBeInstanceOf(FailoverGenerationProvider);
    expect(calls).toEqual([['claude', 'claude-haiku-5-5'], ['ollama', 'gemma4:12b']]);
  });

  it('holder builds plain Ollama when the provider is ollama', async () => {
    const { holder, calls, ollama } = harness({ file: { MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_SERVER_MODEL: 'qwen2.5:14b' } });
    expect(await holder.current('t')).toBe(ollama);
    expect(calls).toEqual([['ollama', 'qwen2.5:14b']]);
  });

  it('an Ollama install with no model set gets the Ollama default, not the Claude model id', async () => {
    const { holder, calls } = harness({ team: { provider: 'ollama' } });
    await holder.current('t');
    expect(calls).toEqual([['ollama', 'gemma4:12b']]);
  });

  it('an Ollama install with no generation model uses MEMSMITH_OLLAMA_MODEL', async () => {
    const { holder, calls } = harness({ file: { MEMSMITH_SERVER_PROVIDER: 'ollama', MEMSMITH_OLLAMA_MODEL: 'llama3.3:70b' } });
    await holder.current('t');
    expect(calls).toEqual([['ollama', 'llama3.3:70b']]);
  });

  it('holder builds plain Claude when fallback is none', async () => {
    const { holder, calls, claude } = harness({ file: { MEMSMITH_SERVER_FALLBACK: 'none' } });
    expect(await holder.current('t')).toBe(claude);
    expect(calls).toEqual([['claude', 'claude-haiku-5-5']]);
  });

  it('honors a configured fallback model', async () => {
    const { holder, calls } = harness({ file: { MEMSMITH_SERVER_FALLBACK_MODEL: 'qwen2.5:14b' } });
    await holder.current('t');
    expect(calls[1]).toEqual(['ollama', 'qwen2.5:14b']);
  });

  it('holder with no Anthropic key still returns a provider that generates through the fallback', async () => {
    const { holder, ollama } = harness({ claude: null });
    const provider = await holder.current('t');
    expect(provider).not.toBeNull();
    const result = await provider!.generate(context);
    expect(result.providerLabel).toBe('ollama');
    expect(ollama.calls).toBe(1);
  });

  it('holder keeps one instance (and its cooldown) while settings are unchanged', async () => {
    const { holder, calls, claude } = harness({ claude: stubProvider('claude', true) });
    const first = await holder.current('t');
    await first!.generate(context);
    const second = await holder.current('t');
    await second!.generate(context);

    expect(second).toBe(first);
    expect(calls).toHaveLength(2);
    expect(claude!.calls).toBe(1);
  });

  it('marks a team-chosen provider as explicit and a file one as not', async () => {
    const specs: Array<{ explicitProvider?: boolean }> = [];
    const store = (team: Record<string, unknown>) => ({ getTeamOverrides: async () => team, putTeamOverrides: async () => {} }) as never;
    for (const [team, file] of [[{ provider: 'claude' }, {}], [{}, { MEMSMITH_SERVER_PROVIDER: 'claude' }]] as const) {
      const resolver = new SettingsResolver(store(team), { fileSettings: () => file, ttlMs: 0 });
      await new GenerationProviderHolder(resolver, spec => { specs.push(spec); return null; }, () => ({ env: {}, settings: file })).current('t');
    }
    expect(specs.map(s => s.explicitProvider)).toEqual([true, false]);
  });

  it('rebuilds when the fallback setting changes', async () => {
    const team: Record<string, unknown> = {};
    const { holder, claude } = harness({ team });
    const before = await holder.current('t');
    team.fallback = 'none';
    const after = await holder.current('t');
    expect(before).toBeInstanceOf(FailoverGenerationProvider);
    expect(after).toBe(claude);
  });
});
