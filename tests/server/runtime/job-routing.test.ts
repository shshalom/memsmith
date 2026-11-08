import { describe, it, expect } from 'bun:test';
import { classifyJobRoute } from '../../../src/server/runtime/job-routing.js';
import type { DrainableJob } from '../../../src/server/runtime/generation-drain.js';

const payload = (over: Record<string, unknown> = {}) => ({
  kind: 'event', source_type: 'agent_event', source_id: 'e1', generation_job_id: 'j1',
  team_id: 't', project_id: 'proj', actor_id: null, source_adapter: 'test', agent_event_id: 'e1',
  api_key_id: null, ...over,
});
const job = (p: unknown, id = 'j1'): DrainableJob => ({
  id, jobType: 'observation', projectId: 'proj', teamId: 't', agentEventId: null, sourceType: null,
  sourceId: null, serverSessionId: null, payload: p, bullmqJobId: id,
});

const base = { name: 'base' };
const projectPool = { name: 'project' };
const ctx = (getPool: (() => Promise<unknown>) | null, baseProjectId: string | null = 'base-proj') =>
  ({ basePool: base, baseProjectId, getPool: getPool as never });

describe('classifyJobRoute', () => {
  it('rejects an invalid payload', async () => {
    expect(await classifyJobRoute(base, job({}), ctx(null))).toBe('unrunnable');
  });

  it('rejects a payload whose generation_job_id differs from the row id', async () => {
    expect(await classifyJobRoute(base, job(payload({ generation_job_id: 'other' })), ctx(null))).toBe('unrunnable');
  });

  it('accepts a base-project job in the base pool and rejects it in another pool', async () => {
    const j = job(payload({ project_id: 'base-proj' }));
    expect(await classifyJobRoute(base, j, ctx(async () => projectPool))).toBe('runnable');
    expect(await classifyJobRoute(projectPool, j, ctx(async () => projectPool))).toBe('unrunnable');
  });

  it('accepts a project job in its own pool and rejects it in the base pool', async () => {
    const c = ctx(async () => projectPool);
    expect(await classifyJobRoute(projectPool, job(payload()), c)).toBe('runnable');
    expect(await classifyJobRoute(base, job(payload()), c)).toBe('unrunnable');
  });

  it('treats every job as a base-pool job when no registry is wired', async () => {
    expect(await classifyJobRoute(base, job(payload()), ctx(null))).toBe('runnable');
  });

  it('reports unknown when the pool lookup throws', async () => {
    const c = ctx(async () => { throw new Error('db down'); });
    expect(await classifyJobRoute(projectPool, job(payload()), c)).toBe('unknown');
  });
});
