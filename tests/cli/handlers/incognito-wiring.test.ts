// tests/cli/handlers/incognito-wiring.test.ts
// SPDX-License-Identifier: Apache-2.0
//
// Integration-style wiring test: asserts that the session-init handler (the
// UserPromptSubmit entry point) correctly intercepts a "/incognito on" prompt,
// calls handleIncognitoCommand, flips isIncognito to true for the session, and
// surfaces a message containing "Incognito ON" via hookSpecificOutput.
import { describe, it, expect, beforeEach } from 'bun:test';
import { sessionInitHandler, setSessionInitDependenciesForTesting } from '../../../src/cli/handlers/session-init.js';
import { isIncognito, resetSession } from '../../../src/cli/incognito.js';

const SESSION = 'incognito-wiring-session';

// Provide a minimal dependency shim so session-init does not attempt any
// network / DB calls — only the incognito dispatch path is exercised.
function useFakeDeps() {
  setSessionInitDependenciesForTesting({
    resolveRuntimeContext: () => ({ runtime: 'local' as const, reason: 'server_context_unavailable' as const }),
    shouldTrackProject: () => true,
    logServerFallback: () => {},
  });
}

describe('session-init /incognito wiring', () => {
  beforeEach(() => {
    resetSession(SESSION);
    useFakeDeps();
  });

  it('"/incognito on" flips isIncognito to true and surfaces "Incognito ON" in hookSpecificOutput', async () => {
    const result = await sessionInitHandler.execute({
      sessionId: SESSION,
      cwd: '/tmp/incognito-wiring-test',
      platform: 'claude-code',
      prompt: '/incognito on',
    });

    // The session must now be flagged incognito
    expect(isIncognito(SESSION)).toBe(true);

    // The result must surface the confirmation message
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toContain('Incognito ON');
  });

  it('"/incognito off" flips isIncognito to false and surfaces "Incognito OFF"', async () => {
    // Start incognito ON
    const { setIncognito } = await import('../../../src/cli/incognito.js');
    setIncognito(SESSION, true);

    const result = await sessionInitHandler.execute({
      sessionId: SESSION,
      cwd: '/tmp/incognito-wiring-test',
      platform: 'claude-code',
      prompt: '/incognito off',
    });

    expect(isIncognito(SESSION)).toBe(false);
    expect(result.hookSpecificOutput?.additionalContext).toContain('Incognito OFF');
  });

  it('bare "/incognito" toggles state', async () => {
    // Initially OFF → toggle ON
    const result = await sessionInitHandler.execute({
      sessionId: SESSION,
      cwd: '/tmp/incognito-wiring-test',
      platform: 'claude-code',
      prompt: '/incognito',
    });

    expect(isIncognito(SESSION)).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toContain('Incognito ON');
  });
});
