import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  READ_ONLY_REFUSAL,
  runMemoryGet,
  runMemoryNote,
  runMemorySearch,
  type MemoryCommandDeps,
} from '../../src/npx-cli/commands/memory.js';
import { ServerClientError } from '../../src/services/hooks/server-client.js';

// Nothing here may reach the real local Postgres on 55433.
const savedDatabaseUrl = process.env.MEMSMITH_SERVER_DATABASE_URL;
beforeAll(() => { process.env.MEMSMITH_SERVER_DATABASE_URL = 'postgres://127.0.0.1:1/unreachable'; });
afterAll(() => {
  if (savedDatabaseUrl === undefined) delete process.env.MEMSMITH_SERVER_DATABASE_URL;
  else process.env.MEMSMITH_SERVER_DATABASE_URL = savedDatabaseUrl;
});


const ROW = {
  id: 'obs-1',
  projectId: 'proj-1',
  kind: 'observation',
  obsType: 'decision',
  lifecycleState: 'active',
  content: 'Start-at-login design\nOne-shot login entry with no supervision.',
  metadata: { title: 'Start-at-login design', actor: 'reviewer', actors: ['reviewer'], why: 'Fewer moving parts.' },
  createdAtEpoch: Date.UTC(2026, 10, 5),
  updatedAtEpoch: Date.UTC(2026, 10, 6),
};

interface FakeOptions {
  context?: boolean;
  search?: () => Promise<unknown>;
  get?: () => Promise<unknown>;
  add?: () => Promise<unknown>;
  stdin?: string | Uint8Array;
  tty?: boolean;
  access?: string;
  actor?: string;
}

function fake(opts: FakeOptions = {}) {
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
    addObservation: async (input: Record<string, unknown>) => {
      calls.push({ method: 'add', input });
      return opts.add ? opts.add() : { memory: { id: 'note-1', kind: 'user_note', content: input.content, metadata: input.metadata, createdAtEpoch: 1_700_000_000_000 } };
    },
  };
  const resolvedCwds: string[] = [];
  const deps: MemoryCommandDeps = {
    cwd: '/work/repo',
    resolveContext: (cwd) => {
      resolvedCwds.push(cwd);
      return opts.context === false ? null : ({ projectId: 'proj-1', client } as never);
    },
    out: (l) => { outs.push(l); },
    err: (l) => { errs.push(l); },
    readStdin: async () => (typeof opts.stdin === 'string' || opts.stdin === undefined ? Buffer.from(opts.stdin ?? '') : opts.stdin),
    stdinIsTTY: () => opts.tty ?? false,
    access: () => opts.access,
    actorSource: { env: () => opts.actor, setting: () => undefined },
  };
  const json = () => JSON.parse(outs.join('\n'));
  return { deps, calls, outs, errs, json, resolvedCwds };
}

describe('memsmith search option parsing', () => {
  it('never treats --json, --actor, or --limit as part of the query', async () => {
    const f = fake();
    await runMemorySearch(['cache', '--json', '--actor', 'reviewer', 'ttl', '--limit=3'], f.deps);
    expect(f.calls[0].input).toEqual({ projectId: 'proj-1', query: 'cache ttl', limit: 3, actor: 'reviewer' });
  });

  it('accepts --actor=<name>', async () => {
    const f = fake();
    await runMemorySearch(['--actor=reviewer', 'cache'], f.deps);
    expect(f.calls[0].input.actor).toBe('reviewer');
  });

  it('treats everything after -- as the query, even text that looks like an option', async () => {
    const f = fake();
    await runMemorySearch(['--json', '--', '--limit', '-x', '--json'], f.deps);
    expect(f.calls[0].input.query).toBe('--limit -x --json');
    expect(f.calls[0].input.limit).toBe(10);
    expect(f.json().query).toBe('--limit -x --json');
  });

  it('does not take another option as an option value', async () => {
    for (const args of [['cache', '--actor', '--json'], ['cache', '--limit', '--json']]) {
      const f = fake();
      expect(await runMemorySearch(args, f.deps)).toBe(1);
      expect(f.calls).toEqual([]);
    }
  });

  it('says --json takes no value', async () => {
    const f = fake();
    expect(await runMemorySearch(['--json=true', 'cache'], f.deps)).toBe(1);
    expect(f.errs.join('\n')).toContain('--json takes no value');
  });

  it('rejects an unknown double-dash option and points at --', async () => {
    const f = fake();
    expect(await runMemorySearch(['--verbose', 'cache'], f.deps)).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.errs.join('\n')).toContain('Unknown option --verbose');
    expect(f.errs.join('\n')).toContain('--');
  });

  it('rejects --actor without a name or with a control character', async () => {
    for (const args of [['cache', '--actor'], ['cache', '--actor', 'bad\u0007name']]) {
      const f = fake();
      expect(await runMemorySearch(args, f.deps)).toBe(1);
      expect(f.calls).toEqual([]);
    }
  });

  it('lists recent records for an actor when no query is given', async () => {
    const f = fake();
    expect(await runMemorySearch(['--actor', 'reviewer'], f.deps)).toBe(0);
    expect(f.calls[0].input).toEqual({ projectId: 'proj-1', query: '', limit: 10, actor: 'reviewer' });
    expect(f.outs.join('\n')).toContain('most recent observation by reviewer');
  });

  it('shows the actor in the text index', async () => {
    const f = fake();
    await runMemorySearch(['login'], f.deps);
    expect(f.outs.join('\n')).toContain('[obs-1] 2026-11-05 · decision · by reviewer · Start-at-login design');
  });
});

describe('memsmith search --json', () => {
  it('prints a stable object with the project, query, and index results', async () => {
    const f = fake();
    expect(await runMemorySearch(['--json', 'login'], f.deps)).toBe(0);
    expect(f.errs).toEqual([]);
    expect(f.json()).toEqual({
      project: { id: 'proj-1', folder: '/work/repo' },
      query: 'login',
      actor: null,
      results: [{
        id: 'obs-1',
        date: '2026-11-05',
        type: 'decision',
        title: 'Start-at-login design',
        snippet: 'One-shot login entry with no supervision.',
        actor: 'reviewer',
        actors: ['reviewer'],
        supersededBy: null,
      }],
    });
  });

  it('reports a record without an actor as actor null and actors empty', async () => {
    const f = fake({ search: async () => ({ observations: [{ ...ROW, metadata: { title: 'Start-at-login design' } }] }) });
    await runMemorySearch(['--json', 'login'], f.deps);
    expect(f.json().results[0]).toMatchObject({ actor: null, actors: [] });
  });

  it('prints errors as JSON on stdout and exits 1', async () => {
    const f = fake({ search: async () => { throw new ServerClientError('transport', 'fetch failed'); } });
    expect(await runMemorySearch(['--json', 'login'], f.deps)).toBe(1);
    expect(f.json()).toEqual({ error: { code: 'server_unreachable', message: expect.stringContaining('memsmith start') } });
    expect(f.errs).toEqual([]);
  });

  it('reports a folder without a project as a JSON error', async () => {
    const f = fake({ context: false });
    expect(await runMemorySearch(['--json', 'login'], f.deps)).toBe(1);
    expect(f.json().error.code).toBe('no_project');
    expect(f.json().error.message).toContain('/work/repo');
  });

  it('reports a usage error as JSON', async () => {
    const f = fake();
    expect(await runMemorySearch(['--json'], f.deps)).toBe(1);
    expect(f.json().error.code).toBe('usage');
  });
});

describe('memsmith get --json', () => {
  it('prints the full records and the ids it could not find', async () => {
    const f = fake();
    expect(await runMemoryGet(['--json', 'obs-1', 'obs-9'], f.deps)).toBe(0);
    expect(f.calls[0].input.ids).toEqual(['obs-1', 'obs-9']);
    expect(f.json()).toEqual({
      project: { id: 'proj-1', folder: '/work/repo' },
      results: [{
        id: 'obs-1',
        date: '2026-11-05',
        type: 'decision',
        kind: 'observation',
        lifecycleState: 'active',
        title: 'Start-at-login design',
        content: ROW.content,
        actor: 'reviewer',
        actors: ['reviewer'],
        supersededBy: null,
        createdAtEpoch: ROW.createdAtEpoch,
        updatedAtEpoch: ROW.updatedAtEpoch,
        metadata: ROW.metadata,
      }],
      notFound: ['obs-9'],
    });
  });

  it('exits 1 when none of the ids exist', async () => {
    const f = fake({ get: async () => ({ observations: [] }) });
    expect(await runMemoryGet(['--json', 'nope'], f.deps)).toBe(1);
    expect(f.json()).toMatchObject({ results: [], notFound: ['nope'] });
  });

  it('accepts ids after --', async () => {
    const f = fake();
    await runMemoryGet(['--', '-odd-id'], f.deps);
    expect(f.calls[0].input.ids).toEqual(['-odd-id']);
  });
});

describe('memsmith note', () => {
  it('saves the argument text as a user note for the folder\'s project', async () => {
    const f = fake();
    expect(await runMemoryNote(['The', 'cache', 'TTL', 'is', '5', 'minutes'], f.deps)).toBe(0);
    expect(f.resolvedCwds).toEqual(['/work/repo']);
    expect(f.calls).toEqual([{
      method: 'add',
      input: { projectId: 'proj-1', content: 'The cache TTL is 5 minutes', kind: 'user_note', metadata: { userDirected: true } },
    }]);
    expect(f.outs.join('\n')).toContain('note-1');
  });

  it('reads the note from stdin when the text is -', async () => {
    const f = fake({ stdin: '  Deploys freeze on Fridays.\n' });
    expect(await runMemoryNote(['-'], f.deps)).toBe(0);
    expect(f.calls[0].input.content).toBe('Deploys freeze on Fridays.');
  });

  it('stamps MEMSMITH_ACTOR on the note', async () => {
    const f = fake({ actor: 'reviewer' });
    await runMemoryNote(['--json', 'Cache TTL is 5 minutes'], f.deps);
    expect(f.calls[0].input.metadata).toEqual({ actor: 'reviewer', userDirected: true });
    expect(f.json()).toEqual({
      project: { id: 'proj-1', folder: '/work/repo' },
      note: { id: 'note-1', content: 'Cache TTL is 5 minutes', actor: 'reviewer', createdAtEpoch: 1_700_000_000_000 },
    });
  });

  it('refuses to save in read-only mode without contacting the server', async () => {
    const f = fake({ access: 'read' });
    expect(await runMemoryNote(['Cache TTL is 5 minutes'], f.deps)).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.resolvedCwds).toEqual([]);
    expect(f.errs.join('\n')).toBe(READ_ONLY_REFUSAL);
    expect(READ_ONLY_REFUSAL).toBe('MemSmith is in read-only mode for this session (MEMSMITH_ACCESS=read). Nothing was saved.');
  });

  it('reports read-only mode as a JSON error', async () => {
    const f = fake({ access: 'read' });
    expect(await runMemoryNote(['--json', 'x'], f.deps)).toBe(1);
    expect(f.json()).toEqual({ error: { code: 'read_only', message: READ_ONLY_REFUSAL } });
  });

  it('refuses an invalid MEMSMITH_ACTOR instead of saving the note untagged', async () => {
    const f = fake({ actor: 'x'.repeat(65) });
    expect(await runMemoryNote(['Cache TTL'], f.deps)).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.errs.join('\n')).toContain('MEMSMITH_ACTOR');
  });

  it('says nothing was saved when the folder has no project', async () => {
    const f = fake({ context: false });
    expect(await runMemoryNote(['Cache TTL'], f.deps)).toBe(1);
    expect(f.errs.join('\n')).toContain('Nothing was saved.');
  });

  it('prints usage for empty text, including empty stdin', async () => {
    for (const [args, stdin] of [[[], ''], [['-'], '  \n']] as const) {
      const f = fake({ stdin });
      expect(await runMemoryNote([...args], f.deps)).toBe(1);
      expect(f.calls).toEqual([]);
      expect(f.errs.join('\n')).toContain('Usage: memsmith note');
    }
  });

  it('exits 1 when the server rejects the write', async () => {
    const f = fake({ add: async () => { throw new ServerClientError('http_error', 'HTTP 500', { status: 500 }); } });
    expect(await runMemoryNote(['Cache TTL'], f.deps)).toBe(1);
  });

  it('refuses to wait on a terminal for stdin and says how to pass the text', async () => {
    const f = fake({ tty: true });
    expect(await runMemoryNote(['-'], f.deps)).toBe(1);
    expect(f.errs.join('\n')).toContain('memsmith note "<text>"');
    expect(f.calls).toEqual([]);
  });

  it('rejects stdin over 5 MB, with NUL bytes, or that is not UTF-8', async () => {
    const cases: Array<[Uint8Array, string]> = [
      [Buffer.alloc(5 * 1024 * 1024 + 1, 'a'), '5 MB'],
      [Buffer.from('note\u0000text'), 'NUL'],
      [Uint8Array.from([0x6e, 0xff, 0xfe, 0x6f]), 'UTF-8'],
    ];
    for (const [stdin, message] of cases) {
      const f = fake({ stdin });
      expect(await runMemoryNote(['-'], f.deps)).toBe(1);
      expect(f.calls).toEqual([]);
      expect(f.errs.join('\n')).toContain(message);
    }
  });

  const SERVER_BODY_LIMIT = 5 * 1024 * 1024;

  it('accepts a note whose encoded request fits the server body limit', async () => {
    const f = fake({ stdin: Buffer.alloc(SERVER_BODY_LIMIT - 1024, 'a') });
    expect(await runMemoryNote(['-'], f.deps)).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(f.calls[0].input))).toBeLessThanOrEqual(SERVER_BODY_LIMIT);
  });

  it('refuses a note whose encoded request the server would reject, before sending it', async () => {
    for (const stdin of [Buffer.alloc(SERVER_BODY_LIMIT, 'a'), Buffer.alloc(3 * 1024 * 1024, '"')]) {
      const f = fake({ stdin });
      expect(await runMemoryNote(['-'], f.deps)).toBe(1);
      expect(f.calls).toEqual([]);
      expect(f.errs.join('\n')).toContain('5 MB');
    }
  });

  it('keeps text after -- verbatim', async () => {
    const f = fake();
    await runMemoryNote(['--', '--json', 'is a flag'], f.deps);
    expect(f.calls[0].input.content).toBe('--json is a flag');
  });
});
