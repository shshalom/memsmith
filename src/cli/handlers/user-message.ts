
import { basename } from 'path';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { getWorkerPort } from '../../shared/worker-utils.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { logger } from '../../utils/logger.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';

// UserPromptSubmit banner budget — recent project context (not query-driven).
const USER_MESSAGE_RECENT_LIMIT = 10;

// C1 (worker retirement) — the worker route `/api/context/inject` that fed this
// banner was deleted. Pull recent project context off the SAME server/local
// runtime the capture handlers use (empty-query "list recent" via /v1/search),
// packed the same way POST /v1/context packs its context string. Graceful-empty:
// returns '' on no runtime / no observations / any error — never throws.
async function fetchUserMessageContext(
  project: string,
  platformSource: string | undefined,
): Promise<string> {
  const runtime = resolveRuntimeContext();
  if (runtime.runtime !== 'server') return '';
  try {
    const response = await runtime.client.searchObservations({
      projectId: project,
      query: '',
      limit: USER_MESSAGE_RECENT_LIMIT,
      ...(platformSource !== undefined ? { platformSource } : {}),
    });
    const observations = Array.isArray(response?.observations) ? response.observations : [];
    return observations
      .map(observation => observation.content)
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
      .join('\n\n');
  } catch (error: unknown) {
    logger.warn('HOOK', 'user-message context injection failed; continuing without it', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

export const userMessageHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const port = getWorkerPort();
    const project = basename(input.cwd ?? process.cwd());
    const platformSource = input.platform
      ? normalizePlatformSource(input.platform)
      : undefined;

    const output = await fetchUserMessageContext(project, platformSource);
    if (!output) {
      return { exitCode: HOOK_EXIT_CODES.SUCCESS };
    }
    // IO discipline: the banner is a USER_HINT. Return it via systemMessage so
    // the platform adapter routes it (claude-code surfaces it inline, exactly
    // like the old stderr write, but inside the HookResult contract). This
    // handler MUST stay pure — no process.stderr.write / console.* / process.exit.
    const bannerText =
      "\n\n" + String.fromCodePoint(0x1F4DD) + " MemSmith Context Loaded\n\n" +
      output +
      "\n\n" + String.fromCodePoint(0x1F4A1) + " Wrap any message with <private> ... </private> to prevent storing sensitive information.\n" +
      "\n" + String.fromCodePoint(0x1F4AC) + " Community https://discord.gg/J4wttp9vDu" +
      `\n` + String.fromCodePoint(0x1F4FA) + ` Watch live in browser http://localhost:${port}/\n`;

    return { exitCode: HOOK_EXIT_CODES.SUCCESS, systemMessage: bannerText };
  },
};
