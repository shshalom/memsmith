// SPDX-License-Identifier: Apache-2.0
import { positionForInjection } from './positioning.js';

export interface InjectDeps {
  hybridSearch(input: { projectId: string; teamId: string; query: string; limit?: number }): Promise<Array<{ content: string; metadata: Record<string, unknown> }>>;
}

export async function buildInjectionBlock(
  deps: InjectDeps,
  input: { projectId: string; teamId: string; query: string; maxItems?: number; maxChars?: number }
): Promise<string> {
  const maxItems = input.maxItems ?? 5;
  const maxChars = input.maxChars ?? 10000;
  const rows = await deps.hybridSearch({ projectId: input.projectId, teamId: input.teamId, query: input.query, limit: maxItems * 2 });
  const visible = rows.filter(r => r.metadata?.private !== true).map(r => r.content);
  const header = '## Relevant team memory (review before acting)\n';
  for (let n = Math.min(visible.length, maxItems); n >= 1; n--) {
    const body = positionForInjection(visible.slice(0, n), maxItems);
    if (!body) continue;
    const block = header + body;
    if (block.length <= maxChars) return block;
  }
  // nothing fit whole; if there is any content, hard-cap the single-item block
  const body = positionForInjection(visible.slice(0, 1), maxItems);
  if (!body) return '';
  return (header + body).slice(0, maxChars);
}
