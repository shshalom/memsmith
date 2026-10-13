import { describe, it, expect, beforeEach } from 'bun:test';
import { createRecordIntentHandler } from '../../../src/cli/handlers/record-intent.js';

const sent: string[] = [];

const handler = createRecordIntentHandler({
  loadSettings: () => ({ MEMSMITH_RECORD_INTENT_BACKSTOP: 'true' }),
  resolveRuntime: () => ({
    runtime: 'server',
    projectId: 'p1',
    serverBaseUrl: 'http://127.0.0.1:1',
    client: { recordIntent: async (req: { prompt: string }) => { sent.push(req.prompt); } },
  }) as any,
  armedStore: () => ({ write: () => {} }),
});

function run(prompt: string) {
  return handler.execute({ sessionId: `gate-${Math.random()}`, cwd: '/tmp', prompt } as any);
}

// 2026-10-07: these two ordinary prompts were sent to the backstop, which
// stored invented "user notes" for them.
describe('record-intent backstop gate', () => {
  beforeEach(() => { sent.length = 0; });

  it('does not send ordinary prompts to the backstop', async () => {
    await run('so someone tried to install memsmith and he encountered a problem while installing.');
    await run('I want you to tell me how MemSmith compared to Engram https://github.com/Gentleman-Programming/engram');
    expect(sent).toEqual([]);
  });

  it('still sends real record requests to the backstop', async () => {
    await run('remember that the base key lives in ~/.memsmith/credentials.json');
    await run('jot down that the dashboard runs on 38879');
    expect(sent.length).toBe(2);
  });
});
