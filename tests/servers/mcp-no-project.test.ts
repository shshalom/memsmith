import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Reported incident: in a checkout with no project marker, observation_search
// answered "No observations matched", so the agent concluded memory was empty.
// The default install here mirrors a real local one: no settings-level key or
// project, so only a folder's marker plus its cached team key resolves a project.

const mcpServerPath = new URL('../../src/servers/mcp-server.ts', import.meta.url).pathname;

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
type Received = { server: 'local' | 'team'; path: string; body: any; auth: string | null };

const NOT_SEARCHED = 'Memory was not searched; this is not an empty result.';

describe('memory MCP tools and folders without a usable MemSmith project', () => {
  let fake: ReturnType<typeof Bun.serve>;
  let teamFake: ReturnType<typeof Bun.serve>;
  let home: string;
  let pinned: string;
  let unpinned: string;
  let unjoinedTeam: string;
  let keylessLocal: string;
  let otherTeam: string;
  let sharedWithSettings: string;
  let joinedTeam: string;
  let fromPinned: Client;
  let fromUnpinned: Client;
  let withSettingsProject: Client;
  let withSettingsKeyOnly: Client;
  let received: Received[] = [];

  async function connect(cwd: string, dataDir: string): Promise<Client> {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) => !k.startsWith('MEMSMITH_') && !k.startsWith('CLAUDE_') && v !== undefined),
    ) as Record<string, string>;
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [mcpServerPath],
      cwd,
      env: {
        ...env,
        HOME: home,
        MEMSMITH_DATA_DIR: dataDir,
        MEMSMITH_SERVER_PORT: String(fake.port),
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
      },
      stderr: 'ignore',
    }));
    return client;
  }

  function writeDataDir(dir: string, settings: Record<string, string>) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ MEMSMITH_SERVER_URL: `http://127.0.0.1:${fake.port}`, ...settings }));
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ keys: { 'team-pinned': 'key-pinned', 'team-joined': 'key-team' } }));
  }

  function writeMarker(dir: string, marker: Record<string, string>) {
    mkdirSync(join(dir, '.memsmith'), { recursive: true });
    writeFileSync(join(dir, '.memsmith', 'project.json'), JSON.stringify(marker));
  }

  beforeAll(async () => {
    const serve = (server: Received['server']) => Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body = req.method === 'POST' ? await req.json() : null;
        received.push({ server, path, body, auth: req.headers.get('authorization') });
        return Response.json({ observations: [], context: '' });
      },
    });
    fake = serve('local');
    teamFake = serve('team');

    home = mkdtempSync(join(tmpdir(), 'ms-mcp-noproj-'));
    const localData = join(home, '.memsmith');
    writeDataDir(localData, { MEMSMITH_RUNTIME: 'local', MEMSMITH_SERVER_API_KEY: '', MEMSMITH_SERVER_PROJECT_ID: '' });
    const settingsData = join(home, 'settings-project-data');
    writeDataDir(settingsData, {
      MEMSMITH_RUNTIME: 'server',
      MEMSMITH_SERVER_URL: `http://127.0.0.1:${teamFake.port}`,
      MEMSMITH_SERVER_API_KEY: 'key-settings',
      MEMSMITH_SERVER_PROJECT_ID: 'proj-settings',
    });
    const keyOnlyData = join(home, 'settings-key-only-data');
    writeDataDir(keyOnlyData, { MEMSMITH_RUNTIME: 'local', MEMSMITH_SERVER_API_KEY: 'key-settings', MEMSMITH_SERVER_PROJECT_ID: '' });

    pinned = join(home, 'pinned-repo');
    writeMarker(pinned, { teamId: 'team-pinned', projectId: 'proj-pinned' });
    unjoinedTeam = join(home, 'team-clone');
    writeMarker(unjoinedTeam, { teamId: 'team-unjoined', projectId: 'proj-unjoined', runtime: 'server' });
    keylessLocal = join(home, 'keyless-local');
    writeMarker(keylessLocal, { teamId: 'team-keyless', projectId: 'proj-keyless', runtime: 'local' });
    otherTeam = join(home, 'other-team');
    writeMarker(otherTeam, { teamId: 'team-other', projectId: 'proj-other', runtime: 'local' });
    sharedWithSettings = join(home, 'settings-project-folder');
    writeMarker(sharedWithSettings, { teamId: 'team-settings', projectId: 'proj-settings', runtime: 'server', serverUrl: `http://127.0.0.1:${teamFake.port}` });
    joinedTeam = join(home, 'joined-team');
    writeMarker(joinedTeam, { teamId: 'team-joined', projectId: 'proj-team', runtime: 'server', serverUrl: `http://127.0.0.1:${teamFake.port}` });
    unpinned = join(home, 'unpinned-checkout');
    mkdirSync(unpinned, { recursive: true });

    [fromPinned, fromUnpinned, withSettingsProject, withSettingsKeyOnly] = await Promise.all([
      connect(pinned, localData),
      connect(unpinned, localData),
      connect(pinned, settingsData),
      connect(unpinned, keyOnlyData),
    ]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([fromPinned?.close(), fromUnpinned?.close(), withSettingsProject?.close(), withSettingsKeyOnly?.close()]);
    fake?.stop(true);
    teamFake?.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    received = [];
  });

  async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ result: ToolResult; text: string }> {
    const result = await client.callTool({ name, arguments: args }) as ToolResult;
    return { result, text: result.content.map(c => c.text).join('') };
  }

  async function expectRefused(client: Client, name: string, args: Record<string, unknown>, ...expected: string[]) {
    const { result, text } = await call(client, name, args);
    expect(result.isError).toBe(true);
    for (const part of expected) expect(text).toContain(part);
    expect(text).not.toContain('No observations matched');
    expect(received).toEqual([]);
  }

  async function expectSentTo(
    client: Client,
    name: string,
    args: Record<string, unknown>,
    projectId: string,
    auth: string,
    server: Received['server'] = 'local',
  ) {
    const { result } = await call(client, name, args);
    expect(result.isError).toBeFalsy();
    expect(received).toHaveLength(1);
    expect(received[0]?.server).toBe(server);
    expect(received[0]?.body?.projectId).toBe(projectId);
    expect(received[0]?.auth).toBe(`Bearer ${auth}`);
  }

  const readCalls: Array<[string, Record<string, unknown>]> = [
    ['observation_search', { query: 'queue engine' }],
    ['observation_context', { query: 'queue engine' }],
    ['observation_get', { ids: ['obs-1'] }],
  ];

  for (const [name, args] of readCalls) {
    describe(name, () => {
      it('reports no project when the session folder is unpinned', async () => {
        // The child reports its cwd through process.cwd(), which resolves the
        // macOS /var -> /private/var symlink in the tmp path.
        await expectRefused(fromUnpinned, name, args, `No MemSmith project found for ${realpathSync(unpinned)}.`, NOT_SEARCHED);
      });

      it('reports no project for an unpinned cwd even when the session folder is pinned', async () => {
        await expectRefused(fromPinned, name, { ...args, cwd: unpinned }, `No MemSmith project found for ${unpinned}.`, NOT_SEARCHED);
      });

      it('reports no project for an unpinned cwd even when settings name a project', async () => {
        await expectRefused(withSettingsProject, name, { ...args, cwd: unpinned }, `No MemSmith project found for ${unpinned}.`, NOT_SEARCHED);
      });

      it("reads the session folder's project when no cwd is passed", async () => {
        await expectSentTo(fromPinned, name, args, 'proj-pinned', 'key-pinned');
      });

      it("reads a pinned cwd's project from an unpinned session folder", async () => {
        await expectSentTo(fromUnpinned, name, { ...args, cwd: pinned }, 'proj-pinned', 'key-pinned');
      });

      it("reads a pinned cwd's project with its own key and server even when settings name another project", async () => {
        await expectSentTo(withSettingsProject, name, { ...args, cwd: pinned }, 'proj-pinned', 'key-pinned');
      });

      it("never sends the settings key for a cwd in another team that has no cached key", async () => {
        await expectRefused(
          withSettingsProject, name, { ...args, cwd: otherTeam },
          `The folder ${otherTeam} belongs to MemSmith project proj-other, but this machine holds no key for it.`,
          NOT_SEARCHED,
        );
      });

      it("reads a pinned cwd's project when settings hold a key but no project", async () => {
        await expectSentTo(withSettingsKeyOnly, name, { ...args, cwd: pinned }, 'proj-pinned', 'key-pinned');
      });

      it('lets an explicit projectId win over the cwd project', async () => {
        await expectSentTo(fromUnpinned, name, { ...args, cwd: pinned, projectId: 'proj-explicit' }, 'proj-explicit', 'key-pinned');
      });

      it("says the team isn't joined when the cwd's team has no key on this machine", async () => {
        await expectRefused(
          fromPinned, name, { ...args, cwd: unjoinedTeam },
          `The folder ${unjoinedTeam} belongs to MemSmith project proj-unjoined in a team this machine hasn't joined.`,
          NOT_SEARCHED,
          'choose Join',
        );
      });
    });
  }

  it('keeps the settings project when no cwd is passed', async () => {
    await expectSentTo(withSettingsProject, 'observation_search', { query: 'queue engine' }, 'proj-settings', 'key-settings', 'team');
  });

  it("uses the settings key for a cwd whose marker names the settings project", async () => {
    await expectSentTo(
      withSettingsProject, 'observation_search', { query: 'queue engine', cwd: sharedWithSettings },
      'proj-settings', 'key-settings', 'team',
    );
  });

  it("sends a joined team folder's requests to the marker's server", async () => {
    await expectSentTo(fromPinned, 'observation_search', { query: 'queue engine', cwd: joinedTeam }, 'proj-team', 'key-team', 'team');
  });

  it('says a local project has no key when its marker has no cached key', async () => {
    await expectRefused(
      fromPinned, 'observation_search', { query: 'queue engine', cwd: keylessLocal },
      `The folder ${keylessLocal} belongs to MemSmith project proj-keyless, but this machine holds no key for it.`,
      NOT_SEARCHED,
    );
  });

  it('rejects a relative cwd', async () => {
    await expectRefused(fromPinned, 'observation_search', { query: 'queue engine', cwd: 'pinned-repo' }, '"cwd" must be an absolute path');
  });

  it('says when the cwd folder does not exist', async () => {
    const missing = join(home, 'no-such-folder');
    await expectRefused(fromPinned, 'observation_search', { query: 'queue engine', cwd: missing }, `The folder ${missing} does not exist.`, NOT_SEARCHED);
  });

  it('keeps the empty-result answer for a pinned project with no match', async () => {
    const { text } = await call(fromPinned, 'observation_search', { query: 'queue engine' });
    expect(text).toContain('No observations matched "queue engine"');
  });

  const writeCalls: Array<[string, Record<string, unknown>]> = [
    ['note_add', { content: 'Remember the queue engine decision.' }],
    ['observation_add', { content: 'Queue engine observation.' }],
    ['observation_record_event', { eventType: 'PostToolUse', payload: {} }],
  ];

  for (const [name, args] of writeCalls) {
    it(`${name} writes to the cwd's project`, async () => {
      await expectSentTo(fromUnpinned, name, { ...args, cwd: pinned }, 'proj-pinned', 'key-pinned');
    });
  }

  it('note_add saves nothing for an unpinned cwd', async () => {
    await expectRefused(
      fromPinned, 'note_add', { content: 'Remember this.', cwd: unpinned },
      `No MemSmith project found for ${unpinned}.`, 'Nothing was saved.',
    );
  });

  it("observation_generation_status uses the cwd project's key", async () => {
    const { result } = await call(fromUnpinned, 'observation_generation_status', { jobId: 'job-1', cwd: pinned });
    expect(result.isError).toBeFalsy();
    expect(received).toHaveLength(1);
    expect(received[0]?.auth).toBe('Bearer key-pinned');
  });
});
