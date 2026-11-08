import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Reported incident: in a checkout with no project marker, observation_search
// answered "No observations matched", so the agent concluded memory was empty.
// The local runtime here mirrors a real install: no settings-level key or
// project, so only a folder's marker plus its cached team key resolves a project.

const mcpServerPath = new URL('../../src/servers/mcp-server.ts', import.meta.url).pathname;

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

describe('memory MCP read tools in a folder without a MemSmith project', () => {
  let fake: ReturnType<typeof Bun.serve>;
  let home: string;
  let pinned: string;
  let unpinned: string;
  let fromPinned: Client;
  let fromUnpinned: Client;
  let received: Array<{ path: string; body: any }> = [];

  async function connect(cwd: string, dataDir: string): Promise<Client> {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) => !k.startsWith('MEMSMITH_') && !k.startsWith('CLAUDE_') && v !== undefined),
    ) as Record<string, string>;
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [mcpServerPath],
      cwd,
      env: { ...env, HOME: home, MEMSMITH_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: join(home, '.claude') },
      stderr: 'ignore',
    }));
    return client;
  }

  beforeAll(async () => {
    fake = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body = req.method === 'POST' ? await req.json() : null;
        received.push({ path, body });
        return Response.json({ observations: [], context: '' });
      },
    });

    home = mkdtempSync(join(tmpdir(), 'ms-mcp-noproj-'));
    const dataDir = join(home, '.memsmith');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      MEMSMITH_RUNTIME: 'local',
      MEMSMITH_SERVER_URL: `http://127.0.0.1:${fake.port}`,
      MEMSMITH_SERVER_API_KEY: '',
      MEMSMITH_SERVER_PROJECT_ID: '',
    }));
    writeFileSync(join(dataDir, 'credentials.json'), JSON.stringify({ keys: { 'team-pinned': 'key-pinned' } }));

    pinned = join(home, 'pinned-repo');
    mkdirSync(join(pinned, '.memsmith'), { recursive: true });
    writeFileSync(join(pinned, '.memsmith', 'project.json'), JSON.stringify({ teamId: 'team-pinned', projectId: 'proj-pinned' }));
    unpinned = join(home, 'unpinned-checkout');
    mkdirSync(unpinned, { recursive: true });

    [fromPinned, fromUnpinned] = await Promise.all([connect(pinned, dataDir), connect(unpinned, dataDir)]);
  }, 30_000);

  afterAll(async () => {
    await fromPinned?.close();
    await fromUnpinned?.close();
    fake?.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    received = [];
  });

  const readCalls: Array<[string, Record<string, unknown>]> = [
    ['observation_search', { query: 'queue engine' }],
    ['observation_context', { query: 'queue engine' }],
    ['observation_get', { ids: ['obs-1'] }],
  ];

  function expectNoProject(result: ToolResult, folder: string) {
    const text = result.content.map(c => c.text).join('');
    expect(result.isError).toBe(true);
    expect(text).toContain(`No MemSmith project found for ${folder}.`);
    expect(text).toContain('Memory was not searched; this is not an empty result.');
    expect(text).not.toContain('No observations matched');
  }

  for (const [name, args] of readCalls) {
    it(`${name} reports no project when the session folder is unpinned`, async () => {
      const result = await fromUnpinned.callTool({ name, arguments: args }) as ToolResult;
      expectNoProject(result, realpathSync(unpinned));
      expect(received).toEqual([]);
    });

    it(`${name} reports no project for an unpinned cwd even when the session folder is pinned`, async () => {
      const result = await fromPinned.callTool({ name, arguments: { ...args, cwd: unpinned } }) as ToolResult;
      expectNoProject(result, unpinned);
      expect(received).toEqual([]);
    });

    it(`${name} still reads the session folder's project when no cwd is passed`, async () => {
      const result = await fromPinned.callTool({ name, arguments: args }) as ToolResult;
      expect(result.isError).toBeFalsy();
      expect(received).toHaveLength(1);
      expect(received[0]?.body.projectId).toBe('proj-pinned');
    });

    it(`${name} reads a pinned cwd's project from an unpinned session folder`, async () => {
      const result = await fromUnpinned.callTool({ name, arguments: { ...args, cwd: pinned } }) as ToolResult;
      expect(result.isError).toBeFalsy();
      expect(received).toHaveLength(1);
      expect(received[0]?.body.projectId).toBe('proj-pinned');
    });
  }

  it('observation_search keeps the empty-result answer for a pinned project with no match', async () => {
    const result = await fromPinned.callTool({ name: 'observation_search', arguments: { query: 'queue engine' } }) as ToolResult;
    expect(result.content[0]?.text).toContain('No observations matched "queue engine"');
  });
});
