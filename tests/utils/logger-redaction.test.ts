// SPDX-License-Identifier: Apache-2.0
//
// The hook logs every PostToolUse at INFO with the formatted tool input, so a
// Bash command that carries a key lands in ~/.memsmith/logs unless the logger
// redacts it.
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { logger, LogLevel } from '../../src/utils/logger.js';
import { summarizeRequestBody } from '../../src/services/server/middleware.js';

const FAKE_KEY = 'sk-ant-api03-' + 'FAKE0test9'.repeat(4);

type LoggerInternals = { logFilePath: string | null; logFileInitialized: boolean; level: LogLevel | null };
const internals = logger as unknown as LoggerInternals;
const saved = { ...internals };
let dir = '';

function captureLogFile(): string {
  dir = mkdtempSync(join(tmpdir(), 'memsmith-log-'));
  const path = join(dir, 'memsmith.log');
  internals.logFilePath = path;
  internals.logFileInitialized = true;
  internals.level = LogLevel.INFO;
  return path;
}

afterEach(() => {
  internals.logFilePath = saved.logFilePath;
  internals.logFileInitialized = saved.logFileInitialized;
  internals.level = saved.level;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('logger secret redaction', () => {
  it('redacts a key in the PostToolUse line the hook writes at INFO', () => {
    const path = captureLogFile();
    const toolStr = logger.formatTool('Bash', { command: `curl -H "x-api-key: ${FAKE_KEY}" https://api.example.com` });
    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {});
    const written = readFileSync(path, 'utf-8');
    expect(written).not.toContain(FAKE_KEY);
    expect(written).toContain('PostToolUse: Bash(curl -H "x-api-key: [REDACTED:anthropic_key]" https://api.example.com)');
  });

  it('redacts secrets in the context and data of any log line', () => {
    const path = captureLogFile();
    logger.warn('SYSTEM', `request failed for ${FAKE_KEY}`, { url: `https://x.example.com/?token=${FAKE_KEY}` }, { authorization: `Bearer ${FAKE_KEY}` });
    const written = readFileSync(path, 'utf-8');
    expect(written).not.toContain(FAKE_KEY);
    expect(written).toContain('request failed for [REDACTED:anthropic_key]');
  });

  it('formatTool returns a redacted summary for every caller', () => {
    expect(logger.formatTool('Bash', { command: `export GITHUB_TOKEN=${FAKE_KEY}` }))
      .toBe('Bash(export GITHUB_TOKEN=[REDACTED:anthropic_key])');
  });

  it('summarizeRequestBody redacts the tool summary in request logs', () => {
    const summary = summarizeRequestBody('POST', '/api/sessions/observations', { tool_name: 'WebFetch', tool_input: { url: `https://x.example.com/cb?api_key=${FAKE_KEY}` } });
    expect(summary).toBe('tool=WebFetch(https://x.example.com/cb?api_key=[REDACTED:anthropic_key])');
  });
});
