// SPDX-License-Identifier: Apache-2.0
import type { SettingsResolver } from '../settings/SettingsResolver.js';
import { buildGenerationProvider } from '../runtime/create-server-service.js';
import type { GenerationProviderSpec, ServerGenerationProvider } from '../runtime/create-server-service.js';
import { DEFAULT_GENERATION_PROVIDER } from '../runtime/resolve-generation-provider.js';
import { logger } from '../../utils/logger.js';

type Build = (spec: GenerationProviderSpec) => ServerGenerationProvider | null;

export class GenerationProviderHolder {
  private cacheKey: string | null = null;
  private instance: ServerGenerationProvider | null = null;

  constructor(
    private readonly resolver: SettingsResolver,
    private readonly build: Build = buildGenerationProvider,
  ) {}

  private async resolveSpec(teamId: string): Promise<GenerationProviderSpec> {
    const provider = await this.resolver.provider(teamId);
    const model = await this.resolver.resolve(teamId, 'model');
    return {
      provider,
      // The registry's default model is a Claude model id; any other provider
      // falls back to its own default model instead.
      ...(model.source !== 'default' || provider === DEFAULT_GENERATION_PROVIDER
        ? { model: String(model.value) }
        : {}),
      fallback: await this.resolver.fallback(teamId),
      fallbackModel: await this.resolver.fallbackModel(teamId),
    };
  }

  async current(teamId: string): Promise<ServerGenerationProvider | null> {
    const spec = await this.resolveSpec(teamId);
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
      // Keep last-good so a bad switch does not break generation entirely.
      logger.warn('SYSTEM', 'provider holder: build returned null; keeping last-good', { ...spec });
      return this.instance;
    }
    this.cacheKey = key;
    this.instance = built;
    return built;
  }
}
