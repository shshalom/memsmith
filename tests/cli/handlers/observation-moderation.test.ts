import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { resetSession, setIncognito } from '../../../src/cli/incognito.js';

// The handler resolves runtime + a client with recordEvent. We capture calls.
const recorded: unknown[] = [];

// NOTE: brief shows mock path as '../../../src/cli/project-tracking.js' but the
// real import in observation.ts is from '../../shared/should-track-project.js'.
// Using the correct path here so the mock actually intercepts.
mock.module('../../../src/shared/should-track-project.js', () => ({
  shouldTrackProject: () => true,
}));

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  resolveRuntimeContext: () => ({
    runtime: 'server',
    projectId: 'p1',
    client: { recordEvent: async (e: unknown) => { recorded.push(e); } },
  }),
  logServerFallback: () => {},
}));

import { observationHandler } from '../../../src/cli/handlers/observation.js';

const S = 'obs-moderation-session';
function input(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: S, cwd: '/tmp/proj', toolName: 'Bash',
    toolInput: { command: 'echo <private>SECRET</private> hi' },
    toolResponse: 'done <private>LEAK</private>',
    platform: 'claude', agentId: undefined, agentType: undefined,
    ...overrides,
  } as never;
}

describe('observation handler moderation', () => {
  beforeEach(() => { recorded.length = 0; resetSession(S); });

  it('strips <private> from the emitted event payload', async () => {
    await observationHandler.execute(input());
    expect(recorded).toHaveLength(1);
    const json = JSON.stringify(recorded[0]);
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('LEAK');
    expect(json).toContain('echo');
  });

  it('emits nothing when incognito is ON', async () => {
    setIncognito(S, true);
    await observationHandler.execute(input());
    expect(recorded).toHaveLength(0);
  });
});
