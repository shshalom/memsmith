// SPDX-License-Identifier: Apache-2.0
//
// Remote-recall MCP server factory.
//
// Builds a low-level MCP `Server` exposing the read tools (`search`, `context`,
// `recent`) over an injected `RecallBackend`. The backend is the only seam to
// storage, so this factory is pure and unit-testable without Postgres — the
// route layer (ServerV1PostgresRoutes) supplies a backend already scoped to the
// authenticated API key's team (and honoring any project scope).
//
// This is the same recall surface the stdio MCP server exposes via
// ServerBetaClient (`/v1/search`, `/v1/context`), so a hosted MCP link and the
// local CLI read identical data. The mutating tools are intentionally absent:
// a pasted recall link is read-only.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../utils/logger.js';
import {
  clampLimit,
  formatObservationContext,
  formatObservationDetails,
  formatObservationIndex,
  CONTEXT_LIMIT,
  GET_MAX_IDS,
  SEARCH_LIMIT,
  type ObservationRow,
} from '../../shared/observation-format.js';

export interface RecallBackend {
  // Returns serialized observations (already shaped by serializeObservation),
  // scoped to the caller's team. Throws if `projectId` is outside the key's scope.
  // `search` and `context` query identically; they are separate methods so the
  // route can audit each tool under its own mode (search vs context).
  search(args: { projectId: string; query: string; limit: number }): Promise<ObservationRow[]>;
  context(args: { projectId: string; query: string; limit: number }): Promise<ObservationRow[]>;
  recent(args: { projectId: string; limit: number }): Promise<ObservationRow[]>;
  get(args: { projectId: string; ids: string[] }): Promise<ObservationRow[]>;
}

const RECENT_LIMIT = SEARCH_LIMIT;

const TOOLS: Tool[] = [
  {
    name: 'search',
    description:
      'Search your memsmith memory for a project. Returns a ranked index (id, date, type, title, snippet); fetch full records with get.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to search within.' },
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_LIMIT.max },
      },
      required: ['projectId', 'query'],
    },
  },
  {
    name: 'context',
    description:
      'Returns the full bodies of the top few observations for a query, capped in size.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to search within.' },
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'integer', minimum: 1, maximum: CONTEXT_LIMIT.max },
      },
      required: ['projectId', 'query'],
    },
  },
  {
    name: 'recent',
    description: 'List the most recent observations for a project as an index (newest first).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project to list.' },
        limit: { type: 'integer', minimum: 1, maximum: RECENT_LIMIT.max },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get',
    description: 'Fetch full observation records by id, using ids from search or recent.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project the ids belong to.' },
        ids: { type: 'array', items: { type: 'string' }, maxItems: GET_MAX_IDS },
      },
      required: ['projectId', 'ids'],
    },
  },
];

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`"${key}" is required`);
  }
  return value;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function requireIds(args: Record<string, unknown>): string[] {
  const raw = args.ids;
  const ids = Array.isArray(raw)
    ? [...new Set(raw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim()))]
    : [];
  if (ids.length === 0) throw new Error('"ids" is required');
  if (ids.length > GET_MAX_IDS) throw new Error(`at most ${GET_MAX_IDS} ids per call (got ${ids.length})`);
  return ids;
}

// Dispatches a single tool call to the backend. Throws on unknown tools or
// invalid arguments; `createRecallMcpServer` converts those into MCP errors.
async function dispatchToolCall(
  backend: RecallBackend,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (name === 'search') {
    const query = requireString(args, 'query');
    const observations = await backend.search({
      projectId: requireString(args, 'projectId'),
      query,
      limit: clampLimit(args.limit, SEARCH_LIMIT),
    });
    return textResult(formatObservationIndex(observations, { query, getTool: 'get' }));
  }
  if (name === 'context') {
    const query = requireString(args, 'query');
    const observations = await backend.context({
      projectId: requireString(args, 'projectId'),
      query,
      limit: clampLimit(args.limit, CONTEXT_LIMIT),
    });
    return textResult(formatObservationContext(observations, { query, getTool: 'get' }));
  }
  if (name === 'recent') {
    const observations = await backend.recent({
      projectId: requireString(args, 'projectId'),
      limit: clampLimit(args.limit, RECENT_LIMIT),
    });
    return textResult(formatObservationIndex(observations, { query: '', getTool: 'get' }));
  }
  if (name === 'get') {
    const ids = requireIds(args);
    const observations = await backend.get({ projectId: requireString(args, 'projectId'), ids });
    return textResult(formatObservationDetails(observations, ids));
  }
  throw new Error(`Unknown tool: ${name}`);
}

/**
 * Build a read-only recall MCP server bound to `backend`. The caller owns the
 * transport (stdio in the CLI, streamable-HTTP in Server Beta).
 */
export function createRecallMcpServer(backend: RecallBackend, version: string): Server {
  const server = new Server(
    { name: 'memsmith', version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return await dispatchToolCall(backend, name, args);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('SYSTEM', 'recall MCP tool call failed', { tool: name }, err);
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  });

  return server;
}

export const RECALL_MCP_TOOLS = TOOLS;
