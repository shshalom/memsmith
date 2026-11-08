// Drives the real hook entry (`ServerService.ts hook claude-code <event>`) the
// way Claude Code does, against a fake server, with HOME and MEMSMITH_DATA_DIR
// in a temp dir. Covers MEMSMITH_ACCESS=read and MEMSMITH_HOOKS_DISABLED.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENTRY = join(process.cwd(), 'src/server/runtime/ServerService.ts');
const QUESTION = 'why did we switch the queue engine to inline?';
const RECORD_PROMPT = 'remember that the queue engine is inline now';
const WRITE_PATH = /^\/v1\/(events|memories|record-intent|sessions\/start|sessions\/[^/]+\/end)$/;

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
        return Response.json({ observations: [{ id: 'o1', content: 'The queue is inline', createdAtEpoch: Date.now() }], context: 'The queue is inline' });
      }
      if (path === '/v1/search') {
        return Response.json({ observations: [{ id: 'o2', content: 'Search hit about the queue engine', metadata: {} }] });
      }
      if (path === '/v1/sessions/start') return Response.json({ session: { id: 'srv-1' } });
      if (path === '/v1/events') return Response.json({ event: { id: 'e1' } });
      if (path.endsWith('/end')) return Response.json({ session: { id: 'srv-1' } });
      return Response.json({});
    },
  });
});

afterAll(() => { server.stop(true); });

interface Box { env: Record<string, string>; cwd: string; dataDir: string; transcript: string }

function sandbox(opts: { env?: Record<string, string>; settings?: Record<string, string>; serverUrl?: string } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), 'ms-mode-proc-'));
  const home = join(root, 'home');
  const dataDir = join(home, '.memsmith');
  const cwd = join(root, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const serverUrl = opts.serverUrl ?? `http://127.0.0.1:${server.port}`;
  const settings = {
    MEMSMITH_SERVER_URL: serverUrl,
    MEMSMITH_SERVER_API_KEY: 'test-key',
    MEMSMITH_SERVER_PROJECT_ID: 'p1',
    MEMSMITH_SEMANTIC_INJECT: 'true',
    MEMSMITH_RETRIEVAL_ENFORCEMENT: 'hard',
    MEMSMITH_RECORD_INTENT_BACKSTOP: 'true',
    MEMSMITH_GATE_TOOLS: 'Glob',
    MEMSMITH_TEAM_SERVER_URL: serverUrl,
    MEMSMITH_TEAM_API_KEY: 'team-key',
    ...opts.settings,
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
    // session-init and context mint a project identity in the local base
    // Postgres; without this they reach the developer's real one on 55433.
    MEMSMITH_SERVER_DATABASE_URL: 'postgres://memsmith:none@127.0.0.1:9/none',
    ...opts.env,
  };
  return { env, cwd, dataDir, transcript };
}

async function hook(box: Box, event: string, payload: Record<string, unknown>, platform = 'claude-code') {
  const proc = Bun.spawn({
    cmd: [process.execPath, ENTRY, 'hook', platform, event],
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

async function track<T>(run: () => Promise<T>): Promise<{ result: T; paths: string[] }> {
  const start = requests.length;
  const result = await run();
  return { result, paths: requests.slice(start) };
}

const toolUse = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a.txt' } };
const stopEvent = (box: Box) => ({ hook_event_name: 'Stop', transcript_path: box.transcript, stop_hook_active: false });

async function runCaptureHooks(box: Box): Promise<string[]> {
  const { paths } = await track(async () => {
    await hook(box, 'session-init', { hook_event_name: 'UserPromptSubmit', prompt: 'list the files' });
    await hook(box, 'observation', toolUse);
    await hook(box, 'answer-gate', stopEvent(box));
  });
  return paths;
}

const spoolFiles = (box: Box) => ['capture-spool.jsonl', 'generation-queue.jsonl'].filter((f) => existsSync(join(box.dataDir, f)));

describe('MEMSMITH_ACCESS=read through the real hook entry', () => {
  it('records the prompt, the tool use, and the summary in write mode', async () => {
    const paths = await runCaptureHooks(sandbox());
    expect(paths).toContain('/v1/sessions/start');
    expect(paths).toContain('/v1/events');
    expect(paths).toContain('/v1/sessions/srv-1/end');
  }, 60_000);

  it('sends no capture write in read mode', async () => {
    const paths = await runCaptureHooks(sandbox({ env: { MEMSMITH_ACCESS: 'read' } }));
    expect(paths.filter((p) => WRITE_PATH.test(p))).toEqual([]);
  }, 60_000);

  it('spools a tool use while the server is down in write mode, and spools nothing in read mode', async () => {
    const down = 'http://127.0.0.1:9';
    const writing = sandbox({ serverUrl: down });
    await hook(writing, 'observation', toolUse);
    expect(spoolFiles(writing)).toContain('capture-spool.jsonl');

    const reading = sandbox({ serverUrl: down, env: { MEMSMITH_ACCESS: 'read' } });
    await hook(reading, 'observation', toolUse);
    expect(spoolFiles(reading)).toEqual([]);
  }, 60_000);

  it('records no file edit in read mode', async () => {
    const edit = (box: Box) => ({ conversation_id: 'sess-1', workspace_roots: [box.cwd], file_path: join(box.cwd, 'a.ts'), edits: [{ old_string: 'a', new_string: 'b' }] });
    const writing = sandbox();
    const on = await track(() => hook(writing, 'file-edit', edit(writing), 'cursor'));
    expect(on.paths).toContain('/v1/events');

    const reading = sandbox({ env: { MEMSMITH_ACCESS: 'read' } });
    const off = await track(() => hook(reading, 'file-edit', edit(reading), 'cursor'));
    expect(off.paths).toEqual([]);
  }, 60_000);

  it('takes the default from settings.json and lets the session environment override it', async () => {
    const fromSettings = await runCaptureHooks(sandbox({ settings: { MEMSMITH_ACCESS: 'read' } }));
    expect(fromSettings.filter((p) => WRITE_PATH.test(p))).toEqual([]);

    const overridden = await runCaptureHooks(sandbox({ settings: { MEMSMITH_ACCESS: 'read' }, env: { MEMSMITH_ACCESS: 'write' } }));
    expect(overridden).toContain('/v1/events');
  }, 60_000);

  it('tells the agent that memory is read-only when the user asks to remember something', async () => {
    const writing = await track(() => hook(sandbox(), 'record-intent', { hook_event_name: 'UserPromptSubmit', prompt: RECORD_PROMPT }));
    expect(writing.paths).toContain('/v1/record-intent');

    const box = sandbox({ env: { MEMSMITH_ACCESS: 'read' } });
    const reading = await track(() => hook(box, 'record-intent', { hook_event_name: 'UserPromptSubmit', prompt: RECORD_PROMPT }));
    expect(reading.paths).toEqual([]);
    expect(reading.result.hookSpecificOutput?.additionalContext).toContain('read-only');
    expect(reading.result.systemMessage).toContain('MEMSMITH_ACCESS=read');
  }, 60_000);

  it('keeps read-side hooks working in read mode', async () => {
    const box = sandbox({ env: { MEMSMITH_ACCESS: 'read' } });
    const context = await hook(box, 'context', { hook_event_name: 'SessionStart', source: 'startup' });
    expect(context.hookSpecificOutput?.additionalContext).toContain('Search hit about the queue engine');
    expect(context.hookSpecificOutput?.additionalContext).toContain('read-only');

    const injected = await hook(box, 'prompt-injection', { hook_event_name: 'UserPromptSubmit', prompt: QUESTION });
    expect(injected.hookSpecificOutput?.additionalContext).toContain('observation_search');

    const stop = await hook(box, 'answer-gate', stopEvent(box));
    expect(stop.decision).toBe('block');
  }, 60_000);
});

describe('MEMSMITH_HOOKS_DISABLED through the real hook entry', () => {
  const disabled = (feature: string) => sandbox({ env: { MEMSMITH_HOOKS_DISABLED: feature } });

  it('context: skips session-start injection', async () => {
    const on = await hook(sandbox(), 'context', { hook_event_name: 'SessionStart', source: 'startup' });
    expect(on.hookSpecificOutput?.additionalContext).toContain('Search hit about the queue engine');

    const off = await track(() => hook(disabled('context'), 'context', { hook_event_name: 'SessionStart', source: 'startup' }));
    expect(off.result.hookSpecificOutput).toEqual({ hookEventName: 'SessionStart', additionalContext: '' });
    expect(off.paths).not.toContain('/v1/context');
  }, 60_000);

  it('prompt-injection: skips the per-prompt memory directive', async () => {
    const on = await hook(sandbox(), 'prompt-injection', { hook_event_name: 'UserPromptSubmit', prompt: QUESTION });
    expect(on.hookSpecificOutput?.additionalContext).toContain('observation_search');

    const off = await hook(disabled('prompt-injection'), 'prompt-injection', { hook_event_name: 'UserPromptSubmit', prompt: QUESTION });
    expect(off).toEqual({});
  }, 60_000);

  it('answer-gate: lets the answer through and still summarizes it', async () => {
    const box = disabled('answer-gate');
    await hook(box, 'prompt-injection', { hook_event_name: 'UserPromptSubmit', prompt: QUESTION });
    const stop = await track(() => hook(box, 'answer-gate', stopEvent(box)));
    expect(stop.result.decision).toBeUndefined();
    expect(stop.paths).toContain('/v1/sessions/srv-1/end');
  }, 60_000);

  it('summary: skips the Stop summary but keeps the answer gate', async () => {
    const box = disabled('summary');
    const quiet = await track(() => hook(box, 'answer-gate', stopEvent(box)));
    expect(quiet.paths.filter((p) => WRITE_PATH.test(p))).toEqual([]);

    await hook(box, 'prompt-injection', { hook_event_name: 'UserPromptSubmit', prompt: QUESTION });
    const gated = await hook(box, 'answer-gate', stopEvent(box));
    expect(gated.decision).toBe('block');
  }, 60_000);

  it('capture: skips prompt, tool-use, and summary capture', async () => {
    const paths = await runCaptureHooks(disabled('capture'));
    expect(paths.filter((p) => WRITE_PATH.test(p))).toEqual([]);
  }, 60_000);

  it('record-intent: skips the record-intent backstop', async () => {
    const off = await track(() => hook(disabled('record-intent'), 'record-intent', { hook_event_name: 'UserPromptSubmit', prompt: RECORD_PROMPT }));
    expect(off.paths).toEqual([]);
    expect(off.result).toEqual({});
  }, 60_000);

  it('memory-first-gate: allows a discovery tool without the memory-first block', async () => {
    const grep = { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'queue engine inline' } };
    const on = await hook(sandbox(), 'tool-intent', grep);
    expect(on.hookSpecificOutput?.permissionDecision).toBe('deny');

    const off = await hook(disabled('memory-first-gate'), 'tool-intent', grep);
    expect(off.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(off.hookSpecificOutput?.additionalContext).toBe('');
  }, 60_000);

  it('discovery-context: skips memory injection before a discovery tool', async () => {
    const glob = { hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: 'src/queue/**/*.ts' } };
    const on = await hook(sandbox(), 'discovery-gate', glob);
    expect(on.hookSpecificOutput?.additionalContext).toContain('Search hit about the queue engine');

    const off = await track(() => hook(disabled('discovery-context'), 'discovery-gate', glob));
    expect(off.result.hookSpecificOutput?.additionalContext ?? '').toBe('');
    expect(off.paths).toEqual([]);
  }, 60_000);

  it('file-context: returns the neutral result for a Read without calling the server', async () => {
    const box = disabled('file-context');
    const big = join(box.cwd, 'big.ts');
    writeFileSync(big, 'export const x = 1;\n'.repeat(200));
    const off = await track(() => hook(box, 'file-context', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: big } }));
    expect(off.result).toEqual({});
    expect(off.paths).toEqual([]);
  }, 60_000);

  it('subagent-directive: skips the directive injected into a subagent spawn', async () => {
    const spawn = { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'look around' } };
    const on = await hook(sandbox(), 'agent-directive', spawn);
    expect(on.hookSpecificOutput?.additionalContext).not.toBe('');

    const off = await hook(disabled('subagent-directive'), 'agent-directive', spawn);
    expect(off).toEqual({});
  }, 60_000);

  it('disables several features from one comma-separated list', async () => {
    const box = sandbox({ env: { MEMSMITH_HOOKS_DISABLED: ' Context , subagent-directive' } });
    const context = await hook(box, 'context', { hook_event_name: 'SessionStart', source: 'startup' });
    expect(context.hookSpecificOutput?.additionalContext).toBe('');
    const spawn = await hook(box, 'agent-directive', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {} });
    expect(spawn).toEqual({});
  }, 60_000);
});
