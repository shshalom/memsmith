// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { OllamaProvider, isOllamaAvailable, isOllamaSelected, classifyOllamaError } from '../src/services/worker/OllamaProvider';
import { DatabaseManager } from '../src/services/worker/DatabaseManager';
import { SessionManager } from '../src/services/worker/SessionManager';
import { ModeManager } from '../src/services/domain/ModeManager';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager';

const mockMode = {
  name: 'code',
  prompts: {
    init: 'init prompt',
    observation: 'obs prompt',
    summary: 'summary prompt'
  },
  observation_types: [{ id: 'discovery' }, { id: 'bugfix' }],
  observation_concepts: []
};

let loadFromFileSpy: ReturnType<typeof spyOn>;
let modeManagerSpy: ReturnType<typeof spyOn>;

function mockOllamaConfig() {
  loadFromFileSpy.mockImplementation(() => ({
    ...SettingsDefaultsManager.getAllDefaults(),
    MEMSMITH_PROVIDER: 'ollama',
    MEMSMITH_OLLAMA_URL: 'http://localhost:11434/v1',
    MEMSMITH_OLLAMA_MODEL: 'qwen2.5:14b',
  }));
}

function mockSuccessfulOllamaFetch(content = 'response text') {
  global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
    model: 'qwen2.5:14b',
    choices: [{ message: { role: 'assistant', content } }],
  }))));
}

describe('OllamaProvider', () => {
  let agent: OllamaProvider;
  let originalFetch: typeof global.fetch;

  let mockStoreObservation: any;
  let mockStoreObservations: any;
  let mockStoreSummary: any;
  let mockMarkSessionCompleted: any;
  let mockSyncObservation: any;
  let mockSyncSummary: any;
  let mockMarkProcessed: any;
  let mockCleanupProcessed: any;
  let mockResetStuckMessages: any;
  let mockDbManager: DatabaseManager;
  let mockSessionManager: SessionManager;

  beforeEach(() => {
    modeManagerSpy = spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => mockMode,
      loadMode: () => {},
    } as any));

    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      MEMSMITH_PROVIDER: 'ollama',
      MEMSMITH_OLLAMA_URL: 'http://localhost:11434/v1',
      MEMSMITH_OLLAMA_MODEL: 'qwen2.5:14b',
    }));

    mockStoreObservation = mock(() => ({ id: 1, createdAtEpoch: Date.now() }));
    mockStoreSummary = mock(() => ({ id: 1, createdAtEpoch: Date.now() }));
    mockMarkSessionCompleted = mock(() => {});
    mockSyncObservation = mock(() => Promise.resolve());
    mockSyncSummary = mock(() => Promise.resolve());
    mockMarkProcessed = mock(() => {});
    mockCleanupProcessed = mock(() => 0);
    mockResetStuckMessages = mock(() => 0);

    mockStoreObservations = mock(() => ({
      observationIds: [1],
      summaryId: 1,
      createdAtEpoch: Date.now()
    }));

    const mockSessionStore = {
      storeObservation: mockStoreObservation,
      storeObservations: mockStoreObservations,
      storeSummary: mockStoreSummary,
      markSessionCompleted: mockMarkSessionCompleted,
      getSessionById: mock(() => ({ memory_session_id: 'mem-session-123' })),
      ensureMemorySessionIdRegistered: mock(() => {}),
      updateMemorySessionId: mock(() => {}),
    };

    const mockChromaSync = {
      syncObservation: mockSyncObservation,
      syncSummary: mockSyncSummary
    };

    mockDbManager = {
      getSessionStore: () => mockSessionStore,
      getChromaSync: () => mockChromaSync
    } as unknown as DatabaseManager;

    const mockPendingMessageStore = {
      markProcessed: mockMarkProcessed,
      confirmProcessed: mock(() => {}),
      cleanupProcessed: mockCleanupProcessed,
      resetStuckMessages: mockResetStuckMessages
    };

    mockSessionManager = {
      getMessageIterator: async function* () { yield* []; },
      confirmClaimedMessages: mock(() => Promise.resolve(0)),
      resetProcessingToPending: mock(() => Promise.resolve(0)),
      getMessageBuffer: () => mockPendingMessageStore,
    } as unknown as SessionManager;

    agent = new OllamaProvider(mockDbManager, mockSessionManager);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (modeManagerSpy) modeManagerSpy.mockRestore();
    if (loadFromFileSpy) loadFromFileSpy.mockRestore();
    mock.restore();
  });

  it('isOllamaAvailable always returns true (keyless)', () => {
    expect(isOllamaAvailable()).toBe(true);
  });

  it('isOllamaSelected returns true when MEMSMITH_PROVIDER is ollama', () => {
    expect(isOllamaSelected()).toBe(true);
  });

  it('isOllamaSelected returns false when provider is not ollama', () => {
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      MEMSMITH_PROVIDER: 'claude',
    }));
    expect(isOllamaSelected()).toBe(false);
  });

  it('posts to the correct Ollama chat completions URL', async () => {
    const session = {
      sessionDbId: 1,
      contentSessionId: 'test-session',
      memorySessionId: 'mem-session-123',
      project: 'test-project',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      abortController: new AbortController(),
      generatorPromise: null,
      currentProvider: null,
      startTime: Date.now(),
    } as any;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      model: 'qwen2.5:14b',
      choices: [{ message: { role: 'assistant', content: '<observation><type>discovery</type><title>Test</title></observation>' } }],
    }))));

    await agent.startSession(session);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as any).mock.calls[0][0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('resolves apiUrl with /chat/completions appended when base URL provided', async () => {
    // When MEMSMITH_OLLAMA_URL ends without /chat/completions, provider appends it
    loadFromFileSpy.mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      MEMSMITH_PROVIDER: 'ollama',
      MEMSMITH_OLLAMA_URL: 'http://localhost:11434/v1',
      MEMSMITH_OLLAMA_MODEL: 'qwen2.5:14b',
    }));

    const session = {
      sessionDbId: 2,
      contentSessionId: 'test-session-2',
      memorySessionId: null,
      project: 'test-project',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      abortController: new AbortController(),
      generatorPromise: null,
      currentProvider: null,
      startTime: Date.now(),
    } as any;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      model: 'qwen2.5:14b',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    }))));

    await agent.startSession(session);

    const url = (global.fetch as any).mock.calls[0][0];
    expect(url).toContain('/chat/completions');
    expect(url).not.toMatch(/\/chat\/completions\/chat\/completions/);
  });

  it('does not send Authorization header (keyless)', async () => {
    const session = {
      sessionDbId: 3,
      contentSessionId: 'test-session-3',
      memorySessionId: null,
      project: 'test-project',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      abortController: new AbortController(),
      generatorPromise: null,
      currentProvider: null,
      startTime: Date.now(),
    } as any;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      model: 'qwen2.5:14b',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    }))));

    await agent.startSession(session);

    const requestInit = (global.fetch as any).mock.calls[0][1];
    const headers = requestInit?.headers ?? {};
    // The Authorization header should NOT be present (keyless provider)
    const authHeader = typeof headers.get === 'function'
      ? headers.get('Authorization')
      : headers['Authorization'];
    expect(authHeader).toBeFalsy();
  });

  it('parses choices[0].message.content from OpenAI-compatible response', async () => {
    const session = {
      sessionDbId: 4,
      contentSessionId: 'test-session-4',
      memorySessionId: 'mem-session-123',
      project: 'test-project',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      abortController: new AbortController(),
      generatorPromise: null,
      currentProvider: null,
      startTime: Date.now(),
    } as any;

    const observationXml = `
      <observation>
        <type>discovery</type>
        <title>Found something</title>
        <subtitle>Details</subtitle>
        <narrative>Found a pattern in the code</narrative>
        <facts><fact>Key fact here</fact></facts>
        <concepts><concept>architecture</concept></concepts>
        <files_read><file>src/main.ts</file></files_read>
        <files_modified></files_modified>
      </observation>
    `;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      model: 'qwen2.5:14b',
      choices: [{ message: { role: 'assistant', content: observationXml } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }))));

    await agent.startSession(session);

    expect(mockStoreObservations).toHaveBeenCalled();
    expect(mockSyncObservation).toHaveBeenCalled();
  });

  it('sets session.endpointClass to custom (not openrouter)', async () => {
    const session = {
      sessionDbId: 5,
      contentSessionId: 'test-session-5',
      memorySessionId: null,
      project: 'test-project',
      userPrompt: 'test prompt',
      conversationHistory: [],
      lastPromptNumber: 1,
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      abortController: new AbortController(),
      generatorPromise: null,
      currentProvider: null,
      startTime: Date.now(),
    } as any;

    global.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      model: 'qwen2.5:14b',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    }))));

    await agent.startSession(session);

    expect(session.endpointClass).toBe('custom');
  });

  describe('classifyOllamaError', () => {
    it('classifies connection-refused (no status) as transient/retryable', () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:11434');
      const classified = classifyOllamaError({ cause: err });
      expect(classified.kind).toBe('transient');
      expect(classified.message).toContain('ECONNREFUSED');
    });

    it('classifies 429 rate limit as rate_limit', () => {
      const classified = classifyOllamaError({ status: 429, cause: new Error('too many requests') });
      expect(classified.kind).toBe('rate_limit');
    });

    it('classifies 400 as unrecoverable', () => {
      const classified = classifyOllamaError({ status: 400, cause: new Error('bad request') });
      expect(classified.kind).toBe('unrecoverable');
    });

    it('classifies 500 as transient', () => {
      const classified = classifyOllamaError({ status: 500, cause: new Error('server error') });
      expect(classified.kind).toBe('transient');
    });
  });
});
