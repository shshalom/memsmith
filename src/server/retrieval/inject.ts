// SPDX-License-Identifier: Apache-2.0
import { positionForInjection } from './positioning.js';

export interface InjectDeps {
  hybridSearch(input: { projectId: string; teamId: string; query: string; limit?: number }): Promise<Array<{ content: string; metadata: Record<string, unknown> }>>;
}

export async function buildInjectionBlock(
  deps: InjectDeps,
  input: { projectId: string; teamId: string; query: string; maxItems?: number }
): Promise<string> {
  const rows = await deps.hybridSearch({ ...input, limit: (input.maxItems ?? 5) * 2 });
  const visible = rows.filter(r => r.metadata?.private !== true).map(r => r.content);
  const body = positionForInjection(visible, input.maxItems ?? 5);
  if (!body) return '';
  return `## Relevant team memory (review before acting)\n${body}`;
}
