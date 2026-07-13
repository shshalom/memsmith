import { describe, it, expect } from 'bun:test';
import {
  packRecentContext,
  fetchRecentContextString,
  RECENT_INJECTION_LIMIT,
} from '../../../src/services/hooks/recent-context-injection.js';
import type { RuntimeContext } from '../../../src/services/hooks/runtime-selector.js';

// Worker retirement (dead-route sweep) — the shared recent-mode injection helper
// replaces the deleted worker route `/api/context/inject` for every non-hook
// consumer (transcript-watcher AGENTS.md, Cursor install preview). Same rigor as
// the C1 SessionStart test: prove it returns REAL packed context when
// observations exist, uses recent-mode (empty query) scoped to the project, and
// gracefully returns '' when no server runtime is reachable / nothing to inject.

function serverRuntime(
  searchObservations: (input: any) => Promise<any>,
): RuntimeContext {
  return {
    runtime: 'server',
    projectId: 'proj',
    serverBaseUrl: 'http://127.0.0.1:1',
    // Only searchObservations is exercised by the helper.
    client: { searchObservations } as any,
  };
}

describe('packRecentContext', () => {
  it('packs observation content and queries in recent-mode (empty query) for the project scope', async () => {
    const seen: any[] = [];
    const runtime = serverRuntime(async (input) => {
      seen.push(input);
      return {
        observations: [
          { id: 'o1', content: 'first memory' },
          { id: 'o2', content: 'second memory' },
        ],
      };
    });

    const result = await packRecentContext(runtime, {
      projectId: 'my-project',
      platformSource: 'codex',
    });

    expect(result).toBe('first memory\n\nsecond memory');
    expect(seen).toHaveLength(1);
    expect(seen[0].query).toBe('');
    expect(seen[0].projectId).toBe('my-project');
    expect(seen[0].platformSource).toBe('codex');
    expect(seen[0].limit).toBe(RECENT_INJECTION_LIMIT);
  });

  it('filters out empty/non-string contents', async () => {
    const runtime = serverRuntime(async () => ({
      observations: [
        { id: 'o1', content: 'keep' },
        { id: 'o2', content: '' },
        { id: 'o3', content: null },
        { id: 'o4' },
      ],
    }));

    const result = await packRecentContext(runtime, { projectId: 'p' });
    expect(result).toBe('keep');
  });

  it('returns empty string when there are no observations', async () => {
    const runtime = serverRuntime(async () => ({ observations: [] }));
    expect(await packRecentContext(runtime, { projectId: 'p' })).toBe('');
  });

  it('returns empty string when no server runtime is reachable (local skip)', async () => {
    const local: RuntimeContext = { runtime: 'local', reason: 'server_context_unavailable' };
    expect(await packRecentContext(local, { projectId: 'p' })).toBe('');
  });

  it('never throws — returns empty string when the client rejects', async () => {
    const runtime = serverRuntime(async () => { throw new Error('boom'); });
    expect(await packRecentContext(runtime, { projectId: 'p' })).toBe('');
  });
});

describe('fetchRecentContextString', () => {
  it('resolves the runtime via the injected resolver and packs its result', async () => {
    const runtime = serverRuntime(async () => ({
      observations: [{ id: 'o1', content: 'resolved memory' }],
    }));
    const result = await fetchRecentContextString({ projectId: 'p' }, () => runtime);
    expect(result).toBe('resolved memory');
  });

  it('returns empty string when the resolver yields a local skip context', async () => {
    const result = await fetchRecentContextString(
      { projectId: 'p' },
      () => ({ runtime: 'local', reason: 'server_context_unavailable' }),
    );
    expect(result).toBe('');
  });
});
