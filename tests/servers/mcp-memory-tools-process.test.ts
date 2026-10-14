import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Drives the real stdio MCP server the way Claude Code does, against a fake
// /v1 server that returns realistically sized rows (~2.7K characters each).

const mcpServerPath = new URL('../../src/servers/mcp-server.ts', import.meta.url).pathname;

function row(id: string) {
  const title = `Observation ${id} about the queue engine`;
  const narrative = `Narrative for ${id}. ${'Detail sentence about the change. '.repeat(45)}`;
  return {
    id,
    projectId: 'proj-1',
    teamId: 'team-1',
    serverSessionId: 'sess-1',
    kind: 'discovery',
    obsType: 'discovery',
    lifecycleState: 'active',
    quality: 80,
    content: `${title}\n\nSubtitle ${id}\n\n${narrative}\n\n- FACT-${id}-END`,
    metadata: { title, subtitle: `Subtitle ${id}`, narrative, why: `WHY-${id}`, files_modified: [`src/${id}.ts`] },
    createdAtEpoch: Date.UTC(2026, 9, 1),
    updatedAtEpoch: Date.UTC(2026, 9, 1),
  };
}

const corpus = Array.from({ length: 60 }, (_, i) => row(`obs-${i}`));

describe('memory MCP tools over stdio', () => {
  let fake: ReturnType<typeof Bun.serve>;
  let home: string;
  let client: Client;
  const received: Array<{ path: string; body: any }> = [];

  beforeAll(async () => {
    fake = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body = req.method === 'POST' ? await req.json() : null;
        received.push({ path, body });
        if (path === '/v1/search' || path === '/v1/context') {
          return Response.json({ observations: corpus.slice(0, body.limit ?? 20), context: '' });
        }
        if (path === '/v1/observations/get') {
          return Response.json({ observations: corpus.filter(o => body.ids.includes(o.id)) });
        }
        return Response.json({}, { status: 404 });
      },
    });

    home = mkdtempSync(join(tmpdir(), 'ms-mcp-proc-'));
    const dataDir = join(home, '.memsmith');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      MEMSMITH_RUNTIME: 'server',
      MEMSMITH_SERVER_URL: `http://127.0.0.1:${fake.port}`,
      MEMSMITH_SERVER_API_KEY: 'test-key',
      MEMSMITH_SERVER_PROJECT_ID: 'proj-1',
    }));

    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) => !k.startsWith('MEMSMITH_') && v !== undefined),
    ) as Record<string, string>;
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [mcpServerPath],
      cwd: home,
      env: { ...env, HOME: home, MEMSMITH_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: join(home, '.claude') },
      stderr: 'ignore',
    }));
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    fake?.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  async function callText(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeFalsy();
    return result.content.map(c => c.text).join('');
  }

  it('lists observation_get next to the search tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(['observation_search', 'observation_get', 'observation_context']));
  });

  it('observation_search caps an oversized limit and returns a small index', async () => {
    const text = await callText('observation_search', { query: 'queue engine', limit: 40 });
    expect(received.at(-1)).toEqual({ path: '/v1/search', body: expect.objectContaining({ limit: 25 }) });
    expect(text.length).toBeLessThan(20_000);
    expect(text).toContain('[obs-0] 2026-10-01 · discovery · Observation obs-0 about the queue engine');
    expect(text).toContain('[obs-24]');
    expect(text).not.toContain('FACT-obs-0-END');
  });

  it('observation_search defaults to 10 results', async () => {
    await callText('observation_search', { query: 'queue engine' });
    expect(received.at(-1)?.body.limit).toBe(10);
  });

  it('observation_get returns the full records for the chosen ids', async () => {
    const text = await callText('observation_get', { ids: ['obs-3', 'obs-7'] });
    expect(received.at(-1)).toEqual({ path: '/v1/observations/get', body: { projectId: 'proj-1', ids: ['obs-3', 'obs-7'] } });
    expect(text).toContain('FACT-obs-3-END');
    expect(text).toContain('WHY-obs-7');
    expect(text).toContain('src/obs-7.ts');
  });

  it('observation_get refuses more than 10 ids', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `obs-${i}`);
    const result = await client.callTool({ name: 'observation_get', arguments: { ids } }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('at most 10 ids');
  });

  it('observation_context caps the limit and the output size', async () => {
    const text = await callText('observation_context', { query: 'queue engine', limit: 50 });
    expect(received.at(-1)?.body.limit).toBe(10);
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text).toContain('FACT-obs-0-END');
  });
});
