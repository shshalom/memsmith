// Drives the real hook entry (`ServerService.ts hook claude-code <event>`) as
// Claude Code does — one process per hook, JSON on stdin — against a fake
// server, with HOME and MEMSMITH_DATA_DIR in a temp dir.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENTRY = join(process.cwd(), 'src/server/runtime/ServerService.ts');
const MEMORY_BODY = 'We chose the inline queue because BullMQ needed Redis on every laptop';

let server: ReturnType<typeof Bun.serve>;
const requests: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      if (path === '/v1/context') {
        return Response.json({ observations: [{ id: 'o1', content: MEMORY_BODY, createdAtEpoch: Date.now() }], context: MEMORY_BODY });
      }
      if (path === '/v1/sessions/start') return Response.json({ session: { id: 'srv-1' } });
      if (path === '/v1/events') return Response.json({ event: { id: 'e1' } });
      if (path.endsWith('/end')) return Response.json({ session: { id: 'srv-1' } });
      return Response.json({});
    },
  });
});

afterAll(() => { server.stop(true); });

function sandbox(mode: 'hard' | 'soft' = 'hard') {
  const root = mkdtempSync(join(tmpdir(), 'ms-ag-proc-'));
  const home = join(root, 'home');
  const dataDir = join(home, '.memsmith');
  const cwd = join(root, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const serverUrl = `http://127.0.0.1:${server.port}`;
  const settings = {
    MEMSMITH_SERVER_URL: serverUrl,
    MEMSMITH_SERVER_API_KEY: 'test-key',
    MEMSMITH_SERVER_PROJECT_ID: 'p1',
    MEMSMITH_SEMANTIC_INJECT: 'true',
    MEMSMITH_RETRIEVAL_ENFORCEMENT: mode,
    MEMSMITH_RECORD_INTENT_BACKSTOP: 'false',
  };
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings));
  const transcript = join(root, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: 'The queue is inline.' } }) + '\n');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    MEMSMITH_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    DO_NOT_TRACK: '1',
    ...settings,
  };
  return { env, cwd, transcript };
}

async function hook(box: ReturnType<typeof sandbox>, event: string, payload: Record<string, unknown>) {
  const proc = Bun.spawn({
    cmd: [process.execPath, ENTRY, 'hook', 'claude-code', event],
    cwd: box.cwd,
    env: box.env,
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: 'sess-1', cwd: box.cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(exitCode).toBe(0);
  const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '{}';
  return JSON.parse(line) as Record<string, any>;
}

const QUESTION = 'why did we switch the queue engine to inline?';

describe('answer gate through the real hook entry', () => {
  it('a memory search between the prompt and Stop lets the answer through and summarizes it', async () => {
    const box = sandbox();
    const submit = await hook(box, 'prompt-injection', { hook_event_name: 'UserPromptSubmit', prompt: QUESTION });
    const ctx: string = submit.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toContain('observation_search');
    expect(ctx).not.toContain(MEMORY_BODY);

    const pre = await hook(box, 'tool-intent', {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__plugin_memsmith_mem__observation_search',
      tool_input: { query: 'queue engine inline' },
    });
    expect(pre.hookSpecificOutput?.permissionDecision).toBe('allow');

    requests.length = 0;
    const stop = await hook(box, 'answer-gate', { hook_event_name: 'Stop', transcript_path: box.transcript, stop_hook_active: false });
    expect(stop.decision).toBeUndefined();
    expect(requests).toContain('/v1/sessions/srv-1/end');
  }, 60_000);

  it('an answer without a memory search is blocked once, then the continuation is summarized', async () => {
    const box = sandbox();
    await hook(box, 'prompt-injection', { hook_event_name: 'UserPromptSubmit', prompt: QUESTION });

    requests.length = 0;
    const first = await hook(box, 'answer-gate', { hook_event_name: 'Stop', transcript_path: box.transcript, stop_hook_active: false });
    expect(first.decision).toBe('block');
    expect(first.reason).toContain('Search memory (observation_search)');
    expect(requests).not.toContain('/v1/sessions/srv-1/end');

    const second = await hook(box, 'answer-gate', { hook_event_name: 'Stop', transcript_path: box.transcript, stop_hook_active: true });
    expect(second.decision).toBeUndefined();
    expect(requests).toContain('/v1/sessions/srv-1/end');
  }, 60_000);

  it('soft mode never blocks', async () => {
    const box = sandbox('soft');
    await hook(box, 'prompt-injection', { hook_event_name: 'UserPromptSubmit', prompt: QUESTION });
    const stop = await hook(box, 'answer-gate', { hook_event_name: 'Stop', transcript_path: box.transcript, stop_hook_active: false });
    expect(stop.decision).toBeUndefined();
  }, 60_000);
});
