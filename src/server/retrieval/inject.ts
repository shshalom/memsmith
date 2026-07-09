// SPDX-License-Identifier: Apache-2.0
import { positionForInjection } from './positioning.js';
import { tierToBudget, type TierInput } from './tiering.js';
import type { SettingsResolver } from '../settings/SettingsResolver.js';
import { buildCompressionEvent } from './compressionMetering.js';
import type { PostgresUsageRepository } from '../../storage/postgres/usage.js';

export interface InjectDeps {
  hybridSearch(input: { projectId: string; teamId: string; query: string; limit?: number }): Promise<Array<{ content: string; metadata: Record<string, unknown> }>>;
}

function tieringEnabledEnv(): boolean {
  const v = process.env.MEMSMITH_TIERING;
  return v !== '0' && v !== 'off';
}

export async function buildInjectionBlock(
  deps: InjectDeps,
  input: { projectId: string; teamId: string; query: string; maxItems?: number; maxChars?: number; resolver?: SettingsResolver; usage?: PostgresUsageRepository }
): Promise<string> {
  const maxItems = input.maxItems ?? 5;
  const maxChars = input.maxChars ?? 10000;
  const rows = await deps.hybridSearch({ projectId: input.projectId, teamId: input.teamId, query: input.query, limit: maxItems * 2 });
  const visible: TierInput[] = rows.filter(r => r.metadata?.private !== true);
  if (visible.length === 0) return '';
  const header = '## Relevant team memory (review before acting)\n';
  // Reserve the header from the body budget. Positioning adds ~2 chars/item of
  // bullet markers on top, so the pre-slice block can run slightly over; the
  // final .slice(0, maxChars) below is the hard cap that guarantees the limit.
  const bodyBudget = Math.max(0, maxChars - header.length);

  const tiering = input.resolver ? await input.resolver.tieringEnabled(input.teamId) : tieringEnabledEnv();
  if (tiering) {
    try {
      const rendered = tierToBudget(visible, { maxChars: bodyBudget, maxItems });
      if (input.usage && process.env.MEMSMITH_USAGE_METERING === '1') {
        try {
          for (let i = 0; i < rendered.length; i++) {
            const preChars = (visible[i]?.content ?? '').length;
            const postChars = rendered[i].length;
            if (preChars > postChars) {
              const ev = buildCompressionEvent(input.teamId, input.projectId ?? null, preChars, postChars, 'tiered');
              await input.usage.record(ev);
            }
          }
        } catch { /* metering must never break injection */ }
      }
      const body = positionForInjection(rendered, maxItems);
      if (body) return (header + body).slice(0, maxChars);
      // fall through to legacy on empty body
    } catch {
      // fall through to legacy whole-item behavior on any tiering error
    }
  }

  // Legacy whole-item-drop behavior (also the MEMSMITH_TIERING=0 path).
  const contents = visible.map(r => r.content);
  for (let n = Math.min(contents.length, maxItems); n >= 1; n--) {
    const body = positionForInjection(contents.slice(0, n), maxItems);
    if (!body) continue;
    const block = header + body;
    if (block.length <= maxChars) return block;
  }
  const body = positionForInjection(contents.slice(0, 1), maxItems);
  if (!body) return '';
  return (header + body).slice(0, maxChars);
}
