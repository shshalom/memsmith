// tests/cli/handlers/tool-intent.test.ts
import { describe, it, expect } from 'bun:test';
import { toolIntentHandler } from '../../../src/cli/handlers/tool-intent.js';

describe('toolIntentHandler', () => {
  it('non-search tool → allow, no block (fail-open path, no runtime)', async () => {
    const res = await toolIntentHandler.execute({ sessionId: 's1', cwd: '/tmp', toolName: 'Edit', toolInput: { file_path: '/a.ts' } } as any);
    expect(res.continue).toBe(true);
    // never denies a non-search tool
    expect(res.hookSpecificOutput?.permissionDecision === 'deny').toBe(false);
  });

  it('search tool with no reachable runtime → allow (fail-open), never throws', async () => {
    const res = await toolIntentHandler.execute({ sessionId: 's1', cwd: '/tmp', toolName: 'Grep', toolInput: { pattern: 'x' } } as any);
    expect(res.continue).toBe(true);
    expect(res.hookSpecificOutput?.permissionDecision === 'deny').toBe(false);
  });

  it('sub-agent tool call (agentId set) still runs the path without throwing', async () => {
    const res = await toolIntentHandler.execute({ sessionId: 's1', cwd: '/tmp', toolName: 'Grep', toolInput: { pattern: 'x' }, agentId: 'sub-1', agentType: 'general-purpose' } as any);
    expect(res.continue).toBe(true);
  });
});

// ── Amendment 1/2 wiring (2026-08-11) ────────────────────────────────────────
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionTopicStore } from '../../../src/services/retrieval/topic-store.js';
import { topicKey } from '../../../src/services/retrieval/topic-key.js';
import { MEMORY_TOOL_PATTERN } from '../../../src/cli/handlers/tool-intent.js';

describe('MEMORY_TOOL_PATTERN', () => {
  for (const t of [
    'mcp__plugin_memsmith_mem__observation_search',
    'mcp__plugin_memsmith_mem__smart_search',
    'mcp__plugin_memsmith_mem__observation_context',
  ]) {
    it(`recognises ${t} as a memory consultation`, () => {
      expect(MEMORY_TOOL_PATTERN.test(t)).toBe(true);
    });
  }
  for (const t of [
    'Grep', 'Glob', 'Read', 'Bash',
    'mcp__plugin_slack_slack__slack_read_channel',
    'mcp__plugin_claude-mem_mcp-search__observation_search',
  ]) {
    it(`does NOT treat ${t} as a memory consultation`, () => {
      expect(MEMORY_TOOL_PATTERN.test(t)).toBe(false);
    });
  }
});

describe('toolIntentHandler — memory tool calls unlock the topic', () => {
  it('marks the topic consulted when a memory search tool is called, and allows it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ti-'));
    const res = await toolIntentHandler.execute({
      sessionId: 'sx', cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__observation_search',
      toolInput: { query: 'ollama restart' },
    } as any, { sessionBaseDir: base } as any);
    expect(res.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(new SessionTopicStore('sx', base).hasConsulted(topicKey('ollama restart'))).toBe(true);
  });

  it('never denies a memory tool call — that would deadlock the gate', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ti-'));
    const res = await toolIntentHandler.execute({
      sessionId: 'sy', cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__smart_search',
      toolInput: { query: 'anything' },
    } as any, { sessionBaseDir: base } as any);
    expect(res.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  it('does not mark a topic for a memory tool call with no query', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ti-'));
    await toolIntentHandler.execute({
      sessionId: 'sz', cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__observation_search',
      toolInput: {},
    } as any, { sessionBaseDir: base } as any);
    expect(new SessionTopicStore('sz', base).hasConsulted('')).toBe(false);
  });

  it('records a cold Read as warm so a re-read is not gated', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ti-'));
    const input = { sessionId: 'sw', cwd: '/tmp', toolName: 'Read', toolInput: { file_path: '/a/x.ts' } } as any;
    await toolIntentHandler.execute(input, { sessionBaseDir: base } as any);
    const { WarmPathStore } = await import('../../../src/services/retrieval/warm-path-store.js');
    expect(new WarmPathStore('sw', base).has('/a/x.ts')).toBe(true);
  });
});

describe('toolIntentHandler — a memory read answers the pending information request', () => {
  const { AnswerGateStore } = require('../../../src/services/retrieval/answer-gate-store.js');
  const PROMPT_TOPIC = topicKey('why did we switch the queue engine to inline');

  function pendingSession(sessionId: string) {
    const base = mkdtempSync(join(tmpdir(), 'ti-ag-'));
    new AnswerGateStore(sessionId, base).beginTurn({ pending: true, topic: PROMPT_TOPIC });
    return base;
  }

  for (const tool of [
    'mcp__plugin_memsmith_mem__observation_search',
    'mcp__plugin_memsmith_mem__observation_context',
    'mcp__plugin_memsmith_mem__session_start_context',
  ]) {
    it(`${tool} satisfies the pending request`, async () => {
      const base = pendingSession('sa');
      await toolIntentHandler.execute({ sessionId: 'sa', cwd: '/tmp', toolName: tool, toolInput: { query: 'queue engine' } } as any, { sessionBaseDir: base } as any);
      expect(new AnswerGateStore('sa', base).isUnsatisfied()).toBe(false);
    });
  }

  it('marks the prompt topic consulted so the follow-up Grep on it is not gated', async () => {
    const base = pendingSession('sb');
    await toolIntentHandler.execute({
      sessionId: 'sb', cwd: '/tmp',
      toolName: 'mcp__plugin_memsmith_mem__observation_search',
      toolInput: { query: 'bullmq redis laptops' },
    } as any, { sessionBaseDir: base } as any);
    expect(new SessionTopicStore('sb', base, () => Number.MAX_SAFE_INTEGER).hasConsulted(PROMPT_TOPIC)).toBe(true);
  });

  for (const tool of [
    'mcp__plugin_memsmith_mem__smart_search',
    'mcp__plugin_memsmith_mem__smart_outline',
    'mcp__plugin_memsmith_mem__observation_add',
    'mcp__plugin_memsmith_mem__note_add',
    'Grep',
    'Read',
  ]) {
    it(`${tool} does not satisfy the pending request`, async () => {
      const base = pendingSession('sc');
      await toolIntentHandler.execute({ sessionId: 'sc', cwd: '/tmp', toolName: tool, toolInput: { query: 'queue engine', pattern: 'queue' } } as any, { sessionBaseDir: base } as any);
      expect(new AnswerGateStore('sc', base).isUnsatisfied()).toBe(true);
    });
  }
});
