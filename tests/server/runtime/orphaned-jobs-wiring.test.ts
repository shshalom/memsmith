import { describe, it, expect, afterEach, jest } from 'bun:test';
import { createServerService } from '../../../src/server/runtime/create-server-service.js';
import { ActiveServerGenerationWorkerManager } from '../../../src/server/runtime/ActiveServerGenerationWorkerManager.js';

const PAYLOAD = {
  kind: 'event', source_type: 'agent_event', source_id: 'e1', generation_job_id: 'orphan-1', team_id: 't', project_id: 'p',
  actor_id: null, source_adapter: 'test', agent_event_id: 'e1', api_key_id: null,
};

const flush = async () => { for (let i = 0; i < 50; i += 1) await Promise.resolve(); };

describe('createServerService orphaned-job sweep', () => {
  const prevUrl = process.env.MEMSMITH_SERVER_DATABASE_URL;
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.MEMSMITH_LOCAL_DEV_TEAM_ID;
    delete process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID;
    if (prevUrl === undefined) delete process.env.MEMSMITH_SERVER_DATABASE_URL;
    else process.env.MEMSMITH_SERVER_DATABASE_URL = prevUrl;
  });

  it('requeues an orphaned job even while the boot drain keeps reloading a permanent row', async () => {
    delete process.env.MEMSMITH_SERVER_DATABASE_URL;
    process.env.MEMSMITH_LOCAL_DEV_TEAM_ID = 't';
    process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID = 'p';
    jest.useFakeTimers();
    const published: Array<{ lane: string; id: string }> = [];
    const queue = (lane: string) => ({
      add: async (id: string) => { published.push({ lane: `${lane}:add`, id }); },
      addRecovery: async (id: string) => { published.push({ lane: `${lane}:recovery`, id }); },
      observe: () => {},
      getRecoveryWaitingCount: () => 0,
      getWaitingCount: () => 0,
    });
    const queueManager = {
      start: () => {}, getQueue: (k: string) => queue(k), close: async () => {},
    };
    const jobRow = {
      id: 'orphan-1', job_type: 'observation', project_id: 'p', team_id: 't',
      payload: PAYLOAD, bullmq_job_id: 'orphan-1',
    };
    let claimed = false;
    const pool = {
      query: async (text: string) => {
        if (text.includes('(attempts = 0 OR next_attempt_at IS NULL)')) {
          if (claimed) return { rows: [] };
          claimed = true;
          return { rows: [jobRow] };
        }
        if (/FROM observation_generation_jobs\s+WHERE status = 'queued'\s+AND attempts < max_attempts\s+ORDER BY created_at/.test(text)) {
          return { rows: [{ ...jobRow, id: 'permanent', bullmq_job_id: 'permanent', payload: { ...PAYLOAD, generation_job_id: 'permanent' } }] };
        }
        return { rows: [] };
      },
      connect: async () => { throw new Error('unused'); },
      end: async () => {},
    };
    const worker = new ActiveServerGenerationWorkerManager({
      pool: pool as never, queueManager: queueManager as never, provider: {} as never,
      generatorFactory: (() => ({ process: async () => ({}) })) as never,
    });

    await createServerService({
      pool: pool as never, skipEnvValidation: true, bootstrapSchema: false,
      queueManager: queueManager as never, generationWorkerManager: worker,
    });
    await flush();
    for (let i = 0; i < 8; i += 1) { jest.advanceTimersByTime(5_000); await flush(); }

    expect(published.filter((p) => p.id === 'orphan-1')).toEqual([{ lane: 'event:recovery', id: 'orphan-1' }]);
  });

  it('screens the boot drain batch and honors backoff after the first batch', async () => {
    delete process.env.MEMSMITH_SERVER_DATABASE_URL;
    process.env.MEMSMITH_LOCAL_DEV_TEAM_ID = 't';
    process.env.MEMSMITH_LOCAL_DEV_PROJECT_ID = 'p';
    jest.useFakeTimers();
    const published: string[] = [];
    const queue = {
      add: async (id: string) => { published.push(id); },
      addRecovery: async (id: string) => { published.push(id); },
      observe: () => {},
      getRecoveryWaitingCount: () => 0,
      getWaitingCount: () => 0,
    };
    const queueManager = { start: () => {}, getQueue: () => queue, close: async () => {} };
    const row = (id: string, payload: unknown) => ({
      id, job_type: 'observation', project_id: 'p', team_id: 't', payload, bullmq_job_id: id,
    });
    const bootQueries: string[] = [];
    const failed: unknown[][] = [];
    const pool = {
      query: async (text: string, values: unknown[] = []) => {
        if (/SET status = 'failed'/.test(text)) { failed.push(values); return { rows: [] }; }
        if (/WHERE status = 'queued'\s+AND attempts < max_attempts(\s|\S)*ORDER BY created_at/.test(text)
          && !text.includes('UPDATE')) {
          bootQueries.push(text);
          return { rows: [row('bad-payload', {}), row('good', { ...PAYLOAD, generation_job_id: 'good' })] };
        }
        return { rows: [] };
      },
      connect: async () => { throw new Error('unused'); },
      end: async () => {},
    };
    const worker = new ActiveServerGenerationWorkerManager({
      pool: pool as never, queueManager: queueManager as never, provider: {} as never,
      generatorFactory: (() => ({ process: async () => ({}) })) as never,
    });

    await createServerService({
      pool: pool as never, skipEnvValidation: true, bootstrapSchema: false,
      queueManager: queueManager as never, generationWorkerManager: worker,
    });
    await flush();
    for (let i = 0; i < 3; i += 1) { jest.advanceTimersByTime(5_000); await flush(); }

    expect(published.every((id) => id === 'good')).toBe(true);
    expect(published.length).toBeGreaterThan(1);
    expect(failed[0]![0]).toEqual(['bad-payload']);
    expect(bootQueries[0]).not.toContain('next_attempt_at');
    expect(bootQueries[1]).toContain('(next_attempt_at IS NULL OR next_attempt_at <= now())');
  });
});
