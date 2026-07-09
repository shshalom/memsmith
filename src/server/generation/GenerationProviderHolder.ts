// SPDX-License-Identifier: Apache-2.0
import type { SettingsResolver } from '../settings/SettingsResolver.js';
import { instantiateServerGenerationProvider } from '../runtime/create-server-service.js';
import type { ServerGenerationProvider } from '../runtime/create-server-service.js';
import { logger } from '../../utils/logger.js';

type Instantiate = (provider: string, model?: string) => ServerGenerationProvider | null;

export class GenerationProviderHolder {
  private cacheKey: string | null = null;
  private instance: ServerGenerationProvider | null = null;

  constructor(
    private readonly resolver: SettingsResolver,
    private readonly instantiate: Instantiate = instantiateServerGenerationProvider,
  ) {}

  async current(teamId: string): Promise<ServerGenerationProvider | null> {
    const provider = await this.resolver.provider(teamId);
    const model = await this.resolver.model(teamId);
    const key = `${provider}::${model}`;
    if (key === this.cacheKey && this.instance) return this.instance;
    let built: ServerGenerationProvider | null = null;
    try {
      built = this.instantiate(provider, model);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('SYSTEM', 'provider holder: instantiation threw; keeping last-good', { provider, model }, err);
      built = null;
    }
    if (!built) {
      // Keep last-good so a bad switch does not break generation entirely.
      logger.warn('SYSTEM', 'provider holder: build returned null; keeping last-good', { provider, model });
      return this.instance;
    }
    this.cacheKey = key;
    this.instance = built;
    return built;
  }
}
