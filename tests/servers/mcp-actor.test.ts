import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const UNREACHABLE_DB = 'postgres://127.0.0.1:1/unreachable';
const mcpServerPath = new URL('../../src/servers/mcp-server.ts', import.meta.url).pathname;

const ROW = {
  id: 'obs-1',
  projectId: 'proj-1',
  kind: 'discovery',
  obsType: 'discovery',
  content: 'Queue drains in order\n\nThe queue drains in FIFO order.',
  metadata: { title: 'Queue drains in order', actor: 'reviewer' },
  createdAtEpoch: Date.UTC(2026, 10, 1),
};

describe('MCP tools and the session actor', () => {
  let fake: ReturnType<typeof Bun.serve>;
  let home: string;
  let client: Client;
  let anonymous: Client;
  const received: Array<{ path: string; body: any }> = [];

  beforeAll(async () => {
    fake = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body = req.method === 'POST' ? await req.json() : null;
        received.push({ path, body });
        if (path === '/v1/search' || path === '/v1/context') return Response.json({ observations: [ROW], context: '' });
        if (path === '/v1/memories') return Response.json({ memory: { id: 'm1', ...body } }, { status: 201 });
        if (path === '/v1/events') return Response.json({ event: { id: 'e1' } }, { status: 201 });
        return Response.json({}, { status: 404 });
      },
    });
    home = mkdtempSync(join(tmpdir(), 'ms-mcp-actor-'));
    const dataDir = join(home, '.memsmith');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      MEMSMITH_RUNTIME: 'server',
      MEMSMITH_SERVER_URL: `http://127.0.0.1:${fake.port}`,
      MEMSMITH_SERVER_API_KEY: 'test-key',
      MEMSMITH_SERVER_PROJECT_ID: 'proj-1',
    }));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) => (!k.startsWith('MEMSMITH_') || k === 'MEMSMITH_SERVER_DATABASE_URL' || k === 'MEMSMITH_LOCAL_PG_PORT') && v !== undefined),
    ) as Record<string, string>;
    const connect = async (actor: string) => {
      const c = new Client({ name: 'test', version: '0.0.0' });
      await c.connect(new StdioClientTransport({
        command: process.execPath,
        args: [mcpServerPath],
        cwd: home,
        env: { ...env, HOME: home, MEMSMITH_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: join(home, '.claude'), MEMSMITH_ACTOR: actor, MEMSMITH_SERVER_DATABASE_URL: UNREACHABLE_DB },
        stderr: 'ignore',
      }));
      return c;
    };
    client = await connect('reviewer');
    anonymous = await connect('');
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await anonymous?.close();
    fake?.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>) {
    return await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
  }

  it('note_add stamps the session actor on the note', async () => {
    await call('note_add', { content: 'Cache TTL is five minutes' });
    expect(received.at(-1)).toEqual({
      path: '/v1/memories',
      body: expect.objectContaining({ kind: 'user_note', metadata: { actor: 'reviewer', userDirected: true } }),
    });
  });

  it('observation_add replaces caller-supplied actor and actors with the session actor', async () => {
    await call('observation_add', { content: 'Queue note', metadata: { title: 'Q', actor: 'someone-else', actors: ['a', 'b'] } });
    expect(received.at(-1)?.body.metadata).toEqual({ title: 'Q', actor: 'reviewer' });
  });

  it('observation_add drops caller-supplied actor and actors when the session has no actor', async () => {
    await anonymous.callTool({ name: 'observation_add', arguments: { content: 'Queue note', metadata: { title: 'Q', actor: 'forged', actors: ['forged'] } } });
    expect(received.at(-1)?.body.metadata).toEqual({ title: 'Q' });
  });

  it('observation_record_event stamps the session actor on the event payload', async () => {
    await call('observation_record_event', { eventType: 'tool_use', payload: { tool_name: 'Read' } });
    expect(received.at(-1)?.body.payload).toEqual({ tool_name: 'Read', actor: 'reviewer' });
  });

  it('observation_search forwards the actor filter and shows the actor in the index', async () => {
    const result = await call('observation_search', { query: 'queue', actor: 'reviewer' });
    expect(received.at(-1)).toEqual({ path: '/v1/search', body: expect.objectContaining({ query: 'queue', actor: 'reviewer' }) });
    expect(result.content[0].text).toContain('[obs-1] 2026-11-01 · discovery · by reviewer · Queue drains in order');
  });

  it('observation_search lists recent records for an actor when no query is given', async () => {
    const result = await call('observation_search', { actor: 'reviewer' });
    expect(result.isError).toBeFalsy();
    expect(received.at(-1)).toEqual({ path: '/v1/search', body: expect.objectContaining({ query: '', actor: 'reviewer' }) });
  });

  it('observation_search still requires a query when no actor is given', async () => {
    const result = await call('observation_search', {});
    expect(result.isError).toBe(true);
  });

  it('observation_context forwards the actor filter', async () => {
    await call('observation_context', { query: 'queue', actor: 'reviewer' });
    expect(received.at(-1)).toEqual({ path: '/v1/context', body: expect.objectContaining({ actor: 'reviewer' }) });
  });

  it('refuses a blank actor filter, like POST /v1/search', async () => {
    const before = received.length;
    for (const name of ['observation_search', 'observation_context']) {
      const result = await call(name, { query: 'queue', actor: '   ' });
      expect(result.isError).toBe(true);
    }
    expect(received.length).toBe(before);
  });

  it('refuses an actor filter with control characters', async () => {
    const before = received.length;
    const result = await call('observation_search', { query: 'queue', actor: 'bad\nactor' });
    expect(result.isError).toBe(true);
    expect(received.length).toBe(before);
  });
});
