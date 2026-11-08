import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// A coordinator session writes memory; worker sessions launched with
// MEMSMITH_ACCESS=read must be able to search it but never add to it.

const mcpServerPath = new URL('../../src/servers/mcp-server.ts', import.meta.url).pathname;
const REFUSAL = 'MemSmith is in read-only mode for this session (MEMSMITH_ACCESS=read). Nothing was saved.';

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

describe('memory MCP tools in read-only mode', () => {
  let fake: ReturnType<typeof Bun.serve>;
  let home: string;
  let project: string;
  let received: string[] = [];
  const clients: Client[] = [];

  async function connect(opts: { env?: Record<string, string>; settings?: Record<string, string> } = {}): Promise<Client> {
    const dataDir = mkdtempSync(join(home, 'data-'));
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      MEMSMITH_SERVER_URL: `http://127.0.0.1:${fake.port}`,
      MEMSMITH_RUNTIME: 'local',
      ...opts.settings,
    }));
    writeFileSync(join(dataDir, 'credentials.json'), JSON.stringify({ keys: { 'team-a': 'key-a' } }));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) => !k.startsWith('MEMSMITH_') && !k.startsWith('CLAUDE_') && v !== undefined),
    ) as Record<string, string>;
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [mcpServerPath],
      cwd: project,
      env: {
        ...env,
        HOME: home,
        MEMSMITH_DATA_DIR: dataDir,
        MEMSMITH_SERVER_PORT: String(fake.port),
        MEMSMITH_SERVER_DATABASE_URL: 'postgres://memsmith:none@127.0.0.1:9/none',
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        ...opts.env,
      },
      stderr: 'ignore',
    }));
    clients.push(client);
    return client;
  }

  let reader: Client;
  let writer: Client;
  let readerFromSettings: Client;
  let writerOverridingSettings: Client;

  beforeAll(async () => {
    fake = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        received.push(new URL(req.url).pathname);
        return Response.json({ observations: [], context: '', observation: { id: 'obs-1' }, event: { id: 'e1' } });
      },
    });
    home = mkdtempSync(join(tmpdir(), 'ms-mcp-readmode-'));
    project = join(home, 'repo');
    mkdirSync(join(project, '.memsmith'), { recursive: true });
    writeFileSync(join(project, '.memsmith', 'project.json'), JSON.stringify({ teamId: 'team-a', projectId: 'proj-a' }));
    [reader, writer, readerFromSettings, writerOverridingSettings] = await Promise.all([
      connect({ env: { MEMSMITH_ACCESS: 'read' } }),
      connect(),
      connect({ settings: { MEMSMITH_ACCESS: 'read' } }),
      connect({ settings: { MEMSMITH_ACCESS: 'read' }, env: { MEMSMITH_ACCESS: 'write' } }),
    ]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    fake?.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => { received = []; });

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args }) as ToolResult;
    return { result, text: result.content.map((c) => c.text).join('') };
  }

  it('lists the write tools only to a session that can write', async () => {
    const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
    const writeTools = ['note_add', 'observation_add', 'observation_record_event'];
    expect(await names(writer)).toEqual(expect.arrayContaining(writeTools));
    const readable = await names(reader);
    for (const tool of writeTools) expect(readable).not.toContain(tool);
    expect(readable).toContain('observation_search');
  });

  const writeCalls: Array<[string, Record<string, unknown>, string]> = [
    ['note_add', { content: 'The queue engine is inline' }, '/v1/memories'],
    ['observation_add', { content: 'The queue engine is inline' }, '/v1/memories'],
    ['observation_record_event', { eventType: 'PostToolUse', payload: { tool_name: 'Bash' } }, '/v1/events'],
  ];

  for (const [name, args, path] of writeCalls) {
    describe(name, () => {
      it('writes in write mode', async () => {
        const { result } = await call(writer, name, args);
        expect(result.isError).toBeFalsy();
        expect(received).toContain(path);
      });

      it('refuses in read mode and sends nothing', async () => {
        const { result, text } = await call(reader, name, args);
        expect(result.isError).toBe(true);
        expect(text).toBe(REFUSAL);
        expect(received).toEqual([]);
      });

      it('refuses when settings.json sets read mode', async () => {
        const { result, text } = await call(readerFromSettings, name, args);
        expect(result.isError).toBe(true);
        expect(text).toBe(REFUSAL);
        expect(received).toEqual([]);
      });

      it('writes when the session environment overrides a read default', async () => {
        const { result } = await call(writerOverridingSettings, name, args);
        expect(result.isError).toBeFalsy();
        expect(received).toContain(path);
      });
    });
  }

  const readCalls: Array<[string, Record<string, unknown>, string]> = [
    ['observation_search', { query: 'queue engine' }, '/v1/search'],
    ['observation_context', { query: 'queue engine' }, '/v1/context'],
    ['observation_get', { ids: ['obs-1'] }, '/v1/observations/get'],
  ];

  for (const [name, args, path] of readCalls) {
    it(`${name} still reads memory in read mode`, async () => {
      const { result } = await call(reader, name, args);
      expect(result.isError).toBeFalsy();
      expect(received).toContain(path);
    });
  }
});
