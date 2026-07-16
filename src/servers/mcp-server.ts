
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

import { logger } from '../utils/logger.js';

console['log'] = (...args: any[]) => {
  logger.error('CONSOLE', 'Intercepted console output (MCP protocol protection)', undefined, { args });
};

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { searchCodebase, formatSearchResults } from '../services/smart-file-read/search.js';
import { parseFile, formatFoldedView, unfoldSymbol } from '../services/smart-file-read/parser.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  ServerClientError,
  isServerClientError,
  type ServerAddObservationRequest,
  type ServerContextObservationsRequest,
  type ServerRecordEventRequest,
  type ServerSearchObservationsRequest,
} from '../services/hooks/server-client.js';
import {
  selectRuntime,
  buildServerContext,
  type SelectedRuntime,
  type ServerRuntimeContext,
} from '../services/hooks/runtime-selector.js';
import { normalizePlatformSource } from '../shared/platform-source.js';

// C3 (worker retirement) — the old callWorker helper and its worker-utils HTTP
// import were removed. Every legit caller now routes through the `/v1` server via
// ServerClient (see requireServerForObservationTool + handle* below); the relic
// worker-route tools (search/timeline/get_observations/corpus family) were deleted.


// Phase 8 — runtime selection for MCP tools.
// In server mode, observation_* tools talk to the server `/v1`
// endpoints via the SAME ServerClient hooks use. This guarantees we
// share the REST core for writes and searches; we never duplicate the
// event-insert + outbox + enqueue logic on the MCP side.
//
// We deliberately resolve the runtime per-call (cheap; reads cached
// settings) so the user can flip MEMSMITH_RUNTIME without restarting
// the MCP server.
type ServerToolContext = ServerRuntimeContext;

interface ServerUnavailable {
  // Task 8: both 'local' and 'server' use the server-context path; the
  // runtime literal here reflects whichever is active.
  runtime: SelectedRuntime;
  available: false;
  reason: string;
}

interface ServerAvailable extends ServerToolContext {
  available: true;
}

type ServerResolution = ServerAvailable | ServerUnavailable;

function resolveServerToolContext(): ServerResolution {
  // Task 8: both 'local' and 'server' reach the engine over HTTP.
  // In 'local' mode the embedded PG server runs in-process and
  // MEMSMITH_SERVER_URL points at it — so the same buildServerContext()
  // path works for both.  There is no worker fallback for either runtime.
  const runtime: SelectedRuntime = selectRuntime();
  const ctx = buildServerContext();
  if (!ctx) {
    return {
      runtime,
      available: false,
      reason: `${runtime} runtime is selected but configuration is incomplete (missing url, api key, or project id)`,
    };
  }
  return { ...ctx, available: true };
}

function formatToolError(error: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  if (isServerClientError(error)) {
    return {
      content: [{
        type: 'text' as const,
        text: `Server error (${error.kind}${error.status ? ` ${error.status}` : ''}): ${error.message}`,
      }],
      isError: true as const,
    };
  }
  return {
    content: [{
      type: 'text' as const,
      text: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
    }],
    isError: true as const,
  };
}

function formatJsonResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(payload, null, 2),
    }],
  };
}

function requireServerForObservationTool(toolName: string): ServerAvailable {
  // Task 8: resolveServerToolContext() never returns null — both 'local' and
  // 'server' use the server-context path.  A missing/incomplete configuration
  // produces a ServerUnavailable result (available: false) which surfaces the
  // existing "requires a running runtime" style error below.
  const resolution = resolveServerToolContext();
  if (!resolution.available) {
    throw new ServerClientError('missing_api_key', `${toolName}: ${resolution.reason}`);
  }
  return resolution;
}

function wrapHandler<Args>(
  toolName: string,
  execute: (args: Args) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
): (args: Args) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return async (args: Args) => {
    try {
      return await execute(args);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('SYSTEM', `${toolName} failed`, undefined, err);
      return formatToolError(error);
    }
  };
}

interface ObservationAddArgs {
  projectId?: string;
  serverSessionId?: string | null;
  kind?: string;
  content: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

const handleObservationAdd = wrapHandler('observation_add', async (args: ObservationAddArgs) => {
  const ctx = requireServerForObservationTool('observation_add');
  if (typeof args?.content !== 'string' || args.content.trim().length === 0) {
    throw new Error('observation_add: "content" is required');
  }
  const projectId = args.projectId && args.projectId.trim().length > 0 ? args.projectId : ctx.projectId;
  const request: ServerAddObservationRequest = {
    projectId,
    content: args.content,
    ...(args.serverSessionId !== undefined ? { serverSessionId: args.serverSessionId } : {}),
    ...(args.kind !== undefined ? { kind: args.kind } : {}),
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
    ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
  };
  const response = await ctx.client.addObservation(request);
  return formatJsonResult(response);
});

interface ObservationRecordEventArgs {
  projectId?: string;
  serverSessionId?: string | null;
  contentSessionId?: string | null;
  memorySessionId?: string | null;
  platformSource?: string | null;
  sourceType?: 'hook' | 'worker' | 'provider' | 'server' | 'api';
  eventType: string;
  payload?: unknown;
  occurredAtEpoch?: number;
  generate?: boolean;
}

function normalizeMcpPlatformSource(value: string | null): string | null {
  return typeof value === 'string' ? normalizePlatformSource(value) : null;
}

const handleObservationRecordEvent = wrapHandler('observation_record_event', async (args: ObservationRecordEventArgs) => {
  const ctx = requireServerForObservationTool('observation_record_event');
  if (typeof args?.eventType !== 'string' || args.eventType.trim().length === 0) {
    throw new Error('observation_record_event: "eventType" is required');
  }
  const projectId = args.projectId && args.projectId.trim().length > 0 ? args.projectId : ctx.projectId;
  const request: ServerRecordEventRequest = {
    projectId,
    sourceType: args.sourceType ?? 'api',
    eventType: args.eventType,
    occurredAtEpoch: typeof args.occurredAtEpoch === 'number' ? args.occurredAtEpoch : Date.now(),
    ...(args.serverSessionId !== undefined ? { serverSessionId: args.serverSessionId } : {}),
    ...(args.contentSessionId !== undefined ? { contentSessionId: args.contentSessionId } : {}),
    ...(args.memorySessionId !== undefined ? { memorySessionId: args.memorySessionId } : {}),
    ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
    ...(args.payload !== undefined ? { payload: args.payload } : {}),
    ...(args.generate !== undefined ? { generate: args.generate } : {}),
  };
  const response = await ctx.client.recordEvent(request);
  return formatJsonResult(response);
});

interface ObservationSearchArgs {
  projectId?: string;
  query: string;
  limit?: number;
  platformSource?: string | null;
}

const handleObservationSearch = wrapHandler('observation_search', async (args: ObservationSearchArgs) => {
  const ctx = requireServerForObservationTool('observation_search');
  if (typeof args?.query !== 'string' || args.query.trim().length === 0) {
    throw new Error('observation_search: "query" is required');
  }
  const projectId = args.projectId && args.projectId.trim().length > 0 ? args.projectId : ctx.projectId;
  const request: ServerSearchObservationsRequest = {
    projectId,
    query: args.query,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
  };
  const response = await ctx.client.searchObservations(request);
  return formatJsonResult(response);
});

interface ObservationContextArgs {
  projectId?: string;
  query: string;
  limit?: number;
  platformSource?: string | null;
}

const handleObservationContext = wrapHandler('observation_context', async (args: ObservationContextArgs) => {
  const ctx = requireServerForObservationTool('observation_context');
  if (typeof args?.query !== 'string' || args.query.trim().length === 0) {
    throw new Error('observation_context: "query" is required');
  }
  const projectId = args.projectId && args.projectId.trim().length > 0 ? args.projectId : ctx.projectId;
  const request: ServerContextObservationsRequest = {
    projectId,
    query: args.query,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
  };
  const response = await ctx.client.contextObservations(request);
  return formatJsonResult(response);
});

interface ObservationGenerationStatusArgs {
  jobId?: string;
  job_id?: string;
}

interface SessionStartContextArgs {
  project?: string;
  projects?: string[] | string;
  platformSource?: string | null;
  full?: boolean;
  colors?: boolean;
}

function normalizeProjectsArg(args: SessionStartContextArgs): string[] {
  if (Array.isArray(args.projects)) {
    return args.projects
      .map(project => typeof project === 'string' ? project.trim() : '')
      .filter(Boolean);
  }
  if (typeof args.projects === 'string') {
    return args.projects
      .split(',')
      .map(project => project.trim())
      .filter(Boolean);
  }
  if (typeof args.project === 'string' && args.project.trim().length > 0) {
    return [args.project.trim()];
  }
  return [];
}

// C2 (worker retirement) — the Codex injection path routes SessionStart context
// through this MCP tool (see cli/handlers/context.ts). The worker route
// `/api/context/inject` it used to call was deleted, so this now pulls recent
// project context off the SAME server/local runtime the observation_* tools use.
//
// Injection is NOT query-driven at SessionStart: we request the most recent
// observations for the project scope via the server's empty-query "list recent"
// mode (POST /v1/search with query='') and pack their content into a string the
// same way POST /v1/context does (`content.join('\n\n')`). Returns the joined
// text (never throws — errors surface as an MCP isError result via wrapHandler).
const SESSION_START_RECENT_LIMIT = 10;

const handleSessionStartContext = wrapHandler('session_start_context', async (args: SessionStartContextArgs) => {
  const projects = normalizeProjectsArg(args);
  if (projects.length === 0) {
    throw new Error('session_start_context: "project" or "projects" is required');
  }
  const ctx = requireServerForObservationTool('session_start_context');
  // Last project in the chain is the primary scope (matches the hook contract).
  const projectId = projects[projects.length - 1];
  const response = await ctx.client.searchObservations({
    projectId,
    query: '', // empty query = "list recent" (ServerV1PostgresRoutes /v1/search)
    limit: SESSION_START_RECENT_LIMIT,
    ...(args.platformSource !== undefined ? { platformSource: normalizeMcpPlatformSource(args.platformSource) } : {}),
  });
  const observations = Array.isArray(response?.observations) ? response.observations : [];
  const context = observations
    .map(observation => observation.content)
    .filter((text): text is string => typeof text === 'string' && text.length > 0)
    .join('\n\n');
  return { content: [{ type: 'text' as const, text: context }] };
});

const handleObservationGenerationStatus = wrapHandler('observation_generation_status', async (args: ObservationGenerationStatusArgs) => {
  const ctx = requireServerForObservationTool('observation_generation_status');
  const jobId = (args?.jobId ?? args?.job_id ?? '').trim();
  if (!jobId) {
    throw new Error('observation_generation_status: "jobId" is required');
  }
  const response = await ctx.client.getJobStatus(jobId);
  return formatJsonResult(response);
});


const tools = [
  {
    name: '__IMPORTANT',
    description: `MEMORY RECALL WORKFLOW (ALWAYS FOLLOW):
1. observation_search(query) → Full-text index of matching observations
2. observation_context(query) → Top-N relevant observations + a packed context string ready for injection
Both are backed by the live server (/v1). Prefer observation_context when you want ready-to-use context.`,
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => ({
      content: [{
        type: 'text' as const,
        text: `# Memory Recall Workflow

**Backed by the live server (/v1). Two tools:**

1. **observation_search** - Full-text search across generated observations
   \`observation_search(query="...", limit=20, projectId="...")\`
   Returns: matching observations (FTS/hybrid ranked)

2. **observation_context** - Top-N relevant observations for injection
   \`observation_context(query="...", limit=10, projectId="...")\`
   Returns: matched observations AND a pre-joined context string ready to inject

Use observation_context when you want ready-to-use context; observation_search when you want to browse matches.`
      }]
    })
  },
  // C3 (worker retirement) — the `search`, `timeline`, and `get_observations`
  // tools dispatched to deleted worker routes (/api/search, /api/timeline,
  // /api/observations/batch) and failed at runtime. They are removed here; their
  // capability is superseded by observation_search / observation_context, which
  // are backed by the live `/v1` server. No capability is lost.
  {
    name: 'session_start_context',
    description: 'Render the SessionStart context for a project. Pulls recent project observations from the server/local runtime (POST /v1/search, recent mode) and returns the packed context string hooks inject at startup. Params: project OR projects, platformSource.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, e.g. memsmith/night-parsnip' },
        projects: {
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'string' },
          ],
          description: 'Project chain for context injection. Array or comma-separated string; last project is treated as primary.',
        },
        platformSource: { type: 'string', description: 'Optional platform source filter, e.g. claude, codex, cursor' },
        full: { type: 'boolean', description: 'When true, request full context instead of configured limits' },
        colors: { type: 'boolean', description: 'When true, request human terminal-color formatting' },
      },
      additionalProperties: false,
    },
    handler: async (args: any) => handleSessionStartContext(args ?? {}),
  },
  // Phase 8 — observation_* tools backed by server REST core.
  {
    name: 'observation_add',
    description: 'Insert a manual observation directly into server storage. Calls /v1/memories — does NOT enqueue generation. Server runtime only. Params: content (required), projectId (optional, falls back to settings), serverSessionId, kind, metadata, idempotencyKey.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id (falls back to MEMSMITH_SERVER_PROJECT_ID)' },
        serverSessionId: { type: 'string', description: 'Optional server_session_id to attach the observation to' },
        kind: { type: 'string', description: 'Observation kind (default: manual)' },
        content: { type: 'string', description: 'Observation content (required)' },
        metadata: { type: 'object', description: 'Free-form metadata object', additionalProperties: true },
        idempotencyKey: { type: 'string', description: 'Optional idempotency key for deduplication' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    handler: async (args: any) => handleObservationAdd(args ?? {}),
  },
  {
    name: 'observation_record_event',
    description: 'Record an agent event into the server. Calls /v1/events — server inserts the event row, the outbox row, and enqueues a generation job atomically. Server runtime only.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        eventType: { type: 'string', description: 'Event type (required), e.g. PostToolUse, UserPromptSubmit' },
        sourceType: { type: 'string', enum: ['hook', 'worker', 'provider', 'server', 'api'] },
        serverSessionId: { type: 'string' },
        contentSessionId: { type: 'string' },
        memorySessionId: { type: 'string' },
        platformSource: { type: 'string', description: 'Optional platform source for session linkage and event scoping' },
        payload: { description: 'Event payload (any JSON value)' },
        occurredAtEpoch: { type: 'number', description: 'Unix epoch millis (defaults to now)' },
        generate: { type: 'boolean', description: 'If false, skip generation job (default: true)' },
      },
      required: ['eventType'],
      additionalProperties: false,
    },
    handler: async (args: any) => handleObservationRecordEvent(args ?? {}),
  },
  {
    name: 'observation_search',
    description: 'Full-text search across generated observations using the server\'s GIN tsvector index (Phase 1). Calls /v1/search. Server runtime only. Params: query (required), projectId (optional), platformSource, limit (default 20, max 100).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string', description: 'Search query (required)' },
        platformSource: { type: 'string', description: 'Optional platform source filter, e.g. claude, codex, cursor' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args: any) => handleObservationSearch(args ?? {}),
  },
  {
    name: 'observation_context',
    description: 'Get top-N relevant observations for context injection. Returns matched observations AND a pre-joined context string suitable for prompt injection. Calls /v1/context. Server runtime only.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string', description: 'Search query (required)' },
        platformSource: { type: 'string', description: 'Optional platform source filter, e.g. claude, codex, cursor' },
        limit: { type: 'number', description: 'Max observations (default 10, max 50)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args: any) => handleObservationContext(args ?? {}),
  },
  {
    name: 'observation_generation_status',
    description: 'Look up the status of an observation generation job by id. Calls /v1/jobs/:id. Server runtime only. Returns the same payload as REST.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Generation job id (required)' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    handler: async (args: any) => handleObservationGenerationStatus(args ?? {}),
  },
  {
    name: 'smart_search',
    description: 'Search codebase for symbols, functions, classes using tree-sitter AST parsing. Returns folded structural views with token counts. Use path parameter to scope the search.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term — matches against symbol names, file names, and file content'
        },
        path: {
          type: 'string',
          description: 'Root directory to search (default: current working directory)'
        },
        max_results: {
          type: 'number',
          description: 'Maximum results to return (default: 20)'
        },
        file_pattern: {
          type: 'string',
          description: 'Substring filter for file paths (e.g. ".ts", "src/services")'
        }
      },
      required: ['query']
    },
    handler: async (args: any) => {
      const rootDir = resolve(args.path || process.cwd());
      const result = await searchCodebase(rootDir, args.query, {
        maxResults: args.max_results || 20,
        filePattern: args.file_pattern
      });
      const formatted = formatSearchResults(result, args.query);
      return {
        content: [{ type: 'text' as const, text: formatted }]
      };
    }
  },
  {
    name: 'smart_unfold',
    description: 'Expand a specific symbol (function, class, method) from a file. Returns the full source code of just that symbol. Use after smart_search or smart_outline to read specific code.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the source file'
        },
        symbol_name: {
          type: 'string',
          description: 'Name of the symbol to unfold (function, class, method, etc.)'
        }
      },
      required: ['file_path', 'symbol_name']
    },
    handler: async (args: any) => {
      const filePath = resolve(args.file_path);
      const content = await readFile(filePath, 'utf-8');
      const unfolded = unfoldSymbol(content, filePath, args.symbol_name);
      if (unfolded) {
        return {
          content: [{ type: 'text' as const, text: unfolded }]
        };
      }
      const parsed = parseFile(content, filePath);
      if (parsed.symbols.length > 0) {
        const available = parsed.symbols.map(s => `  - ${s.name} (${s.kind})`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: `Symbol "${args.symbol_name}" not found in ${args.file_path}.\n\nAvailable symbols:\n${available}`
          }]
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: `Could not parse ${args.file_path}. File may be unsupported or empty.`
        }]
      };
    }
  },
  {
    name: 'smart_outline',
    description: 'Get structural outline of a file — shows all symbols (functions, classes, methods, types) with signatures but bodies folded. Much cheaper than reading the full file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the source file'
        }
      },
      required: ['file_path']
    },
    handler: async (args: any) => {
      const filePath = resolve(args.file_path);
      const content = await readFile(filePath, 'utf-8');
      const parsed = parseFile(content, filePath);
      if (parsed.symbols.length > 0) {
        return {
          content: [{ type: 'text' as const, text: formatFoldedView(parsed) }]
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: `Could not parse ${args.file_path}. File may use an unsupported language or be empty.`
        }]
      };
    }
  },
  // C3 (worker retirement) — the corpus family (build_corpus, list_corpora,
  // prime_corpus, query_corpus, rebuild_corpus, reprime_corpus) all dispatched to
  // deleted worker `/api/corpus/*` routes and failed at runtime. Removed per the
  // approved ledger decision (relic). Knowledge-corpus functionality is not part
  // of the `/v1` server engine.
];

const server = new Server(
  {
    name: 'memsmith',
    version: packageVersion,
  },
  {
    capabilities: {
      tools: {},  // Exposes tools capability (handled by ListToolsRequestSchema and CallToolRequestSchema)
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name);

  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    return await tool.handler(request.params.arguments || {});
  } catch (error: unknown) {
    logger.error('SYSTEM', 'Tool execution failed', { tool: request.params.name }, error instanceof Error ? error : new Error(String(error)));
    return {
      content: [{
        type: 'text' as const,
        text: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
});

const HEARTBEAT_INTERVAL_MS = 30_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let isCleaningUp = false;

function handleStdioClosed() {
  cleanup('stdio-closed');
}

function handleStdioError(error: Error) {
  logger.warn('SYSTEM', 'MCP stdio stream errored, shutting down', {
    message: error.message
  });
  cleanup('stdio-error');
}

function attachStdioLifecycle() {
  process.stdin.on('end', handleStdioClosed);
  process.stdin.on('close', handleStdioClosed);
  process.stdin.on('error', handleStdioError);
}

function detachStdioLifecycle() {
  process.stdin.off('end', handleStdioClosed);
  process.stdin.off('close', handleStdioClosed);
  process.stdin.off('error', handleStdioError);
}

function startParentHeartbeat() {
  if (process.platform === 'win32') return;

  const initialPpid = process.ppid;
  heartbeatTimer = setInterval(() => {
    if (process.ppid === 1 || process.ppid !== initialPpid) {
      logger.info('SYSTEM', 'Parent process died, self-exiting to prevent orphan', {
        initialPpid,
        currentPpid: process.ppid
      });
      cleanup();
    }
  }, HEARTBEAT_INTERVAL_MS);

  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function cleanup(reason: string = 'shutdown') {
  if (isCleaningUp) return;
  isCleaningUp = true;

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  detachStdioLifecycle();
  logger.info('SYSTEM', 'MCP server shutting down', { reason });
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

function detectMissingMarketplaceMarker(): void {
  const home = homedir();
  const marketplaceCandidates = [
    resolve(home, '.claude', 'plugins', 'marketplaces', 'shshalom'),
    resolve(home, '.config', 'claude', 'plugins', 'marketplaces', 'shshalom'),
  ];
  const present = marketplaceCandidates.some(p => p && existsSync(p));
  const cacheCandidates = [
    resolve(home, '.claude', 'plugins', 'cache', 'shshalom', 'memsmith'),
    resolve(home, '.config', 'claude', 'plugins', 'cache', 'shshalom', 'memsmith'),
  ];
  const cachePresent = cacheCandidates.some(p => p && existsSync(p));
  const cacheRoot = cacheCandidates[0];

  if (!present && cachePresent) {
    logger.error(
      'SYSTEM',
      'memsmith MCP started but no marketplace directory was found at ~/.claude/plugins/marketplaces/shshalom or the XDG equivalent. The IDE plugin loader needs that directory to fire memsmith hooks (SessionStart, PostToolUse, Stop, etc.). Without it, MCP search will work but no new memories will be captured. To self-heal, run: node ~/.claude/plugins/cache/shshalom/memsmith/*/scripts/smart-install.js (or reinstall the plugin from the marketplace).',
      { marketplaceCandidates, cacheRoot }
    );
  }
}

function checkMarketplaceMarker(): void {
  try {
    detectMissingMarketplaceMarker();
  } catch (error) {
    logger.warn('SYSTEM', 'checkMarketplaceMarker failed (non-fatal startup check)', undefined, error instanceof Error ? error : new Error(String(error)));
  }
}

async function main() {
  const transport = new StdioServerTransport();
  attachStdioLifecycle();
  await server.connect(transport);
  logger.info('SYSTEM', 'MemSmith search server started');

  checkMarketplaceMarker();

  startParentHeartbeat();

  setTimeout(() => {
    // Task 8 — selectRuntime() now returns 'local' | 'server' only; the worker
    // runtime is retired.  Both 'local' and 'server' talk to the engine over
    // HTTP (local's embedded PG server runs in-process with MEMSMITH_SERVER_URL
    // pointing at it), so MCP must NEVER auto-spawn a worker for either.
    const runtime = selectRuntime();
    logger.info('SYSTEM', `MCP runtime=${runtime} — skipping worker auto-start`, undefined, {});
  }, 0);
}

main().catch((error) => {
  logger.error('SYSTEM', 'Fatal error', undefined, error);
  process.exit(0);
});
