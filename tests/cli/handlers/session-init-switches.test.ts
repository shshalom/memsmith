import { afterEach, describe, expect, it } from 'bun:test';
import { sessionInitHandler, setSessionInitDependenciesForTesting } from '../../../src/cli/handlers/session-init.js';
import { isIncognito, resetSession, setIncognito } from '../../../src/cli/incognito.js';
import { resetFeatureSwitchesForTesting } from '../../../src/shared/feature-switches.js';

const saved = {
  access: process.env.MEMSMITH_ACCESS,
  disabled: process.env.MEMSMITH_HOOKS_DISABLED,
  turns: process.env.MEMSMITH_INCOGNITO_REMINDER_TURNS,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

afterEach(() => {
  restore('MEMSMITH_ACCESS', saved.access);
  restore('MEMSMITH_HOOKS_DISABLED', saved.disabled);
  restore('MEMSMITH_INCOGNITO_REMINDER_TURNS', saved.turns);
  resetFeatureSwitchesForTesting();
  setSessionInitDependenciesForTesting({});
});

function harness(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  resetFeatureSwitchesForTesting();
  const calls = { claims: 0, mints: 0, starts: 0 };
  setSessionInitDependenciesForTesting({
    shouldTrackProject: () => true,
    logServerFallback: () => {},
    mintProjectIdentity: async () => { calls.mints++; return null; },
    projectNotice: async () => null,
    claimPendingJoin: async () => { calls.claims++; },
    resolveRuntimeContext: () => ({
      runtime: 'server',
      projectId: 'p1',
      serverBaseUrl: 'http://fake',
      client: { startSession: async () => { calls.starts++; return { session: { id: 'srv' } }; } },
    }) as never,
  });
  return calls;
}

const run = (sessionId: string, prompt: string) =>
  sessionInitHandler.execute({ sessionId, cwd: '/tmp/ms-si-switches', platform: 'claude-code', prompt });

describe('session-init with capture turned off', () => {
  it('still handles /incognito', async () => {
    resetSession('si-capture-off-1');
    harness({ MEMSMITH_HOOKS_DISABLED: 'capture' });
    const res = await run('si-capture-off-1', '/incognito on');
    expect(isIncognito('si-capture-off-1')).toBe(true);
    expect(res.hookSpecificOutput?.additionalContext).toContain('Incognito ON');
  });

  it('still shows the incognito heartbeat', async () => {
    resetSession('si-capture-off-2');
    setIncognito('si-capture-off-2', true);
    harness({ MEMSMITH_HOOKS_DISABLED: 'capture', MEMSMITH_INCOGNITO_REMINDER_TURNS: '1' });
    const res = await run('si-capture-off-2', 'list the files');
    expect(res.hookSpecificOutput?.additionalContext).toContain('still incognito');
  });

  it('still creates the project and claims a pending team join, but starts no session', async () => {
    const calls = harness({ MEMSMITH_HOOKS_DISABLED: 'capture' });
    await run('si-capture-off-3', 'list the files');
    expect(calls.mints).toBe(1);
    expect(calls.claims).toBe(1);
    expect(calls.starts).toBe(0);
  });

  it('starts the session when capture is on', async () => {
    const calls = harness({});
    await run('si-capture-on', 'list the files');
    expect(calls.starts).toBe(1);
    expect(calls.claims).toBe(1);
  });
});

describe('session-init with read access', () => {
  it('neither mints, claims a team join, nor starts a session', async () => {
    const calls = harness({ MEMSMITH_ACCESS: 'read' });
    await run('si-read', 'list the files');
    expect(calls).toEqual({ claims: 0, mints: 0, starts: 0 });
  });
});
