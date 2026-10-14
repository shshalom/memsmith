// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the remote-recall MCP server factory. The factory is pure
// (storage is injected as a RecallBackend), so these run with no Postgres —
// they drive a real MCP Client over an in-memory transport, exactly how a
// hosted client would, and assert tool listing, arg forwarding/clamping,
// context packing, and that backend failures surface as tool errors (not
// transport throws).

import { describe, it, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRecallMcpServer, type RecallBackend } from '../../../src/server/mcp/recall-mcp-server.js';

interface Recorded {
  search: Array<{ projectId: string; query: string; limit: number }>;
  context: Array<{ projectId: string; query: string; limit: number }>;
  recent: Array<{ projectId: string; limit: number }>;
  get: Array<{ projectId: string; ids: string[] }>;
}

function makeBackend(overrides: Partial<RecallBackend> = {}): { backend: RecallBackend; calls: Recorded } {
  const calls: Recorded = { search: [], context: [], recent: [], get: [] };
  const observations = [
    { id: 'o1', content: 'alpha' },
    { id: 'o2', content: 'beta' },
  ];
  const backend: RecallBackend = {
    search: async (args) => {
      calls.search.push(args);
      return observations;
    },
    context: async (args) => {
      calls.context.push(args);
      return observations;
    },
    recent: async (args) => {
      calls.recent.push(args);
      return [{ id: 'r1', content: 'recent-one' }];
    },
    get: async (args) => {
      calls.get.push(args);
      return observations.filter(o => args.ids.includes(o.id));
    },
    ...overrides,
  };
  return { backend, calls };
}

async function connectClient(backend: RecallBackend): Promise<Client> {
  const server = createRecallMcpServer(backend, '9.9.9');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: { content: unknown }): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? '';
}

describe('createRecallMcpServer', () => {
  it('lists exactly the read-only recall tools', async () => {
    const client = await connectClient(makeBackend().backend);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['context', 'get', 'recent', 'search']);
    await client.close();
  });

  it('search forwards args, clamps the limit, and returns an index', async () => {
    const { backend, calls } = makeBackend();
    const client = await connectClient(backend);
    const res = await client.callTool({
      name: 'search',
      arguments: { projectId: 'p1', query: 'hello', limit: 9999 },
    });
    expect(calls.search[0]).toEqual({ projectId: 'p1', query: 'hello', limit: 25 });
    expect(textOf(res)).toContain('2 observations for "hello"');
    expect(textOf(res)).toContain('[o1]');
    expect(textOf(res)).toContain('with get(ids=[...])');
    expect(textOf(res)).not.toContain('observation_get');
    await client.close();
  });

  it('context routes through backend.context and returns the bodies', async () => {
    const { backend, calls } = makeBackend();
    const client = await connectClient(backend);
    const res = await client.callTool({ name: 'context', arguments: { projectId: 'p1', query: 'hi', limit: 50 } });
    expect(calls.context[0]?.limit).toBe(10);
    expect(calls.search).toHaveLength(0);
    expect(textOf(res)).toContain('alpha');
    expect(textOf(res)).toContain('beta');
    await client.close();
  });

  it('recent calls the recent backend with the default limit', async () => {
    const { backend, calls } = makeBackend();
    const client = await connectClient(backend);
    await client.callTool({ name: 'recent', arguments: { projectId: 'p2' } });
    expect(calls.recent[0]).toEqual({ projectId: 'p2', limit: 10 });
    await client.close();
  });

  it('get forwards de-duplicated ids and reports the ones not found', async () => {
    const { backend, calls } = makeBackend();
    const client = await connectClient(backend);
    const res = await client.callTool({ name: 'get', arguments: { projectId: 'p1', ids: ['o2', 'o2', 'zz'] } });
    expect(calls.get[0]).toEqual({ projectId: 'p1', ids: ['o2', 'zz'] });
    expect(textOf(res)).toContain('beta');
    expect(textOf(res)).toContain('Not found: zz');
    await client.close();
  });

  it('get refuses more than 10 ids', async () => {
    const client = await connectClient(makeBackend().backend);
    const ids = Array.from({ length: 11 }, (_, i) => `o${i}`);
    const res = await client.callTool({ name: 'get', arguments: { projectId: 'p1', ids } });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it('a missing required arg is a tool error, not a transport throw', async () => {
    const client = await connectClient(makeBackend().backend);
    const res = await client.callTool({ name: 'search', arguments: { projectId: 'p1' } });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it('a backend project-scope rejection surfaces as a tool error', async () => {
    const { backend } = makeBackend({
      search: async () => {
        throw new Error('API key is scoped to a different project');
      },
    });
    const client = await connectClient(backend);
    const res = await client.callTool({ name: 'search', arguments: { projectId: 'other', query: 'x' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('different project');
    await client.close();
  });

  it('an unknown tool is a tool error', async () => {
    const client = await connectClient(makeBackend().backend);
    const res = await client.callTool({ name: 'nope', arguments: {} });
    expect(res.isError).toBe(true);
    await client.close();
  });
});
