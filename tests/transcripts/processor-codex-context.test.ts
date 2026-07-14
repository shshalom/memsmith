import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import * as realSessionInit from '../../src/cli/handlers/session-init.js';
import * as realRecentInjection from '../../src/services/hooks/recent-context-injection.js';
import * as realAgentsMdUtils from '../../src/utils/agents-md-utils.js';
import * as realProjectName from '../../src/utils/project-name.js';

const realSessionInitSnapshot = { ...realSessionInit };
const realRecentInjectionSnapshot = { ...realRecentInjection };
const realAgentsMdUtilsSnapshot = { ...realAgentsMdUtils };
const realProjectNameSnapshot = { ...realProjectName };

afterAll(() => {
  mock.module('../../src/cli/handlers/session-init.js', () => realSessionInitSnapshot);
  mock.module('../../src/services/hooks/recent-context-injection.js', () => realRecentInjectionSnapshot);
  mock.module('../../src/utils/agents-md-utils.js', () => realAgentsMdUtilsSnapshot);
  mock.module('../../src/utils/project-name.js', () => realProjectNameSnapshot);
});

mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: {
    execute: async () => ({
      continue: true,
      suppressOutput: true,
    }),
  },
}));

// Worker retirement — the AGENTS.md context is now pulled via the shared
// recent-mode injection helper (server/local runtime + empty-query /v1/search)
// instead of the deleted worker route `/api/context/inject`. Capture the
// project id it was asked for and the string it returned.
const recentInjectionCalls: Array<{ projectId: string; platformSource?: string }> = [];
let recentInjectionResult = 'injected-context';

mock.module('../../src/services/hooks/recent-context-injection.js', () => ({
  fetchRecentContextString: async (args: { projectId: string; platformSource?: string }) => {
    recentInjectionCalls.push({ projectId: args.projectId, platformSource: args.platformSource });
    return recentInjectionResult;
  },
}));

const writeAgentsCalls: Array<{ agentsPath: string; content: string }> = [];

mock.module('../../src/utils/agents-md-utils.js', () => ({
  writeAgentsMd: (agentsPath: string, context: string) => {
    writeAgentsCalls.push({ agentsPath, content: context });
  },
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'repo-project',
    parent: null,
    isWorktree: false,
    allProjects: ['repo-project'],
  }),
}));

const schema: TranscriptSchema = {
  name: 'codex',
  events: [
    {
      name: 'user-message',
      match: { path: 'payload.type', equals: 'user_message' },
      action: 'session_init',
      fields: {
        sessionId: 'payload.session_id',
        cwd: 'payload.cwd',
        prompt: 'payload.prompt',
      },
    },
  ],
};

const makeWatch = (overrides: Partial<WatchTarget>): WatchTarget => ({
  name: 'codex',
  path: join(tmpdir(), 'transcripts', '**', '*.jsonl'),
  schema: 'codex',
  context: {
    mode: 'agents',
    updateOn: ['session_start'],
  },
  ...overrides,
});

const sessionPayload = (cwd: string) => ({
  type: 'event',
  payload: {
    type: 'user_message',
    session_id: 'session-codex-1',
    cwd,
    prompt: 'Hi',
  },
});

describe('TranscriptEventProcessor AGENTS context', () => {
  let processor: TranscriptEventProcessor;

  beforeEach(() => {
    processor = new TranscriptEventProcessor();
    recentInjectionCalls.length = 0;
    writeAgentsCalls.length = 0;
    recentInjectionResult = 'injected-context';
  });

  afterEach(() => {
    recentInjectionCalls.length = 0;
    writeAgentsCalls.length = 0;
    mock.restore();
  });

  it('suppresses AGENTS writes for native-hook-backed Codex transcript watches', async () => {
    const cwd = join(tmpdir(), 'native-codex-context');
    const watch = makeWatch({
      name: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
    });

    await processor.processEntry(sessionPayload(cwd), watch, schema);

    expect(writeAgentsCalls).toHaveLength(0);
    expect(recentInjectionCalls).toHaveLength(0);
  });

  it('writes AGENTS context from recent-mode injection for non-native Codex transcript watches', async () => {
    const cwd = join(tmpdir(), 'non-native-codex-context');
    const agentsPath = join(cwd, 'AGENTS.md');
    const watch = makeWatch({
      name: 'codex-legacy',
      path: join(tmpdir(), 'codex-export', '**', '*.jsonl'),
      context: {
        mode: 'agents',
        path: agentsPath,
        updateOn: ['session_start'],
      },
    });

    await processor.processEntry(sessionPayload(cwd), watch, schema);

    expect(writeAgentsCalls).toHaveLength(1);
    expect(writeAgentsCalls[0].agentsPath).toBe(agentsPath);
    // Repointed off the worker: recent-mode injection is queried for the
    // resolved project scope and its packed string is written verbatim.
    expect(recentInjectionCalls).toHaveLength(1);
    expect(recentInjectionCalls[0].projectId).toBe('repo-project');
    expect(recentInjectionCalls[0].platformSource).toBe('codex');
    expect(writeAgentsCalls[0].content).toBe('injected-context');
  });

  it('cleanly skips the AGENTS write when recent-mode injection returns empty', async () => {
    const cwd = join(tmpdir(), 'empty-codex-context');
    const agentsPath = join(cwd, 'AGENTS.md');
    const watch = makeWatch({
      name: 'codex-legacy',
      path: join(tmpdir(), 'codex-export', '**', '*.jsonl'),
      context: {
        mode: 'agents',
        path: agentsPath,
        updateOn: ['session_start'],
      },
    });

    recentInjectionResult = '';

    await processor.processEntry(sessionPayload(cwd), watch, schema);

    // Injection was attempted but produced nothing — never write an empty file.
    expect(recentInjectionCalls).toHaveLength(1);
    expect(writeAgentsCalls).toHaveLength(0);
  });
});
