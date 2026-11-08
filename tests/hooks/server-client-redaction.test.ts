// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'bun:test';
import { ServerClient } from '../../src/services/hooks/server-client.js';

// Assembled at runtime so no literal in the repository looks like a real key.
const FAKE_KEY = 'sk-ant-api03-' + 'FAKE0test9'.repeat(4);
const FAKE_GH = 'ghp_' + 'FAKE0test9'.repeat(4).slice(0, 36);

function capturingClient() {
  const bodies: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    bodies.push({ url, body: String(init.body ?? '') });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const client = new ServerClient({ serverBaseUrl: 'http://memsmith.test', apiKey: 'test-api-key', fetchImpl });
  return { client, bodies };
}

describe('ServerClient redacts secrets before anything leaves the hook process', () => {
  it('recordEvent: redacts secrets in nested tool input and output', async () => {
    const { client, bodies } = capturingClient();
    await client.recordEvent({
      projectId: 'p1',
      sourceType: 'hook',
      eventType: 'tool_use',
      occurredAtEpoch: 1,
      payload: {
        tool_name: 'Bash',
        tool_input: { command: `echo $ANTHROPIC_API_KEY && gh auth status --token ${FAKE_GH}` },
        tool_response: { stdout: [`ANTHROPIC_API_KEY=${FAKE_KEY}`, `again: ${FAKE_KEY}`] },
      },
    });
    const sent = bodies[0].body;
    expect(sent).not.toContain(FAKE_KEY);
    expect(sent).not.toContain(FAKE_GH);
    expect(JSON.parse(sent).payload).toEqual({
      tool_name: 'Bash',
      tool_input: { command: 'echo $ANTHROPIC_API_KEY && gh auth status --token [REDACTED:github_token]' },
      tool_response: { stdout: ['ANTHROPIC_API_KEY=[REDACTED:anthropic_key]', 'again: [REDACTED:anthropic_key]'] },
    });
  });

  it('addObservation: redacts the content and the metadata', async () => {
    const { client, bodies } = capturingClient();
    await client.addObservation({
      projectId: 'p1',
      content: `Rotated the key ${FAKE_KEY}.`,
      metadata: { facts: [`old token ${FAKE_GH}`], title: 'Key rotation' },
    });
    const sent = JSON.parse(bodies[0].body);
    expect(sent.content).toBe('Rotated the key [REDACTED:anthropic_key].');
    expect(sent.metadata).toEqual({ facts: ['old token [REDACTED:github_token]'], title: 'Key rotation' });
  });

  it('startSession: redacts the prompt carried in session metadata', async () => {
    const { client, bodies } = capturingClient();
    await client.startSession({ projectId: 'p1', metadata: { project: 'demo', prompt: `use ${FAKE_KEY} for this` } });
    expect(JSON.parse(bodies[0].body).metadata).toEqual({ project: 'demo', prompt: 'use [REDACTED:anthropic_key] for this' });
  });

  it('recordIntent: redacts the prompt sent to the record-intent backstop', async () => {
    const { client, bodies } = capturingClient();
    await client.recordIntent({ projectId: 'p1', prompt: `remember that the key is ${FAKE_KEY}` });
    expect(JSON.parse(bodies[0].body).prompt).toBe('remember that the key is [REDACTED:anthropic_key]');
  });
});
