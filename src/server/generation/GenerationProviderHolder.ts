// SPDX-License-Identifier: Apache-2.0
import type { SettingsResolver } from '../settings/SettingsResolver.js';
import { buildGenerationProvider } from '../runtime/create-server-service.js';
import type { GenerationProviderSpec, ServerGenerationProvider } from '../runtime/create-server-service.js';
import { DEFAULT_GENERATION_PROVIDER, explicitModel, resolveOllamaModel } from '../runtime/resolve-generation-provider.js';
import { loadGenerationConfigSources } from '../runtime/generation-credentials.js';
import { logger } from '../../utils/logger.js';

type Build = (spec: GenerationProviderSpec) => ServerGenerationProvider | null;
type ModelSources = () => { env: Record<string, string | undefined>; settings: Record<string, unknown> };

/**
 * Keeps one built provider per resolved spec, so a FailoverGenerationProvider
 * keeps its cooldown across jobs, and keeps the last good provider when a
 * rebuild fails.
 */
export class GenerationProviderCache {
  private cacheKey: string | null = null;
  private instance: ServerGenerationProvider | null = null;

  constructor(private readonly build: Build = buildGenerationProvider) {}

  get(spec: GenerationProviderSpec): ServerGenerationProvider | null {
    const key = [spec.provider, spec.model ?? '', spec.fallback, spec.fallbackModel].join('::');
    if (key === this.cacheKey && this.instance) return this.instance;
    let built: ServerGenerationProvider | null = null;
    try {
      built = this.build(spec);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('SYSTEM', 'provider holder: instantiation threw; keeping last-good', { ...spec }, err);
      built = null;
    }
    if (!built) {
      logger.warn('SYSTEM', 'provider holder: build returned null; keeping last-good', { ...spec });
      return this.instance;
    }
    this.cacheKey = key;
    this.instance = built;
    return built;
  }
}

export class GenerationProviderHolder {
  private readonly cache: GenerationProviderCache;

  constructor(
    private readonly resolver: SettingsResolver,
    build: Build = buildGenerationProvider,
    private readonly modelSources: ModelSources = loadGenerationConfigSources,
  ) {
    this.cache = new GenerationProviderCache(build);
  }

  private async resolveSpec(teamId: string): Promise<GenerationProviderSpec> {
    const provider = await this.resolver.provider(teamId);
    const resolvedModel = await this.resolver.resolve(teamId, 'model');
    const explicit = explicitModel(resolvedModel);
    let model: string | undefined;
    if (provider === 'ollama') {
      const { env, settings } = this.modelSources();
      model = resolveOllamaModel(env, settings, explicit);
    } else {
      // The registry's default model is a Claude model id; any other provider
      // falls back to its own default model instead.
      model = explicit ?? (provider === DEFAULT_GENERATION_PROVIDER ? String(resolvedModel.value) : undefined);
    }
    return {
      provider,
      ...(model ? { model } : {}),
      fallback: await this.resolver.fallback(teamId),
      fallbackModel: await this.resolver.fallbackModel(teamId),
    };
  }

  async current(teamId: string): Promise<ServerGenerationProvider | null> {
    return this.cache.get(await this.resolveSpec(teamId));
  }
}
