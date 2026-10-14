// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { tmpdir } from 'os';
import { buildEvent, extractToolCalls, parseArgs, transcriptDirFor } from '../../scripts/replay-transcript-gap.js';

const SESSION = '21aaaae0-0db2-4b39-b650-235fb0d4d52a';
const CWD = '/Users/dev/Workspace/FormaFieldAgent';

function use(id: string, at: string, name = 'Bash', input: unknown = { command: 'git status' }) {
  return JSON.stringify({
    type: 'assistant', sessionId: SESSION, cwd: CWD, timestamp: at,
    message: { content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id, name, input }] },
  });
}

function result(id: string, at: string, extra: Record<string, unknown> = {}, isError = false) {
  return JSON.stringify({
    type: 'user', sessionId: SESSION, cwd: CWD, timestamp: at,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'raw text', ...(isError ? { is_error: true } : {}) }] },
    ...extra,
  });
}

const FROM = Date.parse('2026-10-10T22:48:00Z');
const TO = Date.parse('2026-10-13T19:56:30Z');

describe('extractToolCalls', () => {
  it('pairs a tool call with its result and keeps the original time', () => {
    const jsonl = [use('t1', '2026-10-11T10:00:00Z'), result('t1', '2026-10-11T10:00:02Z')].join('\n');
    const [call] = extractToolCalls(jsonl, FROM, TO);
    expect(call).toMatchObject({ toolUseId: 't1', sessionId: SESSION, cwd: CWD, toolName: 'Bash', toolInput: { command: 'git status' } });
    expect(call.occurredAtEpoch).toBe(Date.parse('2026-10-11T10:00:02Z'));
  });

  it('prefers the structured tool result over the raw text, as the hook receives it', () => {
    const jsonl = [
      use('t1', '2026-10-11T10:00:00Z'),
      result('t1', '2026-10-11T10:00:02Z', { toolUseResult: { stdout: 'clean', exitCode: 0 } }),
    ].join('\n');
    expect(extractToolCalls(jsonl, FROM, TO)[0].toolResponse).toEqual({ stdout: 'clean', exitCode: 0 });
  });

  it('keeps only calls whose result lands inside the window', () => {
    const jsonl = [
      use('before', '2026-10-10T22:40:00Z'), result('before', '2026-10-10T22:40:01Z'),
      use('inside', '2026-10-12T09:00:00Z'), result('inside', '2026-10-12T09:00:01Z'),
      use('after', '2026-10-13T20:21:00Z'), result('after', '2026-10-13T20:21:01Z'),
    ].join('\n');
    expect(extractToolCalls(jsonl, FROM, TO).map(c => c.toolUseId)).toEqual(['inside']);
  });

  it('drops a call that never got a result, since the hook never fired for it', () => {
    const jsonl = [use('interrupted', '2026-10-11T10:00:00Z'), use('t2', '2026-10-11T10:01:00Z'), result('t2', '2026-10-11T10:01:01Z')].join('\n');
    expect(extractToolCalls(jsonl, FROM, TO).map(c => c.toolUseId)).toEqual(['t2']);
  });

  it('places a call by its result time when it straddles the window start', () => {
    const jsonl = [use('t1', '2026-10-10T22:47:59Z'), result('t1', '2026-10-10T22:48:01Z')].join('\n');
    expect(extractToolCalls(jsonl, FROM, TO).map(c => c.toolUseId)).toEqual(['t1']);
  });

  it('includes a call whose result lands exactly at the window end', () => {
    const jsonl = [use('t1', '2026-10-13T19:56:29Z'), result('t1', '2026-10-13T19:56:30Z')].join('\n');
    expect(extractToolCalls(jsonl, FROM, TO)).toHaveLength(1);
  });

  it('drops a failed call, which PostToolUse never reports', () => {
    const jsonl = [use('t1', '2026-10-11T10:00:00Z'), result('t1', '2026-10-11T10:00:02Z', {}, true)].join('\n');
    expect(extractToolCalls(jsonl, FROM, TO)).toEqual([]);
  });

  it('keeps a subagent call with its parent session and agent id', () => {
    const sub = JSON.stringify({
      type: 'assistant', sessionId: SESSION, cwd: CWD, agentId: 'a7f3', timestamp: '2026-10-11T10:00:00Z',
      message: { content: [{ type: 'tool_use', id: 's1', name: 'Read', input: { file_path: '/x.swift' } }] },
    });
    const [call] = extractToolCalls([sub, result('s1', '2026-10-11T10:00:01Z')].join('\n'), FROM, TO);
    expect(call).toMatchObject({ sessionId: SESSION, agentId: 'a7f3', toolName: 'Read' });
  });

  it('skips corrupt lines without losing the rest of the transcript', () => {
    const jsonl = ['{truncated', use('t1', '2026-10-11T10:00:00Z'), '', result('t1', '2026-10-11T10:00:02Z')].join('\n');
    expect(extractToolCalls(jsonl, FROM, TO)).toHaveLength(1);
  });
});

describe('buildEvent', () => {
  // The server dedups on this shape. Changing it would store every event a
  // second time on the next run, including the events already sent.
  it('sends exactly what the PostToolUse hook sends', () => {
    const event = buildEvent({
      toolUseId: 't1', sessionId: SESSION, cwd: CWD, toolName: 'Bash',
      toolInput: { command: 'git status' }, toolResponse: { stdout: 'clean' },
      agentId: 'a7f3', occurredAtEpoch: 1_791_000_000_000,
    }, 'proj-1');
    expect(event).toEqual({
      projectId: 'proj-1',
      contentSessionId: SESSION,
      platformSource: 'claude',
      sourceType: 'hook',
      eventType: 'tool_use',
      occurredAtEpoch: 1_791_000_000_000,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        tool_response: { stdout: 'clean' },
        cwd: CWD,
        agentId: 'a7f3',
        platformSource: 'claude',
      },
    });
    expect(Object.keys(event.payload as object)).toEqual(['tool_name', 'tool_input', 'tool_response', 'cwd', 'agentId', 'platformSource']);
  });
});

describe('parseArgs', () => {
  const base = ['--cwd', tmpdir(), '--from', '2026-10-10T22:48:00Z', '--to', '2026-10-13T19:56:30Z'];

  it('rejects a mistyped flag instead of running the full replay', () => {
    expect(() => parseArgs([...base, '--execute', '--limt', '5'])).toThrow(/unknown argument --limt/);
    expect(() => parseArgs([...base, '--execute', '--limit=5'])).toThrow(/unknown argument/);
  });

  it('rejects a limit or batch that is not a positive whole number', () => {
    expect(() => parseArgs([...base, '--limit', '0'])).toThrow(/positive whole number/);
    expect(() => parseArgs([...base, '--limit', 'abc'])).toThrow(/positive whole number/);
    expect(() => parseArgs([...base, '--batch', '0'])).toThrow(/positive whole number/);
  });

  it('rejects a time without a zone, which would be read as local time', () => {
    expect(() => parseArgs(['--cwd', tmpdir(), '--from', '2026-10-10T22:48', '--to', '2026-10-13T19:56:30Z'])).toThrow(/time zone/);
  });

  it('accepts a full set of arguments', () => {
    expect(parseArgs([...base, '--execute', '--limit', '5'])).toMatchObject({ execute: true, limit: 5, batch: 4, stallMinutes: 180 });
  });
});

describe('transcriptDirFor', () => {
  it('matches the folder name Claude Code uses for a project path', () => {
    expect(transcriptDirFor('/Users/shwaits/Workspace/FormaFieldAgent', '/Users/shwaits'))
      .toBe('/Users/shwaits/.claude/projects/-Users-shwaits-Workspace-FormaFieldAgent');
    expect(transcriptDirFor('/Users/shwaits/Workspace/team-agent-memory', '/Users/shwaits'))
      .toBe('/Users/shwaits/.claude/projects/-Users-shwaits-Workspace-team-agent-memory');
  });
});
