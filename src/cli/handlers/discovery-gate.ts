// src/cli/handlers/discovery-gate.ts
// SPDX-License-Identifier: Apache-2.0
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { getProjectContext } from '../../utils/project-name.js';
import { shouldGateTool, buildPreToolQuery } from './pre-tool-query.js';
import { fetchTeamMemory as realFetchTeamMemory } from '../../server/retrieval/team-inject-client.js';
import { buildInjectionBlock } from '../../server/retrieval/inject.js';

export interface DiscoveryGateDeps {
  fetchTeamMemory(input: { serverUrl: string; apiKey: string; projectId: string; teamId: string; query: string; limit?: number }): Promise<Array<{ id: string; content: string; metadata: Record<string, unknown> }>>;
}

export async function buildDiscoveryContext(
  deps: DiscoveryGateDeps,
  input: { toolName: string; toolInput: Record<string, unknown>; projectName: string; gateTools: string; serverUrl: string; apiKey: string },
): Promise<string> {
  try {
    if (!shouldGateTool(input.toolName, input.gateTools)) return '';
    if (!input.serverUrl.trim() || !input.apiKey.trim()) return '';
    const query = buildPreToolQuery(input.toolInput);
    if (!query) return '';
    const rows = await deps.fetchTeamMemory({ serverUrl: input.serverUrl, apiKey: input.apiKey, projectId: input.projectName, teamId: '', query, limit: 5 });
    return await buildInjectionBlock({ hybridSearch: async () => rows }, { projectId: input.projectName, teamId: '', query });
  } catch (error) {
    logger.warn('HOOK', 'discovery-gate injection failed; continuing', { error: error instanceof Error ? error.message : String(error) });
    return '';
  }
}

export const discoveryGateHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const empty: HookResult = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '' }, exitCode: HOOK_EXIT_CODES.SUCCESS };
    if (!input.toolName) return empty;
    const settings = loadFromFileOnce();
    const context = getProjectContext(input.cwd || process.cwd());
    const additionalContext = await buildDiscoveryContext(
      { fetchTeamMemory: realFetchTeamMemory },
      {
        toolName: input.toolName,
        toolInput: (input.toolInput as Record<string, unknown>) ?? {},
        projectName: context.primary,
        gateTools: settings.MEMSMITH_GATE_TOOLS ?? '',
        serverUrl: settings.MEMSMITH_TEAM_SERVER_URL ?? '',
        apiKey: settings.MEMSMITH_TEAM_API_KEY ?? '',
      },
    );
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } };
  },
};
