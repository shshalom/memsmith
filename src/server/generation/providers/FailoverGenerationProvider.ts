// SPDX-License-Identifier: Apache-2.0

import { logger } from '../../../utils/logger.js';
import { ServerClassifiedProviderError } from './shared/error-classification.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

export const FAILOVER_COOLDOWN_MS = 300_000;

export class FailoverGenerationProvider implements ServerGenerationProvider {
  readonly providerLabel: ServerGenerationProvider['providerLabel'];
  private readonly primary: ServerGenerationProvider | null;
  private readonly fallback: ServerGenerationProvider;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private cooldownUntil = 0;

  constructor(opts: {
    primary: ServerGenerationProvider | null;
    fallback: ServerGenerationProvider;
    cooldownMs?: number;
    now?: () => number;
  }) {
    this.primary = opts.primary;
    this.fallback = opts.fallback;
    this.cooldownMs = opts.cooldownMs ?? FAILOVER_COOLDOWN_MS;
    this.now = opts.now ?? Date.now;
    this.providerLabel = (opts.primary ?? opts.fallback).providerLabel;
  }

  get hasPrimary(): boolean {
    return this.primary !== null;
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
    opts?: { reformatReason?: string },
  ): Promise<ServerGenerationResult> {
    const primary = this.primary;
    if (!primary) return this.fallback.generate(context, signal, opts);

    if (this.now() < this.cooldownUntil) {
      try {
        return await this.fallback.generate(context, signal, opts);
      } catch (fallbackErr) {
        if (signal?.aborted) throw fallbackErr;
        return primary.generate(context, signal, opts);
      }
    }

    try {
      return await primary.generate(context, signal, opts);
    } catch (primaryErr) {
      if (signal?.aborted) throw primaryErr;
      let result: ServerGenerationResult;
      try {
        result = await this.fallback.generate(context, signal, opts);
      } catch {
        throw primaryErr;
      }
      this.cooldownUntil = this.now() + this.cooldownMs;
      logger.warn('SYSTEM', 'Primary generation provider failed; using fallback during cooldown', {
        primary: primary.providerLabel,
        fallback: this.fallback.providerLabel,
        errorKind: primaryErr instanceof ServerClassifiedProviderError ? primaryErr.kind : 'unclassified',
        cooldownMs: this.cooldownMs,
      }, primaryErr);
      return result;
    }
  }
}
