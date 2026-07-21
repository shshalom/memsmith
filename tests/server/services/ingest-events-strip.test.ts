// tests/server/services/ingest-events-strip.test.ts
import { describe, it, expect } from 'bun:test';
import { IngestEventsService } from '../../../src/server/services/IngestEventsService.js';

// A pool whose transaction hands a client to the callback; the fake
// PostgresAgentEventsRepository is not used — instead we capture the payload
// the service would persist by stubbing withPostgresTransaction indirectly.
// Simplest: spy on scrubEventPayload's effect by giving the service a fake
// pool and asserting eventsRepo.create sees a scrubbed payload.
//
// Query sequence inside eventsRepo.create:
//   1. assertProjectOwnership — SELECT id FROM projects WHERE id=$1 AND team_id=$2  (2 params)
//   2. INSERT INTO agent_events ... VALUES ($1..$12) — payload is JSON.stringify at $10 (index 9)
// We must handle both without crashing.

function makeCapturingPool(captured: { payload?: unknown }) {
  return {
    async connect() {
      return {
        query: async (sql: string, params?: unknown[]) => {
          // Project-ownership SELECT: return a fake project row so the check passes.
          if (sql.includes('FROM projects')) {
            return { rows: [{ id: params?.[0] }] };
          }
          // agent_events INSERT: payload is JSON.stringify(input.payload) at $10 (index 9).
          if (sql.includes('INSERT INTO agent_events') && params && params.length >= 10) {
            captured.payload = JSON.parse(params[9] as string);
            return {
              rows: [{
                id: 'e1', project_id: 'p1', team_id: 't1', server_session_id: null,
                source_adapter: 'hook', source_event_id: null, idempotency_key: 'k1',
                event_type: 'tool_use', platform_source: null,
                payload: captured.payload,
                metadata: {}, occurred_at: new Date(),
                received_at: new Date(), created_at: new Date(),
              }],
            };
          }
          // Any other query: return empty rows.
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

describe('IngestEventsService server-side private strip', () => {
  it('scrubs <private> from the payload before persisting to agent_events', async () => {
    const captured: { payload?: unknown } = {};
    const service = new IngestEventsService({
      pool: makeCapturingPool(captured) as never,
      resolveEventQueue: () => null,
    });
    await service.ingestOne(
      {
        projectId: 'p1', teamId: 't1', sourceAdapter: 'hook',
        eventType: 'tool_use', occurredAt: Date.now(),
        payload: { tool_response: 'ok <private>LEAK_ME</private>' },
      } as never,
      { generate: false },
    );
    expect(JSON.stringify(captured.payload)).not.toContain('LEAK_ME');
    expect(JSON.stringify(captured.payload)).toContain('ok');
  });
});
