import { afterEach, describe, expect, it } from 'bun:test';
import { defaultMemoryCommandDeps, runMemoryGet, runMemorySearch, type MemoryCommandDeps } from '../../src/npx-cli/commands/memory.js';
import { ServerClientError } from '../../src/services/hooks/server-client.js';

const ROW = {
  id: 'obs-1',
  projectId: 'proj-1',
  kind: 'observation',
  obsType: 'decision',
  content: 'Start-at-login design\nOne-shot login entry with no supervision.',
  createdAtEpoch: Date.UTC(2026, 10, 5),
};

function fake(opts: { context?: boolean; search?: () => Promise<unknown>; get?: () => Promise<unknown> } = {}) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const outs: string[] = [];
  const errs: string[] = [];
  const client = {
    searchObservations: async (input: Record<string, unknown>) => {
      calls.push({ method: 'search', input });
      return opts.search ? opts.search() : { observations: [ROW] };
    },
    getObservations: async (input: Record<string, unknown>) => {
      calls.push({ method: 'get', input });
      return opts.get ? opts.get() : { observations: [ROW] };
    },
  };
  const resolvedCwds: string[] = [];
  const deps: MemoryCommandDeps = {
    cwd: '/work/repo/sub',
    resolveContext: (cwd) => {
      resolvedCwds.push(cwd);
      return opts.context === false ? null : ({ projectId: 'proj-1', client } as never);
    },
    out: (l) => { outs.push(l); },
    err: (l) => { errs.push(l); },
  };
  return { deps, calls, outs, errs, resolvedCwds };
}

// Observed 2026-11-06: on a default local install `memsmith search` printed
// "MemSmith runtime is not configured" while the server was running, because it
// read only the team-mode MEMSMITH_SERVER_* settings that local installs never set.
describe('memsmith search', () => {
  it('searches the project resolved from the current folder', async () => {
    const f = fake();
    const code = await runMemorySearch(['start', 'at', 'login'], f.deps);
    expect(code).toBe(0);
    expect(f.resolvedCwds).toEqual(['/work/repo/sub']);
    expect(f.calls).toEqual([{ method: 'search', input: { projectId: 'proj-1', query: 'start at login', limit: 10 } }]);
    const out = f.outs.join('\n');
    expect(out).toContain('[obs-1]');
    expect(out).toContain('Start-at-login design');
    expect(out).toContain('Fetch the full record for the relevant ids with memsmith get <id> [<id>...], up to 10 at a time.');
    expect(out).not.toContain('(ids=[...])');
  });

  it('honors --limit and clamps it to the server maximum', async () => {
    const f = fake();
    await runMemorySearch(['--limit', '3', 'login'], f.deps);
    await runMemorySearch(['login', '--limit', '500'], f.deps);
    expect(f.calls.map((c) => c.input.limit)).toEqual([3, 25]);
    expect(f.calls.map((c) => c.input.query)).toEqual(['login', 'login']);
  });

  it('accepts --limit=<n> and rejects a missing or non-numeric limit', async () => {
    const f = fake();
    expect(await runMemorySearch(['--limit=4', 'login'], f.deps)).toBe(0);
    expect(f.calls.map((c) => [c.input.query, c.input.limit])).toEqual([['login', 4]]);
    for (const bad of [['login', '--limit'], ['login', '--limit', 'abc'], ['login', '--limit', '0'], ['--limit=-2', 'login']]) {
      expect(await runMemorySearch(bad, f.deps)).toBe(1);
    }
    expect(f.calls).toHaveLength(1);
    expect(f.errs.join('\n')).toContain('--limit needs a positive whole number');
  });

  it('does not tell you to start a server that answered too slowly', async () => {
    const f = fake({ search: async () => { throw new ServerClientError('timeout', 'timed out'); } });
    expect(await runMemorySearch(['login'], f.deps)).toBe(1);
    const err = f.errs.join('\n');
    expect(err).toContain('did not answer in time');
    expect(err).not.toContain('memsmith start');
  });

  it('prints usage and exits 1 without a query', async () => {
    const f = fake();
    expect(await runMemorySearch([], f.deps)).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.errs.join('\n')).toContain('Usage: memsmith search');
  });

  it('names the folder when no MemSmith project is found, instead of blaming the runtime', async () => {
    const f = fake({ context: false });
    expect(await runMemorySearch(['login'], f.deps)).toBe(1);
    const err = f.errs.join('\n');
    expect(err).toContain('/work/repo/sub');
    expect(err).not.toContain('not configured');
  });

  it('tells you to start the server when it is unreachable', async () => {
    const f = fake({ search: async () => { throw new ServerClientError('transport', 'fetch failed'); } });
    expect(await runMemorySearch(['login'], f.deps)).toBe(1);
    expect(f.errs.join('\n')).toContain('memsmith start');
  });

  it('reports an authentication failure as such', async () => {
    const f = fake({ search: async () => { throw new ServerClientError('http_error', 'HTTP 401', { status: 401 }); } });
    expect(await runMemorySearch(['login'], f.deps)).toBe(1);
    expect(f.errs.join('\n')).toContain('authentication');
  });
});

// Reported 2026-11-08: from /tmp with MEMSMITH_PROJECT_CWD set, the CLI still
// found no project, because it always used process.cwd().
describe('project folder for the memory commands', () => {
  const saved = process.env.MEMSMITH_PROJECT_CWD;
  afterEach(() => {
    if (saved === undefined) delete process.env.MEMSMITH_PROJECT_CWD;
    else process.env.MEMSMITH_PROJECT_CWD = saved;
  });

  it('uses MEMSMITH_PROJECT_CWD when it is set', () => {
    process.env.MEMSMITH_PROJECT_CWD = '/work/pinned-project';
    expect(defaultMemoryCommandDeps().cwd).toBe('/work/pinned-project');
  });

  it('uses the current folder when MEMSMITH_PROJECT_CWD is unset or empty', () => {
    for (const value of [undefined, '']) {
      if (value === undefined) delete process.env.MEMSMITH_PROJECT_CWD;
      else process.env.MEMSMITH_PROJECT_CWD = value;
      expect(defaultMemoryCommandDeps().cwd).toBe(process.cwd());
    }
  });
});

describe('memsmith get', () => {
  it('fetches the full records for the given ids', async () => {
    const f = fake();
    expect(await runMemoryGet(['obs-1', 'obs-2'], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ method: 'get', input: { projectId: 'proj-1', ids: ['obs-1', 'obs-2'] } }]);
    const out = f.outs.join('\n');
    expect(out).toContain('One-shot login entry with no supervision.');
    expect(out).toContain('Not found: obs-2');
  });

  it('splits comma-separated ids and drops duplicates, like observation_get', async () => {
    const f = fake();
    await runMemoryGet(['obs-1,obs-2', 'obs-1'], f.deps);
    expect(f.calls[0].input.ids).toEqual(['obs-1', 'obs-2']);
  });

  it('exits 1 when none of the ids exist, so scripts can detect the miss', async () => {
    const f = fake({ get: async () => ({ observations: [] }) });
    expect(await runMemoryGet(['nope'], f.deps)).toBe(1);
    expect(f.outs.join('\n')).toContain('Not found: nope');
  });

  it('rejects more ids than the server accepts in one call', async () => {
    const f = fake();
    const ids = Array.from({ length: 11 }, (_, i) => `id-${i}`);
    expect(await runMemoryGet(ids, f.deps)).toBe(1);
    expect(f.calls).toEqual([]);
  });

  it('prints usage and exits 1 without ids', async () => {
    const f = fake();
    expect(await runMemoryGet([], f.deps)).toBe(1);
    expect(f.errs.join('\n')).toContain('Usage: memsmith get');
  });
});
