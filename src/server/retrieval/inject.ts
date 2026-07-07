// SPDX-License-Identifier: Apache-2.0
import { positionForInjection } from './positioning.js';
import { tierToBudget, type TierInput } from './tiering.js';

export interface InjectDeps {
  hybridSearch(input: { projectId: string; teamId: string; query: string; limit?: number }): Promise<Array<{ content: string; metadata: Record<string, unknown> }>>;
}

function tieringEnabled(): boolean {
  const v = process.env.CLAUDE_MEM_TIERING;
  return v !== '0' && v !== 'off';
}

export async function buildInjectionBlock(
  deps: InjectDeps,
  input: { projectId: string; teamId: string; query: string; maxItems?: number; maxChars?: number }
): Promise<string> {
  const maxItems = input.maxItems ?? 5;
  const maxChars = input.maxChars ?? 10000;
  const rows = await deps.hybridSearch({ projectId: input.projectId, teamId: input.teamId, query: input.query, limit: maxItems * 2 });
  const visible: TierInput[] = rows.filter(r => r.metadata?.private !== true);
  if (visible.length === 0) return '';
  const header = '## Relevant team memory (review before acting)\n';
  // Reserve budget for the header + positioning bullet markers.
  const bodyBudget = Math.max(0, maxChars - header.length);

  if (tieringEnabled()) {
    try {
      const rendered = tierToBudget(visible, { maxChars: bodyBudget, maxItems });
      const body = positionForInjection(rendered, maxItems);
      if (body) return (header + body).slice(0, maxChars);
      // fall through to legacy on empty body
    } catch {
      // fall through to legacy whole-item behavior on any tiering error
    }
  }

  // Legacy whole-item-drop behavior (also the CLAUDE_MEM_TIERING=0 path).
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
