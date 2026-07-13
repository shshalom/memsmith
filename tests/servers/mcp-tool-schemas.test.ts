import { describe, it, expect } from 'bun:test';

const mcpServerPath = new URL('../../src/servers/mcp-server.ts', import.meta.url).pathname;

describe('MCP tool inputSchema declarations', () => {
  let tools: any[];

  // C3 (worker retirement) — the relic worker-route tools were deleted. These
  // guards assert they are gone from the tool registrations (no ListTools entry)
  // and that no worker dispatch remains.
  it('relic worker-route tools (search/timeline/get_observations) are removed', async () => {
    const src = await Bun.file(mcpServerPath).text();
    expect(src).not.toContain("name: 'search'");
    expect(src).not.toContain("name: 'timeline'");
    expect(src).not.toContain("name: 'get_observations'");
  });

  it('corpus family tools are removed', async () => {
    const src = await Bun.file(mcpServerPath).text();
    for (const name of ['build_corpus', 'list_corpora', 'prime_corpus', 'query_corpus', 'rebuild_corpus', 'reprime_corpus']) {
      expect(src).not.toContain(`name: '${name}'`);
    }
  });

  it('callWorker and worker dispatch are gone from the MCP server', async () => {
    const src = await Bun.file(mcpServerPath).text();
    // No live callWorker function/dispatch and no workerHttpRequest import.
    // Comments mentioning the retired routes are fine (grep-clean allows
    // comments); a live `callWorker(` call or the worker-utils import is not.
    expect(src).not.toContain('async function callWorker');
    expect(src).not.toContain('callWorker(');
    expect(src).not.toContain('workerHttpRequest');
  });

  it('session_start_context is repointed to the runtime (no worker route)', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const section = src.slice(
      src.indexOf("name: 'session_start_context'"),
      src.indexOf("name: 'observation_add'"),
    );
    // No worker route; wired to the runtime handler and recent-mode search.
    expect(section).not.toContain('/api/context/inject');
    expect(section).toContain('handleSessionStartContext');
    expect(section).toContain('project:');
    expect(section).toContain('projects:');
    expect(section).toContain('platformSource:');
    // The handler pulls recent observations via searchObservations (recent mode).
    const handler = src.slice(
      src.indexOf('const handleSessionStartContext'),
      src.indexOf('const handleObservationGenerationStatus'),
    );
    expect(handler).toContain('searchObservations');
    expect(handler).toContain("query: ''");
  });

  // Phase 8 — observation_* tools backed by server-beta REST core.
  it('observation_add tool declares content as required', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const section = src.slice(
      src.indexOf("name: 'observation_add'"),
      src.indexOf("name: 'observation_record_event'"),
    );
    expect(section).toContain('content:');
    expect(section).toContain("required: ['content']");
    expect(section).toContain('handleObservationAdd');
  });

  it('observation_record_event declares eventType as required', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const section = src.slice(
      src.indexOf("name: 'observation_record_event'"),
      src.indexOf("name: 'observation_search'"),
    );
    expect(section).toContain('eventType:');
    expect(section).toContain('platformSource:');
    expect(section).toContain("required: ['eventType']");
    expect(section).toContain('handleObservationRecordEvent');
  });

  it('observation_search declares query as required and accepts limit', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const section = src.slice(
      src.indexOf("name: 'observation_search'"),
      src.indexOf("name: 'observation_context'"),
    );
    expect(section).toContain('query:');
    expect(section).toContain('platformSource:');
    expect(section).toContain('limit:');
    expect(section).toContain("required: ['query']");
    expect(section).toContain('handleObservationSearch');
  });

  it('observation_context declares query as required and exposes a limit cap', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const section = src.slice(
      src.indexOf("name: 'observation_context'"),
      src.indexOf("name: 'observation_generation_status'"),
    );
    expect(section).toContain("required: ['query']");
    expect(section).toContain('platformSource:');
    expect(section).toContain('handleObservationContext');
  });

  it('observation_generation_status declares jobId as required', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const section = src.slice(src.indexOf("name: 'observation_generation_status'"));
    expect(section).toContain('jobId:');
    expect(section).toContain("required: ['jobId']");
    expect(section).toContain('handleObservationGenerationStatus');
  });

  it('server-beta observation MCP handlers normalize platformSource args', async () => {
    const src = await Bun.file(mcpServerPath).text();
    const handlers = src.slice(
      src.indexOf('function normalizeMcpPlatformSource'),
      src.indexOf('interface ObservationGenerationStatusArgs'),
    );
    expect(src).toContain("import { normalizePlatformSource } from '../shared/platform-source.js'");
    expect(handlers).toContain('normalizePlatformSource(value)');
    expect(handlers).toContain('platformSource: normalizeMcpPlatformSource(args.platformSource)');
  });

  it('mcp-server skips worker auto-start for both local and server runtimes (anti-pattern guard)', async () => {
    const src = await Bun.file(mcpServerPath).text();
    // Task 8: selectRuntime() now returns 'local' | 'server' only; the worker is
    // retired.  The gate unconditionally skips worker auto-start for every runtime.
    expect(src).toContain('selectRuntime()');
    expect(src).toContain('skipping worker auto-start');
    // Ensure ensureWorkerStarted / worker-spawner is gone.
    expect(src).not.toContain('ensureWorkerStarted');
    expect(src).not.toContain('worker-spawner');
  });

  it('mcp-server does NOT import WorkerService (anti-pattern guard, plan line 772)', async () => {
    const src = await Bun.file(mcpServerPath).text();
    expect(src).not.toMatch(/from\s+['"][^'"]*WorkerService[^'"]*['"]/);
    expect(src).not.toMatch(/import\s+\{[^}]*WorkerService[^}]*\}/);
  });
});
