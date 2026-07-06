// SPDX-License-Identifier: Apache-2.0
//
// Shared event corpus + context builder for the generation benches
// (reformat-guard stress + quality eval). One source of truth so both harnesses
// exercise the same varied agent activity. No DB — the provider only reads
// context fields to build the prompt.

import { randomUUID } from 'crypto';
import type { ServerGenerationContext } from '../../src/server/generation/providers/shared/types.js';
import type { PostgresAgentEvent } from '../../src/storage/postgres/agent-events.js';
import type { PostgresObservationGenerationJob } from '../../src/storage/postgres/generation-jobs.js';

/** Varied, realistic agent events — one generation context each. */
export const EVENT_PAYLOADS: Array<{ label: string; eventType: string; payload: unknown }> = [
  { label: 'bash-ls', eventType: 'tool_use', payload: { tool: 'Bash', command: 'ls -la src/', output: 'total 48\ndrwxr-xr-x  server\ndrwxr-xr-x  storage' } },
  { label: 'edit-auth', eventType: 'tool_use', payload: { tool: 'Edit', file: 'src/auth/jwt.ts', diff: '- verifyToken(t)\n+ verifyToken(t, { clockTolerance: 30 })' } },
  { label: 'decision-db', eventType: 'assistant_response', payload: { content: 'Chose Postgres over SQLite for the server runtime because we need concurrent multi-writer access and pgvector. Rejected SQLite (single-writer) and DynamoDB (no vector search).' } },
  { label: 'bugfix-race', eventType: 'assistant_response', payload: { content: 'Fixed a race in the connection pool: two workers could claim the same queued job. Added SELECT ... FOR UPDATE SKIP LOCKED.' } },
  { label: 'read-config', eventType: 'tool_use', payload: { tool: 'Read', file: 'package.json', snippet: '"dependencies": { "pg": "^8", "bullmq": "^5" }' } },
  { label: 'grep-search', eventType: 'tool_use', payload: { tool: 'Grep', pattern: 'markGenerationFailed', matches: 3 } },
  { label: 'trivial-noop', eventType: 'tool_use', payload: { tool: 'Bash', command: 'echo hi', output: 'hi' } },
  { label: 'blocker', eventType: 'assistant_response', payload: { content: 'Blocked: the embedder model download times out behind the corporate proxy. Need an allowlist entry for huggingface.co or a pre-baked model cache.' } },
  { label: 'multi-file-refactor', eventType: 'assistant_response', payload: { content: 'Refactored the three v1 read endpoints to share a resolveSearchResults helper so ranking lives in one place. Touched ServerV1PostgresRoutes.ts search/context/mcp paths.' } },
  { label: 'prompt', eventType: 'user_prompt', payload: { content: 'why is the search returning stale results after I delete an observation?' } },
];

/** Build an in-memory ServerGenerationContext for one event (no DB rows). */
export function makeContext(payload: unknown, eventType: string): ServerGenerationContext {
  const projectId = randomUUID();
  const teamId = randomUUID();
  const now = Date.now();
  const event: PostgresAgentEvent = {
    id: randomUUID(),
    projectId,
    teamId,
    serverSessionId: null,
    sourceAdapter: 'bench',
    sourceEventId: null,
    idempotencyKey: randomUUID(),
    eventType,
    platformSource: null,
    payload: payload as PostgresAgentEvent['payload'],
    metadata: {},
    occurredAtEpoch: now,
    receivedAtEpoch: now,
    createdAtEpoch: now,
  };
  const job = {
    id: randomUUID(),
    projectId,
    teamId,
    sourceType: 'agent_event',
    sourceId: event.id,
    agentEventId: event.id,
    serverSessionId: null,
    jobType: 'generate_observations',
    status: 'processing',
  } as unknown as PostgresObservationGenerationJob;
  return { job, events: [event], project: { projectId, teamId, serverSessionId: null, projectName: 'bench' } };
}
